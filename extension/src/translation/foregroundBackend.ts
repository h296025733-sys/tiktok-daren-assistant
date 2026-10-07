import {
  GOOGLE_TRANSLATION_ARRAY_ENDPOINT,
  GOOGLE_TRANSLATE_HTML_API_KEY,
  GOOGLE_TRANSLATE_HTML_ENDPOINT,
  LOCAL_GOOGLE_TRANSLATION_ENDPOINT,
  LOCAL_GOOGLE_TRANSLATION_FALLBACK_ENDPOINT,
  LOCAL_TRANSLATION_ENDPOINT,
  LOCAL_TRANSLATION_FALLBACK_ENDPOINT,
  TranslationService,
  buildGoogleTranslateFallbackUrl,
} from "../background/translationService";
import {
  LOCAL_MODEL_IDS,
  SUPPORTED_TRANSLATION_TARGET_LANGUAGES,
  TRANSLATION_TARGET_LANGUAGE,
  type LocalModelId,
  type TranslationErrorResponse,
  type TranslationItemProvider,
  type TranslationRequest,
  type TranslationResponse,
  type TranslationResultItem,
  type TranslationTargetLanguage,
} from "../types/messages";
import { readSpeedTaskId, speedLog, speedNow } from "../shared/speedDiagnostics";

export const FOREGROUND_TRANSLATION_BATCH_ENDPOINTS = [
  "http://localhost:8765/api/v1/translations/batch",
  "http://127.0.0.1:8765/api/v1/translations/batch",
] as const;

const FOREGROUND_TRANSLATION_NOTICE =
  "侧栏前台连接本机服务，由本机服务优先调用 Google；在线失败时简体中文回退离线翻译。";
const DEFAULT_TIMEOUT_MS = 30_000;

interface BackendBatchItem {
  index: number;
  ok: boolean;
  translated_text?: string;
  detected_source_language?: string | null;
  provider?: TranslationItemProvider;
  error_code?: string;
  required_model_ids?: LocalModelId[];
}

interface BackendBatchResponse {
  target_language: string;
  results: BackendBatchItem[];
  succeeded: number;
  failed: number;
}

export interface ForegroundTranslationBackendOptions {
  fetchImpl?: typeof fetch;
  endpoints?: readonly string[];
  timeoutMs?: number;
  fallbackService?: Pick<TranslationService, "handle">;
  chromeOnly?: boolean;
}

/**
 * Translation transport used only by the visible side panel. It deliberately
 * keeps loopback I/O out of content scripts and the MV3 service worker.
 */
export class ForegroundTranslationBackend {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoints: readonly string[];
  private readonly timeoutMs: number;
  private readonly fallbackService: Pick<TranslationService, "handle">;
  private readonly chromeOnly: boolean;

  constructor(options: ForegroundTranslationBackendOptions = {}) {
    // Calling an unbound Window.fetch through this.fetchImpl gives the native
    // method the class instance as its receiver and Chrome rejects it before
    // any request reaches localhost. Keep the browser receiver bound.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.chromeOnly = options.chromeOnly === true;
    this.endpoints = options.chromeOnly
      ? []
      : options.endpoints ?? FOREGROUND_TRANSLATION_BATCH_ENDPOINTS;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.fallbackService = options.fallbackService ?? new TranslationService({
      fetchImpl: this.fetchImpl,
      preferLocalBackend: !options.chromeOnly,
      ...(options.chromeOnly
        ? {
            googleArrayEndpoint: GOOGLE_TRANSLATION_ARRAY_ENDPOINT,
            googleTranslateHtmlEndpoint: GOOGLE_TRANSLATE_HTML_ENDPOINT,
            googleTranslateHtmlApiKey: GOOGLE_TRANSLATE_HTML_API_KEY,
            googleEndpoints: [],
          }
        : {}),
      localFallbackEndpoints: options.chromeOnly ? [] : [
          LOCAL_GOOGLE_TRANSLATION_FALLBACK_ENDPOINT,
          LOCAL_GOOGLE_TRANSLATION_ENDPOINT,
          LOCAL_TRANSLATION_FALLBACK_ENDPOINT,
          LOCAL_TRANSLATION_ENDPOINT,
        ],
      timeoutMs: 15_000,
    });
  }

