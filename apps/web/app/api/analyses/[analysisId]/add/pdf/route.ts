import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseAddReviewOverlay } from "@sage/documents/add-overlay";
import { isAddBaselineModel } from "@sage/documents/baseline-add-model";
import { createAddLatex } from "@sage/documents/baseline-latex";
import { addHandlers } from "../../../../../../lib/add/server-handlers.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const compile = promisify(execFile);
let compiling = false;
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  const response = await addHandlers.get(request, (await context.params).analysisId);
  if (!response.ok) return response;
  const { data } = await response.json();
  if (!isAddBaselineModel(data.model)) {
    return Response.json({ error: { message: "Format baseline ADD tidak valid." } }, { status: 409, headers });
  }
  if (compiling) {
    return Response.json({ error: { message: "PDF lain sedang dibuat. Coba lagi sebentar." } }, { status: 503, headers });
  }

  compiling = true;
  let directory: string | undefined;
  try {
    const { model } = data;
    const overlay = parseAddReviewOverlay(model, data.overlay, data.revision);
    const repository = model.snapshot.repository.split("/").map(encodeURIComponent).join("/");
    const sha = encodeURIComponent(model.snapshot.commitSha);
    const latex = createAddLatex(model, overlay, (span, fileOnly) => {
      const path = span.filePath.split("/").map(encodeURIComponent).join("/");
      return `https://github.com/${repository}/blob/${sha}/${path}${fileOnly ? "" : `#L${span.startLine}-L${span.endLine}`}`;
    }, { modelHash: data.modelHash, generatedAt: new Date().toISOString() });
    directory = await mkdtemp(join(tmpdir(), "sage-add-"));
    await writeFile(join(directory, "add.tex"), latex);
    await compile("tectonic", ["--untrusted", "--reruns", "2", "add.tex"], {
      cwd: directory, timeout: 105_000, killSignal: "SIGKILL", maxBuffer: 512 * 1024, signal: request.signal,
    });
    const pdf = await readFile(join(directory, "add.pdf"));
    const name = (model.snapshot.repository.split("/").at(-1) || "repository").replace(/[^a-z0-9_-]/gi, "-").slice(0, 100);
    return new Response(new Uint8Array(pdf), { headers: {
      ...headers, "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="sage-add-${name}.pdf"`,
    } });
  } catch {
    return Response.json({ error: { message: "PDF LaTeX belum dapat dibuat. Coba lagi atau unduh file LaTeX." } }, { status: 503, headers });
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      compiling = false;
    }
  }
}
