import { ActiveVideoResolver, type ActiveMediaContext } from "./activeVideo";
import { parseMetricText } from "./value";
import type { FieldEvidence } from "../types/snapshot";

export type SurfaceMode =
  | "home_feed"
  | "video_detail"
  | "profile_grid"
  | "search_grid"
  | "hashtag_grid"
  | "music_grid"
  | "other";

export type GridSurfaceMode = Extract<
  SurfaceMode,
  "profile_grid" | "search_grid" | "hashtag_grid" | "music_grid"
>;

export interface HomeActiveVideoResolver {
  resolve(): ActiveMediaContext | null;
}

export interface CompositeVideoContext {
  surfaceMode: "video_detail";
  pageUrl: string;
  videoId: string;
  videoIdSource: "page_url";
  contentType: "video" | "photo";
  video: HTMLVideoElement | null;
  mediaRoot: HTMLElement | null;
  metadataRoot: HTMLElement | null;
  actionRoot: HTMLElement | null;
  pageRoot: HTMLElement | null;
}

export interface VideoCardContext {
  surfaceMode: GridSurfaceMode;
  contentType: "video" | "photo";
  cardRoot: HTMLElement;
  videoId: string;
  videoLink: HTMLAnchorElement;
  videoLinkPathname: string;
  playCount: FieldEvidence<number>;
  coverUrl: string | null;
  authorUniqueId: string | null;
  hoverVideo: HTMLVideoElement | null;
  durationSeconds: number | null;
  isHovered: boolean;
}

const GRID_LIST_SELECTOR = '[data-e2e="user-post-item-list"]';
const STRONG_CARD_SELECTOR = [
  '[data-e2e="user-post-item"]',
  '[data-e2e="search-card-video-container"]',
  '[data-e2e="video-card"]',
  '[data-e2e="music-video-item"]',
  '[data-e2e="challenge-video-item"]',
  '[data-e2e="photo-card"]',
  "article",
  "li",
].join(",");
const CARD_PAYLOAD_SELECTOR = '[data-e2e="video-views"], video, img';
const MEDIA_ROOT_SELECTOR = [
  '[data-e2e="browse-video"]',
  '[data-e2e="video-player"]',
  '[data-e2e="video-player-container"]',
  '[data-e2e="video-detail-video"]',
  '[data-e2e="photo-mode"]',
  '[data-e2e="photo-viewer"]',
  '[data-e2e="photo-slide"]',
].join(",");
const DETAIL_ROOT_SELECTOR = [
  '[data-e2e="browse-video-container"]',
  '[data-e2e="video-detail"]',
  '[data-e2e="video-detail-container"]',
  '[data-e2e="photo-detail"]',
  '[data-e2e="photo-detail-container"]',
  '[role="dialog"]',
].join(",");
const METADATA_SIGNAL_SELECTOR = [
  '[data-e2e="browse-username"]',
  '[data-e2e="browser-nickname"]',
  '[data-e2e="video-author-uniqueid"]',
  '[data-e2e="video-author-nickname"]',
  '[data-e2e="browse-video-desc"]',
  '[data-e2e="video-desc"]',
  '[data-e2e="video-publish-time"]',
  "time",
].join(",");
const ACTION_SIGNAL_SELECTOR = [
  '[data-e2e="browse-like-count"]',
  '[data-e2e="like-count"]',
  '[data-e2e="browse-comment-count"]',
  '[data-e2e="comment-count"]',
  '[data-e2e="browse-bookmark-count"]',
  '[data-e2e="bookmark-count"]',
  '[data-e2e="collect-count"]',
  '[data-e2e="favorite-count"]',
  '[data-e2e="browse-favorite-count"]',
  '[data-e2e="browse-collect-count"]',
  '[data-e2e="browse-share-count"]',
  '[data-e2e="share-count"]',
].join(",");

