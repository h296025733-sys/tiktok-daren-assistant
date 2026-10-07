import type { Snapshot } from "../types/snapshot";
import { formatCount, formatDateFull, formatDuration, formatFullNumber } from "../ui/formatter";
import { iconSvg, type IconName } from "../ui/icons";
import {
  DEFAULT_OVERLAY_SETTINGS,
  OverlaySettingsStore,
  type OverlaySettings,
  type SettingsStorage,
} from "../ui/settings";
import { createTokenStyleText } from "../ui/tokens";
import type { CardMediaDownloadMode } from "../types/messages";
import type { RectLike } from "./overlayPosition";

const HOST_SELECTOR = '[data-tiktok-daren-assistant="video-overlay"]';
const NATIVE_QUICK_HOST_SELECTOR = '[data-tiktok-daren-assistant="native-quick-actions"]';
const NATIVE_COMMERCIAL_HOST_SELECTOR = '[data-tiktok-daren-assistant="native-commercial-label"]';
const NATIVE_PLAY_HOST_SELECTOR = '[data-tiktok-daren-assistant="native-play-count"]';
const NATIVE_ACTION_BAR_SELECTORS = [
  '[class*="-SectionActionBarContainer"]',
  '[class*="-DivActionBarContainer"]',
  '[class*="ActionBarContainer"]',
  '[data-e2e="video-actions"]',
  '[data-e2e*="action-bar"]',
].join(",");
const OBSTACLE_SELECTORS = [
  '[data-e2e*="like-icon"]',
  '[data-e2e*="comment-icon"]',
  '[data-e2e*="favorite-icon"]',
  '[data-e2e*="share-icon"]',
  '[data-e2e*="avatar"]',
  '[data-e2e*="video-desc"]',
  '[data-e2e*="browse-username"]',
  '[data-e2e*="video-author"]',
  '[data-e2e*="author-uniqueid"]',
  '[data-e2e*="video-subtitle"]',
  '[data-e2e*="comment-input"]',
  '[class*="-DivSeekBarContainer"]',
  '[class*="-DivVideoControl"]',
].join(",");
const DETAIL_DESCRIPTION_SELECTOR = [
  '[data-e2e="browse-video-desc"]',
  '[data-e2e="video-desc"]',
].join(",");
const DETAIL_METADATA_ANCHOR_SELECTOR = [
  '[data-e2e="video-publish-time"]',
  "time",
  '[data-e2e="browse-username"]',
  '[data-e2e="video-author-uniqueid"]',
].join(",");

type DetailField =
  | "play_count"
  | "like_count"
  | "comment_count"
  | "collect_count"
  | "share_count"
  | "duration_seconds"
  | "interaction_rate";

interface DetailItem {
  field: DetailField;
  label: string;
  icon: IconName;
  evidenceKey: string | null;
}

const DETAIL_ITEMS: readonly DetailItem[] = [
  { field: "play_count", label: "播放", icon: "play", evidenceKey: "metrics.play_count" },
  { field: "like_count", label: "点赞", icon: "heart", evidenceKey: "metrics.like_count" },
  { field: "comment_count", label: "评论", icon: "comment", evidenceKey: "metrics.comment_count" },
  { field: "collect_count", label: "收藏", icon: "bookmark", evidenceKey: "metrics.collect_count" },
  { field: "share_count", label: "分享", icon: "share", evidenceKey: "metrics.share_count" },
  { field: "duration_seconds", label: "时长", icon: "clock", evidenceKey: "duration_seconds" },
  { field: "interaction_rate", label: "互动率", icon: "data", evidenceKey: null },
] as const;

export interface OverlayVideoTarget {
  /** 推荐流与视频详情使用不同的避让策略。 */
  surface?: "feed" | "detail";
  /** 兼容旧调用方；视频目标可只传 video。 */
  video?: HTMLVideoElement | null;
  /** 图文帖子传当前可见图片/轮播媒体节点。 */
  mediaElement?: HTMLElement | null;
  /** 当前视频对应的 TikTok 业务容器，只用于判断原生播放量是否已清晰展示。 */
  nativeRoot?: HTMLElement | null;
  /** 详情页作者、简介和发布时间所在的元数据区域，用于在视频外展示商业标记。 */
  metadataRoot?: HTMLElement | null;
}

export interface OverlayControllerOptions {
  settingsStorage?: SettingsStorage;
  onManualRefresh?: () => void;
  onDownload?: (mode: CardMediaDownloadMode) => void | Promise<void>;
  onOpenSubtitles?: () => void | Promise<void>;
  onSettingsChange?: (settings: OverlaySettings) => void;
}

interface AbsoluteDateDisplay {
  compact: string;
  full: string;
}

type AdaptiveOverlayLayout = "outside-rail" | "inside-toolbar";

/**
 * 首页与详情页的轻量视频浮层。
 *
 * 默认只在 TikTok 没有清楚显示播放量时提供紧凑入口；用户主动点击后才
 * 展示完整指标。发布日期作为独立徽标放在媒体左下区域，不与详情卡混排。
 */
export class OverlayController {
  private readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private readonly settingsStore: OverlaySettingsStore;
  private readonly resizeObserver: ResizeObserver | null;
  private nativeQuickHost: HTMLElement | null = null;
  private nativeQuickShadow: ShadowRoot | null = null;
  private nativeCommercialHost: HTMLElement | null = null;
  private nativePlayHost: HTMLElement | null = null;
  private nativePlayShadow: ShadowRoot | null = null;
  private nativeQuickMounted = false;
  private nativePlayMounted = false;
  private activeContext: OverlayVideoTarget | null = null;
  private settings: OverlaySettings = cloneSettings(DEFAULT_OVERLAY_SETTINGS);
  private latestSnapshot: Snapshot | null = null;
  private latestUpdatedAt: Date | null = null;
  private detailsExpanded = false;
  private detailRowCount = 0;
  private compactVisible = false;
  private dateVisible = false;
  private quickActionsVisible = false;
  private quickActionsReady = false;
  private actionBusy: CardMediaDownloadMode | "subtitles" | null = null;
  private frame: number | null = null;
  private positionFollowUntil = 0;
  private positionFollowStableFrames = 0;
  private lastFollowPositionSignature = "";
  private adaptiveLayout: AdaptiveOverlayLayout = "outside-rail";
  private lastPositionSignature = "";
  private obstacleCache: { video: HTMLElement | null; updatedAt: number; rects: RectLike[] } = {
    video: null,
    updatedAt: 0,
    rects: [],
  };
  readonly ready: Promise<void>;

  constructor(
    private readonly doc: Document = document,
    private readonly win: Window = window,
    private readonly options: OverlayControllerOptions = {},
  ) {
    this.settingsStore = new OverlaySettingsStore(options.settingsStorage);
    const existing = Array.from(this.doc.querySelectorAll<HTMLElement>(HOST_SELECTOR));
    this.host = existing.shift() ?? this.doc.createElement("div");
    for (const duplicate of existing) duplicate.remove();
    this.host.setAttribute("data-tiktok-daren-assistant", "video-overlay");
    this.host.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "width:0",
      "height:0",
      "z-index:2147483400",
      "pointer-events:none",
      "display:none",
    ].join(";");
    if (!this.host.isConnected) (this.doc.body ?? this.doc.documentElement).append(this.host);
    this.shadow = this.host.shadowRoot ?? this.host.attachShadow({ mode: "open" });
    // 重建轻量外壳，同时移除旧版深色长条遗留的监听器和节点。
    this.shadow.replaceChildren();
    this.renderShell();
    this.bindInteractions();

