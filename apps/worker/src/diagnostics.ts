/** Only fixed, non-sensitive values may cross the worker's log boundary. */
export type WorkerPhase = "startup" | "heartbeat" | "claim" | "handler" | "shutdown";
export type WorkerQueue = "analysis" | "export" | "cleanup";
export type WorkerErrorCode =
  | "DATABASE_UNREACHABLE" | "DATABASE_POOL_TIMEOUT" | "DATABASE_CONNECTION_LIMIT"
  | "DATABASE_TRANSACTION_CONFLICT" | "DATABASE_CONNECTION_LOST" | "DATABASE_TIMEOUT"
  | "DATABASE_AUTHENTICATION" | "DATABASE_SCHEMA" | "DATABASE_TRANSACTION_CLOSED"
  | "DATABASE_LOCK_TIMEOUT" | "DATABASE_STORAGE_FULL" | "DATABASE_RESOURCE_LIMIT" | "DATABASE_QUERY_FAILED" | "STORAGE_FULL" | "STORAGE_PERMISSION" | "STORAGE_IO"
  | "SYNTAX_ERROR" | "TYPE_ERROR" | "RANGE_ERROR" | "UNCLASSIFIED";

export interface WorkerErrorClassification {
  code: WorkerErrorCode;
  /** Only known pre-execution failures or confirmed transaction rollbacks. */
  retryableClaim: boolean;
  /** Heartbeat upsert is idempotent; connection-loss ambiguity is safe here. */
  retryableHeartbeat: boolean;
}

function own(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

const CODES: Readonly<Record<string, WorkerErrorCode>> = {
  P1001: "DATABASE_UNREACHABLE", ECONNREFUSED: "DATABASE_UNREACHABLE", ENOTFOUND: "DATABASE_UNREACHABLE",
  "53100": "DATABASE_STORAGE_FULL", "53200": "DATABASE_RESOURCE_LIMIT",
  P2024: "DATABASE_POOL_TIMEOUT", "55P03": "DATABASE_LOCK_TIMEOUT",
  P2037: "DATABASE_CONNECTION_LIMIT", "53300": "DATABASE_CONNECTION_LIMIT",
  P2034: "DATABASE_TRANSACTION_CONFLICT", "40001": "DATABASE_TRANSACTION_CONFLICT", "40P01": "DATABASE_TRANSACTION_CONFLICT",
  P1017: "DATABASE_CONNECTION_LOST", ECONNRESET: "DATABASE_CONNECTION_LOST", "08006": "DATABASE_CONNECTION_LOST", "57P01": "DATABASE_CONNECTION_LOST",
  P1002: "DATABASE_TIMEOUT", P1008: "DATABASE_TIMEOUT", ETIMEDOUT: "DATABASE_TIMEOUT", "57014": "DATABASE_TIMEOUT",
  P1000: "DATABASE_AUTHENTICATION", P1010: "DATABASE_AUTHENTICATION", "28P01": "DATABASE_AUTHENTICATION", "28000": "DATABASE_AUTHENTICATION",
  P1003: "DATABASE_SCHEMA", P2021: "DATABASE_SCHEMA", P2022: "DATABASE_SCHEMA", "42P01": "DATABASE_SCHEMA", "42703": "DATABASE_SCHEMA",
  P2028: "DATABASE_TRANSACTION_CLOSED",
  ENOSPC: "STORAGE_FULL", EACCES: "STORAGE_PERMISSION", EPERM: "STORAGE_PERMISSION", EIO: "STORAGE_IO", EROFS: "STORAGE_IO",
};
const KINDS: Readonly<Record<string, WorkerErrorCode>> = {
  DatabaseNotReachable: "DATABASE_UNREACHABLE", ConnectionClosed: "DATABASE_CONNECTION_LOST", SocketTimeout: "DATABASE_TIMEOUT",
  TooManyConnections: "DATABASE_CONNECTION_LIMIT", TransactionWriteConflict: "DATABASE_TRANSACTION_CONFLICT",
  AuthenticationFailed: "DATABASE_AUTHENTICATION", DatabaseAccessDenied: "DATABASE_AUTHENTICATION", TlsConnectionError: "DATABASE_AUTHENTICATION",
  DatabaseDoesNotExist: "DATABASE_SCHEMA", TableDoesNotExist: "DATABASE_SCHEMA", ColumnNotFound: "DATABASE_SCHEMA",
  TransactionAlreadyClosed: "DATABASE_TRANSACTION_CLOSED",
};

function classification(code: WorkerErrorCode): WorkerErrorClassification {
  const retryableClaim = code === "DATABASE_UNREACHABLE" || code === "DATABASE_POOL_TIMEOUT" ||
    code === "DATABASE_CONNECTION_LIMIT" || code === "DATABASE_TRANSACTION_CONFLICT" || code === "DATABASE_LOCK_TIMEOUT";
  return {
    code, retryableClaim,
    retryableHeartbeat: retryableClaim || code === "DATABASE_CONNECTION_LOST" || code === "DATABASE_TIMEOUT",
  };
}

/**
 * Inspect only known Prisma/pg wrapper paths and own data properties. Never emit
 * messages, names, metadata, query parameters, causes, stacks, IDs or URLs.
 * The pg-pool literal below is an exact pre-checkout timeout from installed
 * pg-pool, not a substring match against arbitrary provider text.
 */
export function classifyWorkerError(error: unknown): WorkerErrorClassification {
  const nodes: unknown[] = [error];
  const visited = new Set<unknown>();
  let genericQueryFailure = false;
  for (let index = 0; index < nodes.length && index < 16; index += 1) {
    const node = nodes[index];
    if (node === null || typeof node !== "object" || visited.has(node)) continue;
    visited.add(node);
    for (const key of ["code", "errorCode", "originalCode"]) {
      const value = own(node, key);
      if (typeof value !== "string") continue;
      if (Object.hasOwn(CODES, value)) return classification(CODES[value]!);
      if (value === "P2010") genericQueryFailure = true;
    }
    const kind = own(node, "kind");
    if (typeof kind === "string" && Object.hasOwn(KINDS, kind)) return classification(KINDS[kind]!);
    if (own(node, "message") === "timeout exceeded when trying to connect") return classification("DATABASE_POOL_TIMEOUT");
    // DriverAdapterError.cause and Prisma's meta.driverAdapterError.cause.
    for (const key of ["cause", "meta", "driverAdapterError"]) {
      const nested = own(node, key);
      if (typeof nested === "object" && nested !== null) nodes.push(nested);
    }
  }
  if (genericQueryFailure) return classification("DATABASE_QUERY_FAILED");
  try {
    if (error instanceof SyntaxError) return classification("SYNTAX_ERROR");
    if (error instanceof TypeError) return classification("TYPE_ERROR");
    if (error instanceof RangeError) return classification("RANGE_ERROR");
  } catch { /* A hostile proxy must not escape the safe diagnostic boundary. */ }
  return classification("UNCLASSIFIED");
}
