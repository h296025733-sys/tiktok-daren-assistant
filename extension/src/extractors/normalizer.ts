/**
 * TikTok JSON -> public video fields.
 *
 * This module deliberately has no DOM or Chrome dependency so the same code can
 * run in both the page MAIN world and the extension isolated world. It never
 * returns the source object and only copies an allow-list of public fields.
 */

type JsonObject = Record<string, unknown>;

export interface NormalizedMediaSources {
  /** 短期签名地址仅在插件内存中使用，不进入快照、数据库、诊断或日志。 */
  play_url: string | null;
  download_url: string | null;
  background_music_url: string | null;
  music_title: string | null;
  subtitle_url: string | null;
  subtitle_language: string | null;
}

export interface NormalizedVideoItem {
  video_id: string;
  /** TikTok 的 item id 同时用于视频和图文帖子，字段名为兼容既有接口保留。 */
  content_type?: "video" | "photo";
  /** 只有页面结构化数据明确给出广告标记时才有值；未知时不猜测。 */
  is_ad?: boolean | null;
  /** 明确商品 ID/商品锚点；与付费广告标记分开，避免把“带货”误称为广告。 */
  has_product?: boolean | null;
  author: {
    unique_id: string | null;
    nickname: string | null;
  };
  description: string | null;
  created_at: number | null;
  publish_time_text: string | null;
  duration_seconds: number | null;
  metrics: {
    play_count: number | null;
    like_count: number | null;
    comment_count: number | null;
    collect_count: number | null;
    share_count: number | null;
  };
  cover_url: string | null;
  media_signature: string | null;
  media_sources?: NormalizedMediaSources;
}

export interface TikTokJsonNormalizationOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxChildrenPerNode?: number;
  maxItems?: number;
}

export interface TikTokJsonNormalizationResult {
  items: NormalizedVideoItem[];
  scanned_node_count: number;
  candidate_object_count: number;
  rejected_candidate_count: number;
  matched_video_ids: string[];
  truncated: boolean;
}

export type TikTokJsonSource = "hydration_json" | "network_response";

export interface SourcedTikTokJsonNormalizationResult extends TikTokJsonNormalizationResult {
  source: TikTokJsonSource;
}

interface RequiredLimits {
  maxDepth: number;
  maxNodes: number;
  maxChildrenPerNode: number;
  maxItems: number;
}

interface QueueNode {
  value: unknown;
  depth: number;
  path: string[];
}

const DEFAULT_LIMITS: RequiredLimits = {
  maxDepth: 10,
  maxNodes: 20_000,
  maxChildrenPerNode: 250,
  maxItems: 1_000,
};

const SENSITIVE_KEY =
  /^(?:authorization|auth(?:orization)?_?token|access_?token|refresh_?token|csrf(?:_?token)?|cookie|cookies|headers?|request_?headers?|password|passwd|credential|credentials|session_?token)$/i;

const COMMENT_OR_IDENTITY_CONTAINER =
  /^(?:comment|comments|commentlist|comment_list|reply|replies|replylist|reply_list|user|users|userlist|user_list|author|authorinfo|author_info)$/i;

const VIDEO_ID = /^\d{10,25}$/;

export function isTikTokVideoId(value: unknown): value is string {
  return typeof value === "string" && VIDEO_ID.test(value);
}

/**
 * Recursively scans an already parsed JSON value with hard depth, node, child
 * and result limits. Cycles are tolerated even though normal JSON cannot have
 * them, which also makes this safe for framework state objects.
 */
