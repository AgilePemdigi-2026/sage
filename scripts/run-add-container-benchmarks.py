"""Replay the frozen ADD corpora in fresh Linux containers with fixed limits."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import uuid

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
        "--network", "none", "--memory=2g", "--cpus=1.5", "--pids-limit=256",
        "--shm-size=128m", "--read-only", "--tmpfs", "/tmp:rw,size=536870912",
        "--volume", f"{corpus}:/corpus:ro", "--volume", f"{output}:/results:rw",
        args.image, "node", "--import", "tsx", "scripts/benchmark-add.ts", "/corpus", "/results", slug,
    ]
    log_path = output / f"{slug}.log"
    report_path = output / f"{slug}-report.json"
    exit_code = 1
    with log_path.open("x") as log:
        os.chmod(log_path, 0o600)
        try:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=False, timeout=300)
            exit_code = result.returncode
        except subprocess.TimeoutExpired:
            stop_container(name)
            exit_code = 124
        except (OSError, subprocess.SubprocessError):
            stop_container(name)
            exit_code = 125

    if report_path.exists():
        report = json.loads(report_path.read_text())
    else:
        report = {
            "status": "FAIL_PROCESS",
            "repository": repository,
            "commit": snapshot["commit"],
            "error": "Benchmark process ended without writing a report",
        }
    report["containerLimits"] = {
        "memoryBytes": MEMORY_LIMIT_BYTES,
        "cpus": CPU_LIMIT,
        "network": "none",
        "pids": 256,
    }
    report["containerExitCode"] = exit_code
    limits = report.get("containerCgroupLimits") or {}
    cgroup_evidence_matches = (
        report.get("containerPeakChargedBytes") is not None
        and limits.get("memoryMaxBytes") == MEMORY_LIMIT_BYTES
        and limits.get("cpuQuotaMicros") == 150000
        and limits.get("cpuPeriodMicros") == 100000
        and limits.get("pidsMax") == 256
    )
    if not cgroup_evidence_matches:
        report["status"] = "FAIL_RESOURCE_LIMIT_EVIDENCE"
        report["error"] = "The container did not report the expected cgroup v2 limits and peak memory."
    if exit_code != 0 and report.get("status") == "PASS":
        report["status"] = "FAIL_CONTAINER_EXIT"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    os.chmod(report_path, 0o600)
    print(json.dumps({
        "repository": repository,
        "commit": snapshot["commit"],
        "status": report.get("status"),
        "containerPeakChargedBytes": report.get("containerPeakChargedBytes"),
        "processPeakRssBytes": report.get("processPeakRssBytes"),
        "elapsedMs": report.get("elapsedMs"),
        "containerExitCode": exit_code,
    }), flush=True)
    summary_rows.append((repository, snapshot["commit"], report))
    failed |= exit_code != 0 or report.get("status") != "PASS"

if summary_path:
    def mib(value):
        return f"{value / (1024 * 1024):.1f} MiB" if isinstance(value, (int, float)) else "not recorded"
    lines = [
        "## Fixed-limit Linux ADD replay",
        "",
        "Pinned snapshots were replayed in isolated containers with a 2 GiB memory cap, 1.5 CPU quota, 256 PID cap, no network, read-only root filesystem, and cgroup v2 measurements.",
        "",
        "| Repository | Commit | Result | Elapsed | Cgroup peak | Process peak RSS | Elements | Evidence spans |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for repository, commit, report in summary_rows:
        add = report.get("add") or {}
        lines.append(
            f"| `{repository}` | `{commit[:12]}` | {report.get('status')} | "
            f"{report.get('elapsedMs', 'not recorded')} ms | "
            f"{mib(report.get('containerPeakChargedBytes'))} | "
            f"{mib(report.get('processPeakRssBytes'))} | "
            f"{add.get('elements', 'not recorded')} | {add.get('evidenceSpans', 'not recorded')} |"
        )
    with open(summary_path, "a", encoding="utf-8") as summary:
        summary.write("\n".join(lines) + "\n")

raise SystemExit(1 if failed else 0)
