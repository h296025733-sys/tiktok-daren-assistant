export interface SessionSubtitleResult {
  video_id: string;
  language: string;
  language_probability: number;
  duration_seconds: number;
  device_used: string;
  compute_type: string;
  fallback_reason: string | null;
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
}

export interface SessionSubtitleTranslation {
  texts: string[];
  providerLabel: string;
}

export interface SessionSubtitleCacheEntry {
  result: SessionSubtitleResult;
  translations: Map<string, SessionSubtitleTranslation>;
}

interface StoredSubtitleCache {
  version: 1;
  entries: Array<{
    video_id: string;
    result: SessionSubtitleResult;
    translations: Array<{
      language: string;
      texts: string[];
      providerLabel: string;
    }>;
  }>;
}

const MAX_SEGMENTS_PER_VIDEO = 10_000;
const MAX_TOTAL_TEXT_CHARACTERS = 1_000_000;
const MAX_TRANSLATION_LANGUAGES = 20;

export function serializeSubtitleSessionCache(
  cache: ReadonlyMap<string, SessionSubtitleCacheEntry>,
  limit: number,
): StoredSubtitleCache {
  const entries = [...cache.entries()]
    .slice(-Math.max(0, limit))
    .map(([videoId, entry]) => ({
      video_id: videoId,
      result: {
        video_id: entry.result.video_id,
        language: entry.result.language,
        language_probability: entry.result.language_probability,
        duration_seconds: entry.result.duration_seconds,
        device_used: entry.result.device_used,
        compute_type: entry.result.compute_type,
        fallback_reason: entry.result.fallback_reason,
        text: entry.result.text,
        segments: entry.result.segments.map((segment) => ({ ...segment })),
      },
      translations: [...entry.translations.entries()]
        .slice(0, MAX_TRANSLATION_LANGUAGES)
        .map(([language, value]) => ({
          language,
          texts: [...value.texts],
          providerLabel: value.providerLabel,
        })),
    }));
  return { version: 1, entries };
}

export function parseSubtitleSessionCache(
  value: unknown,
  limit: number,
): Map<string, SessionSubtitleCacheEntry> {
  const result = new Map<string, SessionSubtitleCacheEntry>();
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return result;

  for (const rawEntry of value.entries.slice(-Math.max(0, limit))) {
    const entry = parseEntry(rawEntry);
    if (!entry) continue;
    result.delete(entry.result.video_id);
    result.set(entry.result.video_id, entry);
  }
  return result;
}

function parseEntry(value: unknown): SessionSubtitleCacheEntry | null {
  if (!isRecord(value) || !isSafeText(value.video_id, 128) || !isRecord(value.result)) {
    return null;
  }
  const rawResult = value.result;
  if (
    rawResult.video_id !== value.video_id ||
    !isSafeText(rawResult.language, 64, true) ||
    !isFiniteNumber(rawResult.language_probability) ||
    !isFiniteNumber(rawResult.duration_seconds) ||
    rawResult.duration_seconds < 0 ||
    !isSafeText(rawResult.device_used, 128, true) ||
    !isSafeText(rawResult.compute_type, 128, true) ||
    !(rawResult.fallback_reason === null || isSafeText(rawResult.fallback_reason, 2_000, true)) ||
    !isSafeText(rawResult.text, MAX_TOTAL_TEXT_CHARACTERS, true) ||
    !Array.isArray(rawResult.segments) ||
    rawResult.segments.length === 0 ||
    rawResult.segments.length > MAX_SEGMENTS_PER_VIDEO
  ) {
    return null;
  }

  let characterCount = rawResult.text.length;
  const segments: SessionSubtitleResult["segments"] = [];
  for (const rawSegment of rawResult.segments) {
    if (
      !isRecord(rawSegment) ||
      !isFiniteNumber(rawSegment.start) ||
      !isFiniteNumber(rawSegment.end) ||
      rawSegment.start < 0 ||
      rawSegment.end < rawSegment.start ||
      !isSafeText(rawSegment.text, 20_000)
    ) {
      return null;
    }
    characterCount += rawSegment.text.length;
    if (characterCount > MAX_TOTAL_TEXT_CHARACTERS) return null;
    segments.push({
      start: rawSegment.start,
      end: rawSegment.end,
      text: rawSegment.text,
    });
  }

  const translations = new Map<string, SessionSubtitleTranslation>();
  if (Array.isArray(value.translations)) {
    for (const rawTranslation of value.translations.slice(0, MAX_TRANSLATION_LANGUAGES)) {
      if (
        !isRecord(rawTranslation) ||
        !isSafeText(rawTranslation.language, 64) ||
        !isSafeText(rawTranslation.providerLabel, 128, true) ||
        !Array.isArray(rawTranslation.texts) ||
        rawTranslation.texts.length !== segments.length
      ) {
        continue;
      }
      const texts: string[] = [];
      let translationCharacters = 0;
      let valid = true;
      for (const text of rawTranslation.texts) {
        if (!isSafeText(text, 20_000, true)) {
          valid = false;
          break;
        }
        translationCharacters += text.length;
        if (translationCharacters > MAX_TOTAL_TEXT_CHARACTERS) {
          valid = false;
          break;
        }
        texts.push(text);
      }
      if (valid) {
        translations.set(rawTranslation.language, {
          texts,
          providerLabel: rawTranslation.providerLabel,
        });
      }
    }
  }

  return {
    result: {
      video_id: value.video_id,
      language: rawResult.language,
      language_probability: rawResult.language_probability,
      duration_seconds: rawResult.duration_seconds,
      device_used: rawResult.device_used,
      compute_type: rawResult.compute_type,
      fallback_reason: rawResult.fallback_reason,
      text: rawResult.text,
      segments,
    },
    translations,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0);
}
