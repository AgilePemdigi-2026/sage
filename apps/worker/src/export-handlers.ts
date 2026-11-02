import { semanticRendererVersion } from "../../../packages/documents/src/semantic/export-pin.ts";
import { renderSemanticMarkdown, type SemanticPresentation } from "../../../packages/documents/src/semantic/render.ts";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { completeExportJob, failExportJob, renewExportLease, snapshotExportJobClaim, reserveJobStorage, readSemanticForUser } from "@sage/database";
import type { ExportJobClaim } from "@sage/database";
import type { PrismaClient } from "../../../packages/database/generated/client.ts";
import { MARKDOWN_RENDERER_VERSION, MAX_MARKDOWN_EXPORT_BYTES, MarkdownExportTooLargeError, renderMarkdownDocumentChunks } from "../../../packages/documents/src/markdown.ts";
import { PDF_RENDERER_VERSION } from "../../../packages/documents/src/pdf-version.ts";
import { renderPdfDocument } from "../../../packages/documents/src/pdf.ts";
import { loadDocumentForUser } from "./document-reader.ts";
import type { DocumentReadDatabase } from "./document-reader.ts";

const MAX_EXPORT_BYTES = MAX_MARKDOWN_EXPORT_BYTES;
const LEASE_DURATION_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

class ExportProcessingError extends Error {
  constructor(readonly code: "EXPORT_TOO_LARGE" | "DOCUMENT_UNAVAILABLE" | "EXPORT_FAILED") {
    super(code);
    this.name = "ExportProcessingError";
  }
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Export worker stopped.");
}

