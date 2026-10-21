import { documentHandlers } from "../../../../../lib/documents/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  return documentHandlers.get(request, (await context.params).analysisId);
}
