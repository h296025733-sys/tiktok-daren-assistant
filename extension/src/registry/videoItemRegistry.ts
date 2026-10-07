import { isTikTokVideoId, type NormalizedVideoItem } from "../extractors/normalizer";

export const VIDEO_ITEM_SOURCES = [
  "hydration_json",
  "network_response",
  "scoped_dom",
  "extension_cache",
  "active_video",
  "page_url",
] as const;

export type VideoItemSource = (typeof VIDEO_ITEM_SOURCES)[number];
export type RegistryConfidence = "high" | "medium" | "low";

export type RegistryFieldName =
  | "content_type"
  | "is_ad"
  | "has_product"
  | "author.unique_id"
  | "author.nickname"
  | "description"
  | "created_at"
  | "publish_time_text"
  | "duration_seconds"
  | "metrics.play_count"
  | "metrics.like_count"
  | "metrics.comment_count"
  | "metrics.collect_count"
  | "metrics.share_count"
  | "cover_url"
  | "media_signature";

export type RegistryPublicValue = string | number | boolean;

export interface RegistryFieldEvidence<T extends RegistryPublicValue = RegistryPublicValue> {
  value: T;
  source: VideoItemSource;
  confidence: RegistryConfidence;
  raw_value: T;
  updated_at: number;
}

export interface RegistryVideoRecord {
  video_id: string;
  video_id_evidence: RegistryFieldEvidence<string>;
  fields: Partial<Record<RegistryFieldName, RegistryFieldEvidence>>;
  sources: VideoItemSource[];
  confidence: RegistryConfidence;
  first_seen_at: number;
  last_seen_at: number;
  updated_at: number;
  revision: number;
}

export interface VideoItemPatch {
  video_id: string;
  content_type?: "video" | "photo" | null;
  is_ad?: boolean | null;
  has_product?: boolean | null;
  author?: {
    unique_id?: string | null;
    nickname?: string | null;
  };
  description?: string | null;
  created_at?: number | null;
  publish_time_text?: string | null;
  duration_seconds?: number | null;
  metrics?: {
    play_count?: number | null;
    like_count?: number | null;
    comment_count?: number | null;
    collect_count?: number | null;
    share_count?: number | null;
  };
  cover_url?: string | null;
  media_signature?: string | null;
  media_sources?: {
    play_url?: string | null;
    download_url?: string | null;
    background_music_url?: string | null;
    music_title?: string | null;
    subtitle_url?: string | null;
    subtitle_language?: string | null;
  };
}

export interface RegistryMediaSources {
  play_url: string | null;
  download_url: string | null;
  background_music_url: string | null;
  music_title: string | null;
  subtitle_url: string | null;
  subtitle_language: string | null;
}

export interface RegistryMatchContext {
  authorUniqueId?: string | null;
  description?: string | null;
  mediaUrls?: string[];
  coverUrl?: string | null;
  mediaSignature?: string | null;
  durationSeconds?: number | null;
  durationSecondsRaw?: unknown;
  likeCount?: number | null;
  likeCountRaw?: unknown;
  commentCount?: number | null;
  commentCountRaw?: unknown;
  collectCount?: number | null;
  collectCountRaw?: unknown;
  shareCount?: number | null;
  shareCountRaw?: unknown;
}

export interface VideoItemRegistryOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface VideoItemRegistryStats {
  size: number;
  max_entries: number;
  ttl_ms: number;
  upsert_count: number;
  deduplicated_count: number;
  evicted_count: number;
  expired_count: number;
}

interface InternalRecord extends RegistryVideoRecord {
  last_accessed_at: number;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 30 * 60 * 1_000;

const SOURCE_PRIORITY: Record<VideoItemSource, number> = {
  page_url: 1,
  active_video: 2,
  scoped_dom: 3,
  extension_cache: 3,
  network_response: 4,
  hydration_json: 5,
};

const SOURCE_CONFIDENCE: Record<VideoItemSource, RegistryConfidence> = {
  page_url: "high",
  active_video: "medium",
  scoped_dom: "high",
  extension_cache: "high",
  network_response: "high",
  hydration_json: "high",
};

/**
 * In-memory, per-page registry. Records can only merge when their exact
 * video_id keys match. No fuzzy matching occurs during insertion.
 */
export class VideoItemRegistry {
  readonly maxEntries: number;
  readonly ttlMs: number;

