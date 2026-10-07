import { formatCount, formatDateCompact, formatDuration, UNKNOWN_DISPLAY_VALUE } from "../ui/formatter";
import { iconSvg } from "../ui/icons";
import { createTokenStyleText } from "../ui/tokens";
import { calculateEngagementRate } from "./profileToolbar";
import { detectNativeMetricVisibility } from "./nativeMetricVisibility";
import type { CardMediaDownloadMode, CurrentMediaDescriptor } from "../types/messages";

const GRID_LABEL_SELECTOR = '[data-tiktok-daren-assistant="grid-card-label"]';
const LEGACY_OVERLAY_SELECTOR = '[data-tiktok-daren-assistant="video-overlay"]';
const POSITION_MARKER = "data-tiktok-daren-assistant-grid-position";
const MARGIN_MARKER = "data-tiktok-daren-assistant-grid-margin";
const OVERFLOW_MARKER = "data-tiktok-daren-assistant-grid-overflow";
const OVERFLOW_PRIORITY_MARKER = "data-tiktok-daren-assistant-grid-overflow-priority";

export interface GridVideoCardContext {
  cardRoot: HTMLElement;
  videoId: string | null;
  play_count: number | null;
  duration: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  collect_count?: number | null;
  share_count?: number | null;
  created_at?: number | null;
  publish_time_text?: string | null;
  description?: string | null;
  is_ad?: boolean | null;
  has_product?: boolean | null;
  /** 保留兼容旧调用方；常驻层不再显示无业务含义的“数据完整”图标。 */
  data_complete?: boolean;
  /** 调用方通过 IntersectionObserver 传入；false 的卡片不会注入或更新 UI。 */
  isNearViewport?: boolean;
  /** TikTok 页面已清楚显示时长时传 true，避免重复。 */
  nativeDurationVisible?: boolean;
  /** TikTok 页面已清楚显示播放量时传 true，避免重复。 */
  nativePlayVisible?: boolean;
  /** Exact descriptor for this card. Never resolved from the currently active/hovered post on click. */
  mediaDescriptor?: CurrentMediaDescriptor | null;
  batchSelectable?: boolean;
  batchSelected?: boolean;
}

export interface GridOverlayOptions {
  onDownload?: (
    media: CurrentMediaDescriptor,
    mode: CardMediaDownloadMode,
  ) => void | Promise<void>;
  onBatchSelectionChange?: (videoId: string, selected: boolean) => void;
}

interface GridLabelElements {
  host: HTMLElement;
  shadow: ShadowRoot;
}

/**
 * 网格卡片 UI 只消费调用方已经按 video_id 绑定好的值。所有已知指标常驻
 * 显示，不依赖 hover；未知值直接隐藏，避免用“--”占据视频画面。
 */
export class GridOverlayController {
  private readonly cardsByRoot = new Map<HTMLElement, GridVideoCardContext>();
  private hoveredVideoId: string | null = null;

  constructor(
    private readonly doc: Document = document,
    private readonly win: Window = window,
    private readonly options: GridOverlayOptions = {},
  ) {}

  render(cards: readonly GridVideoCardContext[]): number {
    this.hideLegacyOverlay();
    this.cardsByRoot.clear();

    for (const card of cards) {
      if (!card.cardRoot.isConnected || card.isNearViewport === false || this.cardsByRoot.has(card.cardRoot)) {
        continue;
      }
      this.cardsByRoot.set(card.cardRoot, card);
      this.updateLabel(this.ensureLabel(card.cardRoot), card);
    }

    for (const host of this.findAllLabels()) {
      const cardRoot = host.parentElement;
      if (cardRoot instanceof HTMLElement && this.cardsByRoot.has(cardRoot)) continue;
      this.removeLabel(host);
    }
    return this.countInstances();
  }

  setHoveredVideoId(videoId: string | null): void {
    this.hoveredVideoId = videoId;
    for (const [root, card] of this.cardsByRoot) {
      const host = directLabel(root);
      if (!host) continue;
      host.toggleAttribute("data-hovered", videoId !== null && card.videoId === videoId);
    }
  }

