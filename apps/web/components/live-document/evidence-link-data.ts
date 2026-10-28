import type { EvidenceSpan } from "@sage/contracts";

const COMMIT_SHA = /^[a-f0-9]{40}$/i;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Link a source-backed span to the exact repository snapshot used by this analysis. */
export function githubEvidenceHref(
  repository: string,
  commitSha: string,
  evidence: Pick<EvidenceSpan, "filePath" | "startLine" | "endLine">,
): string | null {
  const parts = repository.split("/");
  const pathParts = evidence.filePath.split("/");
  if (!REPOSITORY_NAME.test(repository) || parts[0] === "." || parts[0] === ".." || parts[1] === "." || parts[1] === ".." ||
      !COMMIT_SHA.test(commitSha) || !evidence.filePath || evidence.filePath.startsWith("/") || evidence.filePath.includes("\\") ||
      pathParts.some(part => !part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/u.test(part)) ||
      !Number.isSafeInteger(evidence.startLine) || evidence.startLine < 1 ||
      !Number.isSafeInteger(evidence.endLine) || evidence.endLine < evidence.startLine) return null;

  const [owner, name] = parts;
  const encodedPath = pathParts.map(part => encodeURIComponent(part)).join("/");
  const fragment = evidence.startLine === evidence.endLine
    ? `#L${evidence.startLine}`
    : `#L${evidence.startLine}-L${evidence.endLine}`;
  return `https://github.com/${owner}/${name}/blob/${commitSha}/${encodedPath}${fragment}`;
}
