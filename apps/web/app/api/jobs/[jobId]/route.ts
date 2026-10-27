import { cleanupHandlers } from "../../../../lib/analyses/cleanup-server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  return cleanupHandlers.job(request, (await context.params).jobId);
}
