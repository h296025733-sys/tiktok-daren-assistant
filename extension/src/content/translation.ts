import {
  MAX_TRANSLATION_BATCH_CHARACTERS,
  MAX_TRANSLATION_BATCH_SIZE,
  MAX_TRANSLATION_TEXT_LENGTH,
  TranslationService,
} from "../background/translationService";
import type {
  LocalModelId,
  TranslationRequest,
  TranslationItemProvider,
  TranslationProviderMode,
  TranslationResponse,
  TranslationResultItem,
  TranslationTargetLanguage,
} from "../types/messages";
import type { ForegroundTranslationBridgeLike } from "../translation/foregroundQueue";
import { iconSvg } from "../ui/icons";
import {
  createSpeedTaskId,
  speedLog,
  speedNow,
  withSpeedTask,
} from "../shared/speedDiagnostics";

export const MAX_LOADED_TRANSLATION_TARGETS = 500;
export const FIRST_PROGRESSIVE_TRANSLATION_BATCH_SIZE = 8;
export const MAX_PROGRESSIVE_TRANSLATION_BATCH_SIZE = 16;
export const MAX_PROGRESSIVE_TRANSLATION_BATCH_CHARACTERS = 6_000;
export const MAX_AUTO_TRANSLATION_RETRIES = 3;
export const AUTO_TRANSLATION_REFRESH_INTERVAL_MS = 1_500;
export const SCROLL_TRANSLATION_REFRESH_DELAY_MS = 120;
export const DEFAULT_REMEMBERED_TRANSLATION_LIMIT = 5_000;

const TRANSLATABLE_SELECTOR = [
  '[data-e2e="browse-video-desc"]',
  '[data-e2e="video-desc"]',
  '[data-e2e="feed-video-desc"]',
  '[data-e2e="comment-text"]',
  // TikTok 的作者主页详情弹层把评论正文直接放在 p[data-e2e="comment-level-N"]
  // 上，而推荐流旧结构通常在该层级容器下再包一层 .TUXText。两种结构都要覆盖。
  'p[data-e2e|="comment-level"]',
  '[data-e2e="comment-level-1"] .TUXText',
  '[data-e2e="comment-level-2"] .TUXText',
].join(",");
const DESCRIPTION_ROOT_SELECTOR = [
  '[data-e2e="browse-video-desc"]',
  '[data-e2e="video-desc"]',
  '[data-e2e="feed-video-desc"]',
].join(",");
const DESCRIPTION_TEXT_SELECTOR = [
  'span[data-e2e="new-desc-span"]',
  'span[class*="-SpanText"]',
  '[data-e2e="search-common-link"] strong',
].join(",");
const ASSISTANT_SELECTOR = "[data-tiktok-daren-assistant]";

export interface PublicTranslationTarget {
  element: HTMLElement;
  kind: "description" | "comment";
  text: string;
}

export interface TranslationPageContext {
  /** 当前帖子/页面的稳定身份；身份变化会立即终止旧的持续翻译会话。 */
  identity: string;
  /** 只扫描这些根，避免把推荐区、侧栏或上一条帖子送去翻译。 */
  roots: ParentNode[];
  /** 当前评论区是否打开；关闭后会停止持续翻译。 */
  commentsOpen: boolean;
}

export class TranslationRequestError extends Error {
  constructor(
    message: string,
    readonly fallbackUrl: string | null = null,
    readonly diagnostic: string | null = null,
    readonly requiredModelIds: LocalModelId[] = [],
  ) {
    super(message);
    this.name = "TranslationRequestError";
  }
}

export interface TranslationClientOptions {
  /** Explicit transport used by unit tests and embedders. */
  sendMessage?: (request: TranslationRequest) => Promise<TranslationResponse>;
  /** Legacy transport override retained for isolated tests. */
  directService?: Pick<TranslationService, "handle">;
  /** Legacy MV3 transport override retained for isolated tests. */
  backgroundSendMessage?: (request: TranslationRequest) => Promise<TranslationResponse>;
  /** Optional legacy side-panel bridge retained for isolated fallback tests. */
  foregroundBridge?: ForegroundTranslationBridgeLike;
}

export class TranslationClient {
  private readonly sendMessage: (request: TranslationRequest) => Promise<TranslationResponse>;
  private readonly foregroundBridge: ForegroundTranslationBridgeLike | null;

  constructor(options: TranslationClientOptions = {}) {
    if (options.sendMessage) {
      this.sendMessage = options.sendMessage;
      this.foregroundBridge = options.foregroundBridge ?? null;
      return;
    }

    this.foregroundBridge = options.foregroundBridge ?? null;
    if (!options.directService && !options.backgroundSendMessage) {
      // Keep comment translation inside TikTok. The MV3 worker owns the provider
      // chain, so the compact comment action never has to reveal a side panel.
      this.sendMessage = this.foregroundBridge
        ? (request) => this.foregroundBridge!.translate(request)
        : (request) => chrome.runtime.sendMessage(request) as Promise<TranslationResponse>;
      return;
    }

    const directService =
      options.directService ?? new TranslationService({ localFallbackEndpoints: [] });
    const backgroundSendMessage =
      options.backgroundSendMessage ??
      ((request: TranslationRequest) =>
        chrome.runtime.sendMessage(request) as Promise<TranslationResponse>);
    this.sendMessage = (request) =>
      translateInContentScript(request, directService, backgroundSendMessage, this.foregroundBridge);
  }

  prepareForegroundFallback(): void {
    this.foregroundBridge?.prepare();
  }

  async translateText(
    text: string,
    targetLanguage?: TranslationTargetLanguage,
    provider?: TranslationProviderMode,
    parentTaskId = "",
  ): Promise<TranslationResultItem> {
    const taskId = parentTaskId || createSpeedTaskId("translation-single");
    const startedAt = speedNow();
    const request = {
      type: "TRANSLATE_PUBLIC_TEXT",
      text,
      ...(targetLanguage ? { target_language: targetLanguage } : {}),
      ...(provider ? { provider } : {}),
    } satisfies TranslationRequest;
    speedLog("translation-content", taskId, "request_send", startedAt, {
      request_kind: "single",
      item_count: 1,
      character_count: text.length,
    });
    const response = await this.sendMessage(withSpeedTask(request, taskId));
    speedLog("translation-content", taskId, "background_response", startedAt, {
      ok: response.ok,
    });
    const items = unwrapResponse(response);
    const item = items[0];
    if (!item) throw new TranslationRequestError("翻译服务未返回译文");
    return item;
  }

