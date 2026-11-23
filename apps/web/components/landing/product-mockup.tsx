"use client";

import { motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../design-system/icons.tsx";
import { PipelineStep, type PipelineStepStatus } from "../design-system/ui.tsx";
import styles from "./landing.module.css";

/** Data contoh statis untuk mockup produk (bukan hasil analisis sungguhan). */
export type MockupCopy = {
  stages: readonly string[];
  viewTitle: string;
  catalogTitle: string;
};

type Frame = { done: number; add: boolean; ck: boolean; hold: number };

const FINAL: Frame = { done: 9, add: true, ck: true, hold: 2600 };
/** Alur: frame akhir (sama dengan SSR) → reset → 9 tahap → ADD → kembali ke frame akhir (Code Knowledge tersorot). */
const TIMELINE: readonly Frame[] = [
  FINAL,
  { done: 0, add: false, ck: false, hold: 700 },
  ...Array.from({ length: 9 }, (_, index) => ({ done: index + 1, add: false, ck: false, hold: index === 8 ? 600 : 300 })),
  { done: 9, add: true, ck: false, hold: 2300 },
];

const SPRING = { type: "spring", stiffness: 260, damping: 30 } as const;
const EVIDENCE = "src/app/api/books/route.ts:12";
/* Nilai token (globals.css) sebagai hex agar motion bisa menginterpolasi warna. */
const TEAL_50 = "#e6faf6";
const TEAL_50_CLEAR = "rgba(230, 250, 246, 0)";
const TEAL_500 = "#2ac6ae";
const BORDER_SOFT = "#edf2f7";

function stepStatus(index: number, done: number): PipelineStepStatus {
  if (index < done) return "done";
  return index === done ? "active" : "pending";
}

/** Diagram ArchiMate kecil: Data Object (pita atas) + relasi asosiasi; garis digambar saat kartu ADD aktif. */
function InformationStructure({ active }: { active: boolean }) {
  const objects = [
    { x: 8, y: 14, label: "Book" },
    { x: 140, y: 14, label: "Author" },
    { x: 8, y: 92, label: "Loan" },
    { x: 140, y: 92, label: "Member" },
  ];
  const links = ["M100 36H140", "M54 58V92", "M100 114H140"];
  return <svg className={styles.archimate} viewBox="0 0 240 150" role="presentation">
    {links.map((d, index) => <motion.path key={d} d={d} className={styles.archimateLink}
      initial={false} animate={{ pathLength: active ? 1 : 0 }} transition={{ duration: 0.5, delay: active ? 0.15 + index * 0.12 : 0 }} />)}
    {objects.map(object => <g key={object.label} transform={`translate(${object.x} ${object.y})`}>
      <rect width="92" height="44" rx="3" className={styles.archimateBox} />
      <path d="M0 12H92" className={styles.archimateBand} />
      <text x="46" y="32" textAnchor="middle" className={styles.archimateLabel}>{object.label}</text>
    </g>)}
  </svg>;
}

/**
 * Isi kartu muncul (fade + naik) saat kartu aktif; sebelum itu tampil skeleton tanpa teks, sehingga tidak pernah ada
 * teks redup yang kontrasnya < 4.5:1. Tinggi kartu tetap (grid satu sel) → tanpa CLS.
 */
function CardBody({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div className={styles.mockBodyStack}>
    <div className={styles.mockSkeleton} data-show={active ? undefined : "true"}><span /><span /><span /><span /></div>
    <motion.div className={styles.mockBody} initial={false} animate={{ opacity: active ? 1 : 0, y: active ? 0 : 6 }} transition={SPRING}>
      {children}
    </motion.div>
  </div>;
}

export function ProductMockup({ copy }: { copy: MockupCopy }) {
  const stage = useRef<HTMLDivElement>(null);
  const inView = useInView(stage, { amount: 0.35 });
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const frame = reduced ? FINAL : TIMELINE[index] ?? FINAL;
  const running = inView && !reduced;

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setIndex(current => (current + 1) % TIMELINE.length), frame.hold);
    return () => window.clearTimeout(timer);
  }, [running, index, frame.hold]);

  const scene = frame.ck ? "ck" : frame.add ? "add" : "progress";
  const total = copy.stages.length;

  return <div ref={stage} className={styles.stage} data-scene={scene} data-paused={running ? undefined : "true"} aria-hidden="true">
    <section className={`${styles.mockCard} ${styles.mockProgress}`} data-card="progress">
      <header className={styles.mockHead}>
        <Icon name="listChecks" />
        <span className={styles.mockTitle}>Progres analisis</span>
        <span className={styles.mockCount}>{Math.min(frame.done, total)}/{total}</span>
      </header>
      <p className={styles.mockMeta}>acme/perpustakaan · main · 4f2c9e1</p>
      <ol className={styles.mockSteps}>
        {copy.stages.map((label, stepIndex) => <PipelineStep key={label} status={stepStatus(stepIndex, frame.done)} title={label} />)}
      </ol>
    </section>

    <section className={`${styles.mockCard} ${styles.mockAdd}`} data-card="add">
      <header className={styles.mockHead}>
        <Icon name="fileText" />
        <span className={styles.mockTitle}>TOGAF ADD · Phase C</span>
      </header>
      <CardBody active={frame.add}>
        <p className={styles.mockSection}><span className={styles.mockNumber}>2.4</span>{copy.viewTitle}</p>
        <div className={styles.mockInset}><InformationStructure active={frame.add} /></div>
        <p className={styles.mockSection}><span className={styles.mockNumber}>2.2</span>{copy.catalogTitle}</p>
        <dl className={styles.mockRows}>
          <div><dt>Book</dt><dd>prisma/schema.prisma:14</dd></div>
          <div><dt>Loan</dt><dd>prisma/schema.prisma:41</dd></div>
        </dl>
      </CardBody>
    </section>

    <section className={`${styles.mockCard} ${styles.mockCk}`} data-card="ck">
      <header className={styles.mockHead}>
        <Icon name="graph" />
        <span className={styles.mockTitle}>Code Knowledge</span>
      </header>
      <CardBody active={frame.ck}>
      <div className={styles.mockNode}>
        <Icon name="code" />
        <span><strong>GET /api/books</strong><span className={styles.mockKind}>Route handler</span></span>
      </div>
      <ul className={styles.mockRelations}>
        <li><span>memanggil</span><code>listBooks()</code></li>
        <li><span>membaca</span><code>Book</code></li>
      </ul>
      <motion.p className={styles.mockEvidence} initial={false}
        animate={{ backgroundColor: frame.ck ? TEAL_50 : TEAL_50_CLEAR, borderColor: frame.ck ? TEAL_500 : BORDER_SOFT }}
        transition={{ duration: 0.35, delay: frame.ck ? 0.25 : 0 }}>
        <Icon name="fileText" />{EVIDENCE}
      </motion.p>
      <pre className={styles.mockCode}><code>
        <span><i>11</i>{"import { listBooks } from \"@/lib/books\";"}</span>
        <span data-hit={frame.ck ? "true" : undefined}><i>12</i>{"export async function GET() {"}</span>
        <span><i>13</i>{"  return Response.json(await listBooks());"}</span>
      </code></pre>
      </CardBody>
    </section>
  </div>;
}