    const ResizeObserverConstructor = (
      this.win as unknown as { ResizeObserver?: typeof ResizeObserver }
    ).ResizeObserver;
    this.resizeObserver = ResizeObserverConstructor
      ? new ResizeObserverConstructor(() => this.requestPosition())
      : null;
    this.win.addEventListener(
      "resize",
      () => {
        this.obstacleCache.updatedAt = 0;
        this.requestPosition();
      },
      { passive: true },
    );
    this.doc.addEventListener("scroll", () => this.followViewportMotion(), {
      passive: true,
      capture: true,
    });
    // TikTok's feed may animate between videos with transforms instead of a
    // native scrolling element. A short, self-stopping rAF burst keeps the
    // detached overlay on the same frame as that animation.
    this.doc.addEventListener("wheel", () => this.followViewportMotion(), { passive: true });
    this.doc.addEventListener("touchmove", () => this.followViewportMotion(), { passive: true });
    this.doc.addEventListener("pointerdown", (event) => this.handleOutsidePointer(event), true);
    this.doc.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.setDetailsExpanded(false);
    });

    this.ready = this.settingsStore
      .load()
      .then((settings) => {
        this.settings = settings;
        this.options.onSettingsChange?.(cloneSettings(settings));
        if (this.latestSnapshot) this.populate(this.latestSnapshot);
        this.requestPosition();
      })
      .catch((error) => {
        console.error("[TikTok 达人助手] 读取浮层设置失败，已使用默认设置", error);
      });
  }

  showLoading(context: OverlayVideoTarget | null): void {
    this.latestSnapshot = null;
    this.latestUpdatedAt = null;
    this.removeCommercialHost();
    this.setContext(context);
    this.ensureSingleHost();
    this.clearDisplayedData();
    this.setDetailsExpanded(false);
    // TikTok 的推荐流会先切换媒体节点，帖子数据稍后才稳定。操作栏先贴到
    // 新视频位置，但在 video_id 尚未确认前保持禁用，既避免整组控件闪烁，
    // 也不会让一次快速点击误操作到上一条视频。
    this.quickActionsVisible = Boolean(context?.video?.isConnected);
    this.syncNativeAttachments();
    this.syncQuickActionVisibility();
    this.host.toggleAttribute("aria-busy", this.quickActionsVisible);
    this.syncQuickActionAvailability();
    this.requestPosition();
    this.updateHostVisibility();
  }

  showError(context: OverlayVideoTarget | null): void {
    this.showLoading(context);
  }

  render(snapshot: Snapshot, context: OverlayVideoTarget | null): void {
    this.removeCommercialHost();
    this.latestSnapshot = snapshot;
    this.setContext(context);
    this.ensureSingleHost();
    if (!context) {
      this.host.style.display = "none";
      return;
    }
    this.latestUpdatedAt = new Date();
    this.populate(snapshot);
    this.quickActionsReady = this.quickActionsVisible;
    this.host.removeAttribute("aria-busy");
    this.syncNativeAttachments();
    this.syncQuickActionVisibility();
    this.syncQuickActionAvailability();
    this.requestPosition();
  }

  countInstances(): number {
    return this.doc.querySelectorAll(HOST_SELECTOR).length;
  }

  getSettings(): OverlaySettings {
    return cloneSettings(this.settings);
  }

  /** 兼容旧调用：现在表示完整指标卡是否展开。 */
  isSettingsPanelOpen(): boolean {
    return this.detailsExpanded;
  }

  /** 新界面中的“收起”即默认紧凑状态。 */
  isCollapsed(): boolean {
    return !this.detailsExpanded;
  }

  isExpanded(): boolean {
    return this.detailsExpanded;
  }

  reposition(): void {
    this.frame = null;
    const context = this.activeContext;
    const media = mediaElementForTarget(context);
    if (!context || !media?.isConnected) {
      this.host.style.display = "none";
      return;
    }
    const videoRect = toRectLike(media.getBoundingClientRect());
    if (videoRect.width <= 0 || videoRect.height <= 0) {
      this.host.style.display = "none";
      return;
    }

    const surface = context.surface ?? "feed";
    const layout = chooseAdaptiveLayout(videoRect, this.win.innerWidth, surface);
    this.adaptiveLayout = layout;
    this.host.dataset.layout = layout;
    this.syncNativeAttachments();
    const positionSignature = [
      this.latestSnapshot?.video_id ?? "",
      surface,
      layout,
      Math.round(videoRect.left * 2) / 2,
      Math.round(videoRect.top * 2) / 2,
      Math.round(videoRect.width * 2) / 2,
      Math.round(videoRect.height * 2) / 2,
      this.win.innerWidth,
      this.win.innerHeight,
      this.compactVisible,
      this.quickActionsVisible,
      this.nativePlayMounted,
      this.nativeQuickMounted,
      this.dateVisible,
      this.detailsExpanded,
      this.detailRowCount,
    ].join("|");
    if (positionSignature === this.lastPositionSignature) {
      this.updateHostVisibility();
      this.continueFollowingPosition(positionSignature);
      return;
    }
    this.lastPositionSignature = positionSignature;

    const dataCard = this.shadow.querySelector<HTMLElement>(".tda-data-card");
    const compactTrigger = this.shadow.querySelector<HTMLElement>(".tda-play-chip");
    const dataCardVisible = this.compactVisible && !this.nativePlayMounted;
    if (dataCard) dataCard.hidden = !dataCardVisible;
    if (compactTrigger) compactTrigger.hidden = !dataCardVisible;
    if (dataCardVisible && dataCard) {
      const playPosition = choosePlayPosition(
        videoRect,
        findNativeAvatarRect(context.nativeRoot ?? inferNativeRoot(media), this.win),
        this.win.innerWidth,
        this.win.innerHeight,
        layout,
      );
      setFloatingPosition(dataCard, playPosition);
    }

    const quickActions = this.shadow.querySelector<HTMLElement>(".tda-quick-actions");
    const floatingQuickActionsVisible = this.quickActionsVisible && !this.nativeQuickMounted;
    if (quickActions) quickActions.hidden = !floatingQuickActionsVisible;
    if (floatingQuickActionsVisible && quickActions) {
      const position = chooseQuickActionPosition(
        videoRect,
        this.win.innerWidth,
        this.win.innerHeight,
        surface,
        layout,
      );
      setFloatingPosition(quickActions, position);
    }

    const dateBadge = this.shadow.querySelector<HTMLElement>(".tda-date-badge");
    if (dateBadge) dateBadge.hidden = !this.dateVisible;
    if (this.dateVisible && dateBadge) {
      const obstacles = this.layoutObstacles(media);
      const position = chooseDatePosition(videoRect, obstacles, this.win.innerWidth, this.win.innerHeight);
      setFloatingPosition(dateBadge, position);
      const details = this.shadow.querySelector<HTMLElement>(".tda-details");
      if (details && this.detailsExpanded) {
        const height = 38 + Math.ceil(this.detailRowCount / 2) * 34;
        details.style.left = `${position.left}px`;
        details.style.top = `${Math.max(8, position.top - height - 8)}px`;
      }
    }
    this.updateHostVisibility();
    this.continueFollowingPosition(positionSignature);
  }

  private populate(snapshot: Snapshot): void {
    const values: Record<Exclude<DetailField, "interaction_rate">, number | null> = {
      play_count: snapshot.metrics.play_count,
      like_count: snapshot.metrics.like_count,
      comment_count: snapshot.metrics.comment_count,
      collect_count: snapshot.metrics.collect_count,
      share_count: snapshot.metrics.share_count,
      duration_seconds: snapshot.duration_seconds,
    };

    this.detailRowCount = 0;
    for (const item of DETAIL_ITEMS) {
      if (item.field === "interaction_rate") continue;
      const rawValue = values[item.field];
      if (!isKnownNumber(rawValue)) {
        this.hideDetailRow(item.field);
        continue;
      }
      const display = item.field === "duration_seconds"
        ? formatDuration(rawValue)
        : formatCount(rawValue, this.settings.unit);
      const full = item.field === "duration_seconds"
        ? formatDuration(rawValue)
        : formatFullNumber(rawValue);
      const source = item.evidenceKey
        ? snapshot.field_evidence[item.evidenceKey]?.source ?? snapshot.extraction.source
        : snapshot.extraction.source;
      this.showDetailRow(item, display, full, source);
    }

    const interactionRate = calculateInteractionRate(snapshot);
    const interactionItem = DETAIL_ITEMS.find((item) => item.field === "interaction_rate")!;
    if (interactionRate === null) {
      this.hideDetailRow("interaction_rate");
    } else {
      const formatted = formatPercentage(interactionRate);
      this.showDetailRow(
        interactionItem,
        formatted,
        formatted,
        "根据当前视频播放与互动指标计算",
      );
    }

    const playCount = snapshot.metrics.play_count;
    // 推荐流本身没有稳定的播放量入口；不同账号的 A/B DOM 即使出现
    // video-views 节点也可能是隐藏或复用节点，因此推荐流只要采集到数值就显示。
    // 详情页仍由日期展开面板承载播放量，避免与评论区重叠。
    this.compactVisible = this.activeContext?.surface !== "detail" &&
      isKnownNumber(playCount);
    this.syncNativeAttachments();
    for (const compactTrigger of this.playChips()) {
      compactTrigger.hidden = !this.compactVisible;
      if (this.compactVisible) {
        const count = formatCount(playCount, this.settings.unit);
        const full = formatFullNumber(playCount);
        const source = snapshot.field_evidence["metrics.play_count"]?.source ?? snapshot.extraction.source;
        const value = compactTrigger.querySelector<HTMLElement>(".tda-compact-value");
        if (value) value.textContent = count;
        compactTrigger.title = `播放：${full}\n数据来源：${source || "--"}`;
      }
    }

    this.quickActionsVisible = Boolean(
      snapshot.video_id && snapshot.raw_data.content_type !== "photo",
    );
    this.syncNativeAttachments();
    this.syncQuickActionVisibility();

    const absoluteDate = resolveAbsoluteDate(snapshot);
    const dateBadge = this.shadow.querySelector<HTMLButtonElement>(".tda-date-badge");
    this.dateVisible = absoluteDate !== null;
    if (dateBadge) {
      dateBadge.hidden = !absoluteDate;
      dateBadge.disabled = this.detailRowCount === 0;
      if (absoluteDate) {
        const value = dateBadge.querySelector<HTMLElement>(".tda-date-value");
        if (value) value.textContent = absoluteDate.compact;
        dateBadge.title = this.detailRowCount > 0
          ? `发布时间：${absoluteDate.full}\n点击查看完整数据`
          : `发布时间：${absoluteDate.full}`;
      }
    }

    if (this.detailRowCount === 0) this.setDetailsExpanded(false);
    this.syncExpandedView();
    this.updateHostVisibility();
  }

  private clearDisplayedData(): void {
    this.detailRowCount = 0;
    this.compactVisible = false;
    this.dateVisible = false;
    this.quickActionsVisible = false;
    this.quickActionsReady = false;
    this.removeCommercialHost();
    this.lastPositionSignature = "";
    this.shadow.querySelector<HTMLElement>(".tda-data-card")?.setAttribute("hidden", "");
    this.syncQuickActionVisibility();
    for (const compactTrigger of this.playChips()) {
      compactTrigger.setAttribute("hidden", "");
    }
    this.shadow.querySelector<HTMLElement>(".tda-date-badge")?.setAttribute("hidden", "");
    for (const compactValue of this.compactValues()) compactValue.textContent = "";
    const dateValue = this.shadow.querySelector<HTMLElement>(".tda-date-value");
    if (dateValue) dateValue.textContent = "";
    for (const item of DETAIL_ITEMS) this.hideDetailRow(item.field);
  }

  private showDetailRow(item: DetailItem, display: string, full: string, source: string): void {
    const row = this.shadow.querySelector<HTMLElement>(`.tda-detail-row[data-field="${item.field}"]`);
    if (!row) return;
    row.hidden = false;
    row.dataset.known = "true";
    row.title = `${item.label}：${full}\n数据来源：${source || "--"}\n更新时间：${formatUpdatedAt(this.latestUpdatedAt)}`;
    const value = row.querySelector<HTMLElement>(".tda-detail-value");
    if (value) value.textContent = display;
    this.detailRowCount += 1;
  }

  private hideDetailRow(field: DetailField): void {
    const row = this.shadow.querySelector<HTMLElement>(`.tda-detail-row[data-field="${field}"]`);
    if (!row) return;
    row.hidden = true;
    row.dataset.known = "false";
    row.removeAttribute("title");
    const value = row.querySelector<HTMLElement>(".tda-detail-value");
    if (value) value.textContent = "";
  }

  private bindInteractions(): void {
    this.shadow.querySelector<HTMLButtonElement>(".tda-details-close")?.addEventListener(
      "click",
      () => this.setDetailsExpanded(false),
    );
    this.shadow.querySelector<HTMLButtonElement>(".tda-date-badge")?.addEventListener(
      "click",
      () => {
        if (this.detailRowCount > 0) this.setDetailsExpanded(!this.detailsExpanded);
      },
    );
    this.bindQuickActionButtons(this.shadow);
  }

  private bindQuickActionButtons(root: ParentNode): void {
    for (const button of root.querySelectorAll<HTMLButtonElement>(".tda-quick-action")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const action = button.dataset.action;
        if (action === "video" || action === "audio_track" || action === "subtitles") {
          void this.runQuickAction(action, button);
        }
      });
    }
  }

  private async runQuickAction(
    action: CardMediaDownloadMode | "subtitles",
    button: HTMLButtonElement,
  ): Promise<void> {
    if (this.actionBusy) return;
    this.actionBusy = action;
    const buttons = this.quickActionButtons();
    for (const item of buttons) item.disabled = true;
    button.dataset.state = "loading";
    const originalTitle = button.title;
    button.title = action === "subtitles" ? "正在打开字幕工作区" : "正在准备下载";
    try {
      if (action === "subtitles") await this.options.onOpenSubtitles?.();
      else await this.options.onDownload?.(action);
      button.dataset.state = "success";
      button.title = action === "subtitles" ? "字幕工作区已打开" : "已打开保存位置选择";
    } catch (error) {
      button.dataset.state = "error";
      button.title = error instanceof Error ? error.message : "操作失败，请重试";
      console.error("[TikTok 达人助手] 主页快捷操作失败", error);
    } finally {
      this.win.setTimeout(() => {
        delete button.dataset.state;
        button.title = originalTitle;
        for (const item of buttons) item.disabled = !this.quickActionsReady;
      }, 1_600);
      this.actionBusy = null;
    }
  }

  private syncQuickActionAvailability(): void {
    const disabled = !this.quickActionsReady || this.actionBusy !== null;
    for (const button of this.quickActionButtons()) {
      button.disabled = disabled;
    }
  }

  private handleOutsidePointer(event: Event): void {
    if (!this.detailsExpanded) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(this.host)) return;
    this.setDetailsExpanded(false);
  }

  private setDetailsExpanded(expanded: boolean): void {
    this.detailsExpanded = expanded && this.detailRowCount > 0;
    this.syncExpandedView();
    this.updateHostVisibility();
    this.requestPosition();
  }

  private syncExpandedView(): void {
    const details = this.shadow.querySelector<HTMLElement>(".tda-details");
    if (details) details.hidden = !this.detailsExpanded;
    const dataCard = this.shadow.querySelector<HTMLElement>(".tda-data-card");
    dataCard?.classList.toggle("is-expanded", this.detailsExpanded);
    this.shadow
      .querySelector<HTMLButtonElement>(".tda-date-badge")
      ?.setAttribute("aria-expanded", String(this.detailsExpanded));
  }

  private setContext(context: OverlayVideoTarget | null): void {
    const previousMedia = mediaElementForTarget(this.activeContext);
    const nextMedia = mediaElementForTarget(context);
    const changedVideo = previousMedia !== nextMedia;
    if (changedVideo) {
      if (previousMedia) this.resizeObserver?.unobserve(previousMedia);
      if (nextMedia) this.resizeObserver?.observe(nextMedia);
      this.detailsExpanded = false;
      this.lastPositionSignature = "";
      this.obstacleCache = { video: nextMedia, updatedAt: 0, rects: [] };
    }
    this.activeContext = context;
    if (context?.surface) this.host.dataset.surface = context.surface;
    else delete this.host.dataset.surface;
    this.syncNativeAttachments();
    if (changedVideo) this.syncExpandedView();
  }

  private syncNativeAttachments(): void {
    const context = this.activeContext;
    const root = context?.nativeRoot ?? inferNativeRoot(mediaElementForTarget(context));
    const actionBar =
      context?.surface === "feed" && root
        ? findNativeActionBar(root)
        : null;

    if (!actionBar) {
      this.nativeQuickHost?.remove();
      this.nativePlayHost?.remove();
      this.nativeQuickMounted = false;
      this.nativePlayMounted = false;
      this.syncDetailCommercialAttachment(context);
      return;
    }

    const quickHost = this.ensureNativeQuickHost();
    if (quickHost.parentElement !== actionBar) actionBar.prepend(quickHost);
    this.nativeQuickMounted = quickHost.isConnected && quickHost.parentElement === actionBar;

    const commercialHost = this.syncFeedCommercialAttachment(actionBar, quickHost);

    const playHost = this.ensureNativePlayHost();
    const playPredecessor = commercialHost ?? quickHost;
    if (playHost.parentElement !== actionBar || playPredecessor.nextElementSibling !== playHost) {
      playPredecessor.insertAdjacentElement("afterend", playHost);
    }
    this.nativePlayMounted = playHost.isConnected && playHost.parentElement === actionBar;

    this.syncQuickActionVisibility();
    playHost.hidden = !this.compactVisible;
  }

  private syncFeedCommercialAttachment(
    actionBar: HTMLElement,
    quickHost: HTMLElement,
  ): HTMLElement | null {
    if (this.latestSnapshot?.raw_data.is_ad !== true) {
      this.removeCommercialHost();
      return null;
    }
    const host = this.ensureCommercialHost();
    host.dataset.placement = "feed";
    if (host.parentElement !== actionBar || quickHost.nextElementSibling !== host) {
      quickHost.insertAdjacentElement("afterend", host);
    }
    return host;
  }

  private syncDetailCommercialAttachment(context: OverlayVideoTarget | null): void {
    if (
      context?.surface !== "detail" ||
      this.latestSnapshot?.raw_data.is_ad !== true ||
      !context.metadataRoot?.isConnected
    ) {
      this.removeCommercialHost();
      return;
    }
    const anchor = findDetailDescription(context.metadataRoot) ??
      findDetailMetadataAnchor(context.metadataRoot);
    if (!anchor) {
      this.removeCommercialHost();
      return;
    }
    const media = mediaElementForTarget(context);
    if (media && (anchor === media || media.contains(anchor))) {
      this.removeCommercialHost();
      return;
    }
    const host = this.ensureCommercialHost();
    host.dataset.placement = "detail";
    if (anchor.nextElementSibling !== host) {
      anchor.insertAdjacentElement("afterend", host);
    }
  }

  private ensureNativeQuickHost(): HTMLElement {
    if (this.nativeQuickHost) return this.nativeQuickHost;
    for (const duplicate of this.doc.querySelectorAll<HTMLElement>(NATIVE_QUICK_HOST_SELECTOR)) {
      duplicate.remove();
    }
    const host = this.doc.createElement("div");
    host.setAttribute("data-tiktok-daren-assistant", "native-quick-actions");
    host.style.cssText = [
      "display:block",
      "align-self:center",
      "flex:0 0 auto",
      "position:relative",
      "z-index:2",
      "margin:0 0 9px",
    ].join(";");
    const shadow = host.attachShadow({ mode: "open" });
    const style = this.doc.createElement("style");
    style.textContent = `${createTokenStyleText()}
      :host { font-family: "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; }
      *, *::before, *::after { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .tda-quick-actions { display: grid; gap: 9px; pointer-events: auto; contain: layout style paint; }
      .tda-quick-action { position: relative; display: grid; width: 44px; height: 44px; place-items: center; padding: 0; cursor: pointer; border: 1px solid rgba(255,255,255,.58); border-radius: 50%; color: #fff; background: rgba(37,99,235,.94); box-shadow: 0 2px 7px rgba(15,23,42,.15), inset 0 1px 0 rgba(255,255,255,.16); backdrop-filter: blur(8px) saturate(120%); transition: transform var(--tda-motion-fast) var(--tda-motion-easing), background var(--tda-motion-fast) var(--tda-motion-easing), box-shadow var(--tda-motion-fast) var(--tda-motion-easing), opacity var(--tda-motion-fast) var(--tda-motion-easing); }
      .tda-quick-action:hover { transform: translateY(-1px) scale(1.025); background: #2563eb; box-shadow: 0 3px 9px rgba(15,23,42,.18), inset 0 1px 0 rgba(255,255,255,.18); }
      .tda-quick-action:focus-visible { outline: 3px solid rgba(255,255,255,.9); outline-offset: 2px; }
      .tda-quick-action:active { transform: scale(.96); }
      .tda-quick-action:disabled { cursor: wait; opacity: .52; transform: none; }
      .tda-quick-action[data-state="success"] { background: #168a4b; }
      .tda-quick-action[data-state="error"] { background: #d73545; }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
    `;
    const nav = this.doc.createElement("nav");
    nav.className = "tda-quick-actions";
    nav.setAttribute("aria-label", "当前视频快捷操作");
    nav.innerHTML = quickActionMarkup();
    shadow.append(style, nav);
    this.bindQuickActionButtons(shadow);
    this.nativeQuickHost = host;
    this.nativeQuickShadow = shadow;
    this.syncQuickActionAvailability();
    return host;
  }

  private ensureCommercialHost(): HTMLElement {
    if (this.nativeCommercialHost) return this.nativeCommercialHost;
    for (const duplicate of this.doc.querySelectorAll<HTMLElement>(NATIVE_COMMERCIAL_HOST_SELECTOR)) {
      duplicate.remove();
    }
    const host = this.doc.createElement("div");
    host.setAttribute("data-tiktok-daren-assistant", "native-commercial-label");
    host.style.cssText = [
      "position:relative",
      "z-index:2",
      "pointer-events:none",
    ].join(";");
    const shadow = host.attachShadow({ mode: "open" });
    const style = this.doc.createElement("style");
    style.textContent = `
      :host { font-family: "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; }
      :host([data-placement="feed"]) { display: block; width: 52px; align-self: center; flex: 0 0 auto; margin: 0 0 9px; }
      :host([data-placement="detail"]) { display: block; width: max-content; margin: 6px 0 0; }
      *, *::before, *::after { box-sizing: border-box; }
      .tda-commercial-label {
        display: inline-flex; min-height: 20px; align-items: center; justify-content: center;
        box-sizing: border-box; padding: 2px 7px; border: 1px solid rgba(244,63,94,.38);
        border-radius: 999px; color: #b42318; background: rgba(255,241,243,.96);
        font-size: 11px; font-weight: 700; line-height: 15px; white-space: nowrap;
      }
      :host([data-placement="feed"]) .tda-commercial-label { width: 52px; padding-inline: 1px; font-size: 10px; }
    `;
    const badge = this.doc.createElement("span");
    badge.className = "tda-commercial-label";
    badge.setAttribute("role", "status");
    badge.setAttribute("aria-label", "当前视频为广告或推广内容");
    badge.textContent = "广告/推广";
    shadow.append(style, badge);
    this.nativeCommercialHost = host;
    return host;
  }

  private removeCommercialHost(): void {
    this.nativeCommercialHost?.remove();
  }

  private ensureNativePlayHost(): HTMLElement {
    if (this.nativePlayHost) return this.nativePlayHost;
    for (const duplicate of this.doc.querySelectorAll<HTMLElement>(NATIVE_PLAY_HOST_SELECTOR)) {
      duplicate.remove();
    }
    const host = this.doc.createElement("div");
    host.setAttribute("data-tiktok-daren-assistant", "native-play-count");
    host.style.cssText = [
      "display:block",
      "align-self:center",
      "flex:0 0 auto",
      "position:relative",
      "z-index:2",
      "margin:0 0 9px",
      "pointer-events:none",
    ].join(";");
    const shadow = host.attachShadow({ mode: "open" });
    const style = this.doc.createElement("style");
    style.textContent = `
      :host { font-family: "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; }
      *, *::before, *::after { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .tda-play-chip { display: flex; width: 52px; align-items: center; flex-direction: column; gap: 4px; }
      .tda-compact-icon { display: grid; width: 44px; height: 44px; place-items: center; border: 1px solid rgba(255,255,255,.48); border-radius: 50%; color: #fff; background: rgba(18,20,27,.72); box-shadow: inset 0 0 0 1px rgba(255,255,255,.08), 0 3px 8px rgba(0,0,0,.2); backdrop-filter: blur(12px) saturate(125%); }
      .tda-compact-icon svg { width: 18px; height: 18px; }
      .tda-compact-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
      .tda-compact-value { max-width: 72px; color: rgba(22,24,35,.72); font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; text-align: center; white-space: nowrap; }
    `;
    const chip = this.doc.createElement("div");
    chip.className = "tda-play-chip";
    chip.hidden = true;
    chip.setAttribute("role", "status");
    chip.setAttribute("aria-label", "当前视频播放量");
    chip.innerHTML = `
      <span class="tda-compact-icon">${iconSvg("play", { size: 18 })}</span>
      <span class="tda-compact-label">播放</span>
      <strong class="tda-compact-value"></strong>
    `;
    shadow.append(style, chip);
    this.nativePlayHost = host;
    this.nativePlayShadow = shadow;
    return host;
  }

  private syncQuickActionVisibility(): void {
    const floating = this.shadow.querySelector<HTMLElement>(".tda-quick-actions");
    if (floating) floating.hidden = !this.quickActionsVisible || this.nativeQuickMounted;
    const native = this.nativeQuickShadow?.querySelector<HTMLElement>(".tda-quick-actions");
    if (native) native.hidden = !this.quickActionsVisible;
    if (this.nativeQuickHost) this.nativeQuickHost.hidden = !this.quickActionsVisible;
  }

  private quickActionButtons(): HTMLButtonElement[] {
    return [
      ...this.shadow.querySelectorAll<HTMLButtonElement>(".tda-quick-action"),
      ...(this.nativeQuickShadow?.querySelectorAll<HTMLButtonElement>(".tda-quick-action") ?? []),
    ];
  }

  private playChips(): HTMLElement[] {
    return [
      ...this.shadow.querySelectorAll<HTMLElement>(".tda-play-chip"),
      ...(this.nativePlayShadow?.querySelectorAll<HTMLElement>(".tda-play-chip") ?? []),
    ];
  }

  private compactValues(): HTMLElement[] {
    return [
      ...this.shadow.querySelectorAll<HTMLElement>(".tda-compact-value"),
      ...(this.nativePlayShadow?.querySelectorAll<HTMLElement>(".tda-compact-value") ?? []),
    ];
  }

  private layoutObstacles(video: HTMLElement): RectLike[] {
    const now = Date.now();
    if (this.obstacleCache.video === video && now - this.obstacleCache.updatedAt < 180) {
      return this.obstacleCache.rects;
    }
    const rects = collectLayoutObstacles(this.doc, this.win, video);
    this.obstacleCache = { video, updatedAt: now, rects };
    return rects;
  }

  private requestPosition(): void {
    if (this.frame !== null) return;
    this.frame = this.win.requestAnimationFrame(() => this.reposition());
  }

  private followViewportMotion(): void {
    if (this.activeContext?.surface !== "feed") {
      this.requestPosition();
      return;
    }
    const now = this.win.performance?.now?.() ?? Date.now();
    this.positionFollowUntil = Math.max(this.positionFollowUntil, now + 500);
    this.positionFollowStableFrames = 0;
    this.requestPosition();
  }

  private continueFollowingPosition(positionSignature: string): void {
    const now = this.win.performance?.now?.() ?? Date.now();
    if (now >= this.positionFollowUntil) {
      this.positionFollowStableFrames = 0;
      this.lastFollowPositionSignature = positionSignature;
      return;
    }
    if (positionSignature === this.lastFollowPositionSignature) {
      this.positionFollowStableFrames += 1;
    } else {
      this.positionFollowStableFrames = 0;
      this.lastFollowPositionSignature = positionSignature;
    }
    // Stop after several stable frames, but restart immediately on the next
    // wheel/scroll/touch event. This follows scroll-snap without an idle loop.
    if (this.positionFollowStableFrames < 8) this.requestPosition();
  }

  private ensureSingleHost(): void {
    const instances = Array.from(this.doc.querySelectorAll<HTMLElement>(HOST_SELECTOR));
    for (const instance of instances) {
      if (instance !== this.host) instance.remove();
    }
    for (const instance of this.doc.querySelectorAll<HTMLElement>(NATIVE_QUICK_HOST_SELECTOR)) {
      if (instance !== this.nativeQuickHost) instance.remove();
    }
    for (const instance of this.doc.querySelectorAll<HTMLElement>(NATIVE_COMMERCIAL_HOST_SELECTOR)) {
      if (instance !== this.nativeCommercialHost) instance.remove();
    }
    for (const instance of this.doc.querySelectorAll<HTMLElement>(NATIVE_PLAY_HOST_SELECTOR)) {
      if (instance !== this.nativePlayHost) instance.remove();
    }
    if (!this.host.isConnected) (this.doc.body ?? this.doc.documentElement).append(this.host);
  }

  private updateHostVisibility(): void {
    const show = Boolean(
      this.activeContext &&
      (this.dateVisible ||
        (this.compactVisible && !this.nativePlayMounted) ||
        (this.quickActionsVisible && !this.nativeQuickMounted) ||
        (this.detailsExpanded && this.detailRowCount > 0)),
    );
    this.host.style.display = show ? "block" : "none";
  }

  private renderShell(): void {
    const style = this.doc.createElement("style");
    style.textContent = `${createTokenStyleText()}
      :host { color-scheme: dark; font-family: "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; }
      *, *::before, *::after { box-sizing: border-box; }
      button { font: inherit; color: inherit; }
      [hidden] { display: none !important; }
      .tda-panel { pointer-events: none; }
      .tda-data-card { position: fixed; top: 0; left: 0; width: 52px; color: var(--tda-color-text-inverse); pointer-events: none; contain: layout style paint; will-change: transform; transition: opacity var(--tda-motion-fast) var(--tda-motion-easing); }
      .tda-play-chip { display: flex; width: 52px; align-items: center; flex-direction: column; gap: 4px; color: #fff; filter: drop-shadow(0 3px 8px rgba(0,0,0,.26)); }
      .tda-compact-icon { display: grid; width: 44px; height: 44px; place-items: center; border: 1px solid rgba(255,255,255,.48); border-radius: 50%; color: #fff; background: rgba(18,20,27,.72); box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); backdrop-filter: blur(12px) saturate(125%); }
      .tda-compact-icon svg { width: 18px; height: 18px; }
      .tda-compact-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
      .tda-compact-value { max-width: 72px; color: #fff; font-size: 11px; font-weight: var(--tda-font-weight-bold); font-variant-numeric: tabular-nums; line-height: 1; text-align: center; white-space: nowrap; text-shadow: 0 1px 3px rgba(0,0,0,.72); }
      .tda-quick-actions { position: fixed; top: 0; left: 0; display: grid; gap: 9px; pointer-events: auto; contain: layout style paint; will-change: transform; transition: opacity var(--tda-motion-fast) var(--tda-motion-easing); }
      .tda-quick-action { position: relative; display: grid; width: 44px; height: 44px; place-items: center; padding: 0; cursor: pointer; border: 1px solid rgba(255,255,255,.58); border-radius: 50%; color: #fff; background: rgba(37,99,235,.94); box-shadow: 0 2px 7px rgba(15,23,42,.15), inset 0 1px 0 rgba(255,255,255,.16); backdrop-filter: blur(8px) saturate(120%); transition: transform var(--tda-motion-fast) var(--tda-motion-easing), background var(--tda-motion-fast) var(--tda-motion-easing), box-shadow var(--tda-motion-fast) var(--tda-motion-easing), opacity var(--tda-motion-fast) var(--tda-motion-easing); }
      .tda-quick-action:hover { transform: translateY(-1px) scale(1.025); background: #2563eb; box-shadow: 0 3px 9px rgba(15,23,42,.18), inset 0 1px 0 rgba(255,255,255,.18); }
      .tda-quick-action:focus-visible { outline: 3px solid rgba(255,255,255,.9); outline-offset: 2px; }
      .tda-quick-action:active { transform: scale(.96); }
      .tda-quick-action:disabled { cursor: wait; opacity: .52; transform: none; }
      .tda-quick-action[data-state="success"] { color: #fff; background: #168a4b; }
      .tda-quick-action[data-state="error"] { color: #fff; background: #d73545; }
      :host([data-surface="detail"]) .tda-quick-actions { gap: 6px; }
      :host([data-surface="detail"]) .tda-quick-action { width: 36px; height: 36px; }
      :host([data-layout="inside-toolbar"]) .tda-quick-actions { display: flex; gap: 5px; padding: 4px; border: 1px solid rgba(255,255,255,.18); border-radius: 999px; background: rgba(15,23,42,.48); box-shadow: 0 8px 22px rgba(0,0,0,.2); backdrop-filter: blur(12px) saturate(125%); }
      :host([data-layout="inside-toolbar"]) .tda-quick-action,
      :host([data-layout="inside-toolbar"][data-surface="detail"]) .tda-quick-action { width: 36px; height: 36px; border-color: rgba(255,255,255,.38); box-shadow: 0 3px 10px rgba(15,23,42,.18); }
      .tda-details { position: fixed; width: 148px; overflow: hidden; border: 1px solid rgba(255,255,255,.16); border-radius: 14px; color: var(--tda-color-text-inverse); background: rgba(18,20,27,.74); box-shadow: 0 12px 30px rgba(0,0,0,.24); backdrop-filter: blur(16px) saturate(125%); pointer-events: auto; transform-origin: left bottom; animation: tda-pop-up var(--tda-motion-normal) var(--tda-motion-easing); }
      .tda-details-head { display: flex; height: 32px; align-items: center; justify-content: space-between; padding: 0 4px 0 10px; border-bottom: 1px solid rgba(255,255,255,.09); }
      .tda-details-title { color: rgba(255,255,255,.72); font-size: 10px; font-weight: var(--tda-font-weight-semibold); letter-spacing: .04em; white-space: nowrap; }
      .tda-details-close { display: grid; width: 24px; height: 24px; place-items: center; padding: 0; cursor: pointer; border: 0; border-radius: 8px; color: var(--tda-color-text-inverse-muted); background: transparent; }
      .tda-details-close:hover, .tda-details-close:focus-visible { color: #fff; background: rgba(255,255,255,.1); outline: none; }
      .tda-detail-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 2px; padding: 5px 6px 7px; }
      .tda-detail-row { display: grid; grid-template-columns: 17px minmax(0,1fr); min-height: 32px; align-items: center; padding: 0 5px; border-radius: 8px; }
      .tda-detail-row:hover { background: rgba(255,255,255,.07); }
      .tda-detail-icon { display: grid; place-items: center; color: #ff6683; }
      .tda-detail-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      .tda-detail-value { overflow: hidden; color: #fff; font-size: 11px; font-weight: var(--tda-font-weight-bold); font-variant-numeric: tabular-nums; line-height: 1; text-align: right; white-space: nowrap; }
      .tda-date-badge { position: fixed; top: 0; left: 0; display: inline-flex; min-width: 104px; height: 28px; align-items: center; justify-content: center; gap: 6px; padding: 0 10px; cursor: pointer; border: 1px solid rgba(255,255,255,.46); border-radius: var(--tda-radius-pill); color: #2563eb; background: rgba(248,250,252,.76); box-shadow: 0 4px 14px rgba(15,23,42,.12); backdrop-filter: blur(12px) saturate(130%); pointer-events: auto; contain: layout style paint; will-change: transform; transition: background var(--tda-motion-fast) var(--tda-motion-easing); }
      .tda-date-badge:disabled { cursor: default; }
      .tda-date-badge:not(:disabled):hover, .tda-date-badge:not(:disabled):focus-visible { background: rgba(255,255,255,.92); outline: 2px solid rgba(37,99,235,.3); outline-offset: 1px; }
      .tda-date-icon { display: grid; flex: 0 0 13px; place-items: center; color: #3b82f6; }
      .tda-date-value { font-size: 11px; font-weight: var(--tda-font-weight-semibold); font-variant-numeric: tabular-nums; line-height: 1; white-space: nowrap; }
      @keyframes tda-pop-up { from { opacity: 0; transform: translateY(6px) scale(.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
    `;

    const panel = this.doc.createElement("section");
    panel.className = "tda-panel";
    panel.setAttribute("aria-label", "当前视频数据");
    panel.innerHTML = `
      <div class="tda-data-card" hidden>
        <div class="tda-play-chip" hidden role="status" aria-label="当前视频播放量">
          <span class="tda-compact-icon">${iconSvg("play", { size: 18 })}</span>
          <span class="tda-compact-label">播放</span>
          <strong class="tda-compact-value"></strong>
        </div>
      </div>
      <nav class="tda-quick-actions" aria-label="当前视频快捷操作" hidden>
        ${quickActionMarkup()}
      </nav>
      <section class="tda-details" id="tda-video-details" hidden aria-label="完整视频指标">
        <header class="tda-details-head">
          <span class="tda-details-title">视频数据</span>
          <button class="tda-details-close" type="button" title="收起完整数据" aria-label="收起完整数据">${iconSvg("close", { size: 15 })}</button>
        </header>
        <div class="tda-detail-grid" aria-live="polite">
          ${DETAIL_ITEMS.map(detailRowMarkup).join("")}
        </div>
      </section>
      <button class="tda-date-badge" type="button" hidden aria-expanded="false">
        <span class="tda-date-icon">${iconSvg("calendar", { size: 13 })}</span>
        <span class="tda-date-value"></span>
      </button>
    `;
    this.shadow.append(style, panel);
  }
}