export function normalizeTikTokJson(
  payload: unknown,
  options: TikTokJsonNormalizationOptions = {},
): TikTokJsonNormalizationResult {
  const limits = resolveLimits(options);
  const queue: QueueNode[] = [{ value: payload, depth: 0, path: [] }];
  const visited = new WeakSet<object>();
  const considered = new WeakSet<object>();
  const byId = new Map<string, NormalizedVideoItem>();
  let cursor = 0;
  let scannedNodeCount = 0;
  let candidateObjectCount = 0;
  let rejectedCandidateCount = 0;
  let truncated = false;

  const consider = (value: JsonObject, path: string[], wrapperHint: boolean): void => {
    if (considered.has(value)) return;
    considered.add(value);

    if (!hasIdLikeField(value)) return;
    candidateObjectCount += 1;
    const normalized = normalizeCandidate(value, path, wrapperHint);
    if (!normalized) {
      rejectedCandidateCount += 1;
      return;
    }

    const existing = byId.get(normalized.video_id);
    if (existing) {
      byId.set(normalized.video_id, mergeMissingFields(existing, normalized));
      return;
    }
    if (byId.size >= limits.maxItems) {
      truncated = true;
      return;
    }
    byId.set(normalized.video_id, normalized);
  };

  while (cursor < queue.length && scannedNodeCount < limits.maxNodes) {
    const node = queue[cursor];
    cursor += 1;
    if (!node || (!isObject(node.value) && !Array.isArray(node.value))) continue;

    const reference = node.value as object;
    if (visited.has(reference)) continue;
    visited.add(reference);
    scannedNodeCount += 1;

    if (isObject(node.value)) {
      const itemStruct = asObject(safeGet(node.value, "itemStruct"));
      if (itemStruct) consider(itemStruct, appendPath(node.path, "itemStruct"), true);

      const itemInfo = asObject(safeGet(node.value, "itemInfo"));
      const nestedItemStruct = itemInfo ? asObject(safeGet(itemInfo, "itemStruct")) : null;
      if (nestedItemStruct) {
        consider(
          nestedItemStruct,
          appendPath(appendPath(node.path, "itemInfo"), "itemStruct"),
          true,
        );
      }

      consider(node.value, node.path, false);
    }

    if (node.depth >= limits.maxDepth) {
      if (hasTraversableChildren(node.value)) truncated = true;
      continue;
    }

    const childBatch = safeEntries(node.value, limits.maxChildrenPerNode);
    if (childBatch.hasMore) truncated = true;
    for (const [key, child] of childBatch.entries) {
      if (SENSITIVE_KEY.test(key)) continue;
      if (!isObject(child) && !Array.isArray(child)) continue;
      if (queue.length - cursor >= limits.maxNodes) {
        truncated = true;
        break;
      }
      queue.push({ value: child, depth: node.depth + 1, path: appendPath(node.path, key) });
    }
  }

  if (cursor < queue.length) truncated = true;
  const items = [...byId.values()];
  return {
    items,
    scanned_node_count: scannedNodeCount,
    candidate_object_count: candidateObjectCount,
    rejected_candidate_count: rejectedCandidateCount,
    matched_video_ids: items.map((item) => item.video_id),
    truncated,
  };
}

// Alias kept intentionally small for callers that deal with both hydration and
// network payloads; both sources must pass through the exact same normalizer.
export const normalizeTikTokPayload = normalizeTikTokJson;

/** Convenience API for feeding the result directly to registry.upsertMany. */
export function normalizeVideoItems(
  payload: unknown,
  source: TikTokJsonSource,
  options: TikTokJsonNormalizationOptions = {},
): SourcedTikTokJsonNormalizationResult {
  return { ...normalizeTikTokJson(payload, options), source };
}