  private readonly now: () => number;
  private readonly records = new Map<string, InternalRecord>();
  private readonly mediaSources = new Map<string, RegistryMediaSources>();
  private upsertCount = 0;
  private deduplicatedCount = 0;
  private evictedCount = 0;
  private expiredCount = 0;

  constructor(options: VideoItemRegistryOptions = {}) {
    this.maxEntries = boundedPositiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 5_000);
    this.ttlMs = boundedPositiveInteger(options.ttlMs, DEFAULT_TTL_MS, 24 * 60 * 60 * 1_000);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    this.pruneExpired();
    return this.records.size;
  }

  upsert(item: VideoItemPatch, source: VideoItemSource): RegistryVideoRecord {
    assertSource(source);
    assertVideoId(item.video_id);
    const now = this.safeNow();
    this.pruneExpired(now);
    this.upsertCount += 1;

    const existing = this.records.get(item.video_id);
    const record = existing ?? this.createRecord(item.video_id, source, now);
    let changed = !existing;

    if (SOURCE_PRIORITY[source] > SOURCE_PRIORITY[record.video_id_evidence.source]) {
      record.video_id_evidence = evidence(item.video_id, source, now);
      changed = true;
    }

    const incomingFields = fieldsFromPatch(item);
    this.updateMediaSources(item.video_id, item.media_sources);
    for (const [fieldName, incomingValue] of incomingFields) {
      const current = record.fields[fieldName];
      if (!current) {
        record.fields[fieldName] = evidence(incomingValue, source, now);
        changed = true;
        continue;
      }

      const incomingPriority = SOURCE_PRIORITY[source];
      const currentPriority = SOURCE_PRIORITY[current.source];
      if (isMonotonicTrueField(fieldName)) {
        // Advertisement and product evidence is additive. A later payload often
        // carries a default false while another endpoint contains the explicit
        // commercial marker. Once any exact-id source has observed true, a
        // partial/default false must never erase it; conversely a lower-priority
        // true must be allowed to correct an earlier higher-priority false.
        if (current.value === true && incomingValue === false) continue;
        if (current.value === false && incomingValue === true) {
          record.fields[fieldName] = evidence(incomingValue, source, now);
          changed = true;
          continue;
        }
      }
      if (incomingPriority > currentPriority || incomingPriority === currentPriority) {
        if (
          current.value !== incomingValue ||
          current.source !== source ||
          current.confidence !== SOURCE_CONFIDENCE[source]
        ) {
          record.fields[fieldName] = evidence(incomingValue, source, now);
          changed = true;
        } else {
          this.deduplicatedCount += 1;
        }
      } else if (current.value === incomingValue) {
        this.deduplicatedCount += 1;
      }
    }

    if (!record.sources.includes(source)) record.sources.push(source);
    record.sources.sort((left, right) => SOURCE_PRIORITY[right] - SOURCE_PRIORITY[left]);
    record.last_seen_at = now;
    record.last_accessed_at = now;
    if (changed) {
      record.updated_at = now;
      if (existing) record.revision += 1;
    } else if (incomingFields.length === 0 && existing) {
      this.deduplicatedCount += 1;
    }
    record.confidence = aggregateConfidence(record);

    this.touch(record);
    this.enforceCapacity();
    return cloneRecord(record);
  }

  upsertMany(items: readonly VideoItemPatch[], source: VideoItemSource): RegistryVideoRecord[] {
    assertSource(source);
    return items.map((item) => this.upsert(item, source));
  }

  get(videoId: string): RegistryVideoRecord | null {
    if (!isTikTokVideoId(videoId)) return null;
    const now = this.safeNow();
    this.pruneExpired(now);
    const record = this.records.get(videoId);
    if (!record) return null;
    record.last_accessed_at = now;
    this.touch(record);
    return cloneRecord(record);
  }

  getItem(videoId: string): NormalizedVideoItem | null {
    const record = this.get(videoId);
    return record ? materializeRegistryRecord(record) : null;
  }

