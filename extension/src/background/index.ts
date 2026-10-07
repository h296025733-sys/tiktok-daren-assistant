import {
  GOOGLE_TRANSLATION_ARRAY_ENDPOINT,
  GOOGLE_TRANSLATE_HTML_API_KEY,
  GOOGLE_TRANSLATE_HTML_ENDPOINT,
  isTranslationRequest,
  TranslationService,
  type BingBootstrapStore,
  type TranslationCooldownStore,
} from "./translationService";
import { safeSuggestedFilename, saveDownloadFilesAs, type DownloadableFile } from "../downloads/saveAs";
import {
  CARD_MEDIA_DOWNLOAD_QUEUE_KEY,
  MAX_PENDING_CARD_DOWNLOADS,
  usableQueuedCardDownloads,
} from "../downloads/cardQueue";
import { saveBrowserVideo } from "../media/browserMedia";
import {
  CHROME_ONLY_MODE,
  CHROME_ONLY_BUILD_MARKER,
  installChromeOnlyLoopbackGuard,
} from "../runtimeMode";
import { batchDownloadPollingTimeoutMs } from "../downloads/batchLimit";
import {
  FOREGROUND_TRANSLATION_QUEUE_KEY,
  FOREGROUND_TRANSLATION_RESULTS_KEY,
  sanitizeForegroundTranslationRequest,
  usableForegroundTranslationResults,
  usableQueuedForegroundTranslations,
} from "../translation/foregroundQueue";
import type {
  CardMediaDownloadRequest,
  CardMediaDownloadResponse,
  BatchMediaDescriptor,
  CancelTranslationTaskRequest,
  CancelTranslationTaskResponse,
  CurrentMediaDescriptor,
  ForegroundTranslationJobResult,
  PollForegroundTranslationResponse,
  PrepareForegroundTranslationResponse,
  QueueForegroundTranslationResponse,
  QueuedForegroundTranslation,
  ProfileBatchDownloadRequest,
  ProfileBatchDownloadResponse,
  ProfileBatchProgressMessage,
  PageMediaSaveResponse,
  WarmTranslationProviderRequest,
  WarmTranslationProviderResponse,
  GetKnownAdVideoIdsRequest,
  KnownAdVideoIdsResponse,
  KnownAdVideoIdsSyncMessage,
  ReportKnownAdVideoRequest,
} from "../types/messages";
import { LOCAL_MODEL_IDS, type LocalModelId } from "../types/messages";
import { readSpeedTaskId, speedLog, speedNow } from "../shared/speedDiagnostics";
import {
  appendKnownAdVideoIds,
  normalizeKnownAdVideoIds,
} from "./adClassificationCache";
import { LICENSE_API_ORIGIN, LICENSE_ENFORCED } from "../license/config";
import { isLicenseRequest } from "../license/types";
import { LicenseManager } from "./licenseManager";

installChromeOnlyLoopbackGuard(CHROME_ONLY_MODE, LICENSE_ENFORCED ? [LICENSE_API_ORIGIN] : []);

