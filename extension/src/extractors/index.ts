import type { Confidence, FieldEvidence, Snapshot } from "../types/snapshot";
import type { ActiveMediaContext } from "./activeVideo";
import { extractDomData } from "./dom";
import { detectPageType, videoIdFromUrl } from "./pageType";
import {
  extractStructuredData,
  resolveStructuredVideoId,
  type StructuredMatchContext,
} from "./structured";
import { evidence } from "./value";

export interface ExtractionContext {
  pageUrl: string;
  activeVideo: ActiveMediaContext | null;
  switchCount: number;
  activeChanged: boolean;
}

function valueOf<T>(fields: Record<string, FieldEvidence>, name: string): T | null {
  return (fields[name]?.value as T | null | undefined) ?? null;
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

function mergeMissing(
  preferred: Record<string, FieldEvidence>,
  fallback: Record<string, FieldEvidence>,
): Record<string, FieldEvidence> {
  const merged = { ...preferred };
  for (const [name, candidate] of Object.entries(fallback)) {
    if (merged[name]?.value == null && candidate.value != null) merged[name] = candidate;
  }
  return merged;
}

export function extractCurrentPage(context: ExtractionContext): Snapshot {
  const pageType = detectPageType(context.pageUrl);
  let fields: Record<string, FieldEvidence> = {
    page_type: evidence(pageType, "page_url", "high", context.pageUrl),
    page_url: evidence(context.pageUrl, "page_url", "high", context.pageUrl),
  };
  let rawData: Record<string, unknown> = {};
  let fromStructuredJson = false;

  if (context.activeVideo) {
    const domFields = extractDomData(context.activeVideo);
    const matchContext: StructuredMatchContext = {
      authorUniqueId: valueOf<string>(domFields, "author.unique_id"),
      description: valueOf<string>(domFields, "description"),
      mediaUrls: context.activeVideo.video
        ? [
            context.activeVideo.video.currentSrc,
            context.activeVideo.video.src,
            context.activeVideo.video.poster,
          ].filter(Boolean)
        : Array.from(context.activeVideo.activeRoot.querySelectorAll<HTMLImageElement>("img"))
            .flatMap((image) => [image.currentSrc, image.src])
            .filter(Boolean)
            .slice(0, 12),
    };

    let resolvedVideoId = context.activeVideo.videoId;
    let resolvedVideoIdSource = context.activeVideo.videoIdSource;
    const mediaMatch = resolveStructuredVideoId(matchContext, "media");
    let videoIdConflict = false;
    if (resolvedVideoId && mediaMatch && mediaMatch.id !== resolvedVideoId) {
      rawData.video_id_conflict = {
        active_root_id: resolvedVideoId,
        structured_media_id: mediaMatch.id,
        action: "discarded_both_ids",
      };
      resolvedVideoId = null;
      resolvedVideoIdSource = null;
      videoIdConflict = true;
    } else if (!resolvedVideoId) {
      resolvedVideoId = mediaMatch?.id ?? null;
      resolvedVideoIdSource = mediaMatch?.source ?? null;
    }
    if (!resolvedVideoId && !videoIdConflict && pageType === "video_detail") {
      resolvedVideoId = videoIdFromUrl(context.pageUrl);
      resolvedVideoIdSource = resolvedVideoId ? "page_url" : null;
    }
    if (!resolvedVideoId && !videoIdConflict) {
      const contextMatch = resolveStructuredVideoId(matchContext, "context");
      resolvedVideoId = contextMatch?.id ?? null;
      resolvedVideoIdSource = contextMatch?.source ?? null;
    }

    if (resolvedVideoId) {
      fields.video_id = evidence(
        resolvedVideoId,
        resolvedVideoIdSource ?? "active_video_context",
        resolvedVideoIdSource?.startsWith("embedded_json") ? "medium" : "high",
        resolvedVideoId,
      );
      const structured = extractStructuredData(resolvedVideoId);
      if (structured.videoId === resolvedVideoId) {
        fields = mergeMissing(fields, structured.fields);
        rawData = structured.raw;
        fromStructuredJson = Object.keys(structured.fields).length > 0;
      }
    }
    fields = mergeMissing(fields, domFields);
  }

  return {
    page_type: pageType,
    page_url: context.pageUrl,
    video_id: valueOf<string>(fields, "video_id"),
    author: {
      nickname: valueOf<string>(fields, "author.nickname"),
      unique_id: valueOf<string>(fields, "author.unique_id"),
    },
    description: valueOf<string>(fields, "description"),
    created_at: valueOf<number>(fields, "created_at"),
    publish_time_text: valueOf<string>(fields, "publish_time_text"),
    duration_seconds: valueOf<number>(fields, "duration_seconds"),
    metrics: {
      play_count: valueOf<number>(fields, "metrics.play_count"),
      like_count: valueOf<number>(fields, "metrics.like_count"),
      comment_count: valueOf<number>(fields, "metrics.comment_count"),
      collect_count: valueOf<number>(fields, "metrics.collect_count"),
      share_count: valueOf<number>(fields, "metrics.share_count"),
    },
    extraction: aggregateExtraction(fields),
    field_evidence: fields,
    raw_data: {
      ...rawData,
      active_video: context.activeVideo
        ? {
            identity: context.activeVideo.identity,
            visible_ratio: Number(context.activeVideo.visibleRatio.toFixed(4)),
            candidate_count: context.activeVideo.candidateCount,
            root: context.activeVideo.rootSignature,
            score: Number(context.activeVideo.score.toFixed(2)),
            switch_count: context.switchCount,
            changed: context.activeChanged,
          }
        : {
            identity: null,
            visible_ratio: null,
            candidate_count: document.querySelectorAll("video").length,
            root: null,
            score: null,
            switch_count: context.switchCount,
            changed: context.activeChanged,
          },
      from_structured_json: fromStructuredJson,
      captured_url: context.pageUrl,
      captured_at: new Date().toISOString(),
    },
  };
}

export { ActiveVideoResolver } from "./activeVideo";
export type { ActiveVideoContext } from "./activeVideo";
export type { ActiveMediaContext, ActivePhotoContext } from "./activeVideo";