  /** 返回短期签名媒体地址的副本；调用方不得写入快照、诊断、日志或数据库。 */
  getMediaSources(videoId: string): RegistryMediaSources | null {
    if (!this.get(videoId)) return null;
    const sources = this.mediaSources.get(videoId);
    return sources ? { ...sources } : null;
  }

  /** Finds one unambiguous registry candidate without ever merging candidates. */
  matchUnique(context: RegistryMatchContext): RegistryVideoRecord | null {
    const now = this.safeNow();
    this.pruneExpired(now);
    const author = comparableText(context.authorUniqueId)?.replace(/^@/, "") ?? null;
    const description = comparableText(context.description);
    const coverPaths = [context.coverUrl, ...(context.mediaUrls ?? [])]
      .map(comparableUrlPath)
      .filter((value): value is string => Boolean(value));
    const mediaSignature = comparableText(context.mediaSignature);
    const ranked: Array<{ record: InternalRecord; score: number }> = [];

    for (const record of this.records.values()) {
      const candidate = materializeRegistryRecord(record);
      const candidateAuthor = comparableText(candidate.author.unique_id)?.replace(/^@/, "") ?? null;
      const candidateDescription = comparableText(candidate.description);
      const candidateCover = comparableUrlPath(candidate.cover_url);
      const candidateSignature = comparableText(candidate.media_signature);
      const candidateMediaPaths = mediaPathsFromSignature(candidateSignature);
      let score = 0;

      if (candidateCover && coverPaths.includes(candidateCover)) score += 8;
      // 宽高、时长、编码等媒体签名只能辅助消歧，不能单独认领 video_id。
      if (mediaSignature && candidateSignature === mediaSignature) score += 3;
      if (coverPaths.some((path) => candidateMediaPaths.includes(path))) score += 8;
      if (
        author &&
        candidateAuthor === author &&
        description &&
        description.length >= 12 &&
        candidateDescription === description
      ) {
        score += 7;
      }

      const publicSignals = [
        metricSignal(context.likeCount, candidate.metrics.like_count, context.likeCountRaw),
        metricSignal(context.commentCount, candidate.metrics.comment_count, context.commentCountRaw),
        metricSignal(context.collectCount, candidate.metrics.collect_count, context.collectCountRaw),
        metricSignal(context.shareCount, candidate.metrics.share_count, context.shareCountRaw),
        durationSignal(
          context.durationSeconds,
          candidate.duration_seconds,
          context.durationSecondsRaw,
        ),
      ];
      const comparableSignals = publicSignals.filter((signal) => signal !== "missing");
      const matchedSignals = comparableSignals.filter((signal) => signal === "match").length;
      const hasConflict = comparableSignals.some((signal) => signal === "conflict");
      const authorMatches = Boolean(author && candidateAuthor === author);
      const authorConflicts = Boolean(author && candidateAuthor && candidateAuthor !== author);

      // 首页推荐流有时没有公开 permalink/video_id，但按钮上的互动量和时长仍然
      // 与网络响应一致。只有“同作者 + 至少三个独立信号”或“至少四个独立信号”
      // 且不存在冲突时才允许回填，最后仍要求唯一最高候选，避免同作者串视频。
      if (
        !hasConflict &&
        !authorConflicts &&
        ((authorMatches && matchedSignals >= 3) || (!author && matchedSignals >= 4))
      ) {
        score += (authorMatches ? 4 : 0) + matchedSignals * 2;
      }
      if (score >= 7) ranked.push({ record, score });
    }

    ranked.sort((left, right) => right.score - left.score);
    const best = ranked[0];
    if (!best || (ranked[1] && ranked[1].score === best.score)) return null;
    best.record.last_accessed_at = now;
    this.touch(best.record);
    return cloneRecord(best.record);
  }

  list(): RegistryVideoRecord[] {
    this.pruneExpired();
    return [...this.records.values()].map(cloneRecord);
  }

  delete(videoId: string): boolean {
    this.mediaSources.delete(videoId);
    return this.records.delete(videoId);
  }

  clear(): void {
    this.records.clear();
    this.mediaSources.clear();
  }

