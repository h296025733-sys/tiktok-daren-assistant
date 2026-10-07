import {
  LOCAL_MODEL_IDS,
  SUPPORTED_TRANSLATION_TARGET_LANGUAGES,
  TRANSLATION_TARGET_LANGUAGE,
  type LocalModelId,
  type TranslationErrorResponse,
  type TranslationProviderMode,
  type TranslationRequest,
  type TranslationResponse,
  type TranslationResultItem,
  type TranslationTargetLanguage,
} from "../types/messages";
import {
  readSpeedTaskId,
  speedLog,
  speedNow,
} from "../shared/speedDiagnostics";

export const GOOGLE_TRANSLATION_ENDPOINT =
  "https://translate.googleapis.com/translate_a/single";
export const GOOGLE_TRANSLATION_PRIMARY_ENDPOINT =
  "https://translate.google.com/translate_a/single";
export const GOOGLE_TRANSLATION_ARRAY_ENDPOINT =
  "https://translate.googleapis.com/translate_a/t";
export const GOOGLE_TRANSLATE_HTML_ENDPOINT =
  "https://translate-pa.googleapis.com/v1/translateHtml";
export const GOOGLE_TRANSLATE_HTML_API_KEY =
  "";
export const GOOGLE_TRANSLATION_ENDPOINTS = [
  GOOGLE_TRANSLATION_PRIMARY_ENDPOINT,
  GOOGLE_TRANSLATION_ENDPOINT,
] as const;
export const BING_TRANSLATOR_PAGE_ENDPOINT =
  "https://www.bing.com/translator";
export const BING_TRANSLATOR_PAGE_ENDPOINTS = [
  BING_TRANSLATOR_PAGE_ENDPOINT,
] as const;
export const LOCAL_TRANSLATION_ENDPOINT =
  "http://127.0.0.1:8765/api/v1/translations/translate";
export const LOCAL_TRANSLATION_FALLBACK_ENDPOINT =
  "http://localhost:8765/api/v1/translations/translate";
export const LOCAL_GOOGLE_TRANSLATION_ENDPOINT =
  "http://127.0.0.1:8765/api/v1/translations/google";
export const LOCAL_GOOGLE_TRANSLATION_FALLBACK_ENDPOINT =
  "http://localhost:8765/api/v1/translations/google";
export const LOCAL_TRANSLATION_ENDPOINTS = [
  LOCAL_TRANSLATION_ENDPOINT,
  LOCAL_TRANSLATION_FALLBACK_ENDPOINT,
] as const;
export const TRANSLATION_PROVIDER_NOTICE =
  "Chrome 专用版优先使用 Google 整批在线翻译，失败时自动切换 Bing；其他版本保留可用的在线与本机回退通道。";
export const MAX_TRANSLATION_TEXT_LENGTH = 1_600;
// Keep the extension boundary aligned with the backend /batch contract so a
// fully loaded comment page or a normal subtitle track is sent in one batch.
export const MAX_TRANSLATION_BATCH_SIZE = 80;
export const MAX_TRANSLATION_BATCH_CHARACTERS = 24_000;
export const MIN_GOOGLE_BATCH_SIZE = 2;
export const DEFAULT_TRANSLATION_TIMEOUT_MS = 8_000;
export const DEFAULT_GOOGLE_BATCH_TIMEOUT_MS = 3_000;
export const DEFAULT_GOOGLE_DIRECT_TIMEOUT_MS = 3_000;
export const DEFAULT_BING_HEDGE_DELAY_MS = 300;
export const DEFAULT_BING_BOOTSTRAP_TIMEOUT_MS = 5_000;
export const DEFAULT_BING_TRANSLATION_TIMEOUT_MS = 8_000;
export const DEFAULT_BING_BOOTSTRAP_TTL_MS = 50 * 60_000;
export const DEFAULT_TRANSLATION_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_TRANSLATION_CACHE_SIZE = 300;
export const DEFAULT_TRANSLATION_MAX_CONCURRENCY = 2;
export const DEFAULT_GOOGLE_RATE_LIMIT_COOLDOWN_MS = 60_000;
export const DEFAULT_GOOGLE_TRANSPORT_COOLDOWN_MS = 5 * 60_000;
export const DEFAULT_BING_TRANSPORT_COOLDOWN_MS = 30_000;
export const MAX_GOOGLE_RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
export const MAX_GOOGLE_RETRY_AFTER_MS = 24 * 60 * 60_000;

type TranslationErrorCode = TranslationErrorResponse["code"];

interface CacheEntry {
  expiresAt: number;
  item: TranslationResultItem;
}

export interface BingTranslatorBootstrap {
  origin: string;
  ig: string;
  iid: string;
  key: string;
  token: string;
  expiresAt: number;
}

export interface StoredGoogleCooldown {
  until: number;
  failure_count: number;
  last_failure_at: number;
  reason: "rate_limit" | "transport";
}

export interface TranslationCooldownStore {
  load(): Promise<unknown>;
  save(cooldowns: Readonly<Record<string, StoredGoogleCooldown>>): Promise<void>;
}

export interface BingBootstrapStore {
  load(): Promise<unknown>;
  save(bootstrap: Readonly<BingTranslatorBootstrap>): Promise<void>;
  clear(): Promise<void>;
}

export interface TranslationServiceOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  maxConcurrentRequests?: number;
  googleEndpoint?: string;
  googleEndpoints?: readonly string[];
  googleArrayEndpoint?: string | null;
  googleTranslateHtmlEndpoint?: string | null;
  googleTranslateHtmlApiKey?: string | null;
  bingTranslatorPages?: readonly string[];
  localFallbackEndpoint?: string;
  localFallbackEndpoints?: readonly string[];
  cooldownStore?: TranslationCooldownStore;
  bingBootstrapStore?: BingBootstrapStore;
  /**
   * Visible extension pages can reliably reach the loopback backend, while an
   * MV3 worker/content script may be blocked before the request reaches it.
   * The side panel enables this so the backend performs the Google request.
   */
  preferLocalBackend?: boolean;
}

export class TranslationServiceError extends Error {
  constructor(
    readonly code: TranslationErrorCode,
    message: string,
    readonly diagnostic: string | null = null,
    readonly requiredModelIds: LocalModelId[] = [],
  ) {
    super(message);
    this.name = "TranslationServiceError";
  }
}