  /** 旧固定卡能力已移除，保留方法避免外部测试或调用方崩溃。 */
  isPinned(_videoId: string): boolean {
    return false;
  }

  clear(): void {
    for (const host of this.findAllLabels()) this.removeLabel(host);
    this.cardsByRoot.clear();
  }

  destroy(): void {
    this.clear();
  }

  countInstances(): number {
    return this.findAllLabels().length;
  }

  private ensureLabel(cardRoot: HTMLElement): GridLabelElements {
    const directLabels = Array.from(cardRoot.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.matches(GRID_LABEL_SELECTOR),
    );
    const host = directLabels.shift() ?? this.createHost(cardRoot);
    for (const duplicate of directLabels) duplicate.remove();

    if (!host.isConnected || host.parentElement !== cardRoot) cardRoot.append(host);
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    if (!shadow.querySelector(".tda-grid-layer")) this.renderShell(shadow);
    return { host, shadow };
  }

  private createHost(cardRoot: HTMLElement): HTMLElement {
    this.ensurePositionAnchor(cardRoot);
    const host = this.doc.createElement("span");
    host.setAttribute("data-tiktok-daren-assistant", "grid-card-label");
    host.style.cssText = [
      "position:absolute",
      "inset:0",
      "z-index:4",
      "pointer-events:none",
      "contain:layout style",
    ].join(";");
    cardRoot.append(host);
    return host;
  }

  private updateLabel(elements: GridLabelElements, card: GridVideoCardContext): void {
    const duration = normalisePositiveInteger(card.duration);
    const play = normaliseNonNegativeInteger(card.play_count);
    const like = normaliseNonNegativeInteger(card.like_count ?? null);
    const comment = normaliseNonNegativeInteger(card.comment_count ?? null);
    const collect = normaliseNonNegativeInteger(card.collect_count ?? null);
    const share = normaliseNonNegativeInteger(card.share_count ?? null);
    const engagementRate = calculateEngagementRate({
      play_count: play,
      like_count: like,
      comment_count: comment,
      collect_count: collect,
      share_count: share,
    });
    // 网格卡只展示绝对日期；相对时间不再兜底，避免跨天后持续显示旧文本。
    const date = formatDateCompact(card.created_at ?? null);
    const nativeVisibility = detectNativeMetricVisibility(card.cardRoot, this.win);
    const nativeDurationVisible = card.nativeDurationVisible ?? nativeVisibility.duration_seconds;
    const nativePlayVisible = card.nativePlayVisible ?? nativeVisibility.play_count;

    if (card.videoId) elements.host.dataset.tdaVideoId = card.videoId;
    else delete elements.host.dataset.tdaVideoId;
    elements.host.toggleAttribute(
      "data-hovered",
      this.hoveredVideoId !== null && card.videoId === this.hoveredVideoId,
    );
    elements.host.toggleAttribute("data-batch-selectable", card.batchSelectable === true);
    elements.host.toggleAttribute("data-batch-selected", card.batchSelectable === true && card.batchSelected !== false);
    const batchSelect = elements.shadow.querySelector<HTMLButtonElement>("[data-batch-select]");
    if (batchSelect) {
      const selected = card.batchSelected !== false;
      batchSelect.hidden = card.batchSelectable !== true || !card.videoId;
      batchSelect.setAttribute("aria-checked", String(selected));
      batchSelect.title = selected ? "取消选择这个视频" : "选择这个视频";
      batchSelect.setAttribute("aria-label", batchSelect.title);
    }
    const quickActions = elements.shadow.querySelector<HTMLElement>("[data-quick-actions]");
    if (quickActions) quickActions.hidden = !card.mediaDescriptor;
    const descriptionValue = formatTopicText(card.description);
    const description = elements.shadow.querySelector<HTMLElement>("[data-description]");
    if (description) {
      const descriptionText = description.querySelector<HTMLElement>("[data-description-text]");
      if (descriptionText) descriptionText.textContent = descriptionValue;
      description.hidden = descriptionValue.length === 0;
      description.title = descriptionValue ? "点击复制文案与话题" : "";
      description.setAttribute(
        "aria-label",
        descriptionValue ? `复制文案与话题：${descriptionValue}` : "复制文案与话题",
      );
      if (descriptionValue) description.dataset.copyText = descriptionValue;
      else delete description.dataset.copyText;
    }

    this.setChip(elements.shadow, "ad", "推广", card.is_ad === true);
    this.setChip(
      elements.shadow,
      "product",
      "带货",
      card.has_product === true && card.is_ad !== true,
    );
    this.setChip(elements.shadow, "duration", formatDuration(duration), duration !== null && !nativeDurationVisible);
    this.setChip(elements.shadow, "play", formatCount(play), play !== null && !nativePlayVisible);
    this.setChip(elements.shadow, "engagement", formatEngagementRate(engagementRate), engagementRate !== null);
    this.setChip(elements.shadow, "like", formatCount(like), like !== null);
    this.setChip(elements.shadow, "comment", formatCount(comment), comment !== null);
    this.setChip(elements.shadow, "collect", formatCount(collect), collect !== null && !nativeVisibility.collect_count);
    this.setChip(elements.shadow, "share", formatCount(share), share !== null);
    this.setChip(elements.shadow, "date", date, date !== UNKNOWN_DISPLAY_VALUE);

    const footer = elements.shadow.querySelector<HTMLElement>("[data-footer]");
    const footerMeta = elements.shadow.querySelector<HTMLElement>("[data-footer-meta]");
    const classificationVisible = card.is_ad === true || card.has_product === true;
    if (footerMeta) footerMeta.hidden = !classificationVisible && descriptionValue.length === 0;
    if (footer) {
      footer.hidden = !classificationVisible &&
        ![share, comment, like].some((value) => value !== null) &&
        descriptionValue.length === 0;
    }

    for (const zone of elements.shadow.querySelectorAll<HTMLElement>("[data-zone]")) {
      zone.hidden = !Array.from(zone.children).some(
        (child) => child instanceof HTMLElement && !child.hidden,
      );
    }
  }

