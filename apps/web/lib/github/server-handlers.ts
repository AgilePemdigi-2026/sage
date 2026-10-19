import { createRepositoryHandlers } from "./handlers.ts";
import { readRepositorySession } from "./session.ts";
import { createTargetHandlers } from "./target-handlers.ts";

export const repositoryHandlers = createRepositoryHandlers({ env: process.env, readSession: readRepositorySession });
export const targetHandlers = createTargetHandlers({ env: process.env, readSession: readRepositorySession });