export class TranslationService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly maxConcurrentRequests: number;
  private readonly googleEndpoints: readonly string[];
  private readonly googleArrayEndpoint: string | null;
  private readonly googleTranslateHtmlEndpoint: string | null;
  private readonly googleTranslateHtmlApiKey: string | null;
  private readonly bingTranslatorPages: readonly string[];
  private readonly localFallbackEndpoints: readonly string[];
  private readonly preferLocalBackend: boolean;
  private readonly cooldownStore: TranslationCooldownStore | null;
  private readonly bingBootstrapStore: BingBootstrapStore | null;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlightTranslations = new Map<string, Promise<TranslationResultItem[]>>();
  private readonly googleCooldowns = new Map<string, StoredGoogleCooldown>();
  private readonly googlePermitQueue: Array<() => void> = [];
  private cooldownLoad: Promise<void> | null = null;
  private cooldownWrite: Promise<void> = Promise.resolve();
  private activeGoogleRequests = 0;
  private handledRequests = 0;
  private bingBootstrap: BingTranslatorBootstrap | null = null;
  private bingBootstrapLoad: Promise<BingTranslatorBootstrap> | null = null;
  private googleArrayRequestSequence = 0;
  private bingRequestSequence = 0;

  constructor(options: TranslationServiceOptions = {}) {
    // Window.fetch is a Web IDL method in Chrome and rejects calls made with
    // this TranslationService instance as its receiver ("Illegal invocation").
    // Bind the native default once; injected test transports remain untouched.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.max(500, options.timeoutMs ?? DEFAULT_TRANSLATION_TIMEOUT_MS);
    this.cacheTtlMs = Math.max(1_000, options.cacheTtlMs ?? DEFAULT_TRANSLATION_CACHE_TTL_MS);
    this.maxCacheEntries = Math.max(1, options.maxCacheEntries ?? DEFAULT_TRANSLATION_CACHE_SIZE);
    this.maxConcurrentRequests = Math.max(
      1,
      Math.min(4, options.maxConcurrentRequests ?? DEFAULT_TRANSLATION_MAX_CONCURRENCY),
    );
    this.googleEndpoints = normalizeGoogleEndpoints(
      options.googleEndpoints ??
        (options.googleEndpoint ? [options.googleEndpoint] : GOOGLE_TRANSLATION_ENDPOINTS),
    );
    this.googleArrayEndpoint = normalizeGoogleArrayEndpoint(options.googleArrayEndpoint);
    this.googleTranslateHtmlEndpoint = normalizeGoogleTranslateHtmlEndpoint(
      options.googleTranslateHtmlEndpoint,
    );
    this.googleTranslateHtmlApiKey = normalizeGoogleTranslateHtmlApiKey(
      options.googleTranslateHtmlApiKey,
    );
    this.bingTranslatorPages = normalizeBingTranslatorPages(
      options.bingTranslatorPages ?? BING_TRANSLATOR_PAGE_ENDPOINTS,
    );
    this.preferLocalBackend = options.preferLocalBackend ?? false;
    this.localFallbackEndpoints = normalizeLocalEndpoints(
      options.localFallbackEndpoints ??
        (options.localFallbackEndpoint ? [options.localFallbackEndpoint] : LOCAL_TRANSLATION_ENDPOINTS),
    );
    this.cooldownStore = options.cooldownStore ?? null;
    this.bingBootstrapStore = options.bingBootstrapStore ?? null;
  }

  async handle(
    request: TranslationRequest,
    signal?: AbortSignal,
  ): Promise<TranslationResponse> {
    const taskId = readSpeedTaskId(request, "translation");
    const startedAt = speedNow();
    const coldStart = this.handledRequests === 0;
    this.handledRequests += 1;
    let fallbackText: string | null = null;
    let targetLanguage: TranslationTargetLanguage = TRANSLATION_TARGET_LANGUAGE;
    try {
      targetLanguage = normalizeTargetLanguage(request.target_language);
      const provider = normalizeProvider(request.provider);
      const texts = request.type === "TRANSLATE_PUBLIC_TEXT" ? [request.text] : request.texts;
      speedLog("translation-service", taskId, "request_start", startedAt, {
        cold_start: coldStart,
        request_kind: request.type === "TRANSLATE_PUBLIC_TEXT" ? "single" : "batch",
        item_count: Array.isArray(texts) ? texts.length : 0,
        character_count: Array.isArray(texts)
          ? texts.reduce((total, text) => total + (typeof text === "string" ? text.length : 0), 0)
          : 0,
        target_language: targetLanguage,
        max_concurrency: this.maxConcurrentRequests,
      });
      fallbackText = Array.isArray(texts) && typeof texts[0] === "string" ? texts[0].trim() : null;
      if (provider === "deepseek_expert") {
        throw new TranslationServiceError(
          "PROVIDER_NOT_CONFIGURED",
          "专家翻译接口已预留，当前版本尚未配置",
          "deepseek_expert_not_configured",
        );
      }
      const items = await this.translateTexts(texts, targetLanguage, taskId, signal);
      speedLog("translation-service", taskId, "request_complete", startedAt, {
        ok: true,
        item_count: items.length,
        cached_count: items.filter((item) => item.cached).length,
      });
      return {
        ok: true,
        data: {
          items,
          provider: "google_first_chain",
          provider_notice: TRANSLATION_PROVIDER_NOTICE,
        },
      };
    } catch (error) {
      const normalized = normalizeTranslationError(error);
      speedLog("translation-service", taskId, "request_complete", startedAt, {
        ok: false,
        error_code: normalized.code,
      });
      return {
        ok: false,
        error: normalized.message,
        code: normalized.code,
        ...(fallbackText
          ? { fallback_url: buildGoogleTranslateFallbackUrl(fallbackText, targetLanguage) }
          : {}),
        ...(normalized.requiredModelIds.length
          ? { required_model_ids: normalized.requiredModelIds }
          : {}),
        ...(normalized.diagnostic ? { diagnostic: normalized.diagnostic } : {}),
      };
    }
  }

  async translateTexts(
    input: unknown,
    targetLanguage: TranslationTargetLanguage = TRANSLATION_TARGET_LANGUAGE,
    taskId = "",
    signal?: AbortSignal,
  ): Promise<TranslationResultItem[]> {
    const texts = validateTexts(input);
    throwIfTranslationCancelled(signal);
    // Cancellation belongs to one user task. Do not let an old auto-subtitle
    // request share (and therefore abort) an unrelated comment translation
    // that happens to contain the same text.
    const inFlightKey = signal
      ? `${buildInFlightTranslationKey(texts, targetLanguage)}\u0000task:${taskId}`
      : buildInFlightTranslationKey(texts, targetLanguage);
    const existing = this.inFlightTranslations.get(inFlightKey);
    if (existing) {
      speedLog("translation-service", taskId, "inflight_hit", undefined, {
        item_count: texts.length,
      });
      return (await existing).map((item) => ({ ...item }));
    }

    const pending = this.translateTextsUnshared(texts, targetLanguage, taskId, signal);
    this.inFlightTranslations.set(inFlightKey, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlightTranslations.get(inFlightKey) === pending) {
        this.inFlightTranslations.delete(inFlightKey);
      }
    }
  }

  async warmOnlineProvider(taskId = ""): Promise<void> {
    if (this.bingTranslatorPages.length === 0) return;
    await this.getBingBootstrap(taskId);
  }

  private async translateTextsUnshared(
    texts: string[],
    targetLanguage: TranslationTargetLanguage,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TranslationResultItem[]> {
    throwIfTranslationCancelled(signal);
    const startedAt = speedNow();
    const uniqueTexts = [...new Set(texts)];
    speedLog("translation-service", taskId, "dedupe_complete", startedAt, {
      input_count: texts.length,
      unique_count: uniqueTexts.length,
      duplicate_count: texts.length - uniqueTexts.length,
    });
    const translatedByText = new Map<string, TranslationResultItem>();
    let remainingTexts = uniqueTexts;

    if (!this.preferLocalBackend && uniqueTexts.length >= MIN_GOOGLE_BATCH_SIZE) {
      const uncachedTexts: string[] = [];
      for (const [index, text] of uniqueTexts.entries()) {
        const cached = this.getCached(buildCacheKey(text, targetLanguage));
        if (cached) {
          translatedByText.set(text, { ...cached, cached: true });
          speedLog("translation-service", taskId, "cache_hit", undefined, {
            text_index: index,
            text_characters: text.length,
          });
        } else {
          uncachedTexts.push(text);
        }
      }
      if (uncachedTexts.length >= MIN_GOOGLE_BATCH_SIZE) {
        const batchItems = await this.raceOnlineProviders(
          (signal) => this.tryTranslateGoogleBatch(
            uncachedTexts,
            targetLanguage,
            taskId,
            signal,
          ),
          (signal) => this.tryTranslateBingBatch(
            uncachedTexts,
            targetLanguage,
            taskId,
            signal,
          ),
          signal,
        );
        if (batchItems) {
          for (const item of batchItems) {
            this.setCached(buildCacheKey(item.source_text, targetLanguage), item);
            translatedByText.set(item.source_text, item);
          }
        }
      }
      remainingTexts = uniqueTexts.filter((text) => !translatedByText.has(text));
    }
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < remainingTexts.length) {
        throwIfTranslationCancelled(signal);
        const index = cursor;
        cursor += 1;
        const text = remainingTexts[index];
        if (text === undefined) return;
        translatedByText.set(
          text,
          await this.translateOne(text, targetLanguage, taskId, index, signal),
        );
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(this.maxConcurrentRequests, remainingTexts.length) },
        () => worker(),
      ),
    );

    const result = texts.map((text) => {
      const item = translatedByText.get(text);
      if (!item) {
        throw new TranslationServiceError("INVALID_PROVIDER_RESPONSE", "翻译结果数量不完整");
      }
      return { ...item };
    });
    speedLog("translation-service", taskId, "batch_complete", startedAt, {
      input_count: texts.length,
      unique_count: uniqueTexts.length,
      cached_count: result.filter((item) => item.cached).length,
    });
    return result;
  }

  private async tryTranslateGoogleBatch(
    texts: string[],
    targetLanguage: TranslationTargetLanguage,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TranslationResultItem[] | null> {
    const startedAt = speedNow();
    if (this.googleTranslateHtmlEndpoint && this.googleTranslateHtmlApiKey) {
      try {
        const items = await this.translateGoogleHtmlBatch(
          texts,
          targetLanguage,
          taskId,
          signal,
        );
        speedLog("translation-service", taskId, "google_html_batch_complete", startedAt, {
          item_count: items.length,
        });
        return items;
      } catch (error) {
        if (isCancelledTranslationError(error)) throw error;
        speedLog("translation-service", taskId, "google_html_batch_failed", startedAt, {
          item_count: texts.length,
          error_name: safeErrorName(error),
        });
      }
    }
    if (this.googleArrayEndpoint) {
      try {
        const items = await this.translateGoogleArrayThroughEndpoint(
          texts,
          targetLanguage,
          taskId,
          signal,
        );
        speedLog("translation-service", taskId, "google_array_batch_complete", startedAt, {
          item_count: items.length,
        });
        return items;
      } catch (error) {
        if (isCancelledTranslationError(error)) throw error;
        speedLog("translation-service", taskId, "google_array_batch_failed", startedAt, {
          item_count: texts.length,
          error_name: safeErrorName(error),
        });
      }
    }
    const endpoints = preferFastGoogleBatchEndpoint(this.googleEndpoints);
    for (const [index, endpoint] of endpoints.entries()) {
      if (signal?.aborted) return null;
      try {
        const items = await this.translateGoogleBatchThroughEndpoint(
          texts,
          targetLanguage,
          endpoint,
          taskId,
          index + 1,
          signal,
        );
        speedLog("translation-service", taskId, "google_batch_complete", startedAt, {
          item_count: items.length,
          provider_attempt: index + 1,
        });
        return items;
      } catch (error) {
        if (isCancelledTranslationError(error)) throw error;
        speedLog("translation-service", taskId, "google_batch_attempt_failed", startedAt, {
          item_count: texts.length,
          provider_attempt: index + 1,
          error_name: safeErrorName(error),
        });
      }
    }
    speedLog("translation-service", taskId, "google_batch_fallback_to_individual", startedAt, {
      item_count: texts.length,
    });
    return null;
  }

  private async translateGoogleHtmlBatch(
    texts: string[],
    targetLanguage: TranslationTargetLanguage,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TranslationResultItem[]> {
    const endpoint = this.googleTranslateHtmlEndpoint;
    const apiKey = this.googleTranslateHtmlApiKey;
    if (!endpoint || !apiKey) {
      throw new TranslationServiceError(
        "PROVIDER_UNAVAILABLE",
        "Google 快速整批翻译通道未启用",
        "google_html_disabled",
      );
    }
    const response = await this.fetchGoogleWithPolicy(
      endpoint,
      endpoint,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json+protobuf",
          "x-goog-api-key": apiKey,
        },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        body: JSON.stringify([[texts, "auto", targetLanguage], "te_lib"]),
      },
      taskId,
      -1,
      1,
      Math.min(this.timeoutMs, DEFAULT_GOOGLE_BATCH_TIMEOUT_MS),
      signal,
    );
    if (!response.ok) {
      throw new TranslationServiceError(
        "PROVIDER_UNAVAILABLE",
        "Google 快速整批翻译暂时不可用",
        `google_html_http_${response.status}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TranslationServiceError(
        "INVALID_PROVIDER_RESPONSE",
        "Google 快速整批翻译返回了无效响应",
        "google_html_invalid_json",
      );
    }
    const translations = parseGoogleTranslateHtmlResponse(payload, texts.length);
    return texts.map((text, index) => ({
      source_text: text,
      translated_text: translations[index]!,
      detected_source_language: null,
      target_language: targetLanguage,
      cached: false,
      provider: "google_translate_web",
    }));
  }

  private async translateGoogleArrayThroughEndpoint(
    texts: string[],
    targetLanguage: TranslationTargetLanguage,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TranslationResultItem[]> {
    const endpoint = this.googleArrayEndpoint;
    if (!endpoint) {
      throw new TranslationServiceError(
        "PROVIDER_UNAVAILABLE",
        "Google 整批翻译通道未启用",
        "google_array_disabled",
      );
    }
    const requestSequence = ++this.googleArrayRequestSequence;
    const url = new URL(endpoint);
    url.searchParams.set("anno", "3");
    url.searchParams.set("client", "tee");
    url.searchParams.set("format", "html");
    url.searchParams.set("v", "1.0");
    // This public web route expects the flag to exist as `key=` even though it
    // does not use an authenticated Google API credential.
    url.searchParams.set("key", "");
    url.searchParams.set("logld", `vTE_${formatGoogleLogDate(this.now())}`);
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", targetLanguage);
    url.searchParams.set("sp", "nmt");
    url.searchParams.set("tc", String(requestSequence));
    url.searchParams.set("sr", "1");
    url.searchParams.set("tk", createGoogleWebTranslateToken(texts.join("")));
    url.searchParams.set("mode", "1");

    const body = new URLSearchParams();
    for (const text of texts) body.append("q", text);
    const response = await this.fetchGoogleWithPolicy(
      endpoint,
      url.toString(),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        body: body.toString(),
      },
      taskId,
      -1,
      1,
      Math.min(this.timeoutMs, DEFAULT_GOOGLE_BATCH_TIMEOUT_MS),
      signal,
    );
    if (!response.ok) {
      throw new TranslationServiceError(
        "PROVIDER_UNAVAILABLE",
        "Google 整批翻译暂时不可用",
        `google_array_http_${response.status}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TranslationServiceError(
        "INVALID_PROVIDER_RESPONSE",
        "Google 整批翻译返回了无效响应",
        "google_array_invalid_json",
      );
    }
    const translations = parseGoogleArrayTranslateResponse(payload, texts.length);
    return texts.map((text, index) => ({
      source_text: text,
      translated_text: translations[index]!,
      detected_source_language: null,
      target_language: targetLanguage,
      cached: false,
      provider: "google_translate_web",
    }));
  }

  private async translateGoogleBatchThroughEndpoint(
    texts: string[],
    targetLanguage: TranslationTargetLanguage,
    endpoint: string,
    taskId: string,
    providerAttempt: number,
    signal?: AbortSignal,
  ): Promise<TranslationResultItem[]> {
    const markers = createTranslationMarkers(texts);
    const combined = texts
      .map((text, index) => `${markers[index]} ${text}`)
      .join("\n");
    const url = new URL(endpoint);
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", targetLanguage);
    url.searchParams.set("dt", "t");
    const response = await this.fetchGoogleWithPolicy(
      endpoint,
      url.toString(),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        body: new URLSearchParams({ q: combined }).toString(),
      },
      taskId,
      -1,
      providerAttempt,
      Math.min(this.timeoutMs, DEFAULT_GOOGLE_BATCH_TIMEOUT_MS),
      signal,
    );
    if (!response.ok) {
      throw new TranslationServiceError(
        "PROVIDER_UNAVAILABLE",
        "Google 自动翻译暂时不可用",
        `google_batch_http_${response.status}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TranslationServiceError(
        "INVALID_PROVIDER_RESPONSE",
        "Google 自动翻译返回了无效响应",
        "google_batch_invalid_json",
      );
    }
    const parsed = parseGoogleTranslateResponse(payload);
    const translations = splitMarkedTranslations(parsed.translatedText, markers);
    return texts.map((text, index) => ({
      source_text: text,
      translated_text: translations[index]!,
      detected_source_language: parsed.detectedSourceLanguage,
      target_language: targetLanguage,
      cached: false,
      provider: "google_translate_web",
    }));
  }

  private async tryTranslateBingBatch(
    texts: string[],
    targetLanguage: TranslationTargetLanguage,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TranslationResultItem[] | null> {
    if (this.bingTranslatorPages.length === 0) return null;
    const startedAt = speedNow();
    try {
      const markers = createTranslationMarkers(texts);
      const combined = texts
        .map((text, index) => `${markers[index]} ${text}`)
        .join("\n");
      const item = await this.translateThroughBing(
        combined,
        targetLanguage,
        taskId,
        -1,
        1,
        signal,
      );
      const translations = splitMarkedTranslations(item.translated_text, markers);
      const items = texts.map((text, index) => ({
        ...item,
        source_text: text,
        translated_text: translations[index]!,
      }));
      speedLog("translation-service", taskId, "bing_batch_complete", startedAt, {
        item_count: items.length,
      });
      return items;
    } catch (error) {
      if (isCancelledTranslationError(error)) throw error;
      speedLog("translation-service", taskId, "bing_batch_attempt_failed", startedAt, {
        item_count: texts.length,
        error_name: safeErrorName(error),
      });
      return null;
    }
  }

  private async raceOnlineProviders<T>(
    googleAttempt: (signal: AbortSignal) => Promise<T | null>,
    bingAttempt: (signal: AbortSignal) => Promise<T | null>,
    externalSignal?: AbortSignal,
  ): Promise<T | null> {
    throwIfTranslationCancelled(externalSignal);
    if (
      !(this.googleTranslateHtmlEndpoint && this.googleTranslateHtmlApiKey) &&
      !this.googleArrayEndpoint &&
      this.googleEndpoints.length === 0
    ) {
      return bingAttempt(externalSignal ?? new AbortController().signal);
    }
    if (this.bingTranslatorPages.length === 0) {
      return googleAttempt(externalSignal ?? new AbortController().signal);
    }

    const googleController = new AbortController();
    const bingController = new AbortController();
    return new Promise<T | null>((resolve, reject) => {
      let settled = false;
      let failures = 0;
      let bingStarted = false;
      let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (hedgeTimer) clearTimeout(hedgeTimer);
        externalSignal?.removeEventListener("abort", cancelBoth);
      };
      const cancelBoth = (): void => {
        if (settled) return;
        settled = true;
        googleController.abort();
        bingController.abort();
        cleanup();
        reject(cancelledTranslationError("bing_web"));
      };

      const finishSuccess = (
        value: T,
        loser: AbortController,
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        loser.abort();
        resolve(value);
      };
      const finishFailure = (): void => {
        if (settled) return;
        failures += 1;
        if (failures < 2) return;
        settled = true;
        cleanup();
        resolve(null);
      };
      const startBing = (): void => {
        if (settled || bingStarted) return;
        bingStarted = true;
        void bingAttempt(bingController.signal)
          .then((value) => {
            if (value) finishSuccess(value, googleController);
            else finishFailure();
          })
          .catch(() => finishFailure());
      };

      externalSignal?.addEventListener("abort", cancelBoth, { once: true });
      if (externalSignal?.aborted) {
        cancelBoth();
        return;
      }
      hedgeTimer = setTimeout(startBing, DEFAULT_BING_HEDGE_DELAY_MS);
      void googleAttempt(googleController.signal)
        .then((value) => {
          if (value) {
            finishSuccess(value, bingController);
            return;
          }
          if (hedgeTimer) clearTimeout(hedgeTimer);
          startBing();
          finishFailure();
        })
        .catch(() => {
          if (hedgeTimer) clearTimeout(hedgeTimer);
          startBing();
          finishFailure();
        });
    });
  }

  getCacheSize(): number {
    this.removeExpiredEntries();
    return this.cache.size;
  }

  private async translateOne(
    text: string,
    targetLanguage: TranslationTargetLanguage,
    taskId: string,
    textIndex: number,
    signal?: AbortSignal,
  ): Promise<TranslationResultItem> {
    throwIfTranslationCancelled(signal);
    const cacheKey = buildCacheKey(text, targetLanguage);
    const cached = this.getCached(cacheKey);
    if (cached) {
      speedLog("translation-service", taskId, "cache_hit", undefined, {
        text_index: textIndex,
        text_characters: text.length,
      });
      return { ...cached, cached: true };
    }
    speedLog("translation-service", taskId, "cache_miss", undefined, {
      text_index: textIndex,
      text_characters: text.length,
    });

    const diagnostics: string[] = [];
    const requiredModelIds = new Set<LocalModelId>();
    const tryGoogle = async (signal: AbortSignal): Promise<TranslationResultItem | null> => {
      if (
        this.googleTranslateHtmlEndpoint &&
        this.googleTranslateHtmlApiKey &&
        !signal.aborted
      ) {
        try {
          return (
            await this.translateGoogleHtmlBatch(
              [text],
              targetLanguage,
              taskId,
              signal,
            )
          )[0] ?? null;
        } catch (error) {
          if (isCancelledTranslationError(error)) throw error;
          diagnostics.push(toDiagnostic(error, "google_html_failed"));
        }
      }
      if (this.googleArrayEndpoint && !signal.aborted) {
        try {
          return (
            await this.translateGoogleArrayThroughEndpoint(
              [text],
              targetLanguage,
              taskId,
              signal,
            )
          )[0] ?? null;
        } catch (error) {
          if (isCancelledTranslationError(error)) throw error;
          diagnostics.push(toDiagnostic(error, "google_array_failed"));
        }
      }
      for (const [index, endpoint] of this.googleEndpoints.entries()) {
        if (signal.aborted) return null;
        try {
          return await this.translateThroughGoogle(
            text,
            targetLanguage,
            endpoint,
            taskId,
            textIndex,
            index + 1,
            signal,
          );
        } catch (error) {
          if (isCancelledTranslationError(error)) throw error;
          diagnostics.push(toDiagnostic(error, `google_direct_${index + 1}_failed`));
        }
      }
      return null;
    };
    const tryBing = async (signal: AbortSignal): Promise<TranslationResultItem | null> => {
      if (this.bingTranslatorPages.length === 0) return null;
      if (signal.aborted) return null;
      try {
        return await this.translateThroughBing(
          text,
          targetLanguage,
          taskId,
          textIndex,
          1,
          signal,
        );
      } catch (error) {
        if (isCancelledTranslationError(error)) throw error;
        diagnostics.push(toDiagnostic(error, "bing_web_failed"));
        return null;
      }
    };
    const tryLocalBackends = async (): Promise<TranslationResultItem | null> => {
      for (const [index, endpoint] of this.localFallbackEndpoints.entries()) {
        throwIfTranslationCancelled(signal);
        try {
          return await this.translateThroughLocalBackend(
            text,
            targetLanguage,
            endpoint,
            taskId,
            textIndex,
            index + 1,
            signal,
          );
        } catch (error) {
          if (isCancelledTranslationError(error)) throw error;
          if (error instanceof TranslationServiceError && error.code === "LOCAL_MODEL_REQUIRED") {
            for (const modelId of error.requiredModelIds) requiredModelIds.add(modelId);
          }
          diagnostics.push(toDiagnostic(error, `local_backend_${index + 1}_failed`));
        }
      }
      return null;
    };

    const tryOnlineProviders = () => this.raceOnlineProviders(tryGoogle, tryBing, signal);
    const item = this.preferLocalBackend
      ? (await tryLocalBackends()) ?? (await tryOnlineProviders())
      : (await tryOnlineProviders()) ?? (await tryLocalBackends());
    if (item) {
      this.setCached(cacheKey, item);
      return item;
    }

    throw new TranslationServiceError(
      requiredModelIds.size ? "LOCAL_MODEL_REQUIRED" : "PROVIDER_UNAVAILABLE",
      requiredModelIds.size
        ? "在线翻译暂时不可用，可选择下载本地翻译模型后重试"
        : this.localFallbackEndpoints.length
          ? "自动翻译暂时不可用，请检查网络或本地后端后重试"
          : "在线翻译暂时不可用，请检查网络后重试",
      diagnostics.join(";"),
      [...requiredModelIds],
    );
  }

  private async translateThroughGoogle(
    text: string,
    targetLanguage: TranslationTargetLanguage,
    endpoint: string,
    taskId: string,
    textIndex: number,
    providerAttempt: number,
    signal?: AbortSignal,
  ): Promise<TranslationResultItem> {
    const url = new URL(endpoint);
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", targetLanguage);
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", text);
    const response = await this.fetchGoogleWithPolicy(
      endpoint,
      url.toString(),
      {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      },
      taskId,
      textIndex,
      providerAttempt,
      Math.min(this.timeoutMs, DEFAULT_GOOGLE_DIRECT_TIMEOUT_MS),
      signal,
    );
    if (!response.ok) {
      throw new TranslationServiceError(
        "PROVIDER_UNAVAILABLE",
        "Google 自动翻译暂时不可用",
        `google_direct_http_${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TranslationServiceError(
        "INVALID_PROVIDER_RESPONSE",
        "Google 自动翻译返回了无效响应",
        "google_direct_invalid_json",
      );
    }
    const parsed = parseGoogleTranslateResponse(payload);
    return {
      source_text: text,
      translated_text: parsed.translatedText,
      detected_source_language: parsed.detectedSourceLanguage,
      target_language: targetLanguage,
      cached: false,
      provider: "google_translate_web",
    };
  }

  private async translateThroughBing(
    text: string,
    targetLanguage: TranslationTargetLanguage,
    taskId: string,
    textIndex: number,
    providerAttempt: number,
    signal?: AbortSignal,
  ): Promise<TranslationResultItem> {
    let lastError: unknown;
    for (let credentialAttempt = 0; credentialAttempt < 2; credentialAttempt += 1) {
      if (signal?.aborted) {
        throw cancelledTranslationError("bing_web");
      }
      const bootstrap = await this.getBingBootstrap(taskId);
      if (signal?.aborted) {
        throw cancelledTranslationError("bing_web");
      }
      const endpoint = new URL("/ttranslatev3", bootstrap.origin);
      endpoint.searchParams.set("isVertical", "1");
      endpoint.searchParams.set("IG", bootstrap.ig);
      endpoint.searchParams.set(
        "IID",
        `${bootstrap.iid}.${++this.bingRequestSequence}`,
      );
      const body = new URLSearchParams({
        fromLang: "auto-detect",
        text,
        to: toBingTargetLanguage(targetLanguage),
        token: bootstrap.token,
        key: bootstrap.key,
      });
      try {
        const response = await this.fetchBingWithPolicy(
          endpoint.origin + endpoint.pathname,
          endpoint.toString(),
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            },
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            body: body.toString(),
          },
          taskId,
          textIndex,
          providerAttempt,
          signal,
        );
        if (!response.ok) {
          const error = new TranslationServiceError(
            "PROVIDER_UNAVAILABLE",
            "Bing 自动翻译暂时不可用",
            `bing_web_http_${response.status}`,
          );
          if (
            credentialAttempt === 0 &&
            (response.status === 400 || response.status === 401 || response.status === 403)
          ) {
            await this.invalidateBingBootstrap(bootstrap);
            lastError = error;
            continue;
          }
          throw error;
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new TranslationServiceError(
            "INVALID_PROVIDER_RESPONSE",
            "Bing 自动翻译返回了无效响应",
            "bing_web_invalid_json",
          );
        }
        const parsed = parseBingTranslateResponse(payload);
        return {
          source_text: text,
          translated_text: parsed.translatedText,
          detected_source_language: parsed.detectedSourceLanguage,
          target_language: targetLanguage,
          cached: false,
          provider: "bing_translate_web",
        };
      } catch (error) {
        lastError = error;
        const refreshable =
          error instanceof TranslationServiceError &&
          error.code === "INVALID_PROVIDER_RESPONSE";
        if (credentialAttempt === 0 && refreshable) {
          await this.invalidateBingBootstrap(bootstrap);
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new TranslationServiceError(
          "PROVIDER_UNAVAILABLE",
          "Bing 自动翻译暂时不可用",
          "bing_web_failed",
        );
  }

  private async getBingBootstrap(taskId: string): Promise<BingTranslatorBootstrap> {
    const cached = this.bingBootstrap;
    if (cached && cached.expiresAt > this.now()) return cached;
    if (this.bingBootstrapLoad) return this.bingBootstrapLoad;
    const load = this.restoreOrLoadBingBootstrap(taskId);
    this.bingBootstrapLoad = load;
    try {
      const bootstrap = await load;
      this.bingBootstrap = bootstrap;
      return bootstrap;
    } finally {
      if (this.bingBootstrapLoad === load) this.bingBootstrapLoad = null;
    }
  }

  private async restoreOrLoadBingBootstrap(
    taskId: string,
  ): Promise<BingTranslatorBootstrap> {
    if (this.bingBootstrapStore) {
      try {
        const stored = await this.bingBootstrapStore.load();
        const restored = normalizeStoredBingBootstrap(stored, this.now());
        if (restored) return restored;
        if (stored !== undefined && stored !== null) {
          await this.bingBootstrapStore.clear().catch(() => undefined);
        }
      } catch {
        // Session storage is an optimization only; a storage failure must not
        // make the live anonymous Bing request unavailable.
      }
    }
    const bootstrap = await this.loadBingBootstrap(taskId);
    if (this.bingBootstrapStore) {
      await this.bingBootstrapStore.save(bootstrap).catch(() => undefined);
    }
    return bootstrap;
  }

  private async loadBingBootstrap(taskId: string): Promise<BingTranslatorBootstrap> {
    const diagnostics: string[] = [];
    for (const [index, page] of this.bingTranslatorPages.entries()) {
      try {
        const response = await this.fetchWithTimeout(
          page,
          {
            method: "GET",
            headers: { Accept: "text/html,application/xhtml+xml" },
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
          },
          "bing_web",
          taskId,
          -1,
          index + 1,
          Math.min(this.timeoutMs, DEFAULT_BING_BOOTSTRAP_TIMEOUT_MS),
        );
        if (!response.ok) {
          throw new TranslationServiceError(
            "PROVIDER_UNAVAILABLE",
            "无法初始化 Bing 自动翻译",
            `bing_bootstrap_http_${response.status}`,
          );
        }
        const html = await response.text();
        return parseBingTranslatorBootstrap(
          html,
          response.url || page,
          this.now(),
        );
      } catch (error) {
        diagnostics.push(toDiagnostic(error, `bing_bootstrap_${index + 1}_failed`));
      }
    }
    throw new TranslationServiceError(
      "PROVIDER_UNAVAILABLE",
      "无法初始化 Bing 自动翻译",
      diagnostics.join(";") || "bing_bootstrap_unavailable",
    );
  }

  private async invalidateBingBootstrap(
    bootstrap: BingTranslatorBootstrap,
  ): Promise<void> {
    if (this.bingBootstrap === bootstrap) this.bingBootstrap = null;
    if (this.bingBootstrapStore) {
      await this.bingBootstrapStore.clear().catch(() => undefined);
    }
  }

  private async translateThroughLocalBackend(
    text: string,
    targetLanguage: TranslationTargetLanguage,
    endpoint: string,
    taskId: string,
    textIndex: number,
    providerAttempt: number,
    signal?: AbortSignal,
  ): Promise<TranslationResultItem> {
    const requestInit: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      body: JSON.stringify({ text, target_language: targetLanguage }),
    };
    const response = await this.fetchWithTimeout(
      endpoint,
      requestInit,
      "local_backend",
      taskId,
      textIndex,
      providerAttempt,
      this.timeoutMs,
      signal,
    );
    if (!response.ok) {
      const backendError = await readSafeBackendError(response);
      if (backendError.code === "MODEL_REQUIRED" || backendError.code === "LOCAL_MODEL_REQUIRED") {
        throw new TranslationServiceError(
          "LOCAL_MODEL_REQUIRED",
          backendError.message ?? "在线翻译暂时不可用，可选择下载本地翻译模型后重试",
          `local_backend_http_${response.status}:LOCAL_MODEL_REQUIRED`,
          backendError.modelIds,
        );
      }
      throw new TranslationServiceError(
        "PROVIDER_UNAVAILABLE",
        `本地翻译服务处理失败（HTTP ${response.status}）`,
        `local_backend_http_${response.status}${backendError.message ? `:${backendError.message}` : ""}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TranslationServiceError(
        "INVALID_PROVIDER_RESPONSE",
        "本地翻译服务返回了无效响应",
        "local_backend_invalid_json",
      );
    }
    if (!isRecord(payload) || typeof payload.translated_text !== "string" || !payload.translated_text.trim()) {
      throw new TranslationServiceError(
        "INVALID_PROVIDER_RESPONSE",
        "本地翻译服务未返回有效译文",
        "local_backend_missing_translated_text",
      );
    }
    if (typeof payload.target_language === "string" && payload.target_language !== targetLanguage) {
      throw new TranslationServiceError(
        "INVALID_PROVIDER_RESPONSE",
        "本地翻译服务返回了错误的目标语言",
        "local_backend_target_language_mismatch",
      );
    }
    return {
      source_text: text,
      translated_text: payload.translated_text.trim(),
      detected_source_language:
        typeof payload.detected_source_language === "string"
          ? payload.detected_source_language
          : null,
      target_language: targetLanguage,
      cached: false,
      ...(payload.provider === "google_translate_web" ||
        payload.provider === "bing_translate_web" ||
        payload.provider === "argos_local"
        ? { provider: payload.provider }
        : {}),
    };
  }

  private async fetchGoogleWithPolicy(
    endpoint: string,
    input: string,
    init: RequestInit,
    taskId: string,
    textIndex: number,
    providerAttempt: number,
    timeoutMs = this.timeoutMs,
    signal?: AbortSignal,
  ): Promise<Response> {
    await this.ensureGoogleCooldownsLoaded();
    this.assertGoogleEndpointAvailable(endpoint, taskId, textIndex, providerAttempt);
    return this.withGooglePermit(async () => {
      // A queued request may have been waiting when another request received a
      // 429. Check again after acquiring the shared permit so the queue does
      // not continue draining into an endpoint that has just rejected us.
      this.assertGoogleEndpointAvailable(endpoint, taskId, textIndex, providerAttempt);
      try {
        const response = await this.fetchWithTimeout(
          input,
          init,
          "google_direct",
          taskId,
          textIndex,
          providerAttempt,
          timeoutMs,
          signal,
        );
        if (response.status === 429) {
          await this.rememberGoogleCooldown(
            endpoint,
            "rate_limit",
            parseRetryAfterMs(response.headers.get("Retry-After"), this.now()),
          );
        } else if (response.status >= 500) {
          await this.rememberGoogleCooldown(
            endpoint,
            "transport",
            DEFAULT_GOOGLE_TRANSPORT_COOLDOWN_MS,
          );
        } else if (response.ok) {
          await this.clearGoogleCooldown(endpoint);
        }
        return response;
      } catch (error) {
        if (isGoogleTransportError(error)) {
          await this.rememberGoogleCooldown(
            endpoint,
            "transport",
            DEFAULT_GOOGLE_TRANSPORT_COOLDOWN_MS,
          );
        }
        throw error;
      }
    });
  }

  private async fetchBingWithPolicy(
    endpoint: string,
    input: string,
    init: RequestInit,
    taskId: string,
    textIndex: number,
    providerAttempt: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    await this.ensureGoogleCooldownsLoaded();
    this.assertBingEndpointAvailable(endpoint, taskId, textIndex, providerAttempt);
    return this.withGooglePermit(async () => {
      this.assertBingEndpointAvailable(endpoint, taskId, textIndex, providerAttempt);
      try {
        const response = await this.fetchWithTimeout(
          input,
          init,
          "bing_web",
          taskId,
          textIndex,
          providerAttempt,
          Math.min(this.timeoutMs, DEFAULT_BING_TRANSLATION_TIMEOUT_MS),
          signal,
        );
        if (response.status === 429) {
          await this.rememberGoogleCooldown(
            endpoint,
            "rate_limit",
            parseRetryAfterMs(response.headers.get("Retry-After"), this.now()),
          );
        } else if (response.status >= 500) {
          await this.rememberGoogleCooldown(
            endpoint,
            "transport",
            DEFAULT_BING_TRANSPORT_COOLDOWN_MS,
          );
        } else if (response.ok) {
          await this.clearGoogleCooldown(endpoint);
        }
        return response;
      } catch (error) {
        if (isBingTransportError(error)) {
          await this.rememberGoogleCooldown(
            endpoint,
            "transport",
            DEFAULT_BING_TRANSPORT_COOLDOWN_MS,
          );
        }
        throw error;
      }
    });
  }

  private async withGooglePermit<T>(operation: () => Promise<T>): Promise<T> {
    if (
      this.activeGoogleRequests < this.maxConcurrentRequests &&
      this.googlePermitQueue.length === 0
    ) {
      this.activeGoogleRequests += 1;
    } else {
      await new Promise<void>((resolve) => {
        this.googlePermitQueue.push(resolve);
      });
    }
    try {
      return await operation();
    } finally {
      const next = this.googlePermitQueue.shift();
      if (next) next();
      else this.activeGoogleRequests = Math.max(0, this.activeGoogleRequests - 1);
    }
  }

  private assertGoogleEndpointAvailable(
    endpoint: string,
    taskId: string,
    textIndex: number,
    providerAttempt: number,
  ): void {
    const cooldown = this.googleCooldowns.get(googleCooldownKey(endpoint));
    const remainingMs = cooldown ? cooldown.until - this.now() : 0;
    if (remainingMs <= 0) return;
    speedLog("translation-service", taskId, "google_cooldown_skip", undefined, {
      provider_attempt: providerAttempt,
      text_index: textIndex,
      cooldown_reason: cooldown?.reason,
      remaining_ms: remainingMs,
    });
    throw new TranslationServiceError(
      "PROVIDER_UNAVAILABLE",
      cooldown?.reason === "rate_limit"
        ? "Google 自动翻译请求过于频繁，请稍后重试"
        : "Google 自动翻译连接暂时不可用，请稍后重试",
      cooldown?.reason === "rate_limit"
        ? "google_direct_rate_limit_cooldown"
        : "google_direct_transport_cooldown",
    );
  }

  private assertBingEndpointAvailable(
    endpoint: string,
    taskId: string,
    textIndex: number,
    providerAttempt: number,
  ): void {
    const cooldown = this.googleCooldowns.get(googleCooldownKey(endpoint));
    const remainingMs = cooldown ? cooldown.until - this.now() : 0;
    if (remainingMs <= 0) return;
    speedLog("translation-service", taskId, "bing_cooldown_skip", undefined, {
      provider_attempt: providerAttempt,
      text_index: textIndex,
      cooldown_reason: cooldown?.reason,
      remaining_ms: remainingMs,
    });
    throw new TranslationServiceError(
      "PROVIDER_UNAVAILABLE",
      cooldown?.reason === "rate_limit"
        ? "Bing 自动翻译请求过于频繁，请稍后重试"
        : "Bing 自动翻译连接暂时不可用，请稍后重试",
      cooldown?.reason === "rate_limit"
        ? "bing_web_rate_limit_cooldown"
        : "bing_web_transport_cooldown",
    );
  }

  private async rememberGoogleCooldown(
    endpoint: string,
    reason: StoredGoogleCooldown["reason"],
    requestedDurationMs: number | null,
  ): Promise<void> {
    const now = this.now();
    const key = googleCooldownKey(endpoint);
    const previous = this.googleCooldowns.get(key);
    const recentRateLimit =
      reason === "rate_limit" &&
      previous?.reason === "rate_limit" &&
      now - previous.last_failure_at < 60 * 60_000;
    const failureCount = recentRateLimit ? previous.failure_count + 1 : 1;
    const exponentialDuration = Math.min(
      MAX_GOOGLE_RATE_LIMIT_COOLDOWN_MS,
      DEFAULT_GOOGLE_RATE_LIMIT_COOLDOWN_MS * 2 ** Math.min(4, failureCount - 1),
    );
    const duration = reason === "rate_limit"
      ? Math.min(
          MAX_GOOGLE_RETRY_AFTER_MS,
          requestedDurationMs ?? exponentialDuration,
        )
      : requestedDurationMs ?? DEFAULT_GOOGLE_TRANSPORT_COOLDOWN_MS;
    this.googleCooldowns.set(key, {
      until: now + Math.max(1_000, duration),
      failure_count: failureCount,
      last_failure_at: now,
      reason,
    });
    await this.persistGoogleCooldowns();
  }

  private async clearGoogleCooldown(endpoint: string): Promise<void> {
    if (!this.googleCooldowns.delete(googleCooldownKey(endpoint))) return;
    await this.persistGoogleCooldowns();
  }

  private async ensureGoogleCooldownsLoaded(): Promise<void> {
    if (!this.cooldownStore) return;
    if (!this.cooldownLoad) {
      this.cooldownLoad = (async () => {
        try {
          const stored = await this.cooldownStore!.load();
          for (const [key, value] of Object.entries(
            normalizeStoredGoogleCooldowns(stored, this.now()),
          )) {
            const current = this.googleCooldowns.get(key);
            if (!current || current.last_failure_at < value.last_failure_at) {
              this.googleCooldowns.set(key, value);
            }
          }
        } catch {
          // A storage failure must never make translation itself unavailable.
        }
      })();
    }
    await this.cooldownLoad;
  }

  private async persistGoogleCooldowns(): Promise<void> {
    if (!this.cooldownStore) return;
    const snapshot = Object.fromEntries(this.googleCooldowns);
    this.cooldownWrite = this.cooldownWrite
      .catch(() => undefined)
      .then(() => this.cooldownStore!.save(snapshot))
      .catch(() => undefined);
    await this.cooldownWrite;
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
    provider: "google_direct" | "bing_web" | "local_backend",
    taskId: string,
    textIndex: number,
    providerAttempt: number,
    timeoutMs = this.timeoutMs,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const startedAt = speedNow();
    const controller = new AbortController();
    const abortFromExternal = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(input, { ...init, signal: controller.signal });
      speedLog("translation-service", taskId, "network_complete", startedAt, {
        provider,
        provider_attempt: providerAttempt,
        text_index: textIndex,
        status: response.status,
        ok: response.ok,
      });
      return response;
    } catch (error) {
      if (controller.signal.aborted) {
        if (externalSignal?.aborted) {
          throw cancelledTranslationError(provider);
        }
        speedLog("translation-service", taskId, "network_complete", startedAt, {
          provider,
          provider_attempt: providerAttempt,
          text_index: textIndex,
          ok: false,
          timeout: true,
        });
        throw new TranslationServiceError(
          "REQUEST_TIMEOUT",
          provider === "google_direct"
            ? "Google 自动翻译请求超时"
            : provider === "bing_web"
              ? "Bing 自动翻译请求超时"
              : "连接本地翻译服务超时",
          `${provider}_timeout`,
        );
      }
      if (error instanceof TranslationServiceError) throw error;
      speedLog("translation-service", taskId, "network_complete", startedAt, {
        provider,
        provider_attempt: providerAttempt,
        text_index: textIndex,
        ok: false,
        timeout: false,
        error_name: safeErrorName(error),
      });
      throw new TranslationServiceError(
        "PROVIDER_UNAVAILABLE",
        provider === "google_direct"
          ? "无法连接 Google 自动翻译"
          : provider === "bing_web"
            ? "无法连接 Bing 自动翻译"
            : "无法连接本地翻译服务",
        `${provider}_fetch_failed:${safeErrorName(error)}`,
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  }

  private getCached(text: string): TranslationResultItem | null {
    const entry = this.cache.get(text);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(text);
      return null;
    }
    this.cache.delete(text);
    this.cache.set(text, entry);
    return entry.item;
  }

  private setCached(text: string, item: TranslationResultItem): void {
    this.removeExpiredEntries();
    this.cache.delete(text);
    this.cache.set(text, { item: { ...item, cached: false }, expiresAt: this.now() + this.cacheTtlMs });
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private removeExpiredEntries(): void {
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}

export function isTranslationRequest(value: unknown): value is TranslationRequest {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "TRANSLATE_PUBLIC_TEXT" || type === "TRANSLATE_PUBLIC_TEXT_BATCH";
}

export function buildGoogleTranslateFallbackUrl(
  text: string,
  targetLanguage: TranslationTargetLanguage = TRANSLATION_TARGET_LANGUAGE,
): string {
  const url = new URL("https://translate.google.com/");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", targetLanguage);
  url.searchParams.set("text", text);
  url.searchParams.set("op", "translate");
  return url.toString();
}

export function parseGoogleTranslateResponse(payload: unknown): {
  translatedText: string;
  detectedSourceLanguage: string | null;
} {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    throw new TranslationServiceError(
      "INVALID_PROVIDER_RESPONSE",
      "Google 自动翻译返回了无法识别的内容",
      "google_direct_invalid_shape",
    );
  }
  const translatedText = payload[0]
    .map((segment) =>
      Array.isArray(segment) && typeof segment[0] === "string" ? segment[0] : "",
    )
    .join("")
    .trim();
  if (!translatedText) {
    throw new TranslationServiceError(
      "INVALID_PROVIDER_RESPONSE",
      "Google 自动翻译未返回有效译文",
      "google_direct_missing_translated_text",
    );
  }
  return {
    translatedText,
    detectedSourceLanguage: typeof payload[2] === "string" ? payload[2] : null,
  };
}

export function parseGoogleArrayTranslateResponse(
  payload: unknown,
  expectedCount: number,
): string[] {
  const entries = typeof payload === "string"
    ? [payload]
    : Array.isArray(payload)
      ? payload
      : [];
  const translations = entries.map((entry) => {
    const value = typeof entry === "string"
      ? entry
      : Array.isArray(entry) && typeof entry[0] === "string"
        ? entry[0]
        : "";
    return value
      .replace(/<i>[\s\S]*?<\/i>/gi, "")
      .replace(/<\/?b>/gi, "")
      .trim();
  });
  if (
    expectedCount < 1 ||
    translations.length !== expectedCount ||
    translations.some((translation) => !translation)
  ) {
    throw new TranslationServiceError(
      "INVALID_PROVIDER_RESPONSE",
      "Google 整批翻译返回的结果数量不完整",
      "google_array_invalid_shape",
    );
  }
  return translations;
}

export function parseGoogleTranslateHtmlResponse(
  payload: unknown,
  expectedCount: number,
): string[] {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new TranslationServiceError(
      "INVALID_PROVIDER_RESPONSE",
      "Google 快速整批翻译返回了无法识别的内容",
      "google_html_invalid_shape",
    );
  }
  return parseGoogleArrayTranslateResponse(payload[0], expectedCount);
}

export function createGoogleWebTranslateToken(
  text: string,
  tkk = "446379.1364508470",
): string {
  const [seedText = "0", xorText = "0"] = tkk.split(".");
  const seed = Number(seedText) || 0;
  const xor = Number(xorText) || 0;
  const bytes = new TextEncoder().encode(text);
  let value = seed;
  for (const byte of bytes) {
    value += byte;
    value = mixGoogleToken(value, "+-a^+6");
  }
  value = mixGoogleToken(value, "+-3^+b+-f");
  value ^= xor;
  if (value < 0) value = (value & 0x7fffffff) + 0x80000000;
  value %= 1_000_000;
  return `${value}.${value ^ seed}`;
}

export function parseBingTranslateResponse(payload: unknown): {
  translatedText: string;
  detectedSourceLanguage: string | null;
} {
  if (!Array.isArray(payload) || !isRecord(payload[0])) {
    throw new TranslationServiceError(
      "INVALID_PROVIDER_RESPONSE",
      "Bing 自动翻译返回了无法识别的内容",
      "bing_web_invalid_shape",
    );
  }
  const translations = payload[0].translations;
  const firstTranslation =
    Array.isArray(translations) && isRecord(translations[0])
      ? translations[0]
      : null;
  const translatedText =
    firstTranslation && typeof firstTranslation.text === "string"
      ? firstTranslation.text.trim()
      : "";
  if (!translatedText) {
    throw new TranslationServiceError(
      "INVALID_PROVIDER_RESPONSE",
      "Bing 自动翻译未返回有效译文",
      "bing_web_missing_translated_text",
    );
  }
  const detectedLanguage = payload[0].detectedLanguage;
  return {
    translatedText,
    detectedSourceLanguage:
      isRecord(detectedLanguage) && typeof detectedLanguage.language === "string"
        ? detectedLanguage.language
        : null,
  };
}

export function parseBingTranslatorBootstrap(
  html: string,
  pageUrl: string,
  now: number,
): BingTranslatorBootstrap {
  const page = new URL(pageUrl);
  if (page.protocol !== "https:" || !isBingHostname(page.hostname)) {
    throw new TranslationServiceError(
      "INVALID_PROVIDER_RESPONSE",
      "Bing 自动翻译初始化地址无效",
      "bing_bootstrap_invalid_origin",
    );
  }
  const ig = html.match(/\bIG\s*:\s*["']([A-Fa-f0-9]{16,})["']/)?.[1] ?? "";
  const iid = html.match(/\bdata-iid\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
  const abuse = html.match(
    /params_AbusePreventionHelper\s*=\s*\[\s*([0-9]+)\s*,\s*["']([^"']+)["']\s*,\s*([0-9]+)\s*\]/,
  );
  if (!ig || !iid || !abuse?.[1] || !abuse[2]) {
    throw new TranslationServiceError(
      "INVALID_PROVIDER_RESPONSE",
      "Bing 自动翻译初始化信息不完整",
      "bing_bootstrap_missing_fields",
    );
  }
  const advertisedTtl = Number(abuse[3]);
  const ttl = Number.isFinite(advertisedTtl)
    ? Math.min(
        DEFAULT_BING_BOOTSTRAP_TTL_MS,
        Math.max(60_000, advertisedTtl - 60_000),
      )
    : DEFAULT_BING_BOOTSTRAP_TTL_MS;
  return {
    origin: page.origin,
    ig,
    iid,
    key: abuse[1],
    token: abuse[2],
    expiresAt: now + ttl,
  };
}

export function normalizeStoredBingBootstrap(
  value: unknown,
  now: number,
): BingTranslatorBootstrap | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.origin !== "string" ||
    typeof value.ig !== "string" ||
    typeof value.iid !== "string" ||
    typeof value.key !== "string" ||
    typeof value.token !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt)
  ) {
    return null;
  }
  let origin: URL;
  try {
    origin = new URL(value.origin);
  } catch {
    return null;
  }
  if (
    origin.origin !== value.origin ||
    origin.protocol !== "https:" ||
    !isBingHostname(origin.hostname) ||
    !/^[A-Fa-f0-9]{16,64}$/.test(value.ig) ||
    !/^[A-Za-z0-9._-]{3,80}$/.test(value.iid) ||
    !/^[0-9]{6,30}$/.test(value.key) ||
    value.token.length < 8 ||
    value.token.length > 1_024 ||
    /[\s\u0000-\u001f\u007f]/.test(value.token) ||
    value.expiresAt <= now + 5_000 ||
    value.expiresAt > now + 2 * 60 * 60_000
  ) {
    return null;
  }
  return {
    origin: origin.origin,
    ig: value.ig,
    iid: value.iid,
    key: value.key,
    token: value.token,
    expiresAt: value.expiresAt,
  };
}

function createTranslationMarkers(texts: readonly string[]): string[] {
  let left = "\uE000";
  let right = "\uE001";
  while (texts.some((text) => text.includes(left) || text.includes(right))) {
    left += "\uE000";
    right += "\uE001";
  }
  return texts.map((_, index) => `${left}${String(index).padStart(4, "0")}${right}`);
}

function splitMarkedTranslations(value: string, markers: readonly string[]): string[] {
  const translations: string[] = [];
  let cursor = 0;
  for (const [index, marker] of markers.entries()) {
    const markerPosition = value.indexOf(marker, cursor);
    if (markerPosition < cursor) {
      throw new TranslationServiceError(
        "INVALID_PROVIDER_RESPONSE",
        "批量翻译结果无法与原文逐句对应",
        "google_batch_marker_missing",
      );
    }
    const textStart = markerPosition + marker.length;
    const nextMarker = markers[index + 1];
    const textEnd = nextMarker ? value.indexOf(nextMarker, textStart) : value.length;
    if (textEnd < textStart) {
      throw new TranslationServiceError(
        "INVALID_PROVIDER_RESPONSE",
        "批量翻译结果顺序异常",
        "google_batch_marker_order",
      );
    }
    const translated = value.slice(textStart, textEnd).trim();
    if (!translated) {
      throw new TranslationServiceError(
        "INVALID_PROVIDER_RESPONSE",
        "批量翻译结果存在空句",
        "google_batch_empty_item",
      );
    }
    translations.push(translated);
    cursor = textEnd;
  }
  if (translations.length !== markers.length) {
    throw new TranslationServiceError(
      "INVALID_PROVIDER_RESPONSE",
      "批量翻译结果数量不完整",
      "google_batch_incomplete",
    );
  }
  return translations;
}

function normalizeTargetLanguage(value: unknown): TranslationTargetLanguage {
  const targetLanguage = value ?? TRANSLATION_TARGET_LANGUAGE;
  if (
    typeof targetLanguage !== "string" ||
    !(SUPPORTED_TRANSLATION_TARGET_LANGUAGES as readonly string[]).includes(targetLanguage)
  ) {
    throw new TranslationServiceError("INVALID_REQUEST", "不支持该目标语言");
  }
  return targetLanguage as TranslationTargetLanguage;
}

function normalizeProvider(value: unknown): TranslationProviderMode {
  const provider = value ?? "standard";
  if (provider !== "standard" && provider !== "deepseek_expert") {
    throw new TranslationServiceError("INVALID_REQUEST", "不支持该翻译模式");
  }
  return provider;
}

function normalizeLocalEndpoints(endpoints: readonly string[]): readonly string[] {
  const allowed = new Set<string>([
    ...LOCAL_TRANSLATION_ENDPOINTS,
    LOCAL_GOOGLE_TRANSLATION_ENDPOINT,
    LOCAL_GOOGLE_TRANSLATION_FALLBACK_ENDPOINT,
  ]);
  const normalized = [...new Set(endpoints)].filter((endpoint) => allowed.has(endpoint));
  if (normalized.length === 0 && endpoints.length > 0) {
    // Tests may inject a same-origin mock endpoint; production defaults stay pinned above.
    return [...new Set(endpoints)];
  }
  return normalized;
}

function normalizeGoogleEndpoints(endpoints: readonly string[]): readonly string[] {
  if (endpoints.length === 0) return [];
  const allowed = new Set<string>(GOOGLE_TRANSLATION_ENDPOINTS);
  const normalized = [...new Set(endpoints)].filter((endpoint) => {
    if (allowed.has(endpoint)) return true;
    try {
      return new URL(endpoint).protocol === "https:";
    } catch {
      return false;
    }
  });
  return normalized.length ? normalized : [...GOOGLE_TRANSLATION_ENDPOINTS];
}

function normalizeGoogleArrayEndpoint(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return url.origin === "https://translate.googleapis.com" &&
      url.pathname === "/translate_a/t"
      ? `${url.origin}${url.pathname}`
      : null;
  } catch {
    return null;
  }
}

function normalizeGoogleTranslateHtmlEndpoint(
  endpoint: string | null | undefined,
): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return url.origin === "https://translate-pa.googleapis.com" &&
      url.pathname === "/v1/translateHtml"
      ? `${url.origin}${url.pathname}`
      : null;
  } catch {
    return null;
  }
}

function normalizeGoogleTranslateHtmlApiKey(
  apiKey: string | null | undefined,
): string | null {
  if (!apiKey) return null;
  const normalized = apiKey.trim();
  return /^AIza[0-9A-Za-z_-]{30,50}$/.test(normalized) ? normalized : null;
}

function formatGoogleLogDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
}

function mixGoogleToken(value: number, pattern: string): number {
  for (let index = 0; index < pattern.length - 2; index += 3) {
    const character = pattern[index + 2]!;
    const shift = character >= "a"
      ? character.charCodeAt(0) - 87
      : Number(character);
    const shifted = pattern[index + 1] === "+"
      ? value >>> shift
      : value << shift;
    value = pattern[index] === "+"
      ? (value + shifted) & 0xffffffff
      : value ^ shifted;
  }
  return value;
}

function normalizeBingTranslatorPages(endpoints: readonly string[]): readonly string[] {
  return [...new Set(endpoints)].filter((endpoint) => {
    try {
      const url = new URL(endpoint);
      return url.protocol === "https:" && isBingHostname(url.hostname);
    } catch {
      return false;
    }
  });
}

function preferFastGoogleBatchEndpoint(endpoints: readonly string[]): readonly string[] {
  if (!endpoints.includes(GOOGLE_TRANSLATION_ENDPOINT)) return endpoints;
  return [
    GOOGLE_TRANSLATION_ENDPOINT,
    ...endpoints.filter((endpoint) => endpoint !== GOOGLE_TRANSLATION_ENDPOINT),
  ];
}

function buildCacheKey(text: string, targetLanguage: TranslationTargetLanguage): string {
  return `${targetLanguage}\u0000${text}`;
}

function buildInFlightTranslationKey(
  texts: readonly string[],
  targetLanguage: TranslationTargetLanguage,
): string {
  return JSON.stringify([targetLanguage, texts]);
}

function googleCooldownKey(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}${url.pathname}`;
}

function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - now);
}

function isGoogleTransportError(error: unknown): boolean {
  if (!(error instanceof TranslationServiceError)) return false;
  return error.diagnostic === "google_direct_timeout" ||
    error.diagnostic?.startsWith("google_direct_fetch_failed:") === true;
}

function isBingTransportError(error: unknown): boolean {
  if (!(error instanceof TranslationServiceError)) return false;
  return error.diagnostic === "bing_web_timeout" ||
    error.diagnostic?.startsWith("bing_web_fetch_failed:") === true;
}

function cancelledTranslationError(
  provider: "google_direct" | "bing_web" | "local_backend",
): TranslationServiceError {
  return new TranslationServiceError(
    "PROVIDER_UNAVAILABLE",
    "已使用更快的翻译通道",
    `${provider}_cancelled`,
  );
}

function isCancelledTranslationError(error: unknown): boolean {
  return error instanceof TranslationServiceError &&
    error.diagnostic?.endsWith("_cancelled") === true;
}

function throwIfTranslationCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledTranslationError("bing_web");
}

function isBingHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "bing.com" || normalized.endsWith(".bing.com");
}