function quickActionMarkup(): string {
  return `
    <button class="tda-quick-action" type="button" data-action="video" title="下载无水印视频" aria-label="下载无水印视频">${iconSvg("video", { size: 19 })}</button>
    <button class="tda-quick-action" type="button" data-action="audio_track" title="提取视频音频" aria-label="提取视频音频">${iconSvg("music", { size: 19 })}</button>
    <button class="tda-quick-action" type="button" data-action="subtitles" title="生成字幕和翻译" aria-label="生成字幕和翻译">${iconSvg("subtitle", { size: 19 })}</button>
  `;
}

function detailRowMarkup(item: DetailItem): string {
  return `<div class="tda-detail-row" data-field="${item.field}" data-known="false" hidden>
    <span class="tda-detail-icon">${iconSvg(item.icon, { size: 13 })}</span>
    <span class="tda-detail-label">${item.label}</span>
    <strong class="tda-detail-value"></strong>
  </div>`;
}

function calculateInteractionRate(snapshot: Snapshot): number | null {
  const { play_count, like_count, comment_count, collect_count, share_count } = snapshot.metrics;
  const interactions = [like_count, comment_count, collect_count, share_count];
  if (!isKnownNumber(play_count) || play_count <= 0 || !interactions.every(isKnownNumber)) return null;
  return ((like_count! + comment_count! + collect_count! + share_count!) / play_count) * 100;
}

