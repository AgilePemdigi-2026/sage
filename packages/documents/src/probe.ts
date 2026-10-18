import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { chromium } from "playwright";

// Tests the pinned renderer on trusted sample data, not repository content.
export async function renderProbe(pdfPath: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: true });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent('<!doctype html><html lang="id"><head><meta charset="utf-8"></head><body><h1>SAGE - Uji kompatibilitas</h1><div id="diagram"></div></body></html>');
    const require = createRequire(import.meta.url);
    const mermaidEntry = require.resolve("mermaid");
    const script = await readFile(new URL("mermaid.min.js", `file://${mermaidEntry}`), "utf8");
    await page.addScriptTag({ content: script });
    const svg = await page.evaluate(async () => {
      const renderer = (window as unknown as { mermaid: { initialize: (config: object) => void; render: (id: string, source: string) => Promise<{ svg: string }> } }).mermaid;
      renderer.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", flowchart: { htmlLabels: false } });
      const { svg } = await renderer.render("sage-probe", 'flowchart LR\n A["Module"] --> B["Class"]\n B -. "Unresolved" .-> C["Referensi"]');
      document.getElementById("diagram")!.innerHTML = svg;
      return svg;
    });
    await mkdir(dirname(pdfPath), { recursive: true });
    await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
    return { svg, browserVersion: browser.version(), pdfPath };
  } finally {
    await browser.close();
  }
}
