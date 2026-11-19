import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from add_benchmark_runner import check_cgroup_evidence, finalize_report, load_report, write_final_report


class AddBenchmarkRunnerTests(unittest.TestCase):
    def test_valid_limits_require_memory_and_swap_caps(self):
        report = {
            "containerPeakChargedBytes": 123,
            "containerCgroupLimits": {
                "memoryMaxBytes": 2 * 1024 * 1024 * 1024,
                "memorySwapMaxBytes": 0,
                "cpuQuotaMicros": 150000,
                "cpuPeriodMicros": 100000,
                "pidsMax": 256,
            },
        }
        self.assertEqual(check_cgroup_evidence(report, 2 * 1024 * 1024 * 1024, 256)["status"], "PASS")

    def test_report_failure_is_not_replaced_by_cgroup_failure(self):
        report = {"status": "FAIL", "error": "PHP adapter failed for all eligible source files"}
        evidence = check_cgroup_evidence(report, 2 * 1024 * 1024 * 1024, 256)
        finalized = finalize_report(report, 1, evidence)
        self.assertEqual(finalized["status"], "FAIL")
        self.assertEqual(finalized["error"], "PHP adapter failed for all eligible source files")
        self.assertEqual(finalized["resourceLimitEvidence"]["status"], "FAIL")
        self.assertIn("resourceLimitError", finalized)

    def test_missing_report_preserves_timeout_when_cgroup_evidence_is_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            report = load_report(Path(directory) / "missing.json", "owner/repo", "a" * 40,
                                 "Benchmark container exceeded the 300-second timeout.")
        finalized = finalize_report(report, 124, check_cgroup_evidence(report, 2 * 1024 * 1024 * 1024, 256))
        self.assertEqual(finalized["status"], "FAIL_PROCESS")
        self.assertIn("300-second timeout", finalized["error"])
        self.assertEqual(finalized["resourceLimitEvidence"]["status"], "FAIL")

    def test_invalid_json_becomes_a_per_corpus_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            path.write_text("{partial", encoding="utf-8")
            report = load_report(path, "owner/repo", "b" * 40)
        self.assertEqual(report["status"], "FAIL_REPORT")
        self.assertIn("could not be read as JSON", report["error"])

    def test_json_without_status_is_a_per_corpus_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "empty.json"
            path.write_text("{}", encoding="utf-8")
            report = load_report(path, "owner/repo", "c" * 40)
        self.assertEqual(report["status"], "FAIL_REPORT")
        self.assertIn("no string status", report["error"])

    def test_json_with_non_object_add_result_is_a_per_corpus_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad-add.json"
            path.write_text('{"status":"PASS","add":"unexpected"}', encoding="utf-8")
            report = load_report(path, "owner/repo", "d" * 40)
        self.assertEqual(report["status"], "FAIL_REPORT")
        self.assertIn("non-object ADD result", report["error"])

    def test_pass_is_rejected_when_swap_limit_does_not_match(self):
        report = {"status": "PASS", "containerPeakChargedBytes": 123, "containerCgroupLimits": {"memoryMaxBytes": 2 * 1024 * 1024 * 1024}}
        finalized = finalize_report(report, 0, check_cgroup_evidence(report, 2 * 1024 * 1024 * 1024, 256))
        self.assertEqual(finalized["status"], "FAIL_RESOURCE_LIMIT_EVIDENCE")

    def test_directory_at_primary_report_path_uses_a_host_report_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            primary = Path(directory) / "corpus-report.json"
            primary.mkdir()
            fallback = Path(directory) / "corpus-runner-report.json"
            path, error = write_final_report(primary, fallback, {"status": "FAIL_REPORT"})
            self.assertEqual(path, fallback)
            self.assertIsNotNone(error)
            self.assertEqual(json.loads(fallback.read_text(encoding="utf-8"))["status"], "FAIL_REPORT")

    def test_report_write_failure_is_returned_without_raising(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing" / "report.json"
            path, error = write_final_report(missing, missing.with_name("runner-report.json"), {"status": "FAIL"})
            self.assertIsNone(path)
            self.assertIn("Could not write report", error or "")


if __name__ == "__main__":
    unittest.main()
