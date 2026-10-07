import "./style.css";
import {
  CARD_MEDIA_DOWNLOAD_QUEUE_KEY,
  usableQueuedCardDownloads,
} from "../downloads/cardQueue";
import {
  batchDownloadPollingTimeoutMs,
} from "../downloads/batchLimit";
import {
  safeSuggestedFilename,
  saveDownloadFileAs,
  saveDownloadFilesAs,
} from "../downloads/saveAs";
import {
  pickBatchArchiveTarget,
  pickSingleMediaTarget,
  writeBatchArchiveTarget,
  writeSingleMediaTarget,
} from "../downloads/browserWorkflow";
import { resolveFreshTikTokMediaUrl } from "../downloads/tiktokMediaResolver";
import { saveBrowserAudioWav } from "../media/browserMedia";
import {
  BROWSER_SPEECH_MODEL_ESTIMATED_BYTES,
  browserSpeechModelIsReady,
  prepareBrowserSpeechModel,
  transcribeMediaUrl,
  transcribeStagedAudio,
  type BrowserSpeechProgress,
  type BrowserTranscriptionResult,
} from "./browserTranscription";
import {
  parseWebVtt,
  trustedTikTokSubtitleUrl,
  type TikTokWebVttTrack,
  type WebVttSegment,
} from "./webVtt";
import {
  parseSubtitleSessionCache,
  serializeSubtitleSessionCache,
} from "./subtitleSessionCache";
import {
  MAX_TRANSLATION_BATCH_CHARACTERS,
  MAX_TRANSLATION_BATCH_SIZE,
} from "../background/translationService";
import {
  ForegroundTranslationBackend,
  translationProviderLabel,
} from "../translation/foregroundBackend";
import {
  FOREGROUND_TRANSLATION_QUEUE_KEY,
  FOREGROUND_TRANSLATION_RESULTS_KEY,
  usableForegroundTranslationResults,
  usableQueuedForegroundTranslations,
} from "../translation/foregroundQueue";
import { iconSvg, type IconName } from "../ui/icons";
import { formatCount, formatDateFull, formatDuration } from "../ui/formatter";
import {
  CHROME_ONLY_MODE,
  CHROME_ONLY_BUILD_MARKER,
  installChromeOnlyLoopbackGuard,
} from "../runtimeMode";
import {
  createSpeedTaskId,
  SPEED_DIAGNOSTICS_ENABLED,
  speedLog,
  speedNow,
  withSpeedTask,
} from "../shared/speedDiagnostics";
import { LICENSE_API_ORIGIN, LICENSE_ENFORCED } from "../license/config";
import type { LicenseStatus } from "../license/types";
import type {
  BatchMediaDescriptor,
  BatchMediaDescriptorsResponse,
  CancelTranslationTaskResponse,
  ContainerSummaryResponse,
  ContentResponse,
  CurrentTikTokCaption,
  CurrentTikTokCaptionResponse,
  CurrentMediaDescriptor,
  DiagnosticResponse,
  ForegroundTranslationJobResult,
  MediaDescriptorResponse,
  PageUpdateMessage,
  PageMediaChunkResponse,
  PageMediaSaveResponse,
  QueuedCardMediaDownload,
  QueuedForegroundTranslation,
  TranslationRequest,
  TranslationResultItem,
  TranslationResponse,
  WarmTranslationProviderResponse,
} from "../types/messages";
import {
  LOCAL_MODEL_IDS,
  type LocalModelId,
  type LocalModelsResponse,
  type LocalModelStatus,
} from "../types/messages";
import type {
  ContainerStructureExport,
  DiagnosticInfo,
  SavedSnapshot,
  Snapshot,
} from "../types/snapshot";

// Use localhost rather than the numeric loopback address so Windows' <local>
// proxy bypass applies consistently to extension pages and service workers.
const API_BASE = "http://localhost:8765";
const SIDE_PANEL_INTENT_KEY = "sidePanelIntent";
const AUTO_SUBTITLE_SETTINGS_KEY = "autoSubtitleSettingsV1";
const AUTO_SUBTITLE_SESSION_CACHE_KEY = "autoSubtitleSessionCacheV1";
const AUTO_SUBTITLE_DEBOUNCE_MS = 260;
const AUTO_SUBTITLE_BUSY_RETRY_MS = 900;
const AUTO_SUBTITLE_RETRY_DELAYS_MS = [180, 400, 800, 1_400, 2_400] as const;
const AUTO_SUBTITLE_CACHE_LIMIT = 12;
installChromeOnlyLoopbackGuard(CHROME_ONLY_MODE, LICENSE_ENFORCED ? [LICENSE_API_ORIGIN] : []);

const foregroundTranslationService = new ForegroundTranslationBackend({
  chromeOnly: CHROME_ONLY_MODE,
});
document.documentElement.dataset.tdaRelease = CHROME_ONLY_BUILD_MARKER;

function icon(name: IconName, className = "icon"): string {
  return iconSvg(name, { className });
}

document.querySelector<HTMLElement>("#app")!.innerHTML = `
  <section id="license-gate" class="license-gate" hidden aria-labelledby="license-title">
    <div class="license-card">
      <span class="brand-mark license-brand" aria-hidden="true">T</span>
      <p class="eyebrow">公司内部设备授权</p>
      <h1 id="license-title">绑定这台电脑</h1>
      <p class="license-description">输入主控发放的一次性激活码。绑定成功后这台电脑会自动登录，这个激活码不能再绑定第二台电脑。</p>
      <form id="license-form" class="license-form">
        <label for="license-key">一次性设备激活码</label>
        <input id="license-key" type="text" inputmode="text" autocomplete="off" spellcheck="false" maxlength="48" placeholder="TDA-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX">
        <button id="license-activate-button" class="button button-primary" type="submit">绑定并开始使用</button>
      </form>
      <p id="license-message" class="license-message" role="status"></p>
      <button id="license-retry-button" class="text-button" type="button" hidden>重新连接主控</button>
    </div>
  </section>
  <div id="licensed-app">
  <header class="product-header">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">T</span>
      <div>
        <p class="eyebrow">公司内部工具 · 0.1.28</p>
        <h1>TikTok 达人助手</h1>
      </div>
    </div>
    <span id="service-badge" class="badge badge-checking">正在检查服务</span>
  </header>

  <section class="notice" id="notice" hidden></section>

  <section class="status-card" aria-label="当前识别状态">
    <div class="status-line">
      <span class="status-label">当前页面</span>
      <span id="page-type" class="page-chip">识别中</span>
    </div>
    <div class="status-line status-secondary">
      <span class="recognition"><span id="recognition-dot" class="status-dot status-dot-loading"></span><span id="recognition-status">正在识别当前视频</span></span>
      <time id="refresh-time">尚未更新</time>
    </div>
  </section>

  <section class="panel-section" aria-labelledby="metrics-title">
    <div class="section-heading">
      <div><p class="section-kicker">数据摘要</p><h2 id="metrics-title">当前视频表现</h2></div>
      <span class="section-hint">实时采集</span>
    </div>
    <div class="metrics-grid">
      <article class="metric-card" data-metric="play"><span class="metric-icon">${icon("play")}</span><div><span>播放</span><strong id="play-count">暂未获取</strong></div></article>
      <article class="metric-card" data-metric="like"><span class="metric-icon">${icon("heart")}</span><div><span>点赞</span><strong id="like-count">暂未获取</strong></div></article>
      <article class="metric-card" data-metric="comment"><span class="metric-icon">${icon("comment")}</span><div><span>评论</span><strong id="comment-count">暂未获取</strong></div></article>
      <article class="metric-card" data-metric="collect"><span class="metric-icon">${icon("bookmark")}</span><div><span>收藏</span><strong id="collect-count">暂未获取</strong></div></article>
      <article class="metric-card" data-metric="share"><span class="metric-icon">${icon("share")}</span><div><span>分享</span><strong id="share-count">暂未获取</strong></div></article>
      <article class="metric-card" data-metric="duration"><span class="metric-icon">${icon("clock")}</span><div><span>时长</span><strong id="duration">暂未获取</strong></div></article>
    </div>
  </section>

  <section class="panel-section video-section" aria-labelledby="video-info-title">
    <div class="section-heading compact-heading">
      <div><p class="section-kicker">视频信息</p><h2 id="video-info-title">内容与作者</h2></div>
    </div>
    <dl class="info-list">
      <div><dt>作者昵称</dt><dd id="nickname">暂未获取</dd></div>
      <div><dt>作者账号</dt><dd id="unique-id">暂未获取</dd></div>
      <div class="description-row"><dt>视频描述</dt><dd><p id="description" class="description-text">暂未获取</p><button id="description-toggle" class="text-button" type="button" aria-expanded="false" hidden>展开描述</button></dd></div>
      <div><dt>发布时间</dt><dd><span id="created-at">暂未获取</span><small id="publish-time-text"></small></dd></div>
      <div><dt>视频 ID</dt><dd class="copy-field"><code id="video-id">暂未获取</code><button id="copy-video-id-button" class="icon-button" type="button" aria-label="复制视频 ID" title="复制视频 ID" disabled>${icon("copy")}</button></dd></div>
    </dl>
  </section>

  <section class="panel-section tools-section" aria-labelledby="tools-title">
    <div class="section-heading compact-heading"><div><p class="section-kicker">操作</p><h2 id="tools-title">当前视频工具</h2></div></div>
    <div class="primary-actions">
      <button id="refresh-button" class="button button-primary" type="button">${icon("refresh", "button-icon")}<span>刷新当前数据</span></button>
      <button id="save-button" class="button" type="button">${icon("save", "button-icon")}<span>保存视频数据</span></button>
      <button id="raw-button" class="button button-subtle" type="button">${icon("data", "button-icon")}<span>查看原始数据</span></button>
    </div>
    <div class="download-block" aria-labelledby="download-title">
      <div class="download-heading"><strong id="download-title">媒体提取</strong><span>下载时选择保存位置</span></div>
      <div class="download-actions">
        <div class="single-download-actions">
          <button id="download-video-button" class="button" type="button" disabled>${icon("export", "button-icon")}<span>下载视频</span></button>
          <button id="download-audio-button" class="button" type="button" disabled>${icon("play", "button-icon")}<span>提取音频</span></button>
          <button id="transcribe-button" class="button" type="button" disabled>${icon("data", "button-icon")}<span>字幕和翻译</span></button>
        </div>
        <label class="subtitle-save-option">
          <input id="subtitle-save-files" type="checkbox">
          <span>同时下载 SRT 字幕</span>
        </label>
        <div class="batch-download-actions">
          <button id="batch-video-button" class="button batch-action" type="button" disabled>${icon("export", "button-icon")}<span>批量下载视频</span></button>
          <button id="batch-audio-button" class="button batch-action" type="button" disabled>${icon("play", "button-icon")}<span>批量提取音频</span></button>
          <button id="cancel-batch-button" class="button button-subtle" type="button" hidden disabled><span>取消批量任务</span></button>
        </div>
      </div>
      <p class="download-note">视频、音频下载时可选择位置；字幕默认在线展示，勾选后才下载 SRT。</p>
      <section class="subtitle-auto-controls" aria-labelledby="subtitle-auto-title">
        <div class="subtitle-auto-heading">
          <div>
            <strong id="subtitle-auto-title">切换视频自动处理</strong>
            <small>推荐流和视频详情页生效</small>
          </div>
          <div class="subtitle-auto-switches">
            <label class="switch-field">
              <span>自动字幕</span>
              <input id="subtitle-auto-enabled" type="checkbox">
              <span class="switch" aria-hidden="true"></span>
            </label>
            <label class="switch-field">
              <span>自动翻译</span>
              <input id="subtitle-auto-translate" type="checkbox" disabled>
              <span class="switch" aria-hidden="true"></span>
            </label>
          </div>
        </div>
        <p id="subtitle-auto-status" role="status">已关闭，手动字幕功能照常使用</p>
      </section>

      <section id="subtitle-panel" class="subtitle-panel" aria-labelledby="subtitle-panel-title" hidden>
        <div class="subtitle-panel-heading">
          <strong id="subtitle-panel-title">字幕和翻译</strong>
          <span id="subtitle-language-detected" class="subtitle-source-language"></span>
        </div>
        <section id="model-requirement-card" class="model-requirement-card" aria-labelledby="model-requirement-title" hidden>
          <div class="model-requirement-copy">
            <span class="model-requirement-icon" aria-hidden="true">${icon("export")}</span>
            <div>
              <strong id="model-requirement-title">需要下载本地模型</strong>
              <p id="model-requirement-description"></p>
              <small id="model-requirement-size"></small>
            </div>
          </div>
          <div id="model-progress" class="model-progress" role="progressbar" aria-label="模型下载进度" aria-valuemin="0" aria-valuemax="100" hidden>
            <span id="model-progress-bar"></span>
          </div>
          <p id="model-progress-text" class="model-progress-text" role="status"></p>
          <div class="model-requirement-actions">
            <button id="model-install-button" class="button button-primary" type="button">下载并继续</button>
            <button id="model-dismiss-button" class="button button-subtle" type="button">暂不下载</button>
          </div>
        </section>
        <div class="subtitle-toolbar">
          <label class="subtitle-language-label" for="subtitle-target-language">
            <span class="sr-only">翻译语言</span>
            <select id="subtitle-target-language" class="subtitle-language-select" aria-label="翻译语言">
              <option value="zh-CN">简体中文</option>
              <option value="zh-TW">繁体中文</option>
              <option value="en">英语</option>
              <option value="ja">日语</option>
              <option value="ko">韩语</option>
              <option value="es">西班牙语</option>
              <option value="fr">法语</option>
              <option value="de">德语</option>
              <option value="pt">葡萄牙语</option>
              <option value="ru">俄语</option>
              <option value="th">泰语</option>
              <option value="vi">越南语</option>
              <option value="id">印尼语</option>
              <option value="ar">阿拉伯语</option>
            </select>
          </label>
          <label class="switch-field expert-switch" title="DeepSeek API 接口预留，当前未配置">
            <span>专家</span>
            <input id="subtitle-expert-mode" type="checkbox" disabled aria-describedby="subtitle-expert-note">
            <span class="switch" aria-hidden="true"></span>
          </label>
          <label class="switch-field">
            <span>双语</span>
            <input id="subtitle-bilingual" type="checkbox" checked>
            <span class="switch" aria-hidden="true"></span>
          </label>
        </div>
        <p id="subtitle-expert-note" class="subtitle-expert-note">待接入 DeepSeek（当前不发送请求）</p>
        <p id="subtitle-translation-status" class="subtitle-translation-status" role="status"></p>
        <div id="subtitle-segments" class="subtitle-segments" aria-live="polite"></div>
      </section>
    </div>

    <details id="technical-details" class="technical-details">
      <summary><span>技术信息</span><small>排查采集问题时使用</small></summary>
      <div class="technical-content">
        <dl class="technical-list">
          <div><dt>当前 URL</dt><dd id="page-url" class="breakable">暂未获取</dd></div>
          <div><dt>数据来源</dt><dd id="source">暂未获取</dd></div>
          <div><dt>可信度</dt><dd id="confidence">暂未获取</dd></div>
          <div><dt>Registry</dt><dd id="registry-status">暂未获取</dd></div>
        </dl>
        <div class="diagnostic-actions">
          <button id="diagnostic-button" class="text-action" type="button">复制采集证据</button>
          <button id="container-summary-button" class="text-action" type="button">复制容器摘要</button>
        </div>
        <section id="raw-card" class="raw-card" hidden>
          <div class="raw-heading"><strong>原始数据</strong><span>仅供排查提取来源</span></div>
          <pre id="raw-data">{}</pre>
        </section>
      </div>
    </details>
  </section>
  </div>
`;

