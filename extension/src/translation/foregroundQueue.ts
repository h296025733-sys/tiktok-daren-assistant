import {
  MAX_TRANSLATION_BATCH_CHARACTERS,
  MAX_TRANSLATION_BATCH_SIZE,
} from "../background/translationService";
import {
  LOCAL_MODEL_IDS,
  SUPPORTED_TRANSLATION_TARGET_LANGUAGES,
  type ForegroundTranslationDiagnosticCode,
  type ForegroundTranslationJobResult,
  type PollForegroundTranslationRequest,
  type PollForegroundTranslationResponse,
  type PrepareForegroundTranslationRequest,
  type PrepareForegroundTranslationResponse,
  type QueueForegroundTranslationRequest,
  type QueueForegroundTranslationResponse,
  type QueuedForegroundTranslation,
  type TranslationErrorResponse,
  type TranslationProviderMode,
  type TranslationRequest,
  type TranslationResponse,
  type TranslationTargetLanguage,
} from "../types/messages";
import {
  readSpeedTaskId,
  speedLog,
  speedNow,
  withSpeedTask,
} from "../shared/speedDiagnostics";

export const FOREGROUND_TRANSLATION_QUEUE_KEY = "pendingForegroundTranslations";
export const FOREGROUND_TRANSLATION_RESULTS_KEY = "foregroundTranslationResults";
export const FOREGROUND_TRANSLATION_MAX_AGE_MS = 5 * 60_000;
export const MAX_PENDING_FOREGROUND_TRANSLATIONS = 20;
export const DEFAULT_FOREGROUND_TRANSLATION_POLL_MS = 250;
export const DEFAULT_FOREGROUND_TRANSLATION_TIMEOUT_MS = 45_000;

const MAX_TEXT_LENGTH = 1_600;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const ERROR_CODES = new Set<TranslationErrorResponse["code"]>([
  "INVALID_REQUEST",
  "TEXT_TOO_LONG",
  "BATCH_TOO_LARGE",
  "REQUEST_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "LOCAL_MODEL_REQUIRED",
  "PROVIDER_NOT_CONFIGURED",
  "INVALID_PROVIDER_RESPONSE",
]);
const TARGET_LANGUAGES = new Set<string>(SUPPORTED_TRANSLATION_TARGET_LANGUAGES);
const MODEL_IDS = new Set<string>(LOCAL_MODEL_IDS);
const DIAGNOSTIC_CODES = new Set<ForegroundTranslationDiagnosticCode>([
  "fg_prepare_opened",
  "fg_prepare_unconfirmed",
  "fg_queue_enqueued",
  "fg_queue_panel_unconfirmed",
  "fg_queue_pending",
  "fg_queue_completed",
  "fg_queue_invalid",
  "fg_queue_message_failed",
  "fg_queue_timeout",
]);

export function usableQueuedForegroundTranslations(
  value: unknown,
  now = Date.now(),
): QueuedForegroundTranslation[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is QueuedForegroundTranslation => isQueuedForegroundTranslation(item, now))
    .slice(-MAX_PENDING_FOREGROUND_TRANSLATIONS);
}

export function usableForegroundTranslationResults(
  value: unknown,
  now = Date.now(),
): ForegroundTranslationJobResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is ForegroundTranslationJobResult => isForegroundTranslationResult(item, now))
    .slice(-MAX_PENDING_FOREGROUND_TRANSLATIONS);
}

/** Removes unknown fields and rejects text outside the same bounds as TranslationService. */
export function sanitizeForegroundTranslationRequest(value: unknown): TranslationRequest | null {
  if (!isRecord(value)) return null;
  const targetLanguage = value.target_language;
  if (targetLanguage !== undefined && (
    typeof targetLanguage !== "string" || !TARGET_LANGUAGES.has(targetLanguage)
  )) return null;
  const provider = value.provider;
  if (provider !== undefined && provider !== "standard" && provider !== "deepseek_expert") return null;

  const extras: {
    target_language?: TranslationTargetLanguage;
    provider?: TranslationProviderMode;
  } = {};
  if (typeof targetLanguage === "string") extras.target_language = targetLanguage as TranslationTargetLanguage;
  if (provider === "standard" || provider === "deepseek_expert") extras.provider = provider;
  if (value.type === "TRANSLATE_PUBLIC_TEXT") {
    const text = normalizedText(value.text);
    return text ? { type: value.type, text, ...extras } : null;
  }
  if (value.type !== "TRANSLATE_PUBLIC_TEXT_BATCH" || !Array.isArray(value.texts)) return null;
  if (value.texts.length === 0 || value.texts.length > MAX_TRANSLATION_BATCH_SIZE) return null;
  const texts = value.texts.map(normalizedText);
  if (texts.some((text) => text === null)) return null;
  const safeTexts = texts as string[];
  if (
    safeTexts.reduce((total, text) => total + text.length, 0) >
    MAX_TRANSLATION_BATCH_CHARACTERS
  ) return null;
  return { type: value.type, texts: safeTexts, ...extras };
}