  async handle(request: TranslationRequest, parentTaskId = ""): Promise<TranslationResponse> {
    const taskId = parentTaskId || readSpeedTaskId(request, "translation-foreground-backend");
    const taskStartedAt = speedNow();
    speedLog("translation.foreground_backend", taskId, "request_start", taskStartedAt, {
      request_type: request.type,
      endpoint_count: this.endpoints.length,
    });
    if (request.provider === "deepseek_expert") {
      speedLog("translation.foreground_backend", taskId, "request_complete", taskStartedAt, {
        ok: false,
        code: "PROVIDER_NOT_CONFIGURED",
      });
      return failure(
        "PROVIDER_NOT_CONFIGURED",
        "专家翻译接口已预留，当前版本尚未配置",
        "TDA-TR-EXPERT",
        firstText(request),
        targetLanguageOf(request),
      );
    }

    const texts = request.type === "TRANSLATE_PUBLIC_TEXT" ? [request.text] : request.texts;
    const targetLanguage = targetLanguageOf(request);
    const diagnostics: string[] = [];
    for (const [index, endpoint] of this.endpoints.entries()) {
      try {
        const payload = await this.postBatch(endpoint, texts, targetLanguage, taskId, index + 1);
        const mapped = mapBackendBatch(payload, texts, targetLanguage);
        if (mapped.ok || mapped.code === "LOCAL_MODEL_REQUIRED") {
          speedLog("translation.foreground_backend", taskId, "request_complete", taskStartedAt, {
            ok: mapped.ok,
            endpoint_attempt: index + 1,
          });
          return mapped;
        }
        diagnostics.push(`TDA-TR-05-B${index + 1}:${mapped.diagnostic ?? mapped.code}`);
      } catch (error) {
        diagnostics.push(`TDA-TR-03-B${index + 1}:${safeErrorCode(error)}`);
      }
    }

    // Keeps compatibility if the backend process has not yet reloaded the new
    // batch route. This still starts with the side-panel loopback path.
    const fallback = await this.fallbackService.handle(request);
    if (fallback.ok) {
      speedLog("translation.foreground_backend", taskId, "fallback_complete", taskStartedAt, {
        ok: true,
      });
      return this.chromeOnly
        ? fallback
        : { ...fallback, data: { ...fallback.data, provider: "local_foreground" } };
    }
    speedLog("translation.foreground_backend", taskId, "request_complete", taskStartedAt, {
      ok: false,
      fallback_code: fallback.code,
    });
    return {
      ...fallback,
      error: this.chromeOnly
        ? "在线翻译暂时不可用，请检查网络后重试"
        : "侧栏无法完成翻译，请确认本地服务正常后重试",
      diagnostic: [...diagnostics, fallback.diagnostic ?? fallback.code].join(";"),
    };
  }