const elements = {
  licenseGate: byId("license-gate"),
  licensedApp: byId("licensed-app"),
  licenseForm: document.querySelector<HTMLFormElement>("#license-form")!,
  licenseKey: inputById("license-key"),
  licenseActivateButton: buttonById("license-activate-button"),
  licenseMessage: byId("license-message"),
  licenseRetryButton: buttonById("license-retry-button"),
  serviceBadge: byId("service-badge"),
  notice: byId("notice"),
  recognitionStatus: byId("recognition-status"),
  recognitionDot: byId("recognition-dot"),
  refreshTime: byId("refresh-time"),
  pageType: byId("page-type"),
  pageUrl: byId("page-url"),
  videoId: byId("video-id"),
  nickname: byId("nickname"),
  uniqueId: byId("unique-id"),
  description: byId("description"),
  createdAt: byId("created-at"),
  publishTimeText: byId("publish-time-text"),
  duration: byId("duration"),
  playCount: byId("play-count"),
  likeCount: byId("like-count"),
  commentCount: byId("comment-count"),
  collectCount: byId("collect-count"),
  shareCount: byId("share-count"),
  source: byId("source"),
  confidence: byId("confidence"),
  registryStatus: byId("registry-status"),
  descriptionToggle: buttonById("description-toggle"),
  copyVideoIdButton: buttonById("copy-video-id-button"),
  refreshButton: buttonById("refresh-button"),
  saveButton: buttonById("save-button"),
  rawButton: buttonById("raw-button"),
  diagnosticButton: buttonById("diagnostic-button"),
  containerSummaryButton: buttonById("container-summary-button"),
  downloadVideoButton: buttonById("download-video-button"),
  downloadAudioButton: buttonById("download-audio-button"),
  transcribeButton: buttonById("transcribe-button"),
  batchVideoButton: buttonById("batch-video-button"),
  batchAudioButton: buttonById("batch-audio-button"),
  cancelBatchButton: buttonById("cancel-batch-button"),
  subtitlePanel: byId("subtitle-panel"),
  modelRequirementCard: byId("model-requirement-card"),
  modelRequirementTitle: byId("model-requirement-title"),
  modelRequirementDescription: byId("model-requirement-description"),
  modelRequirementSize: byId("model-requirement-size"),
  modelProgress: byId("model-progress"),
  modelProgressBar: byId("model-progress-bar"),
  modelProgressText: byId("model-progress-text"),
  modelInstallButton: buttonById("model-install-button"),
  modelDismissButton: buttonById("model-dismiss-button"),
  subtitleSaveFiles: inputById("subtitle-save-files"),
  subtitleAutoEnabled: inputById("subtitle-auto-enabled"),
  subtitleAutoTranslate: inputById("subtitle-auto-translate"),
  subtitleAutoStatus: byId("subtitle-auto-status"),
  subtitleLanguageDetected: byId("subtitle-language-detected"),
  subtitleTargetLanguage: selectById("subtitle-target-language"),
  subtitleBilingual: inputById("subtitle-bilingual"),
  subtitleTranslationStatus: byId("subtitle-translation-status"),
  subtitleSegments: byId("subtitle-segments"),
  rawCard: byId("raw-card"),
  rawData: byId("raw-data"),
  technicalDetails: detailsById("technical-details"),
};

let licenseAuthorized = !LICENSE_ENFORCED;
let authorizedSidePanelInitialized = false;

async function readLicenseStatus(force = false): Promise<LicenseStatus> {
  return chrome.runtime.sendMessage({ type: "GET_LICENSE_STATUS", force }) as Promise<LicenseStatus>;
}

function renderLicenseStatus(result: LicenseStatus): void {
  licenseAuthorized = result.authorized;
  elements.licenseGate.hidden = result.authorized;
  elements.licensedApp.hidden = !result.authorized;
  elements.licenseMessage.textContent = result.message;
  elements.licenseMessage.dataset.status = result.authorized ? "success" : result.status;
  elements.licenseRetryButton.hidden = result.status !== "unreachable";
  elements.licenseForm.hidden = result.status === "revoked";
  if (result.authorized) {
    elements.licenseKey.value = "";
    void initializeAuthorizedSidePanel();
  }
}

async function checkDeviceLicense(force = false): Promise<void> {
  if (!LICENSE_ENFORCED) {
    renderLicenseStatus({ ok: true, authorized: true, status: "disabled", message: "" });
    return;
  }
  elements.licenseGate.hidden = false;
  elements.licensedApp.hidden = true;
  elements.licenseActivateButton.disabled = true;
  elements.licenseMessage.textContent = "正在连接主控电脑…";
  elements.licenseMessage.dataset.status = "checking";
  try {
    renderLicenseStatus(await readLicenseStatus(force));
  } catch (error) {
    renderLicenseStatus({
      ok: false,
      authorized: false,
      status: "unreachable",
      message: error instanceof Error ? `暂时无法连接主控电脑：${error.message}` : "暂时无法连接主控电脑",
    });
  } finally {
    elements.licenseActivateButton.disabled = false;
  }
}

async function activateDeviceLicense(): Promise<void> {
  if (elements.licenseActivateButton.disabled) return;
  const activationKey = elements.licenseKey.value.trim();
  if (!activationKey) {
    elements.licenseMessage.textContent = "请先输入一次性设备激活码";
    elements.licenseMessage.dataset.status = "unbound";
    elements.licenseKey.focus();
    return;
  }
  elements.licenseActivateButton.disabled = true;
  elements.licenseKey.disabled = true;
  elements.licenseMessage.textContent = "正在绑定这台电脑，请不要关闭…";
  elements.licenseMessage.dataset.status = "checking";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "ACTIVATE_LICENSE",
      activation_key: activationKey,
    }) as LicenseStatus;
    renderLicenseStatus(result);
    if (result.authorized) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "LICENSE_ACTIVATED" }).catch(() => undefined);
    }
  } catch (error) {
    renderLicenseStatus({
      ok: false,
      authorized: false,
      status: "unreachable",
      message: error instanceof Error ? `绑定失败：${error.message}` : "绑定失败，请重试",
    });
  } finally {
    elements.licenseActivateButton.disabled = false;
    elements.licenseKey.disabled = false;
  }
}

let currentSnapshot: Snapshot | null = null;
let currentTabId: number | null = null;
let currentSessionId: string | null = null;
let currentGeneration = 0;
let currentSnapshotSequence = 0;
let stateEpoch = 0;
let collectionRequestSequence = 0;
let descriptionExpanded = false;
let mediaOperationBusy = false;
let activeBatchJobId: string | null = null;
let cardDownloadQueueBusy = false;
let cardDownloadQueueRerun = false;
let foregroundTranslationQueueBusy = false;
let foregroundTranslationQueueRerun = false;
let subtitleResult: TranscriptionResponse | null = null;
let subtitleVideoId: string | null = null;
let subtitleAutoStarted = false;
let subtitleTranslationSequence = 0;
let autoSubtitleSettings = {
  enabled: false,
  translate: false,
};
let autoSubtitleTimer: number | null = null;
let autoSubtitleScheduledVideoId: string | null = null;
let autoSubtitleScheduledAt = 0;
let autoSubtitleSequence = 0;
let autoSubtitleWorkingVideoId: string | null = null;
let autoSubtitleError: { videoId: string; message: string } | null = null;
let activeAutoSubtitleController: AbortController | null = null;
let activeAutoSubtitleTranslationTaskId: string | null = null;
let autoSubtitleModelPromptVideoId: string | null = null;
let autoSubtitleWaitingForSpeechVideoId: string | null = null;
const autoSubtitleRetryCounts = new Map<string, number>();
const activeSubtitleTranslationTaskIds = new Set<string>();
interface SubtitleTranslationCache {
  texts: string[];
  providerLabel: string;
}
interface AutoSubtitleCacheEntry {
  result: TranscriptionResponse;
  translations: Map<string, SubtitleTranslationCache>;
}
const subtitleTranslations = new Map<string, SubtitleTranslationCache>();
const autoSubtitleCache = new Map<string, AutoSubtitleCacheEntry>();
let autoSubtitleCachePersistBusy = false;
let autoSubtitleCachePersistAgain = false;

interface TranscriptionRunOptions {
  trigger?: "manual" | "auto";
  expectedVideoId?: string;
  autoSequence?: number;
  signal?: AbortSignal;
}

class AutoSubtitleCancelledError extends Error {
  constructor() {
    super("自动字幕任务已取消");
    this.name = "AutoSubtitleCancelledError";
  }
}

class AutoSubtitleRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoSubtitleRetryableError";
  }
}

function createTranslationTaskId(prefix: string): string {
  const diagnosticTaskId = createSpeedTaskId(prefix);
  if (diagnosticTaskId) return diagnosticTaskId;
  const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "translation";
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${safePrefix}-${Date.now().toString(36)}-${suffix}`;
}

type ModelRequirementReason =
  | "transcription"
  | "browser_transcription"
  | "subtitle_translation"
  | "comment_translation";

interface ModelRequirementContext {
  ids: LocalModelId[];
  reason: ModelRequirementReason;
  message: string;
  videoId: string | null;
  resume: (() => Promise<void>) | null;
  sequence: number;
}

interface ApiFailure {
  code: string | null;
  message: string;
  modelIds: LocalModelId[];
  browserFallback: boolean;
}

class LocalModelRequiredError extends Error {
  constructor(message: string, readonly modelIds: LocalModelId[]) {
    super(message);
    this.name = "LocalModelRequiredError";
  }
}

class SubtitleTranslationCancelledError extends Error {
  constructor() {
    super("字幕翻译任务已取消");
    this.name = "SubtitleTranslationCancelledError";
  }
}

let modelRequirement: ModelRequirementContext | null = null;
let modelUiSequence = 0;
let modelInstallBusy = false;

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素：${id}`);
  return element;
}

function buttonById(id: string): HTMLButtonElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`缺少按钮：${id}`);
  return element;
}

function selectById(id: string): HTMLSelectElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`缺少下拉框：${id}`);
  return element;
}

function inputById(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`缺少输入框：${id}`);
  return element;
}

function detailsById(id: string): HTMLDetailsElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLDetailsElement)) throw new Error(`缺少折叠区域：${id}`);
  return element;
}

function display(value: string | number | null): string {
  return value === null || value === "" ? "暂未获取" : String(value);
}

function formatCreatedAt(value: number | null): string {
  if (value === null) return "暂未获取";
  return formatDateFull(value);
}

function setRecognitionStatus(
  message: string,
  state: "loading" | "success" | "warning" | "error",
): void {
  elements.recognitionStatus.textContent = message;
  elements.recognitionDot.className = `status-dot status-dot-${state}`;
}

function registryLabel(snapshot: Snapshot): string {
  const matched = snapshot.raw_data.registry_match;
  if (typeof matched === "string" && matched) return `已命中 · ${matched}`;
  return matched === null ? "未命中" : "未提供状态";
}

function updateDescription(snapshot: Snapshot | null): void {
  const value = snapshot?.description ?? null;
  elements.description.textContent = display(value);
  const expandable = typeof value === "string" && value.length > 100;
  if (!expandable) descriptionExpanded = false;
  elements.description.classList.toggle("is-expanded", expandable && descriptionExpanded);
  elements.descriptionToggle.hidden = !expandable;
  elements.descriptionToggle.textContent = descriptionExpanded ? "收起描述" : "展开描述";
  elements.descriptionToggle.setAttribute("aria-expanded", String(expandable && descriptionExpanded));
}

const pageTypeLabels: Record<Snapshot["page_type"], string> = {
  home_feed: "首页推荐流",
  video_detail: "单视频详情页",
  profile: "达人主页",
  search: "搜索页",
  hashtag: "Hashtag 页",
  music: "背景音乐页",
  other: "其他 TikTok 页面",
};

function isAutoSubtitleSurface(snapshot: Snapshot | null): boolean {
  if (!snapshot?.video_id || snapshot.raw_data.content_type === "photo") return false;
  return snapshot.raw_data.surface_mode === "home_feed" ||
    snapshot.raw_data.surface_mode === "video_detail";
}

function setAutoSubtitleStatus(
  message: string,
  state: "idle" | "active" | "working" | "success" | "error" = "idle",
): void {
  elements.subtitleAutoStatus.textContent = message;
  elements.subtitleAutoStatus.parentElement?.setAttribute("data-state", state);
}

function renderAutoSubtitleControls(): void {
  elements.subtitleAutoEnabled.checked = autoSubtitleSettings.enabled;
  elements.subtitleAutoTranslate.checked = autoSubtitleSettings.translate;
  elements.subtitleAutoTranslate.disabled = !autoSubtitleSettings.enabled;

  if (!autoSubtitleSettings.enabled) {
    setAutoSubtitleStatus("已关闭，手动字幕功能照常使用");
    return;
  }
  if (!currentSnapshot || !isAutoSubtitleSurface(currentSnapshot)) {
    const message = currentSnapshot?.raw_data.content_type === "photo"
      ? "当前是图文内容，不生成字幕"
      : "已开启；播放或打开视频后会自动处理";
    setAutoSubtitleStatus(message, "active");
    return;
  }
  const videoId = currentSnapshot.video_id!;
  if (autoSubtitleWorkingVideoId === videoId) {
    setAutoSubtitleStatus(
      autoSubtitleSettings.translate ? "正在自动生成并翻译当前视频字幕…" : "正在自动生成当前视频字幕…",
      "working",
    );
    return;
  }
  if (autoSubtitleError?.videoId === videoId) {
    setAutoSubtitleStatus(`当前视频自动处理失败：${autoSubtitleError.message}`, "error");
    return;
  }
  if (
    autoSubtitleTimer !== null &&
    autoSubtitleScheduledVideoId === videoId &&
    (autoSubtitleRetryCounts.get(videoId) ?? 0) > 0
  ) {
    setAutoSubtitleStatus("页面还在切换，正在自动重试当前视频…", "working");
    return;
  }
  if (autoSubtitleWaitingForSpeechVideoId === videoId) {
    setAutoSubtitleStatus("当前视频没有现成字幕，正在等待上一条语音识别退出…", "working");
    return;
  }
  if (
    modelRequirement?.videoId === videoId &&
    (modelRequirement.reason === "transcription" ||
      modelRequirement.reason === "browser_transcription")
  ) {
    setAutoSubtitleStatus("当前视频没有现成字幕，等待你确认下载语音模型", "active");
    return;
  }
  if (autoSubtitleModelPromptVideoId === videoId) {
    setAutoSubtitleStatus("当前视频已按你的选择停止；切换视频后会继续", "active");
    return;
  }
  if (subtitleVideoId === videoId && subtitleResult) {
    const translated = subtitleTranslations.has(elements.subtitleTargetLanguage.value);
    setAutoSubtitleStatus(
      autoSubtitleSettings.translate && translated
        ? "当前视频字幕和翻译已完成；切换视频后会继续"
        : "当前视频字幕已完成；切换视频后会继续",
      "success",
    );
    return;
  }
  setAutoSubtitleStatus(
    autoSubtitleSettings.translate
      ? "已开启；切换视频后自动生成并翻译"
      : "已开启；切换视频后只生成原字幕",
    "active",
  );
}

function rememberCurrentSubtitle(): void {
  if (!subtitleResult || !subtitleVideoId || !subtitleResult.segments.length) return;
  const translations = new Map<string, SubtitleTranslationCache>();
  for (const [language, value] of subtitleTranslations) {
    translations.set(language, {
      texts: [...value.texts],
      providerLabel: value.providerLabel,
    });
  }
  autoSubtitleCache.delete(subtitleVideoId);
  autoSubtitleCache.set(subtitleVideoId, {
    result: subtitleResult,
    translations,
  });
  while (autoSubtitleCache.size > AUTO_SUBTITLE_CACHE_LIMIT) {
    const oldestVideoId = autoSubtitleCache.keys().next().value as string | undefined;
    if (!oldestVideoId) break;
    autoSubtitleCache.delete(oldestVideoId);
  }
  scheduleAutoSubtitleCachePersist();
}

async function loadAutoSubtitleSessionCache(): Promise<void> {
  const storage = chrome.storage?.session;
  if (!storage) return;
  try {
    const stored = await storage.get(AUTO_SUBTITLE_SESSION_CACHE_KEY);
    const parsed = parseSubtitleSessionCache(
      stored[AUTO_SUBTITLE_SESSION_CACHE_KEY],
      AUTO_SUBTITLE_CACHE_LIMIT,
    );
    for (const [videoId, entry] of parsed) {
      autoSubtitleCache.set(videoId, {
        result: {
          ...entry.result,
          audio_file: null,
          transcript_files: [],
        },
        translations: new Map(entry.translations),
      });
    }
  } catch (error) {
    console.error("[TikTok 达人助手] 无法读取本次会话的字幕缓存", error);
  }
}

function scheduleAutoSubtitleCachePersist(): void {
  const storage = chrome.storage?.session;
  if (!storage) return;
  if (autoSubtitleCachePersistBusy) {
    autoSubtitleCachePersistAgain = true;
    return;
  }
  autoSubtitleCachePersistBusy = true;
  void (async () => {
    try {
      do {
        autoSubtitleCachePersistAgain = false;
        await storage.set({
          [AUTO_SUBTITLE_SESSION_CACHE_KEY]: serializeSubtitleSessionCache(
            autoSubtitleCache,
            AUTO_SUBTITLE_CACHE_LIMIT,
          ),
        });
      } while (autoSubtitleCachePersistAgain);
    } catch (error) {
      console.error("[TikTok 达人助手] 无法保存本次会话的字幕缓存", error);
    } finally {
      autoSubtitleCachePersistBusy = false;
    }
  })();
}

function restoreCachedSubtitle(videoId: string): boolean {
  const cached = autoSubtitleCache.get(videoId);
  if (!cached) return false;
  autoSubtitleCache.delete(videoId);
  autoSubtitleCache.set(videoId, cached);
  scheduleAutoSubtitleCachePersist();
  subtitleTranslationSequence += 1;
  subtitleResult = cached.result;
  subtitleVideoId = videoId;
  subtitleTranslations.clear();
  for (const [language, value] of cached.translations) {
    subtitleTranslations.set(language, {
      texts: [...value.texts],
      providerLabel: value.providerLabel,
    });
  }
  elements.subtitlePanel.hidden = false;
  elements.subtitleLanguageDetected.textContent = cached.result.language
    ? `原语言：${cached.result.language}`
    : "原语言：自动识别";
  renderSubtitleSegments();
  setSubtitleTranslationStatus("已恢复刚才生成的字幕", "success");
  return true;
}

