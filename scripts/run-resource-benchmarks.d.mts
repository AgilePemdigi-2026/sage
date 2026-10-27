import type { ResourceWorkloadResult } from "./benchmark-resource-workload.ts";
export const RESOURCE_CASES: Readonly<Record<string, { manifest: string; root: string; language: "javascript" | "php" }>>;
export function parseArguments(argv: string[], cwd?: string): { image: string; iterations: number; output: string; cases: string[] };
export function validateWorkloadPayload(value: unknown, expectedManifestId: string, expectedLanguage: string): { valid: boolean; failureCode: string | null; result: ResourceWorkloadResult | null };
