import type { ActiveMediaContext } from "../extractors/activeVideo";
import { hasExplicitCommercialDisclosure } from "../extractors/commercialDisclosure";
import { limitBatchDownloadItems } from "../downloads/batchLimit";
import {
  pickBatchArchiveTarget,
  pickSingleMediaTarget,
  writeBatchArchiveTarget,
  writeSingleMediaTarget,
} from "../downloads/browserWorkflow";
import { resolveFreshTikTokMediaUrl } from "../downloads/tiktokMediaResolver";
import {
  collectEmptyPage,
  collectGridCardPage,
  collectHomePage,
  collectHomeRegistrySnapshot,
  collectVideoDetailPage,
  gridOverlayValues,
  materializedRegistryItem,
  type PageCollectionResult,
} from "../extractors/pageData";
import {
  createHomeActiveVideoResolver,
  detectSurfaceMode,
  resolveHomeActiveVideo,
  resolveHoveredCard,
  resolveVideoCards,
  resolveVideoDetailContext,
  type CompositeVideoContext,
  type GridSurfaceMode,
  type SurfaceMode,
  type VideoCardContext,
} from "../extractors/surfaces";
import { VideoItemRegistry, type RegistryVideoRecord } from "../registry/videoItemRegistry";
import type {
  BatchMediaDescriptorsResponse,
  ContainerSummaryResponse,
  ContentRequest,
  ContentResponse,
  CurrentTikTokCaptionResponse,
  CurrentMediaDescriptor,
  DiagnosticResponse,
  GetKnownAdVideoIdsRequest,
  KnownAdVideoIdsResponse,
  MediaDescriptorResponse,
  PageMediaChunkResponse,
  PageMediaSaveResponse,
  PageUpdateMessage,
  ReportKnownAdVideoRequest,
} from "../types/messages";
import type {
  ActiveVideoDiagnostic,
  ContainerStructureExport,
  DiagnosticInfo,
  FieldEvidence,
  PageType,
  Snapshot,
} from "../types/snapshot";
import {
  sanitizeEvidence as sanitizeEvidenceText,
  sanitizePathname,
  summarizeContainerStructure,
  type EvidenceRoot,
} from "./evidence";
import { selectGridCardsForBatch } from "./batchSelection";
import { GridOverlayController } from "./gridOverlay";
import { HydrationScanner } from "./hydrationScanner";
import { NetworkRegistryConsumer } from "./networkRegistry";
import { OverlayController, type OverlayVideoTarget } from "./overlay";
import {
  ProfileToolbarController,
  resolveProfileCardLayoutRoot,
  type ProfileVideoItem,
} from "./profileToolbar";
import { ActiveVideoSession } from "./session";
import { resolveTikTokPageCaption } from "./tikTokCaption";
import { TranslationController, type TranslationPageContext } from "./translation";
import { LICENSE_ENFORCED } from "../license/config";
import type { LicenseStatus } from "../license/types";

// 保持阶段 1.2 已使用的哨兵名，扩展重载但页面尚未刷新时也不会与旧内容脚本并存。
const INJECTED_KEY = "__TIKTOK_DAREN_ASSISTANT_STAGE12__";
const DEBUG_KEY = "__TIKTOK_DAREN_ASSISTANT_DEBUG__";
const HISTORY_EVENT = "tiktok-daren-assistant:history-change";
const DEBUG_EVENT = "tiktok-daren-assistant:debug-update";
const NETWORK_EVENT = "tiktok-daren-assistant:network-items";
const HYDRATION_EVENT = "tiktok-daren-assistant:hydration-items";
const NETWORK_READY_EVENT = "tiktok-daren-assistant:network-ready";
const HYDRATION_RESCAN_EVENT = "tiktok-daren-assistant:hydration-rescan";
const MEDIA_FETCH_REQUEST_EVENT = "tiktok-daren-assistant:media-fetch-request";
const MEDIA_FETCH_RESPONSE_EVENT = "tiktok-daren-assistant:media-fetch-response";
const MEDIA_SAVE_REQUEST_EVENT = "tiktok-daren-assistant:media-save-request";
const MEDIA_SAVE_RESPONSE_EVENT = "tiktok-daren-assistant:media-save-response";
const ASSISTANT_SELECTOR = "[data-tiktok-daren-assistant]";
const COMMERCIAL_DISCLOSURE_MUTATION_SELECTOR = [
  '[data-e2e="sponsored-tag"]',
  '[data-e2e*="commercial-disclosure" i]',
  '[data-e2e*="paid-partnership" i]',
  '[data-e2e*="promotional-content" i]',
  '[data-e2e*="creator-commission" i]',
  '[class*="-DivAnchorTagWrapper"]',
].join(",");
const RELEVANT_MUTATION_SELECTOR = [
  "video",
  "article",
  'a[href*="/video/"]',
  'a[href*="/photo/"]',
  "img",
  '[data-e2e="recommend-list-item-container"]',
  '[data-e2e="feed-item"]',
  '[data-e2e="user-post-item-list"]',
  '[data-e2e="user-post-item"]',
  '[data-e2e="search-card-video-container"]',
  '[data-e2e="video-card"]',
  '[data-e2e="browse-video"]',
  '[data-e2e="video-detail"]',
  COMMERCIAL_DISCLOSURE_MUTATION_SELECTOR,
  '[data-e2e*="count"]',
  '[data-e2e="video-views"]',
  'script[type="application/json"]',
  "#__UNIVERSAL_DATA_FOR_REHYDRATION__",
  "#SIGI_STATE",
  '[role="dialog"]',
].join(",");
const HYDRATION_MUTATION_SELECTOR = [
  "#__UNIVERSAL_DATA_FOR_REHYDRATION__",
  "#SIGI_STATE",
  'script[type="application/json"]',
  'script[id*="HYDRATION" i]',
  'script[id*="STATE" i]',
  'script[id*="DATA" i]',
  "script[data-hydration]",
].join(",");
const MEANINGFUL_MUTATION_ATTRIBUTES = new Set([
  "src",
  "poster",
  "href",
  "aria-current",
  "data-active",
  "data-video-id",
  "data-item-id",
  "data-aweme-id",
  "id",
  "type",
  "data-hydration",
]);

type ContentScope = typeof globalThis & Record<string, unknown>;

interface SurfaceState {
  mode: SurfaceMode;
  home: ActiveMediaContext | null;
  detail: CompositeVideoContext | null;
  cards: VideoCardContext[];
  hoveredCard: VideoCardContext | null;
  homeMediaKey: string | null;
  identity: string;
}

const scope = globalThis as ContentScope;

async function requestAuthorizedContentStart(force = false): Promise<void> {
  if (scope[INJECTED_KEY]) return;
  if (!LICENSE_ENFORCED) {
    initializeAuthorizedContent();
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_LICENSE_STATUS", force }) as LicenseStatus;
    if (response?.authorized) initializeAuthorizedContent();
  } catch {
    // 主控不可用或尚未绑定时不向 TikTok 页面注入任何可操作功能。
  }
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (
    message && typeof message === "object" &&
    (message as { type?: unknown }).type === "LICENSE_ACTIVATED"
  ) {
    void requestAuthorizedContentStart(true);
  }
  return false;
});

void requestAuthorizedContentStart();