function normalizeCandidate(
  candidate: JsonObject,
  path: string[],
  wrapperHint: boolean,
): NormalizedVideoItem | null {
  const videoId = readVideoId(candidate);
  if (!videoId || isDisallowedContext(path)) return null;

  const stats = firstObject(candidate, ["stats", "statistics"]);
  // TikTok 当前 hydration 会同时提供 stats 与 statsV2；A/B 页面中前者可能
  // 只有部分指标。逐字段以 stats 为主、statsV2 为备用，避免出现互动量已知但
  // 播放量因为只存在于 statsV2 而被误判为未知。
  const statsV2 = firstObject(candidate, ["statsV2", "stats_v2"]);
  const author = firstObject(candidate, ["author"]);
  const video = firstObject(candidate, ["video"]);
  const music = firstObject(candidate, ["music", "musicInfo", "music_info"]);
  const imagePost = firstObject(candidate, [
    "imagePost",
    "image_post",
    "imagePostInfo",
    "image_post_info",
    "imageInfo",
    "image_info",
  ]);
  const description = publicText(firstDefined(candidate, ["desc", "description"]), 5_000);
  const hasStats = Boolean(
    (stats && hasAnyKey(stats, STAT_KEYS)) ||
    (statsV2 && hasAnyKey(statsV2, STAT_KEYS)),
  );
  const hasAuthor = Boolean(author && hasAnyKey(author, AUTHOR_KEYS));
  const hasVideo = Boolean(video && hasAnyKey(video, VIDEO_KEYS));
  const hasImagePost = Boolean(imagePost && hasImagePostShape(imagePost));
  const hasExplicitAwemeId = safeGet(candidate, "aweme_id") !== undefined;

  // An arbitrary object with a numeric id is never sufficient. itemStruct is a
  // strong container hint, but still needs at least one actual video field.
  const hasPublicVideoShape = hasVideo || hasImagePost || hasStats || hasAuthor || description !== null;
  const isStrongVideoObject =
    (wrapperHint && hasPublicVideoShape) ||
    ((hasVideo || hasImagePost) && (hasStats || hasAuthor || description !== null)) ||
    (hasExplicitAwemeId && hasStats && (hasAuthor || description !== null));
  if (!isStrongVideoObject) return null;

  const duration = video
    ? publicInteger(firstDefined(video, ["duration", "durationSeconds", "duration_seconds"]))
    : null;
  const coverUrl = video ? extractCoverUrl(video) : imagePost ? extractImagePostCoverUrl(imagePost) : null;
  const mediaSources = extractMediaSources(video, music);

  return {
    video_id: videoId,
    content_type: hasImagePost ? "photo" : "video",
    is_ad: readAdvertisementMarker(candidate),
    has_product: readProductMarker(candidate),
    author: {
      unique_id: author
        ? normalizeUniqueId(firstDefined(author, ["uniqueId", "unique_id", "secUidName"]))
        : null,
      nickname: author ? publicText(firstDefined(author, ["nickname", "nickName"]), 256) : null,
    },
    description,
    created_at: publicInteger(
      firstDefined(candidate, ["createTime", "create_time", "createdAt", "created_at"]),
    ),
    publish_time_text: publicText(
      firstDefined(candidate, ["publishTimeText", "publish_time_text"]),
      128,
    ),
    duration_seconds: duration,
    metrics: {
      play_count: publicInteger(firstStatValue(stats, statsV2, ["playCount", "play_count", "play"])),
      like_count: publicInteger(
        firstStatValue(stats, statsV2, ["diggCount", "digg_count", "likeCount", "like_count"]),
      ),
      comment_count: publicInteger(
        firstStatValue(stats, statsV2, ["commentCount", "comment_count"]),
      ),
      collect_count: publicInteger(
        firstStatValue(stats, statsV2, [
              "collectCount",
              "collect_count",
              "favoriteCount",
              "favorite_count",
              "favouriteCount",
              "favourite_count",
        ]),
      ),
      share_count: publicInteger(
        firstStatValue(stats, statsV2, ["shareCount", "share_count"]),
      ),
    },
    cover_url: coverUrl,
    media_signature: video ? createMediaSignature(video, duration) : null,
    ...(mediaSources ? { media_sources: mediaSources } : {}),
  };
}

const STAT_KEYS = [
  "playCount",
  "play_count",
  "diggCount",
  "digg_count",
  "likeCount",
  "like_count",
  "commentCount",
  "comment_count",
  "collectCount",
  "collect_count",
  "shareCount",
  "share_count",
] as const;

const AUTHOR_KEYS = ["uniqueId", "unique_id", "nickname", "nickName"] as const;

const VIDEO_KEYS = [
  "duration",
  "durationSeconds",
  "duration_seconds",
  "cover",
  "coverUrl",
  "cover_url",
  "dynamicCover",
  "originCover",
  "playAddr",
  "downloadAddr",
  "subtitleInfos",
  "subtitle_infos",
  "claInfo",
  "cla_info",
  "width",
  "height",
  "ratio",
] as const;

function firstStatValue(
  primary: JsonObject | null,
  fallback: JsonObject | null,
  keys: readonly string[],
): unknown {
  const primaryValue = primary ? firstDefined(primary, keys) : undefined;
  return primaryValue ?? (fallback ? firstDefined(fallback, keys) : undefined);
}

function readVideoId(candidate: JsonObject): string | null {
  for (const key of ["aweme_id", "itemId", "item_id", "id"] as const) {
    const value = safeGet(candidate, key);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (VIDEO_ID.test(trimmed)) return trimmed;
    }
    // Large JSON numeric ids have already lost precision, so accepting only
    // safe integers is essential to strict video-id matching.
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1_000_000_000) {
      const text = String(value);
      if (VIDEO_ID.test(text)) return text;
    }
  }
  return null;
}