const GOOGLE_TRANSLATION_COOLDOWN_KEY = "googleTranslationCooldownsV1";
const BING_TRANSLATION_BOOTSTRAP_KEY = "bingTranslationBootstrapV1";
const translationCooldownStore: TranslationCooldownStore = {
  async load() {
    const stored = await chrome.storage.session.get(GOOGLE_TRANSLATION_COOLDOWN_KEY);
    return stored[GOOGLE_TRANSLATION_COOLDOWN_KEY];
  },
  async save(cooldowns) {
    await chrome.storage.session.set({
      [GOOGLE_TRANSLATION_COOLDOWN_KEY]: cooldowns,
    });
  },
};
const bingBootstrapStore: BingBootstrapStore = {
  async load() {
    const stored = await chrome.storage.session.get(BING_TRANSLATION_BOOTSTRAP_KEY);
    return stored[BING_TRANSLATION_BOOTSTRAP_KEY];
  },
  async save(bootstrap) {
    await chrome.storage.session.set({
      [BING_TRANSLATION_BOOTSTRAP_KEY]: bootstrap,
    });
  },
  async clear() {
    await chrome.storage.session.remove(BING_TRANSLATION_BOOTSTRAP_KEY);
  },
};
const translationService = new TranslationService({
  cooldownStore: translationCooldownStore,
  bingBootstrapStore,
  ...(CHROME_ONLY_MODE
    ? {
        googleArrayEndpoint: GOOGLE_TRANSLATION_ARRAY_ENDPOINT,
        googleTranslateHtmlEndpoint: GOOGLE_TRANSLATE_HTML_ENDPOINT,
        googleTranslateHtmlApiKey: GOOGLE_TRANSLATE_HTML_API_KEY,
        googleEndpoints: [],
        localFallbackEndpoints: [],
      }
    : {}),
});
console.info("[TikTok 达人助手] Release mode", CHROME_ONLY_BUILD_MARKER);
const LOCAL_API_BASE = "http://localhost:8765";
const SIDE_PANEL_INTENT_KEY = "sidePanelIntent";
const SIDE_PANEL_OPEN_TIMEOUT_MS = 6_000;
const KNOWN_AD_VIDEO_IDS_KEY = "knownAdVideoIdsV1";
let foregroundTranslationQueueUpdate = Promise.resolve();
let knownAdCacheUpdate = Promise.resolve();
const activeTranslationTasks = new Map<string, Set<AbortController>>();
const licenseManager = new LicenseManager();
void licenseManager.initialize().catch((error) => {
  console.error("[TikTok 达人助手] 初始化设备授权失败", error);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  console.error("[TikTok 达人助手] 初始化侧边栏行为失败", error);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.error("[TikTok 达人助手] 设置侧边栏行为失败", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.error("[TikTok 达人助手] 设置侧边栏行为失败", error);
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch((error) => {
    console.error("[TikTok 达人助手] 打开侧边栏失败", error);
  });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isLicenseRequest(message)) {
    const operation = message.type === "ACTIVATE_LICENSE"
      ? licenseManager.activate(message)
      : licenseManager.getStatus(message);
    void operation
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        authorized: false,
        status: "unreachable",
        message: error instanceof Error ? error.message : "设备授权验证失败",
      }));
    return true;
  }

  if (isOpenSidePanelRequest(message)) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, error: "无法确定当前 TikTok 标签页" });
      return false;
    }

    const view = readRequestedSidePanelView(message);
    const modelIds = view === "models" ? sanitizeLocalModelIds(message.model_ids) : [];
    // 必须在消息监听器的同步调用链里先发起 open，避免前面的存储、广告同步或
    // 其他异步工作消耗 Chrome 传递过来的用户点击权限。按窗口打开可绕开某个
    // 标签页曾被设为 disabled 后 tabId 打不开的状态；窗口就是本次点击所在窗口。
    const panelOpening = sender.tab?.windowId !== undefined
      ? chrome.sidePanel.open({ windowId: sender.tab.windowId })
      : chrome.sidePanel.open({ tabId });
    const rememberIntent = chrome.storage.session.set({
      [SIDE_PANEL_INTENT_KEY]: {
        tab_id: tabId,
        view,
        requested_at: Date.now(),
        ...(modelIds.length ? { model_ids: modelIds } : {}),
      },
    });

    void settleSidePanelOpen(panelOpening, SIDE_PANEL_OPEN_TIMEOUT_MS)
      .then(async () => {
        // 侧栏已经打开时，即使本次 session 写入失败也不应把打开动作判成失败。
        await rememberIntent.catch((error) => {
          console.warn("[TikTok 达人助手] 记录侧栏目标页面失败", error);
        });
        if (view !== "overview") {
          await chrome.runtime.sendMessage({
            type: "SIDE_PANEL_VIEW",
            view,
            ...(modelIds.length ? { model_ids: modelIds } : {}),
          }).catch(() => undefined);
        }
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.error("[TikTok 达人助手] 从页面浮层打开侧边栏失败", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? `侧边栏打开失败：${error.message}` : "侧边栏打开失败",
        });
      });
    return true;
  }

  if (isReportKnownAdVideoRequest(message)) {
    const sourceTabId = sender.tab?.id;
    if (sourceTabId === undefined) {
      sendResponse({ ok: false, error: "无法确认广告识别结果来自哪个 TikTok 页面" } satisfies KnownAdVideoIdsResponse);
      return false;
    }
    void rememberKnownAdVideos(message.video_ids, sourceTabId)
      .then((videoIds) => sendResponse({ ok: true, video_ids: videoIds } satisfies KnownAdVideoIdsResponse))
      .catch(() => sendResponse({ ok: false, error: "广告识别结果暂时无法同步" } satisfies KnownAdVideoIdsResponse));
    return true;
  }

  if (isGetKnownAdVideoIdsRequest(message)) {
    void readKnownAdVideoIds()
      .then((videoIds) => sendResponse({ ok: true, video_ids: videoIds } satisfies KnownAdVideoIdsResponse))
      .catch(() => sendResponse({ ok: false, error: "广告识别缓存暂时无法读取" } satisfies KnownAdVideoIdsResponse));
    return true;
  }

  if (isCardMediaDownloadRequest(message)) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, error: "无法确定当前视频卡片所在标签页" } satisfies CardMediaDownloadResponse);
      return false;
    }
    const requestId = crypto.randomUUID();
    // Single-card actions stay on the TikTok page. The service worker stages the
    // file through the local backend and opens Chrome's native Save As dialog,
    // so downloading a video or audio track no longer expands the side panel.
    const operation = message.mode === "audio_track"
      ? enqueueCardAudioForSidepanel(message.media, tabId, requestId)
      : CHROME_ONLY_MODE
        ? savePageMedia(message.media, tabId, requestId)
        : downloadCardMedia(message.media, message.mode);
    void operation
      .then(() => sendResponse({ ok: true, request_id: requestId } satisfies CardMediaDownloadResponse))
      .catch((error) => {
        console.error("[TikTok 达人助手] 卡片下载失败", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "下载失败，请确认本地服务已启动",
        } satisfies CardMediaDownloadResponse);
      });
    return true;
  }

  if (isProfileBatchDownloadRequest(message)) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, error: "无法确定作者主页所在标签页" } satisfies ProfileBatchDownloadResponse);
      return false;
    }
    void downloadProfileBatch(message, tabId)
      .then((response) => sendResponse(response))
      .catch((error) => {
        console.error("[TikTok 达人助手] 作者主页批量下载失败", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "批量下载失败，请确认本地服务已启动",
        } satisfies ProfileBatchDownloadResponse);
      });
    return true;
  }

  if (isPrepareForegroundTranslationRequest(message)) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({
        ok: false,
        error: "无法确定当前翻译所在标签页",
        diagnostic: "fg_prepare_unconfirmed",
      } satisfies PrepareForegroundTranslationResponse);
      return false;
    }
    // This message is dispatched directly from the content button click so the
    // side-panel call still has Chrome user activation.
    void chrome.sidePanel.open({ tabId })
      .then(() => sendResponse({
        ok: true,
        diagnostic: "fg_prepare_opened",
      } satisfies PrepareForegroundTranslationResponse))
      .catch(() => sendResponse({
        ok: true,
        diagnostic: "fg_prepare_unconfirmed",
      } satisfies PrepareForegroundTranslationResponse));
    return true;
  }

  if (isQueueForegroundTranslationRequest(message)) {
    const tabId = sender.tab?.id;
    const request = sanitizeForegroundTranslationRequest(message.request);
    if (tabId === undefined || !request) {
      sendResponse({
        ok: false,
        error: "本地翻译请求无效",
        diagnostic: "fg_queue_invalid",
      } satisfies QueueForegroundTranslationResponse);
      return false;
    }
    const queued: QueuedForegroundTranslation = {
      request_id: crypto.randomUUID(),
      tab_id: tabId,
      requested_at: Date.now(),
      request,
    };
    const panelOpening = chrome.sidePanel.open({ tabId }).then(
      () => true,
      () => false,
    );
    void enqueueForegroundTranslation(queued)
      .then(async () => {
        const panelOpened = await panelOpening;
        sendResponse({
          ok: true,
          request_id: queued.request_id,
          diagnostic: panelOpened ? "fg_queue_enqueued" : "fg_queue_panel_unconfirmed",
        } satisfies QueueForegroundTranslationResponse);
      })
      .catch(() => sendResponse({
        ok: false,
        error: "无法建立本地翻译队列，请重试",
        diagnostic: "fg_queue_message_failed",
      } satisfies QueueForegroundTranslationResponse));
    return true;
  }

  if (isPollForegroundTranslationRequest(message)) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({
        ok: false,
        error: "无法确定当前翻译所在标签页",
        diagnostic: "fg_queue_message_failed",
      } satisfies PollForegroundTranslationResponse);
      return false;
    }
    void pollForegroundTranslation(message.request_id, tabId)
      .then(sendResponse)
      .catch(() => sendResponse({
        ok: false,
        error: "无法读取本地翻译结果，请重试",
        diagnostic: "fg_queue_message_failed",
      } satisfies PollForegroundTranslationResponse));
    return true;
  }

  if (isCancelTranslationTaskRequest(message)) {
    const controllers = activeTranslationTasks.get(message.task_id);
    const cancelledRequests = controllers?.size ?? 0;
    if (controllers) {
      activeTranslationTasks.delete(message.task_id);
      for (const controller of controllers) controller.abort();
    }
    sendResponse({
      ok: true,
      cancelled_requests: cancelledRequests,
    } satisfies CancelTranslationTaskResponse);
    return false;
  }

  if (isTranslationRequest(message)) {
    const taskId =
      readTranslationTaskId(message) || readSpeedTaskId(message, "translation-background");
    const startedAt = speedNow();
    const controller = registerTranslationTask(taskId);
    speedLog("translation.background", taskId, "message_received", startedAt, {
      request_type: message.type,
      sender_tab_id: sender.tab?.id ?? null,
    });
    void translationService
      .handle(message, controller.signal)
      .then((response) => {
        speedLog("translation.background", taskId, "handler_complete", startedAt, {
          ok: response.ok,
        });
        sendResponse(response);
      })
      .catch((error) => {
        speedLog("translation.background", taskId, "handler_failed", startedAt, {
          error_name: error instanceof Error ? error.name : "unknown",
        });
        console.error("[TikTok 达人助手] 按需翻译处理失败", error);
        sendResponse({
          ok: false,
          error: "翻译服务暂时不可用，请稍后重试",
          code: "PROVIDER_UNAVAILABLE",
        });
      })
      .finally(() => unregisterTranslationTask(taskId, controller));
    return true;
  }

  if (isWarmTranslationProviderRequest(message)) {
    const taskId = readSpeedTaskId(message, "translation-warmup");
    void translationService
      .warmOnlineProvider(taskId)
      .then(() => sendResponse({ ok: true } satisfies WarmTranslationProviderResponse))
      .catch((error) => {
        speedLog("translation.background", taskId, "warmup_failed", undefined, {
          error_name: error instanceof Error ? error.name : "unknown",
        });
        sendResponse({
          ok: false,
          error: "在线翻译准备暂时失败",
        } satisfies WarmTranslationProviderResponse);
      });
    return true;
  }

  return false;
});