  private setChip(shadow: ShadowRoot, key: string, value: string, visible: boolean): void {
    const chip = shadow.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (!chip) return;
    const show = visible && value !== UNKNOWN_DISPLAY_VALUE;
    const target = chip.querySelector<HTMLElement>("[data-value]");
    if (target) target.textContent = show ? value : "";
    chip.hidden = !show;
  }

  private renderShell(shadow: ShadowRoot): void {
    const style = this.doc.createElement("style");
    style.textContent = `
      ${createTokenStyleText()}
      :host { font-family: "Microsoft YaHei UI", system-ui, sans-serif; }
      [hidden] { display: none !important; }
      .tda-grid-layer { position: absolute; inset: 0; overflow: visible; pointer-events: none; font-variant-numeric: tabular-nums; }
      .tda-grid-zone { position: absolute; display: flex; gap: 4px; }
      .tda-grid-play { inset: 6px auto auto 6px; }
      :host([data-batch-selectable]) .tda-grid-play { top: 45px; }
      .tda-grid-batch-select {
        position: absolute; top: 7px; left: 7px; display: grid; width: 30px; height: 30px;
        place-items: center; box-sizing: border-box; padding: 0; border: 2px solid rgba(255,255,255,.96);
        border-radius: 8px; color: transparent; background: rgba(15,23,42,.58);
        box-shadow: 0 3px 12px rgba(15,23,42,.28); backdrop-filter: blur(8px);
        cursor: pointer; pointer-events: auto; transition: transform .14s ease, background .14s ease;
      }
      .tda-grid-batch-select svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 2.5; }
      :host([data-batch-selected]) .tda-grid-batch-select { color: #fff; border-color: #3b82f6; background: #2563eb; }
      .tda-grid-batch-select:hover { transform: scale(1.06); }
      .tda-grid-batch-select:focus-visible { outline: 3px solid rgba(59,130,246,.38); outline-offset: 2px; }
      .tda-grid-right { inset: 6px 6px auto auto; flex-direction: column; align-items: flex-end; }
      .tda-grid-actions { position: static; display: grid; width: 100%; min-width: 0; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); }
      .tda-grid-favorite { inset: auto auto 34px 7px; }
      .tda-grid-date { inset: 58px 6px auto auto; }
      .tda-grid-footer { position: absolute; top: calc(100% + 7px); right: 0; left: 0; min-width: 0; height: 70px; color: #16181d; pointer-events: none; }
      .tda-grid-footer-metrics {
        box-sizing: border-box; min-width: 0; min-height: 30px; overflow: hidden;
        border: 1px solid rgba(96,165,250,.62); border-radius: 7px; color: #1d4ed8;
        background: rgba(239,246,255,.86); box-shadow: 0 1px 3px rgba(37,99,235,.09);
      }
      .tda-grid-footer .tda-grid-chip {
        min-width: 0; min-height: 28px; justify-content: center; padding: 5px 4px; border: 0;
        border-radius: 0; color: #1d4ed8; background: transparent; box-shadow: none;
        backdrop-filter: none; font-size: 11.5px; font-weight: 700;
      }
      .tda-grid-footer .tda-grid-chip + .tda-grid-chip { border-left: 1px solid rgba(96,165,250,.32); }
      .tda-grid-footer-meta { display: flex; min-width: 0; align-items: flex-start; gap: 4px; margin-top: 5px; }
      .tda-grid-classification { display: flex; flex: 0 0 auto; gap: 3px; }
      .tda-grid-footer .tda-grid-classification .tda-grid-chip {
        min-height: 18px; flex: 0 0 auto; justify-content: center; padding: 1px 4px;
        border: 1px solid rgba(244,63,94,.38); border-radius: 4px; color: #b42318;
        background: rgba(255,241,243,.95); box-shadow: none; backdrop-filter: none;
        font-size: 10px; line-height: 14px;
      }
      .tda-grid-description {
        display: grid; width: auto; min-width: 0; flex: 1 1 auto; grid-template-columns: minmax(0, 1fr) auto;
        align-items: start; gap: 6px; box-sizing: border-box; margin: 0; padding: 1px 2px;
        border: 0; border-radius: 4px; color: #16181d; background: transparent; cursor: copy;
        font: inherit; font-size: 12px; font-weight: 500; line-height: 1.35; text-align: left;
        pointer-events: auto; user-select: text;
      }
      .tda-grid-description-text { display: -webkit-box; min-width: 0; overflow: hidden; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
      .tda-grid-description svg { width: 13px; height: 13px; margin-top: 1px; color: #667085; opacity: .68; }
      .tda-grid-description:hover { color: #1d4ed8; background: rgba(239,246,255,.68); }
      .tda-grid-description:focus-visible { outline: 2px solid #4b8cff; outline-offset: 2px; }
      .tda-grid-copy-feedback { display: none; color: #168a4b; font-size: 10px; font-weight: 700; white-space: nowrap; }
      .tda-grid-description[data-copy-state="success"] { color: #168a4b; }
      .tda-grid-description[data-copy-state="success"] svg { display: none; }
      .tda-grid-description[data-copy-state="success"] .tda-grid-copy-feedback { display: inline; }
      .tda-grid-description[data-copy-state="error"] { color: #b42318; }
      .tda-grid-quick-actions {
        position: absolute; top: 7px; right: 7px; display: none; align-items: center; gap: 6px;
        padding: 5px; border: 1px solid rgba(255,255,255,.34); border-radius: 999px;
        background: rgba(15,23,42,.66); box-shadow: 0 6px 18px rgba(15,23,42,.24);
        backdrop-filter: blur(10px) saturate(130%); pointer-events: auto;
      }
      :host([data-hovered]) .tda-grid-quick-actions:not([hidden]) { display: flex; }
      :host([data-hovered]) .tda-grid-right, :host([data-hovered]) .tda-grid-date { opacity: .56; }
      .tda-grid-download-action {
        display: grid; width: 32px; height: 32px; place-items: center; padding: 0; border: 0;
        border-radius: 50%; cursor: pointer; color: #fff; background: rgba(37,99,235,.96);
      }
      .tda-grid-download-action[data-action="audio_track"] { color: #2563eb; background: rgba(255,255,255,.96); }
      .tda-grid-download-action:hover { transform: translateY(-1px); filter: brightness(1.06); }
      .tda-grid-download-action:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
      .tda-grid-download-action:disabled { cursor: wait; opacity: .55; }
      .tda-grid-download-action[data-state="success"] { color: #fff; background: #168a4b; }
      .tda-grid-download-action[data-state="error"] { color: #fff; background: #d73545; }
      .tda-grid-chip {
        display: inline-flex; align-items: center; gap: 3px; min-height: 20px; box-sizing: border-box;
        max-width: calc(100vw - 12px); padding: 2px 5px; border: 1px solid rgba(96, 165, 250, .42);
        border-radius: 5px; color: #2563eb; background: rgba(239, 246, 255, .94);
        box-shadow: 0 1px 3px rgba(15, 23, 42, .2); backdrop-filter: blur(5px);
        font-size: 11px; font-weight: 700; line-height: 15px; white-space: nowrap;
      }
      .tda-grid-chip svg { width: 12px; height: 12px; flex: 0 0 auto; fill: none; stroke: currentColor;
        stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      .tda-grid-chip [data-value] { overflow: visible; text-overflow: clip; white-space: nowrap; }
      .tda-grid-chip[data-key="ad"], .tda-grid-chip[data-key="product"] {
        color: #b42318; border-color: rgba(244, 63, 94, .38); background: rgba(255, 241, 243, .95);
      }
      @media (prefers-color-scheme: dark) {
        .tda-grid-description { color: #f4f4f5; }
      }
    `;
    const layer = this.doc.createElement("span");
    layer.className = "tda-grid-layer";
    layer.innerHTML = `
      <span class="tda-grid-zone tda-grid-play" data-zone="play">
        ${chipMarkup("play", "播放量", iconSvg("play"))}
      </span>
      <button class="tda-grid-batch-select" type="button" role="checkbox" data-batch-select hidden>${iconSvg("check")}</button>
      <span class="tda-grid-zone tda-grid-right" data-zone="right">
        ${chipMarkup("engagement", "互动率", iconSvg("data"))}
        ${chipMarkup("duration", "视频时长", iconSvg("clock"))}
      </span>
      <span class="tda-grid-zone tda-grid-favorite" data-zone="favorite">
        ${chipMarkup("collect", "收藏量", iconSvg("bookmark"))}
      </span>
      <span class="tda-grid-zone tda-grid-date" data-zone="date">
        ${chipMarkup("date", "发布时间", iconSvg("calendar"))}
      </span>
      <span class="tda-grid-quick-actions" data-quick-actions hidden>
        <button class="tda-grid-download-action" type="button" data-action="video" title="下载无水印视频" aria-label="下载无水印视频">${iconSvg("video", { size: 16 })}</button>
        <button class="tda-grid-download-action" type="button" data-action="audio_track" title="提取音频" aria-label="提取音频">${iconSvg("music", { size: 16 })}</button>
      </span>
      <span class="tda-grid-footer" data-footer>
        <span class="tda-grid-footer-metrics tda-grid-actions" data-zone="actions">
          ${chipMarkup("share", "分享量", iconSvg("share"))}
          ${chipMarkup("comment", "评论量", iconSvg("comment"))}
          ${chipMarkup("like", "点赞量", iconSvg("heart"))}
        </span>
        <span class="tda-grid-footer-meta" data-footer-meta hidden>
          <span class="tda-grid-classification" data-zone="classification">
            ${chipMarkup("ad", "TikTok 结构化数据明确标记为广告或推广", "")}
            ${chipMarkup("product", "TikTok 公开数据包含商品或带货锚点", "")}
          </span>
          <button class="tda-grid-description" type="button" data-description data-copy-description hidden>
            <span class="tda-grid-description-text" data-description-text></span>
            ${iconSvg("copy", { size: 13 })}
            <span class="tda-grid-copy-feedback" data-copy-feedback aria-live="polite"></span>
          </button>
        </span>
      </span>
    `;
    layer.addEventListener("click", (event) => void this.handleQuickAction(event, shadow));
    shadow.append(style, layer);
  }