function formatPercentage(value: number): string {
  return `${new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

function resolveAbsoluteDate(snapshot: Snapshot): AbsoluteDateDisplay | null {
  if (isKnownNumber(snapshot.created_at) && snapshot.created_at > 0) {
    const full = formatDateFull(snapshot.created_at);
    if (full !== "--") {
      return { compact: full.slice(0, 10).replace(/-/g, "/"), full };
    }
  }
  const raw = snapshot.publish_time_text?.trim() ?? "";
  const match = raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:\s+(.+))?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const compact = `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
  return { compact, full: raw };
}

function isKnownNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function setFloatingPosition(
  element: HTMLElement,
  position: { left: number; top: number },
): void {
  element.style.transform = `translate3d(${position.left}px, ${position.top}px, 0)`;
}

function chooseAdaptiveLayout(
  videoRect: RectLike,
  viewportWidth: number,
  surface: "feed" | "detail",
): AdaptiveOverlayLayout {
  const aspectRatio = videoRect.width / Math.max(1, videoRect.height);
  const spaceOnRight = viewportWidth - videoRect.right;
  // Wide media and detail modals frequently place TikTok's own actions in the
  // right rail. Keep our three controls together inside the media instead of
  // letting independently positioned circles collide with the native rail.
  if (surface === "detail" || aspectRatio >= 1.12 || spaceOnRight < 70) {
    return "inside-toolbar";
  }
  return "outside-rail";
}

