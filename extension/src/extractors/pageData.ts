import type { Confidence, FieldEvidence, PageType, Snapshot } from "../types/snapshot";
import {
  materializeRegistryRecord,
  type RegistryFieldName,
  type RegistryVideoRecord,
  VideoItemRegistry,
  type VideoItemPatch,
} from "../registry/videoItemRegistry";
import {
  extractActionFields,
  extractDomDataWithDiagnostics,
  extractMediaFields,
  extractMetadataFields,
  type RejectedPlayCountCandidate,
} from "./dom";
import type { ActiveMediaContext } from "./activeVideo";
import { hasExplicitCommercialDisclosure } from "./commercialDisclosure";
import type {
  CompositeVideoContext,
  GridSurfaceMode,
  SurfaceMode,
  VideoCardContext,
} from "./surfaces";
import { evidence } from "./value";

export interface PageCollectionContextEvidence {
  active_identifier: string | null;
  active_root: string | null;
  media_root: string | null;
  metadata_root: string | null;
  action_root: string | null;
  page_root: string | null;
  video_id_source: string | null;
  video_links: string[];
  candidate_card_count: number;
}

export interface PageCollectionResult {
  snapshot: Snapshot;
  surfaceMode: SurfaceMode;
  registryRecord: RegistryVideoRecord | null;
  rejectedPlayCountCandidates: RejectedPlayCountCandidate[];
  context: PageCollectionContextEvidence;
}

export function collectEmptyPage(
  pageUrl: string,
  surfaceMode: SurfaceMode,
): PageCollectionResult {
  const pageType = pageTypeForSurface(surfaceMode);
  const fields = baseFields(pageUrl, pageType);
  return {
    snapshot: snapshotFromFields(fields, pageUrl, pageType, {
      surface_mode: surfaceMode,
      registry_match: null,
      rejected_play_count_candidates: [],
    }),
    surfaceMode,
    registryRecord: null,
    rejectedPlayCountCandidates: [],
    context: {
      active_identifier: null,
      active_root: null,
      media_root: null,
      metadata_root: null,
      action_root: null,
      page_root: null,
      video_id_source: null,
      video_links: [],
      candidate_card_count: 0,
    },
  };
}