  private async handleQuickAction(event: Event, shadow: ShadowRoot): Promise<void> {
    const target = event.composedPath().find(
      (item): item is HTMLButtonElement =>
        item instanceof HTMLButtonElement && item.matches("[data-action], [data-copy-description], [data-batch-select]"),
    );
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    if (target.hasAttribute("data-batch-select")) {
      const root = shadow.host.parentElement;
      const card = root instanceof HTMLElement ? this.cardsByRoot.get(root) : undefined;
      if (!card?.videoId || !this.options.onBatchSelectionChange) return;
      const selected = target.getAttribute("aria-checked") !== "true";
      target.setAttribute("aria-checked", String(selected));
      target.title = selected ? "取消选择这个视频" : "选择这个视频";
      shadow.host.toggleAttribute("data-batch-selected", selected);
      this.options.onBatchSelectionChange(card.videoId, selected);
      return;
    }
    if (target.hasAttribute("data-copy-description")) {
      await this.copyDescription(target);
      return;
    }
    const mode = target.dataset.action;
    if (mode !== "video" && mode !== "audio_track") return;
    const root = shadow.host.parentElement;
    const card = root instanceof HTMLElement ? this.cardsByRoot.get(root) : undefined;
    if (!card?.mediaDescriptor || !this.options.onDownload) return;
    const buttons = Array.from(shadow.querySelectorAll<HTMLButtonElement>("[data-action]"));
    const originalTitle = target.title;
    for (const button of buttons) button.disabled = true;
    target.dataset.state = "loading";
    target.title = mode === "video" ? "正在准备视频" : "正在提取音频";
    try {
      await this.options.onDownload(card.mediaDescriptor, mode);
      target.dataset.state = "success";
      target.title = "已打开保存位置选择";
    } catch (error) {
      console.error(`[TikTok 达人助手] 卡片 ${card.mediaDescriptor.video_id} 下载转交失败`, error);
      target.dataset.state = "error";
      target.title = error instanceof Error ? error.message : "下载转交失败";
    } finally {
      this.win.setTimeout(() => {
        delete target.dataset.state;
        target.title = originalTitle;
        for (const button of buttons) button.disabled = false;
      }, 1_200);
    }
  }