function isOpenSidePanelRequest(
  value: unknown,
): value is { type: "OPEN_SIDE_PANEL"; view?: unknown; model_ids?: unknown } {
  return isRecord(value) && value.type === "OPEN_SIDE_PANEL";
}

function readRequestedSidePanelView(
  request: { view?: unknown },
): "overview" | "subtitles" | "models" {
  return request.view === "subtitles" || request.view === "models" ? request.view : "overview";
}

function settleSidePanelOpen(opening: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome 打开侧栏超时")), timeoutMs);
    opening.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isReportKnownAdVideoRequest(value: unknown): value is ReportKnownAdVideoRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<ReportKnownAdVideoRequest>;
  return request.type === "REPORT_KNOWN_AD_VIDEO" &&
    Array.isArray(request.video_ids) && request.video_ids.length > 0 &&
    request.video_ids.length <= 1_000 &&
    request.video_ids.every((videoId) => typeof videoId === "string" && /^\d{10,25}$/.test(videoId));
}

function isGetKnownAdVideoIdsRequest(value: unknown): value is GetKnownAdVideoIdsRequest {
  return Boolean(value && typeof value === "object" &&
    (value as Partial<GetKnownAdVideoIdsRequest>).type === "GET_KNOWN_AD_VIDEO_IDS");
}