function initializeAuthorizedContent(): void {
  if (scope[INJECTED_KEY]) return;
  scope[INJECTED_KEY] = true;

  const session = new ActiveVideoSession();
  const registry = new VideoItemRegistry({ maxEntries: 500, ttlMs: 30 * 60 * 1_000 });
  const hydrationScanner = new HydrationScanner();
  const networkConsumer = new NetworkRegistryConsumer();
  let autoUpdateEnabled = true;
  const overlay = new OverlayController(document, window, {
    onManualRefresh: () => schedule(0, true),
    onDownload: async (mode) => {
      const media = createCurrentMediaDescriptor();
      const handle = await pickSingleMediaTarget(media, mode);
      if (!handle) return;
      await writeSingleMediaTarget(handle, media, mode, readMediaBytesFromPage);
    },
    onOpenSubtitles: async () => {
      const response = await chrome.runtime.sendMessage({
        type: "OPEN_SIDE_PANEL",
        view: "subtitles",
      });
      if (!response?.ok) throw new Error(response?.error ?? "无法打开字幕工作区");
    },
    onSettingsChange: (settings) => {
      autoUpdateEnabled = settings.autoUpdate;
      if (!autoUpdateEnabled) {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        scheduledFor = 0;
        scheduledManual = false;
      } else {
        schedule(40);
      }
    },
  });
  const gridOverlay = new GridOverlayController(document, window, {
    onDownload: async (media, mode) => {
      const handle = await pickSingleMediaTarget(media, mode);
      if (!handle) return;
      await writeSingleMediaTarget(handle, media, mode, readMediaBytesFromPage);
    },
    onBatchSelectionChange: (videoId, selected) => {
      profileToolbar.setItemSelected(videoId, selected);
    },
  });
  const profileToolbar = new ProfileToolbarController(document, window, {
    onRefresh: () => schedule(0, true),
    onBatchDownload: async (items, mode, onProgress) => {
      const limited = limitBatchDownloadItems(items);
      const descriptors = limited.items.map((item) => ({
        video_id: item.video_id,
        page_url: item.page_url ?? `https://www.tiktok.com/@_/video/${item.video_id}`,
        media_url: item.media_url ?? null,
        media_source: item.media_url ? "registry_play_url" as const : "yt_dlp_fallback" as const,
        background_music_url: item.background_music_url ?? null,
        author_unique_id: item.author_unique_id ?? null,
        author_nickname: item.author_nickname ?? null,
        description: item.description ?? null,
        created_at: item.created_at,
      }));
      const handle = await pickBatchArchiveTarget(descriptors);
      if (!handle) return { succeeded: 0, failed: 0, cancelled: true };
      const result = await writeBatchArchiveTarget(handle, descriptors, mode, readMediaBytesFromPage, (_, processed, total, succeeded = 0, failed = 0) => {
        onProgress({
          processed,
          total,
          succeeded,
          failed,
          status: processed >= total ? (failed ? "partial" : "completed") : "running",
        });
      }, (media) => resolveFreshTikTokMediaUrl(media));
      return result;
    },
    autoScrollStep: () => {
      window.scrollBy({
        top: Math.max(360, Math.round(window.innerHeight * 0.72)),
        behavior: "smooth",
      });
      schedule(260, true);
    },
    onBatchSelectionChange: () => schedule(0, true),
  });
  const homeResolver = createHomeActiveVideoResolver(document, window, () => signalActiveChange(100));
  const contentSessionId = createSessionId();
  const reportedKnownAdVideoIds = new Set<string>();
  const knownAdVideoIds = new Set<string>();

  hydrationScanner.scan(document, registry);
  publishKnownAds();
  let hoveredTarget: EventTarget | null = null;
  let hydrationDirty = false;
  let guardedHomeIdentity: string | null = null;
  let observedUrl = window.location.href;
  let surfaceState = resolveSurfaceState();
  const translationController = new TranslationController(document, window, {
    resolveContext: () => resolveTranslationPageContext(surfaceState),
  });
  translationController.install();
  let latestResult: PageCollectionResult | null = null;
  let latestDiagnostic: DiagnosticInfo | null = null;
  let generation = 0;
  let snapshotSequence = 0;
  let activeChangedForNextSnapshot = false;
  let timer: number | null = null;
  let scheduledFor = 0;
  let scheduledManual = false;
  let lastExtractionAt = 0;
  let extracting = false;
  let pending = false;
  let pendingManual = false;
  let profileToolbarRoot: HTMLElement | null = null;
  let profileToolbarPageIdentity: string | null = null;
  let gridViewportTimer: number | null = null;

  session.observe(surfaceState.identity);
  const initialRegistrySnapshot = registrySnapshotForOverlay(surfaceState);
  updateSurfaceOverlays(surfaceState, initialRegistrySnapshot, !initialRegistrySnapshot);

  function resolveSurfaceState(): SurfaceState {
    const mode = detectSurfaceMode(window.location.href);
    if (mode === "home_feed") {
      const home = resolveHomeActiveVideo(homeResolver);
      return {
        mode,
        home,
        detail: null,
        cards: [],
        hoveredCard: null,
        homeMediaKey: home ? homeMediaIdentity(home.mediaElement) : null,
        identity: home ? `home:${home.identity}` : "home:recognizing",
      };
    }
    if (mode === "video_detail") {
      const detail = resolveVideoDetailContext(window.location.href, document);
      return {
        mode,
        home: null,
        detail,
        cards: [],
        hoveredCard: null,
        homeMediaKey: null,
        identity: detail ? `detail:${detail.videoId}` : "detail:recognizing",
      };
    }
    if (isGridMode(mode)) {
      const cards = resolveVideoCards(document, mode);
      const hoveredCard = resolveHoveredCard(cards, hoveredTarget);
      return {
        mode,
        home: null,
        detail: null,
        cards,
        hoveredCard,
        homeMediaKey: null,
        identity: hoveredCard ? `card:${hoveredCard.videoId}` : `grid:${mode}:none`,
      };
    }
    return {
      mode,
      home: null,
      detail: null,
      cards: [],
      hoveredCard: null,
      homeMediaKey: null,
      identity: `surface:${mode}:${safePagePath(window.location.href)}`,
    };
  }

  function resolveTranslationPageContext(state: SurfaceState): TranslationPageContext | null {
    const contentRoot =
      state.mode === "home_feed"
        ? state.home?.activeRoot ?? null
        : state.mode === "video_detail"
          ? state.detail?.pageRoot ?? null
          : null;
    if (!contentRoot) return null;

    const commentScopes = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-e2e="comment-level-1"], [data-e2e="comment-level-2"]',
      ),
    ).filter(isVisibleTranslationScope);
    const commentsOpen = Array.from(
      document.querySelectorAll<HTMLElement>(
        [
          '[data-e2e="comment-input"]',
          '[data-e2e="comment-input-container"]',
          '[data-e2e="comment-list"]',
          '[data-e2e="browse-comment-list"]',
          '[class*="DivCommentListContainer"]',
          '[data-e2e="comment-level-1"]',
        ].join(","),
      ),
    ).some(isVisibleTranslationScope);

    return {
      identity: state.identity,
      roots: [contentRoot, ...commentScopes],
      commentsOpen,
    };
  }

  function isVisibleTranslationScope(element: HTMLElement): boolean {
    if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function refreshSurfaceIdentity(): { changed: boolean; urlChanged: boolean } {
    const currentUrl = window.location.href;
    const urlChanged = currentUrl !== observedUrl;
    if (urlChanged) observedUrl = currentUrl;

    const previous = surfaceState;
    const next = resolveSurfaceState();
    if (
      previous.mode === "home_feed" &&
      next.mode === "home_feed" &&
      previous.home &&
      next.home &&
      previous.home.mediaElement === next.home.mediaElement &&
      previous.home.videoId === next.home.videoId &&
      previous.homeMediaKey !== null &&
      next.homeMediaKey !== null &&
      previous.homeMediaKey !== next.homeMediaKey
    ) {
      guardedHomeIdentity = next.home.identity;
    } else if (
      next.mode !== "home_feed" ||
      !next.home ||
      (guardedHomeIdentity !== null && next.home.identity !== guardedHomeIdentity)
    ) {
      guardedHomeIdentity = null;
    }
    const changed = session.observe(next.identity);
    surfaceState = next;

    if (changed || urlChanged) {
      document.dispatchEvent(new CustomEvent(HYDRATION_RESCAN_EVENT));
      generation += 1;
      activeChangedForNextSnapshot ||= changed;
      latestResult = null;
      latestDiagnostic = createLoadingDiagnostic(next, changed || urlChanged);
      publishDebug(latestDiagnostic);
      const registrySnapshot = registrySnapshotForOverlay(next);
      updateSurfaceOverlays(next, registrySnapshot, !registrySnapshot);
      translationController.refresh();
      sendUpdate({
        type: "PAGE_INVALIDATED",
        url: currentUrl,
        generation,
        snapshot_sequence: snapshotSequence,
        session_id: contentSessionId,
      });
    }
    return { changed, urlChanged };
  }

  function collect(force = false): Snapshot {
    if (hydrationDirty) {
      hydrationScanner.scan(document, registry);
      hydrationDirty = false;
    }
    refreshSurfaceIdentity();
    // The session cache can arrive before TikTok mounts the current card or
    // detail view. Re-apply it after resolving the latest surface so a known
    // advertisement is not missed merely because of message timing.
    applyKnownAdsToRelevantRegistry();
    const stateAtStart = surfaceState;
    const currentUrl = window.location.href;
    const identityAtStart = stateAtStart.identity;
    const generationAtStart = generation;
    const cached = session.get(identityAtStart, currentUrl);
    if (!force && cached) {
      if (isGridMode(stateAtStart.mode)) renderGridLabels(stateAtStart);
      return cached;
    }

    const result = collectSurface(stateAtStart, currentUrl);
    publishKnownAds();

    refreshSurfaceIdentity();
    if (
      window.location.href !== currentUrl ||
      surfaceState.identity !== identityAtStart ||
      session.currentKey !== identityAtStart ||
      generation !== generationAtStart
    ) {
      throw new Error("当前视频在采集过程中已切换，已丢弃旧结果");
    }

    latestResult = result;
    session.store(identityAtStart, result.snapshot);
    snapshotSequence += 1;
    lastExtractionAt = Date.now();
    latestDiagnostic = createDiagnostic(result, stateAtStart, activeChangedForNextSnapshot);
    activeChangedForNextSnapshot = false;
    publishDebug(latestDiagnostic);
    updateSurfaceOverlays(stateAtStart, result.snapshot, false);
    renderGridLabels(stateAtStart);
    return result.snapshot;
  }

  function collectSurface(state: SurfaceState, pageUrl: string): PageCollectionResult {
    if (state.mode === "home_feed") {
      return collectHomePage(
        pageUrl,
        state.home,
        registry,
        session.switchCount,
        activeChangedForNextSnapshot,
        state.home?.identity === guardedHomeIdentity,
      );
    }
    if (state.mode === "video_detail" && state.detail) {
      return collectVideoDetailPage(state.detail, registry);
    }
    if (isGridMode(state.mode)) {
      return collectGridCardPage(
        pageUrl,
        state.mode,
        state.hoveredCard,
        registry,
        state.cards.length,
      );
    }
    return collectEmptyPage(pageUrl, state.mode);
  }

  function runScheduled(): void {
    timer = null;
    scheduledFor = 0;
    const isManual = scheduledManual;
    scheduledManual = false;
    if (extracting) {
      pending = true;
      pendingManual ||= isManual;
      return;
    }
    extracting = true;
    try {
      const data = collect(true);
      sendUpdate({
        type: "PAGE_DATA_UPDATED",
        data,
        generation,
        snapshot_sequence: snapshotSequence,
        session_id: contentSessionId,
      });
    } catch (error) {
      console.debug("[TikTok 达人助手] 本轮自动采集已取消或失败", error);
      overlay.showError(overlayTarget(surfaceState));
      if (!isManual && autoUpdateEnabled) schedule(180);
    } finally {
      extracting = false;
      if (pending) {
        const resumeManual = pendingManual;
        pending = false;
        pendingManual = false;
        schedule(180, resumeManual);
      }
    }
  }

  function schedule(delay = 260, manual = false): void {
    if (!manual && !autoUpdateEnabled) return;
    const now = Date.now();
    const target = Math.max(now + delay, lastExtractionAt + 300);
    scheduledManual ||= manual;
    if (timer !== null && scheduledFor <= target) return;
    if (timer !== null) window.clearTimeout(timer);
    scheduledFor = target;
    timer = window.setTimeout(runScheduled, Math.max(0, target - now));
  }

  function signalActiveChange(delay = 100): void {
    refreshSurfaceIdentity();
    schedule(delay);
  }

  function sendUpdate(message: PageUpdateMessage): void {
    chrome.runtime.sendMessage(message).catch(() => {
      // 侧边栏关闭时没有接收者是正常情况。
    });
  }

  function publishKnownAds(): void {
    const newlyKnown: string[] = [];
    for (const record of registry.list()) {
      if (record.fields.is_ad?.value !== true || reportedKnownAdVideoIds.has(record.video_id)) {
        continue;
      }
      rememberKnownAdLocally(record.video_id);
      reportedKnownAdVideoIds.add(record.video_id);
      newlyKnown.push(record.video_id);
    }
    if (newlyKnown.length === 0) return;
    const request: ReportKnownAdVideoRequest = {
      type: "REPORT_KNOWN_AD_VIDEO",
      video_ids: newlyKnown,
    };
    void chrome.runtime.sendMessage(request)
      .then((response: KnownAdVideoIdsResponse) => {
        if (response?.ok) return;
        for (const videoId of newlyKnown) reportedKnownAdVideoIds.delete(videoId);
      })
      .catch(() => {
        // Service worker 被挂起时允许下一轮采集重试，不锁死同步状态。
        for (const videoId of newlyKnown) reportedKnownAdVideoIds.delete(videoId);
      });
  }

  function applyKnownAdVideoIds(videoIds: readonly string[]): void {
    for (const videoId of videoIds.slice(-1_000)) {
      if (!/^\d{10,25}$/.test(videoId)) continue;
      rememberKnownAdLocally(videoId);
      reportedKnownAdVideoIds.add(videoId);
    }
    const changed = applyKnownAdsToRelevantRegistry();
    if (!changed) return;
    if (isGridMode(surfaceState.mode)) renderGridLabels(surfaceState);
    if (!renderRegistryOverlayIfAvailable()) schedule(0, true);
  }

  function rememberKnownAdLocally(videoId: string): void {
    knownAdVideoIds.delete(videoId);
    knownAdVideoIds.add(videoId);
    while (knownAdVideoIds.size > 1_000) {
      const oldest = knownAdVideoIds.values().next().value as string | undefined;
      if (!oldest) break;
      knownAdVideoIds.delete(oldest);
      reportedKnownAdVideoIds.delete(oldest);
    }
  }

  function applyKnownAdsToRelevantRegistry(): boolean {
    const records = registry.list();
    const relevantIds = new Set(records.map((record) => record.video_id));
    for (const card of surfaceState.cards) relevantIds.add(card.videoId);
    if (surfaceState.detail) relevantIds.add(surfaceState.detail.videoId);
    if (surfaceState.home?.videoId) relevantIds.add(surfaceState.home.videoId);

    const currentById = new Map(records.map((record) => [record.video_id, record]));
    let changed = false;
    for (const videoId of knownAdVideoIds) {
      if (!relevantIds.has(videoId) || currentById.get(videoId)?.fields.is_ad?.value === true) {
        continue;
      }
      registry.upsert({ video_id: videoId, is_ad: true }, "extension_cache");
      changed = true;
    }
    return changed;
  }

  function renderGridLabels(state: SurfaceState): void {
    if (!isGridMode(state.mode)) {
      gridOverlay.clear();
      clearProfileToolbar();
      return;
    }
    applyKnownAdsToRelevantRegistry();
    let foundNativeDisclosure = false;
    for (const card of state.cards) {
      if (
        registry.getItem(card.videoId)?.is_ad !== true &&
        hasExplicitCommercialDisclosure(card.cardRoot)
      ) {
        registry.upsert({ video_id: card.videoId, is_ad: true }, "scoped_dom");
        foundNativeDisclosure = true;
      }
    }
    if (foundNativeDisclosure) publishKnownAds();
    const mapped = state.cards.map((card) => {
      const registryItem = registry.getItem(card.videoId);
      const values = gridOverlayValues(card, registry);
      const createdAt = registryItem?.created_at ?? null;
      const sources = registry.getMediaSources(card.videoId);
      const cardVideoUrl = signedHttpUrl(card.hoverVideo?.currentSrc || card.hoverVideo?.src || null);
      const mediaDescriptor: CurrentMediaDescriptor | null = card.contentType === "video"
        ? {
            video_id: card.videoId,
            page_url: new URL(card.videoLinkPathname, window.location.origin).href,
            media_url: sources?.play_url ?? cardVideoUrl,
            media_source: sources?.play_url
              ? "registry_play_url"
              : cardVideoUrl
                ? "active_video_src"
                : "yt_dlp_fallback",
            background_music_url: sources?.background_music_url ?? null,
            music_title: sources?.music_title ?? null,
            author_unique_id: registryItem?.author.unique_id ?? card.authorUniqueId,
            author_nickname: registryItem?.author.nickname ?? null,
            description: registryItem?.description ?? null,
            created_at: createdAt,
          }
        : null;
      const cardData = {
        cardRoot: card.cardRoot,
        videoId: card.videoId,
        play_count: values.play_count,
        duration: values.duration,
        like_count: registryItem?.metrics.like_count ?? null,
        comment_count: registryItem?.metrics.comment_count ?? null,
        collect_count: registryItem?.metrics.collect_count ?? null,
        share_count: registryItem?.metrics.share_count ?? null,
        created_at: createdAt,
        publish_time_text: registryItem?.publish_time_text ?? null,
        description: registryItem?.description ?? null,
        is_ad: registryItem?.is_ad ?? null,
        has_product: registryItem?.has_product ?? null,
        data_complete: [
          values.play_count,
          registryItem?.metrics.like_count,
          registryItem?.metrics.comment_count,
          registryItem?.metrics.collect_count,
          registryItem?.metrics.share_count,
          values.duration,
          createdAt,
        ].every((value) => typeof value === "number" && Number.isFinite(value)),
        isNearViewport: isNearViewport(card.cardRoot),
        mediaDescriptor,
        batchSelectable: state.mode === "profile_grid" && card.contentType === "video",
        batchSelected: state.mode !== "profile_grid" || profileToolbar.isItemSelected(card.videoId),
      };
      return { card, registryItem, cardData };
    });
    gridOverlay.render(mapped.map(({ cardData }) => cardData));
    gridOverlay.setHoveredVideoId(state.hoveredCard?.videoId ?? null);

    if (state.mode === "profile_grid") {
      renderProfileToolbar(
        mapped.map(({ card, registryItem, cardData }) => ({
          video_id: card.videoId,
          cardRoot: card.cardRoot,
          content_type: card.contentType,
          author_unique_id: registryItem?.author.unique_id ?? null,
          author_nickname: registryItem?.author.nickname ?? null,
          media_url: cardData.mediaDescriptor?.media_url ?? null,
          background_music_url: cardData.mediaDescriptor?.background_music_url ?? null,
          description: registryItem?.description ?? null,
          is_ad: cardData.is_ad,
          created_at: cardData.created_at,
          play_count: cardData.play_count,
          like_count: cardData.like_count,
          comment_count: cardData.comment_count,
          collect_count: cardData.collect_count,
          share_count: cardData.share_count,
          duration_seconds: cardData.duration,
          page_url: new URL(card.videoLinkPathname, window.location.origin).href,
          isVisible: isVisibleCard(card.cardRoot),
        })),
        state.cards,
      );
    } else {
      clearProfileToolbar();
    }
  }

  function renderProfileToolbar(
    items: ProfileVideoItem[],
    cards: VideoCardContext[],
  ): void {
    const pageIdentity = safePagePath(window.location.href);
    const gridRoot =
      cards[0]?.cardRoot.closest<HTMLElement>('[data-e2e="user-post-item-list"]') ??
      document.querySelector<HTMLElement>('[data-e2e="user-post-item-list"]') ??
      cards[0]?.cardRoot.parentElement ??
      null;
    if (!gridRoot) {
      clearProfileToolbar();
      return;
    }
    const layoutItems = items.map((item) => ({
      ...item,
      cardRoot: item.cardRoot
        ? resolveProfileCardLayoutRoot(item.cardRoot, gridRoot, item.video_id)
        : undefined,
    }));
    if (profileToolbarRoot !== gridRoot || profileToolbarPageIdentity !== pageIdentity) {
      profileToolbar.destroy();
      profileToolbar.mount(gridRoot, layoutItems);
      profileToolbarRoot = gridRoot;
      profileToolbarPageIdentity = pageIdentity;
    } else {
      profileToolbar.update(layoutItems);
    }
  }

  function clearProfileToolbar(): void {
    if (!profileToolbarRoot) return;
    profileToolbar.destroy();
    profileToolbarRoot = null;
    profileToolbarPageIdentity = null;
  }

  function updateSurfaceOverlays(
    state: SurfaceState,
    snapshot: Snapshot | null,
    loading: boolean,
  ): void {
    if (isGridMode(state.mode) || state.mode === "other") {
      overlay.showLoading(null);
      return;
    }
    const target = overlayTarget(state);
    if (!target || loading || !snapshot) overlay.showLoading(target);
    else overlay.render(snapshot, target);
  }

  function registrySnapshotForOverlay(state: SurfaceState): Snapshot | null {
    if (
      state.mode !== "home_feed" ||
      !state.home ||
      state.home.identity === guardedHomeIdentity
    ) {
      return null;
    }
    return collectHomeRegistrySnapshot(window.location.href, state.home, registry);
  }

  function renderRegistryOverlayIfAvailable(): boolean {
    const snapshot = registrySnapshotForOverlay(surfaceState);
    if (!snapshot) return false;
    updateSurfaceOverlays(surfaceState, snapshot, false);
    return true;
  }

  function overlayTarget(state: SurfaceState): OverlayVideoTarget | null {
    if (state.mode === "home_feed" && state.home) {
      return {
        surface: "feed",
        video: state.home.video,
        mediaElement: state.home.mediaElement,
        nativeRoot: state.home.activeRoot,
      };
    }
    if (state.mode === "video_detail" && state.detail?.mediaRoot) {
      const mediaElement = state.detail.video ??
        state.detail.mediaRoot.querySelector<HTMLElement>('img, [data-e2e*="photo"]') ??
        state.detail.mediaRoot;
      return {
        surface: "detail",
        video: state.detail.video,
        mediaElement,
        nativeRoot: state.detail.pageRoot,
        metadataRoot: state.detail.metadataRoot,
      };
    }
    return null;
  }

  function isAssistantMutation(record: MutationRecord): boolean {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (target?.closest(ASSISTANT_SELECTOR)) return true;
    const changed = [...record.addedNodes, ...record.removedNodes];
    return (
      changed.length > 0 &&
      changed.every(
        (node) =>
          node instanceof Element &&
          (node.matches(ASSISTANT_SELECTOR) || Boolean(node.closest(ASSISTANT_SELECTOR))),
      )
    );
  }

  function isRelevantMutation(record: MutationRecord): boolean {
    if (isAssistantMutation(record)) return false;
    const target = record.target instanceof Element ? record.target : record.target.parentElement;

    if (record.type === "characterData") {
      return Boolean(target?.closest(RELEVANT_MUTATION_SELECTOR));
    }
    if (record.type === "attributes") {
      if (!target) return false;
      // TikTok continuously mutates class/style while scroll snapping and
      // animating controls. Those changes do not alter the active video's data
      // and must not schedule a full extraction on every animation frame.
      if (!MEANINGFUL_MUTATION_ATTRIBUTES.has(record.attributeName ?? "")) return false;
      return target.matches(RELEVANT_MUTATION_SELECTOR) ||
        Boolean(target.closest(RELEVANT_MUTATION_SELECTOR));
    }
    // TikTok may first mount an empty disclosure wrapper and append its localized
    // label in a later microtask. In that shape the added child itself has no
    // stable selector, so use only the narrowly scoped disclosure ancestor here.
    if (target?.closest(COMMERCIAL_DISCLOSURE_MUTATION_SELECTOR)) return true;
    return [...record.addedNodes, ...record.removedNodes].some(
      (node) =>
        node instanceof Element &&
        (node.matches(RELEVANT_MUTATION_SELECTOR) ||
          Boolean(node.querySelector(RELEVANT_MUTATION_SELECTOR))),
    );
  }

  function isHydrationMutation(record: MutationRecord): boolean {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (
      target?.matches(HYDRATION_MUTATION_SELECTOR) ||
      target?.closest(HYDRATION_MUTATION_SELECTOR)
    ) return true;
    return [...record.addedNodes, ...record.removedNodes].some(
      (node) =>
        node instanceof Element &&
        (node.matches(HYDRATION_MUTATION_SELECTOR) ||
          Boolean(node.querySelector(HYDRATION_MUTATION_SELECTOR))),
    );
  }

  const mutationObserver = new MutationObserver((records) => {
    if (records.some(isHydrationMutation)) hydrationDirty = true;
    for (const record of records) {
      if (
        record.type === "attributes" &&
        (record.attributeName === "src" || record.attributeName === "poster")
      ) {
        const video =
          record.target instanceof HTMLVideoElement
            ? record.target
            : record.target instanceof HTMLSourceElement
              ? record.target.closest("video")
              : null;
        if (video) homeResolver.bumpRevision(video);
      }
    }
    if (records.some(isRelevantMutation)) schedule(220);
  });

  mutationObserver.observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: [...MEANINGFUL_MUTATION_ATTRIBUTES],
  });

  for (const eventName of ["play", "loadedmetadata", "durationchange"] as const) {
    document.addEventListener(
      eventName,
      (event) => {
        if (!(event.target instanceof HTMLVideoElement)) return;
        if (eventName === "loadedmetadata") homeResolver.bumpRevision(event.target);
        signalActiveChange(eventName === "play" ? 60 : 120);
      },
      true,
    );
  }

  // TikTok may keep all profile/search cards mounted while only the viewport
  // changes. In that case there is no useful DOM mutation to wake the grid
  // renderer, so labels for newly visible cards used to appear late. A single
  // throttled listener only re-evaluates the already resolved cards; it does
  // not start a full extraction or scan the whole document while scrolling.
  document.addEventListener(
    "scroll",
    () => {
      if (!isGridMode(surfaceState.mode) || gridViewportTimer !== null) return;
      gridViewportTimer = window.setTimeout(() => {
        gridViewportTimer = null;
        if (!isGridMode(surfaceState.mode)) return;
        window.requestAnimationFrame(() => {
          if (isGridMode(surfaceState.mode)) renderGridLabels(surfaceState);
        });
      }, 72);
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "pointerover",
    (event) => {
      if (!isGridMode(surfaceState.mode) || !(event.target instanceof Element)) return;
      const card = resolveHoveredCard(surfaceState.cards, event.target);
      if (!card || surfaceState.hoveredCard?.videoId === card.videoId) return;
      hoveredTarget = event.target;
      signalActiveChange(50);
    },
    true,
  );

  document.addEventListener(
    "pointerout",
    (event) => {
      const card = surfaceState.hoveredCard;
      if (!card) return;
      if (event.relatedTarget instanceof Node && card.cardRoot.contains(event.relatedTarget)) return;
      hoveredTarget = null;
      signalActiveChange(80);
    },
    true,
  );

  // Route identity changes must refresh once even when continuous auto-update is
  // disabled; otherwise closing a detail view can leave the profile grid stale.
  document.addEventListener(HISTORY_EVENT, () => schedule(50, true));
  window.addEventListener("popstate", () => schedule(50, true));
  document.addEventListener(NETWORK_EVENT, (event) => {
    if (!(event instanceof CustomEvent)) return;
    if (networkConsumer.consume(event.detail, registry) > 0) {
      publishKnownAds();
      const identity = refreshSurfaceIdentity();
      if (!identity.changed && !identity.urlChanged) renderRegistryOverlayIfAvailable();
      schedule(40);
    }
  });
  document.addEventListener(HYDRATION_EVENT, (event) => {
    if (!(event instanceof CustomEvent)) return;
    if (hydrationScanner.consumeBridge(event.detail, registry) > 0) {
      publishKnownAds();
      const identity = refreshSurfaceIdentity();
      if (!identity.changed && !identity.urlChanged) renderRegistryOverlayIfAvailable();
      schedule(40);
    }
  });
  document.dispatchEvent(new CustomEvent(NETWORK_READY_EVENT));

  window.setInterval(() => {
    if (window.location.href !== observedUrl) schedule(40);
  }, 500);

  chrome.runtime.onMessage.addListener(
    (
      request: ContentRequest,
      _sender,
      sendResponse: (
        response: ContentResponse | DiagnosticResponse | ContainerSummaryResponse | MediaDescriptorResponse | CurrentTikTokCaptionResponse | BatchMediaDescriptorsResponse | PageMediaChunkResponse | PageMediaSaveResponse,
      ) => void,
    ) => {
      try {
        if (request?.type === "KNOWN_AD_VIDEO_IDS_SYNC") {
          applyKnownAdVideoIds(request.video_ids);
          return false;
        }
        if (request?.type === "COLLECT_CURRENT_PAGE") {
          sendResponse({
            ok: true,
            data: collect(request.force ?? false),
            generation,
            snapshot_sequence: snapshotSequence,
            session_id: contentSessionId,
          });
          return false;
        }
        if (request?.type === "GET_DIAGNOSTICS" || request?.type === "GET_PAGE_EVIDENCE") {
          // 首页 URL 不随视频变化，复制前必须强制刷新，不能只复用上一条证据。
          collect(true);
          if (!latestDiagnostic) throw new Error("当前页面采集证据尚未生成");
          sendResponse({ ok: true, data: latestDiagnostic });
          return false;
        }
        if (request?.type === "GET_CONTAINER_SUMMARY") {
          collect(true);
          sendResponse({ ok: true, data: createContainerSummary(surfaceState) });
          return false;
        }
        if (request?.type === "GET_CURRENT_MEDIA_DESCRIPTOR") {
          sendResponse({
            ok: true,
            data: createCurrentMediaDescriptor(),
            generation,
            snapshot_sequence: snapshotSequence,
            session_id: contentSessionId,
          });
          return false;
        }
        if (request?.type === "GET_CURRENT_TIKTOK_CAPTION") {
          void createCurrentTikTokCaption(request.video_id)
            .then((data) => sendResponse({ ok: true, data }))
            .catch((error: unknown) => sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : "TikTok 字幕读取失败",
            }));
          return true;
        }
        if (request?.type === "GET_BATCH_MEDIA_DESCRIPTORS") {
          sendResponse({
            ok: true,
            data: createBatchMediaDescriptors(),
            generation,
            snapshot_sequence: snapshotSequence,
            session_id: contentSessionId,
          });
          return false;
        }
        if (request?.type === "FETCH_PAGE_MEDIA_CHUNK") {
          void requestMediaChunkFromPage(request)
            .then(sendResponse)
            .catch((error: unknown) => sendResponse({
              ok: false,
              transfer_id: request.transfer_id,
              error: error instanceof Error ? error.message : "TikTok 页面读取视频失败",
            }));
          return true;
        }
        if (request?.type === "SAVE_PAGE_MEDIA") {
          void requestMediaSaveFromPage(request)
            .then(sendResponse)
            .catch((error: unknown) => sendResponse({
              ok: false,
              request_id: request.request_id,
              error: error instanceof Error ? error.message : "TikTok 页面保存视频失败",
            }));
          return true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知采集错误";
        console.error("[TikTok 达人助手] 页面消息处理失败", error);
        sendResponse({ ok: false, error: message });
      }
      return false;
    },
  );

  const knownAdsRequest: GetKnownAdVideoIdsRequest = { type: "GET_KNOWN_AD_VIDEO_IDS" };
  void chrome.runtime.sendMessage(knownAdsRequest)
    .then((response: KnownAdVideoIdsResponse) => {
      if (response?.ok) applyKnownAdVideoIds(response.video_ids);
    })
    .catch(() => {
      // 本次浏览器会话尚无缓存或 service worker 正在唤醒时不影响页面正常使用。
    });

  function createCurrentMediaDescriptor() {
    refreshSurfaceIdentity();
    const currentUrl = window.location.href;
    const currentVideoId = videoIdForState(surfaceState);
    const cachedSnapshot = session.get(surfaceState.identity, currentUrl);
    const snapshot =
      cachedSnapshot &&
      (currentVideoId === null || cachedSnapshot.video_id === currentVideoId)
        ? cachedSnapshot
        : collect(true);
    if (!snapshot.video_id) throw new Error("当前内容尚未取得可靠帖子 ID");
    if (snapshot.raw_data.content_type === "photo") {
      throw new Error("当前是图文帖子，单视频下载仅支持视频帖子");
    }
    const sources = registry.getMediaSources(snapshot.video_id);
    const activeVideo =
      surfaceState.mode === "home_feed"
        ? surfaceState.home?.video ?? null
        : surfaceState.mode === "video_detail"
          ? surfaceState.detail?.video ?? null
          : surfaceState.hoveredCard?.hoverVideo ?? null;
    const activeVideoUrl = signedHttpUrl(activeVideo?.currentSrc || activeVideo?.src || null);
    const mediaUrl = sources?.play_url ?? activeVideoUrl;
    return {
      video_id: snapshot.video_id,
      page_url: snapshot.page_url,
      media_url: mediaUrl,
      media_source: sources?.play_url
        ? "registry_play_url" as const
        : activeVideoUrl
          ? "active_video_src" as const
          : "yt_dlp_fallback" as const,
      background_music_url: sources?.background_music_url ?? null,
      music_title: sources?.music_title ?? null,
      subtitle_url: sources?.subtitle_url ?? null,
      subtitle_language: sources?.subtitle_language ?? null,
      author_unique_id: snapshot.author.unique_id,
      author_nickname: snapshot.author.nickname,
      description: snapshot.description,
      created_at: snapshot.created_at,
    };
  }

  async function createCurrentTikTokCaption(expectedVideoId: string) {
    refreshSurfaceIdentity();
    const identityAtStart = surfaceState.identity;
    const liveVideoId = videoIdForState(surfaceState);
    if (liveVideoId && liveVideoId !== expectedVideoId) {
      throw new Error("当前视频已经切换，已丢弃旧字幕请求");
    }
    const sources = registry.getMediaSources(expectedVideoId);
    const caption = await resolveTikTokPageCaption(
      document,
      window.location.href,
      expectedVideoId,
      {
        storedTrack: sources?.subtitle_url
          ? {
              url: sources.subtitle_url,
              language: sources.subtitle_language,
            }
          : null,
      },
    );
    refreshSurfaceIdentity();
    const currentVideoId = videoIdForState(surfaceState);
    if (
      surfaceState.identity !== identityAtStart ||
      (currentVideoId && currentVideoId !== expectedVideoId)
    ) {
      throw new Error("当前视频已经切换，已丢弃旧字幕结果");
    }
    return caption;
  }

  function createBatchMediaDescriptors() {
    collect(true);
    if (!isGridMode(surfaceState.mode)) {
      throw new Error("批量下载仅在达人、搜索、Hashtag 或音乐网格页可用");
    }
    const scopedCards = selectGridCardsForBatch(
      surfaceState.cards,
      surfaceState.mode === "profile_grid"
        ? profileToolbar.getBatchItems()
        : undefined,
    );
    if (surfaceState.mode === "profile_grid" && scopedCards.length === 0) {
      throw new Error("当前筛选结果没有已选择的可下载视频");
    }

    const unique = new Map<string, {
      card: VideoCardContext;
      item: ReturnType<VideoItemRegistry["getItem"]>;
    }>();
    for (const card of scopedCards) {
      if (unique.has(card.videoId)) continue;
      const item = registry.getItem(card.videoId);
      if (item?.content_type === "photo") continue;
      unique.set(card.videoId, { card, item });
    }
    const available = [...unique.entries()];
    const batchWindow = limitBatchDownloadItems(available);
    const items = batchWindow.items.map(([videoId, { card, item }]) => {
      const sources = registry.getMediaSources(videoId);
      return {
        video_id: videoId,
        page_url: new URL(card.videoLinkPathname, window.location.origin).href,
        media_url: sources?.play_url ?? null,
        media_source: sources?.play_url ? "registry_play_url" as const : "yt_dlp_fallback" as const,
        background_music_url: sources?.background_music_url ?? null,
        author_unique_id: item?.author.unique_id ?? null,
        author_nickname: item?.author.nickname ?? null,
        description: item?.description ?? null,
        created_at: item?.created_at ?? null,
      };
    });
    if (!items.length) throw new Error("当前网格还没有可下载的视频帖子");
    return {
      items,
      total_available: batchWindow.totalAvailable,
      truncated: batchWindow.truncated,
    };
  }

  Object.defineProperty(scope, DEBUG_KEY, {
    configurable: false,
    enumerable: false,
    get: () => latestDiagnostic ?? undefined,
  });

  function createDiagnostic(
    result: PageCollectionResult,
    state: SurfaceState,
    changed: boolean,
  ): DiagnosticInfo {
    const hydration = hydrationScanner.getStats();
    const network = networkConsumer.getStats();
    const videoId = result.snapshot.video_id;
    return deepFreeze({
      content_session_id: contentSessionId,
      generation,
      snapshot_sequence: snapshotSequence,
      surface_mode: result.surfaceMode,
      page_url: safePageUrl(result.snapshot.page_url),
      page_type: result.snapshot.page_type,
      video_id: videoId,
      active_video: activeVideoDiagnostic(state, changed),
      context: diagnosticContext(result, state),
      registry: {
        stats: registry.getStats(),
        matched_video_id: result.registryRecord?.video_id ?? null,
        matched_item: registryRecordEvidence(result.registryRecord),
      },
      hydration: {
        ...hydration,
        matched_current_video: Boolean(videoId && hydration.matched_video_ids.includes(videoId)),
      },
      network: {
        ...network,
        matched_current_video: Boolean(videoId && network.matched_video_ids.includes(videoId)),
      },
      fields: sanitizeFieldEvidence(result.snapshot.field_evidence),
      rejected_play_count_candidates: result.rejectedPlayCountCandidates.map((candidate) => ({
        source: sanitizeEvidenceText(candidate.source) ?? "已脱敏",
        raw_value: sanitizeEvidenceText(String(candidate.raw_value ?? "")),
        reason: sanitizeEvidenceText(candidate.reason) ?? "不符合播放量来源规则",
      })),
      from_structured_json:
        result.registryRecord?.sources.includes("hydration_json") === true,
      last_updated_at: new Date().toISOString(),
      extension_version: chrome.runtime.getManifest().version,
    } as DiagnosticInfo);
  }

  function createLoadingDiagnostic(state: SurfaceState, changed: boolean): DiagnosticInfo {
    const hydration = hydrationScanner.getStats();
    const network = networkConsumer.getStats();
    const currentVideoId = videoIdForState(state);
    return deepFreeze({
      content_session_id: contentSessionId,
      generation,
      snapshot_sequence: snapshotSequence,
      surface_mode: state.mode,
      page_url: safePageUrl(window.location.href),
      page_type: pageTypeForSurface(state.mode),
      video_id: currentVideoId,
      active_video: activeVideoDiagnostic(state, changed),
      context: diagnosticContext(null, state),
      registry: {
        stats: registry.getStats(),
        matched_video_id: null,
        matched_item: null,
      },
      hydration: {
        ...hydration,
        matched_current_video: Boolean(
          currentVideoId && hydration.matched_video_ids.includes(currentVideoId),
        ),
      },
      network: {
        ...network,
        matched_current_video: Boolean(
          currentVideoId && network.matched_video_ids.includes(currentVideoId),
        ),
      },
      fields: {},
      rejected_play_count_candidates: [],
      from_structured_json: false,
      last_updated_at: new Date().toISOString(),
      extension_version: chrome.runtime.getManifest().version,
    } as DiagnosticInfo);
  }

  function diagnosticContext(
    result: PageCollectionResult | null,
    state: SurfaceState,
  ): NonNullable<DiagnosticInfo["context"]> {
    const context = result?.context;
    return {
      video_id_source: context?.video_id_source ?? videoIdSourceForState(state),
      video_id_conflict:
        result?.snapshot.raw_data.video_id_conflict &&
        typeof result.snapshot.raw_data.video_id_conflict === "object"
          ? (result.snapshot.raw_data.video_id_conflict as Record<string, string>)
          : null,
      active_identity: context?.active_identifier ?? state.identity,
      candidate_count:
        state.home?.candidateCount ?? (isGridMode(state.mode) ? state.cards.length : document.querySelectorAll("video").length),
      card_count: state.cards.length,
      hovered_card_video_id: state.hoveredCard?.videoId ?? null,
      video_link_pathname:
        state.hoveredCard?.videoLinkPathname ?? context?.video_links[0] ?? null,
      roots: {
        active_root: context?.active_root ?? describeStateRoot(state),
        page_root: context?.page_root ?? describeElementSafe(state.detail?.pageRoot ?? null),
        media_root:
          context?.media_root ?? describeElementSafe(state.home?.video ?? state.detail?.mediaRoot ?? null),
        metadata_root:
          context?.metadata_root ?? describeElementSafe(state.detail?.metadataRoot ?? null),
        action_root: context?.action_root ?? describeElementSafe(state.detail?.actionRoot ?? null),
        card_root: isGridMode(state.mode)
          ? context?.active_root ?? describeElementSafe(state.hoveredCard?.cardRoot ?? null)
          : null,
      },
    };
  }

  function activeVideoDiagnostic(state: SurfaceState, changed: boolean): ActiveVideoDiagnostic {
    return {
      visible_ratio: state.home ? Number(state.home.visibleRatio.toFixed(4)) : null,
      candidate_count:
        state.home?.candidateCount ?? (isGridMode(state.mode) ? state.cards.length : document.querySelectorAll("video").length),
      active_root: describeStateRoot(state),
      active_identity: state.identity,
      switch_count: session.switchCount,
      changed,
    };
  }

  function registryRecordEvidence(record: RegistryVideoRecord | null): unknown {
    if (!record) return null;
    const item = materializedRegistryItem(record) as
      | {
          video_id: string;
          author: { unique_id: string | null; nickname: string | null };
          description: string | null;
          created_at: number | null;
          publish_time_text: string | null;
          duration_seconds: number | null;
          metrics: Record<string, number | null>;
          cover_url: string | null;
          media_signature: string | null;
        }
      | null;
    return {
      item: item
        ? {
            video_id: item.video_id,
            author: {
              unique_id: sanitizeEvidenceText(item.author.unique_id),
              nickname: sanitizeEvidenceText(item.author.nickname),
            },
            description: sanitizeEvidenceText(item.description),
            created_at: item.created_at,
            publish_time_text: sanitizeEvidenceText(item.publish_time_text),
            duration_seconds: item.duration_seconds,
            metrics: { ...item.metrics },
            cover_url: sanitizePublicUrl(item.cover_url),
            media_signature: sanitizeEvidenceText(item.media_signature),
          }
        : null,
      sources: [...record.sources],
      confidence: record.confidence,
      revision: record.revision,
      field_sources: Object.fromEntries(
        Object.entries(record.fields).map(([name, item]) => [
          name,
          item
            ? {
                source: item.source,
                confidence: item.confidence,
                raw_value: sanitizeScalar(item.raw_value),
              }
            : null,
        ]),
      ),
    };
  }

  function createContainerSummary(state: SurfaceState): ContainerStructureExport {
    return deepFreeze({
      content_session_id: contentSessionId,
      generation,
      snapshot_sequence: snapshotSequence,
      page_url: safePageUrl(window.location.href),
      page_type: pageTypeForSurface(state.mode),
      surface_mode: state.mode,
      video_id: latestResult?.snapshot.video_id ?? videoIdForState(state),
      roots: containerRootSummaries(state),
      last_updated_at: new Date().toISOString(),
      extension_version: chrome.runtime.getManifest().version,
    });
  }

  function containerRootSummaries(
    state: SurfaceState,
  ): ContainerStructureExport["roots"] {
    const candidates: Record<string, EvidenceRoot | null> = {
      active_root: state.home?.activeRoot ?? state.hoveredCard?.cardRoot ?? state.detail?.pageRoot ?? null,
      media_root: state.home?.video ?? state.detail?.mediaRoot ?? state.hoveredCard?.hoverVideo ?? null,
      metadata_root: state.detail?.metadataRoot ?? null,
      action_root: state.detail?.actionRoot ?? null,
      page_root: state.detail?.pageRoot ?? null,
      card_root: state.hoveredCard?.cardRoot ?? null,
    };
    return Object.fromEntries(
      Object.entries(candidates)
        .filter((entry): entry is [string, EvidenceRoot] => entry[1] !== null)
        .map(([name, root]) => [
          name,
          summarizeContainerStructure(root, { maxDepth: 3, maxNodes: 100 }),
        ]),
    );
  }

  function publishDebug(diagnostic: DiagnosticInfo): void {
    const detail = JSON.stringify(diagnostic);
    if (detail.length <= 500_000) {
      document.dispatchEvent(new CustomEvent(DEBUG_EVENT, { detail }));
    }
  }

  schedule(40);
}