function chooseDatePosition(
  videoRect: RectLike,
  obstacles: readonly RectLike[],
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const width = 116;
  const height = 28;
  const left = clamp(videoRect.left + 12, 8, Math.max(8, viewportWidth - width - 8));
  const minimumTop = Math.max(8, videoRect.top + 12);
  const maximumTop = Math.min(videoRect.bottom - height - 12, viewportHeight - height - 8);
  const initialTop = clamp(videoRect.bottom - height - 140, minimumTop, maximumTop);
  for (let step = 0; step < 6; step += 1) {
    const top = Math.max(minimumTop, initialTop - step * 34);
    const candidate: RectLike = {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
    };
    if (!obstacles.some((obstacle) => overlapArea(candidate, obstacle) > 0)) {
      return { left: Math.round(left), top: Math.round(top) };
    }
  }
  return { left: Math.round(left), top: Math.round(minimumTop) };
}

function choosePlayPosition(
  videoRect: RectLike,
  avatarRect: RectLike | null,
  viewportWidth: number,
  viewportHeight: number,
  layout: AdaptiveOverlayLayout = "outside-rail",
): { left: number; top: number } {
  const width = 52;
  const height = 64;
  if (layout === "inside-toolbar") {
    const toolbarWidth = 132;
    const placeBesideToolbar = videoRect.width >= 230;
    const preferredLeft = placeBesideToolbar
      ? videoRect.right - 14 - toolbarWidth - 8 - width
      : videoRect.right - width - 14;
    const preferredTop = videoRect.top + (placeBesideToolbar ? 14 : 66);
    return {
      left: Math.round(clamp(
        preferredLeft,
        Math.max(8, videoRect.left + 8),
        Math.max(8, Math.min(videoRect.right - width - 8, viewportWidth - width - 8)),
      )),
      top: Math.round(clamp(preferredTop, 8, Math.max(8, viewportHeight - height - 8))),
    };
  }
  const preferredLeft = avatarRect
    ? avatarRect.left + (avatarRect.width - width) / 2
    : videoRect.right + 14;
  const preferredTop = avatarRect
    ? avatarRect.top - height - 10
    : videoRect.top + Math.min(330, Math.max(160, videoRect.height * .42));
  return {
    left: Math.round(clamp(preferredLeft, 8, Math.max(8, viewportWidth - width - 8))),
    top: Math.round(clamp(preferredTop, 8, Math.max(8, viewportHeight - height - 8))),
  };
}