function cancelScheduledAutoSubtitle(): void {
  if (autoSubtitleTimer !== null) window.clearTimeout(autoSubtitleTimer);
  autoSubtitleTimer = null;
  autoSubtitleScheduledVideoId = null;
  autoSubtitleScheduledAt = 0;
}

function cancelTranslationTask(taskId: string): void {
  if (!taskId) return;
  void chrome.runtime.sendMessage({
    type: "CANCEL_TRANSLATION_TASK",
    task_id: taskId,
  }).then((response: CancelTranslationTaskResponse | undefined) => {
    speedLog("subtitle.translation", taskId, "task_cancelled", undefined, {
      cancelled_requests: response?.cancelled_requests ?? 0,
    });
  }).catch(() => {
    // The worker may already have finished or gone to sleep. Either way the
    // stale result is still blocked by the local sequence checks.
  });
}

function cancelOutstandingSubtitleTranslations(exceptTaskId = ""): void {
  for (const taskId of activeSubtitleTranslationTaskIds) {
    if (taskId !== exceptTaskId) cancelTranslationTask(taskId);
  }
}

function cancelActiveAutoSubtitle(hidePrompt = false): void {
  activeAutoSubtitleController?.abort();
  activeAutoSubtitleController = null;
  if (activeAutoSubtitleTranslationTaskId) {
    cancelTranslationTask(activeAutoSubtitleTranslationTaskId);
    activeAutoSubtitleTranslationTaskId = null;
  }
  if (
    hidePrompt &&
    autoSubtitleModelPromptVideoId &&
    modelRequirement?.videoId === autoSubtitleModelPromptVideoId
  ) {
    hideModelRequirement();
  }
  if (hidePrompt) autoSubtitleModelPromptVideoId = null;
}

function throwIfAutoSubtitleCancelled(options: TranscriptionRunOptions): void {
  if (options.trigger === "auto" && options.signal?.aborted) {
    throw new AutoSubtitleCancelledError();
  }
}

function autoSubtitleRunIsCurrent(options: TranscriptionRunOptions, videoId: string): boolean {
  if (options.trigger !== "auto") return true;
  return (
    !options.signal?.aborted &&
    autoSubtitleSettings.enabled &&
    options.autoSequence === autoSubtitleSequence &&
    options.expectedVideoId === videoId &&
    currentSnapshot?.video_id === videoId &&
    isAutoSubtitleSurface(currentSnapshot)
  );
}

function autoSubtitleTranslationIsCurrent(videoId: string): boolean {
  return (
    autoSubtitleSettings.enabled &&
    autoSubtitleSettings.translate &&
    currentSnapshot?.video_id === videoId &&
    subtitleVideoId === videoId
  );
}

function scheduleAutoSubtitle(delay = AUTO_SUBTITLE_DEBOUNCE_MS): void {
  if (
    !autoSubtitleSettings.enabled ||
    !currentSnapshot ||
    !isAutoSubtitleSurface(currentSnapshot)
  ) {
    cancelScheduledAutoSubtitle();
    renderAutoSubtitleControls();
    return;
  }
  const videoId = currentSnapshot.video_id!;
  const scheduledAt = performance.now() + Math.max(0, delay);
  if (
    autoSubtitleTimer !== null &&
    autoSubtitleScheduledVideoId === videoId &&
    autoSubtitleScheduledAt <= scheduledAt
  ) {
    return;
  }
  cancelScheduledAutoSubtitle();
  const sequence = autoSubtitleSequence;
  autoSubtitleScheduledVideoId = videoId;
  autoSubtitleScheduledAt = scheduledAt;
  autoSubtitleTimer = window.setTimeout(() => {
    autoSubtitleTimer = null;
    autoSubtitleScheduledVideoId = null;
    autoSubtitleScheduledAt = 0;
    void runAutoSubtitle(videoId, sequence);
  }, Math.max(0, delay));
}

function scheduleAutoSubtitleRetry(videoId: string, message: string): void {
  if (
    !autoSubtitleSettings.enabled ||
    currentSnapshot?.video_id !== videoId ||
    !isAutoSubtitleSurface(currentSnapshot)
  ) {
    return;
  }
  const retryCount = (autoSubtitleRetryCounts.get(videoId) ?? 0) + 1;
  if (retryCount > AUTO_SUBTITLE_RETRY_DELAYS_MS.length) {
    autoSubtitleError = {
      videoId,
      message: `${message}；已自动重试，请停留在本条视频后再试一次`,
    };
    renderAutoSubtitleControls();
    return;
  }
  autoSubtitleRetryCounts.set(videoId, retryCount);
  autoSubtitleError = null;
  scheduleAutoSubtitle(AUTO_SUBTITLE_RETRY_DELAYS_MS[retryCount - 1]);
  renderAutoSubtitleControls();
}

function retryableAutoSubtitleFailure(error: unknown): boolean {
  if (error instanceof AutoSubtitleRetryableError || error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return /尚未|未就绪|暂不可用|页面.*切换|无法读取视频|读取视频.*超时|分块|Failed to fetch|network/i
    .test(error.message);
}

async function resumeAfterSubtitleModel(
  automatic: boolean,
  videoId: string,
): Promise<void> {
  if (!automatic) {
    await transcribeCurrent();
    return;
  }
  autoSubtitleModelPromptVideoId = null;
  autoSubtitleRetryCounts.delete(videoId);
  if (
    autoSubtitleSettings.enabled &&
    currentSnapshot?.video_id === videoId &&
    isAutoSubtitleSurface(currentSnapshot)
  ) {
    scheduleAutoSubtitle(0);
  }
}

async function runAutoSubtitle(videoId: string, sequence: number): Promise<void> {
  if (
    !autoSubtitleSettings.enabled ||
    sequence !== autoSubtitleSequence ||
    currentSnapshot?.video_id !== videoId ||
    !isAutoSubtitleSurface(currentSnapshot)
  ) {
    renderAutoSubtitleControls();
    return;
  }
  if (autoSubtitleError?.videoId === videoId) {
    renderAutoSubtitleControls();
    return;
  }
  if (autoSubtitleModelPromptVideoId === videoId) {
    renderAutoSubtitleControls();
    return;
  }
  // A page-data refresh for the same TikTok video can arrive while its
  // subtitles are already being translated. Keep the existing run instead of
  // starting a duplicate that cancels the still-current translation.
  if (autoSubtitleWorkingVideoId === videoId) {
    renderAutoSubtitleControls();
    return;
  }
  if (subtitleVideoId !== videoId && restoreCachedSubtitle(videoId)) {
    autoSubtitleRetryCounts.delete(videoId);
  }
  if (subtitleVideoId === videoId && subtitleResult) {
    if (
      autoSubtitleSettings.translate &&
      !subtitleTranslations.has(elements.subtitleTargetLanguage.value)
    ) {
      await translateSubtitles(
        elements.subtitleTargetLanguage.value,
        "",
        undefined,
        true,
        videoId,
      );
    }
    renderAutoSubtitleControls();
    return;
  }
  if (autoSubtitleWaitingForSpeechVideoId === videoId && mediaOperationBusy) {
    scheduleAutoSubtitle(AUTO_SUBTITLE_BUSY_RETRY_MS);
    renderAutoSubtitleControls();
    return;
  }
  if (autoSubtitleWaitingForSpeechVideoId === videoId) {
    autoSubtitleWaitingForSpeechVideoId = null;
  }

  cancelActiveAutoSubtitle();
  const controller = new AbortController();
  activeAutoSubtitleController = controller;
  autoSubtitleWorkingVideoId = videoId;
  autoSubtitleError = null;
  renderAutoSubtitleControls();
  try {
    await transcribeCurrent({
      trigger: "auto",
      expectedVideoId: videoId,
      autoSequence: sequence,
      signal: controller.signal,
    });
  } finally {
    if (activeAutoSubtitleController === controller) activeAutoSubtitleController = null;
    if (autoSubtitleWorkingVideoId === videoId) autoSubtitleWorkingVideoId = null;
    renderAutoSubtitleControls();
  }
}

async function loadAutoSubtitleSettings(): Promise<void> {
  const storage = chrome.storage?.local;
  if (!storage) {
    renderAutoSubtitleControls();
    return;
  }
  try {
    const stored = await storage.get(AUTO_SUBTITLE_SETTINGS_KEY);
    const value = stored[AUTO_SUBTITLE_SETTINGS_KEY] as {
      enabled?: unknown;
      translate?: unknown;
    } | undefined;
    autoSubtitleSettings = {
      enabled: value?.enabled === true,
      translate: value?.translate === true,
    };
  } catch (error) {
    console.error("[TikTok 达人助手] 无法读取自动字幕设置", error);
  }
  renderAutoSubtitleControls();
}

async function persistAutoSubtitleSettings(): Promise<void> {
  const storage = chrome.storage?.local;
  if (!storage) return;
  try {
    await storage.set({
      [AUTO_SUBTITLE_SETTINGS_KEY]: { ...autoSubtitleSettings },
    });
  } catch (error) {
    console.error("[TikTok 达人助手] 无法保存自动字幕设置", error);
  }
}

function renderSnapshot(snapshot: Snapshot): void {
  const previousVideoId = currentSnapshot?.video_id ?? null;
  if (previousVideoId !== snapshot.video_id) {
    cancelActiveAutoSubtitle();
    if (previousVideoId) autoSubtitleRetryCounts.delete(previousVideoId);
    autoSubtitleError = null;
    autoSubtitleModelPromptVideoId = null;
    autoSubtitleWaitingForSpeechVideoId = null;
  }
  if (subtitleVideoId !== null && snapshot.video_id !== subtitleVideoId) {
    rememberCurrentSubtitle();
    resetSubtitlePanel();
  }
  currentSnapshot = snapshot;
  const surfaceMode = snapshot.raw_data.surface_mode;
  const contentType = snapshot.raw_data.content_type === "photo" ? "photo" : "video";
  const hasAdMarker = snapshot.raw_data.is_ad === true;
  const hasProductMarker = snapshot.raw_data.has_product === true;
  const isGridCard =
    snapshot.video_id !== null &&
    typeof surfaceMode === "string" &&
    ["profile_grid", "search_grid", "hashtag_grid", "music_grid"].includes(surfaceMode);
  const pageTypeLabel = snapshot.page_type === "video_detail" && contentType === "photo"
    ? "图文详情页"
    : pageTypeLabels[snapshot.page_type];
  const gridSuffix = isGridCard
    ? contentType === "photo" ? "（当前图文卡片）" : "（当前视频卡片）"
    : "";
  const contentFlags = [
    hasAdMarker ? "广告/推广标记" : null,
    hasProductMarker ? "商品/带货锚点" : null,
  ].filter((value): value is string => value !== null);
  elements.pageType.textContent = `${pageTypeLabel}${gridSuffix}${contentFlags.length ? ` · ${contentFlags.join(" · ")}` : ""}`;
  elements.pageUrl.textContent = snapshot.page_url;
  elements.videoId.textContent = display(snapshot.video_id);
  elements.nickname.textContent = display(snapshot.author.nickname);
  elements.uniqueId.textContent = display(snapshot.author.unique_id);
  descriptionExpanded = false;
  updateDescription(snapshot);
  elements.createdAt.textContent = formatCreatedAt(snapshot.created_at);
  // 已有绝对时间时不再叠加相对文本，更不能在有效时间下方显示“暂未获取”。
  const publishTimeText = snapshot.created_at === null
    ? normalisePublishTimeText(snapshot.publish_time_text)
    : "";
  elements.publishTimeText.textContent = publishTimeText;
  elements.publishTimeText.hidden = publishTimeText.length === 0;
  elements.duration.textContent = formatDuration(snapshot.duration_seconds);
  elements.playCount.textContent = formatCount(snapshot.metrics.play_count);
  elements.likeCount.textContent = formatCount(snapshot.metrics.like_count);
  elements.commentCount.textContent = formatCount(snapshot.metrics.comment_count);
  elements.collectCount.textContent = formatCount(snapshot.metrics.collect_count);
  elements.shareCount.textContent = formatCount(snapshot.metrics.share_count);
  elements.source.textContent = snapshot.extraction.source;
  elements.confidence.textContent = confidenceLabel(snapshot.extraction.confidence);
  elements.registryStatus.textContent = registryLabel(snapshot);
  const recognizedLabel = contentType === "photo" ? "当前图文已识别" : "当前视频已识别";
  setRecognitionStatus(
    snapshot.video_id ? recognizedLabel : "页面已识别，暂未取得当前内容",
    snapshot.video_id ? "success" : "warning",
  );
  elements.refreshTime.textContent = `最后更新 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  elements.rawData.textContent = JSON.stringify(snapshot, null, 2);
  elements.saveButton.disabled = snapshot.video_id === null;
  elements.copyVideoIdButton.disabled = snapshot.video_id === null;
  updateDownloadButtons();
  renderAutoSubtitleControls();
  scheduleAutoSubtitle();
}

function updateDownloadButtons(): void {
  const isVideo = Boolean(
    currentSnapshot?.video_id && currentSnapshot.raw_data.content_type !== "photo",
  );
  elements.downloadVideoButton.disabled = mediaOperationBusy || !isVideo;
  elements.downloadAudioButton.disabled = mediaOperationBusy || !isVideo;
  elements.transcribeButton.disabled = mediaOperationBusy || !isVideo;
  const surfaceMode = currentSnapshot?.raw_data.surface_mode;
  const isGrid = typeof surfaceMode === "string" &&
    ["profile_grid", "search_grid", "hashtag_grid", "music_grid"].includes(surfaceMode);
  elements.batchVideoButton.disabled = mediaOperationBusy || !isGrid;
  elements.batchAudioButton.disabled = mediaOperationBusy || !isGrid;
  elements.cancelBatchButton.hidden = activeBatchJobId === null;
  elements.cancelBatchButton.disabled = activeBatchJobId === null;
}

function normalisePublishTimeText(value: string | null): string {
  const text = value?.trim() ?? "";
  return /^(?:暂未获取|--|未知|N\/A)$/i.test(text) ? "" : text;
}

function invalidateSnapshot(url: string): void {
  autoSubtitleSequence += 1;
  cancelScheduledAutoSubtitle();
  cancelActiveAutoSubtitle();
  rememberCurrentSubtitle();
  resetSubtitlePanel();
  currentSnapshot = null;
  elements.pageType.textContent = "识别中";
  elements.pageUrl.textContent = url;
  elements.videoId.textContent = "暂未获取";
  elements.nickname.textContent = "暂未获取";
  elements.uniqueId.textContent = "暂未获取";
  descriptionExpanded = false;
  updateDescription(null);
  elements.createdAt.textContent = "暂未获取";
  elements.publishTimeText.textContent = "";
  elements.publishTimeText.hidden = true;
  elements.duration.textContent = "暂未获取";
  elements.playCount.textContent = "暂未获取";
  elements.likeCount.textContent = "暂未获取";
  elements.commentCount.textContent = "暂未获取";
  elements.collectCount.textContent = "暂未获取";
  elements.shareCount.textContent = "暂未获取";
  elements.source.textContent = "暂未获取";
  elements.confidence.textContent = "暂未获取";
  elements.registryStatus.textContent = "暂未获取";
  elements.rawData.textContent = "{}";
  setRecognitionStatus("正在识别当前视频", "loading");
  elements.refreshTime.textContent = "页面切换中";
  elements.saveButton.disabled = true;
  elements.copyVideoIdButton.disabled = true;
  updateDownloadButtons();
  renderAutoSubtitleControls();
}

function resetPageSession(tabId: number | null, url: string): void {
  stateEpoch += 1;
  currentTabId = tabId;
  currentSessionId = null;
  currentGeneration = 0;
  currentSnapshotSequence = 0;
  collectionRequestSequence += 1;
  invalidateSnapshot(url);
}

function acceptSession(tabId: number, sessionId: string, allowReplace: boolean): boolean {
  if (currentTabId !== tabId) {
    currentTabId = tabId;
    currentSessionId = null;
    currentGeneration = 0;
    currentSnapshotSequence = 0;
    currentSnapshot = null;
  }
  if (currentSessionId === null) {
    currentSessionId = sessionId;
    currentGeneration = 0;
    currentSnapshotSequence = 0;
    return true;
  }
  if (currentSessionId === sessionId) return true;
  if (!allowReplace) return false;
  currentSessionId = sessionId;
  currentGeneration = 0;
  currentSnapshotSequence = 0;
  currentSnapshot = null;
  return true;
}

function confidenceLabel(value: Snapshot["extraction"]["confidence"]): string {
  return { high: "高可信", medium: "中可信", low: "低可信" }[value];
}

function setNotice(message: string, kind: "info" | "success" | "error" = "info"): void {
  elements.notice.textContent = message;
  elements.notice.className = `notice notice-${kind}`;
  elements.notice.hidden = false;
}

function clearNotice(): void {
  elements.notice.hidden = true;
}

async function activeTikTokTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://www.tiktok.com/")) {
    throw new Error("请先在当前窗口打开 TikTok 页面");
  }
  return tab;
}

async function collect(force: boolean): Promise<Snapshot> {
  const tab = await activeTikTokTab();
  const tabId = tab.id!;
  if (currentTabId !== tabId) resetPageSession(tabId, tab.url ?? "https://www.tiktok.com/");
  const requestEpoch = stateEpoch;
  const requestSequence = ++collectionRequestSequence;
  let response: ContentResponse | undefined;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: "COLLECT_CURRENT_PAGE",
      force,
    });
  } catch (error) {
    console.error("[TikTok 达人助手] 无法连接页面采集脚本", error);
    throw new Error("页面采集组件未就绪，请刷新 TikTok 页面后重试");
  }
  if (!response?.ok) throw new Error(response?.error ?? "页面未返回有效数据");
  const liveTab = await activeTikTokTab();
  if (
    requestEpoch !== stateEpoch ||
    requestSequence !== collectionRequestSequence ||
    liveTab.id !== tabId ||
    response.data.page_url !== liveTab.url
  ) {
    throw new Error("页面已切换，已阻止使用上一条视频数据，请重试");
  }
  if (!acceptSession(tabId, response.session_id, true)) {
    throw new Error("页面采集会话已更新，已丢弃旧结果，请重试");
  }
  if (response.generation < currentGeneration) {
    throw new Error("收到过期的视频数据，已自动丢弃，请重试");
  }
  if (
    response.generation === currentGeneration &&
    response.snapshot_sequence < currentSnapshotSequence
  ) {
    throw new Error("收到过期的视频快照，已自动丢弃，请重试");
  }
  currentGeneration = response.generation;
  currentSnapshotSequence = response.snapshot_sequence;
  renderSnapshot(response.data);
  return response.data;
}

async function checkHealth(): Promise<void> {
  if (CHROME_ONLY_MODE) {
    elements.serviceBadge.textContent = "Chrome 兼容模式";
    elements.serviceBadge.className = "badge badge-ok";
    return;
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3_000);
  elements.serviceBadge.textContent = "正在检查服务";
  elements.serviceBadge.className = "badge badge-checking";
  try {
    const response = await fetch(`${API_BASE}/health`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: unknown = await response.json();
    if (
      typeof data !== "object" ||
      data === null ||
      (data as Record<string, unknown>).status !== "ok" ||
      (data as Record<string, unknown>).service !== "tiktok-daren-assistant"
    ) {
      throw new Error("接口返回内容不符合预期");
    }
    elements.serviceBadge.textContent = "本地服务正常";
    elements.serviceBadge.className = "badge badge-ok";
  } catch (error) {
    console.error("[TikTok 达人助手] 本地服务检查失败", error);
    if (error instanceof DOMException && error.name === "AbortError") {
      elements.serviceBadge.textContent = "请求超时";
    } else if (error instanceof TypeError) {
      elements.serviceBadge.textContent = "本地服务未启动";
    } else {
      elements.serviceBadge.textContent = "接口异常";
    }
    elements.serviceBadge.className = "badge badge-error";
  } finally {
    window.clearTimeout(timeout);
  }
}

async function refresh(): Promise<void> {
  elements.refreshButton.disabled = true;
  resetSubtitlePanel();
  clearNotice();
  setRecognitionStatus("正在刷新当前视频", "loading");
  try {
    await collect(true);
  } catch (error) {
    console.error("[TikTok 达人助手] 重新识别失败", error);
    setRecognitionStatus("当前视频识别失败", "error");
    setNotice(error instanceof Error ? error.message : "重新识别失败", "error");
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function save(): Promise<void> {
  elements.saveButton.disabled = true;
  clearNotice();
  try {
    const freshSnapshot = await collect(true);
    if (!freshSnapshot.video_id) {
      throw new Error("当前活跃视频尚未取得可靠视频 ID");
    }
    const response = await fetch(`${API_BASE}/api/v1/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(freshSnapshot),
    });
    if (!response.ok) {
      let reason = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { detail?: unknown };
        if (typeof body.detail === "string") reason = body.detail;
      } catch {
        // 保留 HTTP 状态作为简洁提示。
      }
      throw new Error(reason);
    }
    const saved = (await response.json()) as SavedSnapshot;
    setNotice(
      `保存成功：记录 #${saved.id}，时间 ${new Date(saved.saved_at).toLocaleString("zh-CN", { hour12: false })}`,
      "success",
    );
  } catch (error) {
    console.error("[TikTok 达人助手] 保存失败", error);
    const message = error instanceof Error ? error.message : "未知错误";
    setNotice(`保存失败：${message}`, "error");
  } finally {
    elements.saveButton.disabled = !currentSnapshot?.video_id;
  }
}

