import type { SourceAnalysisResult } from "../apps/worker/src/source-analysis.ts";

export type AddBenchmarkLanguageCoverage = {
  eligible: number;
  processed: number;
  failed: number;
};

export type AddBenchmarkSourceSummary = {
  status: SourceAnalysisResult["status"];
  errorCode: SourceAnalysisResult["errorCode"];
  counts: {
    total: number;
    recognized: number;
    eligible: number;
    excluded: number;
    processed: number;
    failed: number;
    languages: Record<string, AddBenchmarkLanguageCoverage>;
  };
};

export function summarizeAddBenchmarkSource(result: SourceAnalysisResult): AddBenchmarkSourceSummary {
  const languages = Object.fromEntries(Object.entries(result.report.counts.languages).map(([language, counts]) => [language, {
    eligible: counts.eligible,
    processed: counts.processed,
    failed: counts.failed,
  }]));
  const summary: AddBenchmarkSourceSummary = {
    status: result.status,
    errorCode: result.errorCode,
    counts: {
      total: result.report.counts.total,
      recognized: result.report.counts.recognized,
      eligible: result.report.counts.eligible,
      excluded: result.report.counts.excluded,
      processed: result.report.counts.processed,
      failed: result.report.counts.failed,
      languages,
    },
  };

  return summary;
}

export function assertAddBenchmarkSourceQuality(result: SourceAnalysisResult): void {
  if (result.status === "failed" || !result.ccm) {
    throw new Error(`Source analysis failed: ${result.errorCode ?? "no validated source model"}.`);
  }

  const uncovered = Object.entries(result.report.counts.languages)
    .filter(([, counts]) => counts.eligible > 0 && counts.processed === 0)
    .map(([language, counts]) => `${language} (${counts.eligible} eligible, ${counts.failed} failed)`);
  if (uncovered.length > 0) {
    throw new Error(`Source analysis processed no eligible files for: ${uncovered.join(", ")}.`);
  }

  for (const [language, counts] of Object.entries(result.report.counts.languages)) {
    if (counts.eligible !== counts.processed + counts.failed) {
      throw new Error(`Source analysis coverage is incomplete for ${language}: ${counts.eligible} eligible, ${counts.processed} processed, ${counts.failed} failed.`);
    }
  }

}
