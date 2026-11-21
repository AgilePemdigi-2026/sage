"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type AnchorHTMLAttributes, type CSSProperties, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
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
    <header className={styles.header} data-print-hide>
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
  /** `github` = latar ink + teks putih (tombol GitHub, CLAUDE.md). */
  variant?: "primary" | "secondary" | "ghost" | "github" | "link";
  size?: "md" | "lg";
  block?: boolean;
  /** Tambahkan panah yang bergeser 4px saat hover. */
  arrow?: boolean;
  /** Proses berjalan: spinner + label proses, tombol nonaktif. Isi `children` dengan label proses. */
  loading?: boolean;
  children: ReactNode;
  className?: string;
};
type ButtonAsButton = ButtonOwnProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonOwnProps> & { href?: undefined };
type ButtonAsLink = ButtonOwnProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonOwnProps> & { href: string };

export function Button(props: ButtonAsButton | ButtonAsLink) {
  const { variant = "primary", size = "md", block = false, arrow = false, loading = false, children, className, ...rest } = props;
  const classes = cx(
    styles.button, styles[`button_${variant}`], size === "lg" && styles.button_lg, block && styles.button_block,
    "hover-lift-button", arrow && "hover-arrow", className,
  );
  const content = <>{loading ? <Spinner /> : null}{children}{arrow && !loading ? <ArrowIcon /> : null}</>;
  if (typeof rest.href === "string") {
    const { href, ...anchor } = rest as Omit<ButtonAsLink, keyof ButtonOwnProps>;
    return <Link href={href} className={classes} {...anchor}>{content}</Link>;
  }
  const { type = "button", ...button } = rest as Omit<ButtonAsButton, keyof ButtonOwnProps>;
  return <button type={type} className={classes} {...button} disabled={button.disabled || loading} aria-busy={loading || undefined}>{content}</button>;
}

export function ArrowIcon() {
  return <svg data-arrow width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.333 8h9.334M8.667 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/* ── Pill & bagian terlihat ───────────────────────────────────────── */

export function PillLink({ href, active = false, children }: { href: string; active?: boolean; children: ReactNode }) {
  return <a className={styles.pill} href={href} aria-current={active ? "location" : undefined}>{children}</a>;
}

/** Pill kit sebagai tombol toggle (filter). Gaya sama dengan PillLink. */
export function PillButton({ pressed, onClick, children, disabled }: { pressed: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return <button type="button" className={styles.pill} aria-pressed={pressed} onClick={onClick} disabled={disabled}>{children}</button>;
}

/** Scrollspy: section aktif = section terakhir yang tepi atasnya sudah melewati garis aktivasi
 *  (header sticky + 30% tinggi viewport). Diperbarui oleh IntersectionObserver dan scroll (rAF). */
export function useVisibleSection(ids: readonly string[], enabled = true): string {
  const [visible, setVisible] = useState(ids[0] ?? "");
  const key = ids.join("|");
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const list = key.split("|");
    let frame = 0;
    const compute = () => {
      frame = 0;
      const line = 72 + window.innerHeight * 0.3;
      let current = list[0] ?? "";
      for (const id of list) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top <= line) current = id;
      }
      setVisible(current);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(compute); };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(schedule, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    for (const id of list) { const element = document.getElementById(id); if (element) observer?.observe(element); }
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    compute();
    return () => { observer?.disconnect(); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); if (frame) window.cancelAnimationFrame(frame); };
  }, [key, enabled]);
  return visible;
}

/* ── ScrollList ───────────────────────────────────────────────────── */

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Gulir hanya container (bukan halaman) agar elemen terlihat, setara block: "nearest". */
function scrollWithin(container: HTMLElement, target: Element) {
  const box = container.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
  if (item.top < box.top) container.scrollBy({ top: item.top - box.top - 4, behavior });
  else if (item.bottom > box.bottom) container.scrollBy({ top: item.bottom - box.bottom + 4, behavior });
}

