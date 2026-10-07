interface ActiveMediaContextBase {
  activeRoot: HTMLElement;
  mediaElement: HTMLElement;
  contentType: "video" | "photo";
  videoId: string | null;
  videoIdSource: string | null;
  permalink: string | null;
  authorUniqueId: string | null;
  visibleRatio: number;
  score: number;
  candidateCount: number;
  rootSignature: string;
  identity: string;
}

export interface ActiveVideoContext extends ActiveMediaContextBase {
  video: HTMLVideoElement;
  mediaElement: HTMLVideoElement;
  contentType: "video";
}

export interface ActivePhotoContext extends ActiveMediaContextBase {
  video: null;
  mediaElement: HTMLElement;
  contentType: "photo";
}

export type ActiveMediaContext = ActiveVideoContext | ActivePhotoContext;

interface Candidate {
  video: HTMLVideoElement;
  root: HTMLElement;
  visibleRatio: number;
  score: number;
}

interface PhotoCandidate {
  mediaElement: HTMLElement;
  root: HTMLElement;
  visibleRatio: number;
  score: number;
}

const FEED_ROOT_SELECTOR = [
  '[data-e2e="recommend-list-item-container"]',
  '[data-e2e="feed-item"]',
  '[data-e2e="video-card"]',
  "article",
].join(",");