  async translateBatch(
    texts: string[],
    targetLanguage?: TranslationTargetLanguage,
    provider?: TranslationProviderMode,
    parentTaskId = "",
  ): Promise<TranslationResultItem[]> {
    const taskId = parentTaskId || createSpeedTaskId("translation-batch");
    const startedAt = speedNow();
    const request = {
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts,
      ...(targetLanguage ? { target_language: targetLanguage } : {}),
      ...(provider ? { provider } : {}),
    } satisfies TranslationRequest;
    speedLog("translation-content", taskId, "request_send", startedAt, {
      request_kind: "batch",
      item_count: texts.length,
      character_count: texts.reduce((total, text) => total + text.length, 0),
    });
    const response = await this.sendMessage(withSpeedTask(request, taskId));
    speedLog("translation-content", taskId, "background_response", startedAt, {
      ok: response.ok,
    });
    return unwrapResponse(response);
  }
}

/** Legacy compatibility chain used only by explicit test/embedder overrides. */
export async function translateInContentScript(
  request: TranslationRequest,
  directService: Pick<TranslationService, "handle">,
  backgroundSendMessage: (request: TranslationRequest) => Promise<TranslationResponse>,
  foregroundBridge: Pick<ForegroundTranslationBridgeLike, "translate"> | null = null,
): Promise<TranslationResponse> {
  let directResponse: TranslationResponse;
  try {
    directResponse = await directService.handle(request);
  } catch (error) {
    directResponse = {
      ok: false,
      error: "在线翻译暂时不可用",
      code: "PROVIDER_UNAVAILABLE",
      diagnostic: `content_google_unexpected:${safeClientErrorName(error)}`,
    };
  }

  if (directResponse.ok || !shouldTryBackgroundFallback(directResponse.code)) {
    return directResponse;
  }

  let failedResponse = directResponse;
  try {
    const backgroundResponse = await backgroundSendMessage(request);
    if (backgroundResponse?.ok) return backgroundResponse;
    if (backgroundResponse && typeof backgroundResponse === "object") {
      if (!shouldTryBackgroundFallback(backgroundResponse.code)) return backgroundResponse;
      failedResponse = backgroundResponse;
    }
  } catch (error) {
    failedResponse = {
      ...directResponse,
      diagnostic: joinClientDiagnostics(
        directResponse.diagnostic,
        `background_message_failed:${safeClientErrorName(error)}`,
      ),
    };
  }
  if (!foregroundBridge) return failedResponse;

  const foregroundResponse = await foregroundBridge.translate(request);
  if (foregroundResponse.ok) return foregroundResponse;
  return {
    ...foregroundResponse,
    ...(foregroundResponse.fallback_url || !failedResponse.fallback_url
      ? {}
      : { fallback_url: failedResponse.fallback_url }),
    diagnostic: joinClientDiagnostics(
      failedResponse.diagnostic,
      foregroundResponse.diagnostic ?? "fg_queue_message_failed",
    ),
  };
}

function shouldTryBackgroundFallback(code: string): boolean {
  return (
    code === "REQUEST_TIMEOUT" ||
    code === "PROVIDER_UNAVAILABLE" ||
    code === "INVALID_PROVIDER_RESPONSE"
  );
}

function safeClientErrorName(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 64);
  return "unknown";
}

function joinClientDiagnostics(left: string | undefined, right: string): string {
  return left ? `${left};${right}` : right;
}

export interface TranslationControllerOptions {
  client?: TranslationClient;
  resolveContext?: () => TranslationPageContext | null;
  showBulkToolbar?: boolean;
  maxRememberedTranslations?: number;
}

interface BoundTranslation {
  target: PublicTranslationTarget;
  host: HTMLElement;
  action: HTMLButtonElement;
  status: HTMLElement;
  result: HTMLElement;
  fallback: HTMLButtonElement;
  installModel: HTMLButtonElement;
  lastSourceText: string | null;
  collapsedSourceText: string | null;
}

interface TranslationSession {
  id: number;
  contextIdentity: string;
  dynamicEnabled: boolean;
  stopped: boolean;
  rerun: boolean;
  processing: Promise<void> | null;
  attempted: number;
  translated: number;
  failed: number;
  providers: Set<TranslationItemProvider>;
  processedTexts: WeakMap<HTMLElement, string>;
  itemByText: Map<string, TranslationResultItem>;
  retryCounts: WeakMap<HTMLElement, number>;
  retryQueue: Map<HTMLElement, { text: string; dueAt: number }>;
  retryingElements: Set<HTMLElement>;
  retryTimer: number | null;
  retryTimerDueAt: number | null;
  speedTaskId: string;
  speedStartedAt: number;
  firstResultLogged: boolean;
}

/**
 * 按需翻译 UI。模块本身没有副作用；内容脚本显式调用 install() 后才会注入按钮。
 * 用户点击单条或当前视频批量按钮本身就是本次发送公开文本的明确操作意图。
 */
export class TranslationController {
  private readonly client: TranslationClient;
  private readonly resolveContext: () => TranslationPageContext | null;
  private readonly showBulkToolbar: boolean;
  private readonly bindings = new Map<HTMLElement, BoundTranslation>();
  private observer: MutationObserver | null = null;
  private refreshTimer: number | null = null;
  private autoRefreshTimer: number | null = null;
  private toolbarHost: HTMLElement | null = null;
  private toolbarAction: HTMLButtonElement | null = null;
  private toolbarExport: HTMLButtonElement | null = null;
  private toolbarStatus: HTMLElement | null = null;
  private currentContext: TranslationPageContext | null = null;
  private activeSession: TranslationSession | null = null;
  private readonly translatedItemsByText = new Map<string, TranslationResultItem>();
  private readonly maxRememberedTranslations: number;
  private sessionSequence = 0;
  private readonly handleScroll = (): void => {
    if (this.activeSession) this.queueRefresh(SCROLL_TRANSLATION_REFRESH_DELAY_MS);
  };

  constructor(
    private readonly documentRef: Document = document,
    private readonly windowRef: Window = window,
    options: TranslationControllerOptions = {},
  ) {
    this.client = options.client ?? new TranslationClient();
    this.resolveContext =
      options.resolveContext ??
      (() => ({
        identity: `page:${this.windowRef.location.href}`,
        roots: [this.documentRef],
        commentsOpen: true,
      }));
    this.showBulkToolbar = options.showBulkToolbar ?? true;
    this.maxRememberedTranslations = Math.max(
      1,
      Math.floor(
        options.maxRememberedTranslations ?? DEFAULT_REMEMBERED_TRANSLATION_LIMIT,
      ),
    );
  }