function chooseQuickActionPosition(
  videoRect: RectLike,
  viewportWidth: number,
  viewportHeight: number,
  surface: "feed" | "detail" = "feed",
  layout: AdaptiveOverlayLayout = "outside-rail",
): { left: number; top: number } {
  if (layout === "inside-toolbar") {
    const width = 132;
    const height = 44;
    return {
      left: Math.round(clamp(videoRect.right - width - 14, 8, Math.max(8, viewportWidth - width - 8))),
      top: Math.round(clamp(videoRect.top + 14, 8, Math.max(8, viewportHeight - height - 8))),
    };
  }
  const width = surface === "detail" ? 36 : 44;
  const height = surface === "detail" ? 120 : 150;
  if (surface === "detail") {
    return {
      left: Math.round(Math.max(8, viewportWidth - width - 10)),
      top: Math.round(clamp((viewportHeight - height) / 2, 64, Math.max(64, viewportHeight - height - 54))),
    };
  }
  return {
    left: Math.round(clamp(videoRect.right + 14, 8, Math.max(8, viewportWidth - width - 8))),
    top: Math.round(clamp(videoRect.top + 70, 8, Math.max(8, viewportHeight - height - 8))),
  };
}

function findNativeAvatarRect(root: HTMLElement | null, win: Window): RectLike | null {
  if (!root) return null;
  const candidates = root.querySelectorAll<HTMLElement>(
    '[data-e2e*="avatar"], a[href^="/@"] img, [class*="Avatar"]',
  );
  for (const candidate of candidates) {
    const style = win.getComputedStyle(candidate);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = toRectLike(candidate.getBoundingClientRect());
    if (rect.width >= 24 && rect.width <= 96 && rect.height >= 24 && rect.height <= 96) return rect;
  }
  return null;
}