const METRIC_SIGNAL_SELECTOR = [
  '[data-e2e="video-views"]',
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

export class ActiveVideoResolver {
  private readonly ratios = new WeakMap<HTMLVideoElement, number>();
  private readonly observed = new Set<HTMLVideoElement>();
  private readonly generatedIds = new WeakMap<HTMLElement, number>();
  private readonly revisions = new WeakMap<HTMLElement, number>();
  private generatedSequence = 0;
  private readonly intersectionObserver: IntersectionObserver | null;

  constructor(
    private readonly doc: Document = document,
    private readonly win: Window = window,
    onVisibilityChange: () => void = () => undefined,
  ) {
    const Observer = (
      this.win as unknown as { IntersectionObserver?: typeof IntersectionObserver }
    ).IntersectionObserver;
    this.intersectionObserver = Observer
      ? new Observer(
          (entries: IntersectionObserverEntry[]) => {
            let materiallyChanged = false;
            for (const entry of entries) {
              if (entry.target.tagName !== "VIDEO") continue;
              const video = entry.target as HTMLVideoElement;
              const previous = this.ratios.get(video) ?? -1;
              const next = entry.isIntersecting ? entry.intersectionRatio : 0;
              this.ratios.set(video, next);
              if (Math.abs(previous - next) >= 0.05) materiallyChanged = true;
            }
            if (materiallyChanged) onVisibilityChange();
          },
          { threshold: [0, 0.1, 0.25, 0.5, 0.7, 0.85, 1] },
        )
      : null;
  }

  setVisibilityRatio(video: HTMLVideoElement, ratio: number): void {
    this.ratios.set(video, Math.max(0, Math.min(1, ratio)));
  }

  resolve(): ActiveMediaContext | null {
    const videos = Array.from(this.doc.querySelectorAll<HTMLVideoElement>("video"));
    this.syncObserved(videos);
    let candidates = videos
      .map((video) => this.scoreCandidate(video))
      .filter((candidate): candidate is Candidate => candidate !== null)
      .sort((left, right) => right.score - left.score);
    const dialogCandidates = candidates.filter((candidate) => candidate.video.closest('[role="dialog"]'));
    if (dialogCandidates.length > 0) {
      const topDialog = [...new Set(
        dialogCandidates
          .map((candidate) => candidate.video.closest<HTMLElement>('[role="dialog"]'))
          .filter((dialog): dialog is HTMLElement => dialog !== null),
      )].sort((left, right) => foregroundLayerRank(right, this.win) - foregroundLayerRank(left, this.win))[0];
      if (topDialog) candidates = dialogCandidates.filter((candidate) => topDialog.contains(candidate.video));
    }
    const active = candidates[0];
    if (!active) return this.resolvePhotoPost();

    const idResult = this.resolveVideoId(active.video, active.root);
    const contentFingerprint = buildContentFingerprint(active.video, active.root, this.doc.baseURI);
    const mediaFingerprint = buildMediaFingerprint(active.video, this.doc.baseURI);
    if (!this.generatedIds.has(active.video)) {
      this.generatedIds.set(active.video, ++this.generatedSequence);
    }
    const fallbackId = this.generatedIds.get(active.video) ?? 0;

    return {
      video: active.video,
      mediaElement: active.video,
      contentType: "video",
      activeRoot: active.root,
      videoId: idResult.id,
      videoIdSource: idResult.source,
      permalink: idResult.permalink,
      authorUniqueId: idResult.authorUniqueId,
      visibleRatio: active.visibleRatio,
      score: active.score,
      candidateCount: videos.length,
      rootSignature: describeRoot(active.root),
      identity: idResult.id
        ? `video:${idResult.id}:${hashString(mediaFingerprint || `element:${fallbackId}`)}:${this.revisions.get(active.video) ?? 0}`
        : `provisional:${hashString(contentFingerprint || `element:${fallbackId}`)}:${this.revisions.get(active.video) ?? 0}`,
    };
  }

  bumpRevision(video: HTMLVideoElement): void {
    this.revisions.set(video, (this.revisions.get(video) ?? 0) + 1);
  }

  private resolvePhotoPost(): ActivePhotoContext | null {
    const candidates = Array.from(
      this.doc.querySelectorAll<HTMLElement>(
        '[data-e2e="recommend-list-item-container"], [data-e2e="feed-item"], [data-e2e="browse-photo"], [class*="DivPhotoWrapper"], article',
      ),
    )
      .map((root) => scorePhotoCandidate(root, this.win))
      .filter((candidate): candidate is PhotoCandidate => candidate !== null)
      .sort((left, right) => right.score - left.score);
    const active = candidates[0];
    if (!active) return null;

    const idResult = resolveMediaId(active.mediaElement, active.root, this.win.location.href, this.doc.baseURI);
    const fingerprint = buildPhotoFingerprint(active.mediaElement, active.root, this.doc.baseURI);
    if (!this.generatedIds.has(active.mediaElement)) {
      this.generatedIds.set(active.mediaElement, ++this.generatedSequence);
    }
    const fallbackId = this.generatedIds.get(active.mediaElement) ?? 0;
    const revision = this.revisions.get(active.mediaElement) ?? 0;
    return {
      video: null,
      mediaElement: active.mediaElement,
      contentType: "photo",
      activeRoot: active.root,
      videoId: idResult.id,
      videoIdSource: idResult.source,
      permalink: idResult.permalink,
      authorUniqueId: idResult.authorUniqueId,
      visibleRatio: active.visibleRatio,
      score: active.score,
      candidateCount: candidates.length,
      rootSignature: describeRoot(active.root),
      identity: idResult.id
        ? `photo:${idResult.id}:${hashString(fingerprint || `element:${fallbackId}`)}:${revision}`
        : `photo-provisional:${hashString(fingerprint || `element:${fallbackId}`)}:${revision}`,
    };
  }

  disconnect(): void {
    this.intersectionObserver?.disconnect();
    this.observed.clear();
  }

  private syncObserved(videos: HTMLVideoElement[]): void {
    if (!this.intersectionObserver) return;
    const current = new Set(videos);
    for (const video of videos) {
      if (!this.observed.has(video)) {
        this.observed.add(video);
        this.intersectionObserver.observe(video);
      }
    }
    for (const video of this.observed) {
      if (!current.has(video) || !video.isConnected) {
        this.intersectionObserver.unobserve(video);
        this.observed.delete(video);
      }
    }
  }

  private scoreCandidate(video: HTMLVideoElement): Candidate | null {
    if (!isVisibleThroughAncestors(video, this.win)) return null;
    const rect = video.getBoundingClientRect();
    if (rect.width < 48 || rect.height < 48 || rect.width * rect.height < 4_096) return null;

    const geometryRatio = viewportIntersectionRatio(rect, this.win.innerWidth, this.win.innerHeight);
    const visibleRatio = this.ratios.get(video) ?? geometryRatio;
    if (visibleRatio <= 0 || geometryRatio <= 0) return null;

    const viewportCenterX = this.win.innerWidth / 2;
    const viewportCenterY = this.win.innerHeight / 2;
    const videoCenterX = rect.left + rect.width / 2;
    const videoCenterY = rect.top + rect.height / 2;
    const normalizedDistance = Math.min(
      1,
      Math.hypot(videoCenterX - viewportCenterX, videoCenterY - viewportCenterY) /
        Math.max(1, Math.hypot(viewportCenterX, viewportCenterY)),
    );
    const centerScore = 1 - normalizedDistance;
    const viewportArea = Math.max(1, this.win.innerWidth * this.win.innerHeight);
    const areaScore = Math.min(1, (rect.width * rect.height) / viewportArea);
    const playingScore = safeBoolean(() => !video.paused) ? 18 : 0;
    const readyScore = safeNumber(() => video.readyState) >= 2 ? 7 : 0;
    const foregroundScore = foregroundBonus(video, this.win);
    const root = findBusinessRoot(video, this.win);

    return {
      video,
      root,
      visibleRatio,
      score:
        visibleRatio * 52 + centerScore * 20 + areaScore * 10 + playingScore + readyScore + foregroundScore,
    };
  }

  private resolveVideoId(
    video: HTMLVideoElement,
    root: HTMLElement,
  ): {
    id: string | null;
    source: string | null;
    permalink: string | null;
    authorUniqueId: string | null;
  } {
    const directLink = video.closest<HTMLAnchorElement>('a[href*="/video/"]');
    const directId = videoIdFromHref(directLink?.href);
    if (directId) return linkResult(directLink, directId, "active_root:video_link");

    const scopedLinks = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]'));
    const urlVideoId = videoIdFromHref(this.win.location.href);
    const matchingUrlLink = urlVideoId
      ? scopedLinks.find((link) => videoIdFromHref(link.href) === urlVideoId)
      : undefined;
    if (matchingUrlLink && urlVideoId) {
      return linkResult(matchingUrlLink, urlVideoId, "active_root:current_url_video_link");
    }
    if (scopedLinks.length === 1) {
      const onlyId = videoIdFromHref(scopedLinks[0]?.href);
      if (onlyId) return linkResult(scopedLinks[0] ?? null, onlyId, "active_root:scoped_video_link");
    }
    const rankedLinks = scopedLinks
      .map((link) => ({ link, score: scoreScopedLink(link, video, this.win) }))
      .sort((left, right) => right.score - left.score);
    const bestLink = rankedLinks[0];
    const nextLink = rankedLinks[1];
    const linkId = videoIdFromHref(bestLink?.link.href);
    if (linkId && bestLink && bestLink.score >= 20 && (!nextLink || bestLink.score > nextLink.score)) {
      return linkResult(bestLink.link, linkId, "active_root:scoped_video_link");
    }

    const dataElements: Element[] = [video];
    let ancestor: HTMLElement | null = video.parentElement;
    while (ancestor) {
      dataElements.push(ancestor);
      if (ancestor === root) break;
      ancestor = ancestor.parentElement;
    }
    if (!dataElements.includes(root)) dataElements.push(root);
    const attributes = ["data-video-id", "data-item-id", "data-aweme-id"];
    for (const element of dataElements) {
      for (const attribute of attributes) {
        const value = element.getAttribute(attribute)?.trim();
        if (value && /^\d{10,}$/.test(value)) {
          return {
            id: value,
            source: `active_root:${attribute}`,
            permalink: null,
            authorUniqueId: null,
          };
        }
      }
    }

    // TikTok 推荐流的 video_id 有时挂在媒体节点的兄弟元素上，而不是 video
    // 的祖先链。仅当当前业务根内强 ID 唯一时才采用；多个 ID 时宁可留空。
    const scopedDataIds = new Map<string, string>();
    for (const element of root.querySelectorAll<HTMLElement>(
      '[data-video-id], [data-item-id], [data-aweme-id]',
    )) {
      for (const attribute of attributes) {
        const value = element.getAttribute(attribute)?.trim();
        if (value && /^\d{10,}$/.test(value)) scopedDataIds.set(value, attribute);
      }
    }
    if (scopedDataIds.size === 1) {
      const [id, attribute] = [...scopedDataIds.entries()][0]!;
      return {
        id,
        source: `active_root:unique_scoped_${attribute}`,
        permalink: null,
        authorUniqueId: null,
      };
    }
    return { id: null, source: null, permalink: null, authorUniqueId: null };
  }
}