export function collectHomePage(
  pageUrl: string,
  active: ActiveMediaContext | null,
  registry: VideoItemRegistry,
  switchCount: number,
  activeChanged: boolean,
  transitionGuarded = false,
): PageCollectionResult {
  let videoId = active?.videoId ?? null;
  let videoIdSource = active?.videoIdSource ?? null;
  let videoIdConflict: Record<string, string> | null = null;
  const domResult = active
    ? extractDomDataWithDiagnostics(active)
    : { fields: {}, rejectedPlayCountCandidates: [] };

  if (active) {
    // 切换过渡态必须先用正在播放的媒体地址单独核对。不能把仍滞后的
    // author/description/poster 一起评分，否则旧卡 A 会压过已切换的媒体 B。
    const mediaUrls = activeMediaUrls(active);
    const coverUrl = activeCoverUrl(active);
    const mediaMatch = registry.matchUnique({ mediaUrls });
    const contextMatch =
      mediaMatch ??
      registry.matchUnique({
        authorUniqueId: fieldValue<string>(domResult.fields, "author.unique_id"),
        description: fieldValue<string>(domResult.fields, "description"),
        coverUrl,
        durationSeconds: fieldValue<number>(domResult.fields, "duration_seconds"),
        durationSecondsRaw: fieldRawValue(domResult.fields, "duration_seconds"),
        likeCount: fieldValue<number>(domResult.fields, "metrics.like_count"),
        likeCountRaw: fieldRawValue(domResult.fields, "metrics.like_count"),
        commentCount: fieldValue<number>(domResult.fields, "metrics.comment_count"),
        commentCountRaw: fieldRawValue(domResult.fields, "metrics.comment_count"),
        collectCount: fieldValue<number>(domResult.fields, "metrics.collect_count"),
        collectCountRaw: fieldRawValue(domResult.fields, "metrics.collect_count"),
        shareCount: fieldValue<number>(domResult.fields, "metrics.share_count"),
        shareCountRaw: fieldRawValue(domResult.fields, "metrics.share_count"),
      });

    if (videoId && mediaMatch && mediaMatch.video_id !== videoId) {
      videoIdConflict = {
        active_root_id: videoId,
        registry_context_id: mediaMatch.video_id,
        action: "discarded_both_ids",
      };
      videoId = null;
      videoIdSource = null;
    } else if (videoId && transitionGuarded && !mediaMatch) {
      if (contextMatch?.video_id === videoId) {
        // The active root has already caught up. A unique match from the
        // author/counters/duration is sufficient confirmation even when the
        // opaque CDN/blob media URL cannot be correlated with the registry.
        videoIdSource = `${videoIdSource ?? "active_root"}+registry:unique_context_confirmation`;
      } else if (contextMatch && contextMatch.video_id !== videoId) {
        // TikTok can reuse one <video> while its permalink/data-id remains on
        // the previous feed item. Once the new DOM counters uniquely bind a
        // different registry record, keep the media-switch guard but replace
        // the stale root id instead of leaving the item permanently unknown.
        videoIdConflict = {
          active_root_id: videoId,
          registry_context_id: contextMatch.video_id,
          action: "replaced_stale_active_root_id",
        };
        videoId = contextMatch.video_id;
        videoIdSource = "registry:unique_context_match_after_media_switch";
      } else {
        videoIdConflict = {
          active_root_id: videoId,
          registry_context_id: contextMatch?.video_id ?? "unconfirmed",
          action: "awaiting_media_or_link_confirmation",
        };
        videoId = null;
        videoIdSource = null;
      }
    } else if (!videoId && contextMatch) {
      videoId = contextMatch.video_id;
      videoIdSource = "registry:unique_context_match";
    }
  }

  if (videoId && active) {
    const coverUrl = activeCoverUrl(active);
    registry.upsert({
      ...domPatch(videoId, domResult.fields, coverUrl),
      content_type: active.contentType,
      is_ad: hasExplicitCommercialDisclosure(active.activeRoot) ? true : null,
    }, "scoped_dom");
    registry.upsert(
      {
        video_id: videoId,
        content_type: active.contentType,
        duration_seconds: fieldValue<number>(domResult.fields, "duration_seconds"),
        cover_url: coverUrl,
      },
      "active_video",
    );
  }

  const registryRecord = videoId ? registry.get(videoId) : null;
  let fields = baseFields(pageUrl, "home_feed");
  if (videoId) {
    fields.video_id = evidence(videoId, videoIdSource ?? "active_video", "high", videoId);
  }
  fields = mergeMissing(fields, registryFields(registryRecord));
  fields = mergeMissing(fields, normalizeScopedDomSources(domResult.fields));

  return {
    snapshot: snapshotFromFields(fields, pageUrl, "home_feed", {
      surface_mode: "home_feed",
      active_video: active
        ? {
            identity: active.identity,
            visible_ratio: Number(active.visibleRatio.toFixed(4)),
            candidate_count: active.candidateCount,
            root: active.rootSignature,
            score: Number(active.score.toFixed(2)),
            switch_count: switchCount,
            changed: activeChanged,
          }
        : {
            identity: null,
            visible_ratio: null,
            candidate_count: document.querySelectorAll("video").length,
            root: null,
            score: null,
            switch_count: switchCount,
            changed: activeChanged,
          },
      registry_match: registryRecord?.video_id ?? null,
      content_type: registryRecord
        ? materializeRegistryRecord(registryRecord).content_type ?? active?.contentType ?? null
        : active?.contentType ?? null,
      is_ad: registryRecord ? materializeRegistryRecord(registryRecord).is_ad ?? null : null,
      has_product: registryRecord
        ? materializeRegistryRecord(registryRecord).has_product ?? null
        : null,
      video_id_conflict: videoIdConflict,
      rejected_play_count_candidates: domResult.rejectedPlayCountCandidates,
    }),
    surfaceMode: "home_feed",
    registryRecord,
    rejectedPlayCountCandidates: domResult.rejectedPlayCountCandidates,
    context: {
      active_identifier: active?.identity ?? null,
      active_root: describeElement(active?.activeRoot ?? null),
      media_root: describeElement(active?.mediaElement ?? null),
      metadata_root: describeElement(active?.activeRoot ?? null),
      action_root: describeElement(active?.activeRoot ?? null),
      page_root: describeElement(active?.activeRoot ?? null),
      video_id_source: videoIdSource,
      video_links: active ? scopedVideoPaths(active.activeRoot) : [],
      candidate_card_count: active?.candidateCount ?? 0,
    },
  };
}