  private async copyDescription(target: HTMLButtonElement): Promise<void> {
    const text = target.dataset.copyText?.trim() ?? "";
    if (!text) return;
    const originalTitle = target.title;
    const feedback = target.querySelector<HTMLElement>("[data-copy-feedback]");
    try {
      await this.win.navigator.clipboard.writeText(text);
      target.dataset.copyState = "success";
      target.title = "已复制文案与话题";
      if (feedback) feedback.textContent = "已复制";
    } catch (error) {
      console.error("[TikTok 达人助手] 复制卡片文案失败", error);
      target.dataset.copyState = "error";
      target.title = "复制失败，请重试";
      if (feedback) feedback.textContent = "复制失败";
    } finally {
      this.win.setTimeout(() => {
        delete target.dataset.copyState;
        target.title = originalTitle;
        if (feedback) feedback.textContent = "";
      }, 1_200);
    }
  }

  private ensurePositionAnchor(cardRoot: HTMLElement): void {
    const computedPosition = this.win.getComputedStyle(cardRoot).position;
    if (!computedPosition || computedPosition === "static") {
      if (!cardRoot.hasAttribute(POSITION_MARKER)) cardRoot.setAttribute(POSITION_MARKER, cardRoot.style.position);
      cardRoot.style.position = "relative";
    }
    if (!cardRoot.hasAttribute(MARGIN_MARKER)) {
      cardRoot.setAttribute(MARGIN_MARKER, cardRoot.style.marginBottom);
      const existing = Number.parseFloat(this.win.getComputedStyle(cardRoot).marginBottom) || 0;
      cardRoot.style.marginBottom = `${Math.max(existing, 84)}px`;
    }
    if (!cardRoot.hasAttribute(OVERFLOW_MARKER)) {
      cardRoot.setAttribute(OVERFLOW_MARKER, cardRoot.style.getPropertyValue("overflow"));
      cardRoot.setAttribute(
        OVERFLOW_PRIORITY_MARKER,
        cardRoot.style.getPropertyPriority("overflow"),
      );
      // TikTok 的网格项通常带 overflow:hidden；信息底栏位于媒体下方，必须允许
      // 该布局项向预留的行间空白绘制，否则只会看到一大片空白。
      cardRoot.style.setProperty("overflow", "visible", "important");
    }
  }

