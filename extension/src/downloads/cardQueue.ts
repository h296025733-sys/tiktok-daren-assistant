import type { QueuedCardMediaDownload } from "../types/messages";

export const CARD_MEDIA_DOWNLOAD_QUEUE_KEY = "pendingCardMediaDownloads";
export const MAX_PENDING_CARD_DOWNLOADS = 10;
export const CARD_DOWNLOAD_MAX_AGE_MS = 10 * 60_000;

export function usableQueuedCardDownloads(
  value: unknown,
  now = Date.now(),
): QueuedCardMediaDownload[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isQueuedCardMediaDownload)
    .filter((item) => now - item.requested_at <= CARD_DOWNLOAD_MAX_AGE_MS)
    .slice(-MAX_PENDING_CARD_DOWNLOADS);
}

function isQueuedCardMediaDownload(value: unknown): value is QueuedCardMediaDownload {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<QueuedCardMediaDownload>;
  const media = item.media;
  return (
    typeof item.request_id === "string" &&
    item.request_id.length > 0 &&
    typeof item.tab_id === "number" &&
    Number.isInteger(item.tab_id) &&
    typeof item.requested_at === "number" &&
    Number.isFinite(item.requested_at) &&
    (item.mode === "video" || item.mode === "audio_track") &&
    Boolean(media) &&
    typeof media?.video_id === "string" &&
    /^\d{10,25}$/.test(media.video_id) &&
    typeof media.page_url === "string" &&
    media.page_url.startsWith("https://www.tiktok.com/")
  );
}