/**
 * Daftar dengan tinggi maksimum `maxRows` baris; sisanya di-scroll di dalam container.
 * Tinggi dihitung dari baris (li) pertama + gap daftar. Fade 24 px hanya saat ada konten tersembunyi.
 */
export function ScrollList({ label, children, footer, maxRows = 5 }: { label: string; children: ReactNode; footer?: ReactNode; maxRows?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastSelected = useRef<Element | null>(null);
  const [state, setState] = useState({ scrollable: false, top: false, bottom: false });
  const update = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const firstRow = element.querySelector("li");
    if (firstRow?.parentElement) {
      const gap = parseFloat(getComputedStyle(firstRow.parentElement).rowGap) || 0;
      const padding = parseFloat(getComputedStyle(element).paddingTop) * 2;
      const max = firstRow.getBoundingClientRect().height * maxRows + gap * (maxRows - 1) + padding;
      element.style.setProperty("--scroll-list-max", `${Math.ceil(max)}px`);
    }
    const scrollable = element.scrollHeight > element.clientHeight + 1;
    const next = {
      scrollable,
      top: scrollable && element.scrollTop > 1,
      bottom: scrollable && element.scrollTop + element.clientHeight < element.scrollHeight - 1,
    };
    setState(previous => previous.scrollable === next.scrollable && previous.top === next.top && previous.bottom === next.bottom ? previous : next);
  }, [maxRows]);
  useLayoutEffect(() => {
    update();
    const element = ref.current;
    if (!element) return;
    const selected = element.querySelector('[aria-pressed="true"]');
    if (selected && selected !== lastSelected.current) scrollWithin(element, selected.closest("li") ?? selected);
    lastSelected.current = selected;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => update());
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [update]);
  const fade = state.top && state.bottom ? "both" : state.top ? "top" : state.bottom ? "bottom" : undefined;
  return <div
    ref={ref}
    className={styles.scrollList}
    data-fade={fade}
    role={state.scrollable ? "region" : undefined}
    aria-label={state.scrollable ? label : undefined}
    tabIndex={state.scrollable ? 0 : undefined}
    onScroll={update}
    onFocus={event => { if (ref.current && event.target !== ref.current) scrollWithin(ref.current, event.target.closest("li") ?? event.target); }}
  >
    {children}
    {footer ? <div className={styles.scrollListFooter}>{footer}</div> : null}
  </div>;
}

/* ── OverflowX: kontainer scroll horizontal (tabel lebar) ───────── */

/** Pola sama dengan ScrollList: fade 24 px hanya di sisi yang masih menyembunyikan konten; region + tabIndex hanya saat bisa digulir. */
export function OverflowX({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ scrollable: false, left: false, right: false });
  const update = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const scrollable = element.scrollWidth > element.clientWidth + 1;
    const next = { scrollable, left: scrollable && element.scrollLeft > 1, right: scrollable && element.scrollLeft + element.clientWidth < element.scrollWidth - 1 };
    setState(previous => previous.scrollable === next.scrollable && previous.left === next.left && previous.right === next.right ? previous : next);
  }, []);
  useLayoutEffect(() => { update(); });
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => update());
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [update]);
  const fade = state.left && state.right ? "both" : state.left ? "left" : state.right ? "right" : undefined;
  return <div
    ref={ref}
    className={cx(styles.overflowX, className)}
    data-fade={fade}
    role={state.scrollable ? "region" : undefined}
    aria-label={state.scrollable ? label : undefined}
    tabIndex={state.scrollable ? 0 : undefined}
    onScroll={update}
  >{children}</div>;
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

/* ── Feature card (frame 01, 251:112) ───────────────────────────────── */

/** Ikon aset Figma yang bisa diwarnai ulang (mask + currentColor), mis. saat hover kartu. */
export function MaskIcon({ group, name, size, className }: { group: string; name: string; size?: number; className?: string }) {
  const record = assets[group]?.[name];
  if (!record) return null;
  const width = size ?? Number(record.width);
  const height = size ?? Number(record.height);
  const style = { width, height, "--icon": `url(${record.src})` } as CSSProperties;
  return <span className={cx(styles.maskIcon, className)} style={style} aria-hidden="true" />;
}