interface DownloadFileResult {
  kind:
    | "video"
    | "audio_track"
    | "background_music"
    | "zip"
    | "transcript_text"
    | "transcript_srt"
    | "transcript_json";
  file_name: string;
  path?: string;
  size_bytes: number;
  download_url: string | null;
}

interface DownloadResponse {
  video_id: string;
  status: "completed" | "partial";
  files: DownloadFileResult[];
  errors: string[];
}

interface TranscriptionResponse {
  video_id: string;
  language: string;
  language_probability: number;
  duration_seconds: number;
  device_used: string;
  compute_type: string;
  fallback_reason: string | null;
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  audio_file: DownloadFileResult | null;
  transcript_files: DownloadFileResult[];
}

function isLocalModelId(value: unknown): value is LocalModelId {
  return typeof value === "string" && (LOCAL_MODEL_IDS as readonly string[]).includes(value);
}

function sanitizeLocalModelIds(value: unknown): LocalModelId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isLocalModelId))];
}

function hideModelRequirement(): void {
  modelUiSequence += 1;
  modelRequirement = null;
  modelInstallBusy = false;
  elements.modelRequirementCard.hidden = true;
  elements.modelProgress.hidden = true;
  elements.modelProgress.classList.remove("is-indeterminate");
  elements.modelProgress.removeAttribute("aria-valuenow");
  elements.modelProgressBar.style.width = "0%";
  elements.modelProgressText.textContent = "";
  elements.modelRequirementSize.textContent = "";
  elements.modelInstallButton.hidden = false;
  elements.modelInstallButton.disabled = false;
  elements.modelInstallButton.textContent = "下载并继续";
  elements.modelDismissButton.disabled = false;
  elements.modelDismissButton.textContent = "暂不下载";
}

function requirementCopy(reason: ModelRequirementReason): {
  title: string;
  description: string;
  installLabel: string;
} {
  if (reason === "transcription") {
    return {
      title: "生成字幕需要语音模型",
      description: "首次使用需下载一次，完成后会自动继续生成本条视频的字幕。",
      installLabel: "下载并继续",
    };
  }
  if (reason === "browser_transcription") {
    return {
      title: "需要浏览器兼容语音模型",
      description: "这台电脑的企业安全策略禁止本地 AI 运行库。模型只在 Chrome 中运行并缓存，不会修改系统运行库。",
      installLabel: "下载并生成字幕",
    };
  }
  if (reason === "comment_translation") {
    return {
      title: "在线翻译暂不可用",
      description: "可选下载离线翻译包。安装完成后，返回评论区点击翻译即可。",
      installLabel: "下载离线翻译包",
    };
  }
  return {
    title: "在线翻译暂不可用",
    description: "当前字幕会保留原文；你也可以下载离线翻译包后继续翻译。",
    installLabel: "下载离线翻译包",
  };
}

function renderModelRequirementBase(context: ModelRequirementContext): void {
  const copy = requirementCopy(context.reason);
  elements.subtitlePanel.hidden = false;
  elements.modelRequirementCard.hidden = false;
  elements.modelRequirementTitle.textContent = copy.title;
  elements.modelRequirementDescription.textContent = context.message || copy.description;
  elements.modelRequirementSize.textContent = "正在确认下载大小…";
  elements.modelProgress.hidden = true;
  elements.modelProgress.classList.remove("is-indeterminate");
  elements.modelProgress.removeAttribute("aria-valuenow");
  elements.modelProgressBar.style.width = "0%";
  elements.modelProgressText.textContent = "仅在确认后下载";
  elements.modelInstallButton.hidden = false;
  elements.modelInstallButton.disabled = false;
  elements.modelInstallButton.textContent = copy.installLabel;
  elements.modelDismissButton.disabled = false;
  elements.modelDismissButton.textContent = "暂不下载";
}

function modelStatusesFor(
  statuses: LocalModelStatus[],
  ids: LocalModelId[],
): LocalModelStatus[] {
  return ids
    .map((id) => statuses.find((status) => status.id === id))
    .filter((status): status is LocalModelStatus => Boolean(status));
}

function updateModelSize(statuses: LocalModelStatus[]): void {
  const total = statuses.reduce((sum, status) => {
    const size = status.total_bytes && status.total_bytes > 0
      ? status.total_bytes
      : status.estimated_size_bytes;
    return sum + (Number.isFinite(size) && size > 0 ? size : 0);
  }, 0);
  elements.modelRequirementSize.textContent = total > 0
    ? `预计下载 ${formatFileSize(total)}`
    : "下载开始后显示实际大小";
}

function renderModelProgress(statuses: LocalModelStatus[]): void {
  const total = statuses.reduce((sum, status) => {
    const size = status.total_bytes && status.total_bytes > 0
      ? status.total_bytes
      : status.estimated_size_bytes;
    return sum + (Number.isFinite(size) && size > 0 ? size : 0);
  }, 0);
  const downloaded = statuses.reduce(
    (sum, status) => sum + Math.max(0, status.downloaded_bytes || 0),
    0,
  );
  elements.modelProgress.hidden = false;
  if (total > 0) {
    const percentage = Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
    elements.modelProgress.classList.remove("is-indeterminate");
    elements.modelProgress.setAttribute("aria-valuenow", String(percentage));
    elements.modelProgressBar.style.width = `${percentage}%`;
    elements.modelProgressText.textContent = `正在下载 ${percentage}% · ${formatFileSize(downloaded)} / ${formatFileSize(total)}`;
  } else {
    elements.modelProgress.classList.add("is-indeterminate");
    elements.modelProgress.removeAttribute("aria-valuenow");
    elements.modelProgressBar.style.width = "36%";
    elements.modelProgressText.textContent = "正在下载模型…";
  }
}

async function fetchLocalModels(): Promise<LocalModelStatus[]> {
  const response = await fetch(`${API_BASE}/api/v1/models`);
  if (!response.ok) throw new Error(await apiError(response));
  const payload = await response.json() as Partial<LocalModelsResponse>;
  if (!Array.isArray(payload.models)) throw new Error("模型状态返回格式不正确");
  return payload.models.filter((status): status is LocalModelStatus => (
    Boolean(status) && typeof status === "object" && isLocalModelId(status.id)
  ));
}

async function finishModelRequirement(context: ModelRequirementContext): Promise<void> {
  if (modelRequirement?.sequence !== context.sequence) return;
  if (context.reason === "comment_translation") {
    modelRequirement = null;
    elements.modelRequirementTitle.textContent = "离线翻译已就绪";
    elements.modelRequirementDescription.textContent = "返回评论区，再次点击单条翻译或自动翻译即可。";
    elements.modelRequirementSize.textContent = "";
    elements.modelProgress.hidden = false;
    elements.modelProgress.classList.remove("is-indeterminate");
    elements.modelProgress.setAttribute("aria-valuenow", "100");
    elements.modelProgressBar.style.width = "100%";
    elements.modelProgressText.textContent = "安装完成";
    elements.modelInstallButton.hidden = true;
    elements.modelDismissButton.disabled = false;
    elements.modelDismissButton.textContent = "完成";
    return;
  }

  const resume = context.resume;
  const expectedVideoId = context.videoId;
  hideModelRequirement();
  if (expectedVideoId && currentSnapshot?.video_id !== expectedVideoId) {
    setNotice("视频已经切换，模型已安装；请在当前视频上重新生成字幕。", "info");
    return;
  }
  if (resume) {
    window.setTimeout(() => {
      void resume();
    }, 0);
  }
}

async function presentModelRequirement(
  idsValue: unknown,
  reason: ModelRequirementReason,
  message: string,
  resume: (() => Promise<void>) | null,
  videoId: string | null = currentSnapshot?.video_id ?? null,
): Promise<void> {
  if (CHROME_ONLY_MODE) {
    if (reason === "transcription") {
      await presentBrowserSpeechRequirement(
        "语音模型由 Chrome 直接下载并缓存，不会启动 Windows 程序。",
        resume ?? (() => Promise.resolve()),
        videoId ?? currentSnapshot?.video_id ?? "",
      );
    } else {
      setNotice("当前为 Chrome 兼容模式：翻译仅使用 Bing 在线服务，不安装本地翻译模型。", "info");
    }
    return;
  }
  const ids = sanitizeLocalModelIds(idsValue);
  if (!ids.length) return;
  if (
    modelRequirement?.reason === reason &&
    modelRequirement.ids.length === ids.length &&
    modelRequirement.ids.every((id) => ids.includes(id)) &&
    !elements.modelRequirementCard.hidden
  ) {
    return;
  }
  const sequence = ++modelUiSequence;
  const context: ModelRequirementContext = {
    ids,
    reason,
    message,
    resume,
    videoId,
    sequence,
  };
  modelRequirement = context;
  renderModelRequirementBase(context);
  try {
    const statuses = modelStatusesFor(await fetchLocalModels(), ids);
    if (modelRequirement?.sequence !== sequence) return;
    updateModelSize(statuses);
    if (statuses.length === ids.length && statuses.every((status) => status.installed)) {
      elements.modelProgressText.textContent = "模型已安装，正在继续…";
      await finishModelRequirement(context);
    }
  } catch (error) {
    if (modelRequirement?.sequence !== sequence) return;
    const detail = error instanceof Error ? error.message : "无法读取模型状态";
    elements.modelRequirementSize.textContent = "下载开始后显示实际大小";
    elements.modelProgressText.textContent = `暂时无法读取模型状态：${detail}`;
  }
}

async function presentBrowserSpeechRequirement(
  message: string,
  resume: () => Promise<void>,
  videoId: string,
): Promise<void> {
  const sequence = ++modelUiSequence;
  const context: ModelRequirementContext = {
    ids: [],
    reason: "browser_transcription",
    message,
    resume,
    videoId,
    sequence,
  };
  modelRequirement = context;
  renderModelRequirementBase(context);
  elements.modelRequirementSize.textContent =
    `预计下载 ${formatFileSize(BROWSER_SPEECH_MODEL_ESTIMATED_BYTES)}，完成后由 Chrome 缓存`;
  elements.modelProgressText.textContent = "仅在确认后下载；以后无需重复下载";
}

function renderBrowserSpeechProgress(progress: BrowserSpeechProgress): void {
  elements.modelProgress.hidden = false;
  elements.modelProgressText.textContent = progress.message;
  if (progress.percent === null) {
    elements.modelProgress.classList.add("is-indeterminate");
    elements.modelProgress.removeAttribute("aria-valuenow");
    elements.modelProgressBar.style.width = "36%";
    return;
  }
  elements.modelProgress.classList.remove("is-indeterminate");
  elements.modelProgress.setAttribute("aria-valuenow", String(progress.percent));
  elements.modelProgressBar.style.width = `${progress.percent}%`;
  if (progress.phase === "model" && progress.totalBytes > 0 && progress.loadedBytes > 0) {
    elements.modelProgressText.textContent =
      `${progress.message} ${progress.percent}% · ${formatFileSize(progress.loadedBytes)} / ${formatFileSize(progress.totalBytes)}`;
  }
}

async function installRequiredModels(): Promise<void> {
  const context = modelRequirement;
  if (!context || modelInstallBusy) return;
  if (CHROME_ONLY_MODE && context.reason !== "browser_transcription") {
    elements.modelProgressText.textContent = "Chrome 兼容模式不会调用本地模型安装程序";
    elements.modelInstallButton.disabled = true;
    return;
  }
  modelInstallBusy = true;
  elements.modelInstallButton.disabled = true;
  elements.modelDismissButton.disabled = true;
  elements.modelInstallButton.textContent = "准备下载…";
  elements.modelProgressText.textContent = "正在准备模型下载…";
  const sequence = context.sequence;
  try {
    if (context.reason === "browser_transcription") {
      const taskId = createSpeedTaskId("subtitle-model-install");
      const startedAt = speedNow();
      speedLog("subtitle.sidepanel", taskId, "model_install_start", startedAt);
      if (SPEED_DIAGNOSTICS_ENABLED) {
        await prepareBrowserSpeechModel(renderBrowserSpeechProgress, taskId);
      } else {
        await prepareBrowserSpeechModel(renderBrowserSpeechProgress);
      }
      speedLog("subtitle.sidepanel", taskId, "model_install_complete", startedAt);
      if (modelRequirement?.sequence !== sequence) return;
      modelInstallBusy = false;
      elements.modelProgressText.textContent = "浏览器兼容语音模型已就绪";
      await finishModelRequirement(context);
      return;
    }
    const currentStatuses = modelStatusesFor(await fetchLocalModels(), context.ids);
    updateModelSize(currentStatuses);
    const installedIds = new Set(
      currentStatuses.filter((status) => status.installed).map((status) => status.id),
    );
    for (const id of context.ids) {
      if (modelRequirement?.sequence !== sequence) return;
      if (installedIds.has(id)) continue;
      const response = await fetch(`${API_BASE}/api/v1/models/${encodeURIComponent(id)}/install`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await apiError(response));
    }

    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      if (modelRequirement?.sequence !== sequence) return;
      const statuses = modelStatusesFor(await fetchLocalModels(), context.ids);
      updateModelSize(statuses);
      renderModelProgress(statuses);
      const failed = statuses.find((status) =>
        status.state === "error" || status.state === "failed" || status.error);
      if (failed) throw new Error(failed.error || `${failed.name} 下载失败`);
      if (statuses.length === context.ids.length && statuses.every((status) => status.installed)) {
        modelInstallBusy = false;
        elements.modelProgressText.textContent = "安装完成";
        await finishModelRequirement(context);
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
    }
    throw new Error("模型下载等待超时，请重试");
  } catch (error) {
    if (modelRequirement?.sequence !== sequence) return;
    const detail = error instanceof Error ? error.message : "模型下载失败";
    elements.modelProgressText.textContent = `下载失败：${detail}`;
    elements.modelInstallButton.textContent = "重试下载";
    elements.modelInstallButton.disabled = false;
    elements.modelDismissButton.disabled = false;
  } finally {
    if (modelRequirement?.sequence === sequence) modelInstallBusy = false;
  }
}

