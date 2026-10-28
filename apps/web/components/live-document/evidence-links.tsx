import type { EvidenceSpan } from "@sage/contracts";
import { githubEvidenceHref } from "./evidence-link-data.ts";
import styles from "./evidence-links.module.css";

function shortPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : filePath;
}

export function EvidenceLink({
  repository,
  commitSha,
  evidence,
  role,
}: {
  repository: string;
  commitSha: string;
  evidence: Pick<EvidenceSpan, "filePath" | "startLine" | "endLine">;
  role?: string;
}) {
  const href = githubEvidenceHref(repository, commitSha, evidence);
  const lineRange = evidence.startLine === evidence.endLine
    ? `baris ${evidence.startLine}`
    : `baris ${evidence.startLine}–${evidence.endLine}`;
  const label = `${shortPath(evidence.filePath)} · ${lineRange}${role ? ` · ${role}` : ""}`;
  return href
    ? <a className={`sageEvidenceLink ${styles.link}`} href={href} target="_blank" rel="noopener noreferrer" title={`${evidence.filePath} · ${lineRange}${role ? ` · ${role}` : ""}`}>{label}</a>
    : <span className={`sageEvidenceLink ${styles.link}`} title="Lokasi bukti tidak dapat ditautkan dengan aman">{label}</span>;
}