function isGridMode(mode: SurfaceMode): mode is GridSurfaceMode {
  return (
    mode === "profile_grid" ||
    mode === "search_grid" ||
    mode === "hashtag_grid" ||
    mode === "music_grid"
  );
}

function pageTypeForSurface(mode: SurfaceMode): PageType {
  return {
    home_feed: "home_feed",
    video_detail: "video_detail",
    profile_grid: "profile",
    search_grid: "search",
    hashtag_grid: "hashtag",
    music_grid: "music",
    other: "other",
  }[mode] as PageType;
}

function videoIdForState(state: SurfaceState): string | null {
  return state.home?.videoId ?? state.detail?.videoId ?? state.hoveredCard?.videoId ?? null;
}

function videoIdSourceForState(state: SurfaceState): string | null {
  return (
    state.home?.videoIdSource ??
    state.detail?.videoIdSource ??
    (state.hoveredCard ? "video_card_dom:video_link" : null)
  );
}

function describeStateRoot(state: SurfaceState): string | null {
  return describeElementSafe(
    state.home?.activeRoot ?? state.detail?.pageRoot ?? state.hoveredCard?.cardRoot ?? null,
  );
}

function describeElementSafe(element: Element | null): string | null {
  if (!element) return null;
  const tag = element.tagName.toLowerCase();
  const e2e = element.getAttribute("data-e2e");
  const role = element.getAttribute("role");
  return [
    tag,
    e2e ? `[data-e2e="${(sanitizeEvidenceText(e2e) ?? "").slice(0, 80)}"]` : "",
    role ? `[role="${(sanitizeEvidenceText(role) ?? "").slice(0, 40)}"]` : "",
  ]
    .join("")
    .slice(0, 240);
}