function hasIdLikeField(value: JsonObject): boolean {
  return ["aweme_id", "itemId", "item_id", "id"].some(
    (key) => safeGet(value, key) !== undefined,
  );
}

function isDisallowedContext(path: string[]): boolean {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const segment = path[index];
    if (!segment || /^\d+$/.test(segment) || /^(?:itemStruct|itemInfo)$/i.test(segment)) continue;
    if (COMMENT_OR_IDENTITY_CONTAINER.test(segment)) return true;
  }
  return false;
}

function readAdvertisementMarker(value: JsonObject): boolean | null {
  let explicitFalse = false;
  for (const key of ["isAd", "is_ad", "ad", "advertisement", "promoted"] as const) {
    const marker = safeGet(value, key);
    if (marker === true || marker === 1 || marker === "1" || marker === "true") return true;
    if (marker === false || marker === 0 || marker === "0" || marker === "false") explicitFalse = true;
  }
  for (const key of ["adId", "ad_id", "advertiser", "adInfo", "ad_info"] as const) {
    const marker = safeGet(value, key);
    if (marker !== undefined && marker !== null && marker !== "") return true;
  }
  const promoteType = firstDefined(value, ["promoteType", "promote_type"]);
  if (positiveIntegerMarker(promoteType)) return true;

  // The exact live affiliate sample exposes `adLabelVersion: 2` together with a
  // strict TikTok Shop product anchor while its narrower `isAd` field is false.
  // Require both signals so an unrelated label-version field cannot classify a
  // normal post by itself.
  const adLabelVersion = firstDefined(value, ["adLabelVersion", "ad_label_version"]);
  if (positiveIntegerMarker(adLabelVersion) && hasTikTokShopProductAnchor(value)) return true;

  const videoTag = firstDefined(value, ["videoTag", "video_tag"]);
  if (hasBrandedVideoTag(videoTag, 0)) return true;

  const commerceInfo = firstObject(value, ["commerceInfo", "commerce_info"]);
  if (
    commerceInfo &&
    positiveIntegerMarker(
      firstDefined(commerceInfo, ["brandedContentType", "branded_content_type"]),
    )
  ) return true;

  for (const key of ["commercialVideoInfo", "commercial_video_info"] as const) {
    if (hasExplicitCommercialDisclosure(safeGet(value, key), 0)) return true;
  }
  for (const key of ["hybridLabel", "hybrid_label"] as const) {
    if (hasExplicitCommercialDisclosure(safeGet(value, key), 0)) return true;
  }
  return explicitFalse ? false : null;
}

const EXPLICIT_COMMERCIAL_DISCLOSURE_LABELS = new Set(
  [
    "Advertisement",
    "Sponsored",
    "Paid partnership",
    "Promotional content",
    "Creator earns commission",
    "广告",
    "廣告",
    "付费合作关系",
    "付費合作關係",
    "付费合作伙伴关系",
    "付費合作夥伴關係",
    "推广内容",
    "推廣內容",
    "创作者赚取佣金",
    "創作者賺取佣金",
    "符合佣金领取资格",
    "符合佣金領取資格",
    "符合领取佣金资格",
    "符合領取佣金資格",
    "プロモーションコンテンツ",
    "有料パートナーシップ",
    "有償パートナーシップ",
    "광고",
    "유료 파트너십",
    "프로모션 콘텐츠",
  ].map(normalizeCommercialDisclosureLabel),
);

const COMMERCIAL_BOOLEAN_MARKER = /^(?:is_?ad|paid_?partnership|is_?paid_?partnership|promotional_?content|is_?promotional_?content|creator_?earns_?commission|commission_?eligible|is_?commission_?eligible|commercial_?content|is_?commercial_?content)$/i;

const COMMERCIAL_IDENTIFIER = /^(?:ad_?id|advertiser_?id|campaign_?id|commercial_?content_?id|commercial_?video_?id)$/i;

const COMMERCIAL_LABEL_KEY = /^(?:label|label_?text|text|title|tag|disclosure|disclosure_?text)$/i;

function positiveIntegerMarker(value: unknown): boolean {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" && /^\d+$/.test(value.trim()) && Number(value.trim()) > 0)
  );
}