  pruneExpired(now = this.safeNow()): number {
    let removed = 0;
    for (const [videoId, record] of this.records) {
      if (now - record.last_seen_at < this.ttlMs) continue;
      this.records.delete(videoId);
      this.mediaSources.delete(videoId);
      removed += 1;
    }
    this.expiredCount += removed;
    return removed;
  }

  getStats(): VideoItemRegistryStats {
    this.pruneExpired();
    return {
      size: this.records.size,
      max_entries: this.maxEntries,
      ttl_ms: this.ttlMs,
      upsert_count: this.upsertCount,
      deduplicated_count: this.deduplicatedCount,
      evicted_count: this.evictedCount,
      expired_count: this.expiredCount,
    };
  }

  private createRecord(videoId: string, source: VideoItemSource, now: number): InternalRecord {
    return {
      video_id: videoId,
      video_id_evidence: evidence(videoId, source, now),
      fields: {},
      sources: [source],
      confidence: SOURCE_CONFIDENCE[source],
      first_seen_at: now,
      last_seen_at: now,
      last_accessed_at: now,
      updated_at: now,
      revision: 1,
    };
  }

  private touch(record: InternalRecord): void {
    this.records.delete(record.video_id);
    this.records.set(record.video_id, record);
  }

  private enforceCapacity(): void {
    while (this.records.size > this.maxEntries) {
      const oldestVideoId = this.records.keys().next().value as string | undefined;
      if (!oldestVideoId) break;
      this.records.delete(oldestVideoId);
      this.mediaSources.delete(oldestVideoId);
      this.evictedCount += 1;
    }
  }

  private safeNow(): number {
    const value = this.now();
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : Date.now();
  }

  private updateMediaSources(
    videoId: string,
    incoming: VideoItemPatch["media_sources"],
  ): void {
    if (!incoming) return;
    const current = this.mediaSources.get(videoId) ?? {
      play_url: null,
      download_url: null,
      background_music_url: null,
      music_title: null,
      subtitle_url: null,
      subtitle_language: null,
    };
    const next: RegistryMediaSources = {
      play_url: sanitizeSignedMediaUrl(incoming.play_url) ?? current.play_url,
      download_url: sanitizeSignedMediaUrl(incoming.download_url) ?? current.download_url,
      background_music_url:
        sanitizeSignedMediaUrl(incoming.background_music_url) ?? current.background_music_url,
      music_title: sanitizeMediaTitle(incoming.music_title) ?? current.music_title,
      subtitle_url: sanitizeSignedMediaUrl(incoming.subtitle_url) ?? current.subtitle_url,
      subtitle_language:
        sanitizeSubtitleLanguage(incoming.subtitle_language) ?? current.subtitle_language,
    };
    if (next.play_url || next.download_url || next.background_music_url || next.subtitle_url) {
      this.mediaSources.set(videoId, next);
    }
  }
}

export function materializeRegistryRecord(record: RegistryVideoRecord): NormalizedVideoItem {
  const value = <T extends RegistryPublicValue>(field: RegistryFieldName): T | null =>
    (record.fields[field]?.value as T | undefined) ?? null;

  return {
    video_id: record.video_id,
    content_type: value<string>("content_type") === "photo" ? "photo" : "video",
    is_ad: value<boolean>("is_ad"),
    has_product: value<boolean>("has_product"),
    author: {
      unique_id: value<string>("author.unique_id"),
      nickname: value<string>("author.nickname"),
    },
    description: value<string>("description"),
    created_at: value<number>("created_at"),
    publish_time_text: value<string>("publish_time_text"),
    duration_seconds: value<number>("duration_seconds"),
    metrics: {
      play_count: value<number>("metrics.play_count"),
      like_count: value<number>("metrics.like_count"),
      comment_count: value<number>("metrics.comment_count"),
      collect_count: value<number>("metrics.collect_count"),
      share_count: value<number>("metrics.share_count"),
    },
    cover_url: value<string>("cover_url"),
    media_signature: value<string>("media_signature"),
  };
}

