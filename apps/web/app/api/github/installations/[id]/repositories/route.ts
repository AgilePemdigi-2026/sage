import { repositoryHandlers } from "../../../../../../lib/github/server-handlers.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return repositoryHandlers.installationRepositories(request, (await context.params).id);
}
