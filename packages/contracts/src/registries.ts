/** Browser-safe enum registries; canonical hashing stays in the server entry point. */
export const SCHEMA_VERSION = 1 as const;
export const LANGUAGES = ["javascript", "typescript", "php"] as const;
export const NODE_KINDS = ["Module", "Class", "Interface", "Function", "Method", "Property", "UnresolvedReference"] as const;
export const EDGE_KINDS = [
  "CONTAINS", "IMPORTS", "EXPORTS", "EXTENDS", "IMPLEMENTS", "TYPE_REFERENCES", "CALLS",
  "INSTANTIATES", "READS", "WRITES", "THROWS", "INCLUDES",
] as const;
export const NODE_ORIGINS = ["source", "stdlib", "external", "unresolved"] as const;
export const EDGE_RESOLUTIONS = ["Exact", "Unresolved"] as const;
export const UNRESOLVED_REASONS = [
  "DYNAMIC_LOAD", "UNKNOWN_RECEIVER", "EXTERNAL_DEPENDENCY", "UNSUPPORTED_CONSTRUCT", "AMBIGUOUS_SYMBOL",
] as const;
export const EVIDENCE_ROLES = ["declaration", "reference", "context"] as const;
