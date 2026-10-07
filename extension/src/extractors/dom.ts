import type { FieldEvidence } from "../types/snapshot";
import type { ActiveMediaContext } from "./activeVideo";
import {
  cleanText,
  evidence,
  parseMetricText,
  splitNicknameAndPublishTime,
} from "./value";

interface TextResult {
  text: string;
  selector: string;
  element: HTMLElement;
}

interface MetricDefinition {
  field: string;
  selectors: string[];
  semanticPatterns: RegExp[];
}

export interface RejectedPlayCountCandidate {
  source: string;
  raw_value: string | null;
  reason: string;
}

export interface DomExtractionResult {
  fields: Record<string, FieldEvidence>;
  rejectedPlayCountCandidates: RejectedPlayCountCandidate[];
}

const METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    field: "metrics.play_count",
    selectors: ['[data-e2e="video-views"]', '[data-e2e="browse-video-views"]'],
    // 播放量禁止使用 semantic 文本兜底，只接受严格绑定的 data-e2e 或 Registry。
    semanticPatterns: [],
  },
  {
    field: "metrics.like_count",
    selectors: ['[data-e2e="browse-like-count"]', '[data-e2e="like-count"]'],
    semanticPatterns: [/\blikes?\b/i, /点赞|讚|喜歡/i],
  },
  {
    field: "metrics.comment_count",
    selectors: ['[data-e2e="browse-comment-count"]', '[data-e2e="comment-count"]'],
    semanticPatterns: [/\bcomments?\b/i, /评论|評論|留言/i],
  },
  {
    field: "metrics.collect_count",
    selectors: [
      '[data-e2e="browse-bookmark-count"]',
      '[data-e2e="bookmark-count"]',
      '[data-e2e="collect-count"]',
      '[data-e2e="favorite-count"]',
      '[data-e2e="browse-favorite-count"]',
      '[data-e2e="browse-collect-count"]',
    ],
    semanticPatterns: [/\b(?:bookmarks?|favorites?|saves?)\b/i, /收藏|儲存/i],
  },
  {
    field: "metrics.share_count",
    selectors: ['[data-e2e="browse-share-count"]', '[data-e2e="share-count"]'],
    semanticPatterns: [/\bshares?\b/i, /分享/i],
  },
];

function firstText(root: ParentNode, selectors: string[]): TextResult | null {
  for (const selector of selectors) {
    const elements = queryIncludingRoot(root, selector);
    for (const element of elements) {
      if (root instanceof HTMLElement && isHiddenWithinRoot(element, root)) continue;
      const text = cleanText(element.textContent);
      if (text) return { text, selector, element };
    }
  }
  return null;
}

function metricToken(raw: string): string | null {
  const match = raw.match(/\d[\d,]*(?:\.\d+)?\s*(?:K|M|B|万|亿)?/i);
  return match?.[0]?.replace(/\s+/g, "") ?? null;
}

function metricFromElement(element: HTMLElement): { raw: string; value: number } | null {
  const candidates = [
    cleanText(element.textContent),
    cleanText(element.getAttribute("aria-label")),
    cleanText(element.getAttribute("title")),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const direct = parseMetricText(candidate);
    if (direct !== null) return { raw: candidate, value: direct };
    const token = metricToken(candidate);
    const parsed = parseMetricText(token);
    if (token && parsed !== null) return { raw: candidate, value: parsed };
  }
  return null;
}

function extractScopedMetric(
  root: HTMLElement,
  definition: MetricDefinition,
  rejectedPlayCountCandidates: RejectedPlayCountCandidate[],
): FieldEvidence<number> | null {
  for (const selector of definition.selectors) {
    const elements = queryIncludingRoot(root, selector);
    for (const element of elements) {
      if (isHiddenWithinRoot(element, root)) continue;
      const metric = metricFromElement(element);
      if (metric) {
        if (definition.field === "metrics.play_count") {
          const rejection = rejectedPlayCountReason(metric.raw);
          if (rejection) {
            rejectedPlayCountCandidates.push({
              source: `active_root_dom:${selector}`,
              raw_value: metric.raw,
              reason: rejection,
            });
            continue;
          }
        }
        return evidence(metric.value, `active_root_dom:${selector}`, "medium", metric.raw);
      }
    }
  }

  if (definition.field === "metrics.play_count") {
    collectForbiddenSemanticPlayCandidates(root, rejectedPlayCountCandidates);
    return null;
  }

  const semanticElements = queryIncludingRoot(
    root,
    'button[aria-label], [role="button"][aria-label], [aria-label]',
  );
  for (const element of semanticElements) {
    if (isHiddenWithinRoot(element, root)) continue;
    const label = cleanText(element.getAttribute("aria-label") ?? element.getAttribute("title"));
    if (!label || !definition.semanticPatterns.some((pattern) => pattern.test(label))) continue;
    const countElements = Array.from(
      element.querySelectorAll<HTMLElement>('[data-e2e*="count"], strong, [data-count], span'),
    );
    const metric =
      countElements
        .filter((candidate) => !isHiddenWithinRoot(candidate, root))
        .map(metricFromElement)
        .find((candidate) => candidate !== null) ?? metricFromElement(element);
    if (metric) {
      return evidence(
        metric.value,
        `active_root_semantic:${cleanText(element.getAttribute("aria-label")) ?? "button"}`,
        "medium",
        metric.raw,
      );
    }
  }
  return null;
}

