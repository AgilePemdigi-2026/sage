"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGroup, MotionConfig, motion, useMotionValueEvent, useReducedMotion, useScroll, type Variants } from "motion/react";
import { Children, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type AnchorHTMLAttributes, type CSSProperties, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import assetManifest from "../../public/design/figma/manifest.json";
import { useHeaderAccount } from "./account-context.tsx";
import { loginGatedHref } from "./login-gated.ts";
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
    <summary className={styles.accountPill} aria-label={`@${login} · menu akun`}>
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

/** Kapsul melayang aktif setelah scroll melewati ambang ini (px). */
const FLOATING_THRESHOLD = 24;
/** Pill nav: satu indikator yang bergeser antar item (layoutId). Reduced-motion → MotionConfig mematikan slide. */
const PILL_SPRING = { type: "spring", stiffness: 400, damping: 35 } as const;

/**
 * Kapsul tanpa layout shift: kotak header tetap full-width; lapisan latar (headerSurface) berada permanen di geometri kapsul
 * dan di posisi atas di-scale menutup full-width. --sx = lebar header / lebar kapsul, diukur saat ukuran berubah (bukan per frame).
 */
function useSurfaceScale() {
  const header = useRef<HTMLElement>(null);
  const surface = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const headerElement = header.current;
    const surfaceElement = surface.current;
    if (!headerElement || !surfaceElement) return;
    const measure = () => {
      const capsule = surfaceElement.offsetWidth;
      if (capsule > 0) headerElement.style.setProperty("--sx", String(headerElement.clientWidth / capsule));
      headerElement.dataset.measured = "true";
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(headerElement);
    return () => observer.disconnect();
  }, []);
  return { headerRef: header, surfaceRef: surface };
}

function useFloatingHeader(): boolean {
  const { scrollY } = useScroll();
  const [floating, setFloating] = useState(false);
  useMotionValueEvent(scrollY, "change", value => setFloating(value > FLOATING_THRESHOLD));
  // Halaman dibuka/dipulihkan di posisi tengah: sinkronkan sekali setelah hidrasi (SSR selalu bentuk diam).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sinkronisasi awal dengan posisi scroll browser.
    setFloating(scrollY.get() > FLOATING_THRESHOLD);
  }, [scrollY]);
  return floating;
}

function NavPills({ current, signedIn }: { current: NavKey; signedIn: boolean }) {
  const [hovered, setHovered] = useState<NavKey | null>(null);
  // Tanpa hover/fokus, pill hover "beristirahat" di bawah item aktif sehingga hover berikutnya bergeser dari sana.
  const hoverTarget = hovered ?? (current === "none" ? null : current);
  return <LayoutGroup id="site-nav">
    <nav className={styles.nav} aria-label="Navigasi utama" onMouseLeave={() => setHovered(null)}>
      {navigation.map(item => {
        const isActive = current === item.key;
        return <Link
          key={item.key}
          href={loginGatedHref(item.href, signedIn)}
          className={styles.navLink}
          data-hovered={hovered === item.key && !isActive ? "true" : undefined}
          aria-current={isActive ? (item.key === "docs" ? "location" : "page") : undefined}
          onMouseEnter={() => setHovered(item.key)}
          onFocus={() => setHovered(item.key)}
          onBlur={() => setHovered(null)}
        >
          {hoverTarget === item.key ? <motion.span layoutId="nav-hover" className={styles.navHover} transition={PILL_SPRING} aria-hidden="true" /> : null}
          {isActive ? <motion.span layoutId="nav-active" className={styles.navActive} transition={PILL_SPRING} aria-hidden="true" /> : null}
          <span className={styles.navLabel}>{item.label}</span>
        </Link>;
      })}
    </nav>
  </LayoutGroup>;
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
  const floating = useFloatingHeader();
  const { headerRef, surfaceRef } = useSurfaceScale();

  return <div className={styles.frame}>
    <a className={styles.skip} href="#main-content">Lewati navigasi</a>
    {/* Slot menyisakan tinggi header di dokumen (tanpa CLS); header sendiri fixed agar bisa berubah jadi kapsul. */}
    <div className={styles.headerSlot} data-print-hide>
      <MotionConfig reducedMotion="user">
        <header ref={headerRef} className={styles.header} data-floating={floating ? "true" : undefined}>
          <span ref={surfaceRef} className={styles.headerSurface} aria-hidden="true" />
          <Link className={styles.brand} href="/" aria-label="SAGE, halaman utama">SAGE<span>.</span></Link>
          <NavPills current={current} signedIn={Boolean(account)} />
          <div className={styles.headerEnd}>
            {account
              ? <AccountMenu login={account.login} displayName={account.displayName} />
              : onLogin ? null : <Button href="/login" variant="primary" size="md">Masuk</Button>}
          </div>
        </header>
      </MotionConfig>
    </div>
    <main className={styles.main} id="main-content" tabIndex={-1}>{children}</main>
    <SiteFooter signedIn={Boolean(account)} />
  </div>;
}

