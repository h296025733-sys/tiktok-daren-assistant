import { normalizeVideoItems } from "../extractors/normalizer";
import type { BrowserMediaDescriptor } from "./browserWorkflow";

const PAGE_TIMEOUT_MS = 6_000;
const MAX_PAGE_CHARS = 12_000_000;
const TRUSTED_MEDIA_SUFFIXES = [
  ".tiktok.com",
  ".tiktokcdn.com",
  ".tiktokcdn-us.com",
  ".tiktokv.com",
  ".byteoversea.com",
  ".ibytedtos.com",
  ".akamaized.net",
  ".muscdn.com",
  ".byteimg.com",
] as const;

export interface TikTokMediaResolverOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Refreshes TikTok's short-lived signed media URL from the video's own public
 * page. This is only used when the captured URL is missing or has expired.
 */
export async function resolveFreshTikTokMediaUrl(
  media: Pick<BrowserMediaDescriptor, "video_id" | "page_url">,
  options: TikTokMediaResolverOptions = {},
): Promise<string | null> {
  const pageUrl = trustedTikTokVideoPageUrl(media.page_url, media.video_id);
  if (!pageUrl) return null;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? PAGE_TIMEOUT_MS);
  try {
    const response = await (options.fetcher ?? fetch)(pageUrl, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TikTok 页面刷新失败（HTTP ${response.status}）`);
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_PAGE_CHARS) {
      throw new Error("TikTok 视频页面过大，无法安全解析");
    }
    const html = await response.text();
    if (html.length > MAX_PAGE_CHARS) throw new Error("TikTok 视频页面过大，无法安全解析");
    return extractTikTokMediaUrlFromHtml(html, media.video_id);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function extractTikTokMediaUrlFromHtml(html: string, expectedVideoId: string): string | null {
  if (!html || html.length > MAX_PAGE_CHARS || !/^\d{10,25}$/.test(expectedVideoId)) return null;
  const patterns = [
    /<script\b[^>]*\bid=(?:"__UNIVERSAL_DATA_FOR_REHYDRATION__"|'__UNIVERSAL_DATA_FOR_REHYDRATION__')[^>]*>([\s\S]*?)<\/script>/gi,
    /<script\b[^>]*\bid=(?:"SIGI_STATE"|'SIGI_STATE')[^>]*>([\s\S]*?)<\/script>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const source = match[1]?.trim();
      if (!source) continue;
      try {
        const result = normalizeVideoItems(JSON.parse(source) as unknown, "hydration_json", {
          maxDepth: 14,
          maxNodes: 40_000,
          maxChildrenPerNode: 500,
          maxItems: 1_000,
        });
        const item = result.items.find((candidate) => candidate.video_id === expectedVideoId);
        const url = trustedTikTokMediaUrl(
          item?.media_sources?.play_url ?? item?.media_sources?.download_url,
        );
        if (url) return url;
      } catch {
        // Try the next known hydration script.
      }
    }
  }
  return null;
}

export function trustedTikTokMediaUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !TRUSTED_MEDIA_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
    ) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function trustedTikTokVideoPageUrl(value: string, expectedVideoId: string): string | null {
  if (!value || value.length > 2_048 || !/^\d{10,25}$/.test(expectedVideoId)) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLocaleLowerCase() !== "www.tiktok.com" ||
      url.username ||
      url.password ||
      !url.pathname.endsWith(`/video/${expectedVideoId}`)
    ) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