export interface ForegroundTranslationBridgeOptions {
  sendMessage?: (message: unknown) => Promise<unknown>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface ForegroundTranslationBridgeLike {
  prepare(): void;
  translate(request: TranslationRequest): Promise<TranslationResponse>;
}

export class ForegroundTranslationBridge implements ForegroundTranslationBridgeLike {
  private readonly sendMessage: (message: unknown) => Promise<unknown>;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(options: ForegroundTranslationBridgeOptions = {}) {
    this.sendMessage = options.sendMessage ?? ((message) => chrome.runtime.sendMessage(message));
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_FOREGROUND_TRANSLATION_POLL_MS);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_FOREGROUND_TRANSLATION_TIMEOUT_MS);
  }

  /** Called synchronously from the click path so Chrome can honor sidePanel.open user activation. */
  prepare(): void {
    const message: PrepareForegroundTranslationRequest = { type: "PREPARE_FOREGROUND_TRANSLATION" };
    try {
      void this.sendMessage(message).catch(() => undefined);
    } catch {
      // Preparation is best effort; the later queue request still retries open.
    }
  }

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const taskId = readSpeedTaskId(request, "translation-foreground-queue");
    const taskStartedAt = speedNow();
    const safeRequest = sanitizeForegroundTranslationRequest(request);
    if (!safeRequest) {
      speedLog("translation.foreground_queue.content", taskId, "request_rejected", taskStartedAt);
      return queueFailure("INVALID_REQUEST", "翻译请求无效", "fg_queue_invalid");
    }

    const queued = await this.sendQueueRequest(safeRequest, taskId);
    if (!queued.ok) {
      speedLog("translation.foreground_queue.content", taskId, "enqueue_failed", taskStartedAt, {
        diagnostic: queued.diagnostic,
      });
      return queueFailure("PROVIDER_UNAVAILABLE", queued.error, queued.diagnostic);
    }

    const startedAt = this.now();
    let pollCount = 0;
    const pollRequest: PollForegroundTranslationRequest = {
      type: "GET_FOREGROUND_TRANSLATION_RESULT",
      request_id: queued.request_id,
    };
    while (this.now() - startedAt < this.timeoutMs) {
      await this.delay(this.pollIntervalMs);
      let raw: unknown;
      try {
        pollCount += 1;
        raw = await this.sendMessage(pollRequest);
      } catch {
        speedLog("translation.foreground_queue.content", taskId, "poll_failed", taskStartedAt, {
          foreground_request_id: queued.request_id,
          poll_count: pollCount,
        });
        return queueFailure("PROVIDER_UNAVAILABLE", "无法读取本地翻译结果，请重试", "fg_queue_message_failed");
      }
      if (!isPollResponse(raw)) {
        speedLog("translation.foreground_queue.content", taskId, "invalid_poll_response", taskStartedAt, {
          foreground_request_id: queued.request_id,
          poll_count: pollCount,
        });
        return queueFailure("INVALID_PROVIDER_RESPONSE", "本地翻译结果无效，请重试", "fg_queue_message_failed");
      }
      if (!raw.ok) return queueFailure("PROVIDER_UNAVAILABLE", raw.error, raw.diagnostic);
      if (raw.status === "completed") {
        speedLog("translation.foreground_queue.content", taskId, "request_complete", taskStartedAt, {
          foreground_request_id: queued.request_id,
          poll_count: pollCount,
          ok: raw.response.ok,
        });
        return raw.response;
      }
    }
    speedLog("translation.foreground_queue.content", taskId, "request_timeout", taskStartedAt, {
      foreground_request_id: queued.request_id,
      poll_count: pollCount,
    });
    return queueFailure("REQUEST_TIMEOUT", "本地翻译等待超时，请重试", "fg_queue_timeout");
  }

  private async sendQueueRequest(
    request: TranslationRequest,
    taskId: string,
  ): Promise<QueueForegroundTranslationResponse> {
    const startedAt = speedNow();
    const message: QueueForegroundTranslationRequest = {
      type: "QUEUE_FOREGROUND_TRANSLATION",
      request: withSpeedTask(request, taskId),
    };
    try {
      const raw = await this.sendMessage(message);
      speedLog("translation.foreground_queue.content", taskId, "enqueue_response", startedAt, {
        valid: isQueueResponse(raw),
      });
      return isQueueResponse(raw)
        ? raw
        : { ok: false, error: "本地翻译队列响应无效", diagnostic: "fg_queue_message_failed" };
    } catch (error) {
      speedLog("translation.foreground_queue.content", taskId, "enqueue_message_failed", startedAt, {
        error_name: error instanceof Error ? error.name : "unknown",
      });
      return { ok: false, error: "无法连接本地翻译队列，请重试", diagnostic: "fg_queue_message_failed" };
    }
  }
}

