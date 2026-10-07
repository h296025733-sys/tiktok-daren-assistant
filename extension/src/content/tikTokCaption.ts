import {
  extractTikTokWebVttTrackFromDocument,
  extractTikTokWebVttTrackFromHtml,
  parseWebVtt,
  trustedTikTokSubtitleUrl,
  trustedTikTokVideoPageUrl,
  type TikTokWebVttTrack,
  type WebVttSegment,
} from "../sidepanel/webVtt";

const PAGE_TIMEOUT_MS = 3_000;
const VTT_TIMEOUT_MS = 3_000;
const FRESH_PAGE_HEDGE_DELAY_MS = 750;
const MAX_PAGE_CHARS = 8_000_000;
const MAX_VTT_CHARS = 2_000_000;

export interface TikTokPageCaption {
  video_id: string;
  language: string | null;
  segments: WebVttSegment[];
}

export interface TikTokPageCaptionOptions {
  storedTrack?: TikTokWebVttTrack | null;
  fetcher?: typeof fetch;
}

/**
 * Runs in the TikTok content script so TikTok HTML and caption requests use
 * the same browser context as the page, matching TikTok's own request path.
 */
export async function resolveTikTokPageCaption(
  doc: Document,
  pageUrl: string,
  expectedVideoId: string,
  options: TikTokPageCaptionOptions = {},
): Promise<TikTokPageCaption | null> {
  const fetcher = options.fetcher ?? fetch;
  const directTrack = extractTikTokWebVttTrackFromDocument(doc, expectedVideoId);
  const storedTrack = usableTrack(options.storedTrack);
  const attemptedUrls = new Set<string>();
  const trustedPageUrl = trustedTikTokVideoPageUrl(pageUrl, expectedVideoId);
  const controller = new AbortController();
  const knownTrackCandidates: Array<Promise<TikTokPageCaption | null>> = [];

  for (const track of [directTrack, storedTrack]) {
    if (!track || attemptedUrls.has(track.url)) continue;
    attemptedUrls.add(track.url);
    knownTrackCandidates.push(
      fetchTrack(fetcher, track, controller.signal)
        .then((segments) => ({
          video_id: expectedVideoId,
          language: track.language,
          segments,
        }))
        .catch(() => null),
    );
  }

  const candidates = [...knownTrackCandidates];
  if (trustedPageUrl) {
    candidates.push(
      (
        knownTrackCandidates.length
          ? Promise.race([
              Promise.all(knownTrackCandidates).then((results) =>
                results.some(Boolean) ? waitForAbort(controller.signal) : undefined),
              abortableDelay(FRESH_PAGE_HEDGE_DELAY_MS, controller.signal),
            ])
          : Promise.resolve()
      )
        .then(() => fetchFreshTrack(fetcher, trustedPageUrl, expectedVideoId, controller.signal))
        .then(async (freshTrack) => {
          if (!freshTrack || attemptedUrls.has(freshTrack.url)) return null;
          attemptedUrls.add(freshTrack.url);
          const segments = await fetchTrack(fetcher, freshTrack, controller.signal);
          return {
            video_id: expectedVideoId,
            language: freshTrack.language,
            segments,
          };
        })
        .catch(() => null),
    );
  }

  const pending = candidates.map((promise, index) => ({
    index,
    promise: promise.then((caption) => ({ index, caption })),
  }));
  try {
    while (pending.length) {
      const settled = await Promise.race(pending.map(({ promise }) => promise));
      const settledIndex = pending.findIndex(({ index }) => index === settled.index);
      if (settledIndex >= 0) pending.splice(settledIndex, 1);
      if (settled.caption) {
        controller.abort();
        return settled.caption;
      }
    }
    return null;
  } finally {
    controller.abort();
  }
}

function abortableDelay(timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, timeoutMs);
    const abort = (): void => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function usableTrack(track: TikTokWebVttTrack | null | undefined): TikTokWebVttTrack | null {
  const url = trustedTikTokSubtitleUrl(track?.url);
  return url ? { url, language: track?.language ?? null } : null;
}

async function fetchFreshTrack(
  fetcher: typeof fetch,
  pageUrl: string,
  expectedVideoId: string,
  signal?: AbortSignal,
): Promise<TikTokWebVttTrack | null> {
  const response = await fetchWithTimeout(fetcher, pageUrl, PAGE_TIMEOUT_MS, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-cache",
    headers: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Cache-Control": "max-age=0",
    },
  }, signal);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_CHARS) {
    throw new Error("TikTok page is too large");
  }
  const html = await response.text();
  if (html.length > MAX_PAGE_CHARS) throw new Error("TikTok page is too large");
  return extractTikTokWebVttTrackFromHtml(html, expectedVideoId);
}

async function fetchTrack(
  fetcher: typeof fetch,
  track: TikTokWebVttTrack,
  signal?: AbortSignal,
): Promise<WebVttSegment[]> {
  const response = await fetchWithTimeout(fetcher, track.url, VTT_TIMEOUT_MS, {
    method: "GET",
    credentials: "omit",
    cache: "default",
  }, signal);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_VTT_CHARS) {
    throw new Error("TikTok caption is too large");
  }
  const source = await response.text();
  if (source.length > MAX_VTT_CHARS) throw new Error("TikTok caption is too large");
  const segments = parseWebVtt(source);
  if (!segments.length) throw new Error("TikTok caption is empty");
  return segments;
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  timeoutMs: number,
  init: RequestInit,
  parentSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  if (parentSignal?.aborted) controller.abort();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", forwardAbort);
  }
}
