import { safeSuggestedFilename } from "./saveAs";

export type BrowserDownloadMode = "video" | "audio_track";

export interface DownloadNamingDescriptor {
  video_id: string;
  author_unique_id?: string | null;
  author_nickname?: string | null;
  description?: string | null;
  created_at?: number | null;
}

export function mediaDownloadFileName(
  media: Readonly<DownloadNamingDescriptor>,
  mode: BrowserDownloadMode,
): string {
  const parts = [
    formatDownloadDate(media.created_at),
    cleanFileNamePart(media.video_id, "未知视频"),
    cleanFileNamePart(media.author_unique_id || media.author_nickname, "TikTok"),
    cleanCaption(media.description),
  ];
  return safeSuggestedFilename(`${parts.join("_")}.${mode === "video" ? "mp4" : "wav"}`);
}

export function batchArchiveFileName(
  items: readonly DownloadNamingDescriptor[],
  now = new Date(),
): string {
  const author = items.find((item) => item.author_unique_id || item.author_nickname);
  return safeSuggestedFilename(
    `${formatDateParts(now)}_${cleanFileNamePart(author?.author_unique_id || author?.author_nickname, "TikTok")}.zip`,
  );
}

export function stripCaptionTags(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/(^|\s)#[^\s#]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function formatDownloadDate(createdAt: number | null | undefined): string {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0) {
    return formatDateParts(new Date());
  }
  const milliseconds = createdAt < 10_000_000_000 ? createdAt * 1_000 : createdAt;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? formatDateParts(new Date()) : formatDateParts(date);
}

function cleanCaption(value: string | null | undefined): string {
  return cleanFileNamePart(stripCaptionTags(value), "无文案", 72);
}

function cleanFileNamePart(
  value: string | null | undefined,
  fallback: string,
  maxLength = 48,
): string {
  const cleaned = (value ?? "")
    .replace(/[\\/\x00-\x1f<>:"|?*]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[._\s]+|[._\s]+$/gu, "")
    .slice(0, maxLength)
    .trim();
  return cleaned || fallback;
}

function formatDateParts(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