function isHiddenWithinRoot(element: HTMLElement, root: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (
      current.hidden ||
      current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      (style.opacity !== "" && Number(style.opacity) === 0)
    ) {
      return true;
    }
    if (current === root) break;
    current = current.parentElement;
  }
  return false;
}

export function extractDomData(context: ActiveMediaContext): Record<string, FieldEvidence> {
  return extractDomDataWithDiagnostics(context).fields;
}

export function extractDomDataWithDiagnostics(context: ActiveMediaContext): DomExtractionResult {
  const root = context.activeRoot;
  const metadataFields = extractMetadataFields(root);
  // 首页与详情页的播放量必须来自与 video_id 精确绑定的 Registry；
  // DOM 只用于点赞/评论/收藏/分享，播放候选仅记录为拒绝证据。
  const actionResult = extractActionFields(root, false);
  const fields: Record<string, FieldEvidence> = {
    ...metadataFields,
    ...actionResult.fields,
    ...(context.video ? extractMediaFields(context.video) : {}),
  };

  const directVideoLink = context.mediaElement.closest<HTMLAnchorElement>(
    'a[href*="/video/"], a[href*="/photo/"]',
  );
  const scopedVideoLinks = Array.from(
    root.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"], a[href*="/photo/"]'),
  );
  const authorLink = directVideoLink ?? (scopedVideoLinks.length === 1 ? scopedVideoLinks[0] : null);
  const existingUniqueId = fields["author.unique_id"]?.value;
  const uniqueId =
    typeof existingUniqueId === "string"
      ? existingUniqueId
      : context.authorUniqueId ??
        authorUniqueIdFromHref(context.permalink ?? authorLink?.getAttribute("href"));
  if (uniqueId && typeof existingUniqueId !== "string") {
    fields["author.unique_id"] = evidence(
      decodeURIComponent(uniqueId),
      "active_root_link:author_href",
      "medium",
      context.permalink ?? authorLink?.getAttribute("href") ?? null,
    );
  }
  return { fields, rejectedPlayCountCandidates: actionResult.rejectedPlayCountCandidates };
}

export function extractMetadataFields(root: HTMLElement): Record<string, FieldEvidence> {
  const fields: Record<string, FieldEvidence> = {};
  const description = firstText(root, [
    '[data-e2e="browse-video-desc"]',
    '[data-e2e="video-desc"]',
    '[data-e2e="feed-video-desc"]',
  ]);
  if (description) {
    fields.description = evidence(
      description.text,
      `active_root_dom:${description.selector}`,
      "medium",
      description.text,
    );
  }

  const publishNode = firstText(root, [
    '[data-e2e="browser-video-time"]',
    '[data-e2e="browse-video-time"]',
    '[data-e2e="video-publish-time"]',
    '[data-e2e*="publish-time"]',
    "time",
  ]);
  if (publishNode) {
    fields.publish_time_text = evidence(
      publishNode.text,
      `active_root_dom:${publishNode.selector}`,
      "medium",
      publishNode.text,
    );
    const dateTime = publishNode.element.getAttribute("datetime");
    if (dateTime) {
      const milliseconds = Date.parse(dateTime);
      if (Number.isFinite(milliseconds) && milliseconds >= 0) {
        fields.created_at = evidence(
          Math.floor(milliseconds / 1000),
          `active_root_semantic:${publishNode.selector}[datetime]`,
          "medium",
          dateTime,
        );
      }
    }
  }

  const nicknameNode = firstText(root, [
    '[data-e2e="video-author-nickname"]',
    '[data-e2e="browser-nickname"]',
  ]);
  if (nicknameNode) {
    const split = splitNicknameAndPublishTime(nicknameNode.text);
    if (split.nickname) {
      fields["author.nickname"] = evidence(
        split.nickname,
        `active_root_dom:${nicknameNode.selector}`,
        "medium",
        nicknameNode.text,
      );
    }
    if (!fields.publish_time_text && split.publishTimeText) {
      fields.publish_time_text = evidence(
        split.publishTimeText,
        `active_root_dom:${nicknameNode.selector}:split_publish_time`,
        "medium",
        nicknameNode.text,
      );
    }
  }

  const uniqueIdNode = firstText(root, [
    '[data-e2e="video-author-uniqueid"]',
    '[data-e2e="browse-username"]',
  ]);
  const authorLink = findScopedAuthorLink(root);
  const uniqueId =
    authorUniqueIdFromHref(authorLink?.getAttribute("href")) ??
    cleanText(uniqueIdNode?.text)?.replace(/^@/, "") ??
    null;
  if (uniqueId) {
    fields["author.unique_id"] = evidence(
      decodeURIComponent(uniqueId),
      authorLink ? "scoped_dom:author_href" : `scoped_dom:${uniqueIdNode?.selector ?? "author"}`,
      "medium",
      authorLink?.getAttribute("href") ?? uniqueIdNode?.text ?? null,
    );
  }
  return fields;
}

