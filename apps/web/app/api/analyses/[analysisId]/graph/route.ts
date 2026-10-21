import { graphHandlers } from "../../../../../lib/graphs/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  return graphHandlers.get(request, (await context.params).analysisId);
}