export function detectSurfaceMode(urlValue: string): SurfaceMode {
  let pathname: string;
  try {
    pathname = new URL(urlValue, "https://www.tiktok.com").pathname;
  } catch {
    return "other";
  }

  if (/^\/(?:@[^/]+\/)?(?:video|photo)\/\d+(?:\/|$)/.test(pathname)) return "video_detail";
  if (pathname === "/" || /^\/(?:foryou|following|friends|live)(?:\/|$)/.test(pathname)) {
    return "home_feed";
  }
  if (/^\/@[^/]+\/?$/.test(pathname)) return "profile_grid";
  if (/^\/search(?:\/|$)/.test(pathname)) return "search_grid";
  if (/^\/tag\/[^/]+/.test(pathname)) return "hashtag_grid";
  if (/^\/music\/[^/]+/.test(pathname)) return "music_grid";
  return "other";
}

/**
 * 首页继续复用已经带可见度评分的 resolver，但在边界处拒绝网格级根。
 * 调用方应复用同一个 resolver 实例，以保留 IntersectionObserver 状态。
 */
export function resolveHomeActiveVideo(resolver: HomeActiveVideoResolver): ActiveMediaContext | null {
  const context = resolver.resolve();
  if (!context) return null;
  if (context.activeRoot.matches(GRID_LIST_SELECTOR) || context.activeRoot.closest(GRID_LIST_SELECTOR)) {
    return null;
  }
  if (distinctPostIds(context.activeRoot).length > 1) return null;
  return context;
}

export function createHomeActiveVideoResolver(
  doc: Document = document,
  win: Window = window,
  onVisibilityChange: () => void = () => undefined,
): ActiveVideoResolver {
  return new ActiveVideoResolver(doc, win, onVisibilityChange);
}

export function resolveVideoDetailContext(
  pageUrl: string,
  doc: Document = document,
): CompositeVideoContext | null {
  const videoId = postIdFromUrl(pageUrl);
  if (!videoId) return null;

  const matchingLinks = postLinks(doc).filter((link) => postIdFromHref(link.href, doc.baseURI) === videoId);
  const postKind = postKindFromUrl(pageUrl) ?? "video";
  const video = postKind === "video" ? selectDetailVideo(doc, videoId, matchingLinks) : null;
  const pageRoot = video
    ? findDetailPageRoot(video, videoId, matchingLinks)
    : findNonVideoDetailPageRoot(doc, videoId, matchingLinks);
  const mediaRoot = video && pageRoot
    ? findMediaRoot(video, pageRoot)
    : pageRoot
      ? findPhotoMediaRoot(pageRoot, videoId)
      : null;
  const metadataSignals = pageRoot
    ? safeDetailSignals(pageRoot, METADATA_SIGNAL_SELECTOR, videoId, video)
    : [];
  const actionSignals = pageRoot
    ? safeDetailSignals(pageRoot, ACTION_SIGNAL_SELECTOR, videoId, video)
    : [];

  return {
    surfaceMode: "video_detail",
    pageUrl,
    videoId,
    videoIdSource: "page_url",
    contentType: postKind,
    video,
    mediaRoot,
    metadataRoot: commonScopedRoot(metadataSignals, pageRoot),
    actionRoot: commonScopedRoot(actionSignals, pageRoot),
    pageRoot,
  };
}