function findScopedAuthorLink(root: HTMLElement): HTMLAnchorElement | undefined {
  const links = queryIncludingRoot(root, 'a[href^="/@"], a[href*="tiktok.com/@"]')
    .filter((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement)
    .filter((element) => !isHiddenWithinRoot(element, root));
  return links.find((link) =>
    link.matches(
      '[data-e2e="browse-username"], [data-e2e="video-author-uniqueid"], [data-e2e="video-author-nickname"]',
    ) || Boolean(link.querySelector(
      '[data-e2e="browse-username"], [data-e2e="video-author-uniqueid"], [data-e2e="video-author-nickname"]',
    )),
  ) ?? links.find((link) => isProfileOnlyHref(link.getAttribute("href"))) ?? links[0];
}

function isProfileOnlyHref(href: string | null): boolean {
  if (!href) return false;
  try {
    return /^\/@[^/]+\/?$/.test(new URL(href, document.baseURI).pathname);
  } catch {
    return false;
  }
}

export function extractActionFields(
  root: HTMLElement,
  includeStrictPlayCount = false,
): DomExtractionResult {
  const fields: Record<string, FieldEvidence> = {};
  const rejectedPlayCountCandidates: RejectedPlayCountCandidate[] = [];
  for (const definition of METRIC_DEFINITIONS) {
    if (definition.field === "metrics.play_count" && !includeStrictPlayCount) {
      extractScopedMetric(root, definition, rejectedPlayCountCandidates);
      continue;
    }
    const result = extractScopedMetric(root, definition, rejectedPlayCountCandidates);
    if (result) fields[definition.field] = result;
  }
  return { fields, rejectedPlayCountCandidates };
}

export function extractMediaFields(video: HTMLVideoElement): Record<string, FieldEvidence> {
  const fields: Record<string, FieldEvidence> = {};
  const duration = video.duration;
  if (Number.isFinite(duration) && duration > 0 && video.readyState >= 1) {
    fields.duration_seconds = evidence(
      Math.round(duration),
      "active_video:duration",
      "medium",
      duration,
    );
  }
  return fields;
}

function rejectedPlayCountReason(raw: string): string | null {
  const text = cleanText(raw);
  if (!text) return "empty";
  if (/%/.test(text)) return "percentage";
  if (/^(?:\d{1,2}:){1,2}\d{2}$/.test(text) || /^\d+\s*(?:秒|分钟|分鐘|分|小时|小時|時|时)$/.test(text)) {
    return "time_value";
  }
  if (/^(?:0{2,}|--)$/.test(text)) return "player_placeholder";
  if (/全螢幕|全屏|播放器|進度|进度|\bvidiq\b|查看|觀看|观看/i.test(text)) {
    return "forbidden_semantic_text";
  }
  if (parseMetricText(text) === null) return "not_canonical_metric";
  return null;
}

function collectForbiddenSemanticPlayCandidates(
  root: HTMLElement,
  rejected: RejectedPlayCountCandidate[],
): void {
  const elements = Array.from(
    root.querySelectorAll<HTMLElement>('[aria-label], [title], [data-e2e*="fullscreen"]'),
  );
  for (const element of elements.slice(0, 80)) {
    if (isHiddenWithinRoot(element, root)) continue;
    const semanticText = cleanText(
      [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent]
        .filter(Boolean)
        .join(" "),
    );
    if (!semanticText || !/全螢幕|全屏|播放器|進度|进度|\bvidiq\b|查看|觀看|观看|播放/i.test(semanticText)) {
      continue;
    }
    const metric = metricFromElement(element);
    rejected.push({
      source: "active_root_semantic:rejected",
      raw_value: metric?.raw ?? semanticText.slice(0, 160),
      reason: "semantic_play_count_forbidden",
    });
  }
}

function queryIncludingRoot(root: ParentNode, selector: string): HTMLElement[] {
  const descendants = Array.from(root.querySelectorAll<HTMLElement>(selector));
  return root instanceof HTMLElement && root.matches(selector) ? [root, ...descendants] : descendants;
}

function authorUniqueIdFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, document.baseURI).pathname.match(/^\/@([^/?]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}
