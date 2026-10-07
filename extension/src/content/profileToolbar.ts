import { formatCount } from "../ui/formatter";
import { iconSvg } from "../ui/icons";
import { createTokenStyleText, uiTokens } from "../ui/tokens";
import type { BrowserDownloadMode } from "../downloads/naming";

const TOOLBAR_SELECTOR = '[data-tiktok-daren-assistant="profile-toolbar"]';
const TOOLBAR_ANCHOR_SELECTOR = '[data-tiktok-daren-assistant="profile-toolbar-anchor"]';
const TOOLBAR_TOP_OFFSET_PX = 8;

export type ProfileSortMode =
  | "default"
  | "created_desc"
  | "created_asc"
  | "play_desc"
  | "like_desc"
  | "comment_desc"
  | "collect_desc"
  | "share_desc"
  | "engagement_desc";

export type ProfileAdMode = "all" | "ad" | "non_ad";

export interface EngagementMetricValues {
  play_count: number | null;
  like_count: number | null | undefined;
  comment_count: number | null | undefined;
  collect_count: number | null | undefined;
  share_count: number | null | undefined;
}

export interface ProfileVideoItem extends EngagementMetricValues {
  video_id: string;
  is_ad: boolean | null;
  cardRoot?: HTMLElement;
  content_type?: "video" | "photo";
  author_unique_id?: string | null;
  author_nickname?: string | null;
  media_url?: string | null;
  background_music_url?: string | null;
  description?: string | null;
  created_at: number | null;
  duration_seconds: number | null;
  page_url?: string | null;
  /** IntersectionObserver 或调用方的当前可见判断。 */
  isVisible?: boolean;
}

export interface ProfileVideoFilter {
  keyword: string;
  adMode: ProfileAdMode;
  minPlayCount: number | null;
  maxPlayCount: number | null;
  minLikeCount: number | null;
  maxLikeCount: number | null;
  minCommentCount: number | null;
  maxCommentCount: number | null;
  minCollectCount: number | null;
  maxCollectCount: number | null;
  minShareCount: number | null;
  maxShareCount: number | null;
  minDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  minEngagementRate: number | null;
  maxEngagementRate: number | null;
  createdFrom: number | null;
  createdTo: number | null;
}

export const EMPTY_PROFILE_FILTER: Readonly<ProfileVideoFilter> = Object.freeze({
  keyword: "",
  adMode: "all",
  minPlayCount: null,
  maxPlayCount: null,
  minLikeCount: null,
  maxLikeCount: null,
  minCommentCount: null,
  maxCommentCount: null,
  minCollectCount: null,
  maxCollectCount: null,
  minShareCount: null,
  maxShareCount: null,
  minDurationSeconds: null,
  maxDurationSeconds: null,
  minEngagementRate: null,
  maxEngagementRate: null,
  createdFrom: null,
  createdTo: null,
});

export interface ProfileToolbarState {
  sortMode: ProfileSortMode;
  filter: ProfileVideoFilter;
  batchSelectionEnabled: boolean;
  autoScrolling: boolean;
  filterPanelOpen: boolean;
}

export interface ProfileToolbarOptions {
  onRefresh?: () => void | Promise<void>;
  onExport?: (csv: string, fileName: string) => void;
  autoScrollStep?: () => void;
  autoScrollIntervalMs?: number;
  onBatchDownload?: (
    items: readonly ProfileVideoItem[],
    mode: BrowserDownloadMode,
    onProgress: (progress: ProfileBatchProgress) => void,
  ) => void | ProfileBatchDownloadOutcome | Promise<void | ProfileBatchDownloadOutcome>;
  onBatchSelectionChange?: () => void;
}

export interface ProfileBatchDownloadOutcome {
  succeeded: number;
  failed: number;
  cancelled?: boolean;
}

export interface ProfileBatchProgress {
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
}

/**
 * 互动率 = (点赞 + 评论 + 收藏 + 分享) / 播放 × 100%。
 * 播放量为空、为 0，或任一互动指标尚未取得时返回 null，不用 0 猜测未知值。
 */
export function calculateEngagementRate(item: Readonly<EngagementMetricValues>): number | null {
  const play = nonNegativeFinite(item.play_count);
  const interactions = [item.like_count, item.comment_count, item.collect_count, item.share_count]
    .map(nonNegativeFinite);
  if (play === null || play <= 0 || interactions.some((value) => value === null)) return null;
  return (interactions.reduce<number>((sum, value) => sum + (value ?? 0), 0) / play) * 100;
}

/** 不改变输入数组；空值永远排在有值之后；同值保留输入稳定顺序。 */
export function sortProfileVideos(
  items: readonly ProfileVideoItem[],
  mode: ProfileSortMode,
): ProfileVideoItem[] {
  const indexed = items.map((item, index) => ({ item, index }));
  if (mode === "default") return indexed.map(({ item }) => item);
  return indexed
    .sort((left, right) => {
      const leftValue = sortValue(left.item, mode);
      const rightValue = sortValue(right.item, mode);
      if (leftValue === null && rightValue === null) return left.index - right.index;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      const compared = mode === "created_asc" ? leftValue - rightValue : rightValue - leftValue;
      return compared || left.index - right.index;
    })
    .map(({ item }) => item);
}

/** 所有条件均为包含边界；字段未知时不能证明符合已启用条件，因此会被过滤。 */
export function filterProfileVideos(
  items: readonly ProfileVideoItem[],
  filter: Readonly<ProfileVideoFilter>,
): ProfileVideoItem[] {
  const keyword = filter.keyword.trim().toLocaleLowerCase();
  return items.filter((item) => {
    const engagementRate = calculateEngagementRate(item);
    return matchesAdMode(item.is_ad, filter.adMode) &&
      matchesKeyword(item, keyword) &&
      passesRange(item.created_at, filter.createdFrom, filter.createdTo) &&
      passesRange(item.duration_seconds, filter.minDurationSeconds, filter.maxDurationSeconds) &&
      passesRange(item.play_count, filter.minPlayCount, filter.maxPlayCount) &&
      passesRange(item.like_count ?? null, filter.minLikeCount, filter.maxLikeCount) &&
      passesRange(item.comment_count ?? null, filter.minCommentCount, filter.maxCommentCount) &&
      passesRange(item.collect_count ?? null, filter.minCollectCount, filter.maxCollectCount) &&
      passesRange(item.share_count ?? null, filter.minShareCount, filter.maxShareCount) &&
      passesRange(engagementRate, filter.minEngagementRate, filter.maxEngagementRate);
  });
}

