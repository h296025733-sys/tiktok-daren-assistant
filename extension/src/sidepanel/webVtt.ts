export interface WebVttSegment {
  start: number;
  end: number;
  text: string;
}

export interface TikTokWebVttTrack {
  url: string;
  language: string | null;
}

const TRUSTED_TIKTOK_MEDIA_SUFFIXES = [
  ".tiktokcdn.com",
  ".tiktokcdn-us.com",
  ".tiktokv.com",
  ".byteoversea.com",
  ".ibytedtos.com",
  ".akamaized.net",
  ".muscdn.com",
] as const;

export function trustedTikTokSubtitleUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !TRUSTED_TIKTOK_MEDIA_SUFFIXES.some(
        (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
      )
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function trustedTikTokVideoPageUrl(
  value: string | null | undefined,
  expectedVideoId: string,
): string | null {
  if (!value || !/^\d{10,}$/.test(expectedVideoId) || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLocaleLowerCase() !== "www.tiktok.com" ||
      url.username ||
      url.password ||
      !url.pathname.endsWith(`/video/${expectedVideoId}`)
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function extractTikTokWebVttTrackFromHtml(
  value: string,
  expectedVideoId: string,
): TikTokWebVttTrack | null {
  if (!value || value.length > 8_000_000 || !/^\d{10,}$/.test(expectedVideoId)) return null;
  const scriptMatch = value.match(
    /<script\b[^>]*\bid=(?:"__UNIVERSAL_DATA_FOR_REHYDRATION__"|'__UNIVERSAL_DATA_FOR_REHYDRATION__')[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!scriptMatch?.[1]) return null;

  return extractTikTokWebVttTrackFromHydrationJson(scriptMatch[1], expectedVideoId);
}

export function extractTikTokWebVttTrackFromDocument(
  doc: Document,
  expectedVideoId: string,
): TikTokWebVttTrack | null {
  const script = doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
  return extractTikTokWebVttTrackFromHydrationJson(script?.textContent, expectedVideoId);
}

export function extractTikTokWebVttTrackFromHydrationJson(
  value: string | null | undefined,
  expectedVideoId: string,
): TikTokWebVttTrack | null {
  if (!value || value.length > 8_000_000 || !/^\d{10,}$/.test(expectedVideoId)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    return null;
  }
  const root = asRecord(payload);
  const defaultScope = asRecord(root?.__DEFAULT_SCOPE__);
  const detail = asRecord(defaultScope?.["webapp.video-detail"]);
  const itemInfo = asRecord(detail?.itemInfo);
  const item = asRecord(itemInfo?.itemStruct);
  if (!item || String(item.id ?? "") !== expectedVideoId) return null;
  return preferredWebVttTrack(asRecord(item.video));
}

export function parseWebVtt(value: string): WebVttSegment[] {
  if (!value || value.length > 2_000_000) return [];
  const normalized = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.trimStart().startsWith("WEBVTT")) return [];

  const segments: WebVttSegment[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    if (segments.length >= 5_000) break;
    const lines = block.split("\n").map((line) => line.trim());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [rawStart, rawEndWithSettings] = lines[timingIndex]!.split(/\s+-->\s+/, 2);
    const rawEnd = rawEndWithSettings?.split(/\s+/, 1)[0];
    const start = parseWebVttTimestamp(rawStart);
    const end = parseWebVttTimestamp(rawEnd);
    if (start === null || end === null || end < start) continue;
    const text = decodeCueText(lines.slice(timingIndex + 1).join(" "));
    if (!text) continue;
    segments.push({ start, end, text });
  }
  return segments;
}

function preferredWebVttTrack(video: Record<string, unknown> | null): TikTokWebVttTrack | null {
  if (!video) return null;
  const rawTracks = video.subtitleInfos ?? video.subtitle_infos;
  if (!Array.isArray(rawTracks)) return null;
  const tracks = rawTracks
    .map(asRecord)
    .filter((track): track is Record<string, unknown> => Boolean(track))
    .map((track) => ({
      format: textValue(track.Format ?? track.format)?.toLocaleLowerCase() ?? "",
      language: textValue(
        track.LanguageCodeName ?? track.languageCodeName ?? track.language_code_name,
      ),
      url: trustedTikTokSubtitleUrl(textValue(track.Url ?? track.url)),
    }))
    .filter((track) => track.format === "webvtt" && Boolean(track.url));
  if (!tracks.length) return null;

  const claInfo = asRecord(video.claInfo ?? video.cla_info);
  const originalLanguageInfo = asRecord(
    claInfo?.originalLanguageInfo ?? claInfo?.original_language_info,
  );
  const originalLanguage = textValue(originalLanguageInfo?.language);
  const selected = originalLanguage
    ? tracks.find((track) =>
        track.language?.toLocaleLowerCase() === originalLanguage.toLocaleLowerCase())
    : null;
  const fallback = selected ?? tracks[0];
  return fallback?.url
    ? { url: fallback.url, language: fallback.language }
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 4_096 ? text : null;
}

function parseWebVttTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    minutes > 59 ||
    seconds > 59
  ) {
    return null;
  }
  return hours * 3_600 + minutes * 60 + seconds + milliseconds / 1_000;
}

function decodeCueText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_match, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function safeCodePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}