function mediaElementForTarget(target: OverlayVideoTarget | null): HTMLElement | null {
  return target?.mediaElement ?? target?.video ?? null;
}

function inferNativeRoot(video: HTMLElement | null): HTMLElement | null {
  if (!video) return null;
  return (
    video.closest<HTMLElement>(
      '[data-e2e="recommend-list-item-container"], [data-e2e="feed-video"], [data-e2e="browse-video-container"], [data-e2e="video-detail"], article, [role="dialog"]',
    ) ?? video.parentElement
  );
}

function findNativeActionBar(root: HTMLElement): HTMLElement | null {
  if (root.matches(NATIVE_ACTION_BAR_SELECTORS)) return root;
  return root.querySelector<HTMLElement>(NATIVE_ACTION_BAR_SELECTORS);
}

function findDetailDescription(metadataRoot: HTMLElement): HTMLElement | null {
  if (metadataRoot.matches(DETAIL_DESCRIPTION_SELECTOR)) return metadataRoot;
  return metadataRoot.querySelector<HTMLElement>(DETAIL_DESCRIPTION_SELECTOR);
}

function findDetailMetadataAnchor(metadataRoot: HTMLElement): HTMLElement | null {
  if (metadataRoot.matches(DETAIL_METADATA_ANCHOR_SELECTOR)) return metadataRoot;
  const candidates = metadataRoot.querySelectorAll<HTMLElement>(DETAIL_METADATA_ANCHOR_SELECTOR);
  return candidates.item(candidates.length - 1);
}