export function FeatureCard({ icon, number, title, children, href, linkLabel, headingLevel = 3 }: {
  icon: { group: string; name: string };
  number?: string;
  title: ReactNode;
  children: ReactNode;
  /** Jika diisi, seluruh kartu menjadi link (eksternal dibuka di tab baru). */
  href?: string;
  linkLabel?: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const body = <>
    <span className={styles.featureIcon}><MaskIcon group={icon.group} name={icon.name} size={22} /></span>
    {number ? <span className={styles.featureNumber}>{number}</span> : null}
    <Heading className={styles.featureTitle}>{title}</Heading>
    <p className={styles.featureText}>{children}</p>
    {href && linkLabel ? <span className={styles.featureLink}>{linkLabel}<ArrowIcon /></span> : null}
  </>;
  if (!href) return <article className={cx(styles.featureCard, "hover-lift-card")}>{body}</article>;
  const external = /^https?:\/\//.test(href);
  return <a
    className={cx(styles.featureCard, "hover-lift-card", "hover-arrow")}
    href={href}
    {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
  >{body}{external ? <span className={styles.srOnly}> (membuka tab baru)</span> : null}</a>;
}

/** Fade-up saat masuk viewport, stagger 60 ms per anak langsung. Konten tetap terlihat tanpa JS / reduced-motion. */
export function Reveal({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "div" | "ol" | "ul" }) {
  const ref = useRef<HTMLElement>(null);
  const [state, setState] = useState<"idle" | "hidden" | "shown">("idle");
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (element.getBoundingClientRect().top < window.innerHeight * 0.9) return;
    setState("hidden");
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setState("shown"); observer.disconnect(); }
    }, { rootMargin: "0px 0px -10% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const Tag = as as "div";
  return <Tag ref={ref as React.RefObject<HTMLDivElement>} className={cx(styles.reveal, className)} data-reveal={state}>{children}</Tag>;
}

/* ── Page head (frame 02, 251:158) ────────────────────────────────── */

export function PageHead({ breadcrumb, title, description, aside, titleId, backLink }: {
  breadcrumb?: ReadonlyArray<{ label: string; href?: string }>;
  /** Di layar ≤480 px breadcrumb diringkas menjadi satu tautan kembali (mis. "← Riwayat"). */
  backLink?: { label: string; href: string };
  title: ReactNode;
  description?: ReactNode;
  /** Elemen kanan, mis. Stepper atau tombol. */
  aside?: ReactNode;
  titleId?: string;
}) {
  return <div className={styles.pageHead}>
    <div className={styles.pageHeadCopy}>
      {breadcrumb?.length ? <nav aria-label="Breadcrumb">
        {backLink ? <Link className={styles.breadcrumbBack} href={backLink.href}><span aria-hidden="true">←</span> {backLink.label}</Link> : null}
        <ol className={cx(styles.breadcrumb, backLink && styles.breadcrumbFull)}>
        {breadcrumb.map((item, index) => <li key={item.label} aria-current={index === breadcrumb.length - 1 ? "page" : undefined}>
          {item.href && index < breadcrumb.length - 1 ? <Link href={item.href}>{item.label}</Link> : item.label}
        </li>)}
      </ol></nav> : null}
      <h1 id={titleId} className={styles.pageTitle}>{title}</h1>
      {description ? <div className={styles.pageDescription}>{description}</div> : null}
    </div>
    {aside ? <div className={styles.pageHeadAside}>{aside}</div> : null}
  </div>;
}

/** Stepper pill (frame 02): langkah sebelum/aktif = teal, sesudahnya netral. */
export function Stepper({ steps, current, label = "Langkah" }: { steps: readonly string[]; current: number; label?: string }) {
  return <ol className={styles.stepper} aria-label={label}>
    {steps.map((step, index) => {
      const state = index < current ? "done" : index === current ? "current" : "upcoming";
      return <li key={step} className={styles.stepperItem} data-state={state} aria-current={state === "current" ? "step" : undefined}>
        <span className={styles.stepperNumber} aria-hidden="true">{index + 1}</span>{step}
      </li>;
    })}
  </ol>;
}

/** Empty / info state gaya kit: border dashed, ikon dalam kotak, satu kalimat, maksimal satu aksi. */
export function EmptyState({ icon, title, children, action, tone = "neutral", role }: {
  icon?: { group: string; name: string };
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "error";
  role?: "status" | "alert";
}) {
  return <div className={styles.emptyState} data-tone={tone} role={role}>
    {icon ? <span className={styles.emptyIcon}><MaskIcon group={icon.group} name={icon.name} size={18} /></span> : null}
    <div className={styles.emptyCopy}>
      {title ? <strong>{title}</strong> : null}
      <span>{children}</span>
    </div>
    {action ? <div className={styles.emptyAction}>{action}</div> : null}
  </div>;
}

/** Skeleton baris (pulse 1.6 s, mati saat reduced-motion). */
export function SkeletonRows({ rows = 3, label, className }: { rows?: number; label: string; className?: string }) {
  return <div className={cx(styles.skeleton, className)} role="status">
    <span className={styles.srOnly}>{label}</span>
    {Array.from({ length: rows }, (_, index) => <div key={index} className={styles.skeletonRow} aria-hidden="true">
      <span className={styles.skeletonIcon} /><span className={styles.skeletonLines}><span /><span /></span>
    </div>)}
  </div>;
}

export function Spinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}

