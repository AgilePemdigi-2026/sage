import { addHandlers } from "../../../../../lib/add/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  return addHandlers.get(request, (await context.params).analysisId);
}

export async function POST(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  return addHandlers.generate(request, (await context.params).analysisId);
}

export async function PATCH(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  return addHandlers.updateReview(request, (await context.params).analysisId);
}
