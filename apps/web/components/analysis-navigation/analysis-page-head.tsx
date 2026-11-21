import { analysisStatusBadge } from "../history/format.ts";
import { AssetIcon, Badge, CopySha, MaskIcon, PageHead, Stepper } from "../design-system/ui.tsx";
import designStyles from "../design-system/ui.module.css";
import type { AnalysisHeadData } from "../../lib/analyses/analysis-head.ts";
import styles from "./analysis-page-head.module.css";

/** Page head bersama untuk ketiga tab analisis: Workspace / Riwayat / owner/repo / tab. */
export function AnalysisPageHead({ head, tab, badgeLabel }: {
  head: Pick<AnalysisHeadData, "repositoryFullName" | "branchName" | "commitSha" | "status">;
  tab: "Progres" | "TOGAF ADD" | "Code Knowledge";
  /** Label badge khusus (mis. "Berjalan · tahap 4 dari 9"); default dari analysisStatusBadge. */
  badgeLabel?: string;
}) {
  const badge = analysisStatusBadge(head.status);
  return <PageHead
    breadcrumb={[{ label: "Workspace", href: "/workspace" }, { label: "Riwayat", href: "/workspace/history" }, { label: head.repositoryFullName }, { label: tab }]}
    title={<span className={styles.title}>{head.repositoryFullName}</span>}
    description={<div className={styles.meta}>
      <span className={styles.chip}><MaskIcon group="repository" name="imgBranch" size={14} /><span className={designStyles.srOnly}>Branch </span>{head.branchName}</span>
      <span className={`${styles.chip} ${styles.chipSha}`}><AssetIcon group="progress-v2" name="imgCommit" /><span className={designStyles.srOnly}>Commit </span><CopySha sha={head.commitSha} /></span>
      <span className={styles.status} aria-live="polite"><Badge tone={badge.tone} pulse={head.status === "RUNNING"}>{badgeLabel ?? badge.label}</Badge></span>
    </div>}
    aside={<Stepper steps={["Repository", "Target", "Analisis"]} current={2} label="Langkah analisis" />}
  />;
}
