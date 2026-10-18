import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

type ParseProbe = { valid: boolean; parserVersion?: string; phpVersion?: string; statementKinds?: string[]; diagnostics: unknown[] };

export function parsePhp(source: string): Promise<ParseProbe> {
  return new Promise((resolve, reject) => {
    const child = execFile("php", [fileURLToPath(new URL("../bin/probe.php", import.meta.url))], { timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error("PHP_PARSER_UNAVAILABLE"));
      try { resolve(JSON.parse(stdout) as ParseProbe); } catch { reject(new Error("PHP_PARSER_INVALID_RESPONSE")); }
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(source);
  });
}
