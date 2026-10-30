"use client";

import { useEffect, useRef, useState } from "react";
import type { DocumentPayload } from "../../lib/documents/types.ts";
import {
  ExportBindingError,
  ExportPayloadError,
  exportDownloadFilename,
  parseExportPayload,
  type ExportFormat,
  type ExportRecord,
} from "./export-data.ts";
import styles from "./live-document.module.css";

type Operation = "create" | "status" | "retry" | "download";
type ExportError = { message: string; retry: Operation | null };
type PendingOperation = Operation | null;

class ExportRequestError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = "ExportRequestError";
  }
}

const MAX_POLLS = 40;
const POLL_DELAY_MS = 1_500;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

function retryable(cause: unknown): boolean {
  if (cause instanceof ExportRequestError) return cause.status === null || TRANSIENT_STATUSES.has(cause.status);
  return cause instanceof TypeError;
}

function operationLabel(operation: Operation, formatName: string): string {
  if (operation === "create") return `Memulai ekspor ${formatName}…`;
  if (operation === "status") return `Memeriksa status ${formatName}…`;
  if (operation === "retry") return `Mencoba kembali ekspor ${formatName}…`;
  return `Memverifikasi dan mengunduh ${formatName}…`;
}

function failureMessage(cause: unknown, operation: Operation, formatName: string): string {
  if (cause instanceof ExportPayloadError) return `Respons ekspor ${formatName} tidak dapat dibaca.`;
  if (cause instanceof ExportRequestError) {
    if (cause.status === 404) return `Ekspor ${formatName} tidak ditemukan.`;
    if (cause.status === 409) return "Snapshot dokumen telah berubah. Muat ulang dokumen sebelum mengekspor.";
    if (cause.status !== null && cause.status >= 500) return "Layanan ekspor sementara tidak tersedia.";
    if (cause.status === 429) return "Permintaan ekspor terlalu sering. Tunggu sebentar, lalu coba lagi.";
  }
  if (operation === "download") return cause instanceof Error ? cause.message : `Unduhan ${formatName} gagal diverifikasi.`;
  if (operation === "status") return "Status ekspor belum dapat diperiksa.";
  if (operation === "retry") return "Ekspor belum dapat diantrekan ulang.";
  return `Ekspor ${formatName} belum dapat dimulai.`;
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, POLL_DELAY_MS);
    function aborted() {
      window.clearTimeout(timer);
      reject(new DOMException("Permintaan dibatalkan.", "AbortError"));
    }
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

