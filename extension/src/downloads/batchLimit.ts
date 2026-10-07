const MIN_BATCH_POLLING_TIMEOUT_MS = 30 * 60_000;
const ITEM_RUNTIME_BUDGET_MS = 3 * 60_000;
const BACKEND_BATCH_CONCURRENCY = 2;

export interface BatchDownloadWindow<T> {
  items: T[];
  totalAvailable: number;
  truncated: boolean;
}

/** Keep every user-selected item in its existing filtered order. */
export function limitBatchDownloadItems<T>(items: readonly T[]): BatchDownloadWindow<T> {
  return {
    items: [...items],
    totalAvailable: items.length,
    truncated: false,
  };
}

/** Keep polling long enough for every accepted item while retaining cancellation. */
export function batchDownloadPollingTimeoutMs(itemCount: number): number {
  const safeCount = Math.max(1, Math.floor(itemCount));
  return Math.max(
    MIN_BATCH_POLLING_TIMEOUT_MS,
    Math.ceil(safeCount / BACKEND_BATCH_CONCURRENCY) * ITEM_RUNTIME_BUDGET_MS,
  );
}
