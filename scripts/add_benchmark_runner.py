"""Small pure helpers for preserving per-corpus ADD replay diagnostics."""
import json
import os
from pathlib import Path


def load_report(report_path: Path, repository: str, commit: str, process_error: str | None = None) -> dict:
    if not report_path.exists():
        return {
            "status": "FAIL_PROCESS",
            "repository": repository,
            "commit": commit,
            "error": process_error or "Benchmark process ended without writing a report",
        }
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return {
            "status": "FAIL_REPORT",
            "repository": repository,
            "commit": commit,
            "error": f"Benchmark report could not be read as JSON ({type(error).__name__})",
        }
    if not isinstance(report, dict):
        return {
            "status": "FAIL_REPORT",
            "repository": repository,
            "commit": commit,
            "error": "Benchmark report JSON must contain an object",
        }
    if not isinstance(report.get("status"), str):
        return {
            "status": "FAIL_REPORT",
            "repository": repository,
            "commit": commit,
            "error": "Benchmark report JSON has no string status",
        }
    return report


def check_cgroup_evidence(report: dict, memory_limit_bytes: int, pids_limit: int) -> dict:
    limits = report.get("containerCgroupLimits")
    if not isinstance(limits, dict):
        limits = {}
    expected = {
        "memoryMaxBytes": memory_limit_bytes,
        "memorySwapMaxBytes": 0,
        "cpuQuotaMicros": 150000,
        "cpuPeriodMicros": 100000,
        "pidsMax": pids_limit,
    }
    observed = {key: limits.get(key) for key in expected}
    problems = [f"{key}: expected {value}, observed {observed[key]}" for key, value in expected.items()
                if observed[key] != value]
    if report.get("containerPeakChargedBytes") is None:
        problems.append("containerPeakChargedBytes: missing")
    return {
        "status": "PASS" if not problems else "FAIL",
        "expected": expected,
        "observed": observed,
        "peakChargedBytesRecorded": report.get("containerPeakChargedBytes") is not None,
        **({"error": "; ".join(problems)} if problems else {}),
    }


def finalize_report(report: dict, exit_code: int, cgroup_evidence: dict, process_error: str | None = None) -> dict:
    report["containerExitCode"] = exit_code
    report["resourceLimitEvidence"] = cgroup_evidence
    if process_error:
        report["processError"] = process_error
    if exit_code != 0 and report.get("status") == "PASS":
        report["status"] = "FAIL_CONTAINER_EXIT"
        report["error"] = process_error or f"Benchmark container exited with status {exit_code}."
    if cgroup_evidence.get("status") != "PASS":
        if report.get("status") == "PASS":
            report["status"] = "FAIL_RESOURCE_LIMIT_EVIDENCE"
            report["error"] = "The container did not report the expected cgroup v2 limits and peak memory."
        else:
            report["resourceLimitError"] = cgroup_evidence.get("error", "Expected cgroup evidence was not recorded.")
    return report


def write_final_report(report_path: Path, fallback_path: Path, report: dict) -> tuple[Path | None, str | None]:
    payload = json.dumps(report, indent=2) + "\n"
    try:
        report_path.write_text(payload, encoding="utf-8")
        os.chmod(report_path, 0o600)
        return report_path, None
    except OSError as primary_error:
        try:
            fallback_path.write_text(payload, encoding="utf-8")
            os.chmod(fallback_path, 0o600)
            return fallback_path, f"Primary report path was unavailable ({type(primary_error).__name__})."
        except OSError as fallback_error:
            return None, (f"Could not write report to either path ({type(primary_error).__name__}; "
                          f"fallback {type(fallback_error).__name__}).")