async function readKnownAdVideoIds(): Promise<string[]> {
  await knownAdCacheUpdate.catch(() => undefined);
  const stored = await chrome.storage.session.get(KNOWN_AD_VIDEO_IDS_KEY);
  return normalizeKnownAdVideoIds(stored[KNOWN_AD_VIDEO_IDS_KEY]);
}

async function rememberKnownAdVideos(videoIds: readonly string[], sourceTabId: number): Promise<string[]> {
  let result: string[] = [];
  let added: string[] = [];
  knownAdCacheUpdate = knownAdCacheUpdate.catch(() => undefined).then(async () => {
    const stored = await chrome.storage.session.get(KNOWN_AD_VIDEO_IDS_KEY);
    const current = normalizeKnownAdVideoIds(stored[KNOWN_AD_VIDEO_IDS_KEY]);
    const currentSet = new Set(current);
    added = normalizeKnownAdVideoIds(videoIds).filter((videoId) => !currentSet.has(videoId));
    result = appendKnownAdVideoIds(current, added);
    if (added.length > 0) await chrome.storage.session.set({ [KNOWN_AD_VIDEO_IDS_KEY]: result });
  });
  await knownAdCacheUpdate;
  if (added.length === 0) return result;

  const syncMessage: KnownAdVideoIdsSyncMessage = {
    type: "KNOWN_AD_VIDEO_IDS_SYNC",
    video_ids: added,
  };
  const tabs = await chrome.tabs.query({ url: "https://www.tiktok.com/*" });
  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id !== undefined && tab.id !== sourceTabId)
      .map((tab) => chrome.tabs.sendMessage(tab.id!, syncMessage)),
  );
  return result;
}

