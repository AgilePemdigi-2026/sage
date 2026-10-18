import type { AnalysisTarget } from "./types";

export type TargetErrors = Partial<Record<"repository" | "branch" | "commit", string>>;
export type TargetValidation = { valid: true; target: AnalysisTarget } | { valid: false; errors: TargetErrors };

/** Syntax only. The server must check existence, permissions, branch history and full SHA. */
export function normalizeRepository(input: string): string | null {
  let slug = input.trim();
  if (/^https?:\/\//i.test(slug)) {
    try {
      const url = new URL(slug);
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash) return null;
      const path = slug.match(/^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/?$/i);
      if (!path) return null;
      slug = `${path[1]}/${path[2]}`;
    } catch { return null; }
  }
  slug = slug.replace(/\.git$/, "");
  const segments = slug.split("/");
  if (segments.length !== 2) return null;
  const [owner, name] = segments;
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner) || owner.includes("--")) return null;
  if (!/^[a-z\d_.-]{1,100}$/i.test(name) || name === "." || name === "..") return null;
  return `${owner}/${name}`;
}

export function validateTarget(input: AnalysisTarget, availableBranches: readonly string[]): TargetValidation {
  const errors: TargetErrors = {};
  const repository = normalizeRepository(input.repository);
  const branch = input.branch.trim();
  const commit = input.commit?.trim() || null;
  if (!repository) errors.repository = "Gunakan owner/repository atau URL HTTPS github.com yang valid.";
  if (!branch || !availableBranches.includes(branch)) errors.branch = "Pilih branch yang tersedia untuk repository ini.";
  if (commit && !/^[a-f\d]{7,40}$/i.test(commit)) errors.commit = "Commit harus berisi 7–40 karakter heksadesimal, atau kosongkan.";
  return Object.keys(errors).length ? { valid: false, errors } : { valid: true, target: { repository: repository!, branch, commit } };
}