  install(): void {
    if (this.observer) return;
    this.syncContext();
    if (this.showBulkToolbar) this.createToolbar();
    this.refresh();
    this.observer = new MutationObserver((records) => {
      const shouldRefresh = records.some((record) => {
        if (isAssistantMutation(record.target)) return false;
        if (record.type !== "characterData") return true;
        return this.activeSession !== null &&
          nodeBelongsToRoots(record.target, this.currentContext?.roots ?? []);
      });
      if (!shouldRefresh) return;
      this.queueRefresh();
    });
    this.observer.observe(this.documentRef.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    this.documentRef.addEventListener("scroll", this.handleScroll, {
      capture: true,
      passive: true,
    });
    this.windowRef.addEventListener("scroll", this.handleScroll, { passive: true });
  }

  dispose(): void {
    this.stopAutoTranslation("持续翻译已停止", false);
    this.observer?.disconnect();
    this.observer = null;
    this.documentRef.removeEventListener("scroll", this.handleScroll, true);
    this.windowRef.removeEventListener("scroll", this.handleScroll);
    if (this.refreshTimer !== null) this.windowRef.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.clearAutoRefreshWatchdog();
    for (const binding of this.bindings.values()) binding.host.remove();
    this.bindings.clear();
    this.toolbarHost?.remove();
    this.toolbarHost = null;
    this.toolbarAction = null;
    this.toolbarExport = null;
    this.toolbarStatus = null;
    this.currentContext = null;
    this.translatedItemsByText.clear();
  }

  refresh(root: ParentNode = this.documentRef): number {
    const context = this.syncContext();
    const roots = root === this.documentRef ? context?.roots ?? [] : [root];
    const targets = collectPublicTranslationTargetsFromRoots(roots);
    for (const [element, binding] of this.bindings) {
      // TikTok only exposes the currently visible comment scopes while the user
      // scrolls. A still-connected comment missing from this scan is off-screen,
      // not deleted. Keep its completed translation attached so scrolling back
      // never clears an earlier batch.
      if (!element.isConnected || !binding.host.isConnected) {
        binding.host.remove();
        this.bindings.delete(element);
      }
    }
    for (const target of targets) {
      const existing = this.bindings.get(target.element);
      if (existing) {
        existing.target = target;
        this.restoreTranslatedResult(existing);
        continue;
      }
      const binding = this.createBinding(target);
      target.element.insertAdjacentElement("afterend", binding.host);
      this.bindings.set(target.element, binding);
      this.restoreTranslatedResult(binding);
    }
    this.positionToolbar();
    if (this.toolbarExport) {
      this.toolbarExport.disabled = ![...this.bindings.values()].some(
        (binding) => binding.target.kind === "comment",
      );
    }
    if (!this.activeSession) {
      this.updateToolbarStatus(`${this.bindings.size} 条当前视频公开内容可翻译`);
    } else if (
      !context ||
      this.activeSession.contextIdentity !== context.identity ||
      (this.activeSession.dynamicEnabled && !context.commentsOpen)
    ) {
      this.stopAutoTranslation(
        context && this.activeSession.contextIdentity === context.identity
          ? "评论区已关闭，持续翻译已停止"
          : "已切换帖子，旧翻译会话已停止",
      );
    } else {
      this.activeSession.rerun = true;
      void this.processSession(this.activeSession);
    }
    return this.bindings.size;
  }

  async translateElement(element: HTMLElement): Promise<TranslationResultItem | null> {
    const taskId = createSpeedTaskId("translation-single");
    const startedAt = speedNow();
    const binding = this.bindings.get(element);
    if (!binding) return null;
    const contextIdentity = this.syncContext()?.identity ?? null;
    const text = readPublicText(element);
    if (!text) {
      this.renderStatus(binding, "未找到可翻译文本", "error");
      return null;
    }
    if (!binding.result.hidden && binding.lastSourceText === text) {
      binding.result.hidden = true;
      binding.status.hidden = true;
      binding.action.textContent = "重新翻译";
      binding.collapsedSourceText = text;
      return null;
    }
    if (text.length > MAX_TRANSLATION_TEXT_LENGTH) {
      this.renderStatus(binding, `文本超过 ${MAX_TRANSLATION_TEXT_LENGTH} 字符，未发送`, "error");
      this.showFallback(binding, buildOfficialTranslateUrl(text));
      return null;
    }
    this.client.prepareForegroundFallback();
    this.renderLoading(binding);
    try {
      const item = await this.client.translateText(text, undefined, undefined, taskId);
      if (!this.isContextCurrent(contextIdentity) || !binding.host.isConnected) return null;
      const renderStartedAt = speedNow();
      this.rememberTranslatedResult(text, item);
      this.renderResult(binding, item);
      speedLog("translation-content", taskId, "first_result_rendered", startedAt, {
        request_kind: "single",
      });
      speedLog("translation-content", taskId, "dom_render_complete", renderStartedAt, {
        rendered_count: 1,
      });
      speedLog("translation-content", taskId, "task_complete", startedAt, {
        ok: true,
        translated_count: 1,
      });
      return item;
    } catch (error) {
      console.error("[TikTok 达人助手] 单条公开文本翻译失败", {
        error,
        diagnostic: error instanceof TranslationRequestError ? error.diagnostic : null,
      });
      if (!this.isContextCurrent(contextIdentity) || !binding.host.isConnected) return null;
      this.renderTranslationError(binding, error, text);
      speedLog("translation-content", taskId, "task_complete", startedAt, {
        ok: false,
        translated_count: 0,
      });
      return null;
    }
  }

  async translateLoaded(): Promise<{ translated: number; total: number }> {
    if (this.activeSession) {
      const result = {
        translated: this.activeSession.translated,
        total: this.activeSession.attempted,
      };
      this.stopAutoTranslation("已停止自动翻译");
      return result;
    }
    const taskId = createSpeedTaskId("translation-loaded");
    const startedAt = speedNow();
    const collectStartedAt = speedNow();
    this.refresh();
    speedLog("translation-content", taskId, "collect_comments_complete", collectStartedAt, {
      binding_count: this.bindings.size,
    });
    const context = this.currentContext;
    if (!context || this.bindings.size === 0) {
      this.updateToolbarStatus("当前视频没有可翻译的公开文案或评论");
      return { translated: 0, total: 0 };
    }
    this.client.prepareForegroundFallback();

    const session: TranslationSession = {
      id: ++this.sessionSequence,
      contextIdentity: context.identity,
      dynamicEnabled: context.commentsOpen,
      stopped: false,
      rerun: true,
      processing: null,
      attempted: 0,
      translated: 0,
      failed: 0,
      providers: new Set(),
      processedTexts: new WeakMap(),
      itemByText: new Map(),
      retryCounts: new WeakMap(),
      retryQueue: new Map(),
      retryingElements: new Set(),
      retryTimer: null,
      retryTimerDueAt: null,
      speedTaskId: taskId,
      speedStartedAt: startedAt,
      firstResultLogged: false,
    };
    this.activeSession = session;
    if (session.dynamicEnabled) this.startAutoRefreshWatchdog(session);
    this.setToolbarMode(session.dynamicEnabled ? "active" : "busy");
    await this.processSession(session);
    speedLog("translation-content", taskId, "initial_pass_complete", startedAt, {
      attempted_count: session.attempted,
      translated_count: session.translated,
      failed_count: session.failed,
      dynamic_enabled: session.dynamicEnabled,
    });

    const result = { translated: session.translated, total: session.attempted };
    if (this.activeSession !== session || session.stopped) return result;
    if (session.dynamicEnabled) {
      this.setToolbarMode("active");
      this.updateSessionStatus(session, true);
    } else {
      this.activeSession = null;
      this.setToolbarMode("idle");
      this.updateToolbarStatus(
        `已翻译 ${session.translated}/${session.attempted} 条；打开评论区后可持续翻译新评论`,
      );
    }
    return result;
  }

  stopAutoTranslation(message = "已停止自动翻译", updateStatus = true): void {
    const session = this.activeSession;
    if (!session) return;
    session.stopped = true;
    session.rerun = false;
    this.clearSessionRetries(session);
    this.clearAutoRefreshWatchdog();
    this.activeSession = null;
    this.setToolbarMode("idle");
    if (updateStatus) this.updateToolbarStatus(message);
  }

  private syncContext(): TranslationPageContext | null {
    let next: TranslationPageContext | null = null;
    try {
      const resolved = this.resolveContext();
      if (resolved?.identity && resolved.roots.length > 0) {
        next = {
          identity: resolved.identity,
          roots: [...new Set(resolved.roots)],
          commentsOpen: resolved.commentsOpen,
        };
      }
    } catch (error) {
      console.error("[TikTok 达人助手] 无法确定当前翻译范围", error);
    }

    if (this.currentContext?.identity !== next?.identity) {
      if (this.activeSession) this.stopAutoTranslation("已切换帖子，旧翻译会话已停止");
      for (const binding of this.bindings.values()) binding.host.remove();
      this.bindings.clear();
      // Identical short comments appear across many videos. Keep the bounded
      // text cache across post switches so they render immediately instead of
      // spending another public translation request.
    }
    this.currentContext = next;
    return next;
  }

  private isContextCurrent(identity: string | null): boolean {
    return identity !== null && this.syncContext()?.identity === identity;
  }

  private isSessionCurrent(session: TranslationSession): boolean {
    return (
      !session.stopped &&
      this.activeSession === session &&
      this.currentContext?.identity === session.contextIdentity
    );
  }

  private async processSession(session: TranslationSession): Promise<void> {
    if (session.processing) {
      session.rerun = true;
      await session.processing;
      return;
    }
    const processing = this.processSessionLoop(session);
    session.processing = processing;
    try {
      await processing;
    } finally {
      if (session.processing === processing) session.processing = null;
    }
  }

  private async processSessionLoop(session: TranslationSession): Promise<void> {
    while (session.rerun && this.isSessionCurrent(session)) {
      session.rerun = false;
      await this.processSessionPass(session);
    }
  }

  private async processSessionPass(session: TranslationSession): Promise<void> {
    const passStartedAt = speedNow();
    const grouped = new Map<string, BoundTranslation[]>();
    let sessionCacheHits = 0;
    let duplicateBindings = 0;
    // Map preserves insertion time, not page order. TikTok can insert or recycle
    // comments while scrolling, so always rebuild the work order from the live DOM.
    for (const binding of this.bindingsInDocumentOrder()) {
      const element = binding.target.element;
      if (!element.isConnected || !binding.host.isConnected) continue;
      const text = readPublicText(element);
      const retrying = session.retryingElements.delete(element);
      const previousText = session.processedTexts.get(element);
      if (!text || (!retrying && previousText === text)) continue;
      if (previousText !== undefined && previousText !== text) {
        session.retryCounts.delete(element);
        session.retryQueue.delete(element);
      }
      session.processedTexts.set(element, text);
      if (!retrying) session.attempted += 1;

      if (text.length > MAX_TRANSLATION_TEXT_LENGTH) {
        session.retryCounts.delete(element);
        session.retryQueue.delete(element);
        session.failed += 1;
        this.renderStatus(binding, `文本超过 ${MAX_TRANSLATION_TEXT_LENGTH} 字符，未发送`, "error");
        this.showFallback(binding, buildOfficialTranslateUrl(text));
        continue;
      }

      const cached = session.itemByText.get(text) ?? this.translatedItemsByText.get(text);
      if (cached) {
        session.retryCounts.delete(element);
        session.retryQueue.delete(element);
        sessionCacheHits += 1;
        session.itemByText.set(text, cached);
        if (cached.provider) session.providers.add(cached.provider);
        const renderStartedAt = speedNow();
        this.renderResult(binding, cached);
        speedLog("translation-content", session.speedTaskId, "dom_render_complete", renderStartedAt, {
          rendered_count: 1,
          source: "session_cache",
        });
        this.logFirstSessionResult(session);
        session.translated += 1;
        continue;
      }
      const matches = grouped.get(text) ?? [];
      if (matches.length > 0) duplicateBindings += 1;
      matches.push(binding);
      grouped.set(text, matches);
    }

    const entries = [...grouped].map(([text, bindings]) => ({ text, bindings }));
    speedLog("translation-content", session.speedTaskId, "dedupe_complete", passStartedAt, {
      unique_request_count: entries.length,
      duplicate_binding_count: duplicateBindings,
      session_cache_hits: sessionCacheHits,
      attempted_total: session.attempted,
    });
    let chunkIndex = 0;
    for (const chunk of chunkTranslationEntries(entries)) {
      chunkIndex += 1;
      if (!this.isSessionCurrent(session)) return;
      for (const entry of chunk) {
        for (const binding of entry.bindings) this.renderLoading(binding);
      }
      try {
        const chunkStartedAt = speedNow();
        const items = await this.client.translateBatch(
          chunk.map((entry) => entry.text),
          undefined,
          undefined,
          session.speedTaskId,
        );
        speedLog("translation-content", session.speedTaskId, "chunk_response", chunkStartedAt, {
          chunk_index: chunkIndex,
          unique_item_count: chunk.length,
          result_count: items.length,
        });
        if (!this.isSessionCurrent(session)) return;
        const renderStartedAt = speedNow();
        let renderedCount = 0;
        chunk.forEach((entry, index) => {
          const item = items[index];
          if (!item) {
            session.failed += entry.bindings.length;
            for (const binding of entry.bindings) {
              this.renderStatus(binding, "翻译服务未返回译文", "error");
            }
            return;
          }
          session.itemByText.set(entry.text, item);
          this.rememberTranslatedResult(entry.text, item);
          if (item.provider) session.providers.add(item.provider);
          for (const binding of entry.bindings) {
            session.retryCounts.delete(binding.target.element);
            session.retryQueue.delete(binding.target.element);
            if (!binding.host.isConnected) continue;
            this.renderResult(binding, item);
            renderedCount += 1;
            this.logFirstSessionResult(session);
            session.translated += 1;
          }
        });
        speedLog("translation-content", session.speedTaskId, "dom_render_complete", renderStartedAt, {
          chunk_index: chunkIndex,
          rendered_count: renderedCount,
        });
      } catch (error) {
        console.error("[TikTok 达人助手] 当前视频批量翻译失败", {
          error,
          diagnostic: error instanceof TranslationRequestError ? error.diagnostic : null,
        });
        if (!this.isSessionCurrent(session)) return;
        for (const entry of chunk) {
          for (const binding of entry.bindings) {
            if (!binding.target.element.isConnected || !binding.host.isConnected) continue;
            if (this.scheduleBindingRetry(session, binding, entry.text, error)) {
              this.renderStatus(binding, "翻译暂时失败，稍后会自动重试", "muted");
              binding.fallback.hidden = true;
            } else {
              session.failed += 1;
              this.renderTranslationError(binding, error, entry.text);
            }
          }
        }
      }
      this.updateSessionStatus(session, false);
    }
    this.armSessionRetryTimer(session);
    speedLog("translation-content", session.speedTaskId, "session_pass_complete", passStartedAt, {
      translated_total: session.translated,
      failed_total: session.failed,
    });
  }

  private startAutoRefreshWatchdog(session: TranslationSession): void {
    this.clearAutoRefreshWatchdog();
    const schedule = (): void => {
      if (!this.isSessionCurrent(session)) return;
      this.autoRefreshTimer = this.windowRef.setTimeout(() => {
        this.autoRefreshTimer = null;
        if (!this.isSessionCurrent(session)) return;
        try {
          if (this.documentRef.visibilityState !== "hidden") this.refresh();
        } catch (error) {
          console.error("[TikTok 达人助手] 自动翻译兜底刷新失败", error);
        } finally {
          schedule();
        }
      }, AUTO_TRANSLATION_REFRESH_INTERVAL_MS);
    };
    schedule();
  }

  private clearAutoRefreshWatchdog(): void {
    if (this.autoRefreshTimer !== null) this.windowRef.clearTimeout(this.autoRefreshTimer);
    this.autoRefreshTimer = null;
  }

  private scheduleBindingRetry(
    session: TranslationSession,
    binding: BoundTranslation,
    text: string,
    error: unknown,
  ): boolean {
    const baseDelay = autoTranslationRetryBaseDelay(error);
    if (baseDelay === null) return false;
    const element = binding.target.element;
    const retryCount = (session.retryCounts.get(element) ?? 0) + 1;
    if (retryCount > MAX_AUTO_TRANSLATION_RETRIES) {
      session.retryCounts.delete(element);
      session.retryQueue.delete(element);
      return false;
    }
    session.retryCounts.set(element, retryCount);
    const delay = Math.min(15 * 60_000, baseDelay * 2 ** (retryCount - 1));
    session.retryQueue.set(element, {
      text,
      dueAt: Date.now() + delay,
    });
    this.armSessionRetryTimer(session);
    return true;
  }

  private armSessionRetryTimer(session: TranslationSession): void {
    if (!this.isSessionCurrent(session)) return;
    const nextDueAt = Math.min(
      ...[...session.retryQueue.values()].map((entry) => entry.dueAt),
    );
    if (!Number.isFinite(nextDueAt)) {
      if (session.retryTimer !== null) this.windowRef.clearTimeout(session.retryTimer);
      session.retryTimer = null;
      session.retryTimerDueAt = null;
      return;
    }
    if (
      session.retryTimer !== null &&
      session.retryTimerDueAt !== null &&
      session.retryTimerDueAt <= nextDueAt
    ) {
      return;
    }
    if (session.retryTimer !== null) this.windowRef.clearTimeout(session.retryTimer);
    session.retryTimerDueAt = nextDueAt;
    session.retryTimer = this.windowRef.setTimeout(() => {
      session.retryTimer = null;
      session.retryTimerDueAt = null;
      if (!this.isSessionCurrent(session)) {
        session.retryQueue.clear();
        session.retryingElements.clear();
        return;
      }
      const now = Date.now();
      let hasReadyRetry = false;
      for (const [element, retry] of session.retryQueue) {
        if (retry.dueAt > now + 25) continue;
        session.retryQueue.delete(element);
        if (!element.isConnected || readPublicText(element) !== retry.text) continue;
        session.processedTexts.delete(element);
        session.retryingElements.add(element);
        hasReadyRetry = true;
      }
      if (hasReadyRetry) {
        session.rerun = true;
        void this.processSession(session);
      }
      this.armSessionRetryTimer(session);
    }, Math.max(0, nextDueAt - Date.now()));
  }

  private clearSessionRetries(session: TranslationSession): void {
    if (session.retryTimer !== null) this.windowRef.clearTimeout(session.retryTimer);
    session.retryTimer = null;
    session.retryTimerDueAt = null;
    session.retryQueue.clear();
    session.retryingElements.clear();
  }

  private logFirstSessionResult(session: TranslationSession): void {
    if (session.firstResultLogged) return;
    session.firstResultLogged = true;
    speedLog(
      "translation-content",
      session.speedTaskId,
      "first_result_rendered",
      session.speedStartedAt,
      {
        request_kind: "loaded_comments",
        translated_count: session.translated + 1,
      },
    );
  }

  private updateSessionStatus(session: TranslationSession, waiting: boolean): void {
    const failed = session.failed > 0 ? `，失败 ${session.failed} 条` : "";
    const retrying = session.retryQueue.size > 0 ? `，等待重试 ${session.retryQueue.size} 条` : "";
    const suffix = waiting ? "；等待新评论" : "";
    const provider = providerLabel(session.providers);
    this.updateToolbarStatus(
      `已翻译 ${session.translated}/${session.attempted} 条${failed}${retrying}${provider ? ` · ${provider}` : ""}${suffix}`,
    );
  }

  private createToolbar(): void {
    if (this.toolbarHost?.isConnected) return;
    const host = this.documentRef.createElement("div");
    host.dataset.tiktokDarenAssistant = "translation-toolbar";
    // 没有公开文案或评论时不占据页面空间；refresh() 找到目标后再显示。
    host.hidden = true;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `${translationStyles}<div class="toolbar" role="toolbar" aria-label="评论区工具">
      <button class="bulk" type="button" title="开始自动翻译" aria-label="开始自动翻译">${iconSvg("translate", { size: 17 })}</button>
      <button class="export-comments" type="button" title="下载全部已加载评论" aria-label="下载全部已加载评论">${iconSvg("document", { size: 17 })}</button>
      <span class="toolbar-status" role="status">评论区翻译工具已就绪</span>
    </div>`;
    const action = shadow.querySelector<HTMLButtonElement>(".bulk");
    const exportComments = shadow.querySelector<HTMLButtonElement>(".export-comments");
    const status = shadow.querySelector<HTMLElement>(".toolbar-status");
    if (!action || !exportComments || !status) throw new Error("无法创建评论区工具栏");
    action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.activeSession) this.stopAutoTranslation();
      else void this.translateLoaded();
    });
    exportComments.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.exportLoadedComments();
    });
    this.documentRef.documentElement.append(host);
    this.toolbarHost = host;
    this.toolbarAction = action;
    this.toolbarExport = exportComments;
    this.toolbarStatus = status;
  }

  private positionToolbar(): void {
    if (!this.toolbarHost) return;
    const commentsRoot = this.documentRef.querySelector<HTMLElement>(
      '[data-e2e="comment-list"], [data-e2e="browse-comment-list"], [class*="DivCommentListContainer"]',
    );
    const hasLoadedComments = [...this.bindings.values()].some(
      (binding) => binding.target.kind === "comment",
    );
    const visible = Boolean(commentsRoot && this.currentContext?.commentsOpen && hasLoadedComments);
    this.toolbarHost.hidden = !visible;
    this.toolbarHost.toggleAttribute("data-in-comments", visible);
    if (!commentsRoot || this.toolbarHost.parentElement === commentsRoot) return;
    commentsRoot.prepend(this.toolbarHost);
  }

  private exportLoadedComments(): void {
    const comments = [...this.bindings.values()]
      .filter((binding) => binding.target.kind === "comment")
      .map((binding) => readPublicText(binding.target.element))
      .filter(Boolean);
    if (comments.length === 0) {
      this.updateToolbarStatus("当前还没有已加载评论");
      return;
    }
    const body = comments.map((comment, index) => `${index + 1}. ${comment}`).join("\r\n\r\n");
    const url = URL.createObjectURL(new Blob([`TikTok 评论导出\r\n\r\n${body}`], {
      type: "text/plain;charset=utf-8",
    }));
    const link = this.documentRef.createElement("a");
    link.href = url;
    link.download = `TikTok评论_${new Date().toISOString().slice(0, 10)}.txt`;
    link.hidden = true;
    this.documentRef.body.append(link);
    link.click();
    link.remove();
    this.windowRef.setTimeout(() => URL.revokeObjectURL(url), 0);
    this.updateToolbarStatus(`已导出 ${comments.length} 条评论`);
  }

  private createBinding(target: PublicTranslationTarget): BoundTranslation {
    const host = this.documentRef.createElement("span");
    host.dataset.tiktokDarenAssistant = "translation";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `${translationStyles}<span class="inline"><button class="single" type="button">译为中文</button><span class="status" hidden></span><span class="result" hidden></span><button class="install-model" type="button" hidden>下载离线翻译包</button><button class="fallback" type="button" hidden>打开 Google 翻译</button></span>`;
    const action = shadow.querySelector<HTMLButtonElement>(".single")!;
    const status = shadow.querySelector<HTMLElement>(".status")!;
    const result = shadow.querySelector<HTMLElement>(".result")!;
    const installModel = shadow.querySelector<HTMLButtonElement>(".install-model")!;
    const fallback = shadow.querySelector<HTMLButtonElement>(".fallback")!;
    const binding: BoundTranslation = {
      target,
      host,
      action,
      status,
      result,
      installModel,
      fallback,
      lastSourceText: null,
      collapsedSourceText: null,
    };
    action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.translateElement(target.element);
    });
    return binding;
  }

  private renderLoading(binding: BoundTranslation): void {
    binding.collapsedSourceText = null;
    binding.action.disabled = true;
    binding.action.textContent = "翻译中…";
    binding.status.hidden = true;
    binding.result.hidden = true;
    binding.installModel.hidden = true;
    binding.fallback.hidden = true;
  }

  private rememberTranslatedResult(text: string, item: TranslationResultItem): void {
    this.translatedItemsByText.delete(text);
    this.translatedItemsByText.set(text, item);
    while (this.translatedItemsByText.size > this.maxRememberedTranslations) {
      const oldestText = this.translatedItemsByText.keys().next().value as string | undefined;
      if (oldestText === undefined) break;
      this.translatedItemsByText.delete(oldestText);
    }
  }

  private restoreTranslatedResult(binding: BoundTranslation): boolean {
    const text = readPublicText(binding.target.element);
    if (binding.collapsedSourceText === text) return false;
    if (binding.collapsedSourceText !== null) binding.collapsedSourceText = null;
    const cached = this.translatedItemsByText.get(text);
    if (cached) {
      // Refresh insertion order so translations revisited during back-scroll
      // stay in the bounded cache longer than old, unseen comments.
      this.rememberTranslatedResult(text, cached);
      this.renderResult(binding, cached);
      return true;
    }
    if (binding.lastSourceText !== null && binding.lastSourceText !== text) {
      binding.lastSourceText = null;
      binding.collapsedSourceText = null;
      binding.action.disabled = false;
      binding.action.textContent = "译为中文";
      binding.status.hidden = true;
      binding.result.hidden = true;
      binding.installModel.hidden = true;
      binding.fallback.hidden = true;
    }
    return false;
  }

  private bindingsInDocumentOrder(): BoundTranslation[] {
    return [...this.bindings.values()].sort((left, right) => {
      const leftElement = left.target.element;
      const rightElement = right.target.element;
      if (leftElement === rightElement) return 0;
      const position = leftElement.compareDocumentPosition(rightElement);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  private renderResult(binding: BoundTranslation, item: TranslationResultItem): void {
    binding.collapsedSourceText = null;
    binding.action.disabled = false;
    binding.action.textContent = "收起译文";
    const provider = item.provider ? providerLabel(new Set([item.provider])) : "";
    binding.status.textContent = provider;
    binding.status.className = "status muted provider";
    binding.status.hidden = !provider;
    binding.lastSourceText = item.source_text;
    binding.result.textContent = item.translated_text;
    binding.result.hidden = false;
    binding.installModel.hidden = true;
    binding.fallback.hidden = true;
  }

  private renderTranslationError(binding: BoundTranslation, error: unknown, text: string): void {
    const message = error instanceof Error ? error.message : "翻译失败，请稍后重试";
    const diagnostic = error instanceof TranslationRequestError
      ? visibleTranslationDiagnostic(error.diagnostic)
      : null;
    this.renderStatus(binding, diagnostic ? `${message}（诊断 ${diagnostic}）` : message, "error");
    if (error instanceof TranslationRequestError && error.requiredModelIds.length > 0) {
      this.showModelInstaller(binding, error.requiredModelIds);
    } else {
      binding.installModel.hidden = true;
    }
    const fallback =
      error instanceof TranslationRequestError && error.fallbackUrl
        ? error.fallbackUrl
        : buildOfficialTranslateUrl(text);
    this.showFallback(binding, fallback);
  }

  private renderStatus(
    binding: BoundTranslation,
    message: string,
    kind: "muted" | "error",
  ): void {
    binding.action.disabled = false;
    binding.action.textContent = "重试翻译";
    binding.result.hidden = true;
    binding.installModel.hidden = true;
    binding.status.textContent = message;
    binding.status.className = `status ${kind}`;
    binding.status.hidden = false;
  }

  private showFallback(binding: BoundTranslation, url: string): void {
    binding.fallback.hidden = false;
    binding.fallback.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openOfficialTranslateFallback(url, this.windowRef);
    };
  }

  private showModelInstaller(binding: BoundTranslation, modelIds: LocalModelId[]): void {
    binding.installModel.hidden = false;
    binding.installModel.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      binding.installModel.disabled = true;
      void chrome.runtime.sendMessage({
        type: "OPEN_SIDE_PANEL",
        view: "models",
        model_ids: modelIds,
      }).then((response: { ok?: boolean; error?: string } | undefined) => {
        if (!response?.ok) throw new Error(response?.error ?? "无法打开离线模型下载界面");
        binding.status.textContent = "已打开离线模型下载界面";
        binding.status.hidden = false;
      }).catch((error) => {
        binding.status.textContent = error instanceof Error ? error.message : "无法打开离线模型下载界面";
        binding.status.hidden = false;
      }).finally(() => {
        binding.installModel.disabled = false;
      });
    };
  }

  private setToolbarMode(mode: "idle" | "busy" | "active"): void {
    if (!this.toolbarAction) return;
    this.toolbarAction.disabled = mode === "busy";
    this.toolbarAction.title = mode === "active" ? "停止自动翻译" : "开始自动翻译";
    this.toolbarAction.setAttribute("aria-label", this.toolbarAction.title);
    this.toolbarAction.setAttribute("aria-pressed", String(mode === "active"));
    this.toolbarAction.dataset.state = mode;
  }

  private updateToolbarStatus(message: string): void {
    if (this.toolbarStatus) this.toolbarStatus.textContent = message;
  }

  private queueRefresh(delayMs = 250): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = this.windowRef.setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, delayMs);
  }
}