function dismissModelRequirement(): void {
  const reason = modelRequirement?.reason;
  hideModelRequirement();
  if (reason === "transcription" || reason === "browser_transcription") {
    setNotice("未下载语音模型，暂时无法生成字幕。", "info");
  } else if (reason === "subtitle_translation") {
    setSubtitleTranslationStatus("已保留原文；在线翻译恢复后可直接重试。", "idle");
  }
}

function resetSubtitlePanel(): void {
  cancelOutstandingSubtitleTranslations();
  subtitleTranslationSequence += 1;
  hideModelRequirement();
  subtitleResult = null;
  subtitleVideoId = null;
  subtitleAutoStarted = false;
  subtitleTranslations.clear();
  elements.subtitlePanel.hidden = true;
  elements.subtitleLanguageDetected.textContent = "";
  elements.subtitleTranslationStatus.textContent = "";
  elements.subtitleTranslationStatus.className = "subtitle-translation-status";
  elements.subtitleSegments.replaceChildren();
}

function subtitleTimestamp(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const remainingSeconds = safeSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, remainingSeconds]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function subtitleTimeRange(start: number, end: number): string {
  return `${subtitleTimestamp(start)}-${subtitleTimestamp(Math.ceil(Math.max(start, end)))}`;
}

function renderSubtitleSegments(): void {
  if (!subtitleResult) {
    elements.subtitleSegments.replaceChildren();
    return;
  }
  const targetLanguage = elements.subtitleTargetLanguage.value;
  const translatedTexts = subtitleTranslations.get(targetLanguage)?.texts ?? [];
  const bilingual = elements.subtitleBilingual.checked;
  const fragment = document.createDocumentFragment();

  subtitleResult.segments.forEach((segment, index) => {
    const translatedText = translatedTexts[index]?.trim() ?? "";
    const row = document.createElement("article");
    row.className = "subtitle-segment";

    const time = document.createElement("time");
    time.className = "subtitle-time";
    time.textContent = subtitleTimeRange(segment.start, segment.end);

    const content = document.createElement("div");
    content.className = "subtitle-content";
    const original = document.createElement("p");
    original.className = "subtitle-original";
    original.textContent = segment.text.trim();
    original.hidden = Boolean(translatedText) && !bilingual;
    content.append(original);

    if (translatedText) {
      const translation = document.createElement("p");
      translation.className = "subtitle-translation";
      translation.lang = targetLanguage;
      translation.textContent = translatedText;
      content.append(translation);
    }

    row.append(time, content);
    fragment.append(row);
  });

  elements.subtitleSegments.replaceChildren(fragment);
}

function setSubtitleTranslationStatus(
  message: string,
  state: "loading" | "success" | "error" | "idle" = "idle",
): void {
  elements.subtitleTranslationStatus.textContent = message;
  elements.subtitleTranslationStatus.className = `subtitle-translation-status subtitle-translation-${state}`;
}

function chunkSubtitleTexts(texts: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let characters = 0;
  for (const text of texts) {
    if (
      current.length > 0 &&
      (current.length >= MAX_TRANSLATION_BATCH_SIZE ||
        characters + text.length > MAX_TRANSLATION_BATCH_CHARACTERS)
    ) {
      chunks.push(current);
      current = [];
      characters = 0;
    }
    current.push(text);
    characters += text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function translateSubtitleBatch(
  texts: string[],
  targetLanguage: string,
  taskId = createTranslationTaskId("subtitle-translation-batch"),
): Promise<TranslationResultItem[]> {
  const startedAt = speedNow();
  const request = {
    type: "TRANSLATE_PUBLIC_TEXT_BATCH",
    texts,
    target_language: targetLanguage,
    translation_task_id: taskId,
  } as unknown as TranslationRequest;
  // Keep subtitle translation on the exact same MV3 background route used by
  // the in-page translation controls. Direct fetches from the side-panel
  // extension page can be rejected even when the service worker has the
  // required host permission, which previously made the two buttons disagree.
  const response = await chrome.runtime.sendMessage(
    withSpeedTask(request, taskId),
  ) as TranslationResponse;
  speedLog("subtitle.translation", taskId, "background_response", startedAt, {
    item_count: texts.length,
    character_count: texts.reduce((total, text) => total + text.length, 0),
    ok: response?.ok === true,
  });
  if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
    throw new Error("翻译服务未返回有效结果（诊断 TDA-SUB:background_no_response）");
  }
  if (!response.ok) {
    if (response.diagnostic?.endsWith("_cancelled")) {
      throw new SubtitleTranslationCancelledError();
    }
    if (response.code === "LOCAL_MODEL_REQUIRED") {
      const modelIds = sanitizeLocalModelIds(response.required_model_ids);
      if (modelIds.length) throw new LocalModelRequiredError(response.error, modelIds);
    }
    const diagnostic = response.diagnostic || response.code;
    throw new Error(`${response.error}（诊断 TDA-SUB：${diagnostic}）`);
  }
  if (response.data.items.length !== texts.length) throw new Error("翻译结果数量不完整");
  return response.data.items;
}

async function warmTranslationProvider(taskId: string): Promise<void> {
  const startedAt = speedNow();
  try {
    const response = await chrome.runtime.sendMessage(withSpeedTask({
      type: "WARM_TRANSLATION_PROVIDER",
    }, taskId)) as WarmTranslationProviderResponse;
    speedLog("subtitle.translation", taskId, "provider_warmup_complete", startedAt, {
      ok: response?.ok === true,
    });
  } catch (error) {
    // Warm-up is optional. The real translation request will retry normally.
    speedLog("subtitle.translation", taskId, "provider_warmup_failed", startedAt, {
      error_name: error instanceof Error ? error.name : "unknown",
    });
  }
}

async function translateSubtitles(
  targetLanguage: string,
  parentTaskId = "",
  parentStartedAt?: number,
  autoTriggered = false,
  expectedVideoId = subtitleVideoId ?? "",
  cancellationRetryCount = 0,
): Promise<void> {
  if (!subtitleResult || subtitleResult.segments.length === 0) return;
  if (autoTriggered && !autoSubtitleTranslationIsCurrent(expectedVideoId)) return;
  const taskId = parentTaskId || createTranslationTaskId("subtitle-translation");
  const startedAt = speedNow();
  const sequence = ++subtitleTranslationSequence;
  cancelOutstandingSubtitleTranslations(taskId);
  const languageLabel = subtitleLanguageLabel(targetLanguage);
  const cached = subtitleTranslations.get(targetLanguage);
  if (cached) {
    setSubtitleTranslationStatus(
      `已翻译为${languageLabel} · ${cached.providerLabel}`,
      "success",
    );
    renderSubtitleSegments();
    rememberCurrentSubtitle();
    speedLog("subtitle.translation", taskId, "translation_cache_rendered", startedAt, {
      segment_count: cached.texts.length,
    });
    return;
  }

  const texts = subtitleResult.segments.map((segment) => segment.text.trim());
  const chunks = chunkSubtitleTexts(texts);
  speedLog("subtitle.translation", taskId, "translation_start", startedAt, {
    segment_count: texts.length,
    chunk_count: chunks.length,
    character_count: texts.reduce((total, text) => total + text.length, 0),
  });
  setSubtitleTranslationStatus(`正在翻译为${languageLabel}…`, "loading");
  renderSubtitleSegments();
  activeSubtitleTranslationTaskIds.add(taskId);
  try {
    const translated: string[] = [];
    const translatedItems: TranslationResultItem[] = [];
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const chunkStartedAt = speedNow();
      const items = await translateSubtitleBatch(chunk, targetLanguage, taskId);
      speedLog("subtitle.translation", taskId, "chunk_complete", chunkStartedAt, {
        chunk_index: chunkIndex,
        item_count: chunk.length,
      });
      translatedItems.push(...items);
      translated.push(...items.map((item) => item.translated_text));
      if (sequence !== subtitleTranslationSequence) return;
      if (autoTriggered && !autoSubtitleTranslationIsCurrent(expectedVideoId)) return;
    }
    if (sequence !== subtitleTranslationSequence) return;
    if (autoTriggered && !autoSubtitleTranslationIsCurrent(expectedVideoId)) return;
    const providerLabel = translationProviderLabel(translatedItems);
    subtitleTranslations.set(targetLanguage, { texts: translated, providerLabel });
    setSubtitleTranslationStatus(`已翻译为${languageLabel} · ${providerLabel}`, "success");
    const renderStartedAt = speedNow();
    renderSubtitleSegments();
    rememberCurrentSubtitle();
    speedLog("subtitle.translation", taskId, "translated_dom_render_complete", renderStartedAt, {
      segment_count: translated.length,
    });
    speedLog("subtitle.translation", taskId, "translation_complete", startedAt, {
      segment_count: translated.length,
      provider_label: providerLabel,
      parent_elapsed_ms: parentStartedAt === undefined
        ? null
        : Math.round((speedNow() - parentStartedAt) * 100) / 100,
    });
  } catch (error) {
    if (sequence !== subtitleTranslationSequence) return;
    if (autoTriggered && !autoSubtitleTranslationIsCurrent(expectedVideoId)) return;
    if (error instanceof SubtitleTranslationCancelledError) {
      const stillCurrent =
        subtitleVideoId === expectedVideoId &&
        currentSnapshot?.video_id === expectedVideoId;
      if (stillCurrent && cancellationRetryCount < 1) {
        setSubtitleTranslationStatus("翻译任务已自动续接…", "loading");
        window.setTimeout(() => {
          void translateSubtitles(
            targetLanguage,
            "",
            parentStartedAt,
            autoTriggered,
            expectedVideoId,
            cancellationRetryCount + 1,
          );
        }, 0);
      } else if (stillCurrent) {
        setSubtitleTranslationStatus("字幕原文已保留，可再次点击翻译", "idle");
      }
      return;
    }
    if (error instanceof LocalModelRequiredError) {
      setSubtitleTranslationStatus(
        "在线翻译暂不可用，可选择下载离线翻译包；当前字幕原文已保留。",
        "idle",
      );
      renderSubtitleSegments();
      await presentModelRequirement(
        error.modelIds,
        "subtitle_translation",
        "",
        () => translateSubtitles(
          targetLanguage,
          "",
          undefined,
          autoTriggered,
          expectedVideoId,
        ),
        subtitleVideoId,
      );
      return;
    }
    const message = error instanceof Error ? error.message : "翻译失败";
    speedLog("subtitle.translation", taskId, "translation_failed", startedAt, {
      error_name: error instanceof Error ? error.name : "unknown",
    });
    console.error(`[TikTok 达人助手] 字幕翻译失败：${message}`);
    setSubtitleTranslationStatus(`翻译失败：${message}`, "error");
    renderSubtitleSegments();
  } finally {
    activeSubtitleTranslationTaskIds.delete(taskId);
  }
}

function subtitleLanguageLabel(targetLanguage: string): string {
  return [...elements.subtitleTargetLanguage.options]
    .find((option) => option.value === targetLanguage)
    ?.textContent?.trim() || "所选语言";
}

async function showTranscription(
  result: TranscriptionResponse,
  taskId = createSpeedTaskId("subtitle-render"),
  taskStartedAt?: number,
  translateAfter = true,
  autoTriggered = false,
): Promise<void> {
  const startedAt = speedNow();
  subtitleTranslationSequence += 1;
  subtitleResult = result;
  subtitleVideoId = result.video_id;
  if (autoSubtitleModelPromptVideoId === result.video_id) {
    autoSubtitleModelPromptVideoId = null;
  }
  subtitleTranslations.clear();
  elements.subtitlePanel.hidden = false;
  elements.subtitleLanguageDetected.textContent = result.language
    ? `原语言：${result.language}`
    : "原语言：自动识别";
  const renderStartedAt = speedNow();
  renderSubtitleSegments();
  rememberCurrentSubtitle();
  speedLog("subtitle.sidepanel", taskId, "first_original_subtitle_rendered", taskStartedAt, {
    render_elapsed_ms: Math.round((speedNow() - renderStartedAt) * 100) / 100,
    segment_count: result.segments.length,
  });
  if (!result.segments.length) {
    setSubtitleTranslationStatus("未检测到可识别语音", "idle");
    return;
  }
  if (translateAfter) {
    await translateSubtitles(
      elements.subtitleTargetLanguage.value,
      taskId,
      taskStartedAt,
      autoTriggered,
      result.video_id,
    );
  } else {
    setSubtitleTranslationStatus("原字幕已生成；自动翻译未开启", "idle");
  }
  rememberCurrentSubtitle();
  speedLog("subtitle.sidepanel", taskId, "transcription_display_complete", startedAt, {
    segment_count: result.segments.length,
  });
}

interface BatchJobErrorResult {
  video_id: string;
  error: string;
}

interface BatchJobResult {
  job_id: string;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  files: DownloadFileResult[];
  errors: BatchJobErrorResult[];
  zip_file: DownloadFileResult | null;
  cancel_requested: boolean;
}

async function requestCurrentMedia(): Promise<CurrentMediaDescriptor> {
  const expectedVideoId = currentSnapshot?.video_id;
  if (!expectedVideoId) throw new Error("当前视频尚未取得可靠帖子 ID");
  const tab = await activeTikTokTab();
  const response = (await chrome.tabs.sendMessage(tab.id!, {
    type: "GET_CURRENT_MEDIA_DESCRIPTOR",
  })) as MediaDescriptorResponse | undefined;
  if (!response?.ok) throw new Error(response?.error ?? "当前视频媒体地址暂不可用");
  const liveTab = await activeTikTokTab();
  if (
    liveTab.id !== tab.id ||
    response.data.video_id !== expectedVideoId ||
    response.generation < currentGeneration
  ) {
    throw new Error("页面或视频已经切换，已取消旧视频下载");
  }
  if (!acceptSession(tab.id!, response.session_id, false)) {
    throw new Error("媒体地址来自已失效的页面会话，请重试");
  }
  currentGeneration = response.generation;
  currentSnapshotSequence = Math.max(currentSnapshotSequence, response.snapshot_sequence);
  return response.data;
}

async function downloadCurrent(
  mode: "video" | "audio_track",
): Promise<void> {
  if (mediaOperationBusy) return;
  const namingMedia = currentSnapshot
    ? {
        video_id: currentSnapshot.video_id ?? "未知视频",
        author_unique_id: currentSnapshot.author.unique_id,
        author_nickname: currentSnapshot.author.nickname,
        description: currentSnapshot.description,
        created_at: currentSnapshot.created_at,
      }
    : null;
  if (!namingMedia) return;
  const handle = await pickSingleMediaTarget(namingMedia, mode);
  if (!handle) return;
  mediaOperationBusy = true;
  updateDownloadButtons();
  clearNotice();
  const modeLabel = {
    video: "视频",
    audio_track: "音频",
  }[mode];
  setNotice(`正在提取${modeLabel}，请勿切换当前视频…`, "info");
  try {
    const media = await requestCurrentMedia();
    const fileName = await writeSingleMediaTarget(
      handle,
      media,
      mode,
      loadDownloadMediaBytesFromActivePage,
      (message) => setNotice(message, "info"),
    );
    setNotice(`已保存：${fileName}`, "success");
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "处理超过 3 分钟，已在界面停止等待"
      : error instanceof Error ? error.message : "未知错误";
    console.error(`[TikTok 达人助手] ${modeLabel}提取失败：${message}`);
    setNotice(`${modeLabel}提取失败：${message}`, "error");
  } finally {
    mediaOperationBusy = false;
    updateDownloadButtons();
  }
}