function findBusinessRoot(video: HTMLVideoElement, win: Window): HTMLElement {
  const feedRoot = video.closest<HTMLElement>(FEED_ROOT_SELECTOR);
  const ownerDocument = video.ownerDocument;
  if (
    feedRoot &&
    feedRoot !== ownerDocument.body &&
    feedRoot !== ownerDocument.documentElement &&
    !containsOtherVisibleVideo(feedRoot, video, win)
  ) {
    return feedRoot;
  }

  let current = video.parentElement;
  let lastSingleVideoRoot: HTMLElement = video;
  for (let depth = 0; current && depth < 12; depth += 1) {
    if (current === ownerDocument.body || current === ownerDocument.documentElement) break;
    if (containsOtherVisibleVideo(current, video, win)) return lastSingleVideoRoot;
    lastSingleVideoRoot = current;
    const metricCount = current.querySelectorAll(METRIC_SIGNAL_SELECTOR).length;
    const semanticActions = current.querySelectorAll('button[aria-label], [role="button"][aria-label]').length;
    const scopedVideoCount = current.querySelectorAll("video").length;
    if (
      metricCount >= 2 ||
      (metricCount >= 1 && semanticActions >= 2) ||
      (semanticActions >= 3 && scopedVideoCount <= 2)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return video.closest<HTMLElement>('[data-e2e="browse-video"]') ?? lastSingleVideoRoot;
}

function scorePhotoCandidate(root: HTMLElement, win: Window): PhotoCandidate | null {
  if (!isVisibleThroughAncestors(root, win)) return null;
  if (Array.from(root.querySelectorAll<HTMLVideoElement>("video")).some((video) => {
    if (!isVisibleThroughAncestors(video, win)) return false;
    const rect = video.getBoundingClientRect();
    return viewportIntersectionRatio(rect, win.innerWidth, win.innerHeight) > 0.05;
  })) return null;

  const mediaCandidates = Array.from(
    root.querySelectorAll<HTMLElement>('[data-e2e*="photo"], [class*="DivPhotoWrapper"], img'),
  )
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const ratio = viewportIntersectionRatio(rect, win.innerWidth, win.innerHeight);
      return { element, rect, ratio, visibleArea: rect.width * rect.height * ratio };
    })
    .filter(({ element, rect, ratio }) =>
      ratio > 0 && rect.width >= 96 && rect.height >= 96 && isVisibleThroughAncestors(element, win),
    )
    .sort((left, right) => right.visibleArea - left.visibleArea);
  const media = mediaCandidates[0];
  if (!media) return null;

  const photoSpecific = Boolean(
    root.matches('[data-e2e*="photo"], [class*="DivPhotoWrapper"]') ||
    root.querySelector('[data-e2e*="photo"], [class*="DivPhotoWrapper"]'),
  );
  const imageCount = root.querySelectorAll("img").length;
  const actionCount = root.querySelectorAll(METRIC_SIGNAL_SELECTOR).length;
  const currentRouteIsPhoto = /\/@[^/]+\/photo\/\d+/.test(win.location.pathname);
  if (!photoSpecific && !(imageCount >= 2 && actionCount >= 2) && !currentRouteIsPhoto) return null;

  const rootRect = root.getBoundingClientRect();
  const rootVisibleRatio = viewportIntersectionRatio(rootRect, win.innerWidth, win.innerHeight);
  if (rootVisibleRatio <= 0) return null;
  const viewportCenterX = win.innerWidth / 2;
  const viewportCenterY = win.innerHeight / 2;
  const mediaCenterX = media.rect.left + media.rect.width / 2;
  const mediaCenterY = media.rect.top + media.rect.height / 2;
  const normalizedDistance = Math.min(
    1,
    Math.hypot(mediaCenterX - viewportCenterX, mediaCenterY - viewportCenterY) /
      Math.max(1, Math.hypot(viewportCenterX, viewportCenterY)),
  );
  return {
    mediaElement: media.element,
    root,
    visibleRatio: Math.max(media.ratio, rootVisibleRatio),
    score: media.ratio * 55 + (1 - normalizedDistance) * 20 + Math.min(12, actionCount * 2) +
      (currentRouteIsPhoto ? 12 : 0) + (photoSpecific ? 8 : 0),
  };
}

