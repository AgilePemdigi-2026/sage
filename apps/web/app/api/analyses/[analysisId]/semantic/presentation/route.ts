import { semanticHandlers } from "../../../../../../lib/semantic/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  return semanticHandlers.patchPresentation(request, (await context.params).analysisId);
}