/* ── Logo orb (app/icon.svg) ──────────────────────────────────────── */

export function BrandOrb({ size = 32 }: { size?: number }) {
  return <svg className={styles.orb} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
    <circle cx="50" cy="50" r="48" fill="#061E42" />
    <circle cx="50" cy="50" r="45" fill="none" stroke="#2AC6AE" strokeWidth="3" />
    <circle cx="48" cy="54" r="22" fill="#2AC6AE" />
    <path d="M36 50 A14 14 0 0 1 50 36 A18 18 0 0 0 40 52 Z" fill="#C9F6F0" />
    <path d="M71 22 L76 29 L71 36 L66 29 Z" fill="#C9F6F0" />
    <circle cx="79" cy="44" r="3" fill="#2AC6AE" />
  </svg>;
}

/* ── Footer situs ─────────────────────────────────────────────────── */

const REPOSITORY_URL = "https://github.com/AgilePemdigi-2026/sage";

const footerColumns: ReadonlyArray<{ title: string; links: ReadonlyArray<{ label: string; href: string }> }> = [
  { title: "Produk", links: navigation.map(item => ({ label: item.label, href: item.href })) },
  { title: "Kebijakan", links: [
    { label: "Privasi", href: "/policies#privasi" },
    { label: "Ketentuan", href: "/policies#ketentuan" },
    { label: "Cookie", href: "/policies#cookie" },
    { label: "Penghapusan data", href: "/policies#penghapusan" },
    { label: "Pengembalian dana", href: "/policies#pengembalian-dana" },
  ] },
  { title: "Proyek", links: [{ label: "Repositori GitHub", href: REPOSITORY_URL }] },
];

export function SiteFooter({ signedIn }: { signedIn: boolean }) {
  return <footer className={styles.siteFooter} data-print-hide>
    <div className={styles.siteFooterInner}>
      <div className={styles.siteFooterBrand}>
        <Link className={styles.siteFooterLogo} href="/" aria-label="SAGE, halaman utama"><BrandOrb /><span>SAGE<span>.</span></span></Link>
        <p>Dokumentasi arsitektur dari source code, dengan setiap klaim tertaut ke file, baris, dan commit.</p>
        <p className={styles.siteFooterCopy}>© 2026 AgilePemdigi</p>
      </div>
      <nav className={styles.siteFooterNav} aria-label="Navigasi footer">
        {footerColumns.map(column => <div key={column.title} className={styles.siteFooterColumn}>
          <h2>{column.title}</h2>
          <ul>
            {column.links.map(link => {
              const external = /^https?:\/\//.test(link.href);
              return <li key={link.href}>{external
                ? <a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}<span className={styles.srOnly}> (membuka tab baru)</span></a>
                : <Link href={loginGatedHref(link.href, signedIn)}>{link.label}</Link>}</li>;
            })}
          </ul>
        </div>)}
      </nav>
    </div>
  </footer>;
}

/* ── Pemberitahuan cookie ─────────────────────────────────────────── */

const COOKIE_NOTICE_KEY = "sage-cookie-notice";

/**
 * Kartu melayang kiri bawah. Tidak pernah dirender saat SSR: baru muncul setelah hidrasi jika belum ditutup,
 * sehingga tidak ada kilatan di alur dokumen (mis. saat redirect). Status tutup disimpan di localStorage.
 */
