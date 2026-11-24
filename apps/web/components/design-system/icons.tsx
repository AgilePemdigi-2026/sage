/**
 * Satu set ikon garis untuk seluruh aplikasi: grid 24, ukuran tampil 20 px, stroke 1.75, ujung membulat,
 * warna mengikuti currentColor. Dekoratif (aria-hidden); teks di sebelahnya yang membawa makna.
 * Pengecualian ukuran hanya untuk glyph status di dalam indikator (mis. centang PipelineStep).
 */
import type { ReactNode, SVGProps } from "react";

const paths = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  shieldCheck: <><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  gitCommit: <><circle cx="12" cy="12" r="3" /><path d="M3 12h6M15 12h6" /></>,
  logIn: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l5-5-5-5" /><path d="M15 12H4" /></>,
  gitBranch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10" /><path d="M18 9v1a4 4 0 0 1-4 4H6" /></>,
  listChecks: <><path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17" /><path d="M12 6h8M12 12h8M12 18h8" /></>,
  fileText: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" /></>,
  bookOpen: <><path d="M3 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H3z" /><path d="M21 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7z" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3" /></>,
  code: <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />,
  graph: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="10" cy="18" r="2.5" /><path d="M8.5 6.4l7 1.2M6.8 8.4l2.4 7.2M16.6 10.1l-5 6" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></>,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  database: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></>,
  box: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.4-4.4" /></>,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  repo: <><path d="M5 18.5V5a2 2 0 0 1 2-2h12v14H7a2 2 0 0 0-2 2 2 2 0 0 0 2 2h12v-4" /><path d="M9 7h6" /></>,
  checkCircle: <><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></>,
  layers: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16.2v.3" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  copy: <><rect x="8.5" y="8.5" width="12" height="12" rx="2" /><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  minus: <path d="M5 12h14" />,
  fit: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  github: <><path d="M15 21v-3.5a3.4 3.4 0 0 0-1-2.6c3.1-.4 6-1.6 6-6.4a5 5 0 0 0-1.4-3.5 4.7 4.7 0 0 0-.1-3.5s-1.1-.4-3.6 1.3a12.4 12.4 0 0 0-6.6 0C5.8 1.1 4.7 1.5 4.7 1.5a4.7 4.7 0 0 0-.1 3.5A5 5 0 0 0 3.2 8.5c0 4.8 2.9 6 6 6.4a3.4 3.4 0 0 0-1 2.6V21" /><path d="M9 18.5c-3.5 1.2-4.2-1.3-5.8-1.8" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, className, ...rest }: { name: IconName; size?: number; className?: string } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>{paths[name]}</svg>;
}
