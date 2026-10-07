declare const __TDA_SPEED_DIAGNOSTICS__: boolean;

export const SPEED_DIAGNOSTICS_ENABLED =
  typeof __TDA_SPEED_DIAGNOSTICS__ !== "undefined" && __TDA_SPEED_DIAGNOSTICS__;

const SPEED_TASK_FIELD = "__tda_speed_task_id";
const SPEED_LOG_PREFIX = "[TDA-SPEED]";

export interface SpeedLogDetails {
  [key: string]: string | number | boolean | null | undefined;
}

export function speedNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createSpeedTaskId(prefix: string): string {
  if (!SPEED_DIAGNOSTICS_ENABLED) return "";
  const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "task";
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${safePrefix}-${Date.now().toString(36)}-${suffix}`;
}

export function withSpeedTask<T extends object>(value: T, taskId: string): T {
  if (!SPEED_DIAGNOSTICS_ENABLED || !taskId) return value;
  return { ...value, [SPEED_TASK_FIELD]: taskId };
}

export function readSpeedTaskId(value: unknown, prefix: string): string {
  if (SPEED_DIAGNOSTICS_ENABLED && value && typeof value === "object") {
    const candidate = (value as Record<string, unknown>)[SPEED_TASK_FIELD];
    if (typeof candidate === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(candidate)) {
      return candidate;
    }
  }
  return createSpeedTaskId(prefix);
}

export function speedLog(
  scope: string,
  taskId: string,
  stage: string,
  startedAt?: number,
  details: SpeedLogDetails = {},
): void {
  if (!SPEED_DIAGNOSTICS_ENABLED) return;
  const now = speedNow();
  const memory = currentHeapBytes();
  const payload = {
    version: 1,
    wall_time: new Date().toISOString(),
    monotonic_ms: rounded(now),
    scope,
    task_id: taskId || "unscoped",
    stage,
    ...(startedAt === undefined ? {} : { elapsed_ms: rounded(Math.max(0, now - startedAt)) }),
    ...(memory === null ? {} : { heap_bytes: memory }),
    ...details,
  };
  console.info(`${SPEED_LOG_PREFIX} ${JSON.stringify(payload)}`);
}

function currentHeapBytes(): number | null {
  if (typeof performance === "undefined") return null;
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  }).memory;
  return typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)
    ? Math.round(memory.usedJSHeapSize)
    : null;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}
