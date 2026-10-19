const outputs = [
  ["01", "Telusuri struktur kode", "Pahami hubungan module, class, dan function melalui graph yang dapat ditelusuri."],
  ["02", "Periksa bukti sumber", "Hubungkan setiap temuan dengan file dan lokasi source code yang mendasarinya."],
  ["03", "Susun dokumentasi", "Baca dokumentasi arsitektur dan simpan hasilnya dalam Markdown atau PDF."],
];

export default function Home() {
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-5 sm:px-8">
      <header className="flex items-center justify-between border-b border-ink/10 py-6">
        <span className="text-2xl font-bold tracking-tight" aria-label="SAGE">SAGE<span className="text-accent">.</span></span>
        <span className="rounded-full border border-ink/15 bg-white px-3 py-1 text-xs font-medium">Dalam pengembangan</span>
      </header>
      <main className="flex flex-1 flex-col justify-center py-16 sm:py-24">
        <p className="mb-5 font-mono text-xs tracking-wide text-ink/65">DARI SOURCE CODE KE PEMAHAMAN ARSITEKTUR</p>
        <h1 className="max-w-3xl text-4xl leading-tight font-semibold tracking-tight sm:text-6xl">Pahami arsitektur.<br /><span className="text-ink/55">Telusuri buktinya.</span></h1>
        <p className="mt-6 max-w-xl text-base leading-7 text-ink/70 sm:text-lg">SAGE membantu membaca struktur repository PHP dan JavaScript/TypeScript melalui graph serta dokumentasi yang berlandaskan source code.</p>
        <a className="mt-8 inline-flex min-h-12 w-fit items-center rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-white transition hover:bg-ink/90" href="/login">Mulai dengan GitHub</a>
        <ol className="mt-14 grid gap-8 border-t border-ink/10 pt-8 md:grid-cols-3">
          {outputs.map(([number, title, description]) => (
            <li key={number}>
              <span className="font-mono text-xs text-ink/50">{number}</span>
              <h2 className="mt-3 text-base font-semibold">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-ink/65">{description}</p>
            </li>
          ))}
        </ol>
      </main>
      <footer className="border-t border-ink/10 py-5 text-xs text-ink/55">Source-code Architecture Graph Extraction</footer>
    </div>
  );
}