export function CookieNotice() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let dismissed = false;
    try { dismissed = window.localStorage.getItem(COOKIE_NOTICE_KEY) === "dismissed"; } catch { /* storage diblokir: tetap tampil */ }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sengaja setelah hidrasi; SSR selalu tanpa kartu.
    if (!dismissed) setVisible(true);
  }, []);
  const ref = useRef<HTMLElement>(null);
  // Selama kartu tampil, footer mendapat ruang bawah setinggi kartu + jarak tepinya + 16 px (lihat .siteFooter),
  // sehingga baris terakhir footer tidak tertutup. Variabel dihapus saat kartu ditutup.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!visible || !element) return;
    const root = document.documentElement;
    const measure = () => {
      const fromBottom = window.innerHeight - element.getBoundingClientRect().bottom;
      root.style.setProperty("--cookie-notice-space", `${Math.ceil(element.offsetHeight + Math.max(0, fromBottom) + 16)}px`);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => { observer?.disconnect(); root.style.removeProperty("--cookie-notice-space"); };
  }, [visible]);
  if (!visible) return null;
  function dismiss() {
    try { window.localStorage.setItem(COOKIE_NOTICE_KEY, "dismissed"); } catch { /* tetap tutup untuk sesi ini */ }
    setVisible(false);
  }
  return <aside ref={ref} className={styles.cookieNotice} aria-label="Cookie dan kebijakan SAGE" data-print-hide data-cookie-notice>
    <p>SAGE hanya memakai cookie untuk login.</p>
    <div className={styles.cookieNoticeActions}>
      <Link href="/policies#cookie">Kebijakan cookie</Link>
      <Button size="sm" onClick={dismiss}>Mengerti</Button>
    </div>
  </aside>;
}

/* ── RD/Button ────────────────────────────────────────────────────────── */

type ButtonOwnProps = {
  /** `github` = latar ink + teks putih (tombol GitHub, CLAUDE.md). */
  variant?: "primary" | "secondary" | "ghost" | "github" | "link";
  size?: "sm" | "md" | "lg";
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
    styles.button, styles[`button_${variant}`], size === "lg" && styles.button_lg, size === "sm" && styles.button_sm, block && styles.button_block,
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

function isAssetRef(value: unknown): value is { group: string; name: string } {
  return typeof value === "object" && value !== null && "group" in value && "name" in value && !("$$typeof" in value);
}

export function FeatureCard({ icon, number, title, children, href, linkLabel, headingLevel = 3 }: {
  /** Aset Figma (MaskIcon) atau node ikon siap pakai (mis. <Icon> dari icons.tsx). */
  icon: { group: string; name: string } | ReactNode;
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
    <span className={styles.featureIcon}>{isAssetRef(icon) ? <MaskIcon group={icon.group} name={icon.name} size={22} /> : icon}</span>
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

const REVEAL_ITEM: Variants = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.2, 0.8, 0.2, 1] } },
};
const REVEAL_GROUP: Variants = { hidden: {}, shown: { transition: { staggerChildren: 0.06 } } };

/**
 * Fade-up saat masuk viewport (Motion whileInView, sekali), stagger 60 ms per item. Setiap anak dibungkus satu item
 * (<li> untuk as="ol"/"ul"). SSR dan tanpa JS: konten langsung terlihat; setelah hidrasi baru "dipersenjatai" bila grup
 * berada di bawah layar dan pengguna tidak memilih reduced-motion (remount ber-key, tak terlihat karena di luar layar).
 */
export function Reveal({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "div" | "ol" | "ul" }) {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || reduced) return;
    // Keputusan setelah hidrasi; SSR selalu tampil.
    if (element.getBoundingClientRect().top > window.innerHeight * 0.9) setArmed(true);
  }, [reduced]);
  const Group = as === "ol" ? motion.ol : as === "ul" ? motion.ul : motion.div;
  const Item = as === "div" ? motion.div : motion.li;
  return <Group
    key={armed ? "armed" : "static"}
    ref={ref as React.RefObject<never>}
    className={className}
    variants={REVEAL_GROUP}
    initial={armed ? "hidden" : false}
    whileInView="shown"
    viewport={{ once: true, margin: "0px 0px -10% 0px" }}
  >
    {Children.toArray(children).map((child, index) => <Item key={isValidElement(child) && child.key !== null ? child.key : index} variants={REVEAL_ITEM}>{child}</Item>)}
  </Group>;
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

/** Empty / info state gaya kit: border dashed, ikon dalam kotak, satu kalimat, maksimal satu aksi.
 *  `variant="page"`: versi satu halaman penuh (mis. 404) — tersentral, judul menjadi <h1>, boleh dua aksi. */
export function EmptyState({ icon, title, children, action, tone = "neutral", role, variant = "inline" }: {
  icon?: { group: string; name: string };
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "error";
  role?: "status" | "alert";
  variant?: "inline" | "page";
}) {
  const page = variant === "page";
  return <div className={cx(styles.emptyState, page && styles.emptyPage)} data-tone={tone} role={role}>
    {icon ? <span className={styles.emptyIcon}><MaskIcon group={icon.group} name={icon.name} size={page ? 24 : 18} /></span> : null}
    <div className={styles.emptyCopy}>
      {title ? page ? <h1>{title}</h1> : <strong>{title}</strong> : null}
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