function hasBrandedVideoTag(value: unknown, depth: number): boolean {
  if (depth > 3 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.slice(0, 40).some((item) => hasBrandedVideoTag(item, depth + 1));
  }
  if (!isObject(value)) return false;

  const type = publicText(firstDefined(value, ["type", "videoTagType", "video_tag_type"]), 64)
    ?.normalize("NFKC")
    .toLocaleLowerCase();
  const number = publicInteger(
    firstDefined(value, ["number", "videoTagNumber", "video_tag_number"]),
  );
  if ((type === "branded" || type === "branded type") && (number === 1 || number === 7)) {
    return true;
  }

  return safeEntries(value, 40).entries.some(
    ([, child]) =>
      (isObject(child) || Array.isArray(child)) && hasBrandedVideoTag(child, depth + 1),
  );
}

function hasExplicitCommercialDisclosure(value: unknown, depth: number): boolean {
  if (depth > 3 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    if (isExplicitCommercialDisclosureLabel(value)) return true;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 20_000 || !/^(?:\{|\[)/.test(trimmed)) return false;
    try {
      return hasExplicitCommercialDisclosure(JSON.parse(trimmed), depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 40).some((item) => hasExplicitCommercialDisclosure(item, depth + 1));
  }
  if (!isObject(value)) return false;

  const entries = safeEntries(value, 80).entries;
  for (const [key, child] of entries) {
    if (COMMERCIAL_BOOLEAN_MARKER.test(key) && isExplicitTrue(child)) return true;
    if (COMMERCIAL_IDENTIFIER.test(key) && hasNonEmptyIdentifier(child)) return true;
    if (COMMERCIAL_LABEL_KEY.test(key) && isExplicitCommercialDisclosureLabel(child)) return true;
    if (
      /^(?:brandedContentType|branded_content_type)$/.test(key) &&
      positiveIntegerMarker(child)
    ) return true;
  }

  return entries.some(
    ([, child]) =>
      (isObject(child) || Array.isArray(child)) &&
      hasExplicitCommercialDisclosure(child, depth + 1),
  );
}

function isExplicitCommercialDisclosureLabel(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = normalizeCommercialDisclosureLabel(value);
  return normalized.length > 0 && EXPLICIT_COMMERCIAL_DISCLOSURE_LABELS.has(normalized);
}

function normalizeCommercialDisclosureLabel(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function isExplicitTrue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function hasNonEmptyIdentifier(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readProductMarker(value: JsonObject): boolean | null {
  for (const key of ["productData", "product_data"] as const) {
    if (hasExplicitProductId(safeGet(value, key), 0)) return true;
  }
  for (const key of ["anchors", "anchorList", "anchor_list"] as const) {
    const anchors = safeGet(value, key);
    if (!Array.isArray(anchors)) continue;
    for (const anchor of anchors.slice(0, 40)) {
      if (!isObject(anchor)) continue;
      if (hasExplicitProductId(anchor, 0)) return true;
      if (hasTikTokShopAnchorObject(anchor)) return true;
      const extra = firstDefined(anchor, ["extra", "extraInfo", "extra_info"]);
      if (typeof extra === "string" && extra.length <= 20_000) {
        try {
          if (hasExplicitProductId(JSON.parse(extra), 0)) return true;
        } catch {
          // 非 JSON 的公开 extra 不作为商品证据。
        }
      } else if (hasExplicitProductId(extra, 0)) {
        return true;
      }
    }
  }
  return null;
}

function hasTikTokShopProductAnchor(value: JsonObject): boolean {
  for (const key of ["anchors", "anchorList", "anchor_list"] as const) {
    const anchors = safeGet(value, key);
    if (!Array.isArray(anchors)) continue;
    if (anchors.slice(0, 40).some((anchor) => isObject(anchor) && hasTikTokShopAnchorObject(anchor))) {
      return true;
    }
  }
  return false;
}

function hasTikTokShopAnchorObject(anchor: JsonObject): boolean {
  const candidates: unknown[] = [anchor];
  for (const key of ["extra", "extraInfo", "extra_info"] as const) {
    const extra = safeGet(anchor, key);
    if (typeof extra === "string" && extra.length <= 20_000) {
      try {
        candidates.push(JSON.parse(extra));
      } catch {
        // 非 JSON 的公开 extra 不作为 TikTok Shop 锚点证据。
      }
    } else if (extra !== undefined) {
      candidates.push(extra);
    }
  }
  return candidates.some((candidate) => containsStrictShopAnchor(candidate, 0));
}

function containsStrictShopAnchor(value: unknown, depth: number): boolean {
  if (depth > 3 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.slice(0, 40).some((item) => containsStrictShopAnchor(item, depth + 1));
  }
  if (!isObject(value)) return false;
  const componentKey = publicText(firstDefined(value, ["component_key", "componentKey"]), 80)
    ?.normalize("NFKC")
    .toLocaleLowerCase();
  const type = publicInteger(safeGet(value, "type"));
  const id = firstDefined(value, ["id", "product_id", "productId"]);
  if (
    componentKey === "anchor_shop" &&
    type === 33 &&
    hasNonEmptyIdentifier(id)
  ) return true;
  return safeEntries(value, 80).entries.some(
    ([, child]) =>
      (isObject(child) || Array.isArray(child)) && containsStrictShopAnchor(child, depth + 1),
  );
}

function hasExplicitProductId(value: unknown, depth: number): boolean {
  if (depth > 3 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.slice(0, 40).some((item) => hasExplicitProductId(item, depth + 1));
  }
  if (!isObject(value)) return false;
  for (const [key, child] of Object.entries(value).slice(0, 80)) {
    if (/^product_?id$/i.test(key)) {
      if (typeof child === "string" && child.trim().length > 0) return true;
      if (typeof child === "number" && Number.isSafeInteger(child) && child > 0) return true;
    }
    if (child && typeof child === "object" && hasExplicitProductId(child, depth + 1)) return true;
  }
  return false;
}

function hasImagePostShape(value: JsonObject): boolean {
  const images = firstDefined(value, ["images", "imageList", "image_list"]);
  return (Array.isArray(images) && images.length > 0) || hasAnyKey(value, [
    "imageURL",
    "image_url",
    "cover",
    "coverUrl",
    "cover_url",
  ]);
}

function extractImagePostCoverUrl(imagePost: JsonObject): string | null {
  const images = firstDefined(imagePost, ["images", "imageList", "image_list"]);
  if (Array.isArray(images)) {
    for (const image of images.slice(0, 10)) {
      const url = findUrl(image, 0);
      if (url) return url;
    }
  }
  return findUrl(imagePost, 0);
}

function extractCoverUrl(video: JsonObject): string | null {
  for (const key of [
    "originCover",
    "origin_cover",
    "dynamicCover",
    "dynamic_cover",
    "cover",
    "coverUrl",
    "cover_url",
  ] as const) {
    const url = findUrl(safeGet(video, key), 0);
    if (url) return url;
  }
  return null;
}

function findUrl(value: unknown, depth: number): string | null {
  if (depth > 3) return null;
  if (typeof value === "string") return sanitizePublicUrl(value);
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 10)) {
      const result = findUrl(child, depth + 1);
      if (result) return result;
    }
    return null;
  }
  if (!isObject(value)) return null;
  for (const key of ["urlList", "url_list", "url", "imageURL", "image_url"] as const) {
    const result = findUrl(safeGet(value, key), depth + 1);
    if (result) return result;
  }
  return null;
}

function extractMediaSources(
  video: JsonObject | null,
  music: JsonObject | null,
): NormalizedMediaSources | null {
  const playUrl = video
    ? findSignedMediaUrl(
        firstDefined(video, [
          "playAddrH264",
          "play_addr_h264",
          "playAddr",
          "play_addr",
          "playUrl",
          "play_url",
        ]),
        0,
      )
    : null;
  const downloadUrl = video
    ? findSignedMediaUrl(
        firstDefined(video, ["downloadAddr", "download_addr", "downloadUrl", "download_url"]),
        0,
      )
    : null;
  const backgroundMusicUrl = music
    ? findSignedMediaUrl(
        firstDefined(music, ["playUrl", "play_url", "playAddr", "play_addr"]),
        0,
      )
    : null;
  const musicTitle = music
    ? publicText(firstDefined(music, ["title", "musicName", "music_name"]), 256)
    : null;
  const subtitleTrack = video ? extractPreferredWebVttTrack(video) : null;
  if (!playUrl && !downloadUrl && !backgroundMusicUrl && !subtitleTrack) return null;
  return {
    play_url: playUrl,
    download_url: downloadUrl,
    background_music_url: backgroundMusicUrl,
    music_title: musicTitle,
    subtitle_url: subtitleTrack?.url ?? null,
    subtitle_language: subtitleTrack?.language ?? null,
  };
}

function extractPreferredWebVttTrack(
  video: JsonObject,
): { url: string; language: string | null } | null {
  const rawTracks = firstDefined(video, ["subtitleInfos", "subtitle_infos"]);
  if (!Array.isArray(rawTracks)) return null;

  const claInfo = firstObject(video, ["claInfo", "cla_info"]);
  const originalLanguageInfo = claInfo
    ? firstObject(claInfo, ["originalLanguageInfo", "original_language_info"])
    : null;
  const originalLanguage = originalLanguageInfo
    ? publicText(
        firstDefined(originalLanguageInfo, ["language", "languageCode", "language_code"]),
        64,
      )
    : null;
  const tracks: Array<{ url: string; language: string | null }> = [];
  for (const rawTrack of rawTracks.slice(0, 32)) {
    const track = asObject(rawTrack);
    if (!track) continue;
    const format = publicText(firstDefined(track, ["Format", "format"]), 32);
    if (format?.toLocaleLowerCase() !== "webvtt") continue;
    const url = findSignedMediaUrl(
      firstDefined(track, ["Url", "url", "URL", "urlList", "url_list"]),
      0,
    );
    if (!url) continue;
    const language = publicText(
      firstDefined(track, [
        "LanguageCodeName",
        "languageCodeName",
        "LanguageCode",
        "languageCode",
        "language",
      ]),
      64,
    );
    tracks.push({ url, language });
  }
  if (!tracks.length) return null;
  return tracks.find((track) => track.language === originalLanguage) ?? tracks[0] ?? null;
}

function findSignedMediaUrl(value: unknown, depth: number): string | null {
  if (depth > 3) return null;
  if (typeof value === "string") return sanitizeSignedMediaUrl(value);
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 10)) {
      const result = findSignedMediaUrl(child, depth + 1);
      if (result) return result;
    }
    return null;
  }
  if (!isObject(value)) return null;
  for (const key of ["urlList", "url_list", "url"] as const) {
    const result = findSignedMediaUrl(safeGet(value, key), depth + 1);
    if (result) return result;
  }
  return null;
}

function sanitizeSignedMediaUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4_096) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizePublicUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4_096) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function createMediaSignature(video: JsonObject, duration: number | null): string | null {
  const parts: string[] = [];
  const width = publicInteger(safeGet(video, "width"));
  const height = publicInteger(safeGet(video, "height"));
  const ratio = publicText(safeGet(video, "ratio"), 32);
  const format = publicText(firstDefined(video, ["format", "codecType", "codec_type"]), 48);
  const mediaUrl = findUrl(
    firstDefined(video, ["playAddr", "play_addr", "playUrl", "play_url"]),
    0,
  );
  const mediaPath = mediaUrl ? publicUrlPath(mediaUrl) : null;
  if (mediaPath !== null) parts.push(`media=${mediaPath}`);
  if (duration !== null) parts.push(`duration=${duration}`);
  if (width !== null) parts.push(`width=${width}`);
  if (height !== null) parts.push(`height=${height}`);
  if (ratio !== null) parts.push(`ratio=${ratio}`);
  if (format !== null) parts.push(`format=${format}`);
  return parts.length > 0 ? parts.join(";") : null;
}

function publicUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.hostname.toLocaleLowerCase()}${decodeURIComponent(url.pathname).toLocaleLowerCase()}`.slice(
      0,
      1_000,
    );
  } catch {
    return null;
  }
}

function mergeMissingFields(
  existing: NormalizedVideoItem,
  incoming: NormalizedVideoItem,
): NormalizedVideoItem {
  return {
    video_id: existing.video_id,
    content_type:
      existing.content_type === "photo" || incoming.content_type === "photo" ? "photo" : "video",
    is_ad:
      existing.is_ad === true || incoming.is_ad === true
        ? true
        : existing.is_ad ?? incoming.is_ad,
    has_product:
      existing.has_product === true || incoming.has_product === true
        ? true
        : existing.has_product ?? incoming.has_product,
    author: {
      unique_id: existing.author.unique_id ?? incoming.author.unique_id,
      nickname: existing.author.nickname ?? incoming.author.nickname,
    },
    description: existing.description ?? incoming.description,
    created_at: existing.created_at ?? incoming.created_at,
    publish_time_text: existing.publish_time_text ?? incoming.publish_time_text,
    duration_seconds: existing.duration_seconds ?? incoming.duration_seconds,
    metrics: {
      play_count: existing.metrics.play_count ?? incoming.metrics.play_count,
      like_count: existing.metrics.like_count ?? incoming.metrics.like_count,
      comment_count: existing.metrics.comment_count ?? incoming.metrics.comment_count,
      collect_count: existing.metrics.collect_count ?? incoming.metrics.collect_count,
      share_count: existing.metrics.share_count ?? incoming.metrics.share_count,
    },
    cover_url: existing.cover_url ?? incoming.cover_url,
    media_signature: existing.media_signature ?? incoming.media_signature,
    ...((existing.media_sources || incoming.media_sources)
      ? {
          media_sources: {
            play_url:
              existing.media_sources?.play_url ?? incoming.media_sources?.play_url ?? null,
            download_url:
              existing.media_sources?.download_url ?? incoming.media_sources?.download_url ?? null,
            background_music_url:
              existing.media_sources?.background_music_url ??
              incoming.media_sources?.background_music_url ??
              null,
            music_title:
              existing.media_sources?.music_title ?? incoming.media_sources?.music_title ?? null,
            subtitle_url:
              existing.media_sources?.subtitle_url ?? incoming.media_sources?.subtitle_url ?? null,
            subtitle_language:
              existing.media_sources?.subtitle_language ??
              incoming.media_sources?.subtitle_language ??
              null,
          },
        }
      : {}),
  };
}

function resolveLimits(options: TikTokJsonNormalizationOptions): RequiredLimits {
  return {
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_LIMITS.maxDepth, 0, 20),
    maxNodes: boundedInteger(options.maxNodes, DEFAULT_LIMITS.maxNodes, 1, 100_000),
    maxChildrenPerNode: boundedInteger(
      options.maxChildrenPerNode,
      DEFAULT_LIMITS.maxChildrenPerNode,
      1,
      1_000,
    ),
    maxItems: boundedInteger(options.maxItems, DEFAULT_LIMITS.maxItems, 1, 5_000),
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value as number)));
}

function publicText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeUniqueId(value: unknown): string | null {
  return publicText(value, 128)?.replace(/^@/, "") || null;
}

function publicInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function firstDefined(value: JsonObject, keys: readonly string[]): unknown {
  for (const key of keys) {
    const result = safeGet(value, key);
    if (result !== undefined && result !== null) return result;
  }
  return null;
}

function firstObject(value: JsonObject, keys: readonly string[]): JsonObject | null {
  for (const key of keys) {
    const result = asObject(safeGet(value, key));
    if (result) return result;
  }
  return null;
}

function hasAnyKey(value: JsonObject, keys: readonly string[]): boolean {
  return keys.some((key) => safeGet(value, key) !== undefined);
}

function safeGet(value: JsonObject, key: string): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function safeEntries(
  value: unknown,
  limit: number,
): { entries: Array<[string, unknown]>; hasMore: boolean } {
  const entries: Array<[string, unknown]> = [];
  if (Array.isArray(value)) {
    const count = Math.min(value.length, limit);
    for (let index = 0; index < count; index += 1) {
      entries.push([String(index), value[index]]);
    }
    return { entries, hasMore: value.length > limit };
  }
  if (!isObject(value)) return { entries, hasMore: false };

  // for..in lets us stop at the limit without first allocating Object.entries
  // for a potentially enormous framework state object.
  let ownKeyCount = 0;
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      ownKeyCount += 1;
      if (ownKeyCount > limit) return { entries, hasMore: true };
      entries.push([key, safeGet(value, key)]);
    }
  } catch {
    // A Proxy may throw while enumerating. Preserve the safely read prefix.
  }
  return { entries, hasMore: false };
}

function hasTraversableChildren(value: unknown): boolean {
  return safeEntries(value, 8).entries.some(
    ([, child]) => isObject(child) || Array.isArray(child),
  );
}

function appendPath(path: string[], segment: string): string[] {
  return [...path.slice(-11), segment];
}

function asObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