function isCardMediaDownloadRequest(value: unknown): value is CardMediaDownloadRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<CardMediaDownloadRequest>;
  return (
    request.type === "DOWNLOAD_CARD_MEDIA" &&
    (request.mode === "video" || request.mode === "audio_track") &&
    typeof request.media?.video_id === "string" &&
    /^\d{10,25}$/.test(request.media.video_id) &&
    typeof request.media.page_url === "string" &&
    request.media.page_url.startsWith("https://www.tiktok.com/")
  );
}

async function enqueueCardAudioForSidepanel(
  media: CurrentMediaDescriptor,
  tabId: number,
  requestId: string,
): Promise<void> {
  const stored = await chrome.storage.session.get(CARD_MEDIA_DOWNLOAD_QUEUE_KEY);
  const queue = usableQueuedCardDownloads(stored[CARD_MEDIA_DOWNLOAD_QUEUE_KEY]);
  queue.push({
    request_id: requestId,
    tab_id: tabId,
    requested_at: Date.now(),
    mode: "audio_track",
    media,
  });
  await chrome.storage.session.set({
    [CARD_MEDIA_DOWNLOAD_QUEUE_KEY]: queue.slice(-MAX_PENDING_CARD_DOWNLOADS),
  });
  await chrome.sidePanel.open({ tabId });
}

function isProfileBatchDownloadRequest(value: unknown): value is ProfileBatchDownloadRequest {
  if (!isRecord(value) || value.type !== "DOWNLOAD_PROFILE_BATCH") return false;
  if (typeof value.request_id !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(value.request_id)) return false;
  if (!Array.isArray(value.items) || value.items.length === 0) return false;
  const ids = new Set<string>();
  for (const raw of value.items) {
    if (!isRecord(raw) || typeof raw.video_id !== "string" || !/^\d{10,25}$/.test(raw.video_id)) return false;
    if (typeof raw.page_url !== "string" || !raw.page_url.startsWith("https://www.tiktok.com/")) return false;
    if (ids.has(raw.video_id)) return false;
    ids.add(raw.video_id);
  }
  return true;
}

interface BackgroundBatchJob {
  job_id: string;
  status: ProfileBatchProgressMessage["status"];
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  errors?: Array<{ video_id?: string; error?: string }>;
}

