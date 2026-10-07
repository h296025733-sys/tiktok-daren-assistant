import { isTikTokVideoId, type NormalizedVideoItem } from "../extractors/normalizer";
import { VideoItemRegistry } from "../registry/videoItemRegistry";

const MAX_EVENT_CHARS = 1_000_000;
const MAX_ITEMS_PER_EVENT = 300;
const MAX_RECENT_PATHS = 12;
const MAX_MATCHED_IDS = 1_000;

export interface NetworkRegistryStats {
  normalized_item_count: number;
  matched_video_ids: string[];
  recent_pathnames: string[];
  accepted_event_count: number;
  rejected_event_count: number;
}

export interface ValidatedNormalizedVideoEvent {
  pathname: string;
  items: NormalizedVideoItem[];
}

export class NetworkRegistryConsumer {
  private normalizedItemCount = 0;
  private acceptedEventCount = 0;
  private rejectedEventCount = 0;
  private readonly matchedIds = new Set<string>();
  private readonly recentPathnames: string[] = [];

  consume(detail: unknown, registry: VideoItemRegistry): number {
    const event = parseNormalizedVideoEvent(detail);
    if (!event) {
      this.rejectedEventCount += 1;
      return 0;
    }
    registry.upsertMany(event.items, "network_response");
    this.acceptedEventCount += 1;
    this.normalizedItemCount += event.items.length;
    for (const item of event.items) {
      touchBoundedSet(this.matchedIds, item.video_id, MAX_MATCHED_IDS);
    }
    this.touchPath(event.pathname);
    return event.items.length;
  }

  getStats(): NetworkRegistryStats {
    return {
      normalized_item_count: this.normalizedItemCount,
      matched_video_ids: [...this.matchedIds],
      recent_pathnames: [...this.recentPathnames],
      accepted_event_count: this.acceptedEventCount,
      rejected_event_count: this.rejectedEventCount,
    };
  }

  private touchPath(pathname: string): void {
    const index = this.recentPathnames.indexOf(pathname);
    if (index >= 0) this.recentPathnames.splice(index, 1);
    this.recentPathnames.push(pathname);
    if (this.recentPathnames.length > MAX_RECENT_PATHS) this.recentPathnames.shift();
  }
}

export function parseNormalizedVideoEvent(
  detail: unknown,
): ValidatedNormalizedVideoEvent | null {
  if (typeof detail !== "string" || detail.length === 0 || detail.length > MAX_EVENT_CHARS) {
    return null;
  }
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    const pathname = safePathname(parsed.pathname);
    const rawItems = Array.isArray(parsed.items) ? parsed.items.slice(0, MAX_ITEMS_PER_EVENT) : [];
    if (!pathname || rawItems.length === 0) return null;
    const items = rawItems
      .map(validateItem)
      .filter((item): item is NormalizedVideoItem => item !== null);
    return items.length > 0 ? { pathname, items } : null;
  } catch {
    return null;
  }
}

function validateItem(value: unknown): NormalizedVideoItem | null {
  if (!isRecord(value) || !isTikTokVideoId(value.video_id)) return null;
  const author = isRecord(value.author) ? value.author : {};
  const metrics = isRecord(value.metrics) ? value.metrics : {};
  const mediaSources = isRecord(value.media_sources) ? value.media_sources : null;
  return {
    video_id: value.video_id,
    content_type: value.content_type === "photo" ? "photo" : "video",
    is_ad: typeof value.is_ad === "boolean" ? value.is_ad : null,
    has_product: typeof value.has_product === "boolean" ? value.has_product : null,
    author: {
      unique_id: safeText(author.unique_id, 128),
      nickname: safeText(author.nickname, 256),
    },
    description: safeText(value.description, 1_000),
    created_at: safeInteger(value.created_at),
    publish_time_text: safeText(value.publish_time_text, 128),
    duration_seconds: safeInteger(value.duration_seconds),
    metrics: {
      play_count: safeInteger(metrics.play_count),
      like_count: safeInteger(metrics.like_count),
      comment_count: safeInteger(metrics.comment_count),
      collect_count: safeInteger(metrics.collect_count),
      share_count: safeInteger(metrics.share_count),
    },
    cover_url: safePublicUrl(value.cover_url),
    media_signature: safeText(value.media_signature, 512),
    ...(mediaSources
      ? {
          media_sources: {
            play_url: safeSignedMediaUrl(mediaSources.play_url),
            download_url: safeSignedMediaUrl(mediaSources.download_url),
            background_music_url: safeSignedMediaUrl(mediaSources.background_music_url),
            music_title: safeText(mediaSources.music_title, 256),
            subtitle_url: safeSignedMediaUrl(mediaSources.subtitle_url),
            subtitle_language: safeText(mediaSources.subtitle_language, 64),
          },
        }
      : {}),
  };
}

function safePathname(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 300) return null;
  return value.split(/[?#]/, 1)[0] ?? null;
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safePublicUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
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

function safeSignedMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function touchBoundedSet(values: Set<string>, value: string, maximum: number): void {
  values.delete(value);
  values.add(value);
  while (values.size > maximum) {
    const oldest = values.values().next().value as string | undefined;
    if (!oldest) break;
    values.delete(oldest);
  }
}