/**
 * Builds the lightweight snapshot used while a feed card is becoming active.
 * TikTok's feed response normally reaches the registry before the card finishes
 * its scroll-snap transition, so an exact video-id lookup can paint the stable
 * counters immediately without waiting for the throttled DOM collection pass.
 *
 * The caller must suppress this fast path while a reused media element is in an
 * unconfirmed transition. The full collector remains the source of truth and
 * replaces this snapshot as soon as the active card has settled.
 */
export function collectHomeRegistrySnapshot(
  pageUrl: string,
  active: ActiveMediaContext | null,
  registry: VideoItemRegistry,
): Snapshot | null {
  const videoId = active?.videoId ?? null;
  if (!videoId) return null;
  const registryRecord = registry.get(videoId);
  if (!registryRecord) return null;

  const item = materializeRegistryRecord(registryRecord);
  let fields = baseFields(pageUrl, "home_feed");
  fields.video_id = evidence(
    videoId,
    `${active?.videoIdSource ?? "active_root"}+registry:exact_id`,
    "high",
    videoId,
  );
  fields = mergeMissing(fields, registryFields(registryRecord));

  return snapshotFromFields(fields, pageUrl, "home_feed", {
    surface_mode: "home_feed",
    registry_match: videoId,
    registry_fast_path: true,
    content_type: item.content_type ?? active?.contentType ?? null,
    is_ad: item.is_ad ?? null,
    has_product: item.has_product ?? null,
    rejected_play_count_candidates: [],
  });
}