/** 只读取可见元素的矩形用于避让，不读取文本、业务属性或修改第三方节点。 */
export function collectLayoutObstacles(
  doc: Document,
  win: Window,
  video: HTMLElement,
): RectLike[] {
  const candidates = new Set<Element>();
  for (const element of doc.querySelectorAll(OBSTACLE_SELECTORS)) candidates.add(element);
  for (const element of Array.from(doc.body?.children ?? []).slice(0, 80)) {
    if (element.matches(HOST_SELECTOR) || element.hasAttribute("data-tiktok-daren-assistant")) continue;
    const style = win.getComputedStyle(element);
    const zIndex = Number.parseInt(style.zIndex, 10);
    if (
      (style.position === "fixed" || style.position === "sticky") &&
      (Number.isNaN(zIndex) || zIndex >= 100)
    ) {
      candidates.add(element);
    }
  }
  const videoRect = toRectLike(video.getBoundingClientRect());
  const results: RectLike[] = [];
  for (const element of candidates) {
    if (element === video || (video.contains(element) && !element.matches(OBSTACLE_SELECTORS))) continue;
    const rect = toRectLike(element.getBoundingClientRect());
    if (rect.width <= 2 || rect.height <= 2) continue;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= win.innerWidth || rect.top >= win.innerHeight) continue;
    if (containsRect(rect, videoRect) && rect.width > videoRect.width * 0.9) continue;
    results.push(rect);
    if (results.length >= 48) break;
  }
  return results;
}

function formatUpdatedAt(value: Date | null): string {
  if (!value) return "--";
  return value.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function toRectLike(
  rect: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">,
): RectLike {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function containsRect(outer: RectLike, inner: RectLike): boolean {
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom
  );
}

function overlapArea(left: RectLike, right: RectLike): number {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function cloneSettings(settings: Readonly<OverlaySettings>): OverlaySettings {
  return {
    ...settings,
    visibleFields: { ...settings.visibleFields },
  };
}
