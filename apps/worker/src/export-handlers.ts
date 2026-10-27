import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { completeExportJob, failExportJob, renewExportLease, snapshotExportJobClaim } from "@sage/database";
import type { ExportJobClaim } from "@sage/database";
import type { PrismaClient } from "../../../packages/database/generated/client.ts";
import { MARKDOWN_RENDERER_VERSION, renderMarkdownDocument } from "../../../packages/documents/src/markdown.ts";
import { PDF_RENDERER_VERSION } from "../../../packages/documents/src/pdf-version.ts";
import { renderPdfDocument } from "../../../packages/documents/src/pdf.ts";
import { loadDocumentForUser } from "./document-reader.ts";
import type { DocumentReadDatabase } from "./document-reader.ts";

const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const LEASE_DURATION_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

class ExportProcessingError extends Error {
  constructor(readonly code: "EXPORT_TOO_LARGE" | "DOCUMENT_UNAVAILABLE" | "EXPORT_FAILED") {
    super(code);
    this.name = "ExportProcessingError";
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Export worker stopped.");
}

async function writePrivateExportFile(storageRoot: string, body: Uint8Array, format: ExportJobClaim["format"], signal: AbortSignal) {
  if (body.byteLength > MAX_EXPORT_BYTES) throw new ExportProcessingError("EXPORT_TOO_LARGE");
  const filename = format === "PDF" ? "document.pdf" : "document.md";
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(storageRoot);
  const folderName = `export-${randomUUID()}`;
  const folder = join(root, folderName);
  await mkdir(folder, { mode: 0o700 });
  const storageKey = `${folderName}/${filename}`;
  const pendingPath = join(folder, `${filename}.pending`);
  const finalPath = join(folder, filename);
  try {
    assertActive(signal);
    const handle = await open(pendingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    assertActive(signal);
    const verifyHandle = await open(pendingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let verified: Buffer;
    try {
      const stat = await verifyHandle.stat();
      if (!stat.isFile() || stat.size !== body.byteLength || stat.size > MAX_EXPORT_BYTES) throw new ExportProcessingError("EXPORT_FAILED");
      verified = await verifyHandle.readFile();
    } finally {
      await verifyHandle.close();
    }
    if (hash(verified) !== hash(body)) throw new ExportProcessingError("EXPORT_FAILED");
    assertActive(signal);
    await rename(pendingPath, finalPath);
    const finalHandle = await open(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const finalStat = await finalHandle.stat();
      if (!finalStat.isFile() || finalStat.size !== verified.byteLength || finalStat.size > MAX_EXPORT_BYTES) {
        throw new ExportProcessingError("EXPORT_FAILED");
      }
      const finalBytes = await finalHandle.readFile();
      if (hash(finalBytes) !== hash(verified)) throw new ExportProcessingError("EXPORT_FAILED");
    } finally {
      await finalHandle.close();
    }
    assertActive(signal);
    return { folder, storageKey, contentHash: hash(verified), byteLength: verified.byteLength };
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
        if (claim.rendererVersion !== expectedRendererVersion) throw new ExportProcessingError("EXPORT_FAILED");
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
        let bytes: Uint8Array;
        if (claim.format === "PDF") {
          bytes = await renderPdfDocument(state.value.document, { signal: controller.signal });
          if (!(bytes instanceof Uint8Array)) throw new ExportProcessingError("EXPORT_FAILED");
          if (bytes.byteLength < 5 || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
            throw new ExportProcessingError("EXPORT_FAILED");
          }
        } else {
          const markdown = renderMarkdownDocument(state.value.document);
          if (typeof markdown !== "string") throw new ExportProcessingError("EXPORT_FAILED");
          bytes = Buffer.from(markdown, "utf8");
        }
        if (bytes.byteLength > MAX_EXPORT_BYTES) throw new ExportProcessingError("EXPORT_TOO_LARGE");
        publishedFile = await writePrivateExportFile(options.storageRoot, bytes, claim.format, controller.signal);
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
        const errorCode = cause instanceof ExportProcessingError ? cause.code : pdfError ?? "EXPORT_FAILED";
        await failExportJob(options.db, claim, errorCode);
      } finally {
        clearInterval(heartbeat);
        parentSignal?.removeEventListener("abort", abortFromParent);
      }
    },
  };
}
