import { inspectorHandlers } from "../../../../../../lib/graphs/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ analysisId: string; nodeId: string }> },
) {
  const { analysisId, nodeId } = await context.params;
  return inspectorHandlers.getNode(request, analysisId, nodeId);
}
