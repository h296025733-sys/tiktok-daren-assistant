import type { OverlayField } from "../ui/settings";

export type NativeMetricVisibility = Record<OverlayField, boolean>;

const EMPTY_VISIBILITY: NativeMetricVisibility = {
  play_count: false,
  like_count: false,
  comment_count: false,
  collect_count: false,
  share_count: false,
  duration_seconds: false,
  publish_time: false,
};

const SELECTORS: Record<OverlayField, readonly string[]> = {
  play_count: [
    '[data-e2e="video-views"]',
    '[data-e2e="video-card-views"]',
    '[data-e2e="browse-video-views"]',
  ],
  like_count: [
    '[data-e2e="browse-like-count"]',
    '[data-e2e="like-count"]',
    '[data-e2e="like-icon"]',
    'button[aria-label*="like" i]',
    'button[aria-label*="点赞"]',
    'button[aria-label*="讚"]',
  ],
  comment_count: [
    '[data-e2e="browse-comment-count"]',
    '[data-e2e="comment-count"]',
    '[data-e2e="comment-icon"]',
    'button[aria-label*="comment" i]',
    'button[aria-label*="评论"]',
    'button[aria-label*="評論"]',
  ],
  collect_count: [
    '[data-e2e="browse-bookmark-count"]',
    '[data-e2e="bookmark-count"]',
    '[data-e2e="collect-count"]',
    '[data-e2e="favorite-count"]',
    '[data-e2e="browse-favorite-count"]',
    '[data-e2e="browse-collect-count"]',
    '[data-e2e="favorite-icon"]',
    'button[aria-label*="bookmark" i]',
    'button[aria-label*="favorite" i]',
    'button[aria-label*="收藏"]',
  ],
  share_count: [
    '[data-e2e="browse-share-count"]',
    '[data-e2e="share-count"]',
    '[data-e2e="share-icon"]',
    'button[aria-label*="share" i]',
    'button[aria-label*="分享"]',
  ],
  duration_seconds: [
    '[data-e2e="video-duration"]',
    '[data-e2e="video-card-duration"]',
    '[data-e2e="video-time"]',
  ],
  publish_time: [
    '[data-e2e="browser-video-time"]',
    '[data-e2e="browse-video-time"]',
    '[data-e2e="video-publish-time"]',
    '[data-e2e*="publish-time"]',
    "time",
  ],
};

/**
 * 只在当前 TikTok 业务容器内判断“原页面是否已经清楚展示该字段”。
 * 插件自身节点一律排除；不可见、无文本/语义的占位节点不算已展示。
 */
export function detectNativeMetricVisibility(
  root: HTMLElement | null | undefined,
  win: Window = window,
): NativeMetricVisibility {
  if (!root?.isConnected) return { ...EMPTY_VISIBILITY };

  return Object.fromEntries(
    (Object.keys(SELECTORS) as OverlayField[]).map((field) => [
      field,
      SELECTORS[field].some((selector) =>
        queryIncludingRoot(root, selector).some((element) => isClearNativeSignal(element, root, win)),
      ),
    ]),
  ) as NativeMetricVisibility;
}

function queryIncludingRoot(root: HTMLElement, selector: string): HTMLElement[] {
  const descendants = Array.from(root.querySelectorAll<HTMLElement>(selector));
  return root.matches(selector) ? [root, ...descendants] : descendants;
}

function isClearNativeSignal(element: HTMLElement, root: HTMLElement, win: Window): boolean {
  if (element.closest('[data-tiktok-daren-assistant]')) return false;
  let current: HTMLElement | null = element;
  while (current) {
    const style = win.getComputedStyle(current);
    if (
      current.hidden ||
      current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      (style.opacity !== "" && Number(style.opacity) === 0)
    ) {
      return false;
    }
    if (current === root) break;
    current = current.parentElement;
  }

  const semanticText = [
    element.textContent,
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return semanticText.length > 0;
}