/* ── RD/Badge ─────────────────────────────────────────────────────────── */

export type BadgeTone = "info" | "success" | "warning" | "error" | "neutral" | "teal";

export function Badge({ tone = "neutral", pulse = false, children }: { tone?: BadgeTone; pulse?: boolean; children: React.ReactNode }) {
  return <span className={`${styles.badge} ${styles[`badge_${tone}`]}`}>{pulse ? <span className={styles.badgePulse} aria-hidden="true" /> : null}{children}</span>;
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
  /** Label tetap ada untuk pembaca layar, tetapi disembunyikan secara visual. */
  hideLabel?: boolean;
  /** Ganti <input> bawaan, misalnya dengan <select>. Kontrol harus memakai id yang sama. */
  children?: ReactNode;
};

export function Field({ label, icon, trailing, hint, error, optional = false, mono = false, hideLabel = false, children, id, className, ...input }: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = cx(input["aria-describedby"], hintId, errorId) || undefined;
  return <div className={cx(styles.field, className)}>
    <label className={hideLabel ? styles.srOnly : styles.fieldLabel} htmlFor={controlId}>{label}{optional ? <>{" "}<span className={styles.fieldOptional}>(opsional)</span></> : null}</label>
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
    {/* key per status: ikon di-remount saat status berubah sehingga crossfade + scale .8→1 berjalan. */}
    <span key={status} className={styles.stepIndicator} aria-hidden="true">
      {status === "done" ? <AssetIcon group="pipeline" name="imgIconCheck" /> : null}
    </span>
    <span className={styles.stepText}>
      <span className={styles.stepTitle}>{title}</span>
      {meta ? <span className={styles.stepMeta}>{meta}</span> : null}
    </span>
    {aside ? <span className={styles.stepAside}>{aside}</span> : null}
  </li>;
}

/* ── Progress bar ─────────────────────────────────────────────────── */

export function ProgressBar({ value, max, label, indeterminate = false }: { value: number; max: number; label: string; indeterminate?: boolean }) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return <div className={styles.progress} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
    <span className={styles.progressFill} style={{ width: `${percent}%` }} />
    {indeterminate && percent < 100 ? <span className={styles.progressPending} style={{ left: `calc(${percent}% + 6px)` }} /> : null}
  </div>;
}

/* ── Util ─────────────────────────────────────────────────────────────── */

export function CopySha({ sha, label }: { sha: string; /** Teks tampilan (mis. SHA pendek); yang disalin tetap SHA penuh. */ label?: string }) {
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
    <code title={label ? sha : undefined}>{label ?? sha}</code>
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