export function collectVideoDetailPage(
  context: CompositeVideoContext,
  registry: VideoItemRegistry,
): PageCollectionResult {
  registry.upsert({ video_id: context.videoId, content_type: context.contentType }, "page_url");
  const metadataFields = context.metadataRoot ? extractMetadataFields(context.metadataRoot) : {};
  const actionResult = context.actionRoot
    ? extractActionFields(context.actionRoot, false)
    : { fields: {}, rejectedPlayCountCandidates: [] };
  const mediaFields = context.video ? extractMediaFields(context.video) : {};
  const scopedFields = { ...metadataFields, ...actionResult.fields, ...mediaFields };
  const detailCover = context.video?.poster ||
    context.mediaRoot?.querySelector<HTMLImageElement>("img")?.currentSrc ||
    context.mediaRoot?.querySelector<HTMLImageElement>("img")?.src ||
    null;
  registry.upsert({
    ...domPatch(context.videoId, scopedFields, detailCover),
    content_type: context.contentType,
    is_ad: hasDetailCommercialDisclosure(context) ? true : null,
  }, "scoped_dom");
  if (context.video) {
    registry.upsert(
      {
        video_id: context.videoId,
        duration_seconds: fieldValue<number>(mediaFields, "duration_seconds"),
        cover_url: context.video.poster || null,
      },
      "active_video",
    );
  }

  const registryRecord = registry.get(context.videoId);
  let fields = baseFields(context.pageUrl, "video_detail");
  fields.video_id = evidence(context.videoId, "page_url", "high", context.videoId);
  fields = mergeMissing(fields, registryFields(registryRecord));
  fields = mergeMissing(fields, normalizeScopedDomSources(scopedFields));

  return {
    snapshot: snapshotFromFields(fields, context.pageUrl, "video_detail", {
      surface_mode: "video_detail",
      registry_match: registryRecord?.video_id ?? null,
      content_type: context.contentType,
      is_ad: registryRecord ? materializeRegistryRecord(registryRecord).is_ad ?? null : null,
      has_product: registryRecord
        ? materializeRegistryRecord(registryRecord).has_product ?? null
        : null,
      composite_context: {
        media_root: describeElement(context.mediaRoot),
        metadata_root: describeElement(context.metadataRoot),
        action_root: describeElement(context.actionRoot),
        page_root: describeElement(context.pageRoot),
      },
      rejected_play_count_candidates: actionResult.rejectedPlayCountCandidates,
    }),
    surfaceMode: "video_detail",
    registryRecord,
    rejectedPlayCountCandidates: actionResult.rejectedPlayCountCandidates,
    context: {
      active_identifier: `detail:${context.videoId}`,
      active_root: describeElement(context.pageRoot),
      media_root: describeElement(context.mediaRoot),
      metadata_root: describeElement(context.metadataRoot),
      action_root: describeElement(context.actionRoot),
      page_root: describeElement(context.pageRoot),
      video_id_source: "page_url",
      video_links: context.pageRoot ? scopedVideoPaths(context.pageRoot) : [],
      candidate_card_count: 1,
    },
  };
}

function hasDetailCommercialDisclosure(context: CompositeVideoContext): boolean {
  if (hasExplicitCommercialDisclosure(context.metadataRoot)) return true;
  if (!context.pageRoot) return false;

  // Some TikTok detail layouts render the disclosure beside, rather than inside,
  // the author/description root. Widen one ancestor at a time, but stop before an
  // ancestor contains another post so a recommended sponsored card cannot leak
  // into the current video's result.
  let candidate: HTMLElement | null = context.metadataRoot?.parentElement ?? context.pageRoot;
  while (candidate && context.pageRoot.contains(candidate)) {
    if (containsForeignPostLink(candidate, context.videoId)) return false;
    if (hasExplicitCommercialDisclosure(candidate)) return true;
    if (candidate === context.pageRoot) break;
    candidate = candidate.parentElement;
  }
  return false;
}

function containsForeignPostLink(root: ParentNode, videoId: string): boolean {
  return Array.from(
    root.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"], a[href*="/photo/"]'),
  ).some((link) => {
    try {
      const linkedId = new URL(link.href, link.ownerDocument.baseURI).pathname
        .match(/\/(?:video|photo)\/(\d+)/)?.[1];
      return Boolean(linkedId && linkedId !== videoId);
    } catch {
      return false;
    }
  });
}

