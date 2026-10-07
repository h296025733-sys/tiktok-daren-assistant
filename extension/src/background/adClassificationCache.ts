const TIKTOK_VIDEO_ID = /^\d{10,25}$/;

export const MAX_KNOWN_AD_VIDEO_IDS = 1_000;

/** Keeps only exact TikTok ids, removes duplicates, and retains the newest tail. */
export function normalizeKnownAdVideoIds(
  value: unknown,
  maximum = MAX_KNOWN_AD_VIDEO_IDS,
): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !TIKTOK_VIDEO_ID.test(candidate) || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    ids.push(candidate);
  }
  return ids.slice(-Math.max(1, maximum));
}

export function appendKnownAdVideoId(value: unknown, videoId: string): string[] {
  return appendKnownAdVideoIds(value, [videoId]);
}

export function appendKnownAdVideoIds(value: unknown, videoIds: readonly string[]): string[] {
  const ids = normalizeKnownAdVideoIds(value);
  const incoming = normalizeKnownAdVideoIds(videoIds);
  if (incoming.length === 0) return ids;
  const incomingSet = new Set(incoming);
  return [...ids.filter((candidate) => !incomingSet.has(candidate)), ...incoming]
    .slice(-MAX_KNOWN_AD_VIDEO_IDS);
}