async function downloadProfileBatch(
  request: ProfileBatchDownloadRequest,
  tabId: number,
): Promise<ProfileBatchDownloadResponse> {
  if (CHROME_ONLY_MODE) return downloadProfileBatchInBrowser(request, tabId);
  let createdResponse: Response | null = null;
  try {
    createdResponse = await fetch(`${LOCAL_API_BASE}/api/v1/downloads/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        create_zip: true,
        items: request.items.map(batchDownloadPayload),
      }),
    });
  } catch {
    // Chrome-only colleague package: use direct media URLs below.
  }
  if (!createdResponse?.ok) return downloadProfileBatchInBrowser(request, tabId);
  let job = await createdResponse.json() as BackgroundBatchJob;
  if (!/^[a-f0-9]{32}$/i.test(job.job_id)) throw new Error("本地服务返回了无效的批量任务 ID");

  // The archive endpoint sends attachment headers immediately and waits for the
  // existing job in its response body. This makes Chrome show Save As at the
  // start of the operation instead of after every video has finished.
  let downloadId: number;
  try {
    downloadId = await chrome.downloads.download({
      url: `${LOCAL_API_BASE}/api/v1/downloads/batches/${job.job_id}/archive`,
      filename: `TikTok_批量视频_${new Date().toISOString().slice(0, 10)}.zip`,
      saveAs: true,
      conflictAction: "uniquify",
    });
  } catch (error) {
    await fetch(`${LOCAL_API_BASE}/api/v1/downloads/batches/${job.job_id}/cancel`, { method: "POST" }).catch(() => undefined);
    throw error;
  }

  await sendProfileBatchProgress(tabId, request.request_id, job);
  const deadline = Date.now() + batchDownloadPollingTimeoutMs(request.items.length);
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() >= deadline) throw new Error("批量任务处理超时，本地服务可能仍在继续运行");
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 800));
    const statusResponse = await fetch(`${LOCAL_API_BASE}/api/v1/downloads/batches/${job.job_id}`);
    if (!statusResponse.ok) throw new Error(await downloadApiError(statusResponse));
    job = await statusResponse.json() as BackgroundBatchJob;
    await sendProfileBatchProgress(tabId, request.request_id, job);
  }
  if (job.status === "failed" || job.status === "cancelled") {
    const firstError = job.errors?.find((item) => typeof item.error === "string")?.error;
    throw new Error(firstError ?? (job.status === "cancelled" ? "批量下载已取消" : "批量下载全部失败"));
  }
  return {
    ok: true,
    request_id: request.request_id,
    download_id: downloadId,
    succeeded: job.succeeded,
    failed: job.failed,
  };
}

async function downloadProfileBatchInBrowser(
  request: ProfileBatchDownloadRequest,
  tabId: number,
): Promise<ProfileBatchDownloadResponse> {
  let succeeded = 0;
  let failed = 0;
  let firstDownloadId = -1;
  for (let index = 0; index < request.items.length; index += 1) {
    const item = request.items[index]!;
    await sendProfileBatchProgress(tabId, request.request_id, {
      job_id: request.request_id,
      status: "running",
      total: request.items.length,
      processed: index,
      succeeded,
      failed,
    });
    try {
      await savePageMedia(item, tabId, `${request.request_id}_${index}`);
      succeeded += 1;
    } catch {
      failed += 1;
    }
  }
  await sendProfileBatchProgress(tabId, request.request_id, {
    job_id: request.request_id,
    status: failed ? "partial" : "completed",
    total: request.items.length,
    processed: request.items.length,
    succeeded,
    failed,
  });
  if (!succeeded) throw new Error("当前页面没有可由 Chrome 直接下载的视频地址");
  return {
    ok: true,
    request_id: request.request_id,
    download_id: firstDownloadId,
    succeeded,
    failed,
  };
}

async function savePageMedia(
  media: Pick<CurrentMediaDescriptor, "video_id" | "media_url" | "author_unique_id" | "author_nickname">,
  tabId: number,
  requestId: string,
): Promise<void> {
  if (!media.media_url) throw new Error("当前页面尚未捕获可下载的视频地址");
  const author = media.author_unique_id || media.author_nickname || "TikTok";
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "SAVE_PAGE_MEDIA",
    request_id: requestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
    media_url: media.media_url,
    file_name: safeSuggestedFilename(`${author}_${media.video_id}.mp4`),
  }) as PageMediaSaveResponse | undefined;
  if (!response?.ok) throw new Error(response?.error ?? "TikTok 页面保存视频失败");
}

function batchDownloadPayload(item: BatchMediaDescriptor): Record<string, unknown> {
  return {
    video_id: item.video_id,
    media_url: item.media_url,
    author_unique_id: item.author_unique_id,
    author_nickname: item.author_nickname,
    description: item.description,
    created_at: item.created_at,
    page_url: item.page_url,
    download_video: true,
    extract_audio: false,
    download_background_music: false,
  };
}

async function sendProfileBatchProgress(
  tabId: number,
  requestId: string,
  job: BackgroundBatchJob,
): Promise<void> {
  const message: ProfileBatchProgressMessage = {
    type: "PROFILE_BATCH_PROGRESS",
    request_id: requestId,
    processed: job.processed,
    total: job.total,
    succeeded: job.succeeded,
    failed: job.failed,
    status: job.status,
  };
  await chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

async function downloadApiError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { detail?: unknown };
    if (typeof payload.detail === "string") return payload.detail;
  } catch {
    // Fall back to the bounded status below.
  }
  return `本地下载服务返回 HTTP ${response.status}`;
}

async function downloadCardMedia(
  media: CurrentMediaDescriptor,
  mode: "video" | "audio_track",
): Promise<void> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 180_000);
  let response: Response | null = null;
  try {
    try {
      response = await fetch(`${LOCAL_API_BASE}/api/v1/downloads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          video_id: media.video_id,
          media_url: media.media_url,
          background_music_url: media.background_music_url,
          author_unique_id: media.author_unique_id,
          author_nickname: media.author_nickname,
          description: media.description,
          music_title: media.music_title,
          created_at: media.created_at,
          page_url: media.page_url,
          download_video: mode === "video",
          extract_audio: mode === "audio_track",
          download_background_music: false,
        }),
      });
    } catch {
      // Chrome-only colleague package: fall through to direct download.
    }
  } finally {
    globalThis.clearTimeout(timeout);
  }
  if (!response?.ok) {
    if (mode === "video" && media.media_url) {
      await saveBrowserVideo(media, true);
      return;
    }
    let message = response ? `本地下载服务返回 HTTP ${response.status}` : "本地服务不可用";
    if (response) {
      try {
        const payload = await response.json() as { detail?: unknown };
        if (typeof payload.detail === "string") message = payload.detail;
      } catch {
        // Keep the bounded HTTP status message when the service returns no JSON.
      }
    }
    throw new Error(message);
  }
  const result = await response.json() as { files?: DownloadableFile[] };
  if (!Array.isArray(result.files) || result.files.length === 0) {
    throw new Error("本地服务没有返回可保存的文件");
  }
  await saveDownloadFilesAs(result.files, { saveAs: true });
}