async function saveMediaWithFallback(
  media: CurrentMediaDescriptor,
  mode: "video" | "audio_track",
  saveAs: boolean,
): Promise<{ fileNames: string[]; provider: "本地服务" | "Chrome" }> {
  if (CHROME_ONLY_MODE) {
    if (!media.media_url) throw new Error("当前页面尚未捕获可下载的视频地址");
    if (mode === "video") {
      const fileName = await requestPageMediaSave(media);
      return { fileNames: [fileName], provider: "Chrome" };
    }
    const saved = await saveBrowserAudioWav(
      media,
      saveAs,
      (message) => setNotice(message, "info"),
      (url) => requestMediaBytesFromActivePage(url),
    );
    return { fileNames: [saved.fileName], provider: "Chrome" };
  }
  try {
    const result = await requestMediaDownload(media, mode);
    await saveDownloadFilesAs(result.files, { saveAs });
    return { fileNames: result.files.map((file) => file.file_name), provider: "本地服务" };
  } catch (backendError) {
    if (!media.media_url) throw backendError;
    if (mode === "video") {
      const fileName = await requestPageMediaSave(media);
      return { fileNames: [fileName], provider: "Chrome" };
    }
    const saved = await saveBrowserAudioWav(
      media,
      saveAs,
      (message) => setNotice(message, "info"),
      (url) => requestMediaBytesFromActivePage(url),
    );
    return { fileNames: [saved.fileName], provider: "Chrome" };
  }
}

async function requestMediaDownload(
  media: CurrentMediaDescriptor,
  mode: "video" | "audio_track",
): Promise<DownloadResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 180_000);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/v1/downloads`, {
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
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(await apiError(response));
  return response.json() as Promise<DownloadResponse>;
}

async function processPendingCardDownloads(): Promise<void> {
  if (cardDownloadQueueBusy) {
    cardDownloadQueueRerun = true;
    return;
  }
  if (mediaOperationBusy) {
    window.setTimeout(() => void processPendingCardDownloads(), 600);
    return;
  }
  const sessionStorage = chrome.storage?.session;
  if (!sessionStorage) return;
  cardDownloadQueueBusy = true;
  try {
    while (!mediaOperationBusy) {
      const pending = await takePendingCardDownload(sessionStorage);
      if (!pending) break;
      const label = pending.mode === "video" ? "视频" : "音频";
      mediaOperationBusy = true;
      updateDownloadButtons();
      setNotice(`正在处理所选卡片 ${pending.media.video_id} 的${label}…`, "info");
      try {
        const saved = await saveMediaWithFallback(pending.media, pending.mode, true);
        setNotice(`已打开另存为：${saved.fileNames.join("、")} · ${saved.provider}`, "success");
      } catch (error) {
        const message = error instanceof DOMException && error.name === "AbortError"
          ? "处理超过 3 分钟，已停止等待"
          : error instanceof Error ? error.message : "未知错误";
        console.error(`[TikTok 达人助手] 卡片 ${pending.media.video_id} 下载失败：${message}`);
        setNotice(`卡片${label}处理失败：${message}`, "error");
      } finally {
        mediaOperationBusy = false;
        updateDownloadButtons();
      }
    }
  } finally {
    cardDownloadQueueBusy = false;
    if (cardDownloadQueueRerun) {
      cardDownloadQueueRerun = false;
      void processPendingCardDownloads();
    }
  }
}

async function takePendingCardDownload(
  sessionStorage: chrome.storage.StorageArea,
): Promise<QueuedCardMediaDownload | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return null;
  const stored = await sessionStorage.get(CARD_MEDIA_DOWNLOAD_QUEUE_KEY);
  const queue = usableQueuedCardDownloads(stored[CARD_MEDIA_DOWNLOAD_QUEUE_KEY]);
  const index = queue.findIndex((item) => item.tab_id === tab.id);
  if (index < 0) return null;
  const [pending] = queue.splice(index, 1);
  await sessionStorage.set({ [CARD_MEDIA_DOWNLOAD_QUEUE_KEY]: queue });
  return pending ?? null;
}

async function processPendingForegroundTranslations(): Promise<void> {
  if (foregroundTranslationQueueBusy) {
    foregroundTranslationQueueRerun = true;
    return;
  }
  const sessionStorage = chrome.storage?.session;
  if (!sessionStorage) return;
  foregroundTranslationQueueBusy = true;
  try {
    while (true) {
      const pending = await peekPendingForegroundTranslation(sessionStorage);
      if (!pending) break;
      const startedAt = Date.now();
      const count = pending.request.type === "TRANSLATE_PUBLIC_TEXT"
        ? 1
        : pending.request.texts.length;
      const targetLanguage = pending.request.target_language ?? "zh-CN";
      setNotice(`正在通过本地服务翻译 ${count} 条公开文本…`, "info");

      let response: TranslationResponse;
      try {
        response = SPEED_DIAGNOSTICS_ENABLED
          ? await foregroundTranslationService.handle(pending.request, pending.request_id)
          : await foregroundTranslationService.handle(pending.request);
      } catch (error) {
        response = {
          ok: false,
          error: "侧栏前景翻译发生异常，请重试",
          code: "PROVIDER_UNAVAILABLE",
          diagnostic: `TDA-TR-03:${safeTranslationErrorName(error)}`,
        };
      }
      await completeForegroundTranslation(sessionStorage, pending, response);

      console.info("[TikTok 达人助手] 前景翻译任务完成", {
        route: "sidepanel_local_backend",
        ok: response.ok,
        elapsed_ms: Date.now() - startedAt,
        count,
        target_language: targetLanguage,
        diagnostic: response.ok ? "TDA-TR-OK" : response.diagnostic ?? response.code,
      });
      if (response.ok) {
        const providerLabel = translationProviderLabel(response.data.items);
        setNotice(`翻译完成（${count} 条 · ${providerLabel}）`, "success");
      } else {
        setNotice(`${response.error}（诊断 ${response.diagnostic ?? response.code}）`, "error");
      }
    }
  } finally {
    foregroundTranslationQueueBusy = false;
    if (foregroundTranslationQueueRerun) {
      foregroundTranslationQueueRerun = false;
      void processPendingForegroundTranslations();
    }
  }
}

async function peekPendingForegroundTranslation(
  sessionStorage: chrome.storage.StorageArea,
): Promise<QueuedForegroundTranslation | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return null;
  const stored = await sessionStorage.get(FOREGROUND_TRANSLATION_QUEUE_KEY);
  const queue = usableQueuedForegroundTranslations(stored[FOREGROUND_TRANSLATION_QUEUE_KEY]);
  return queue.find((item) => item.tab_id === tab.id) ?? null;
}

async function completeForegroundTranslation(
  sessionStorage: chrome.storage.StorageArea,
  pending: QueuedForegroundTranslation,
  response: TranslationResponse,
): Promise<void> {
  const stored = await sessionStorage.get([
    FOREGROUND_TRANSLATION_QUEUE_KEY,
    FOREGROUND_TRANSLATION_RESULTS_KEY,
  ]);
  const queue = usableQueuedForegroundTranslations(stored[FOREGROUND_TRANSLATION_QUEUE_KEY])
    .filter((item) => item.request_id !== pending.request_id);
  const results = usableForegroundTranslationResults(stored[FOREGROUND_TRANSLATION_RESULTS_KEY])
    .filter((item) => item.request_id !== pending.request_id);
  const completed: ForegroundTranslationJobResult = {
    request_id: pending.request_id,
    tab_id: pending.tab_id,
    updated_at: Date.now(),
    response,
  };
  results.push(completed);
  await sessionStorage.set({
    [FOREGROUND_TRANSLATION_QUEUE_KEY]: queue,
    [FOREGROUND_TRANSLATION_RESULTS_KEY]: results.slice(-20),
  });
}

function safeTranslationErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return error.name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 48) || "Error";
}

async function requestBatchMedia(): Promise<BatchMediaDescriptor[]> {
  const tab = await activeTikTokTab();
  const response = (await chrome.tabs.sendMessage(tab.id!, {
    type: "GET_BATCH_MEDIA_DESCRIPTORS",
  })) as BatchMediaDescriptorsResponse | undefined;
  if (!response?.ok) throw new Error(response?.error ?? "当前网格没有可下载视频");
  const liveTab = await activeTikTokTab();
  if (liveTab.id !== tab.id || response.generation < currentGeneration) {
    throw new Error("页面已经切换，已取消旧的批量请求");
  }
  if (!acceptSession(tab.id!, response.session_id, false)) {
    throw new Error("批量媒体数据来自已失效的页面会话，请重试");
  }
  return response.data.items;
}

async function transcribeTikTokCaption(
  media: CurrentMediaDescriptor,
  taskId: string,
  signal?: AbortSignal,
): Promise<TranscriptionResponse | null> {
  const startedAt = speedNow();
  const errors: unknown[] = [];
  const storedUrl = trustedTikTokSubtitleUrl(media.subtitle_url);
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();
  if (!controller.signal.aborted && currentSnapshot?.video_id === media.video_id) {
    setNotice("正在读取 TikTok 已有字幕…", "info");
  }

  type CaptionCandidate = {
    source: "tiktok_page_context" | "captured_page_data";
    response: TranscriptionResponse;
    characterCount?: number;
  };
  const candidates: Array<Promise<CaptionCandidate | null>> = [
    requestCurrentTikTokCaption(media)
      .then((caption) => caption?.segments.length
        ? {
            source: "tiktok_page_context" as const,
            response: createTikTokCaptionResponse(media, caption.segments, caption.language),
          }
        : null),
  ];
  if (storedUrl) {
    candidates.push(
      fetchTikTokWebVtt(
        { url: storedUrl, language: media.subtitle_language ?? null },
        1_500,
        controller.signal,
      ).then((caption) => ({
        source: "captured_page_data" as const,
        response: createTikTokCaptionResponse(media, caption.segments, caption.language),
        characterCount: caption.characterCount,
      })),
    );
  }
  const pending = candidates.map((promise, index) => ({
    index,
    promise: promise
      .then((candidate) => ({ candidate, error: null as unknown }))
      .catch((error: unknown) => ({ candidate: null, error })),
  }));
  let suspiciousCandidate: CaptionCandidate | null = null;
  try {
    while (pending.length) {
      if (controller.signal.aborted) throw new AutoSubtitleCancelledError();
      const settled = await Promise.race(
        pending.map(({ index, promise }) => promise.then((result) => ({ index, ...result }))),
      );
      const pendingIndex = pending.findIndex((item) => item.index === settled.index);
      if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
      if (settled.error) errors.push(settled.error);
      const candidate = settled.candidate;
      if (!candidate) continue;
      if (!captionResultLooksComplete(candidate.response, media.video_id)) {
        if (
          !suspiciousCandidate ||
          candidate.response.duration_seconds > suspiciousCandidate.response.duration_seconds
        ) {
          suspiciousCandidate = candidate;
        }
        continue;
      }
      controller.abort();
      speedLog("subtitle.caption", taskId, "tiktok_webvtt_complete", startedAt, {
        segment_count: candidate.response.segments.length,
        character_count: candidate.characterCount,
        source: candidate.source,
      });
      return candidate.response;
    }
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", forwardAbort);
  }

  if (suspiciousCandidate) {
    speedLog("subtitle.caption", taskId, "tiktok_webvtt_rejected_as_incomplete", startedAt, {
      segment_count: suspiciousCandidate.response.segments.length,
      caption_duration_seconds: suspiciousCandidate.response.duration_seconds,
      video_duration_seconds: currentSnapshot?.video_id === media.video_id
        ? currentSnapshot.duration_seconds
        : null,
      source: suspiciousCandidate.source,
    });
  }
  speedLog("subtitle.caption", taskId, "tiktok_webvtt_failed", startedAt, {
    attempted_stored_url: Boolean(storedUrl),
    attempted_fresh_page: true,
    error_name: errors[0] instanceof Error ? errors[0].name : "Unavailable",
  });
  if (errors.length) {
    console.info(
      "[TikTok 达人助手] TikTok 现成字幕不可用，继续使用原语音识别流程",
      errors[0],
    );
  }
  return null;
}

function captionResultLooksComplete(result: TranscriptionResponse, videoId: string): boolean {
  if (!result.segments.length) return false;
  const videoDuration = currentSnapshot?.video_id === videoId
    ? currentSnapshot.duration_seconds
    : null;
  if (!videoDuration || videoDuration < 10) return true;
  const captionDuration = result.segments.reduce(
    (maximum, segment) => Math.max(maximum, segment.end),
    0,
  );
  // A single cue ending almost immediately on a normal-length video is usually
  // a still-loading/wrong TikTok track. Do not mistake it for the full caption.
  return !(
    result.segments.length === 1 &&
    captionDuration < Math.min(3, videoDuration * 0.2)
  );
}

async function requestCurrentTikTokCaption(
  media: CurrentMediaDescriptor,
): Promise<CurrentTikTokCaption | null> {
  const tab = await activeTikTokTab();
  const response = (await chrome.tabs.sendMessage(tab.id!, {
    type: "GET_CURRENT_TIKTOK_CAPTION",
    video_id: media.video_id,
  })) as CurrentTikTokCaptionResponse | undefined;
  if (!response?.ok) {
    throw new Error(response?.error ?? "TikTok 页面字幕读取失败");
  }
  if (currentSnapshot?.video_id !== media.video_id) {
    throw new Error("页面或视频已经切换，已取消旧视频字幕");
  }
  if (
    response.data &&
    (
      response.data.video_id !== media.video_id ||
      !Array.isArray(response.data.segments)
    )
  ) {
    throw new Error("TikTok 页面返回了无效字幕");
  }
  return response.data;
}

async function fetchTikTokWebVtt(
  track: TikTokWebVttTrack,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ segments: WebVttSegment[]; language: string | null; characterCount: number }> {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(track.url, {
      method: "GET",
      signal: controller.signal,
      credentials: "omit",
      cache: "default",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
      throw new Error("字幕文件过大");
    }
    const source = await response.text();
    const segments = parseWebVtt(source);
    if (!segments.length) throw new Error("字幕内容为空");
    return { segments, language: track.language, characterCount: source.length };
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

function createTikTokCaptionResponse(
  media: CurrentMediaDescriptor,
  segments: WebVttSegment[],
  language: string | null,
): TranscriptionResponse {
  return {
    video_id: media.video_id,
    language: language || "auto",
    language_probability: 0,
    duration_seconds: segments.reduce(
      (maximum, segment) => Math.max(maximum, segment.end),
      0,
    ),
    device_used: "tiktok-webvtt",
    compute_type: "existing-caption",
    fallback_reason: null,
    text: segments.map((segment) => segment.text).join(" "),
    segments,
    audio_file: null,
    transcript_files: [],
  };
}

async function transcribeCurrent(options: TranscriptionRunOptions = {}): Promise<void> {
  const automatic = options.trigger === "auto";
  const expectedVideoId = options.expectedVideoId ?? currentSnapshot?.video_id ?? "";
  let ownsMediaOperation = false;
  if (!automatic) {
    if (mediaOperationBusy) return;
    mediaOperationBusy = true;
    ownsMediaOperation = true;
  }
  if (automatic && !autoSubtitleRunIsCurrent(options, expectedVideoId)) return;
  const taskId = createTranslationTaskId("subtitle");
  const taskStartedAt = speedNow();
  speedLog("subtitle.sidepanel", taskId, "task_start", taskStartedAt, {
    chrome_only_mode: CHROME_ONLY_MODE,
    trigger: automatic ? "auto" : "manual",
  });
  if (CHROME_ONLY_MODE && (!automatic || autoSubtitleSettings.translate)) {
    void warmTranslationProvider(taskId);
  }
  if (automatic) {
    activeAutoSubtitleTranslationTaskId = taskId;
    autoSubtitleWorkingVideoId = expectedVideoId;
    autoSubtitleError = null;
    renderAutoSubtitleControls();
  }
  updateDownloadButtons();
  setNotice(
    automatic ? "正在自动生成当前视频字幕…" : "正在生成字幕，首次识别会稍慢…",
    "info",
  );
  try {
    throwIfAutoSubtitleCancelled(options);
    const mediaStartedAt = speedNow();
    let media: CurrentMediaDescriptor;
    try {
      media = await requestCurrentMedia();
    } catch (error) {
      if (
        automatic &&
        autoSubtitleRunIsCurrent(options, expectedVideoId)
      ) {
        throw new AutoSubtitleRetryableError(
          error instanceof Error ? error.message : "当前视频信息还没有加载完成",
        );
      }
      throw error;
    }
    if (automatic && !autoSubtitleRunIsCurrent(options, media.video_id)) {
      throw new AutoSubtitleCancelledError();
    }
    speedLog("subtitle.sidepanel", taskId, "media_descriptor_received", mediaStartedAt, {
      video_id_present: Boolean(media.video_id),
      media_url_present: Boolean(media.media_url),
      subtitle_url_present: Boolean(media.subtitle_url),
    });
    let result: TranscriptionResponse;
    const tikTokCaption = await transcribeTikTokCaption(media, taskId, options.signal);
    if (automatic && !autoSubtitleRunIsCurrent(options, media.video_id)) {
      throw new AutoSubtitleCancelledError();
    }
    if (tikTokCaption) {
      hideModelRequirement();
      result = tikTokCaption;
    } else {
      if (automatic && mediaOperationBusy) {
        autoSubtitleWaitingForSpeechVideoId = media.video_id;
        scheduleAutoSubtitle(AUTO_SUBTITLE_BUSY_RETRY_MS);
        return;
      }
      if (!ownsMediaOperation) {
        mediaOperationBusy = true;
        ownsMediaOperation = true;
        updateDownloadButtons();
      }
      if (automatic) autoSubtitleWaitingForSpeechVideoId = null;
      throwIfAutoSubtitleCancelled(options);
      if (CHROME_ONLY_MODE) {
      elements.subtitlePanel.hidden = false;
      const browserModelReady = SPEED_DIAGNOSTICS_ENABLED
        ? await browserSpeechModelIsReady(taskId)
        : await browserSpeechModelIsReady();
      if (!browserModelReady) {
        speedLog("subtitle.sidepanel", taskId, "task_paused_for_model_install", taskStartedAt);
        setSubtitleTranslationStatus("首次使用需下载浏览器语音模型，确认后会自动继续。", "idle");
        if (automatic) autoSubtitleModelPromptVideoId = media.video_id;
        await presentBrowserSpeechRequirement(
          "模型由 Chrome 直接下载并保存到浏览器缓存，不会运行 EXE、脚本或本地服务。",
          () => resumeAfterSubtitleModel(automatic, media.video_id),
          media.video_id,
        );
        return;
      }
        result = await transcribeCurrentInBrowser(
          media,
          false,
          taskId,
          options.signal,
          () => !automatic || autoSubtitleRunIsCurrent(options, media.video_id),
        );
      } else {
      const controller = new AbortController();
      const forwardAutoAbort = (): void => controller.abort();
      options.signal?.addEventListener("abort", forwardAutoAbort, { once: true });
      if (options.signal?.aborted) controller.abort();
      const timeout = window.setTimeout(() => controller.abort(), 10 * 60_000);
      let response: Response | null = null;
      let backendUnavailable = false;
      try {
        try {
          response = await fetch(`${API_BASE}/api/v1/transcriptions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              media: {
                video_id: media.video_id,
                media_url: media.media_url,
                author_unique_id: media.author_unique_id,
                author_nickname: media.author_nickname,
                description: media.description,
                created_at: media.created_at,
                page_url: media.page_url,
                download_video: false,
                extract_audio: true,
                download_background_music: false,
              },
              language: null,
              beam_size: 5,
              vad_filter: true,
              save_transcript_files: !automatic && elements.subtitleSaveFiles.checked,
            }),
          });
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          backendUnavailable = true;
        }
      } finally {
        window.clearTimeout(timeout);
        options.signal?.removeEventListener("abort", forwardAutoAbort);
      }
      if (backendUnavailable || response === null) {
        elements.subtitlePanel.hidden = false;
        const browserModelReady = SPEED_DIAGNOSTICS_ENABLED
          ? await browserSpeechModelIsReady(taskId)
          : await browserSpeechModelIsReady();
        if (!browserModelReady) {
          speedLog("subtitle.sidepanel", taskId, "task_paused_for_model_install", taskStartedAt);
          setSubtitleTranslationStatus("本地服务被 Windows 阻止，可直接使用 Chrome 兼容模式。", "idle");
          if (automatic) autoSubtitleModelPromptVideoId = media.video_id;
          await presentBrowserSpeechRequirement(
            "Windows 阻止了本地后端，字幕将在 Chrome 内直接生成，不需要运行库。",
            () => resumeAfterSubtitleModel(automatic, media.video_id),
            media.video_id,
          );
          return;
        }
        result = await transcribeCurrentInBrowser(
          media,
          false,
          taskId,
          options.signal,
          () => !automatic || autoSubtitleRunIsCurrent(options, media.video_id),
        );
      } else if (!response.ok) {
        const failure = await readApiFailure(response);
        if (response.status === 409 && failure.code === "MODEL_REQUIRED" && failure.modelIds.length) {
          elements.subtitlePanel.hidden = false;
          setSubtitleTranslationStatus("需要先安装语音模型，确认后将自动继续。", "idle");
            if (automatic) autoSubtitleModelPromptVideoId = media.video_id;
            await presentModelRequirement(
              failure.modelIds,
              "transcription",
              "",
              () => resumeAfterSubtitleModel(automatic, media.video_id),
              media.video_id,
            );
          return;
        }
        if (response.status === 503 && failure.browserFallback) {
          elements.subtitlePanel.hidden = false;
          const browserModelReady = SPEED_DIAGNOSTICS_ENABLED
            ? await browserSpeechModelIsReady(taskId)
            : await browserSpeechModelIsReady();
          if (!browserModelReady) {
            speedLog("subtitle.sidepanel", taskId, "task_paused_for_model_install", taskStartedAt);
            setSubtitleTranslationStatus("本地引擎被系统策略阻止，可使用 Chrome 兼容模式。", "idle");
            if (automatic) autoSubtitleModelPromptVideoId = media.video_id;
            await presentBrowserSpeechRequirement(
              failure.message,
              () => resumeAfterSubtitleModel(automatic, media.video_id),
              media.video_id,
            );
            return;
          }
          result = await transcribeCurrentInBrowser(
            media,
            true,
            taskId,
            options.signal,
            () => !automatic || autoSubtitleRunIsCurrent(options, media.video_id),
          );
        } else {
          throw new Error(failure.message);
        }
      } else {
        result = await response.json() as TranscriptionResponse;
      }
      }
    }
    if (automatic && !autoSubtitleRunIsCurrent(options, media.video_id)) {
      throw new AutoSubtitleCancelledError();
    }
    if (currentSnapshot?.video_id !== media.video_id) {
      throw new Error("页面或视频已经切换，已取消旧视频字幕");
    }
    await showTranscription(
      result,
      taskId,
      taskStartedAt,
      automatic ? autoSubtitleSettings.translate : true,
      automatic,
    );
    if (automatic && !autoSubtitleRunIsCurrent(options, media.video_id)) {
      throw new AutoSubtitleCancelledError();
    }
    let saveMessage = "";
    const transcriptFile = result.transcript_files[0];
    if (
      !automatic &&
      elements.subtitleSaveFiles.checked &&
      (result.device_used === "chrome-wasm" || result.device_used === "tiktok-webvtt")
    ) {
      try {
        await saveBrowserSubtitleAs(media, result);
        saveMessage = "，已打开 SRT 另存为";
      } catch (saveError) {
        const reason = saveError instanceof Error ? saveError.message : "用户取消或浏览器拒绝保存";
        console.error(`[TikTok 达人助手] 浏览器字幕保存失败：${reason}`);
        saveMessage = "，SRT 未保存";
      }
    } else if (!automatic && elements.subtitleSaveFiles.checked && transcriptFile) {
      try {
        await saveDownloadFileAs(transcriptFile);
        saveMessage = "，已打开 SRT 另存为";
      } catch (saveError) {
        const reason = saveError instanceof Error ? saveError.message : "用户取消或浏览器拒绝保存";
        console.error(`[TikTok 达人助手] SRT 字幕保存失败：${reason}`);
        saveMessage = "；SRT 未保存";
      }
    }
    setNotice(
      result.segments.length
        ? `${automatic ? "自动字幕" : "字幕"}已生成，共 ${result.segments.length} 句${saveMessage}。`
        : "未检测到可识别语音。",
      result.segments.length ? "success" : "info",
    );
    if (automatic) {
      autoSubtitleError = null;
      autoSubtitleModelPromptVideoId = null;
      autoSubtitleWaitingForSpeechVideoId = null;
      autoSubtitleRetryCounts.delete(media.video_id);
    }
    speedLog("subtitle.sidepanel", taskId, "task_complete", taskStartedAt, {
      segment_count: result.segments.length,
      device_used: result.device_used,
    });
  } catch (error) {
    if (
      error instanceof AutoSubtitleCancelledError ||
      (automatic && options.signal?.aborted) ||
      (automatic && !autoSubtitleRunIsCurrent(options, expectedVideoId))
    ) {
      speedLog("subtitle.sidepanel", taskId, "task_cancelled", taskStartedAt, {
        trigger: "auto",
      });
      return;
    }
    if (
      automatic &&
      expectedVideoId &&
      retryableAutoSubtitleFailure(error) &&
      autoSubtitleRunIsCurrent(options, expectedVideoId)
    ) {
      const retryMessage = error instanceof Error
        ? error.message
        : "当前视频还没有加载完成";
      speedLog("subtitle.sidepanel", taskId, "task_retry_scheduled", taskStartedAt, {
        retry_count: (autoSubtitleRetryCounts.get(expectedVideoId) ?? 0) + 1,
      });
      setNotice("当前视频还在加载，正在自动重试字幕…", "info");
      scheduleAutoSubtitleRetry(expectedVideoId, retryMessage);
      return;
    }
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "字幕生成超过 10 分钟，已在界面停止等待"
      : error instanceof Error ? error.message : "未知错误";
    console.error(`[TikTok 达人助手] 字幕生成失败：${message}`);
    speedLog("subtitle.sidepanel", taskId, "task_failed", taskStartedAt, {
      error_name: error instanceof Error ? error.name : "unknown",
    });
    if (automatic && expectedVideoId) {
      autoSubtitleError = { videoId: expectedVideoId, message };
    }
    setNotice(`字幕生成失败：${message}`, "error");
  } finally {
    if (ownsMediaOperation) mediaOperationBusy = false;
    if (activeAutoSubtitleTranslationTaskId === taskId) {
      activeAutoSubtitleTranslationTaskId = null;
    }
    if (automatic && autoSubtitleWorkingVideoId === expectedVideoId) {
      autoSubtitleWorkingVideoId = null;
    }
    updateDownloadButtons();
    renderAutoSubtitleControls();
    if (
      autoSubtitleSettings.enabled &&
      currentSnapshot &&
      isAutoSubtitleSurface(currentSnapshot) &&
      currentSnapshot.video_id !== expectedVideoId
    ) {
      scheduleAutoSubtitle(0);
    }
  }
}