function sanitizeFieldEvidence(
  fields: Record<string, FieldEvidence>,
): Record<string, FieldEvidence> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      {
        value: sanitizeScalar(field.value),
        source: sanitizeEvidenceText(field.source) ?? "已脱敏",
        confidence: field.confidence,
        raw_value: sanitizeScalar(field.raw_value),
      },
    ]),
  );
}

function sanitizeScalar(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeEvidenceText(value);
  if (Array.isArray(value)) return value.slice(0, 12).map(sanitizeScalar);
  return "[非标量原始值已省略]";
}

function safePageUrl(value: string): string {
  try {
    const url = new URL(value, "https://www.tiktok.com/");
    return `${url.origin}${sanitizePathname(url.pathname) ?? "/"}`;
  } catch {
    return "https://www.tiktok.com/";
  }
}

function sanitizePublicUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${sanitizePathname(url.pathname) ?? "/"}`;
  } catch {
    return null;
  }
}

function signedHttpUrl(value: string | null): string | null {
  if (!value || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function safePagePath(value: string): string {
  try {
    return sanitizePathname(new URL(value, "https://www.tiktok.com/").pathname) ?? "/";
  } catch {
    return "/";
  }
}

function isNearViewport(root: HTMLElement): boolean {
  const rect = root.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return true;
  const margin = Math.max(480, window.innerHeight * 0.75);
  return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
}

function isVisibleCard(root: HTMLElement): boolean {
  const rect = root.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
}

function homeMediaIdentity(media: HTMLElement): string | null {
  const values = media instanceof HTMLVideoElement
    ? [media.currentSrc, media.src, media.poster]
    : media instanceof HTMLImageElement
      ? [media.currentSrc, media.src]
      : Array.from(media.querySelectorAll<HTMLImageElement>("img"))
          .slice(0, 4)
          .flatMap((image) => [image.currentSrc, image.src]);
  for (const value of values) {
    if (!value) continue;
    try {
      const url = new URL(value, document.baseURI);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      return `${url.hostname.toLowerCase()}${url.pathname}`;
    } catch {
      // 尝试下一个公开媒体地址。
    }
  }
  return null;
}

async function readMediaBytesFromPage(
  mediaUrl: string,
  onProgress: (loadedBytes: number, totalBytes: number) => void = () => undefined,
): Promise<ArrayBuffer> {
  const transferId = crypto.randomUUID().replace(/-/g, "");
  const chunkSize = 8 * 1024 * 1024;
  let offset = 0;
  let output: Uint8Array | null = null;
  while (true) {
    const response = await requestMediaChunkFromPage({
      type: "FETCH_PAGE_MEDIA_CHUNK",
      transfer_id: transferId,
      media_url: mediaUrl,
      offset,
      chunk_size: chunkSize,
    });
    if (!response.ok) throw new Error(response.error);
    if (response.transfer_id !== transferId || response.offset !== offset) {
      throw new Error("视频分块响应与当前下载不匹配，请重试");
    }
    if (
      !Number.isSafeInteger(response.total_bytes) ||
      response.total_bytes <= 0 ||
      response.total_bytes > 512 * 1024 * 1024
    ) {
      throw new Error("当前媒体大小异常，无法在浏览器内保存");
    }
    if (!output) output = new Uint8Array(response.total_bytes);
    if (output.byteLength !== response.total_bytes) throw new Error("媒体大小在读取过程中发生变化");
    const chunk = decodeMediaChunk(response.chunk_base64);
    if (!chunk.byteLength || offset + chunk.byteLength > output.byteLength) {
      throw new Error("媒体分块数据不完整，请重试");
    }
    output.set(chunk, offset);
    offset += chunk.byteLength;
    onProgress(offset, output.byteLength);
    if (response.done) {
      if (offset !== output.byteLength) throw new Error("TikTok 页面返回的媒体不完整");
      return output.buffer as ArrayBuffer;
    }
  }
}

function decodeMediaChunk(value: string): Uint8Array {
  if (!value || value.length > 12_000_000) throw new Error("媒体分块编码无效");
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("媒体分块编码损坏");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function requestMediaChunkFromPage(request: Extract<ContentRequest, { type: "FETCH_PAGE_MEDIA_CHUNK" }>): Promise<PageMediaChunkResponse> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      document.removeEventListener(MEDIA_FETCH_RESPONSE_EVENT, onResponse);
      reject(new Error("TikTok 页面读取视频超时"));
    }, 45_000);
    const onResponse = (event: Event): void => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string" || event.detail.length > 12_000_000) return;
      let response: PageMediaChunkResponse;
      try {
        response = JSON.parse(event.detail) as PageMediaChunkResponse;
      } catch {
        return;
      }
      if (response.transfer_id !== request.transfer_id) return;
      window.clearTimeout(timeout);
      document.removeEventListener(MEDIA_FETCH_RESPONSE_EVENT, onResponse);
      resolve(response);
    };
    document.addEventListener(MEDIA_FETCH_RESPONSE_EVENT, onResponse);
    document.dispatchEvent(new CustomEvent(MEDIA_FETCH_REQUEST_EVENT, {
      detail: JSON.stringify({
        transfer_id: request.transfer_id,
        media_url: request.media_url,
        offset: request.offset,
        chunk_size: request.chunk_size,
      }),
    }));
  });
}

function requestMediaSaveFromPage(request: Extract<ContentRequest, { type: "SAVE_PAGE_MEDIA" }>): Promise<PageMediaSaveResponse> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      document.removeEventListener(MEDIA_SAVE_RESPONSE_EVENT, onResponse);
      reject(new Error("TikTok 页面保存视频超时"));
    }, 180_000);
    const onResponse = (event: Event): void => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string" || event.detail.length > 20_000) return;
      let response: PageMediaSaveResponse;
      try {
        response = JSON.parse(event.detail) as PageMediaSaveResponse;
      } catch {
        return;
      }
      if (response.request_id !== request.request_id) return;
      window.clearTimeout(timeout);
      document.removeEventListener(MEDIA_SAVE_RESPONSE_EVENT, onResponse);
      resolve(response);
    };
    document.addEventListener(MEDIA_SAVE_RESPONSE_EVENT, onResponse);
    document.dispatchEvent(new CustomEvent(MEDIA_SAVE_REQUEST_EVENT, {
      detail: JSON.stringify({
        request_id: request.request_id,
        media_url: request.media_url,
        file_name: request.file_name,
      }),
    }));
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function createSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}