function fieldsFromPatch(item: VideoItemPatch): Array<[RegistryFieldName, RegistryPublicValue]> {
  const fields: Array<[RegistryFieldName, RegistryPublicValue]> = [];
  if (item.content_type === "video" || item.content_type === "photo") {
    fields.push(["content_type", item.content_type]);
  }
  if (typeof item.is_ad === "boolean") fields.push(["is_ad", item.is_ad]);
  if (typeof item.has_product === "boolean") fields.push(["has_product", item.has_product]);
  addString(fields, "author.unique_id", item.author?.unique_id, 128, true);
  addString(fields, "author.nickname", item.author?.nickname, 256);
  addString(fields, "description", item.description, 5_000);
  addInteger(fields, "created_at", item.created_at);
  addString(fields, "publish_time_text", item.publish_time_text, 128);
  addInteger(fields, "duration_seconds", item.duration_seconds);
  addInteger(fields, "metrics.play_count", item.metrics?.play_count);
  addInteger(fields, "metrics.like_count", item.metrics?.like_count);
  addInteger(fields, "metrics.comment_count", item.metrics?.comment_count);
  addInteger(fields, "metrics.collect_count", item.metrics?.collect_count);
  addInteger(fields, "metrics.share_count", item.metrics?.share_count);
  const cover = sanitizeCoverUrl(item.cover_url);
  if (cover !== null) fields.push(["cover_url", cover]);
  const mediaSignature = sanitizeMediaSignature(item.media_signature);
  if (mediaSignature !== null) fields.push(["media_signature", mediaSignature]);
  return fields;
}

function isMonotonicTrueField(field: RegistryFieldName): field is "is_ad" | "has_product" {
  return field === "is_ad" || field === "has_product";
}

function addString(
  fields: Array<[RegistryFieldName, RegistryPublicValue]>,
  name: RegistryFieldName,
  raw: string | null | undefined,
  maxLength: number,
  removeAt = false,
): void {
  if (typeof raw !== "string") return;
  let value = raw.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  if (removeAt) value = value.replace(/^@/, "");
  if (value) fields.push([name, value.slice(0, maxLength)]);
}

function addInteger(
  fields: Array<[RegistryFieldName, RegistryPublicValue]>,
  name: RegistryFieldName,
  value: number | null | undefined,
): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    fields.push([name, value]);
  }
}

function evidence<T extends RegistryPublicValue>(
  value: T,
  source: VideoItemSource,
  now: number,
): RegistryFieldEvidence<T> {
  return {
    value,
    source,
    confidence: SOURCE_CONFIDENCE[source],
    raw_value: value,
    updated_at: now,
  };
}

function aggregateConfidence(record: InternalRecord): RegistryConfidence {
  const evidenceValues = [record.video_id_evidence, ...Object.values(record.fields)];
  if (evidenceValues.some((item) => item?.confidence === "high")) return "high";
  if (evidenceValues.some((item) => item?.confidence === "medium")) return "medium";
  return "low";
}

function cloneRecord(record: RegistryVideoRecord): RegistryVideoRecord {
  const fields: Partial<Record<RegistryFieldName, RegistryFieldEvidence>> = {};
  for (const [name, item] of Object.entries(record.fields)) {
    if (!item) continue;
    fields[name as RegistryFieldName] = { ...item };
  }
  return {
    video_id: record.video_id,
    video_id_evidence: { ...record.video_id_evidence },
    fields,
    sources: [...record.sources],
    confidence: record.confidence,
    first_seen_at: record.first_seen_at,
    last_seen_at: record.last_seen_at,
    updated_at: record.updated_at,
    revision: record.revision,
  };
}

function comparableText(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return text || null;
}

type MatchSignal = "match" | "conflict" | "missing";

function metricSignal(
  observed: number | null | undefined,
  candidate: number | null,
  rawObserved?: unknown,
): MatchSignal {
  if (!isNonNegativeInteger(observed) || !isNonNegativeInteger(candidate)) return "missing";
  const tolerance = displayedMetricTolerance(rawObserved) ??
    (observed < 1_000
      ? 0
      : observed < 1_000_000
        ? 50
        : observed < 1_000_000_000
          ? 50_000
          : 50_000_000);
  return Math.abs(observed - candidate) <= tolerance ? "match" : "conflict";
}

