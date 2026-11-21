import { cache } from "react";
import { readWorkspaceContextCached } from "./workspace-context.ts";

/** Minimal, non-secret identity shown in the header account pill. */
export type HeaderAccount = { readonly login: string; readonly displayName: string | null };

/** Reads the existing session for the header only; any failure renders the logged-out header. */
export const readHeaderAccount = cache(async (): Promise<HeaderAccount | null> => {
  try {
    const context = await readWorkspaceContextCached();
    return context ? { login: context.login, displayName: context.displayName } : null;
  } catch {
    return null;
  }
});