export function resolveVideoCards(
  doc: Document = document,
  surfaceMode: GridSurfaceMode = gridModeOrProfile(detectSurfaceMode(doc.location.href)),
): VideoCardContext[] {
  const result: VideoCardContext[] = [];
  const seenRoots = new Set<HTMLElement>();

  for (const link of postLinks(doc)) {
    const videoId = postIdFromHref(link.href, doc.baseURI);
    if (!videoId) continue;
    const cardRoot = findSingleCardRoot(link, videoId);
    if (!cardRoot || seenRoots.has(cardRoot)) continue;
    seenRoots.add(cardRoot);

    const exactLinks = postLinks(cardRoot).filter(
      (candidate) => postIdFromHref(candidate.href, doc.baseURI) === videoId,
    );
    if (exactLinks.length === 0 || distinctPostIds(cardRoot).length !== 1) continue;
    const mainLink = exactLinks.find((candidate) => candidate.contains(cardRoot.querySelector("video, img"))) ?? exactLinks[0];
    if (!mainLink) continue;

    const hoverVideo = cardRoot.querySelector<HTMLVideoElement>("video");
    const duration = hoverVideo?.duration;
    const authorUniqueId = authorFromPostHref(mainLink.href, doc.baseURI);
    const cover = cardRoot.querySelector<HTMLImageElement>("img");
    const playCount = extractCardPlayCount(cardRoot);

    result.push({
      surfaceMode,
      contentType: postKindFromHref(mainLink.href, doc.baseURI) ?? "video",
      cardRoot,
      videoId,
      videoLink: mainLink,
      videoLinkPathname: safePathname(mainLink.href, doc.baseURI),
      playCount,
      coverUrl: firstNonEmpty(cover?.currentSrc, cover?.src, hoverVideo?.poster),
      authorUniqueId,
      hoverVideo,
      durationSeconds: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null,
      isHovered: hasHoverState(cardRoot),
    });
  }

  return result;
}

export function resolveHoveredCard(
  cards: readonly VideoCardContext[],
  hoveredTarget: EventTarget | null = null,
): VideoCardContext | null {
  if (hoveredTarget instanceof Element) {
    const directlyTargeted = cards.filter(
      (card) => card.cardRoot === hoveredTarget || card.cardRoot.contains(hoveredTarget),
    );
    if (directlyTargeted.length === 1) return directlyTargeted[0] ?? null;
  }

  const explicitlyHovered = cards.filter((card) => hasHoverState(card.cardRoot));
  return explicitlyHovered.length === 1 ? explicitlyHovered[0] ?? null : null;
}