function toBingTargetLanguage(
  targetLanguage: TranslationTargetLanguage,
): string {
  if (targetLanguage === "zh-CN") return "zh-Hans";
  if (targetLanguage === "zh-TW") return "zh-Hant";
  return targetLanguage;
}

function normalizeStoredGoogleCooldowns(
  value: unknown,
  now: number,
): Record<string, StoredGoogleCooldown> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, StoredGoogleCooldown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isAllowedCooldownKey(key) || !isRecord(entry)) continue;
    if (
      typeof entry.until !== "number" ||
      !Number.isFinite(entry.until) ||
      typeof entry.failure_count !== "number" ||
      !Number.isInteger(entry.failure_count) ||
      entry.failure_count < 1 ||
      typeof entry.last_failure_at !== "number" ||
      !Number.isFinite(entry.last_failure_at) ||
      (entry.reason !== "rate_limit" && entry.reason !== "transport")
    ) {
      continue;
    }
    normalized[key] = {
      until: Math.min(entry.until, now + MAX_GOOGLE_RETRY_AFTER_MS),
      failure_count: Math.min(entry.failure_count, 100),
      last_failure_at: Math.min(entry.last_failure_at, now),
      reason: entry.reason,
    };
  }
  return normalized;
}

function isAllowedCooldownKey(key: string): boolean {
  if (
    [
      ...GOOGLE_TRANSLATION_ENDPOINTS,
      GOOGLE_TRANSLATION_ARRAY_ENDPOINT,
      GOOGLE_TRANSLATE_HTML_ENDPOINT,
    ].map(googleCooldownKey).includes(key)
  ) return true;
  try {
    const url = new URL(key);
    return url.protocol === "https:" &&
      isBingHostname(url.hostname) &&
      url.pathname === "/ttranslatev3";
  } catch {
    return false;
  }
}

