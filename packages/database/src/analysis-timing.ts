/**
 * Production analysis keeps a two-minute renewable lease for large canonical
 * documents. A heartbeat every 40s leaves at least 80s before expiry; a bounded
 * 45s persistence/publication transaction and 2s acquisition wait fit that window.
 * Renewal can wait behind that transaction, then rechecks expiry using DB time.
 * Shorter caller leases remain supported and still fail the final expiry fence.
 */
export const ANALYSIS_RUNTIME_LEASE_DURATION_MS = 120_000;
export const ANALYSIS_DOCUMENT_TRANSACTION_OPTIONS = { maxWait: 2_000, timeout: 45_000 } as const;
export const ANALYSIS_RENEWAL_TRANSACTION_OPTIONS = { maxWait: 2_000, timeout: 50_000 } as const;