async function transcribeCurrentInBrowser(
  media: CurrentMediaDescriptor,
  backendAvailable: boolean,
  taskId = createSpeedTaskId("subtitle-browser"),
  signal?: AbortSignal,
  shouldReport: () => boolean = () => true,
): Promise<TranscriptionResponse> {
  const startedAt = speedNow();
  if (shouldReport() && !signal?.aborted) {
    setNotice("本地 AI 被系统策略阻止，正在使用 Chrome 兼容模式…", "info");
  }
  const progress = (value: BrowserSpeechProgress): void => {
    if (signal?.aborted || !shouldReport()) return;
    setNotice(value.message, "info");
    if (!elements.modelRequirementCard.hidden) renderBrowserSpeechProgress(value);
  };
  let browserResult: BrowserTranscriptionResult;
  try {
    if (signal?.aborted) throw new AutoSubtitleCancelledError();
    if (!media.media_url) throw new Error("当前页面尚未捕获视频地址");
    browserResult = SPEED_DIAGNOSTICS_ENABLED
      ? await transcribeMediaUrl(
          media.media_url,
          progress,
          (url, onProgress) => requestMediaBytesFromActivePage(
            url,
            onProgress,
            taskId,
            signal,
          ),
          taskId,
          signal,
        )
      : await transcribeMediaUrl(
          media.media_url,
          progress,
          (url, onProgress) => requestMediaBytesFromActivePage(
            url,
            onProgress,
            undefined,
            signal,
          ),
          undefined,
          signal,
        );
  } catch (directError) {
    speedLog("subtitle.sidepanel", taskId, "browser_direct_path_failed", startedAt, {
      error_name: directError instanceof Error ? directError.name : "unknown",
      backend_available: backendAvailable,
    });
    if (signal?.aborted) throw new AutoSubtitleCancelledError();
    if (!backendAvailable) throw directError;
    const download = await requestMediaDownload(media, "audio_track");
    if (signal?.aborted) throw new AutoSubtitleCancelledError();
    const audioFile = download.files.find((file) => file.kind === "audio_track");
    if (!audioFile) throw new Error("本地服务未返回可识别的音轨");
    browserResult = SPEED_DIAGNOSTICS_ENABLED
      ? await transcribeStagedAudio(audioFile, progress, taskId, signal)
      : await transcribeStagedAudio(audioFile, progress, undefined, signal);
  }
  if (signal?.aborted || !shouldReport()) throw new AutoSubtitleCancelledError();
  speedLog("subtitle.sidepanel", taskId, "browser_transcription_complete", startedAt, {
    segment_count: browserResult.segments.length,
    audio_duration_seconds: Math.round(browserResult.durationSeconds * 1000) / 1000,
  });
  return {
    video_id: media.video_id,
    language: browserResult.language,
    language_probability: 0,
    duration_seconds: browserResult.durationSeconds,
    device_used: "chrome-wasm",
    compute_type: "q8",
    fallback_reason: "Windows 应用控制策略阻止了本地 AI，已自动使用 Chrome 兼容模式",
    text: browserResult.text,
    segments: browserResult.segments,
    audio_file: null,
    transcript_files: [],
  };
}

async function requestMediaBytesFromActivePage(
  mediaUrl: string,
  onProgress: (value: BrowserSpeechProgress) => void = () => undefined,
  taskId = createSpeedTaskId("subtitle-page-media"),
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const startedAt = speedNow();
  const tab = await activeTikTokTab();
  const transferId = crypto.randomUUID().replace(/-/g, "");
  const chunkSize = 8 * 1024 * 1024;
  let offset = 0;
  let chunkCount = 0;
  let output: Uint8Array | null = null;
  while (true) {
    if (signal?.aborted) throw new AutoSubtitleCancelledError();
    const response = await chrome.tabs.sendMessage(tab.id!, {
      type: "FETCH_PAGE_MEDIA_CHUNK",
      transfer_id: transferId,
      media_url: mediaUrl,
      offset,
      chunk_size: chunkSize,
    }) as PageMediaChunkResponse | undefined;
    if (signal?.aborted) throw new AutoSubtitleCancelledError();
    chunkCount += 1;
    if (!response?.ok) {
      throw new Error(response?.error ?? "当前 TikTok 页面无法读取视频，请刷新页面后重试");
    }
    if (response.transfer_id !== transferId || response.offset !== offset) {
      throw new Error("视频分块响应与当前请求不匹配，请重试");
    }
    if (!Number.isSafeInteger(response.total_bytes) || response.total_bytes <= 0 || response.total_bytes > 512 * 1024 * 1024) {
      throw new Error("当前视频大小异常，无法在浏览器内生成字幕");
    }
    if (!output) output = new Uint8Array(response.total_bytes);
    if (output.byteLength !== response.total_bytes) throw new Error("视频大小在读取过程中发生变化，请重试");
    const chunk = decodeBase64Bytes(response.chunk_base64);
    if (!chunk.byteLength || offset + chunk.byteLength > output.byteLength) {
      throw new Error("视频分块数据不完整，请重试");
    }
    output.set(chunk, offset);
    offset += chunk.byteLength;
    onProgress({
      phase: "audio",
      percent: Math.min(100, Math.round(offset / output.byteLength * 100)),
      loadedBytes: offset,
      totalBytes: output.byteLength,
      message: "正在通过当前 TikTok 页面读取视频…",
    });
    if (response.done) {
      if (offset !== output.byteLength) throw new Error("TikTok 页面返回的视频不完整，请重试");
      speedLog("subtitle.media", taskId, "page_chunk_transfer_complete", startedAt, {
        byte_length: output.byteLength,
        chunk_count: chunkCount,
      });
      return output.buffer as ArrayBuffer;
    }
  }
}

function loadDownloadMediaBytesFromActivePage(
  mediaUrl: string,
  onProgress: (loadedBytes: number, totalBytes: number) => void = () => undefined,
): Promise<ArrayBuffer> {
  return requestMediaBytesFromActivePage(mediaUrl, (value) => {
    onProgress(value.loadedBytes ?? 0, value.totalBytes ?? 0);
  });
}

function decodeBase64Bytes(value: string): Uint8Array {
  if (!value || value.length > 12_000_000) throw new Error("视频分块编码无效");
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("视频分块编码损坏");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function requestPageMediaSave(
  media: Pick<CurrentMediaDescriptor, "video_id" | "media_url" | "author_unique_id" | "author_nickname">,
): Promise<string> {
  if (!media.media_url) throw new Error("当前页面尚未捕获可下载的视频地址");
  const tab = await activeTikTokTab();
  const author = media.author_unique_id || media.author_nickname || "TikTok";
  const fileName = safeSuggestedFilename(`${author}_${media.video_id}.mp4`);
  const response = await chrome.tabs.sendMessage(tab.id!, {
    type: "SAVE_PAGE_MEDIA",
    request_id: crypto.randomUUID().replace(/-/g, ""),
    media_url: media.media_url,
    file_name: fileName,
  }) as PageMediaSaveResponse | undefined;
  if (!response?.ok) throw new Error(response?.error ?? "TikTok 页面保存视频失败");
  return response.file_name;
}

async function saveBrowserSubtitleAs(
  media: CurrentMediaDescriptor,
  result: TranscriptionResponse,
): Promise<void> {
  const srt = result.segments.map((segment, index) => (
    `${index + 1}\n${srtTimestamp(segment.start)} --> ${srtTimestamp(segment.end)}\n${segment.text.trim()}`
  )).join("\n\n");
  if (!srt) return;
  const author = media.author_unique_id || media.author_nickname || "TikTok";
  const filename = safeSuggestedFilename(`${author}_${media.video_id}.srt`);
  const objectUrl = URL.createObjectURL(new Blob([`${srt}\n`], { type: "application/x-subrip;charset=utf-8" }));
  try {
    await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: true,
      conflictAction: "uniquify",
    });
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}