function resolveMediaId(
  media: HTMLElement,
  root: HTMLElement,
  currentUrl: string,
  baseUri: string,
): { id: string | null; source: string | null; permalink: string | null; authorUniqueId: string | null } {
  const currentId = videoIdFromHref(currentUrl);
  const currentPath = safePathname(currentUrl, baseUri);
  if (currentId && /\/(?:video|photo)\/\d+/.test(currentPath)) {
    const authorUniqueId = authorUniqueIdFromHref(currentUrl, baseUri);
    return { id: currentId, source: "page_url:media_id", permalink: currentUrl, authorUniqueId };
  }

  const links = Array.from(
    root.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"], a[href*="/photo/"]'),
  );
  const ids = [...new Set(links.map((link) => videoIdFromHref(link.href)).filter(Boolean))];
  if (ids.length === 1) {
    const id = ids[0]!;
    const link = links.find((candidate) => videoIdFromHref(candidate.href) === id) ?? null;
    return linkResult(link, id, "active_root:scoped_media_link");
  }

  for (const element of [media, root, ...Array.from(root.querySelectorAll<HTMLElement>(
    '[data-video-id], [data-item-id], [data-aweme-id]',
  ))]) {
    for (const attribute of ["data-video-id", "data-item-id", "data-aweme-id"]) {
      const id = element.getAttribute(attribute)?.trim();
      if (id && /^\d{10,25}$/.test(id)) {
        return { id, source: `active_root:${attribute}`, permalink: null, authorUniqueId: null };
      }
    }
  }
  return { id: null, source: null, permalink: null, authorUniqueId: null };
}