export function collectPublicTranslationTargets(
  root: ParentNode = document,
  limit = MAX_LOADED_TRANSLATION_TARGETS,
): PublicTranslationTarget[] {
  const elements: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(TRANSLATABLE_SELECTOR)) elements.push(root);
  for (const element of root.querySelectorAll<HTMLElement>(TRANSLATABLE_SELECTOR)) elements.push(element);
  const targets: PublicTranslationTarget[] = [];
  const seen = new Set<HTMLElement>();
  for (const element of elements) {
    if (targets.length >= Math.max(0, limit)) break;
    if (seen.has(element) || !isAllowedPublicTarget(element)) continue;
    seen.add(element);
    const text = readPublicText(element);
    if (!isMeaningfulTranslationText(text)) continue;
    targets.push({
      element,
      kind: isCommentTranslationTarget(element) ? "comment" : "description",
      text,
    });
  }
  return targets;
}

export function collectPublicTranslationTargetsFromRoots(
  roots: ParentNode[],
  limit = MAX_LOADED_TRANSLATION_TARGETS,
): PublicTranslationTarget[] {
  const targets: PublicTranslationTarget[] = [];
  const seen = new Set<HTMLElement>();
  for (const root of roots) {
    for (const target of collectPublicTranslationTargets(root, limit)) {
      if (seen.has(target.element)) continue;
      seen.add(target.element);
      targets.push(target);
      if (targets.length >= Math.max(0, limit)) return targets;
    }
  }
  return targets;
}

