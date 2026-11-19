"""Replay the frozen ADD corpora in fresh Linux containers with fixed limits."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import uuid
from add_benchmark_runner import check_cgroup_evidence, finalize_report, load_report, write_final_report

ROOT = Path(__file__).resolve().parents[1]
MEMORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
CPU_LIMIT = 1.5

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path, help="New report directory, relative to the checkout or absolute")
parser.add_argument("--image", required=True, help="Built QA image containing the current workspace")
parser.add_argument("--context", default="default", help="Docker context; use colima-sage for local Colima")
args = parser.parse_args()

output = args.output if args.output.is_absolute() else ROOT / args.output
output = output.resolve()
if output.exists():
    raise SystemExit(f"Refusing to overwrite existing benchmark output: {output}")
output.mkdir(parents=True, mode=0o700)

manifest = json.loads((ROOT / "docs/evidence/semantic/oracle.json").read_text())
failed = False
summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
summary_rows = []

def stop_container(name):
    try:
        subprocess.run(["docker", "--context", args.context, "rm", "--force", name],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=30)
    except (OSError, subprocess.SubprocessError):
        pass

for snapshot in manifest["snapshots"]:
    repository = snapshot["repository"]
    slug = repository.rsplit("/", 1)[-1]
    if not slug or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for character in slug):
        raise SystemExit("Invalid pinned corpus name")
    corpus = ROOT / "artifacts/semantic/corpora" / slug
    metadata = json.loads((corpus / ".snapshot.json").read_text())
    if metadata.get("repository") != repository or metadata.get("commit") != snapshot["commit"]:
        raise SystemExit(f"Corpus does not match the frozen source oracle: {slug}")

    name = "sage-add-bench-" + uuid.uuid4().hex[:12]
    command = [
        "docker", "--context", args.context, "run", "--rm", "--name", name,
        "--user", f"{os.getuid()}:{os.getgid()}",
        "--network", "none", "--memory=2g", "--memory-swap=2g", "--cpus=1.5", "--pids-limit=256",
        "--shm-size=128m", "--read-only", "--tmpfs", "/tmp:rw,size=536870912",
        "--volume", f"{corpus}:/corpus:ro", "--volume", f"{output}:/results:rw",
        args.image, "node", "--import", "tsx", "scripts/benchmark-add.ts", "/corpus", "/results", slug,
    ]
    log_path = output / f"{slug}.log"
    report_path = output / f"{slug}-report.json"
    exit_code = 1
    process_error = None
    with log_path.open("x") as log:
        os.chmod(log_path, 0o600)
        try:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=False, timeout=300)
            exit_code = result.returncode
        except subprocess.TimeoutExpired:
            stop_container(name)
            exit_code = 124
            process_error = "Benchmark container exceeded the 300-second timeout."
        except (OSError, subprocess.SubprocessError):
            stop_container(name)
            exit_code = 125
            process_error = "Benchmark container could not be started or monitored."

    if exit_code != 0 and process_error is None and not report_path.exists():
        process_error = f"Benchmark command exited with status {exit_code} without writing a report."
    report = load_report(report_path, repository, snapshot["commit"], process_error)
    report["containerLimits"] = {
        "memoryBytes": MEMORY_LIMIT_BYTES,
        "memoryAndSwapBytes": MEMORY_LIMIT_BYTES,
        "swapAllowanceBytes": 0,
        "cpus": CPU_LIMIT,
        "network": "none",
        "pids": 256,
    }
    report["containerExitCode"] = exit_code
    cgroup_evidence = check_cgroup_evidence(report, MEMORY_LIMIT_BYTES, 256)
    report = finalize_report(report, exit_code, cgroup_evidence, process_error)
    written_report_path, report_write_error = write_final_report(report_path, output / f"{slug}-runner-report.json", report)
    if report_write_error:
        if written_report_path is None:
            if report.get("status") == "PASS":
                report["status"] = "FAIL_REPORT_WRITE"
                report["error"] = "The benchmark report could not be saved."
            report["reportWriteError"] = report_write_error
    print(json.dumps({
        "repository": repository,
        "commit": snapshot["commit"],
        "status": report.get("status"),
        "containerPeakChargedBytes": report.get("containerPeakChargedBytes"),
        "resourceLimitEvidence": (report.get("resourceLimitEvidence") or {}).get("status"),
        "processPeakRssBytes": report.get("processPeakRssBytes"),
        "elapsedMs": report.get("elapsedMs"),
        "containerExitCode": exit_code,
        "reportFile": written_report_path.name if written_report_path else None,
        "reportWriteWarning": report_write_error,
    }), flush=True)
    summary_rows.append((repository, snapshot["commit"], report, written_report_path, report_write_error))
    failed |= exit_code != 0 or report.get("status") != "PASS" or written_report_path is None

if summary_path:
    def mib(value):
        return f"{value / (1024 * 1024):.1f} MiB" if isinstance(value, (int, float)) else "not recorded"
    lines = [
        "## Fixed-limit Linux ADD replay",
        "",
        "Each replay container is configured for a 2 GiB total memory cap, swap disabled, 1.5 CPU quota, 256 PIDs, no network, and a read-only root. The result column reports whether observed cgroup values matched those configured limits; a failure does not imply the container ran with those limits.",
        "",
        "| Repository | Commit | Result | Limits observed | Elapsed | Cgroup peak | Process peak RSS | Elements | Evidence spans | Report file |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    report_warnings = []
    for repository, commit, report, written_report_path, report_write_error in summary_rows:
        add = report.get("add") or {}
        lines.append(
            f"| `{repository}` | `{commit[:12]}` | {report.get('status')} | "
            f"{(report.get('resourceLimitEvidence') or {}).get('status', 'not verified')} | "
            f"{report.get('elapsedMs', 'not recorded')} ms | "
            f"{mib(report.get('containerPeakChargedBytes'))} | "
            f"{mib(report.get('processPeakRssBytes'))} | "
            f"{add.get('elements', 'not recorded')} | {add.get('evidenceSpans', 'not recorded')} | "
            f"{written_report_path.name if written_report_path else 'not saved'} |"
        )
        if report_write_error:
            report_warnings.append(f"- `{repository}` report write note: {report_write_error}")
    if report_warnings:
        lines.extend(["", *report_warnings])
    with open(summary_path, "a", encoding="utf-8") as summary:
        summary.write("\n".join(lines) + "\n")

raise SystemExit(1 if failed else 0)
