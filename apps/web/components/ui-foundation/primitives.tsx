import type { ReactNode } from "react";
import styles from "./ui-foundation.module.css";

export function Icon({ name, className }: { name: "code" | "repository" | "progress" | "github" | "arrow" | "check"; className?: string }) {
  const paths = {
    code: <><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></>,
    repository: <><path d="M5 3h12a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Z" /><path d="M3 17h16M7 7h8M7 11h5" /></>,
    progress: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="7" cy="6" r="2" /><circle cx="13" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></>,
    github: <><path d="M9 19c-4 1-4-2-6-2m12 5v-4a3.5 3.5 0 0 0-1-3c3 0 6-1.5 6-5a4 4 0 0 0-1-3c.3-1 .2-2-.3-3-1.5 0-3 1-3 1a11 11 0 0 0-6 0s-1.5-1-3-1C6.2 5 6 6 6.3 7a4 4 0 0 0-1 3c0 3.5 3 5 6 5a3.5 3.5 0 0 0-1 3v4" /></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
  };
  return <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function Notice({ tone = "info", title, children, action }: { tone?: "info" | "error" | "success" | "warning"; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className={`${styles.notice} ${styles[tone]}`} role={tone === "error" ? "alert" : "status"}>
    <strong>{title}</strong>{children && <div>{children}</div>}{action && <div className={styles.noticeAction}>{action}</div>}
  </div>;
}

export function Loading({ label }: { label: string }) {
  return <div className={styles.loading} role="status"><span className={styles.spinner} aria-hidden="true" /><span>{label}</span></div>;
}

export function Badge({ children }: { children: ReactNode }) { return <span className={styles.badge}>{children}</span>; }