/** Excel 友好的 UTF-8 BOM CSV；危险公式前缀会转为普通文本。 */
export function exportProfileVideosCsv(items: readonly ProfileVideoItem[]): string {
  const headers = [
    "video_id", "作者账号", "视频描述", "发布时间", "播放量", "点赞量",
    "评论量", "收藏量", "分享量", "互动率(%)", "时长(秒)", "视频链接",
  ];
  const rows = items.map((item) => [
    item.video_id,
    item.author_unique_id ?? "",
    item.description ?? "",
    formatCsvDate(item.created_at),
    csvNumber(item.play_count),
    csvNumber(item.like_count ?? null),
    csvNumber(item.comment_count ?? null),
    csvNumber(item.collect_count ?? null),
    csvNumber(item.share_count ?? null),
    csvNumber(calculateEngagementRate(item)),
    csvNumber(item.duration_seconds),
    item.page_url ?? "",
  ]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

export class AutoScrollController {
  private timer: number | null = null;

  constructor(
    private readonly step: () => void,
    private readonly schedule: (callback: () => void, intervalMs: number) => number,
    private readonly cancel: (timer: number) => void,
    private readonly intervalMs = 850,
    private readonly onStateChange: (running: boolean) => void = () => undefined,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null) return;
    this.step();
    this.timer = this.schedule(() => this.step(), this.intervalMs);
    this.onStateChange(true);
  }

  stop(): void {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
    this.onStateChange(false);
  }

  toggle(): void {
    if (this.running) this.stop();
    else this.start();
  }
}

interface OriginalCardPosition {
  anchor: Comment;
  parent: HTMLElement;
  originalDisplay: string;
  originalDisplayPriority: string;
  originalOrder: string;
  originalOrderPriority: string;
  originalHidden: boolean;
  index: number;
}

/**
 * TikTok 的 data-e2e 卡片有时位于真正的 CSS Grid 项内部。只隐藏或移动内层
 * 会留下白色空位；这里上溯到仍只包含当前帖子的最外层布局项。
 */
export function resolveProfileCardLayoutRoot(
  cardRoot: HTMLElement,
  gridRoot: HTMLElement,
  videoId: string,
): HTMLElement {
  if (!gridRoot.contains(cardRoot)) return cardRoot;
  let current = cardRoot;
  while (current.parentElement && current.parentElement !== gridRoot) {
    const parent = current.parentElement;
    const postIds = postIdsWithin(parent);
    if (postIds.size > 1 || (postIds.size === 1 && !postIds.has(videoId))) break;
    current = parent;
  }
  return current;
}

/**
 * 达人主页工具栏不采集数据，只对调用方提供的 video_id 记录进行排序、筛选、
 * CSV 导出和受控滚动。DOM 排序用原位锚点保存初始顺序，随时可恢复。
 */
export class ProfileToolbarController {
  private host: HTMLElement | null = null;
  private stickyAnchor: HTMLElement | null = null;
  private dockedToViewport = false;
  private shadow: ShadowRoot | null = null;
  private gridRoot: HTMLElement | null = null;
  private items: ProfileVideoItem[] = [];
  private displayedItems: ProfileVideoItem[] = [];
  private batchBusy = false;
  private readonly excludedBatchVideoIds = new Set<string>();
  private batchProgressHideTimer: number | null = null;
  private readonly positions = new Map<HTMLElement, OriginalCardPosition>();
  private state: ProfileToolbarState = {
    sortMode: "default",
    filter: { ...EMPTY_PROFILE_FILTER },
    batchSelectionEnabled: true,
    autoScrolling: false,
    filterPanelOpen: false,
  };
  private readonly autoScroller: AutoScrollController;

  private readonly handleViewportChange = (): void => {
    this.syncViewportDocking();
  };

  private readonly handleClick = (event: Event): void => {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "refresh") {
      try {
        void Promise.resolve(this.options.onRefresh?.()).catch((error: unknown) => console.error("达人主页数据刷新失败", error));
      } catch (error) {
        console.error("达人主页数据刷新失败", error);
      }
    }
    if (action === "toggle-filter") this.setFilterPanelOpen(!this.state.filterPanelOpen);
    if (action === "apply-filter") this.applyFilterFromInputs();
    if (action === "reset-filter") this.setFilter({ ...EMPTY_PROFILE_FILTER });
    if (action === "toggle-auto-scroll") this.autoScroller.toggle();
    if (action === "export") this.exportCurrentItems();
    if (action === "batch-download-video") void this.runBatchDownload("video");
    if (action === "batch-download-audio") void this.runBatchDownload("audio_track");
  };

  private readonly handleChange = (event: Event): void => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (input?.dataset.action === "select-all-results") {
      this.setBatchSelectionEnabled(input.checked);
      return;
    }
    const select = event.target instanceof HTMLSelectElement ? event.target : null;
    if (select?.dataset.action === "sort") {
      this.setSortMode(asSortMode(select.value));
      return;
    }
    if (select?.dataset.action === "filter-ad") {
      this.setFilter({ ...this.state.filter, adMode: asAdMode(select.value) });
    }
  };

  constructor(
    private readonly doc: Document = document,
    private readonly win: Window = window,
    private readonly options: ProfileToolbarOptions = {},
  ) {
    const step = options.autoScrollStep ?? (() => {
      this.win.scrollBy({ top: Math.max(360, Math.round(this.win.innerHeight * 0.72)), behavior: "auto" });
    });
    this.autoScroller = new AutoScrollController(
      step,
      (callback, delay) => this.win.setInterval(callback, delay),
      (timer) => this.win.clearInterval(timer),
      options.autoScrollIntervalMs ?? 850,
      (running) => {
        this.state.autoScrolling = running;
        this.updateAutoScrollButton();
      },
    );
  }

  mount(gridRoot: HTMLElement, items: readonly ProfileVideoItem[]): HTMLElement {
    this.gridRoot = gridRoot;
    const candidates = Array.from(this.doc.querySelectorAll<HTMLElement>(TOOLBAR_SELECTOR));
    this.host = candidates.shift() ?? this.createHost(gridRoot);
    for (const duplicate of candidates) duplicate.remove();
    this.ensureStickyAnchor(gridRoot);
    this.restoreHostToFlow();
    this.applyStickyHostStyles();
    this.win.addEventListener("scroll", this.handleViewportChange, true);
    this.win.addEventListener("resize", this.handleViewportChange);

    this.shadow = this.host.shadowRoot ?? this.host.attachShadow({ mode: "open" });
    this.renderShell(this.shadow);
    this.shadow.addEventListener("click", this.handleClick);
    this.shadow.addEventListener("change", this.handleChange);
    const select = this.shadow.querySelector<HTMLSelectElement>('[data-action="sort"]');
    if (select) select.value = this.state.sortMode;
    this.syncFilterInputs();
    this.updateFilterButton();
    this.setFilterPanelOpen(this.state.filterPanelOpen);
    this.setBatchSelectionEnabled(this.state.batchSelectionEnabled, false);
    this.updateAutoScrollButton();
    this.update(items);
    return this.host;
  }

  update(items: readonly ProfileVideoItem[]): void {
    // TikTok can briefly return an empty or partial card snapshot while it is
    // recycling a profile grid. Treating that transient gap as a real deletion
    // restores every filtered card, then hides it again on the next snapshot —
    // the visible result is a continuous full-grid flash. Keep an old item only
    // while its exact layout root is still connected to this same grid and has
    // not already been replaced by an incoming id/root.
    const incomingIds = new Set(items.map((item) => item.video_id));
    const incomingRoots = new Set(
      items.flatMap((item) => item.cardRoot ? [item.cardRoot] : []),
    );
    const retainedItems = this.items.filter((item) => {
      const root = item.cardRoot;
      if (!root || incomingIds.has(item.video_id) || incomingRoots.has(root)) return false;
      if (!root.isConnected || !this.gridRoot?.contains(root)) return false;
      const currentPostIds = postIdsWithin(root);
      return currentPostIds.size === 0 || currentPostIds.has(item.video_id);
    });
    const stableItems = [...items, ...retainedItems];
    this.reconcilePositions(stableItems);
    this.items = stableItems;
    this.applyView();
  }

  setSortMode(mode: ProfileSortMode): void {
    this.state.sortMode = mode;
    const select = this.shadow?.querySelector<HTMLSelectElement>('[data-action="sort"]');
    if (select) select.value = mode;
    this.applyView();
  }

  setFilter(filter: Readonly<ProfileVideoFilter>): void {
    this.state.filter = normalizeFilter(filter);
    this.syncFilterInputs();
    this.updateFilterButton();
    this.applyView();
  }

  setFilterPanelOpen(open: boolean): void {
    this.state.filterPanelOpen = open;
    const panel = this.shadow?.querySelector<HTMLElement>(".tda-profile-filters");
    const button = this.shadow?.querySelector<HTMLButtonElement>('[data-action="toggle-filter"]');
    if (panel) panel.hidden = !open;
    if (button) button.setAttribute("aria-expanded", String(open));
  }

  startAutoScroll(): void {
    this.autoScroller.start();
  }

  stopAutoScroll(): void {
    this.autoScroller.stop();
  }

  getState(): Readonly<ProfileToolbarState> {
    return {
      ...this.state,
      filter: { ...this.state.filter },
    };
  }

  getDisplayedItems(): readonly ProfileVideoItem[] {
    return this.displayedItems;
  }

  /** 当前批量范围始终是筛选后的结果，并保持工具栏排序后的顺序。 */
  getBatchItems(): readonly ProfileVideoItem[] {
    if (!this.state.batchSelectionEnabled) return [];
    return this.displayedItems.filter(
      (item) => item.content_type !== "photo" && !this.excludedBatchVideoIds.has(item.video_id),
    );
  }

  isItemSelected(videoId: string): boolean {
    return this.state.batchSelectionEnabled && !this.excludedBatchVideoIds.has(videoId);
  }

  setItemSelected(videoId: string, selected: boolean): void {
    const availableIds = this.items
      .filter((item) => item.content_type !== "photo")
      .map((item) => item.video_id);
    if (!availableIds.includes(videoId)) return;
    if (selected && !this.state.batchSelectionEnabled) {
      this.state.batchSelectionEnabled = true;
      for (const id of availableIds) this.excludedBatchVideoIds.add(id);
    }
    if (selected) this.excludedBatchVideoIds.delete(videoId);
    else this.excludedBatchVideoIds.add(videoId);
    this.updateCounts();
    this.options.onBatchSelectionChange?.();
  }

  setBatchSelectionEnabled(enabled: boolean, notify = true): void {
    this.state.batchSelectionEnabled = enabled;
    this.excludedBatchVideoIds.clear();
    this.updateCounts();
    if (notify) this.options.onBatchSelectionChange?.();
  }

  destroy(): void {
    this.autoScroller.stop();
    if (this.batchProgressHideTimer !== null) this.win.clearTimeout(this.batchProgressHideTimer);
    this.batchProgressHideTimer = null;
    this.win.removeEventListener("scroll", this.handleViewportChange, true);
    this.win.removeEventListener("resize", this.handleViewportChange);
    this.restoreDefaultOrder();
    for (const [root, position] of this.positions) {
      this.restoreRootPresentation(root, position);
      position.anchor.remove();
    }
    this.positions.clear();
    if (this.shadow) {
      this.shadow.removeEventListener("click", this.handleClick);
      this.shadow.removeEventListener("change", this.handleChange);
    }
    this.host?.remove();
    this.stickyAnchor?.remove();
    this.host = null;
    this.stickyAnchor = null;
    this.dockedToViewport = false;
    this.shadow = null;
    this.gridRoot = null;
    this.items = [];
    this.displayedItems = [];
  }

  private createHost(gridRoot: HTMLElement): HTMLElement {
    const host = this.doc.createElement("div");
    host.setAttribute("data-tiktok-daren-assistant", "profile-toolbar");
    gridRoot.parentElement?.insertBefore(host, gridRoot);
    return host;
  }

  /**
   * TikTok profile layouts regularly put the grid below overflow/transform wrappers.
   * Native `position: sticky` is then constrained by that wrapper instead of the
   * viewport. Keep a zero-height sentinel in the original flow and portal the
   * toolbar to `body` only after the sentinel reaches the viewport edge.
   */
  private ensureStickyAnchor(gridRoot: HTMLElement): void {
    const parent = gridRoot.parentElement;
    if (!parent || !this.host) return;
    const anchors = Array.from(this.doc.querySelectorAll<HTMLElement>(TOOLBAR_ANCHOR_SELECTOR));
    this.stickyAnchor = anchors.shift() ?? this.doc.createElement("div");
    for (const duplicate of anchors) duplicate.remove();
    this.stickyAnchor.setAttribute("data-tiktok-daren-assistant", "profile-toolbar-anchor");
    this.stickyAnchor.setAttribute("aria-hidden", "true");
    this.stickyAnchor.style.cssText = "display:block;height:0;margin:0;padding:0;border:0;pointer-events:none";
    if (this.stickyAnchor.parentElement !== parent || this.stickyAnchor.nextSibling !== this.host) {
      parent.insertBefore(this.stickyAnchor, gridRoot);
      this.stickyAnchor.after(this.host);
    }
  }

  private applyStickyHostStyles(): void {
    if (!this.host) return;
    this.host.style.setProperty("display", "block", "important");
    this.host.style.setProperty("position", "sticky", "important");
    this.host.style.setProperty("top", `${TOOLBAR_TOP_OFFSET_PX}px`, "important");
    this.host.style.setProperty("z-index", uiTokens.zIndex.toolbar, "important");
    this.host.style.setProperty("margin", "8px 0", "important");
    this.host.style.setProperty("isolation", "isolate", "important");
    this.host.style.removeProperty("left");
    this.host.style.removeProperty("right");
    this.host.style.removeProperty("width");
    this.host.style.removeProperty("max-width");
  }

  private syncViewportDocking(): void {
    if (!this.host || !this.stickyAnchor || !this.gridRoot) return;
    if (!this.stickyAnchor.isConnected || !this.gridRoot.isConnected) {
      if (this.dockedToViewport) this.host.remove();
      this.dockedToViewport = false;
      return;
    }

    const anchorTop = this.stickyAnchor.getBoundingClientRect().top;
    if (!Number.isFinite(anchorTop)) return;
    if (anchorTop <= TOOLBAR_TOP_OFFSET_PX) {
      this.dockHostToViewport();
    } else {
      this.restoreHostToFlow();
    }
  }

  private dockHostToViewport(): void {
    if (!this.host || !this.stickyAnchor || !this.gridRoot) return;
    const alignmentRoot = this.gridRoot.parentElement ?? this.gridRoot;
    const alignmentRect = alignmentRoot.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    const viewportWidth = Math.max(0, this.win.innerWidth || this.doc.documentElement.clientWidth);
    const availableWidth = Math.max(0, viewportWidth - (TOOLBAR_TOP_OFFSET_PX * 2));
    const measuredWidth = alignmentRect.width > 0 ? alignmentRect.width : hostRect.width;
    const width = Math.min(measuredWidth, availableWidth);
    const left = Math.min(
      Math.max(TOOLBAR_TOP_OFFSET_PX, alignmentRect.left),
      Math.max(TOOLBAR_TOP_OFFSET_PX, viewportWidth - TOOLBAR_TOP_OFFSET_PX - width),
    );

    if (!this.dockedToViewport) {
      const computed = this.win.getComputedStyle(this.host);
      const marginTop = Number.parseFloat(computed.marginTop) || 0;
      const marginBottom = Number.parseFloat(computed.marginBottom) || 0;
      const reservedHeight = Math.max(hostRect.height, this.host.offsetHeight) + marginTop + marginBottom;
      this.stickyAnchor.style.height = `${Math.ceil(reservedHeight)}px`;
      (this.doc.body ?? this.doc.documentElement).append(this.host);
      this.dockedToViewport = true;
    }

    this.host.style.setProperty("display", "block", "important");
    this.host.style.setProperty("position", "fixed", "important");
    this.host.style.setProperty("top", `${TOOLBAR_TOP_OFFSET_PX}px`, "important");
    this.host.style.setProperty("left", `${Math.round(left)}px`, "important");
    this.host.style.setProperty("right", "auto", "important");
    this.host.style.setProperty("width", `${Math.round(width)}px`, "important");
    this.host.style.setProperty("max-width", `calc(100vw - ${TOOLBAR_TOP_OFFSET_PX * 2}px)`, "important");
    this.host.style.setProperty("margin", "0", "important");
    this.host.style.setProperty("z-index", uiTokens.zIndex.toolbar, "important");
  }

  private restoreHostToFlow(): void {
    if (!this.host || !this.stickyAnchor) return;
    if (this.host.parentElement !== this.stickyAnchor.parentElement || this.stickyAnchor.nextSibling !== this.host) {
      this.stickyAnchor.after(this.host);
    }
    this.stickyAnchor.style.height = "0px";
    this.dockedToViewport = false;
    this.applyStickyHostStyles();
  }

  private renderShell(shadow: ShadowRoot): void {
    shadow.replaceChildren();
    const style = this.doc.createElement("style");
    style.textContent = `
      ${createTokenStyleText()}
      :host { color-scheme: light dark; font-family: "Microsoft YaHei UI", system-ui, sans-serif; font-variant-numeric: tabular-nums; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      button, select, input { font: inherit; }
      .tda-toolbar { position: relative; display: flex; flex-wrap: wrap; align-items: center; min-height: 40px; gap: 7px; padding: 6px 8px;
        border: 1px solid var(--tda-color-border); border-radius: var(--tda-radius-md); color: var(--tda-color-text); background: rgba(255,255,255,.96);
        box-shadow: var(--tda-shadow-subtle); }
      .tda-count { display: flex; align-items: baseline; gap: 4px; white-space: nowrap; }
      .tda-count strong { font-size: var(--tda-font-size-md); } .tda-count span { color: var(--tda-color-text-secondary); font-size: 11px; }
      .tda-batch-scope { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 0 7px; border: 1px solid rgba(22,24,35,.1); border-radius: 7px; color: var(--tda-color-text-secondary); background: var(--tda-color-surface-muted); cursor: pointer; white-space: nowrap; }
      .tda-batch-scope input { width: 14px; height: 14px; margin: 0; padding: 0; border: 0; background: transparent; accent-color: var(--tda-color-accent); }
      .tda-batch-scope strong { color: var(--tda-color-text); }
      .tda-spacer { flex: 1; }
      .tda-button, .tda-select { min-height: 28px; border: 1px solid rgba(22,24,35,.14); border-radius: 7px;
        color: inherit; background: var(--tda-color-surface-muted); cursor: pointer; }
      .tda-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 0 8px; }
      .tda-button:hover, .tda-select:hover { background: #ececee; }
      .tda-button svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      .tda-select { max-width: 148px; padding: 0 22px 0 7px; }
      .tda-select[data-active="true"] { border-color: var(--tda-color-accent); color: var(--tda-color-accent); background: var(--tda-color-accent-soft); }
      .tda-button[data-active="true"] { border-color: var(--tda-color-accent); color: var(--tda-color-accent); background: var(--tda-color-accent-soft); }
      .tda-auto[aria-pressed="true"] { border-color: var(--tda-color-accent); color: var(--tda-color-text-inverse); background: var(--tda-color-accent); }
      .tda-batch-download { width: 30px; padding: 0; color: #fff; border-color: #2563eb; background: #2563eb; }
      .tda-batch-download:hover { color: #fff; background: #1d4ed8; }
      .tda-batch-download:disabled { cursor: wait; opacity: .55; }
      .tda-batch-progress { position: absolute; z-index: 6; top: calc(100% + 10px); right: 8px; display: grid; width: 58px; height: 58px; place-items: center; border: 1px solid var(--tda-color-border); border-radius: 13px; background: var(--tda-color-surface); box-shadow: var(--tda-shadow-floating); }
      .tda-progress-ring { --tda-progress: 0deg; position: relative; display: grid; width: 42px; height: 42px; place-items: center; border-radius: 50%; background: conic-gradient(#3b82f6 var(--tda-progress), #e9edf3 0); }
      .tda-progress-ring::after { position: absolute; inset: 4px; border-radius: 50%; background: var(--tda-color-surface); content: ""; }
      .tda-progress-ring strong { position: relative; z-index: 1; color: var(--tda-color-text); font-size: 11px; }
      .tda-batch-progress[data-state="error"] .tda-progress-ring { background: #dc3545; }
      .tda-batch-progress[data-state="complete"] .tda-progress-ring { background: #168a4b; }
      .tda-profile-filters { position: absolute; z-index: 5; top: calc(100% + 6px); right: 0; width: min(680px, 96vw); max-height: min(70vh, 560px); overflow: auto; padding: 12px;
        border: 1px solid var(--tda-color-border); border-radius: var(--tda-radius-md); color: var(--tda-color-text); background: var(--tda-color-surface);
        box-shadow: var(--tda-shadow-floating); }
      .tda-filter-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; }
      .tda-filter-wide { grid-column: 1 / -1; }
      .tda-range { display: grid; grid-template-columns: minmax(82px,.7fr) minmax(0,1fr) 12px minmax(0,1fr); align-items: center; gap: 5px; }
      .tda-range-title { color: var(--tda-color-text-secondary); font-size: 11px; white-space: nowrap; }
      .tda-range-separator { color: var(--tda-color-text-muted); text-align: center; }
      label { display: grid; gap: 3px; color: #6b6d76; font-size: 11px; }
      input { width: 100%; height: 28px; padding: 0 6px; border: 1px solid #d9d9dd; border-radius: 6px; color: #161823; background: #fff; }
      .tda-filter-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 9px; }
      @media (prefers-color-scheme: dark) {
        .tda-toolbar, .tda-profile-filters { color: #f4f4f5; border-color: rgba(255,255,255,.14); background: rgba(28,29,34,.96); }
        .tda-count span, label { color: #aaaab2; } .tda-button, .tda-select, input { color: #f4f4f5; border-color: rgba(255,255,255,.15); background: #27282e; }
        .tda-button:hover, .tda-select:hover { background: #33343b; }
      }
      @media (max-width: 620px) {
        .tda-spacer { display: none; }
        .tda-filter-grid { grid-template-columns: 1fr; }
        .tda-filter-wide { grid-column: auto; }
      }
    `;
    const wrap = this.doc.createElement("div");
    wrap.className = "tda-toolbar";
    wrap.innerHTML = `
      <div class="tda-count" title="当前已识别 / 当前筛选结果"><strong data-count="identified">0</strong><span>已识别</span><strong data-count="visible">0</strong><span>筛选结果</span></div>
      <button type="button" class="tda-button" data-action="refresh" title="刷新当前数据">${iconSvg("refresh")}<span>刷新</span></button>
      <select class="tda-select" data-action="sort" aria-label="视频排序">
        <option value="default">默认顺序</option><option value="created_desc">最新发布</option>
        <option value="created_asc">最早发布</option><option value="play_desc">播放量最高</option>
        <option value="like_desc">点赞量最高</option><option value="comment_desc">评论量最高</option>
        <option value="collect_desc">收藏量最高</option><option value="share_desc">分享量最高</option>
        <option value="engagement_desc">互动率最高</option>
      </select>
      <select class="tda-select" data-action="filter-ad" aria-label="广告视频筛选" title="尚未确认广告状态的视频仅在全部视频中显示">
        <option value="all">全部视频</option>
        <option value="ad">广告视频</option>
        <option value="non_ad">非广告视频</option>
      </select>
      <label class="tda-batch-scope" title="批量下载仅包含当前筛选结果，并按当前排序执行"><input type="checkbox" data-action="select-all-results" checked><span>批量全选</span><strong data-count="selected">0</strong></label>
      <button type="button" class="tda-button tda-batch-download" data-action="batch-download-video" title="批量下载已选无水印视频 ZIP" aria-label="批量下载已选无水印视频 ZIP">${iconSvg("video")}</button>
      <button type="button" class="tda-button tda-batch-download" data-action="batch-download-audio" title="批量提取已选视频音频 ZIP" aria-label="批量提取已选视频音频 ZIP">${iconSvg("music")}</button>
      <span class="tda-spacer"></span>
      <button type="button" class="tda-button" data-action="toggle-filter" aria-expanded="false">${iconSvg("filter")}<span>筛选</span></button>
      <button type="button" class="tda-button tda-auto" data-action="toggle-auto-scroll" aria-pressed="false">${iconSvg("chevronDown")}<span data-auto-label>自动滚动</span></button>
      <button type="button" class="tda-button" data-action="export">${iconSvg("export")}<span>导出 CSV</span></button>
      <output class="tda-batch-progress" data-batch-progress aria-live="polite" hidden><span class="tda-progress-ring"><strong data-batch-percent>0%</strong></span></output>
      <section class="tda-profile-filters" aria-label="视频筛选" hidden>
        <div class="tda-filter-grid">
          <label class="tda-filter-wide">关键词<input type="search" data-filter="keyword" placeholder="视频描述、作者账号或 video_id"></label>
          ${rangeInput("date-from", "date-to", "发布时间", "date")}
          ${rangeInput("min-duration", "max-duration", "时长（秒）", "number")}
          ${rangeInput("min-play", "max-play", "播放量", "number")}
          ${rangeInput("min-like", "max-like", "点赞量", "number")}
          ${rangeInput("min-comment", "max-comment", "评论量", "number")}
          ${rangeInput("min-collect", "max-collect", "收藏量", "number")}
          ${rangeInput("min-share", "max-share", "分享量", "number")}
          ${rangeInput("min-engagement", "max-engagement", "互动率（%）", "number", "0.01")}
        </div>
        <div class="tda-filter-actions"><button type="button" class="tda-button" data-action="reset-filter">重置</button><button type="button" class="tda-button" data-action="apply-filter">应用筛选</button></div>
      </section>
    `;
    shadow.append(style, wrap);
  }

  private reconcilePositions(items: readonly ProfileVideoItem[]): void {
    const currentRoots = new Set(items.flatMap((item) => item.cardRoot ? [item.cardRoot] : []));
    for (const [root, position] of [...this.positions]) {
      if (currentRoots.has(root)) continue;
      // A root that truly disappeared belongs to TikTok. Restore only the
      // presentation we changed; never drag the stale node back through its old
      // anchor because that creates another child-list mutation and can revive a
      // card TikTok intentionally removed.
      this.restoreRootPresentation(root, position);
      position.anchor.remove();
      this.positions.delete(root);
    }
    for (const item of items) {
      const root = item.cardRoot;
      if (!root?.parentElement || this.positions.has(root)) continue;
      const anchor = this.doc.createComment("tiktok-daren-assistant:card-default-position");
      root.parentElement.insertBefore(anchor, root);
      const nextIndex = [...this.positions.values()].reduce((maximum, position) => Math.max(maximum, position.index), -1) + 1;
      this.positions.set(root, {
        anchor,
        parent: root.parentElement,
        originalDisplay: root.style.display,
        originalDisplayPriority: root.style.getPropertyPriority("display"),
        originalOrder: root.style.order,
        originalOrderPriority: root.style.getPropertyPriority("order"),
        originalHidden: root.hidden,
        index: nextIndex,
      });
    }
  }

  private applyView(): void {
    const filtered = filterProfileVideos(this.items, this.state.filter);
    const visibleRoots = new Set(filtered.flatMap((item) => item.cardRoot ? [item.cardRoot] : []));
    for (const [root, position] of this.positions) {
      this.setRootVisible(root, position, visibleRoots.has(root));
    }

    const defaultOrdered = [...filtered].sort((left, right) => this.positionIndex(left) - this.positionIndex(right));
    if (this.state.sortMode === "default") {
      this.restoreDefaultOrder();
      this.displayedItems = defaultOrdered;
    } else {
      this.displayedItems = sortProfileVideos(defaultOrdered, this.state.sortMode);
      for (const [index, item] of this.displayedItems.entries()) {
        if (item.cardRoot) setStylePropertyIfChanged(item.cardRoot, "order", String(index), "important");
      }
      const byParent = new Map<HTMLElement, HTMLElement[]>();
      for (const item of this.displayedItems) {
        if (!item.cardRoot) continue;
        const position = this.positions.get(item.cardRoot);
        if (!position) continue;
        const group = byParent.get(position.parent) ?? [];
        group.push(item.cardRoot);
        byParent.set(position.parent, group);
      }
      for (const [parent, roots] of byParent) {
        const rootSet = new Set(roots);
        const current = Array.from(parent.children).filter(
          (child): child is HTMLElement => child instanceof HTMLElement && rootSet.has(child),
        );
        if (current.length === roots.length && current.every((root, index) => root === roots[index])) {
          continue;
        }
        for (const root of roots) parent.append(root);
      }
    }
    this.updateCounts();
  }

  private restoreDefaultOrder(): void {
    const ordered = [...this.positions.entries()].sort(([, a], [, b]) => a.index - b.index);
    for (const [root, position] of ordered) {
      setStylePropertyIfChanged(root, "order", position.originalOrder, position.originalOrderPriority);
      if (position.anchor.parentNode && root.isConnected && position.anchor.nextSibling !== root) {
        position.anchor.after(root);
      }
    }
  }

  private positionIndex(item: ProfileVideoItem): number {
    return item.cardRoot ? this.positions.get(item.cardRoot)?.index ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  }

  private updateCounts(): void {
    const identified = this.shadow?.querySelector<HTMLElement>('[data-count="identified"]');
    const visible = this.shadow?.querySelector<HTMLElement>('[data-count="visible"]');
    const selected = this.shadow?.querySelector<HTMLElement>('[data-count="selected"]');
    if (identified) identified.textContent = String(this.items.length);
    if (visible) visible.textContent = String(this.displayedItems.length);
    if (selected) selected.textContent = String(this.getBatchItems().length);
    const selectAll = this.shadow?.querySelector<HTMLInputElement>('[data-action="select-all-results"]');
    if (selectAll) {
      const selectableCount = this.displayedItems.filter((item) => item.content_type !== "photo").length;
      const selectedCount = this.getBatchItems().length;
      selectAll.checked = selectableCount > 0 && selectedCount === selectableCount;
      selectAll.indeterminate = selectedCount > 0 && selectedCount < selectableCount;
    }
    const batchButtons = this.shadow?.querySelectorAll<HTMLButtonElement>('[data-action^="batch-download-"]');
    if (batchButtons) {
      const count = this.getBatchItems().length;
      for (const batchButton of batchButtons) {
        const audio = batchButton.dataset.action === "batch-download-audio";
        batchButton.disabled = this.batchBusy || count === 0;
        batchButton.title = count > 0
          ? `批量${audio ? "提取已选视频音频" : "下载已选无水印视频"} ZIP（${count}）`
          : "请先选择需要下载的视频";
        batchButton.setAttribute("aria-label", batchButton.title);
      }
    }
  }

  private async runBatchDownload(mode: BrowserDownloadMode): Promise<void> {
    if (this.batchBusy || !this.options.onBatchDownload) return;
    const items = this.getBatchItems();
    if (items.length === 0) return;
    this.batchBusy = true;
    this.updateCounts();
    this.renderBatchProgress({
      processed: 0,
      total: items.length,
      succeeded: 0,
      failed: 0,
      status: "queued",
    });
    try {
      const result = await this.options.onBatchDownload(
        items,
        mode,
        (progress) => this.renderBatchProgress(progress),
      );
      if (result?.cancelled) {
        this.hideBatchProgress();
      } else if (result && result.failed > 0) {
        this.finishBatchProgress(
          "error",
          "!",
          `ZIP 已保存：成功 ${result.succeeded}，失败 ${result.failed}`,
        );
      } else {
        const count = result?.succeeded ?? items.length;
        this.finishBatchProgress(
          "complete",
          "100%",
          `${mode === "video" ? "批量视频" : "批量音频"} ZIP 已保存，共 ${count} 个`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "批量下载失败";
      console.error("[TikTok 达人助手] 页内批量下载失败", error);
      this.finishBatchProgress("error", "!", message);
    } finally {
      this.batchBusy = false;
      this.updateCounts();
    }
  }

  private hideBatchProgress(): void {
    const output = this.shadow?.querySelector<HTMLOutputElement>("[data-batch-progress]");
    if (output) output.hidden = true;
  }

  private renderBatchProgress(progress: ProfileBatchProgress): void {
    const output = this.shadow?.querySelector<HTMLOutputElement>("[data-batch-progress]");
    const ring = output?.querySelector<HTMLElement>(".tda-progress-ring");
    const label = output?.querySelector<HTMLElement>("[data-batch-percent]");
    if (!output || !ring || !label) return;
    const total = Math.max(1, progress.total);
    const percent = Math.max(0, Math.min(99, Math.round((progress.processed / total) * 100)));
    output.hidden = false;
    output.dataset.state = "running";
    output.title = `已处理 ${progress.processed}/${progress.total}，成功 ${progress.succeeded}，失败 ${progress.failed}`;
    ring.style.setProperty("--tda-progress", `${percent * 3.6}deg`);
    label.textContent = `${percent}%`;
  }

  private finishBatchProgress(state: "complete" | "error", label: string, title: string): void {
    const output = this.shadow?.querySelector<HTMLOutputElement>("[data-batch-progress]");
    const ring = output?.querySelector<HTMLElement>(".tda-progress-ring");
    const value = output?.querySelector<HTMLElement>("[data-batch-percent]");
    if (!output || !ring || !value) return;
    output.hidden = false;
    output.dataset.state = state;
    output.title = title;
    ring.style.setProperty("--tda-progress", "360deg");
    value.textContent = label;
    if (this.batchProgressHideTimer !== null) this.win.clearTimeout(this.batchProgressHideTimer);
    this.batchProgressHideTimer = this.win.setTimeout(() => {
      output.hidden = true;
      this.batchProgressHideTimer = null;
    }, state === "complete" ? 1_400 : 3_200);
  }

  private setRootVisible(root: HTMLElement, position: OriginalCardPosition, visible: boolean): void {
    if (!visible) {
      if (!root.hidden) root.hidden = true;
      setStylePropertyIfChanged(root, "display", "none", "important");
      if (root.getAttribute("data-tiktok-daren-assistant-filtered") !== "true") {
        root.setAttribute("data-tiktok-daren-assistant-filtered", "true");
      }
      return;
    }
    if (root.hidden !== position.originalHidden) root.hidden = position.originalHidden;
    setStylePropertyIfChanged(root, "display", position.originalDisplay, position.originalDisplayPriority);
    if (root.hasAttribute("data-tiktok-daren-assistant-filtered")) {
      root.removeAttribute("data-tiktok-daren-assistant-filtered");
    }
  }

  private restoreRootPresentation(root: HTMLElement, position: OriginalCardPosition): void {
    if (root.hidden !== position.originalHidden) root.hidden = position.originalHidden;
    setStylePropertyIfChanged(root, "display", position.originalDisplay, position.originalDisplayPriority);
    setStylePropertyIfChanged(root, "order", position.originalOrder, position.originalOrderPriority);
    if (root.hasAttribute("data-tiktok-daren-assistant-filtered")) {
      root.removeAttribute("data-tiktok-daren-assistant-filtered");
    }
  }

  private updateAutoScrollButton(): void {
    const button = this.shadow?.querySelector<HTMLButtonElement>('[data-action="toggle-auto-scroll"]');
    const label = button?.querySelector<HTMLElement>("[data-auto-label]");
    if (button) button.setAttribute("aria-pressed", String(this.state.autoScrolling));
    if (label) label.textContent = this.state.autoScrolling ? "停止滚动" : "自动滚动";
  }

  private updateFilterButton(): void {
    const button = this.shadow?.querySelector<HTMLButtonElement>('[data-action="toggle-filter"]');
    if (!button) return;
    const active = isFilterActive(this.state.filter);
    button.dataset.active = String(active);
    button.title = active ? "筛选条件已生效" : "设置筛选条件";
  }

  private syncFilterInputs(): void {
    const adSelect = this.shadow?.querySelector<HTMLSelectElement>('[data-action="filter-ad"]');
    if (adSelect) {
      adSelect.value = this.state.filter.adMode;
      adSelect.dataset.active = String(this.state.filter.adMode !== "all");
    }
    const values: Record<string, string> = {
      "keyword": this.state.filter.keyword,
      "min-play": inputNumber(this.state.filter.minPlayCount),
      "max-play": inputNumber(this.state.filter.maxPlayCount),
      "min-like": inputNumber(this.state.filter.minLikeCount),
      "max-like": inputNumber(this.state.filter.maxLikeCount),
      "min-comment": inputNumber(this.state.filter.minCommentCount),
      "max-comment": inputNumber(this.state.filter.maxCommentCount),
      "min-collect": inputNumber(this.state.filter.minCollectCount),
      "max-collect": inputNumber(this.state.filter.maxCollectCount),
      "min-share": inputNumber(this.state.filter.minShareCount),
      "max-share": inputNumber(this.state.filter.maxShareCount),
      "min-duration": inputNumber(this.state.filter.minDurationSeconds),
      "max-duration": inputNumber(this.state.filter.maxDurationSeconds),
      "min-engagement": inputNumber(this.state.filter.minEngagementRate),
      "max-engagement": inputNumber(this.state.filter.maxEngagementRate),
      "date-from": inputDate(this.state.filter.createdFrom),
      "date-to": inputDate(this.state.filter.createdTo),
    };
    for (const [name, value] of Object.entries(values)) {
      const input = this.shadow?.querySelector<HTMLInputElement>(`[data-filter="${name}"]`);
      if (input) input.value = value;
    }
  }

  private applyFilterFromInputs(): void {
    const read = (name: string): string => this.shadow?.querySelector<HTMLInputElement>(`[data-filter="${name}"]`)?.value ?? "";
    this.setFilter({
      keyword: read("keyword"),
      adMode: this.state.filter.adMode,
      minPlayCount: parseOptionalNumber(read("min-play")),
      maxPlayCount: parseOptionalNumber(read("max-play")),
      minLikeCount: parseOptionalNumber(read("min-like")),
      maxLikeCount: parseOptionalNumber(read("max-like")),
      minCommentCount: parseOptionalNumber(read("min-comment")),
      maxCommentCount: parseOptionalNumber(read("max-comment")),
      minCollectCount: parseOptionalNumber(read("min-collect")),
      maxCollectCount: parseOptionalNumber(read("max-collect")),
      minShareCount: parseOptionalNumber(read("min-share")),
      maxShareCount: parseOptionalNumber(read("max-share")),
      minDurationSeconds: parseOptionalNumber(read("min-duration")),
      maxDurationSeconds: parseOptionalNumber(read("max-duration")),
      minEngagementRate: parseOptionalNumber(read("min-engagement")),
      maxEngagementRate: parseOptionalNumber(read("max-engagement")),
      createdFrom: parseDateBoundary(read("date-from"), false),
      createdTo: parseDateBoundary(read("date-to"), true),
    });
    this.setFilterPanelOpen(false);
  }

  private exportCurrentItems(): void {
    const csv = exportProfileVideosCsv(this.displayedItems);
    const fileName = `TikTok达人视频_${new Date().toISOString().slice(0, 10)}.csv`;
    if (this.options.onExport) {
      this.options.onExport(csv, fileName);
      return;
    }
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = this.doc.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.hidden = true;
    this.doc.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function sortValue(item: Readonly<ProfileVideoItem>, mode: ProfileSortMode): number | null {
  if (mode === "created_desc" || mode === "created_asc") return nonNegativeFinite(item.created_at);
  if (mode === "play_desc") return nonNegativeFinite(item.play_count);
  if (mode === "like_desc") return nonNegativeFinite(item.like_count);
  if (mode === "comment_desc") return nonNegativeFinite(item.comment_count);
  if (mode === "collect_desc") return nonNegativeFinite(item.collect_count);
  if (mode === "share_desc") return nonNegativeFinite(item.share_count);
  if (mode === "engagement_desc") return calculateEngagementRate(item);
  return null;
}

function matchesKeyword(item: Readonly<ProfileVideoItem>, keyword: string): boolean {
  if (!keyword) return true;
  return [item.video_id, item.author_unique_id, item.description]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLocaleLowerCase().includes(keyword));
}

function matchesAdMode(value: boolean | null, mode: ProfileAdMode): boolean {
  if (mode === "ad") return value === true;
  if (mode === "non_ad") return value === false;
  return true;
}

function passesRange(value: number | null, minimum: number | null, maximum: number | null): boolean {
  if (minimum === null && maximum === null) return true;
  if (value === null || !Number.isFinite(value)) return false;
  return (minimum === null || value >= minimum) && (maximum === null || value <= maximum);
}

function normalizeFilter(filter: Readonly<ProfileVideoFilter>): ProfileVideoFilter {
  return {
    keyword: filter.keyword.trim().slice(0, 200),
    adMode: asAdMode(filter.adMode),
    minPlayCount: nonNegativeOrNull(filter.minPlayCount),
    maxPlayCount: nonNegativeOrNull(filter.maxPlayCount),
    minLikeCount: nonNegativeOrNull(filter.minLikeCount),
    maxLikeCount: nonNegativeOrNull(filter.maxLikeCount),
    minCommentCount: nonNegativeOrNull(filter.minCommentCount),
    maxCommentCount: nonNegativeOrNull(filter.maxCommentCount),
    minCollectCount: nonNegativeOrNull(filter.minCollectCount),
    maxCollectCount: nonNegativeOrNull(filter.maxCollectCount),
    minShareCount: nonNegativeOrNull(filter.minShareCount),
    maxShareCount: nonNegativeOrNull(filter.maxShareCount),
    minDurationSeconds: nonNegativeOrNull(filter.minDurationSeconds),
    maxDurationSeconds: nonNegativeOrNull(filter.maxDurationSeconds),
    minEngagementRate: nonNegativeOrNull(filter.minEngagementRate),
    maxEngagementRate: nonNegativeOrNull(filter.maxEngagementRate),
    createdFrom: positiveOrNull(filter.createdFrom),
    createdTo: positiveOrNull(filter.createdTo),
  };
}

function nonNegativeFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseDateBoundary(value: string, endOfDay: boolean): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const suffix = endOfDay ? "T23:59:59.999" : "T00:00:00.000";
  const timestamp = new Date(`${value}${suffix}`).getTime();
  return Number.isNaN(timestamp) ? null : Math.floor(timestamp / 1000);
}

function inputNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

function inputDate(value: number | null): string {
  if (value === null) return "";
  const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatCsvDate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function csvNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "" : String(value);
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function asSortMode(value: string): ProfileSortMode {
  return value === "created_desc" || value === "created_asc" || value === "play_desc" ||
    value === "like_desc" || value === "comment_desc" || value === "collect_desc" ||
    value === "share_desc" || value === "engagement_desc"
    ? value
    : "default";
}

function asAdMode(value: string): ProfileAdMode {
  return value === "ad" || value === "non_ad" ? value : "all";
}

function rangeInput(
  minimumName: string,
  maximumName: string,
  label: string,
  type: "number" | "date",
  step = "1",
): string {
  const extra = type === "number" ? ` min="0" step="${step}"` : "";
  return `<div class="tda-range${type === "date" ? " tda-filter-wide" : ""}">
    <span class="tda-range-title">${label}</span>
    <input type="${type}" data-filter="${minimumName}" aria-label="${label}最小值" placeholder="最小"${extra}>
    <span class="tda-range-separator" aria-hidden="true">–</span>
    <input type="${type}" data-filter="${maximumName}" aria-label="${label}最大值" placeholder="最大"${extra}>
  </div>`;
}

function isFilterActive(filter: Readonly<ProfileVideoFilter>): boolean {
  return filter.keyword.length > 0 || filter.adMode !== "all" || Object.entries(filter).some(
    ([key, value]) => key !== "keyword" && key !== "adMode" && value !== null,
  );
}

function postIdsWithin(root: HTMLElement): Set<string> {
  const ids = new Set<string>();
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"], a[href*="/photo/"]')) {
    let pathname = anchor.getAttribute("href") ?? "";
    try {
      pathname = new URL(anchor.href, anchor.ownerDocument.baseURI).pathname;
    } catch {
      // 相对或尚未完整装载的链接仍会由下面的正则安全检查。
    }
    const matched = pathname.match(/\/(?:video|photo)\/(\d+)(?:\/|$)/);
    if (matched?.[1]) ids.add(matched[1]);
  }
  return ids;
}

function setStylePropertyIfChanged(
  element: HTMLElement,
  property: "display" | "order",
  value: string,
  priority: string,
): void {
  if (
    element.style.getPropertyValue(property) === value &&
    element.style.getPropertyPriority(property) === priority
  ) return;
  element.style.setProperty(property, value, priority);
}

/** 工具栏摘要可复用的紧凑数量文本。 */
export function formatProfileCount(value: number | null): string {
  return formatCount(value);
}
