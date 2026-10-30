"""Run pinned corpora sequentially in fresh offline containers with fixed worker limits."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import shutil
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
parser.add_argument("--image", required=True, help="Locally built QA image with Node/PHP/Chromium and workspace dependencies")
parser.add_argument("--context", default="colima-sage")
parser.add_argument("--render", action="store_true")
parser.add_argument("--reuse-core-from", type=Path, help="Reuse explicitly identified successful source measurements for a renderer-only rerun")
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False, mode=0o700)
oracle = json.loads((root / "docs/evidence/semantic/oracle.json").read_text())
failed = False
for fixture in oracle["snapshots"]:
    slug = fixture["repository"].split("/")[-1]
    if not slug or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in slug):
        raise ValueError("Invalid pinned corpus name")
    source = root / "artifacts/semantic/corpora" / slug
    metadata = json.loads((source / ".snapshot.json").read_text())
    if metadata["commit"] != fixture["commit"] or metadata["repository"] != fixture["repository"]:
        raise ValueError("Corpus differs from frozen oracle")
    name = "sage-semantic-" + uuid.uuid4().hex[:12]
    command = ["docker", "--context", args.context, "run", "--rm", "--name", name,
               "--network", "none", "--memory=2g", "--cpus=1.5", "--pids-limit=256",
               "--shm-size=128m", "--read-only", "--tmpfs", "/tmp:rw,size=536870912", "--entrypoint", "sh"]
    for folder in ("packages", "apps", "scripts"):
        command += ["-v", str(root / folder) + ":/app/" + folder + ":ro"]
    command += ["-v", str(source) + ":/corpus:ro", "-v", str(output) + ":/results", args.image,
                "-c", "node --import tsx scripts/benchmark-semantic.ts /corpus /results"]
    log_path = output / (slug + ".log")
    report_path = output / (slug + "-report.json")
    if args.reuse_core_from:
        old = args.reuse_core_from.resolve()
        prior = json.loads((old / (slug + "-report.json")).read_text())
        if prior.get("sourceStatus") != "PASS" or prior["commit"] != fixture["commit"] or prior["repository"] != fixture["repository"]:
            raise ValueError("Reusable source measurement does not match pinned corpus")
        for suffix in ("-ckg.json", "-semantic.json"):
            shutil.copyfile(old / (slug + suffix), output / (slug + suffix))
        for key in ("exportError", "exportProcess", "exportExitCode"):
            prior.pop(key, None)
        prior.update(status="PASS", exportMetrics=None, sourceMeasurementReusedFrom=str(old.relative_to(root)))
        report_path.write_text(json.dumps(prior, indent=2) + "\n")
        log_path.write_text("Source extraction reused explicitly from " + str(old.relative_to(root)) + "\n")
        result = subprocess.CompletedProcess(command, 0)
    else:
        with log_path.open("x") as log:
            os.chmod(log_path, 0o600)
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=False)
    if not report_path.exists():
        text = log_path.read_text(errors="replace")
        phases = []
        for line in text.splitlines():
            try:
                value = json.loads(line)
                if isinstance(value, dict) and "phase" in value:
                    phases.append(value["phase"])
            except ValueError:
                pass
        report = {"status": "FAIL_PROCESS", "repository": fixture["repository"], "commit": fixture["commit"],
                  "exitCode": result.returncode, "lastPhase": phases[-1] if phases else None,
                  "error": "V8_HEAP_LIMIT" if "heap out of memory" in text else "PROCESS_FAILED",
                  "memoryLimitBytes": 2147483648, "cpus": 1.5, "containerPeakChargedBytes": None}
        report_path.write_text(json.dumps(report, indent=2) + "\n")
    else:
        report = json.loads(report_path.read_text())
    if args.render and report.get("sourceStatus") == "PASS":
        export_command = command.copy()
        export_command[export_command.index(name)] = name + "-export"
        export_command[-1] = "node --import tsx scripts/benchmark-semantic-export.ts /corpus /results"
        with (output / (slug + "-export.log")).open("x") as log:
            result = subprocess.run(export_command, stdout=log, stderr=subprocess.STDOUT, check=False)
        report = json.loads(report_path.read_text())
        if result.returncode != 0 and report["status"] == "PASS":
            export_log = (output / (slug + "-export.log")).read_text(errors="replace")
            report.update(status="FAIL_EXPORT_PROCESS", exportExitCode=result.returncode,
                          exportError="V8_HEAP_LIMIT" if "heap out of memory" in export_log else "Export process aborted; inspect retained export log",
                          exportProcess={"processPeakRssBytes": None, "containerPeakChargedBytes": None})
            report_path.write_text(json.dumps(report, indent=2) + "\n")
    failed |= result.returncode != 0 or report["status"] != "PASS"
    print(json.dumps({"repository": fixture["repository"], "status": report["status"], "exitCode": result.returncode}), flush=True)
raise SystemExit(1 if failed else 0)
