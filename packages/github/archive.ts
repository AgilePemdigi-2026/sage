import { GitHubRepositoryClient, GitHubRepositoryError } from "./client.js";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";
const CODELOAD_ORIGIN = "https://codeload.github.com";
const DEFAULT_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = DEFAULT_MAX_ARCHIVE_BYTES;
const DEFAULT_TIMEOUT_MS = 60_000;

export type RepositoryArchiveInput = {
  readonly repository: string;
  readonly githubRepositoryId: string;
  readonly commitSha: string;
  readonly accessToken: string | null;
  readonly signal?: AbortSignal;
  readonly maxArchiveBytes?: number;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
};

type AbortScope = {
  readonly signal: AbortSignal;
  dispose(): void;
};

function fail(code: ConstructorParameters<typeof GitHubRepositoryError>[0]): never {
  throw new GitHubRepositoryError(code);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,32}$/.test(value) && /[1-9]/.test(value);
}

function validCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function makeAbortScope(parent: AbortSignal | undefined, timeoutMs: number): AbortScope {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new GitHubRepositoryError("UNAVAILABLE"));
      return;
    }
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new GitHubRepositoryError("UNAVAILABLE"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal.aborted) reject(new GitHubRepositoryError("UNAVAILABLE"));
        else resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function createSafeFetcher(fetcher: typeof fetch, operationSignal: AbortSignal): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal
      ? AbortSignal.any([operationSignal, init.signal])
      : operationSignal;
    if (signal.aborted) return fail("UNAVAILABLE");
    try {
      const request = Promise.resolve().then(() => fetcher(input, { ...init, signal }));
      return await withAbort(request, signal);
    } catch {
      return fail("UNAVAILABLE");
    }
  }) as typeof fetch;
}

function validateCodeloadLocation(
  location: string,
  owner: string,
  repository: string,
  commitSha: string,
): URL {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return fail("UNAVAILABLE");
  }
  const expectedPath = `/${owner}/${repository}/legacy.tar.gz/${commitSha}`;
  if (url.origin !== CODELOAD_ORIGIN || url.pathname !== expectedPath || url.username || url.password || url.hash) {
    return fail("UNAVAILABLE");
  }
  return url;
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // Provider bodies are intentionally discarded; their contents are never surfaced.
  }
}

function isRateLimited(response: Response): boolean {
  return response.status === 429 || (response.status === 403 && (
    response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")
  ));
}

async function throwForProviderResponse(response: Response): Promise<never> {
  await cancelResponse(response);
  if (isRateLimited(response)) return fail("RATE_LIMIT");
  if (response.status === 401) return fail("AUTH_REQUIRED");
  if (response.status === 403) return fail("PERMISSION_DENIED");
  if (response.status === 404) return fail("NOT_FOUND");
  return fail("UNAVAILABLE");
}

async function readArchive(response: Response, maxArchiveBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxArchiveBytes)) {
    await cancelResponse(response);
    return fail("UNAVAILABLE");
  }
  if (!response.body) return fail("UNAVAILABLE");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxArchiveBytes) {
        void reader.cancel().catch(() => undefined);
        return fail("UNAVAILABLE");
      }
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return fail("UNAVAILABLE");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Resolve current access by repository ID, then fetch only the requested immutable commit archive. */
export async function fetchRepositoryArchive(input: RepositoryArchiveInput): Promise<Uint8Array> {
  if (!input || typeof input.repository !== "string" || !validId(input.githubRepositoryId) || !validCommitSha(input.commitSha)) {
    return fail("INVALID_INPUT");
  }
  if (input.accessToken !== null && typeof input.accessToken !== "string") return fail("INVALID_INPUT");
  if (input.signal !== undefined && (
    typeof input.signal !== "object"
    || typeof input.signal.aborted !== "boolean"
    || typeof input.signal.addEventListener !== "function"
    || typeof input.signal.removeEventListener !== "function"
  )) return fail("INVALID_INPUT");

  const maxArchiveBytes = input.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 1 || maxArchiveBytes > MAX_ARCHIVE_BYTES) return fail("INVALID_INPUT");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) return fail("INVALID_INPUT");

  const scope = makeAbortScope(input.signal, timeoutMs);
  try {
    if (scope.signal.aborted) return fail("UNAVAILABLE");
    const fetcher = createSafeFetcher(input.fetcher ?? fetch, scope.signal);
    const repository = await new GitHubRepositoryClient({ accessToken: input.accessToken, fetcher }).resolveRepository(input.repository);
    if (scope.signal.aborted) return fail("UNAVAILABLE");
    if (repository.id !== input.githubRepositoryId) return fail("NOT_FOUND");

    const sha = input.commitSha.toLowerCase();
    const apiPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tarball/${sha}`;
    const apiHeaders = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    });
    if (repository.private) {
      if (!input.accessToken) return fail("AUTH_REQUIRED");
      apiHeaders.set("Authorization", `Bearer ${input.accessToken}`);
    }
    const apiResponse = await fetcher(`${API_ORIGIN}${apiPath}`, {
      method: "GET",
      headers: apiHeaders,
      signal: scope.signal,
      cache: "no-store",
      redirect: "manual",
    });
    if (scope.signal.aborted) {
      await cancelResponse(apiResponse);
      return fail("UNAVAILABLE");
    }
    if (apiResponse.status !== 302) return throwForProviderResponse(apiResponse);
    const location = apiResponse.headers.get("location");
    await cancelResponse(apiResponse);
    if (!location) return fail("UNAVAILABLE");
    const codeloadUrl = validateCodeloadLocation(location, repository.owner, repository.name, sha);

    // Private archive URLs can carry temporary signatures. Keep them only in this request path.
    const archiveResponse = await fetcher(codeloadUrl, {
      method: "GET",
      headers: new Headers({ Accept: "application/octet-stream" }),
      signal: scope.signal,
      cache: "no-store",
      redirect: "error",
    });
    if (scope.signal.aborted) {
      await cancelResponse(archiveResponse);
      return fail("UNAVAILABLE");
    }
    if (archiveResponse.status !== 200) return throwForProviderResponse(archiveResponse);
    return await readArchive(archiveResponse, maxArchiveBytes, scope.signal);
  } catch (error) {
    if (error instanceof GitHubRepositoryError) throw error;
    return fail("UNAVAILABLE");
  } finally {
    scope.dispose();
  }
}