function containsOtherVisibleVideo(root: HTMLElement, selected: HTMLVideoElement, win: Window): boolean {
  return Array.from(root.querySelectorAll<HTMLVideoElement>("video")).some((candidate) => {
    if (candidate === selected || !isVisibleThroughAncestors(candidate, win)) return false;
    const rect = candidate.getBoundingClientRect();
    // 业务根不能跨过另一条仍参与布局的视频，即使那条视频此刻在视口外。
    // 否则全屏推荐流的上/下张离屏卡片仍可能把指标污染到当前视频。
    return rect.width >= 48 && rect.height >= 48 && rect.width * rect.height >= 4_096;
  });
}

function isVisibleThroughAncestors(element: HTMLElement, win: Window): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    const style = win.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      (style.opacity !== "" && Number(style.opacity) === 0)
    ) {
      return false;
    }
    if (current.getAttribute("aria-hidden") === "true" || current.hidden) return false;
    current = current.parentElement;
  }
  return true;
}

function viewportIntersectionRatio(rect: DOMRect, viewportWidth: number, viewportHeight: number): number {
  const width = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  const area = Math.max(1, rect.width * rect.height);
  return Math.max(0, Math.min(1, (width * height) / area));
}

function foregroundBonus(video: HTMLVideoElement, win: Window): number {
  let bonus = 0;
  if (video.closest('[role="dialog"]')) bonus += 6;
  if (video.closest('[aria-current="true"], [data-active="true"], .is-active')) bonus += 7;
  let current: HTMLElement | null = video;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const zIndex = Number.parseInt(win.getComputedStyle(current).zIndex, 10);
    if (Number.isFinite(zIndex) && zIndex > 0) bonus = Math.max(bonus, Math.min(8, Math.log10(zIndex + 1) * 2));
    current = current.parentElement;
  }
  return bonus;
}

function foregroundLayerRank(layer: HTMLElement, win: Window): number {
  const zIndex = Number.parseInt(win.getComputedStyle(layer).zIndex, 10);
  const zRank = Number.isFinite(zIndex) ? zIndex : 0;
  const allDialogs = Array.from(layer.ownerDocument.querySelectorAll('[role="dialog"]'));
  return zRank * 10_000 + allDialogs.indexOf(layer);
}

function scoreScopedLink(link: HTMLAnchorElement, video: HTMLVideoElement, win: Window): number {
  const rect = link.getBoundingClientRect();
  const videoRect = video.getBoundingClientRect();
  const overlapWidth = Math.max(0, Math.min(rect.right, videoRect.right) - Math.max(rect.left, videoRect.left));
  const overlapHeight = Math.max(0, Math.min(rect.bottom, videoRect.bottom) - Math.max(rect.top, videoRect.top));
  const overlap = overlapWidth * overlapHeight;
  const visible = viewportIntersectionRatio(rect, win.innerWidth, win.innerHeight);
  return (link.contains(video) ? 100 : 0) + (overlap > 0 ? 20 : 0) + visible * 10;
}

function videoIdFromHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, document.baseURI).pathname.match(/\/(?:video|photo)\/(\d+)/)?.[1] ?? null;
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

function authorUniqueIdFromHref(href: string, baseUri: string): string | null {
  try {
    return new URL(href, baseUri).pathname.match(/^\/@([^/?]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function cleanMediaUrl(value: string, baseUri: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, baseUri);
    url.hash = "";
    return url.toString().slice(0, 500);
  } catch {
    return value.slice(0, 500);
  }
}

function buildContentFingerprint(video: HTMLVideoElement, root: HTMLElement, baseUri: string): string {
  const media = buildMediaFingerprint(video, baseUri);
  const authorHref = root
    .querySelector<HTMLAnchorElement>('a[href^="/@"], a[href*="tiktok.com/@"]')
    ?.getAttribute("href");
  const description = root
    .querySelector<HTMLElement>(
      '[data-e2e="browse-video-desc"], [data-e2e="video-desc"], [data-e2e="feed-video-desc"]',
    )
    ?.textContent?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  const dataId = [video, root]
    .flatMap((element) =>
      ["data-video-id", "data-item-id", "data-aweme-id"].map(
        (attribute) => element.getAttribute(attribute) ?? "",
      ),
    )
    .join("|");
  return [media, authorHref ?? "", description ?? "", dataId, describeRoot(root)].join("||");
}

function buildMediaFingerprint(video: HTMLVideoElement, baseUri: string): string {
  return [video.currentSrc, video.src, video.poster]
    .map((value) => cleanMediaUrl(value, baseUri))
    .filter(Boolean)
    .join("|");
}

function buildPhotoFingerprint(media: HTMLElement, root: HTMLElement, baseUri: string): string {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>("img"))
    .map((image) => cleanMediaUrl(image.currentSrc || image.src, baseUri))
    .filter((value): value is string => Boolean(value))
    .slice(0, 8);
  const authorHref = root
    .querySelector<HTMLAnchorElement>('a[href^="/@"], a[href*="tiktok.com/@"]')
    ?.getAttribute("href") ?? "";
  const description = root
    .querySelector<HTMLElement>(
      '[data-e2e="browse-video-desc"], [data-e2e="video-desc"], [data-e2e="feed-video-desc"]',
    )
    ?.textContent?.replace(/\s+/g, " ").trim().slice(0, 300) ?? "";
  return [media.tagName, ...images, authorHref, description, describeRoot(root)].join("||");
}

function hashString(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function linkResult(
  link: HTMLAnchorElement | null | undefined,
  id: string,
  source: string,
): { id: string; source: string; permalink: string | null; authorUniqueId: string | null } {
  const permalink = link?.href ?? null;
  let authorUniqueId: string | null = null;
  if (permalink) {
    try {
      authorUniqueId = new URL(permalink, document.baseURI).pathname.match(/^\/@([^/?]+)/)?.[1] ?? null;
    } catch {
      authorUniqueId = null;
    }
  }
  return { id, source, permalink, authorUniqueId };
}

function describeRoot(root: HTMLElement): string {
  const parts = [root.tagName.toLowerCase()];
  if (root.id) parts.push(`#${root.id.slice(0, 80)}`);
  const e2e = root.getAttribute("data-e2e");
  if (e2e) parts.push(`[data-e2e="${e2e.slice(0, 80)}"]`);
  const videoId = root.getAttribute("data-video-id") ?? root.getAttribute("data-item-id");
  if (videoId) parts.push(`[data-video-id="${videoId.slice(0, 40)}"]`);
  const classes = Array.from(root.classList).slice(0, 2);
  if (classes.length > 0) parts.push(`.${classes.join(".")}`);
  return parts.join("").slice(0, 240);
}

function safeBoolean(reader: () => boolean): boolean {
  try {
    return reader();
  } catch {
    return false;
  }
}

function safeNumber(reader: () => number): number {
  try {
    const value = reader();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