  private restorePositionAnchor(cardRoot: HTMLElement): void {
    if (cardRoot.hasAttribute(POSITION_MARKER)) {
      cardRoot.style.position = cardRoot.getAttribute(POSITION_MARKER) ?? "";
      cardRoot.removeAttribute(POSITION_MARKER);
    }
    if (cardRoot.hasAttribute(MARGIN_MARKER)) {
      cardRoot.style.marginBottom = cardRoot.getAttribute(MARGIN_MARKER) ?? "";
      cardRoot.removeAttribute(MARGIN_MARKER);
    }
    if (cardRoot.hasAttribute(OVERFLOW_MARKER)) {
      cardRoot.style.setProperty(
        "overflow",
        cardRoot.getAttribute(OVERFLOW_MARKER) ?? "",
        cardRoot.getAttribute(OVERFLOW_PRIORITY_MARKER) ?? "",
      );
      cardRoot.removeAttribute(OVERFLOW_MARKER);
      cardRoot.removeAttribute(OVERFLOW_PRIORITY_MARKER);
    }
  }

  private removeLabel(host: HTMLElement): void {
    const cardRoot = host.parentElement;
    host.remove();
    if (cardRoot instanceof HTMLElement && !Array.from(cardRoot.children).some(
      (child) => child instanceof HTMLElement && child.matches(GRID_LABEL_SELECTOR),
    )) this.restorePositionAnchor(cardRoot);
  }

  private hideLegacyOverlay(): void {
    for (const overlay of this.doc.querySelectorAll<HTMLElement>(LEGACY_OVERLAY_SELECTOR)) overlay.style.display = "none";
  }

  private findAllLabels(): HTMLElement[] {
    return Array.from(this.doc.querySelectorAll<HTMLElement>(GRID_LABEL_SELECTOR));
  }
}

function normaliseNonNegativeInteger(value: number | null): number | null {
  return value === null || !Number.isFinite(value) || value < 0 ? null : Math.round(value);
}

function normalisePositiveInteger(value: number | null): number | null {
  return value === null || !Number.isFinite(value) || value <= 0 ? null : Math.round(value);
}

function formatEngagementRate(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return UNKNOWN_DISPLAY_VALUE;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value)}%`;
}

export function formatTopicText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/#(?=[\p{L}\p{N}_])/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function chipMarkup(key: string, title: string, icon: string): string {
  return `<span class="tda-grid-chip" data-key="${key}" title="${title}" aria-label="${title}" hidden>${icon}<span data-value="${key}">--</span></span>`;
}

function directLabel(root: HTMLElement): HTMLElement | null {
  return Array.from(root.children).find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.matches(GRID_LABEL_SELECTOR),
  ) ?? null;
}