export function buildOfficialTranslateUrl(text: string): string {
  const url = new URL("https://translate.google.com/");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", "zh-CN");
  url.searchParams.set("text", text);
  url.searchParams.set("op", "translate");
  return url.toString();
}

export function openOfficialTranslateFallback(urlValue: string, windowRef: Window = window): boolean {
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" || url.hostname !== "translate.google.com") return false;
    windowRef.open(url.toString(), "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}

function unwrapResponse(response: TranslationResponse): TranslationResultItem[] {
  if (response.ok) return response.data.items;
  throw new TranslationRequestError(
    response.error,
    response.fallback_url ?? null,
    response.diagnostic ?? null,
    response.required_model_ids ?? [],
  );
}

function visibleTranslationDiagnostic(diagnostic: string | null): string | null {
  if (!diagnostic) return null;
  if (diagnostic.includes("fg_queue_timeout")) return "TDA-TR-02";
  if (diagnostic.includes("fg_queue_")) return "TDA-TR-01";
  const tdaCode = diagnostic.match(/TDA-TR-[A-Za-z0-9_-]+/i)?.[0];
  if (tdaCode) return tdaCode.toUpperCase();
  const safe = diagnostic.replace(/[^A-Za-z0-9_.:;-]/g, "").slice(0, 80);
  return safe ? `TDA-TR-00:${safe}` : "TDA-TR-00";
}

function isAllowedPublicTarget(element: HTMLElement): boolean {
  if (element.closest(ASSISTANT_SELECTOR)) return false;
  // 新详情弹层的 comment-level 本身是正文 p；若其内部仍带旧版 .TUXText，
  // 只绑定外层正文，避免同一条评论出现两个按钮和发送两次请求。
  const directCommentText = element.closest<HTMLElement>('p[data-e2e|="comment-level"]');
  if (directCommentText && directCommentText !== element) return false;
  if (
    element.closest(
      "input, textarea, form, [contenteditable], [data-e2e='comment-input'], [data-e2e='comment-input-container']",
    )
  ) return false;
  // TikTok 当前会把评论输入框的 DIV 标记为 data-e2e="comment-text"。
  // 该标记只有位于真实评论层级内时才属于公开评论，不能把草稿入口当作可翻译内容。
  if (
    element.getAttribute("data-e2e") === "comment-text" &&
    !element.closest('[data-e2e="comment-level-1"], [data-e2e="comment-level-2"]')
  ) return false;
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  return true;
}

function readPublicText(element: HTMLElement): string {
  if (element.matches(DESCRIPTION_ROOT_SELECTOR)) {
    const textNodes = Array.from(element.querySelectorAll<HTMLElement>(DESCRIPTION_TEXT_SELECTOR));
    const pieces = textNodes
      .filter((node) => !textNodes.some((other) => other !== node && other.contains(node)))
      .map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const uniquePieces = [...new Set(pieces)];
    if (uniquePieces.length > 0) return uniquePieces.join(" ");
  }
  return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
}

function isCommentTranslationTarget(element: HTMLElement): boolean {
  return element.getAttribute("data-e2e") === "comment-text" || Boolean(
    element.closest('[data-e2e="comment-level-1"], [data-e2e="comment-level-2"]'),
  );
}

function isMeaningfulTranslationText(text: string): boolean {
  if (!text || /^\[(?:贴纸|貼紙|贴图|貼圖|sticker)\]$/i.test(text)) return false;
  return /[\p{L}\p{N}]/u.test(text);
}

function providerLabel(providers: ReadonlySet<TranslationItemProvider>): string {
  const labels: string[] = [];
  if (providers.has("google_translate_web")) labels.push("Google 在线");
  if (providers.has("bing_translate_web")) labels.push("Bing 在线");
  if (providers.has("argos_local")) labels.push("Argos 本地");
  return labels.join(" + ");
}

function isAssistantMutation(target: Node): boolean {
  const element = target instanceof Element ? target : target.parentElement;
  return element?.closest(ASSISTANT_SELECTOR) != null;
}

function nodeBelongsToRoots(target: Node, roots: readonly ParentNode[]): boolean {
  return roots.some((root) =>
    root instanceof Node && (root === target || root.contains(target))
  );
}

function chunkTranslationEntries<T extends { text: string }>(entries: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let characterCount = 0;
  for (const entry of entries) {
    const itemLimit = chunks.length === 0
      ? FIRST_PROGRESSIVE_TRANSLATION_BATCH_SIZE
      : MAX_PROGRESSIVE_TRANSLATION_BATCH_SIZE;
    if (
      current.length >= Math.min(itemLimit, MAX_TRANSLATION_BATCH_SIZE) ||
      characterCount + entry.text.length >
        Math.min(MAX_PROGRESSIVE_TRANSLATION_BATCH_CHARACTERS, MAX_TRANSLATION_BATCH_CHARACTERS)
    ) {
      if (current.length > 0) chunks.push(current);
      current = [];
      characterCount = 0;
    }
    current.push(entry);
    characterCount += entry.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function autoTranslationRetryBaseDelay(error: unknown): number | null {
  if (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) {
    return 3_000;
  }
  if (!(error instanceof TranslationRequestError)) return null;
  const diagnostic = error.diagnostic ?? "";
  if (/rate_limit|http_429/i.test(diagnostic)) return 60_000;
  if (/transport_cooldown|timeout|fetch_failed/i.test(diagnostic)) return 15_000;
  if (/http_5\d\d|invalid|marker|incomplete/i.test(diagnostic)) return 3_000;
  return null;
}

const translationStyles = `<style>
  :host { display: inline; color-scheme: light dark; font-family: "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; }
  button { font: inherit; }
  .inline { display: inline-flex; max-width: 100%; flex-wrap: wrap; align-items: center; gap: 6px; margin: 4px 0; }
  .single, .fallback, .install-model { cursor: pointer; border: 0; border-radius: 6px; padding: 3px 7px; color: #175cd3; background: #eef4ff; font-size: 11px; font-weight: 700; }
  .single:disabled, .install-model:disabled { cursor: wait; opacity: .65; }
  .install-model { color: #fff; background: #2563eb; }
  .fallback { color: #475467; background: #f2f4f7; }
  .status, .result { font-size: 12px; line-height: 1.55; }
  .status.muted { color: #667085; }
  .status.error { color: #b42318; }
  .result { flex-basis: 100%; box-sizing: border-box; padding: 6px 8px; border-left: 2px solid #fe2c55; color: #344054; background: rgba(255,255,255,.92); }
  :host([hidden]) { display: none !important; }
  :host([data-in-comments]) { display: block; position: sticky; top: 0; z-index: 5; }
  .toolbar { display: flex; width: max-content; align-items: center; gap: 3px; margin: 6px 10px 6px auto; padding: 3px; border: 1px solid #edf0f4; border-radius: 8px; color: #2563eb; background: rgba(249,250,252,.96); box-shadow: none; }
  .bulk, .export-comments { display: grid; width: 28px; height: 28px; place-items: center; padding: 0; cursor: pointer; border: 0; border-radius: 6px; color: #2563eb; background: transparent; }
  .bulk[aria-pressed="true"] { color: #fff; background: #2563eb; }
  .bulk:hover, .export-comments:hover { background: #eaf2ff; }
  .bulk[aria-pressed="true"]:hover { background: #1d4ed8; }
  .bulk:focus-visible, .export-comments:focus-visible { outline: 2px solid #4b8cff; outline-offset: 2px; }
  .bulk:disabled, .export-comments:disabled { cursor: wait; opacity: .5; }
  .toolbar-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  [hidden] { display: none !important; }
  @media (prefers-color-scheme: dark) {
    .single { color: #9ec5ff; background: #20314e; }
    .fallback { color: #d0d5dd; background: #30343d; }
    .result { color: #eceff4; background: rgba(28,31,38,.94); }
  }
</style>`;