export function collectGridCardPage(
  pageUrl: string,
  surfaceMode: GridSurfaceMode,
  card: VideoCardContext | null,
  registry: VideoItemRegistry,
  candidateCardCount: number,
): PageCollectionResult {
  const pageType = pageTypeForGrid(surfaceMode);
  if (card) {
    registry.upsert(
      {
        video_id: card.videoId,
        content_type: card.contentType,
        author: { unique_id: card.authorUniqueId },
        duration_seconds: card.durationSeconds,
        cover_url: card.coverUrl,
        is_ad: hasExplicitCommercialDisclosure(card.cardRoot) ? true : null,
      },
      "scoped_dom",
    );
  }
  const registryRecord = card ? registry.get(card.videoId) : null;
  let fields = baseFields(pageUrl, pageType);
  if (card) {
    fields.video_id = evidence(card.videoId, "video_card_dom:video_link", "high", card.videoLinkPathname);
    fields = mergeMissing(fields, registryFields(registryRecord));
    // 卡片页面必须展示卡片自身的可见播放量，不能把它改写成通用
    // registry:scoped_dom 后再被首页或详情页复用。
    if (card.playCount.value !== null && fields["metrics.play_count"]?.value == null) {
      fields["metrics.play_count"] = card.playCount;
    }
    if (card.authorUniqueId && fields["author.unique_id"]?.value == null) {
      fields["author.unique_id"] = evidence(
        card.authorUniqueId,
        "video_card_dom:video_link",
        "high",
        card.videoLinkPathname,
      );
    }
    if (card.durationSeconds !== null && fields.duration_seconds?.value == null) {
      fields.duration_seconds = evidence(
        card.durationSeconds,
        "active_video:hover_duration",
        "medium",
        card.durationSeconds,
      );
    }
  }

  return {
    snapshot: snapshotFromFields(fields, pageUrl, pageType, {
      surface_mode: surfaceMode,
      hovered_card: card
        ? {
            video_id: card.videoId,
            card_root: describeElement(card.cardRoot),
            video_link: card.videoLinkPathname,
          }
        : null,
      registry_match: registryRecord?.video_id ?? null,
      content_type: card?.contentType ?? null,
      is_ad: registryRecord ? materializeRegistryRecord(registryRecord).is_ad ?? null : null,
      has_product: registryRecord
        ? materializeRegistryRecord(registryRecord).has_product ?? null
        : null,
      rejected_play_count_candidates: [],
    }),
    surfaceMode,
    registryRecord,
    rejectedPlayCountCandidates: [],
    context: {
      active_identifier: card ? `card:${card.videoId}` : null,
      active_root: describeElement(card?.cardRoot ?? null),
      media_root: describeElement(
        card?.hoverVideo ?? card?.cardRoot.querySelector<HTMLElement>("img") ?? null,
      ),
      metadata_root: describeElement(card?.cardRoot ?? null),
      action_root: null,
      page_root: describeElement(card?.cardRoot ?? null),
      video_id_source: card ? "video_card_dom:video_link" : null,
      video_links: card ? [card.videoLinkPathname] : [],
      candidate_card_count: candidateCardCount,
    },
  };
}

export function gridOverlayValues(
  card: VideoCardContext,
  registry: VideoItemRegistry,
): { play_count: number | null; duration: number | null } {
  const item = registry.getItem(card.videoId);
  return {
    // 卡片自身可见的严格 video-views 优先用于卡片 UI，绝不借用邻卡。
    play_count: card.playCount.value ?? item?.metrics.play_count ?? null,
    duration: card.durationSeconds ?? item?.duration_seconds ?? null,
  };
}

function activeMediaUrls(active: ActiveMediaContext): string[] {
  if (active.video) {
    return [active.video.currentSrc, active.video.src, active.video.poster].filter(Boolean);
  }
  return Array.from(active.activeRoot.querySelectorAll<HTMLImageElement>("img"))
    .map((image) => image.currentSrc || image.src)
    .filter(Boolean)
    .slice(0, 12);
}

function activeCoverUrl(active: ActiveMediaContext): string | null {
  if (active.video) return active.video.poster || null;
  const image = active.mediaElement instanceof HTMLImageElement
    ? active.mediaElement
    : active.activeRoot.querySelector<HTMLImageElement>("img");
  return image ? image.currentSrc || image.src || null : null;
}

function baseFields(pageUrl: string, pageType: PageType): Record<string, FieldEvidence> {
  return {
    page_type: evidence(pageType, "page_url", "high", pageUrl),
    page_url: evidence(pageUrl, "page_url", "high", pageUrl),
  };
}

