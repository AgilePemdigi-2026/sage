import { retryAnalysisHandler } from "../../../../../lib/analyses/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  return retryAnalysisHandler(request, (await context.params).analysisId);
}
