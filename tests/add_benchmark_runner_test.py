from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from add_benchmark_runner import check_cgroup_evidence, finalize_report, load_report


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

    def test_pass_is_rejected_when_swap_limit_does_not_match(self):
        report = {"status": "PASS", "containerPeakChargedBytes": 123, "containerCgroupLimits": {"memoryMaxBytes": 2 * 1024 * 1024 * 1024}}
        finalized = finalize_report(report, 0, check_cgroup_evidence(report, 2 * 1024 * 1024 * 1024, 256))
        self.assertEqual(finalized["status"], "FAIL_RESOURCE_LIMIT_EVIDENCE")


if __name__ == "__main__":
    unittest.main()