function registryFields(record: RegistryVideoRecord | null): Record<string, FieldEvidence> {
  if (!record) return {};
  const fields: Record<string, FieldEvidence> = {
    video_id: evidence(
      record.video_id,
      `registry:${record.video_id_evidence.source}`,
      record.video_id_evidence.confidence,
      record.video_id_evidence.raw_value,
    ),
  };
  for (const [name, item] of Object.entries(record.fields)) {
    if (!item || name === "cover_url" || name === "media_signature") continue;
    fields[name] = evidence(
      item.value,
      `registry:${item.source}`,
      item.confidence,
      item.raw_value,
    );
  }
  return fields;
}

function domPatch(
  videoId: string,
  fields: Record<string, FieldEvidence>,
  coverUrl: string | null,
): VideoItemPatch {
  return {
    video_id: videoId,
    author: {
      unique_id: fieldValue<string>(fields, "author.unique_id"),
      nickname: fieldValue<string>(fields, "author.nickname"),
    },
    description: fieldValue<string>(fields, "description"),
    created_at: fieldValue<number>(fields, "created_at"),
    publish_time_text: fieldValue<string>(fields, "publish_time_text"),
    duration_seconds: fieldValue<number>(fields, "duration_seconds"),
    metrics: {
      play_count: fieldValue<number>(fields, "metrics.play_count"),
      like_count: fieldValue<number>(fields, "metrics.like_count"),
      comment_count: fieldValue<number>(fields, "metrics.comment_count"),
      collect_count: fieldValue<number>(fields, "metrics.collect_count"),
      share_count: fieldValue<number>(fields, "metrics.share_count"),
    },
    cover_url: coverUrl,
  };
}

function snapshotFromFields(
  fields: Record<string, FieldEvidence>,
  pageUrl: string,
  pageType: PageType,
  rawData: Record<string, unknown>,
): Snapshot {
  const materializedFields = withInferredCreatedAt(fields);
  return {
    page_type: pageType,
    page_url: pageUrl,
    video_id: fieldValue<string>(materializedFields, "video_id"),
    author: {
      nickname: fieldValue<string>(materializedFields, "author.nickname"),
      unique_id: fieldValue<string>(materializedFields, "author.unique_id"),
    },
    description: fieldValue<string>(materializedFields, "description"),
    created_at: fieldValue<number>(materializedFields, "created_at"),
    publish_time_text: fieldValue<string>(materializedFields, "publish_time_text"),
    duration_seconds: fieldValue<number>(materializedFields, "duration_seconds"),
    metrics: {
      play_count: fieldValue<number>(materializedFields, "metrics.play_count"),
      like_count: fieldValue<number>(materializedFields, "metrics.like_count"),
      comment_count: fieldValue<number>(materializedFields, "metrics.comment_count"),
      collect_count: fieldValue<number>(materializedFields, "metrics.collect_count"),
      share_count: fieldValue<number>(materializedFields, "metrics.share_count"),
    },
    extraction: aggregateExtraction(materializedFields),
    field_evidence: materializedFields,
    raw_data: {
      ...rawData,
      captured_url: pageUrl,
      captured_at: new Date().toISOString(),
    },
  };
}

function withInferredCreatedAt(
  fields: Record<string, FieldEvidence>,
): Record<string, FieldEvidence> {
  if (fieldValue<number>(fields, "created_at") !== null) return fields;
  const videoIdEvidence = fields.video_id;
  const videoId = fieldValue<string>(fields, "video_id");
  if (!videoId || !videoIdEvidence || videoIdEvidence.confidence === "low") return fields;
  const timestamp = inferTikTokCreatedAt(videoId);
  if (timestamp === null) return fields;
  return {
    ...fields,
    created_at: evidence(
      timestamp,
      `${videoIdEvidence.source}:tiktok_id_timestamp`,
      "medium",
      videoId,
    ),
  };
}

