import { exportHandlers } from "../../../../../../../lib/exports/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ analysisId: string; exportId: string }> }) {
  const { analysisId, exportId } = await context.params;
  return exportHandlers.retry(request, analysisId, exportId);
}