function findSingleCardRoot(link: HTMLAnchorElement, videoId: string): HTMLElement | null {
  const strong = link.closest<HTMLElement>(STRONG_CARD_SELECTOR);
  if (isValidSingleCardRoot(strong, videoId)) return strong;

  let current = link.parentElement;
  while (current && current !== link.ownerDocument.body && current !== link.ownerDocument.documentElement) {
    if (current.matches(GRID_LIST_SELECTOR)) break;
    const ids = distinctPostIds(current);
    if (ids.length > 1) break;
    if (ids.length === 1 && ids[0] === videoId && current.querySelector(CARD_PAYLOAD_SELECTOR)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function isValidSingleCardRoot(root: HTMLElement | null, videoId: string): root is HTMLElement {
  if (!root || root.matches(GRID_LIST_SELECTOR) || root.closest(GRID_LIST_SELECTOR) === root) return false;
  const ids = distinctPostIds(root);
  return ids.length === 1 && ids[0] === videoId && Boolean(root.querySelector(CARD_PAYLOAD_SELECTOR));
}

function extractCardPlayCount(cardRoot: HTMLElement): FieldEvidence<number> {
  const rawCandidates = Array.from(
    cardRoot.querySelectorAll<HTMLElement>('[data-e2e="video-views"]'),
  ).map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "");
  const accepted = rawCandidates
    .map((raw) => ({ raw, value: parseStrictViewCount(raw) }))
    .filter((item): item is { raw: string; value: number } => item.value !== null);
  const uniqueValues = [...new Set(accepted.map((item) => item.value))];

  if (uniqueValues.length === 1) {
    const match = accepted.find((item) => item.value === uniqueValues[0]);
    return {
      value: uniqueValues[0] ?? null,
      source: 'video_card_dom:[data-e2e="video-views"]',
      confidence: "high",
      raw_value: match?.raw ?? null,
    };
  }
  return {
    value: null,
    source: uniqueValues.length > 1 ? "video_card_dom:ambiguous" : "video_card_dom:unavailable",
    confidence: "low",
    raw_value: rawCandidates.length > 0 ? rawCandidates : null,
  };
}

function parseStrictViewCount(raw: string): number | null {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (
    !normalized ||
    /^0+$/.test(normalized) ||
    /[%：:]|全[螢屏]|觀看|观看|查看|vidiq/i.test(normalized) ||
    !/^\d+(?:[.,]\d+)?\s*(?:[KMB]|万|萬|亿|億)?$/i.test(normalized)
  ) {
    return null;
  }
  const parsed = parseMetricText(normalized);
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function selectDetailVideo(
  doc: Document,
  videoId: string,
  matchingLinks: readonly HTMLAnchorElement[],
): HTMLVideoElement | null {
  const linkedVideo = matchingLinks
    .map((link) => link.querySelector<HTMLVideoElement>("video"))
    .find((candidate): candidate is HTMLVideoElement => candidate !== null);
  if (linkedVideo) return linkedVideo;

  const attributed = Array.from(
    doc.querySelectorAll<HTMLElement>("[data-video-id], [data-item-id], [data-aweme-id]"),
  ).find((element) =>
    ["data-video-id", "data-item-id", "data-aweme-id"].some(
      (attribute) => element.getAttribute(attribute) === videoId,
    ),
  );
  const attributedVideo = attributed?.matches("video")
    ? (attributed as HTMLVideoElement)
    : attributed?.querySelector<HTMLVideoElement>("video");
  if (attributedVideo) return attributedVideo;

  const videos = Array.from(doc.querySelectorAll<HTMLVideoElement>("video")).filter(
    (candidate) => !isInsideForeignCard(candidate, doc.body, videoId),
  );
  if (videos.length === 1) return videos[0] ?? null;

  const detailShellVideos = Array.from(doc.querySelectorAll<HTMLElement>(DETAIL_ROOT_SELECTOR))
    .filter(
      (root) => root.querySelector(METADATA_SIGNAL_SELECTOR) || root.querySelector(ACTION_SIGNAL_SELECTOR),
    )
    .flatMap((root) =>
      Array.from(root.querySelectorAll<HTMLVideoElement>("video")).filter(
        (candidate) => !isInsideForeignCard(candidate, root, videoId),
      ),
    );
  const uniqueShellVideos = [...new Set(detailShellVideos)];
  if (uniqueShellVideos.length === 1) return uniqueShellVideos[0] ?? null;

  const detailContainer = matchingLinks
    .map((link) => link.closest<HTMLElement>(DETAIL_ROOT_SELECTOR))
    .find((candidate): candidate is HTMLElement => candidate !== null);
  if (detailContainer) {
    const contained = Array.from(detailContainer.querySelectorAll<HTMLVideoElement>("video")).filter(
      (candidate) => !isInsideForeignCard(candidate, detailContainer, videoId),
    );
    if (contained.length === 1) return contained[0] ?? null;
  }
  return selectMostLikelyDetailVideo(uniqueShellVideos.length > 0 ? uniqueShellVideos : videos);
}

function findDetailPageRoot(
  video: HTMLVideoElement,
  videoId: string,
  matchingLinks: readonly HTMLAnchorElement[],
): HTMLElement | null {
  const strong = video.closest<HTMLElement>(DETAIL_ROOT_SELECTOR);
  let fallbackStrong: HTMLElement | null = null;
  let current = video.parentElement;
  while (current && current !== video.ownerDocument.body && current !== video.ownerDocument.documentElement) {
    const metadataSignals = safeDetailSignals(current, METADATA_SIGNAL_SELECTOR, videoId, video);
    const actionSignals = safeDetailSignals(current, ACTION_SIGNAL_SELECTOR, videoId, video);
    if (metadataSignals.length > 0 && actionSignals.length > 0) {
      return current;
    }
    if (
      !fallbackStrong &&
      current.matches(DETAIL_ROOT_SELECTOR) &&
      (hasDetailAssociation(current, videoId, matchingLinks) ||
        metadataSignals.length > 0 ||
        actionSignals.length > 0)
    ) {
      fallbackStrong = current;
    }
    current = current.parentElement;
  }
  if (
    strong &&
    (hasDetailAssociation(strong, videoId, matchingLinks) ||
      strong.querySelector(METADATA_SIGNAL_SELECTOR) ||
      strong.querySelector(ACTION_SIGNAL_SELECTOR))
  ) {
    return fallbackStrong ?? strong;
  }
  return fallbackStrong ?? video.closest<HTMLElement>(MEDIA_ROOT_SELECTOR) ?? video.parentElement;
}

/** 图文详情没有 video 元素，改用 URL post_id、详情壳和元数据/动作信号组合页面根。 */
function findNonVideoDetailPageRoot(
  doc: Document,
  postId: string,
  matchingLinks: readonly HTMLAnchorElement[],
): HTMLElement | null {
  const attributed = Array.from(
    doc.querySelectorAll<HTMLElement>("[data-video-id], [data-item-id], [data-aweme-id], [data-post-id]"),
  ).find((element) => ["data-video-id", "data-item-id", "data-aweme-id", "data-post-id"]
    .some((attribute) => element.getAttribute(attribute) === postId));

  const startingPoints = [attributed, ...matchingLinks]
    .filter((element): element is HTMLElement => element instanceof HTMLElement);
  let strongFallback: HTMLElement | null = null;
  for (const startingPoint of startingPoints) {
    let current: HTMLElement | null = startingPoint;
    while (current && current !== doc.body && current !== doc.documentElement) {
      const metadata = safeDetailSignals(current, METADATA_SIGNAL_SELECTOR, postId, null);
      const actions = safeDetailSignals(current, ACTION_SIGNAL_SELECTOR, postId, null);
      if (metadata.length > 0 && actions.length > 0) return current;
      if (!strongFallback && current.matches(DETAIL_ROOT_SELECTOR)) strongFallback = current;
      current = current.parentElement;
    }
  }
  if (strongFallback) return strongFallback;

  const detailRoots = Array.from(doc.querySelectorAll<HTMLElement>(DETAIL_ROOT_SELECTOR));
  const associated = detailRoots.filter((root) => hasDetailAssociation(root, postId, matchingLinks));
  if (associated.length === 1) return associated[0] ?? null;
  const signalled = detailRoots.filter((root) =>
    safeDetailSignals(root, METADATA_SIGNAL_SELECTOR, postId, null).length > 0 &&
    safeDetailSignals(root, ACTION_SIGNAL_SELECTOR, postId, null).length > 0,
  );
  return signalled.length === 1 ? signalled[0] ?? null : null;
}

function findPhotoMediaRoot(pageRoot: HTMLElement, postId: string): HTMLElement | null {
  const strong = Array.from(pageRoot.querySelectorAll<HTMLElement>(MEDIA_ROOT_SELECTOR))
    .find((candidate) => !isInsideForeignCard(candidate, pageRoot, postId));
  if (strong) return strong;
  const image = Array.from(pageRoot.querySelectorAll<HTMLImageElement>("img"))
    .find((candidate) => !isInsideForeignCard(candidate, pageRoot, postId));
  return image?.parentElement ?? image ?? null;
}

function selectMostLikelyDetailVideo(videos: readonly HTMLVideoElement[]): HTMLVideoElement | null {
  const ranked = videos
    .map((video) => {
      const rect = video.getBoundingClientRect();
      const area = Math.max(0, rect.width * rect.height);
      const viewportWidth = video.ownerDocument.defaultView?.innerWidth ?? 0;
      const viewportHeight = video.ownerDocument.defaultView?.innerHeight ?? 0;
      const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
      const visibleArea = visibleWidth * visibleHeight;
      return {
        video,
        score: visibleArea + area * 0.1 + (!video.paused ? 1_000_000_000 : 0),
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!ranked[0]) return null;
  if (ranked[1] && ranked[1].score === ranked[0].score) return null;
  return ranked[0].video;
}

function hasDetailAssociation(
  root: HTMLElement,
  videoId: string,
  matchingLinks: readonly HTMLAnchorElement[],
): boolean {
  if (matchingLinks.some((link) => root.contains(link))) return true;
  return ["data-video-id", "data-item-id", "data-aweme-id"].some(
    (attribute) => root.getAttribute(attribute) === videoId,
  );
}

function findMediaRoot(video: HTMLVideoElement, pageRoot: HTMLElement): HTMLElement {
  const strong = video.closest<HTMLElement>(MEDIA_ROOT_SELECTOR);
  if (strong && pageRoot.contains(strong)) return strong;
  let current = video.parentElement;
  let last = video as HTMLElement;
  while (current && current !== pageRoot) {
    if (current.querySelector(METADATA_SIGNAL_SELECTOR) || current.querySelector(ACTION_SIGNAL_SELECTOR)) break;
    last = current;
    current = current.parentElement;
  }
  return last;
}

function safeDetailSignals(
  pageRoot: HTMLElement,
  selector: string,
  videoId: string,
  selectedVideo: HTMLVideoElement | null,
): HTMLElement[] {
  return Array.from(pageRoot.querySelectorAll<HTMLElement>(selector)).filter((element) => {
    if (selectedVideo && element === selectedVideo) return true;
    return !isInsideForeignCard(element, pageRoot, videoId);
  });
}

function isInsideForeignCard(element: Element, boundary: HTMLElement, videoId: string): boolean {
  let current: HTMLElement | null = element instanceof HTMLElement ? element : element.parentElement;
  while (current && current !== boundary) {
    if (current.matches(STRONG_CARD_SELECTOR)) {
      const ids = distinctPostIds(current);
      if (ids.length === 1 && ids[0] !== videoId) return true;
    }
    current = current.parentElement;
  }
  return false;
}

function commonScopedRoot(elements: readonly HTMLElement[], boundary: HTMLElement | null): HTMLElement | null {
  if (!boundary || elements.length === 0) return null;
  let current: HTMLElement | null = elements[0] ?? null;
  while (current && boundary.contains(current)) {
    if (elements.every((element) => current?.contains(element))) return current;
    if (current === boundary) break;
    current = current.parentElement;
  }
  return null;
}

function distinctPostIds(root: ParentNode): string[] {
  const ids = postLinks(root)
    .map((link) => postIdFromHref(link.href, link.ownerDocument.baseURI))
    .filter((id): id is string => id !== null);
  return [...new Set(ids)];
}

function postLinks(root: ParentNode): HTMLAnchorElement[] {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"], a[href*="/photo/"]'));
}

function postIdFromUrl(urlValue: string): string | null {
  try {
    return new URL(urlValue, "https://www.tiktok.com").pathname.match(/\/(?:video|photo)\/(\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function postIdFromHref(href: string, baseUri: string): string | null {
  try {
    return new URL(href, baseUri).pathname.match(/\/(?:video|photo)\/(\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function authorFromPostHref(href: string, baseUri: string): string | null {
  try {
    return new URL(href, baseUri).pathname.match(/^\/@([^/]+)\/(?:video|photo)\/\d+/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function postKindFromUrl(urlValue: string): "video" | "photo" | null {
  try {
    const match = new URL(urlValue, "https://www.tiktok.com").pathname.match(/\/(video|photo)\/\d+/);
    return match?.[1] === "photo" ? "photo" : match?.[1] === "video" ? "video" : null;
  } catch {
    return null;
  }
}

function postKindFromHref(href: string, baseUri: string): "video" | "photo" | null {
  try {
    const match = new URL(href, baseUri).pathname.match(/\/(video|photo)\/\d+/);
    return match?.[1] === "photo" ? "photo" : match?.[1] === "video" ? "video" : null;
  } catch {
    return null;
  }
}

function safePathname(href: string, baseUri: string): string {
  try {
    return new URL(href, baseUri).pathname;
  } catch {
    return "";
  }
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  return values.find((value): value is string => Boolean(value?.trim())) ?? null;
}

function hasHoverState(root: HTMLElement): boolean {
  if (root.dataset.hovered === "true" || root.getAttribute("aria-current") === "true") return true;
  try {
    return root.matches(":hover");
  } catch {
    return false;
  }
}

function gridModeOrProfile(mode: SurfaceMode): GridSurfaceMode {
  return mode === "profile_grid" ||
    mode === "search_grid" ||
    mode === "hashtag_grid" ||
    mode === "music_grid"
    ? mode
    : "profile_grid";
}