/** TikTok's 64-bit post id stores Unix seconds in its high 32 bits. */
function inferTikTokCreatedAt(videoId: string, nowMs = Date.now()): number | null {
  if (!/^\d{10,25}$/.test(videoId)) return null;
  try {
    const timestamp = Number(BigInt(videoId) >> 32n);
    const earliest = Date.UTC(2016, 0, 1) / 1_000;
    const latest = Math.floor(nowMs / 1_000) + 24 * 60 * 60;
    return Number.isSafeInteger(timestamp) && timestamp >= earliest && timestamp <= latest
      ? timestamp
      : null;
  } catch {
    return null;
  }
}

function normalizeScopedDomSources(
  fields: Record<string, FieldEvidence>,
): Record<string, FieldEvidence> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      {
        ...field,
        source: field.source.replace(/^active_root_dom:/, "scoped_dom:"),
      },
    ]),
  );
}

function mergeMissing(
  preferred: Record<string, FieldEvidence>,
  fallback: Record<string, FieldEvidence>,
): Record<string, FieldEvidence> {
  const merged = { ...preferred };
  for (const [name, item] of Object.entries(fallback)) {
    if (merged[name]?.value == null && item.value != null) merged[name] = item;
  }
  return merged;
}

function fieldValue<T>(fields: Record<string, FieldEvidence>, name: string): T | null {
  return (fields[name]?.value as T | null | undefined) ?? null;
}

function fieldRawValue(fields: Record<string, FieldEvidence>, name: string): unknown {
  return fields[name]?.raw_value ?? null;
}

function aggregateExtraction(fields: Record<string, FieldEvidence>): {
  source: string;
  confidence: Confidence;
} {
  const used = Object.values(fields).filter((field) => field.value !== null);
  if (used.length === 0) return { source: "page_url", confidence: "low" };
  const sources = [...new Set(used.map((field) => field.source.split(":")[0]))];
  const confidence: Confidence = used.some((field) => field.confidence === "high")
    ? "high"
    : used.some((field) => field.confidence === "medium")
      ? "medium"
      : "low";
  return { source: sources.join(" + "), confidence };
}

function pageTypeForGrid(surfaceMode: GridSurfaceMode): PageType {
  return {
    profile_grid: "profile",
    search_grid: "search",
    hashtag_grid: "hashtag",
    music_grid: "music",
  }[surfaceMode] as PageType;
}

function pageTypeForSurface(surfaceMode: SurfaceMode): PageType {
  if (surfaceMode === "home_feed" || surfaceMode === "video_detail") return surfaceMode;
  if (
    surfaceMode === "profile_grid" ||
    surfaceMode === "search_grid" ||
    surfaceMode === "hashtag_grid" ||
    surfaceMode === "music_grid"
  ) {
    return pageTypeForGrid(surfaceMode);
  }
  return "other";
}

function scopedVideoPaths(root: ParentNode): string[] {
  return Array.from(
    root.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"], a[href*="/photo/"]'),
  )
    .map((link) => {
      try {
        return new URL(link.href, link.ownerDocument.baseURI).pathname;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => value !== null)
    .slice(0, 20);
}

export function describeElement(element: Element | null): string | null {
  if (!element) return null;
  const parts = [element.tagName.toLocaleLowerCase()];
  const e2e = element.getAttribute("data-e2e");
  const role = element.getAttribute("role");
  if (e2e) parts.push(`[data-e2e="${sanitizeDomIdentifier(e2e, 80)}"]`);
  if (role) parts.push(`[role="${sanitizeDomIdentifier(role, 40)}"]`);
  if (element.id) parts.push(`#${sanitizeDomIdentifier(element.id, 80)}`);
  return parts.join("").slice(0, 240);
}

function sanitizeDomIdentifier(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\b(?:cookie|token|authorization|password|secret)\b\s*[:=]\s*[^\s]+/gi, "[已脱敏]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[长标识已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function materializedRegistryItem(record: RegistryVideoRecord | null): unknown {
  return record ? materializeRegistryRecord(record) : null;
}

export type { RegistryFieldName };
