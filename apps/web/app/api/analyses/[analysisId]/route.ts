import { analysisHandlers } from "../../../../lib/analyses/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  return analysisHandlers.detail(request, (await context.params).analysisId);
}
