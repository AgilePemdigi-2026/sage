"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import assetManifest from "../../public/design/figma/manifest.json";
import { useHeaderAccount } from "./account-context.tsx";
import styles from "./ui.module.css";

type AssetRecord = { src: string; width: string; height: string };
const assets = assetManifest as Record<string, Record<string, AssetRecord>>;

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

/* ── Header (RD/Header, frame 01) ─────────────────────────────────────── */

export type NavKey = "home" | "repositories" | "history" | "docs" | "none";

const navigation: ReadonlyArray<{ key: Exclude<NavKey, "none">; label: string; href: string }> = [
  { key: "home", label: "Beranda", href: "/" },
  { key: "repositories", label: "Repository", href: "/workspace/repositories" },
  { key: "history", label: "Riwayat", href: "/workspace/history" },
  { key: "docs", label: "Dokumentasi", href: "/#dokumentasi" },
];

/** Di landing, pill aktif mengikuti section yang terlihat (#dokumentasi → Dokumentasi, selain itu Beranda). */
function useLandingSection(enabled: boolean): NavKey {
  const [section, setSection] = useState<NavKey>("home");
  useEffect(() => {
    if (!enabled) return;
    const target = document.getElementById("dokumentasi");
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setSection(entry?.isIntersecting ? "docs" : "home"),
      { rootMargin: "-35% 0px -55% 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled]);
  return section;
}

function initials(account: { login: string; displayName: string | null }): string {
  const source = account.displayName?.trim() || account.login;
  const parts = source.split(/[\s._-]+/u).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

function AccountMenu({ login, displayName }: { login: string; displayName: string | null }) {
  return <details className={styles.account}>
    <summary className={styles.accountPill} aria-label={`Akun @${login}`}>
      <span className={styles.avatar} aria-hidden="true">{initials({ login, displayName })}</span>
      <span className={styles.accountName}>@{login}</span>
      <AssetIcon group="header" name="imgIconChevronDown" className={styles.chevron} />
    </summary>
    <div className={styles.accountMenu}>
      <Link href="/workspace">Workspace</Link>
      <form action="/auth/logout" method="post"><button type="submit">Keluar</button></form>
    </div>
  </details>;
}

export function DesignFrame({ children, active = "none" }: {
  children: React.ReactNode;
  active?: NavKey;
}) {
  const pathname = usePathname();
  const onLanding = pathname === "/";
  const onLogin = pathname === "/login";
  const landingSection = useLandingSection(onLanding);
  const current: NavKey = onLanding ? landingSection : active;
  const account = useHeaderAccount();

  return <div className={styles.frame}>
    <a className={styles.skip} href="#main-content">Lewati navigasi</a>
    <header className={styles.header}>
      <Link className={styles.brand} href="/" aria-label="SAGE, halaman utama">SAGE<span>.</span></Link>
      <nav className={styles.nav} aria-label="Navigasi utama">
        {navigation.map(item => <Link
          key={item.key}
          href={item.href}
          className={styles.navPill}
          aria-current={current === item.key ? (item.key === "docs" ? "location" : "page") : undefined}
        >{item.label}</Link>)}
      </nav>
      <div className={styles.headerEnd}>
        {account
          ? <AccountMenu login={account.login} displayName={account.displayName} />
          : onLogin ? null : <Button href="/login" variant="primary" size="md">Masuk</Button>}
      </div>
    </header>
    <main className={styles.main} id="main-content" tabIndex={-1}>{children}</main>
  </div>;
}

/* ── RD/Button ────────────────────────────────────────────────────────── */

type ButtonOwnProps = {
  variant?: "primary" | "secondary" | "ghost";
  size?: "md" | "lg";
  block?: boolean;
  /** Tambahkan panah yang bergeser 4px saat hover. */
  arrow?: boolean;
  children: ReactNode;
  className?: string;
};
type ButtonAsButton = ButtonOwnProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonOwnProps> & { href?: undefined };
type ButtonAsLink = ButtonOwnProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonOwnProps> & { href: string };

export function Button(props: ButtonAsButton | ButtonAsLink) {
  const { variant = "primary", size = "md", block = false, arrow = false, children, className, ...rest } = props;
  const classes = cx(
    styles.button, styles[`button_${variant}`], size === "lg" && styles.button_lg, block && styles.button_block,
    "hover-lift-button", arrow && "hover-arrow", className,
  );
  const content = <>{children}{arrow ? <ArrowIcon /> : null}</>;
  if (typeof rest.href === "string") {
    const { href, ...anchor } = rest as Omit<ButtonAsLink, keyof ButtonOwnProps>;
    return <Link href={href} className={classes} {...anchor}>{content}</Link>;
  }
  const { type = "button", ...button } = rest as Omit<ButtonAsButton, keyof ButtonOwnProps>;
  return <button type={type} className={classes} {...button}>{content}</button>;
}

export function ArrowIcon() {
  return <svg data-arrow width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.333 8h9.334M8.667 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/* ── Card ─────────────────────────────────────────────────────────────── */

export function Panel({ title, children, className, interactive = false }: {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Kartu yang bisa diklik/hover: naik 4px, border teal, bayangan pop. */
  interactive?: boolean;
}) {
  return <section className={cx(styles.panel, interactive && "hover-lift-card", className)}>
    {title ? <h2 className={styles.panelTitle}>{title}</h2> : null}
    {children}
  </section>;
}

/* ── RD/Badge ─────────────────────────────────────────────────────────── */

export type BadgeTone = "info" | "success" | "warning" | "error" | "neutral" | "teal";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return <span className={`${styles.badge} ${styles[`badge_${tone}`]}`}>{children}</span>;
}

/* ── RD/Side link ─────────────────────────────────────────────────────── */

export function SideLink({ href, selected = false, children, className }: {
  href: string;
  selected?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return <Link href={href} className={cx(styles.sideLink, className)} aria-current={selected ? "location" : undefined}>{children}</Link>;
}

/* ── Field (frame 02) ─────────────────────────────────────────────────── */

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "children"> & {
  label: ReactNode;
  /** Ikon 18px di kiri (dekoratif). */
  icon?: ReactNode;
  /** Elemen di kanan, misalnya chevron select atau tombol salin. */
  trailing?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  mono?: boolean;
  /** Ganti <input> bawaan, misalnya dengan <select>. Kontrol harus memakai id yang sama. */
  children?: ReactNode;
};

export function Field({ label, icon, trailing, hint, error, optional = false, mono = false, children, id, className, ...input }: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = cx(input["aria-describedby"], hintId, errorId) || undefined;
  return <div className={cx(styles.field, className)}>
    <label className={styles.fieldLabel} htmlFor={controlId}>{label}{optional ? <span className={styles.fieldOptional}>(opsional)</span> : null}</label>
    <div className={cx(styles.fieldControl, mono && styles.fieldMono)} data-invalid={error ? "true" : undefined} data-disabled={input.disabled ? "true" : undefined}>
      {icon ? <span className={styles.fieldIcon} aria-hidden="true">{icon}</span> : null}
      {children ?? <input id={controlId} {...input} aria-invalid={error ? true : input["aria-invalid"]} aria-describedby={describedBy} />}
      {trailing}
    </div>
    {hint ? <p id={hintId} className={styles.fieldHint}>{hint}</p> : null}
    {error ? <p id={errorId} className={styles.fieldError} role="alert">{error}</p> : null}
  </div>;
}

/* ── RD/Pipeline step ─────────────────────────────────────────────────── */

export type PipelineStepStatus = "done" | "active" | "pending" | "failed";

export function PipelineStep({ status, title, meta, aside, className, ...rest }: {
  status: PipelineStepStatus;
  title: ReactNode;
  meta?: ReactNode;
  /** Teks kanan (mono), misalnya durasi dari startedAt/finishedAt. */
  aside?: ReactNode;
  className?: string;
} & Omit<React.LiHTMLAttributes<HTMLLIElement>, "title">) {
  return <li className={cx(styles.step, className)} data-status={status} aria-current={status === "active" ? "step" : undefined} {...rest}>
    <span className={styles.stepIndicator} aria-hidden="true">
      {status === "done" ? <AssetIcon group="pipeline" name="imgIconCheck" /> : null}
    </span>
    <span className={styles.stepText}>
      <span className={styles.stepTitle}>{title}</span>
      {meta ? <span className={styles.stepMeta}>{meta}</span> : null}
    </span>
    {aside ? <span className={styles.stepAside}>{aside}</span> : null}
  </li>;
}

/* ── Util ─────────────────────────────────────────────────────────────── */

export function CopySha({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }
  return <div className={styles.copySha}>
    <code>{sha}</code>
    <button type="button" onClick={() => void copy()} aria-label="Salin SHA lengkap">{copied ? "Tersalin" : "Salin"}</button>
  </div>;
}

export function AssetIcon({ group, name, className }: { group: string; name: string; className?: string }) {
  const record = assets[group]?.[name];
  if (!record) return null;
  // eslint-disable-next-line @next/next/no-img-element -- Local Figma SVGs keep their manifest dimensions.
  return <img
    className={className}
    src={record.src}
    width={Number(record.width)}
    height={Number(record.height)}
    alt=""
    aria-hidden="true"
  />;
}
