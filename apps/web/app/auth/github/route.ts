import { createGitHubOAuthAttempt, database } from "@sage/database";
import { createGitHubReadOnlyLoginHandler, createGitHubStartHandler } from "../../../lib/auth/handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return createGitHubStartHandler({
    env: process.env,
    createAttempt: () => createGitHubOAuthAttempt(database()),
    consumeAttempt: async () => null,
    completeLogin: async () => { throw new Error("Not used by login start"); },
    revokeSession: async () => false,
  })(request);
}

export const GET = createGitHubReadOnlyLoginHandler();