function enqueueForegroundTranslation(item: QueuedForegroundTranslation): Promise<void> {
  const startedAt = speedNow();
  speedLog("translation.foreground_queue.background", item.request_id, "enqueue_start", startedAt);
  foregroundTranslationQueueUpdate = foregroundTranslationQueueUpdate.catch(() => undefined).then(async () => {
    const readStartedAt = speedNow();
    const stored = await chrome.storage.session.get([
      FOREGROUND_TRANSLATION_QUEUE_KEY,
      FOREGROUND_TRANSLATION_RESULTS_KEY,
    ]);
    speedLog("translation.foreground_queue.background", item.request_id, "storage_read_complete", readStartedAt);
    const queue = usableQueuedForegroundTranslations(stored[FOREGROUND_TRANSLATION_QUEUE_KEY]);
    const results = usableForegroundTranslationResults(stored[FOREGROUND_TRANSLATION_RESULTS_KEY]);
    queue.push(item);
    const writeStartedAt = speedNow();
    await chrome.storage.session.set({
      [FOREGROUND_TRANSLATION_QUEUE_KEY]: queue.slice(-20),
      [FOREGROUND_TRANSLATION_RESULTS_KEY]: results,
    });
    speedLog("translation.foreground_queue.background", item.request_id, "storage_write_complete", writeStartedAt, {
      queue_size: Math.min(queue.length, 20),
    });
  });
  void foregroundTranslationQueueUpdate.then(
    () => speedLog("translation.foreground_queue.background", item.request_id, "enqueue_complete", startedAt),
    (error) => speedLog("translation.foreground_queue.background", item.request_id, "enqueue_failed", startedAt, {
      error_name: error instanceof Error ? error.name : "unknown",
    }),
  );
  return foregroundTranslationQueueUpdate;
}

