import { exportHandlers } from "../../../../../lib/exports/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  return exportHandlers.post(request, (await context.params).analysisId);
}