function toDiagnostic(error: unknown, fallback: string): string {
  if (error instanceof TranslationServiceError && error.diagnostic) return error.diagnostic;
  return `${fallback}:${safeErrorName(error)}`;
}

function validateTexts(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.some((text) => typeof text !== "string")) {
    throw new TranslationServiceError("INVALID_REQUEST", "请提供需要翻译的公开文本");
  }
  if (input.length > MAX_TRANSLATION_BATCH_SIZE) {
    throw new TranslationServiceError(
      "BATCH_TOO_LARGE",
      `单次最多翻译 ${MAX_TRANSLATION_BATCH_SIZE} 条文本`,
    );
  }
  const texts = input.map((text) => text.trim());
  if (texts.some((text) => !text)) {
    throw new TranslationServiceError("INVALID_REQUEST", "翻译文本不能为空");
  }
  if (texts.some((text) => text.length > MAX_TRANSLATION_TEXT_LENGTH)) {
    throw new TranslationServiceError(
      "TEXT_TOO_LONG",
      `单条文本不能超过 ${MAX_TRANSLATION_TEXT_LENGTH} 个字符`,
    );
  }
  const totalCharacters = texts.reduce((total, text) => total + text.length, 0);
  if (totalCharacters > MAX_TRANSLATION_BATCH_CHARACTERS) {
    throw new TranslationServiceError(
      "BATCH_TOO_LARGE",
      `单次翻译文本总长度不能超过 ${MAX_TRANSLATION_BATCH_CHARACTERS} 个字符`,
    );
  }
  return texts;
}