function isQueuedForegroundTranslation(value: unknown, now: number): value is QueuedForegroundTranslation {
  if (!isRecord(value)) return false;
  return (
    validRequestId(value.request_id) &&
    validTabId(value.tab_id) &&
    validTimestamp(value.requested_at, now) &&
    sanitizeForegroundTranslationRequest(value.request) !== null
  );
}

function isForegroundTranslationResult(value: unknown, now: number): value is ForegroundTranslationJobResult {
  if (!isRecord(value)) return false;
  return (
    validRequestId(value.request_id) &&
    validTabId(value.tab_id) &&
    validTimestamp(value.updated_at, now) &&
    isTranslationResponse(value.response)
  );
}

function isTranslationResponse(value: unknown): value is TranslationResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) {
    if (
      typeof value.error !== "string" || value.error.length > 300 ||
      typeof value.code !== "string" || !ERROR_CODES.has(value.code as TranslationErrorResponse["code"])
    ) return false;
    if (value.required_model_ids !== undefined) {
      if (!Array.isArray(value.required_model_ids) || value.required_model_ids.length > LOCAL_MODEL_IDS.length) {
        return false;
      }
      if (value.required_model_ids.some((id) => typeof id !== "string" || !MODEL_IDS.has(id))) {
        return false;
      }
    }
    return true;
  }
  if (!isRecord(value.data) || !Array.isArray(value.data.items) || value.data.items.length === 0) return false;
  if (
    value.data.provider !== "google_first_chain" &&
    value.data.provider !== "local_foreground" &&
    value.data.provider !== "deepseek_expert"
  ) return false;
  return value.data.items.every((item) => isRecord(item) &&
    typeof item.source_text === "string" &&
    typeof item.translated_text === "string" &&
    item.translated_text.length > 0 &&
    typeof item.target_language === "string" &&
    TARGET_LANGUAGES.has(item.target_language) &&
    typeof item.cached === "boolean" &&
    (item.provider === undefined || item.provider === "google_translate_web" ||
      item.provider === "bing_translate_web" ||
      item.provider === "argos_local")
  );
}

function isQueueResponse(value: unknown): value is QueueForegroundTranslationResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean" || !isDiagnosticCode(value.diagnostic)) return false;
  return value.ok
    ? validRequestId(value.request_id)
    : typeof value.error === "string";
}

function isPollResponse(value: unknown): value is PollForegroundTranslationResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean" || !isDiagnosticCode(value.diagnostic)) return false;
  if (!value.ok) return typeof value.error === "string";
  if (value.status === "pending") return true;
  return value.status === "completed" && isTranslationResponse(value.response);
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= MAX_TEXT_LENGTH ? text : null;
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function validTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validTimestamp(value: unknown, now: number): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value <= now + 60_000 && now - value <= FOREGROUND_TRANSLATION_MAX_AGE_MS;
}

function queueFailure(
  code: TranslationErrorResponse["code"],
  error: string,
  diagnostic: ForegroundTranslationDiagnosticCode,
): TranslationErrorResponse {
  return { ok: false, error: error.slice(0, 240), code, diagnostic };
}

function isDiagnosticCode(value: unknown): value is ForegroundTranslationDiagnosticCode {
  return typeof value === "string" && DIAGNOSTIC_CODES.has(value as ForegroundTranslationDiagnosticCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