async function writePrivateExportFile(storageRoot: string, chunks: Iterable<string | Uint8Array>, format: ExportJobClaim["format"], signal: AbortSignal, reserve: (key: string) => Promise<boolean>) {
  const filename = format === "PDF" ? "document.pdf" : "document.md";
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(storageRoot);
  const folderName = `export-${randomUUID()}`;
  const folder = join(root, folderName);
  const storageKey = `${folderName}/${filename}`;
  const pendingPath = join(folder, `${filename}.pending`);
  const finalPath = join(folder, filename);
  try {
    assertActive(signal);
    // Create the empty directory before reservation: a stale writer must not recreate
    // a directory that cleanup already removed after seeing its reserved paths.
    await mkdir(folder, { mode: 0o700 });
    if (!await reserve(storageKey) || !await reserve(`${storageKey}.pending`)) throw new ExportProcessingError("EXPORT_FAILED");
    const handle = await open(pendingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let byteLength = 0;
    const digest = createHash("sha256");
    try {
      for (const chunk of chunks) {
        assertActive(signal);
        const size = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
        if (size > MAX_EXPORT_BYTES - byteLength) throw new ExportProcessingError("EXPORT_TOO_LARGE");
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        await handle.writeFile(bytes);
        digest.update(bytes);
        byteLength += size;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    assertActive(signal);
    const contentHash = digest.digest("hex");
    // Verify through fixed-size reads; never retain another copy of the artifact.
    async function verify(path: string): Promise<void> {
      const reader = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await reader.stat();
        if (!stat.isFile() || stat.size !== byteLength || stat.size > MAX_EXPORT_BYTES) throw new ExportProcessingError("EXPORT_FAILED");
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let readBytes = 0;
        while (true) {
          assertActive(signal);
          const result = await reader.read(buffer, 0, buffer.length, null);
          if (result.bytesRead === 0) break;
          readBytes += result.bytesRead;
          if (readBytes > byteLength) throw new ExportProcessingError("EXPORT_FAILED");
          hash.update(buffer.subarray(0, result.bytesRead));
        }
        if (readBytes !== byteLength || hash.digest("hex") !== contentHash) throw new ExportProcessingError("EXPORT_FAILED");
      } finally { await reader.close(); }
    }
    await verify(pendingPath);
    assertActive(signal);
    await rename(pendingPath, finalPath);
    await verify(finalPath);
    assertActive(signal);
    return { folder, storageKey, contentHash, byteLength };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

/** One queue consumer slot is independent from the ANALYSIS queue and its lease. */
export function createExportWorker(options: { db: PrismaClient; storageRoot: string }) {
  return {
    async process(inputClaim: ExportJobClaim, parentSignal?: AbortSignal): Promise<void> {
      const claim = snapshotExportJobClaim(inputClaim);
      const controller = new AbortController();
      const abortFromParent = () => controller.abort(parentSignal?.reason);
      if (parentSignal?.aborted) abortFromParent();
      else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

      let renewing = false;
      const heartbeat = setInterval(() => {
        if (renewing || controller.signal.aborted) return;
        renewing = true;
        void renewExportLease(options.db, claim, { leaseDurationMs: LEASE_DURATION_MS })
          .then(lease => { if (!lease && !controller.signal.aborted) controller.abort(new Error("EXPORT_LEASE_LOST")); })
          .catch(() => { if (!controller.signal.aborted) controller.abort(new Error("EXPORT_LEASE_UNAVAILABLE")); })
          .finally(() => { renewing = false; });
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      let publishedFile: { folder: string; storageKey: string; contentHash: string; byteLength: number } | null = null;
      let completionAttempted = false;
      try {
        assertActive(controller.signal);
        const expectedRendererVersion = claim.format === "PDF" ? PDF_RENDERER_VERSION : MARKDOWN_RENDERER_VERSION;
        const storedPin = await options.db.export.findFirst({ where: { id: claim.exportId, analysisId: claim.analysisId, ownerUserId: claim.ownerUserId }, select: {semanticModelHash: true, presentationRevision: true} });
        if (!storedPin) throw new ExportProcessingError("DOCUMENT_UNAVAILABLE");
        let semantic: SemanticPresentation | undefined;
        if (storedPin.semanticModelHash !== null || storedPin.presentationRevision !== null) {
          if (!storedPin.semanticModelHash || storedPin.presentationRevision === null) throw new ExportProcessingError("DOCUMENT_UNAVAILABLE");
          const pinned = await readSemanticForUser(options.db, claim.ownerUserId, claim.analysisId, storedPin.presentationRevision);
          if (!pinned || pinned.modelHash !== storedPin.semanticModelHash ||
              claim.rendererVersion !== semanticRendererVersion(expectedRendererVersion, pinned.modelHash, pinned.revision)) throw new ExportProcessingError("DOCUMENT_UNAVAILABLE");
          semantic = {model: pinned.model, overlay: pinned.overlay, revision: pinned.revision};
        } else if (claim.rendererVersion !== expectedRendererVersion) throw new ExportProcessingError("EXPORT_FAILED");
        const state = await loadDocumentForUser(
          options.db as unknown as DocumentReadDatabase,
          claim.ownerUserId,
          claim.analysisId,
          options.storageRoot,
          controller.signal,
        );
        if (state.kind !== "ready" || state.value.contentHash !== claim.documentHash) {
          throw new ExportProcessingError("DOCUMENT_UNAVAILABLE");
        }
        assertActive(controller.signal);
        let chunks: Iterable<string | Uint8Array>;
        if (claim.format === "PDF") {
          const bytes = await renderPdfDocument(state.value.document, { signal: controller.signal, semantic });
          if (!(bytes instanceof Uint8Array)) throw new ExportProcessingError("EXPORT_FAILED");
          if (bytes.byteLength < 5 || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
            throw new ExportProcessingError("EXPORT_FAILED");
          }
          chunks = [bytes];
        } else {
          const document = state.value.document;
          chunks = (function* () {
            if (semantic) yield `${renderSemanticMarkdown(semantic)}\n---\n\n`;
            yield* renderMarkdownDocumentChunks(document);
          })();
        }
        publishedFile = await writePrivateExportFile(options.storageRoot, chunks, claim.format, controller.signal,
          key => reserveJobStorage(options.db, claim, key));
        assertActive(controller.signal);
        completionAttempted = true;
        const completed = await completeExportJob(options.db, claim, {
          storageKey: publishedFile.storageKey,
          contentHash: publishedFile.contentHash,
          byteLength: publishedFile.byteLength,
        });
        if (!completed) await rm(publishedFile.folder, { recursive: true, force: true });
      } catch (cause) {
        if (publishedFile && !completionAttempted) {
          await rm(publishedFile.folder, { recursive: true, force: true });
        }
        if (parentSignal?.aborted) return;
        if (publishedFile && completionAttempted) {
          // Once completion reaches PostgreSQL a transport error can make commit outcome unknown.
          // Leave the private orphan for later cleanup rather than risk deleting a READY file.
        }
        const pdfError = claim.format === "PDF" && cause instanceof Error && /^PDF_[A-Z0-9_]{1,63}$/.test(cause.message)
          ? cause.message
          : null;
        const errorCode = cause instanceof ExportProcessingError || cause instanceof MarkdownExportTooLargeError ? cause.code : pdfError ?? "EXPORT_FAILED";
        await failExportJob(options.db, claim, errorCode);
      } finally {
        clearInterval(heartbeat);
        parentSignal?.removeEventListener("abort", abortFromParent);
      }
    },
  };
}