function normalizeTranslationError(error: unknown): TranslationServiceError {
  if (error instanceof TranslationServiceError) return error;
  return new TranslationServiceError("PROVIDER_UNAVAILABLE", "翻译服务暂时不可用，请稍后重试");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SafeBackendError {
  code: string | null;
  message: string | null;
  modelIds: LocalModelId[];
}

async function readSafeBackendError(response: Response): Promise<SafeBackendError> {
  const empty: SafeBackendError = { code: null, message: null, modelIds: [] };
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > 4_096) return empty;

  let body: string;
  try {
    body = await response.text();
  } catch {
    return empty;
  }
  if (!body || body.length > 4_096) return empty;

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return empty;
  }
  if (!isRecord(payload)) return empty;
  if (typeof payload.detail === "string") {
    return { ...empty, message: sanitizeBackendDetail(payload.detail) };
  }
  if (!isRecord(payload.detail)) return empty;
  const detail = payload.detail;
  const code = typeof detail.code === "string"
    ? detail.code.replace(/[^A-Z0-9_]/gi, "").slice(0, 64)
    : null;
  const message = sanitizeBackendDetail(detail.message);
  const modelIds = Array.isArray(detail.model_ids)
    ? uniqueLocalModelIds(detail.model_ids)
    : [];
  return { code, message, modelIds };
}

function uniqueLocalModelIds(values: readonly unknown[]): LocalModelId[] {
  const allowed = LOCAL_MODEL_IDS as readonly string[];
  return [...new Set(values.filter((value): value is LocalModelId =>
    typeof value === "string" && allowed.includes(value)))];
}

function sanitizeBackendDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const detail = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!detail || detail.length > 240) return null;
  if (/https?:\/\/|(?:authorization|bearer|cookie|password|secret|token|api[_-]?key)\b/i.test(detail)) {
    return null;
  }
  return detail;
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return error.name.replace(/[^\w.-]/g, "").slice(0, 60) || "Error";
}
