import Link from "next/link";
import { createPreviewData } from "./preview/fixture-data.ts";
import { DesignFrame, Panel } from "../components/design-system/ui.tsx";

const outputs = [
  ["01", "Code Knowledge Graph", "Jelajahi struktur kode, hubungan langsung, dan bukti sumber."],
  ["02", "Katalog interface", "Tinjau interface yang ditemukan dalam source code."],
  ["03", "Diagram arsitektur", "Baca Software Engineering Diagram dan UML Class Diagram."],
];

export default function Home() {
  const fixture = createPreviewData();
  const declaration = fixture.sources["src/report.ts"].split("\n")[3];
  return <DesignFrame>
    <div className="grid gap-8 pt-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,.8fr)] lg:pt-12">
      <section className="max-w-3xl py-2">
        <p className="font-mono text-xs font-medium tracking-[.16em] text-[#0b7a6c]">DOKUMENTASI ARSITEKTUR SOURCE CODE</p>
        <h1 className="mt-4 max-w-3xl text-[32px] font-semibold leading-[1.2] tracking-tight sm:text-[40px]">Pahami arsitektur.<br />Telusuri buktinya.</h1>
        <p className="mt-5 max-w-2xl text-sm leading-6 text-[#52637b] sm:text-base sm:leading-7">SAGE membantu membaca struktur repository PHP dan JavaScript/TypeScript melalui graph serta dokumentasi yang berlandaskan source code.</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link className="inline-flex min-h-11 items-center rounded-md bg-[#2ac6ae] px-4 py-2 text-sm font-semibold text-[#061e42] hover:bg-[#25b59f]" href="/login">Hubungkan GitHub</Link>
          <Link className="inline-flex min-h-11 items-center rounded-md border border-[#b8c6d3] bg-white px-4 py-2 text-sm font-semibold text-[#061e42] hover:bg-[#f2f6f8]" href="/preview/progress">Lihat pratinjau</Link>
        </div>
        <p className="mt-3 text-xs leading-5 text-[#63738a]">Kamu akan melanjutkan ke GitHub untuk meninjau akses repository.</p>
      </section>
      <Panel title="Bukti terlebih dahulu">
        <p className="text-sm leading-6 text-[#52637b]">Fakta teknis dapat ditelusuri ke file sumber, rentang baris, dan commit yang dianalisis.</p>
        <div className="mt-6 rounded-md border border-[#dce5ec] bg-[#f6f9fb] p-4">
          <p className="text-xs font-medium text-[#52637b]">Contoh bukti dari fixture tervalidasi</p>
          <p className="mt-3 font-mono text-xs text-[#061e42]">src/report.ts:4</p>
          <pre className="mt-2 overflow-x-auto text-xs leading-5 text-[#243b57]"><code>{declaration}</code></pre>
          <p className="mt-3 font-mono text-[11px] text-[#52637b]">{fixture.model.snapshot.repository}<br />commit {fixture.model.snapshot.commitSha.slice(0, 7)}</p>
        </div>
      </Panel>
    </div>
    <section className="mt-10" aria-labelledby="outputs-heading">
      <h2 id="outputs-heading" className="mb-4 text-xl font-semibold">Dari source code ke pemahaman arsitektur</h2>
      <div className="grid gap-4 md:grid-cols-3">
        {outputs.map(([number, title, description]) => <Panel key={number}>
          <span className="font-mono text-xs text-[#0b7a6c]">{number}</span>
          <h3 className="mt-3 text-base font-semibold">{title}</h3>
          <p className="mt-2 text-sm leading-6 text-[#52637b]">{description}</p>
        </Panel>)}
      </div>
    </section>
    <p className="mt-6 text-xs leading-5 text-[#63738a]">Source yang didukung: JavaScript/TypeScript dan PHP.</p>
  </DesignFrame>;
}