  private async postBatch(
    endpoint: string,
    texts: string[],
    targetLanguage: TranslationTargetLanguage,
    taskId: string,
    attempt: number,
  ): Promise<unknown> {
    const startedAt = speedNow();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      body: JSON.stringify({ texts, target_language: targetLanguage }),
    };
    try {
      const response = await this.fetchImpl(endpoint, init);
      speedLog("translation.foreground_backend", taskId, "network_response", startedAt, {
        attempt,
        status: response.status,
        ok: response.ok,
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      return await response.json();
    } catch (error) {
      speedLog("translation.foreground_backend", taskId, "network_failed", startedAt, {
        attempt,
        error_name: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function mapBackendBatch(
  value: unknown,
  texts: string[],
  targetLanguage: TranslationTargetLanguage,
): TranslationResponse {
  if (!isBackendBatchResponse(value) || value.target_language !== targetLanguage) {
    return failure(
      "INVALID_PROVIDER_RESPONSE",
      "本地翻译服务返回了无效结果",
      "TDA-TR-05-SCHEMA",
      texts[0] ?? null,
      targetLanguage,
    );
  }
  if (value.results.length !== texts.length) {
    return failure(
      "INVALID_PROVIDER_RESPONSE",
      "本地翻译结果数量不完整",
      "TDA-TR-05-COUNT",
      texts[0] ?? null,
      targetLanguage,
    );
  }

  const byIndex = new Map(value.results.map((item) => [item.index, item]));
  const requiredModelIds = uniqueModelIds(
    value.results.flatMap((item) =>
      !item.ok && item.error_code === "LOCAL_MODEL_REQUIRED"
        ? item.required_model_ids ?? []
        : []),
  );
  if (requiredModelIds.length > 0) {
    return failure(
      "LOCAL_MODEL_REQUIRED",
      "在线翻译暂时不可用，可选择下载本地翻译模型后重试",
      "TDA-TR-04-LOCAL_MODEL_REQUIRED",
      texts[0] ?? null,
      targetLanguage,
      requiredModelIds,
    );
  }
  const items: TranslationResultItem[] = [];
  for (const [index, sourceText] of texts.entries()) {
    const item = byIndex.get(index);
    if (!item?.ok || typeof item.translated_text !== "string" || !item.translated_text.trim()) {
      return failure(
        "PROVIDER_UNAVAILABLE",
        "部分文本暂时无法翻译，请重试",
        `TDA-TR-04-${sanitizeCode(item?.error_code ?? "UNKNOWN")}`,
        texts[0] ?? null,
        targetLanguage,
      );
    }
    items.push({
      source_text: sourceText,
      translated_text: item.translated_text.trim(),
      detected_source_language:
        typeof item.detected_source_language === "string"
          ? item.detected_source_language
          : null,
      target_language: targetLanguage,
      cached: false,
      provider: item.provider,
    });
  }
  return {
    ok: true,
    data: {
      items,
      provider: "local_foreground",
      provider_notice: translationProviderNotice(items),
    },
  };
}

function isBackendBatchResponse(value: unknown): value is BackendBatchResponse {
  if (!isRecord(value) || typeof value.target_language !== "string" || !Array.isArray(value.results)) {
    return false;
  }
  if (typeof value.succeeded !== "number" || typeof value.failed !== "number") return false;
  return value.results.every((item) => {
    if (!isRecord(item) || typeof item.index !== "number" || !Number.isInteger(item.index) ||
      typeof item.ok !== "boolean") return false;
    if (item.translated_text !== undefined && typeof item.translated_text !== "string") return false;
    if (item.detected_source_language !== undefined && item.detected_source_language !== null &&
      typeof item.detected_source_language !== "string") return false;
    if (item.error_code !== undefined && typeof item.error_code !== "string") return false;
    if (
      item.required_model_ids !== undefined &&
      (!Array.isArray(item.required_model_ids) ||
        item.required_model_ids.some((id) => !isLocalModelId(id)))
    ) return false;
    const validProvider =
      item.provider === "google_translate_web" ||
      item.provider === "bing_translate_web" ||
      item.provider === "argos_local";
    return item.ok ? validProvider : item.provider === undefined || validProvider;
  });
}

export function translationProviderLabel(items: readonly TranslationResultItem[]): string {
  const providers = new Set<TranslationItemProvider>();
  for (const item of items) {
    if (item.provider) providers.add(item.provider);
  }
  if (providers.size > 1) {
    const labels: string[] = [];
    if (providers.has("google_translate_web")) labels.push("Google 在线");
    if (providers.has("bing_translate_web")) labels.push("Bing 在线");
    if (providers.has("argos_local")) labels.push("Argos 本地");
    return labels.join(" + ");
  }
  if (providers.has("google_translate_web")) return "Google 在线";
  if (providers.has("bing_translate_web")) return "Bing 在线";
  if (providers.has("argos_local")) return "Argos 本地";
  return "自动翻译";
}

function translationProviderNotice(items: readonly TranslationResultItem[]): string {
  const label = translationProviderLabel(items);
  if (label === "Google 在线") return "本次译文由 Google 在线翻译完成。";
  if (label === "Bing 在线") return "Google 在线不可用，本次译文已由 Bing 在线翻译自动补齐。";
  if (label === "Argos 本地") return "在线翻译不可用，本次译文由 Argos 本地模型完成。";
  if (label.includes(" + ")) return `本次使用混合通道：${label}。`;
  return FOREGROUND_TRANSLATION_NOTICE;
}

function targetLanguageOf(request: TranslationRequest): TranslationTargetLanguage {
  const candidate = request.target_language ?? TRANSLATION_TARGET_LANGUAGE;
  return (SUPPORTED_TRANSLATION_TARGET_LANGUAGES as readonly string[]).includes(candidate)
    ? candidate
    : TRANSLATION_TARGET_LANGUAGE;
}

function firstText(request: TranslationRequest): string | null {
  return request.type === "TRANSLATE_PUBLIC_TEXT" ? request.text : request.texts[0] ?? null;
}

function failure(
  code: TranslationErrorResponse["code"],
  error: string,
  diagnostic: string,
  text: string | null,
  targetLanguage: TranslationTargetLanguage,
  requiredModelIds: LocalModelId[] = [],
): TranslationErrorResponse {
  return {
    ok: false,
    error,
    code,
    diagnostic,
    ...(requiredModelIds.length ? { required_model_ids: requiredModelIds } : {}),
    ...(text ? { fallback_url: buildGoogleTranslateFallbackUrl(text, targetLanguage) } : {}),
  };
}

function isLocalModelId(value: unknown): value is LocalModelId {
  return typeof value === "string" && (LOCAL_MODEL_IDS as readonly string[]).includes(value);
}

function uniqueModelIds(values: readonly LocalModelId[]): LocalModelId[] {
  return [...new Set(values)].filter(isLocalModelId);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "TIMEOUT";
  if (error instanceof Error && /^http_\d{3}$/.test(error.message)) return error.message.toUpperCase();
  if (error instanceof Error) return sanitizeCode(error.name);
  return "UNKNOWN";
}

function sanitizeCode(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "UNKNOWN";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