/**
 * TikTok abbreviates counters according to their visible precision. `846K`
 * represents a one-thousand-wide bucket, while `6.7K` represents a
 * one-hundred-wide bucket. Matching both with a fixed +/-50 tolerance caused
 * otherwise exact home-feed items to be rejected before their registry-only
 * video id, play count and publish date could be materialized.
 *
 * We deliberately accept at most one displayed unit on either side. The
 * caller still requires at least three independent public signals and one
 * unique best registry record, so this does not turn a single rounded counter
 * into identity evidence by itself.
 */
function displayedMetricTolerance(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().replace(/,/g, "").toUpperCase();
  const match = normalized.match(/^(\d+)(?:\.(\d+))?\s*([KMB])$/);
  if (!match) return null;
  const suffixMultiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[
    match[3] as "K" | "M" | "B"
  ];
  const decimals = match[2]?.length ?? 0;
  const displayUnit = suffixMultiplier / (10 ** decimals);
  return Number.isSafeInteger(displayUnit) ? displayUnit : null;
}

/**
 * The visible HTMLMediaElement duration and TikTok's public item payload can
 * differ by one second because the former exposes a fractional container
 * duration while the latter is an integer metadata value. Treating that
 * harmless rounding difference as an identity conflict prevents an otherwise
 * unique home-feed item from binding until a detail/comment view exposes its
 * permalink. A wider tolerance would weaken the multi-signal identity guard,
 * so this is intentionally capped at exactly one second.
 */
function durationSignal(
  observed: number | null | undefined,
  candidate: number | null,
  rawObserved?: unknown,
): MatchSignal {
  if (!isNonNegativeInteger(observed) || !isNonNegativeInteger(candidate)) return "missing";
  if (typeof rawObserved === "number" && Number.isFinite(rawObserved) && rawObserved >= 0) {
    const possiblePublicDurations = new Set([
      Math.floor(rawObserved),
      Math.round(rawObserved),
      Math.ceil(rawObserved),
    ]);
    return possiblePublicDurations.has(candidate) ? "match" : "conflict";
  }
  return Math.abs(observed - candidate) <= 1 ? "match" : "conflict";
}

function isNonNegativeInteger(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function comparableUrlPath(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.hostname.toLocaleLowerCase()}${decodeURIComponent(url.pathname).toLocaleLowerCase()}`;
  } catch {
    return null;
  }
}

function mediaPathsFromSignature(signature: string | null): string[] {
  if (!signature) return [];
  return signature
    .split(";")
    .filter((part) => part.startsWith("media="))
    .map((part) => part.slice("media=".length))
    .filter(Boolean);
}

function sanitizeCoverUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 4_096) return null;
  try {
    const url = new URL(value);
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

function sanitizeSignedMediaUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizeMediaTitle(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 256) : null;
}

function sanitizeSubtitleLanguage(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const language = value.trim();
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language)
    ? language.slice(0, 64)
    : null;
}

function sanitizeMediaSignature(value: string | null | undefined): string | null {
  if (!value || value.length > 2_048) return null;
  const safeParts: string[] = [];
  for (const rawPart of value.split(";").slice(0, 12)) {
    const [rawName, ...rawValueParts] = rawPart.split("=");
    const name = rawName?.trim().toLocaleLowerCase();
    const rawValue = rawValueParts.join("=").trim();
    if (!name || !rawValue) continue;
    if (name === "media") {
      const path = comparableUrlPath(
        /^https?:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`,
      );
      if (path) safeParts.push(`media=${path}`);
      continue;
    }
    if (["duration", "width", "height"].includes(name) && /^\d{1,10}$/.test(rawValue)) {
      safeParts.push(`${name}=${rawValue}`);
      continue;
    }
    if (["ratio", "format"].includes(name) && /^[\w.:-]{1,64}$/i.test(rawValue)) {
      safeParts.push(`${name}=${rawValue}`);
    }
  }
  return safeParts.length > 0 ? safeParts.join(";") : null;
}

function assertVideoId(videoId: string): void {
  if (!isTikTokVideoId(videoId)) {
    throw new TypeError(`无效的 TikTok video_id：${String(videoId).slice(0, 32)}`);
  }
}

function assertSource(source: VideoItemSource): void {
  if (!VIDEO_ITEM_SOURCES.includes(source)) {
    throw new TypeError("不支持的 VideoItemRegistry 数据来源");
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || (value as number) <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value as number)));
}