async function pollForegroundTranslation(
  requestId: string,
  tabId: number,
): Promise<PollForegroundTranslationResponse> {
  const startedAt = speedNow();
  await foregroundTranslationQueueUpdate.catch(() => undefined);
  const stored = await chrome.storage.session.get([
    FOREGROUND_TRANSLATION_QUEUE_KEY,
    FOREGROUND_TRANSLATION_RESULTS_KEY,
  ]);
  const results = usableForegroundTranslationResults(stored[FOREGROUND_TRANSLATION_RESULTS_KEY]);
  const completed = results.find((item: ForegroundTranslationJobResult) =>
    item.request_id === requestId && item.tab_id === tabId
  );
  if (completed) {
    speedLog("translation.foreground_queue.background", requestId, "poll_complete", startedAt, {
      status: "completed",
    });
    return {
      ok: true,
      status: "completed",
      response: completed.response,
      diagnostic: "fg_queue_completed",
    };
  }
  speedLog("translation.foreground_queue.background", requestId, "poll_complete", startedAt, {
    status: "pending",
  });
  return {
    ok: true,
    status: "pending",
    diagnostic: "fg_queue_pending",
  };
}

function isPrepareForegroundTranslationRequest(value: unknown): value is { type: "PREPARE_FOREGROUND_TRANSLATION" } {
  return isRecord(value) && value.type === "PREPARE_FOREGROUND_TRANSLATION";
}

function isWarmTranslationProviderRequest(
  value: unknown,
): value is WarmTranslationProviderRequest {
  return isRecord(value) && value.type === "WARM_TRANSLATION_PROVIDER";
}

function isCancelTranslationTaskRequest(
  value: unknown,
): value is CancelTranslationTaskRequest {
  return isRecord(value) &&
    value.type === "CANCEL_TRANSLATION_TASK" &&
    typeof value.task_id === "string" &&
    /^[a-zA-Z0-9_-]{8,80}$/.test(value.task_id);
}

function readTranslationTaskId(value: unknown): string {
  if (!isRecord(value)) return "";
  const candidate = value.translation_task_id;
  return typeof candidate === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(candidate)
    ? candidate
    : "";
}

function registerTranslationTask(taskId: string): AbortController {
  const controller = new AbortController();
  if (!taskId) return controller;
  const controllers = activeTranslationTasks.get(taskId) ?? new Set<AbortController>();
  controllers.add(controller);
  activeTranslationTasks.set(taskId, controllers);
  return controller;
}

function unregisterTranslationTask(taskId: string, controller: AbortController): void {
  const controllers = activeTranslationTasks.get(taskId);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size === 0) activeTranslationTasks.delete(taskId);
}

function isQueueForegroundTranslationRequest(
  value: unknown,
): value is { type: "QUEUE_FOREGROUND_TRANSLATION"; request: unknown } {
  return isRecord(value) && value.type === "QUEUE_FOREGROUND_TRANSLATION" && "request" in value;
}

function isPollForegroundTranslationRequest(
  value: unknown,
): value is { type: "GET_FOREGROUND_TRANSLATION_RESULT"; request_id: string } {
  return isRecord(value) && value.type === "GET_FOREGROUND_TRANSLATION_RESULT" &&
    typeof value.request_id === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value.request_id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeLocalModelIds(value: unknown): LocalModelId[] {
  if (!Array.isArray(value)) return [];
  const allowed = LOCAL_MODEL_IDS as readonly string[];
  return [...new Set(value.filter((item): item is LocalModelId =>
    typeof item === "string" && allowed.includes(item)))];
}
