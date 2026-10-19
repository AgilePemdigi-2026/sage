import { createRepositoryHandlers } from "./handlers.ts";
import { readRepositorySession } from "./session.ts";

export const repositoryHandlers = createRepositoryHandlers({ env: process.env, readSession: readRepositorySession });
