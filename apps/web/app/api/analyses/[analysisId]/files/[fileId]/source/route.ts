import { inspectorHandlers } from "../../../../../../../lib/graphs/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ analysisId: string; fileId: string }> },
) {
  const { analysisId, fileId } = await context.params;
  return inspectorHandlers.getSource(request, analysisId, fileId);
}