function srtTimestamp(value: number): string {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}

async function downloadBatch(mode: "video" | "audio_track"): Promise<void> {
  if (mediaOperationBusy) return;
  const archiveNaming = currentSnapshot
    ? [{
        video_id: currentSnapshot.video_id ?? "批量",
        author_unique_id: currentSnapshot.author.unique_id,
        author_nickname: currentSnapshot.author.nickname,
        description: null,
        created_at: currentSnapshot.created_at,
      }]
    : [{ video_id: "批量", author_unique_id: "TikTok", created_at: null }];
  const handle = await pickBatchArchiveTarget(archiveNaming);
  if (!handle) return;
  mediaOperationBusy = true;
  updateDownloadButtons();
  setNotice("正在汇总当前页面已加载的视频…", "info");
  try {
    const items = await requestBatchMedia();
    await downloadBatchInBrowser(handle, items, mode);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    console.error(`[TikTok 达人助手] 批量媒体处理失败：${message}`);
    setNotice(`批量处理失败：${message}`, "error");
  } finally {
    activeBatchJobId = null;
    mediaOperationBusy = false;
    updateDownloadButtons();
  }
}

async function downloadBatchInBrowser(
  handle: Awaited<ReturnType<typeof pickBatchArchiveTarget>> & {},
  items: BatchMediaDescriptor[],
  mode: "video" | "audio_track",
): Promise<void> {
  const browserJobId = `browser-${crypto.randomUUID()}`;
  activeBatchJobId = browserJobId;
  const result = await writeBatchArchiveTarget(
    handle,
    items,
    mode,
    loadDownloadMediaBytesFromActivePage,
    (message, processed, total, succeeded = 0, failed = 0) => {
      if (activeBatchJobId !== browserJobId) throw new Error("批量任务已停止");
      setNotice(`${message}（${processed}/${total}，成功 ${succeeded}，失败 ${failed}）`, "info");
    },
    (media) => resolveFreshTikTokMediaUrl(media),
  );
  const cancelled = activeBatchJobId !== browserJobId;
  setNotice(
    cancelled
      ? `批量任务已停止`
      : `ZIP 已保存：${result.fileName}，成功 ${result.succeeded}/${items.length}，失败 ${result.failed}`,
    result.failed || cancelled ? "info" : "success",
  );
}

async function cancelActiveBatch(): Promise<void> {
  if (!activeBatchJobId) return;
  if (activeBatchJobId.startsWith("browser-")) {
    activeBatchJobId = null;
    setNotice("已停止继续处理，当前正在保存的文件会正常结束。", "info");
    return;
  }
  elements.cancelBatchButton.disabled = true;
  try {
    const response = await fetch(`${API_BASE}/api/v1/downloads/batches/${activeBatchJobId}/cancel`, {
      method: "POST",
    });
    if (!response.ok) throw new Error(await apiError(response));
    setNotice("已请求取消，当前正在下载的文件结束后停止。", "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    setNotice(`取消失败：${message}`, "error");
    elements.cancelBatchButton.disabled = false;
  }
}

async function readApiFailure(response: Response): Promise<ApiFailure> {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === "string") {
      return { code: null, message: body.detail, modelIds: [], browserFallback: false };
    }
    if (body.detail && typeof body.detail === "object") {
      const detail = body.detail as {
        code?: unknown;
        message?: unknown;
        model_ids?: unknown;
        browser_fallback?: unknown;
      };
      return {
        code: typeof detail.code === "string" ? detail.code : null,
        message: typeof detail.message === "string" && detail.message.trim()
          ? detail.message
          : `HTTP ${response.status}`,
        modelIds: sanitizeLocalModelIds(detail.model_ids),
        browserFallback: detail.browser_fallback === true,
      };
    }
  } catch {
    // Keep only the status code; signed media URLs are never shown.
  }
  return { code: null, message: `HTTP ${response.status}`, modelIds: [], browserFallback: false };
}

async function apiError(response: Response): Promise<string> {
  return (await readApiFailure(response)).message;
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "未知大小";
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${Math.round(size)} B`;
}

type CopyExportData = DiagnosticInfo | ContainerStructureExport;
type CopyExportResponse = DiagnosticResponse | ContainerSummaryResponse;

function originAndPath(urlValue: string): string | null {
  try {
    const url = new URL(urlValue);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function sameOriginAndPath(left: string, right: string): boolean {
  const leftKey = originAndPath(left);
  const rightKey = originAndPath(right);
  return leftKey !== null && rightKey !== null && leftKey === rightKey;
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("浏览器拒绝写入剪贴板");
  }
}

async function requestExport(
  requestType: "GET_PAGE_EVIDENCE" | "GET_CONTAINER_SUMMARY",
  unavailableMessage: string,
): Promise<CopyExportData> {
  const tab = await activeTikTokTab();
  const tabId = tab.id!;
  if (currentTabId !== tabId) resetPageSession(tabId, tab.url ?? "https://www.tiktok.com/");
  const requestEpoch = stateEpoch;
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: requestType,
  })) as CopyExportResponse | undefined;
  if (!response?.ok) throw new Error(response?.error ?? unavailableMessage);

  const liveTab = await activeTikTokTab();
  if (
    requestEpoch !== stateEpoch ||
    liveTab.id !== tabId ||
    !liveTab.url ||
    !sameOriginAndPath(response.data.page_url, liveTab.url)
  ) {
    throw new Error("页面已切换，已取消复制旧页面数据");
  }
  if (!acceptSession(tabId, response.data.content_session_id, true)) {
    throw new Error("采集信息来自已失效的页面会话，请重试");
  }
  if (response.data.generation < currentGeneration) {
    throw new Error("采集信息已过期，请重试");
  }
  if (
    response.data.generation === currentGeneration &&
    response.data.snapshot_sequence < currentSnapshotSequence
  ) {
    throw new Error("采集信息已被更新，请重试");
  }
  return response.data;
}

async function copyPageEvidence(): Promise<void> {
  clearNotice();
  try {
    const data = await requestExport("GET_PAGE_EVIDENCE", "当前页面采集证据尚未生成");
    await writeClipboard(JSON.stringify(data, null, 2));
    setNotice("当前页面采集证据已复制，不包含 Cookie、Token、请求头或完整网页 DOM。", "success");
  } catch (error) {
    console.error("[TikTok 达人助手] 复制当前页面采集证据失败", error);
    setNotice(
      `复制失败：${error instanceof Error ? error.message : "未知错误"}`,
      "error",
    );
  }
}

async function copyContainerSummary(): Promise<void> {
  clearNotice();
  try {
    const data = await requestExport("GET_CONTAINER_SUMMARY", "当前容器结构摘要尚未生成");
    await writeClipboard(JSON.stringify(data, null, 2));
    setNotice("当前容器结构摘要已复制，仅包含有限、脱敏的结构信息。", "success");
  } catch (error) {
    console.error("[TikTok 达人助手] 复制当前容器结构摘要失败", error);
    setNotice(
      `复制失败：${error instanceof Error ? error.message : "未知错误"}`,
      "error",
    );
  }
}

elements.licenseForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void activateDeviceLicense();
});
elements.licenseKey.addEventListener("input", () => {
  elements.licenseKey.value = elements.licenseKey.value.toUpperCase().replace(/[^A-Z0-9-]/g, "");
});
elements.licenseRetryButton.addEventListener("click", () => void checkDeviceLicense(true));
elements.refreshButton.addEventListener("click", () => void refresh());
elements.saveButton.addEventListener("click", () => void save());
elements.rawButton.addEventListener("click", () => {
  elements.technicalDetails.open = true;
  elements.rawCard.hidden = !elements.rawCard.hidden;
  const label = elements.rawButton.querySelector("span");
  if (label) label.textContent = elements.rawCard.hidden ? "查看原始数据" : "收起原始数据";
});
elements.descriptionToggle.addEventListener("click", () => {
  descriptionExpanded = !descriptionExpanded;
  updateDescription(currentSnapshot);
});
elements.copyVideoIdButton.addEventListener("click", () => {
  const videoId = currentSnapshot?.video_id;
  if (!videoId) return;
  void writeClipboard(videoId)
    .then(() => setNotice("视频 ID 已复制。", "success"))
    .catch((error) => {
      console.error("[TikTok 达人助手] 复制视频 ID 失败", error);
      setNotice("复制视频 ID 失败，请重试。", "error");
    });
});
elements.diagnosticButton.addEventListener("click", () => void copyPageEvidence());
elements.containerSummaryButton.addEventListener("click", () => void copyContainerSummary());
elements.downloadVideoButton.addEventListener("click", () => void downloadCurrent("video"));
elements.downloadAudioButton.addEventListener("click", () => void downloadCurrent("audio_track"));
elements.transcribeButton.addEventListener("click", () => void transcribeCurrent());
elements.batchVideoButton.addEventListener("click", () => void downloadBatch("video"));
elements.batchAudioButton.addEventListener("click", () => void downloadBatch("audio_track"));
elements.cancelBatchButton.addEventListener("click", () => void cancelActiveBatch());
elements.modelInstallButton.addEventListener("click", () => void installRequiredModels());
elements.modelDismissButton.addEventListener("click", () => dismissModelRequirement());
elements.subtitleTargetLanguage.addEventListener("change", () => {
  void translateSubtitles(elements.subtitleTargetLanguage.value);
});
elements.subtitleBilingual.addEventListener("change", () => renderSubtitleSegments());
elements.subtitleAutoEnabled.addEventListener("change", () => {
  autoSubtitleSettings.enabled = elements.subtitleAutoEnabled.checked;
  autoSubtitleSequence += 1;
  cancelActiveAutoSubtitle(!autoSubtitleSettings.enabled);
  autoSubtitleWorkingVideoId = null;
  autoSubtitleWaitingForSpeechVideoId = null;
  autoSubtitleError = null;
  autoSubtitleRetryCounts.clear();
  cancelScheduledAutoSubtitle();
  renderAutoSubtitleControls();
  void persistAutoSubtitleSettings();
  if (autoSubtitleSettings.enabled) scheduleAutoSubtitle(0);
});
elements.subtitleAutoTranslate.addEventListener("change", () => {
  autoSubtitleSettings.translate = elements.subtitleAutoTranslate.checked;
  renderAutoSubtitleControls();
  void persistAutoSubtitleSettings();
  if (autoSubtitleSettings.enabled && autoSubtitleSettings.translate) {
    scheduleAutoSubtitle(0);
  } else {
    cancelOutstandingSubtitleTranslations();
    if (subtitleResult && subtitleVideoId === currentSnapshot?.video_id) {
      setSubtitleTranslationStatus("已关闭自动翻译，当前原字幕继续保留", "idle");
    }
  }
});

async function activateSidePanelView(
  view: "overview" | "subtitles" | "models",
  modelIds: LocalModelId[] = [],
): Promise<void> {
  document.body.dataset.view = view;
  const heading = document.querySelector<HTMLElement>(".product-header h1");
  if (view === "models") {
    if (heading) heading.textContent = "离线翻译";
    elements.subtitlePanel.hidden = false;
    await presentModelRequirement(
      modelIds.length ? modelIds : ["argos-en-zh"],
      "comment_translation",
      "",
      null,
      null,
    );
    return;
  }
  if (view === "subtitles") {
    if (heading) heading.textContent = "视频字幕";
    if (!elements.modelRequirementCard.hidden) hideModelRequirement();
    elements.subtitlePanel.hidden = false;
    setSubtitleTranslationStatus("正在生成字幕，首次识别可能需要一些时间…", "loading");
    if (!mediaOperationBusy && !subtitleAutoStarted) {
      subtitleAutoStarted = true;
      void transcribeCurrent();
    }
    return;
  }
  if (heading) heading.textContent = "TikTok 达人助手";
}

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (
    message && typeof message === "object" &&
    (message as { type?: unknown }).type === "SIDE_PANEL_VIEW"
  ) {
    const payload = message as { view?: unknown; model_ids?: unknown };
    if (payload.view === "subtitles" || payload.view === "models" || payload.view === "overview") {
      void activateSidePanelView(payload.view, sanitizeLocalModelIds(payload.model_ids));
      return false;
    }
  }
  if (!isPageUpdateMessage(message)) return false;
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
    if (!activeTab?.id || sender.tab?.id !== activeTab.id) return;
    if (!acceptSession(activeTab.id, message.session_id, false)) return;
    if (message.type === "PAGE_INVALIDATED") {
      if (message.generation < currentGeneration) return;
      if (message.generation === currentGeneration && currentSnapshot !== null) return;
      currentGeneration = message.generation;
      currentSnapshotSequence = message.snapshot_sequence;
      invalidateSnapshot(message.url);
    } else if (message.type === "PAGE_DATA_UPDATED") {
      if (message.generation < currentGeneration) return;
      if (
        message.generation === currentGeneration &&
        message.snapshot_sequence < currentSnapshotSequence
      ) {
        return;
      }
      if (message.data.page_url !== activeTab.url) return;
      currentGeneration = message.generation;
      currentSnapshotSequence = message.snapshot_sequence;
      renderSnapshot(message.data);
    }
  });
  return false;
});

function isPageUpdateMessage(message: unknown): message is PageUpdateMessage {
  if (!message || typeof message !== "object") return false;
  const type = (message as { type?: unknown }).type;
  return type === "PAGE_DATA_UPDATED" || type === "PAGE_INVALIDATED";
}

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "session") return;
  if (CARD_MEDIA_DOWNLOAD_QUEUE_KEY in changes) void processPendingCardDownloads();
  if (FOREGROUND_TRANSLATION_QUEUE_KEY in changes) void processPendingForegroundTranslations();
});

chrome.tabs.onActivated.addListener(() => {
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab?.id) return;
    resetPageSession(tab.id, tab.url ?? "暂未获取");
    if (tab.url?.startsWith("https://www.tiktok.com/")) void refresh();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active || currentTabId !== tabId) return;
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    resetPageSession(tabId, changeInfo.url ?? tab.url ?? "暂未获取");
  }
  if (changeInfo.status === "complete" && tab.url?.startsWith("https://www.tiktok.com/")) {
    void refresh();
  }
});

interface SidePanelIntent {
  view: "overview" | "subtitles" | "models";
  modelIds: LocalModelId[];
}

async function consumeSidePanelIntent(): Promise<SidePanelIntent> {
  const sessionStorage = chrome.storage?.session;
  if (!sessionStorage) return { view: "overview", modelIds: [] };
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await sessionStorage.get(SIDE_PANEL_INTENT_KEY);
  const intent = stored[SIDE_PANEL_INTENT_KEY] as {
    tab_id?: unknown;
    view?: unknown;
    requested_at?: unknown;
    model_ids?: unknown;
  } | undefined;
  if (typeof sessionStorage.remove === "function") await sessionStorage.remove(SIDE_PANEL_INTENT_KEY);
  if (!intent) return { view: "overview", modelIds: [] };
  if (
    intent.tab_id === activeTab?.id &&
    (intent.view === "subtitles" || intent.view === "models") &&
    typeof intent.requested_at === "number" &&
    Date.now() - intent.requested_at < 30_000
  ) {
    return {
      view: intent.view,
      modelIds: sanitizeLocalModelIds(intent.model_ids),
    };
  }
  return { view: "overview", modelIds: [] };
}

async function initializeAuthorizedSidePanel(): Promise<void> {
  if (!licenseAuthorized || authorizedSidePanelInitialized) return;
  authorizedSidePanelInitialized = true;
  elements.saveButton.disabled = true;
  updateDownloadButtons();
  await Promise.all([
    loadAutoSubtitleSettings(),
    loadAutoSubtitleSessionCache(),
  ]);
  const intent = await consumeSidePanelIntent().catch((): SidePanelIntent => ({
    view: "overview",
    modelIds: [],
  }));
  document.body.dataset.view = intent.view;
  if (intent.view === "subtitles" || intent.view === "models") {
    const heading = document.querySelector<HTMLElement>(".product-header h1");
    if (heading) heading.textContent = intent.view === "subtitles" ? "视频字幕" : "离线翻译";
  }
  void checkHealth();
  await refresh();
  if (intent.view === "models") {
    await activateSidePanelView("models", intent.modelIds);
  } else if (intent.view === "subtitles" && currentSnapshot?.video_id) {
    await activateSidePanelView("subtitles");
  }
  void processPendingCardDownloads();
  void processPendingForegroundTranslations();
}

void checkDeviceLicense();
