import {
  completeGitHubLogin,
  consumeGitHubOAuthAttempt,
  database,
} from "@sage/database";
import { createGitHubCallbackHandler } from "../../../../lib/auth/handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return createGitHubCallbackHandler({
    env: process.env,
    createAttempt: async () => { throw new Error("Not used by callback"); },
    consumeAttempt: ({ state, browserToken }) => consumeGitHubOAuthAttempt(database(), { state, browserToken }),
    completeLogin: (input) => completeGitHubLogin(database(), input),
    revokeSession: async () => false,
  })(request);
}
