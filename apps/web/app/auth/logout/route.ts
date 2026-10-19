import { database, revokeSession } from "@sage/database";
import { createGitHubLogoutHandler } from "../../../lib/auth/handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return createGitHubLogoutHandler({
    env: process.env,
    createAttempt: async () => { throw new Error("Not used by logout"); },
    consumeAttempt: async () => null,
    completeLogin: async () => { throw new Error("Not used by logout"); },
    revokeSession: (token) => revokeSession(database(), token),
  })(request);
}