async function sha256Blob(blob: Blob, formatName: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error(`Browser ini tidak dapat memverifikasi unduhan ${formatName}.`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function FormatExport({
  payload,
  format,
  onUnauthorized,
  presentationRevision,
}: {
  payload: Pick<DocumentPayload, "analysisId" | "accountKey" | "contentHash">;
  format: ExportFormat;
  onUnauthorized: () => void;
  presentationRevision?: number;
}) {
  const [exportRecord, setExportRecord] = useState<ExportRecord | null>(null);
  const [pending, setPending] = useState<PendingOperation>(null);
  const [error, setError] = useState<ExportError | null>(null);
  const [pollingPaused, setPollingPaused] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const revokeTimer = useRef<number | null>(null);

  const formatName = format === "PDF" ? "PDF" : "Markdown";
  const acceptedMediaType = format === "PDF" ? "application/pdf" : "text/markdown";
  const collectionPath = `/api/analyses/${encodeURIComponent(payload.analysisId)}/exports`;
  const expectation = {
    analysisId: payload.analysisId,
    accountKey: payload.accountKey,
    documentHash: payload.contentHash,
  };

  function current(token: number): boolean {
    return mounted.current && generation.current === token;
  }

  function revokeDownloadUrl() {
    if (revokeTimer.current !== null) window.clearTimeout(revokeTimer.current);
    revokeTimer.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }

  function clearForIdentityRefresh(token: number) {
    if (!current(token)) return;
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    revokeDownloadUrl();
    setExportRecord(null);
    setPending(null);
    setError(null);
    setPollingPaused(false);
    onUnauthorized();
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      controller.current?.abort();
      controller.current = null;
      revokeDownloadUrl();
    };
  }, []);

  async function validateSession(token: number, signal: AbortSignal): Promise<boolean> {
    const response = await fetch("/api/auth/session", {
      headers: { "X-SAGE-Account": payload.accountKey },
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    if (!current(token)) return false;
    if (response.status === 401) {
      clearForIdentityRefresh(token);
      return false;
    }
    if (!response.ok) throw new ExportRequestError(response.status, "Sesi akun belum dapat diverifikasi.");
    let body: unknown;
    try { body = await response.json(); } catch { throw new ExportRequestError(null, "Sesi akun belum dapat diverifikasi."); }
    if (!current(token)) return false;
    const data = typeof body === "object" && body !== null && "data" in body
      ? (body as { data?: unknown }).data
      : null;
    const accountKey = typeof data === "object" && data !== null && "accountKey" in data
      ? (data as { accountKey?: unknown }).accountKey
      : null;
    if (accountKey !== payload.accountKey) {
      clearForIdentityRefresh(token);
      return false;
    }
    return true;
  }

  async function readExportResponse(
    response: Response,
    token: number,
    expectedExportId?: string,
  ): Promise<ExportRecord | null> {
    if (!current(token)) return null;
    if (response.status === 401) {
      clearForIdentityRefresh(token);
      return null;
    }
    if (!response.ok) throw new ExportRequestError(response.status, "Permintaan ekspor gagal.");
    let body: unknown;
    try { body = await response.json(); } catch { throw new ExportPayloadError(format); }
    if (!current(token)) return null;
    const data = typeof body === "object" && body !== null && "data" in body
      ? (body as { data?: unknown }).data
      : null;
    const result = parseExportPayload(data, { ...expectation, format, exportId: expectedExportId });
    return result.export;
  }

  async function fetchExportRecord(
    path: string,
    method: "GET" | "POST",
    token: number,
    signal: AbortSignal,
    body?: unknown,
    expectedExportId?: string,
  ): Promise<ExportRecord | null> {
    const response = await fetch(path, {
      method,
      headers: {
        "X-SAGE-Account": payload.accountKey,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    return readExportResponse(response, token, expectedExportId);
  }

  function publishRecord(value: ExportRecord, token: number) {
    if (!current(token)) return;
    setExportRecord(value);
    setError(null);
  }

  async function pollUntilTerminal(
    initial: ExportRecord,
    token: number,
    signal: AbortSignal,
  ): Promise<void> {
    let latest = initial;
    for (let attempt = 0; attempt < MAX_POLLS && (latest.status === "QUEUED" || latest.status === "GENERATING"); attempt += 1) {
      await waitForPoll(signal);
      if (!current(token)) return;
      const next = await fetchExportRecord(`${collectionPath}/${encodeURIComponent(latest.id)}`, "GET", token, signal, undefined, latest.id);
      if (!next || !current(token)) return;
      latest = next;
      publishRecord(latest, token);
    }
    if (current(token) && (latest.status === "QUEUED" || latest.status === "GENERATING")) setPollingPaused(true);
  }

  function beginOperation(operation: Operation, task: (token: number, signal: AbortSignal) => Promise<void>) {
    controller.current?.abort();
    revokeDownloadUrl();
    const nextController = new AbortController();
    controller.current = nextController;
    const token = ++generation.current;
    setPending(operation);
    setError(null);
    setPollingPaused(false);
    void (async () => {
      try {
        await task(token, nextController.signal);
      } catch (cause) {
        if (!current(token) || isAbortError(cause)) return;
        if (cause instanceof ExportBindingError) {
          clearForIdentityRefresh(token);
          return;
        }
        setError({ message: failureMessage(cause, operation, formatName), retry: retryable(cause) ? operation : null });
      } finally {
        if (current(token)) {
          setPending(null);
          if (controller.current === nextController) controller.current = null;
        }
      }
    })();
  }

  function createExport() {
    beginOperation("create", async (token, signal) => {
      const value = await fetchExportRecord(collectionPath, "POST", token, signal, { format, ...(presentationRevision === undefined ? {} : {presentationRevision}) });
      if (!value || !current(token)) return;
      publishRecord(value, token);
      await pollUntilTerminal(value, token, signal);
    });
  }

  function checkExport() {
    if (!exportRecord) return;
    const exportId = exportRecord.id;
    beginOperation("status", async (token, signal) => {
      const value = await fetchExportRecord(`${collectionPath}/${encodeURIComponent(exportId)}`, "GET", token, signal, undefined, exportId);
      if (!value || !current(token)) return;
      publishRecord(value, token);
      await pollUntilTerminal(value, token, signal);
    });
  }

  function retryExport() {
    if (!exportRecord) return;
    const exportId = exportRecord.id;
    beginOperation("retry", async (token, signal) => {
      const value = await fetchExportRecord(`${collectionPath}/${encodeURIComponent(exportId)}/retry`, "POST", token, signal, {}, exportId);
      if (!value || !current(token)) return;
      publishRecord(value, token);
      await pollUntilTerminal(value, token, signal);
    });
  }

  function downloadExport() {
    if (!exportRecord || exportRecord.status !== "READY") return;
    const readyExport = exportRecord;
    beginOperation("download", async (token, signal) => {
      if (!await validateSession(token, signal) || !current(token)) return;
      const response = await fetch(`${collectionPath}/${encodeURIComponent(readyExport.id)}/download`, {
        headers: { "X-SAGE-Account": payload.accountKey, Accept: acceptedMediaType },
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      if (!current(token)) return;
      if (response.status === 401) {
        clearForIdentityRefresh(token);
        return;
      }
      if (!response.ok) throw new ExportRequestError(response.status, "Unduhan ekspor gagal.");
      const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== acceptedMediaType) throw new Error(`Jenis berkas unduhan bukan ${formatName}.`);
      const blob = await response.blob();
      if (!current(token)) return;
      if (await sha256Blob(blob, formatName) !== readyExport.contentHash) {
        throw new Error(`Berkas ${formatName} belum bisa diverifikasi. Coba unduh lagi.`);
      }
      // A cookie can change during the body transfer, so only make the Blob downloadable
      // after revalidating the account against the completed download.
      if (!await validateSession(token, signal) || !current(token)) return;
      const url = URL.createObjectURL(blob);
      objectUrl.current = url;
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = exportDownloadFilename(response.headers.get("content-disposition"), payload.analysisId, format);
      anchor.rel = "noopener";
      window.document.body.append(anchor);
      anchor.click();
      anchor.remove();
      revokeTimer.current = window.setTimeout(() => {
        if (objectUrl.current === url) revokeDownloadUrl();
      }, 1_000);
    });
  }

  const statusMessage = !exportRecord ? null : exportRecord.status === "QUEUED"
    ? `Ekspor ${formatName} masuk antrean.`
    : exportRecord.status === "GENERATING"
      ? `${formatName} sedang disiapkan dari dokumen ini.`
      : exportRecord.status === "READY"
        ? `${formatName} siap diunduh.`
        : `Ekspor ${formatName} belum berhasil. Anda dapat mencoba lagi.`;

  const titleId = `${format.toLowerCase()}-export-title`;
  return <section className={styles.exportCard} aria-labelledby={titleId} aria-busy={pending !== null}>
    <div className={styles.exportCopy}>
      <p className={styles.eyebrow}>EKSPOR DOKUMEN</p>
      <h2 id={titleId}>{formatName}</h2>
      <p>Berkas dibuat dari dokumen analisis ini.</p>
      {statusMessage ? <p className={exportRecord?.status === "FAILED" ? styles.exportFailure : styles.exportStatus} role={exportRecord?.status === "FAILED" ? "alert" : "status"}>{statusMessage}</p> : null}
      {pending ? <p className={styles.exportStatus} role="status">{operationLabel(pending, formatName)}</p> : null}
      {pollingPaused ? <p className={styles.exportStatus} role="status">Pemeriksaan otomatis ${formatName} dijeda. Periksa status untuk melanjutkan.</p> : null}
      {error ? <p className={styles.exportFailure} role="alert">{error.message}</p> : null}
    </div>
    <div className={styles.exportActions}>
      {!exportRecord ? <button className={styles.exportButton} type="button" disabled={pending !== null} onClick={createExport}>
        {pending === "create" ? `Menyiapkan ${formatName}…` : error?.retry === "create" ? `Coba ekspor ${formatName} lagi` : `Ekspor ${formatName}`}
      </button> : null}
      {exportRecord && (exportRecord.status === "QUEUED" || exportRecord.status === "GENERATING") && (pollingPaused || error !== null) ? <button className={styles.exportButton} type="button" disabled={pending !== null} onClick={checkExport}>
        {pending === "status" ? `Memeriksa ${formatName}…` : error?.retry === "status" ? `Coba periksa ${formatName} lagi` : `Periksa status ${formatName}`}
      </button> : null}
      {exportRecord?.status === "READY" ? <button className={styles.exportButton} type="button" disabled={pending !== null} onClick={downloadExport}>
        {pending === "download" ? `Mengunduh ${formatName}…` : error?.retry === "download" ? `Coba unduh ${formatName} lagi` : `Unduh ${formatName}`}
      </button> : null}
      {exportRecord?.status === "FAILED" ? <button className={styles.exportButton} type="button" disabled={pending !== null} onClick={retryExport}>
        {pending === "retry" ? `Mengantrekan ${formatName}…` : `Coba ekspor ${formatName} lagi`}
      </button> : null}
    </div>
  </section>;
}

export function MarkdownExport(props: {
  payload: Pick<DocumentPayload, "analysisId" | "accountKey" | "contentHash">;
  onUnauthorized: () => void;
  presentationRevision?: number;
}) {
  return <FormatExport {...props} format="MARKDOWN" />;
}

export function PdfExport(props: {
  payload: Pick<DocumentPayload, "analysisId" | "accountKey" | "contentHash">;
  onUnauthorized: () => void;
  presentationRevision?: number;
}) {
  return <FormatExport {...props} format="PDF" />;
}
