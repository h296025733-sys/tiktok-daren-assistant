import { describe, expect, it, vi } from "vitest";

import {
  extractTikTokMediaUrlFromHtml,
  resolveFreshTikTokMediaUrl,
  trustedTikTokMediaUrl,
} from "../src/downloads/tiktokMediaResolver";

const VIDEO_ID = "7658854290118692126";
const PAGE_URL = `https://www.tiktok.com/@creator/video/${VIDEO_ID}`;
const MEDIA_URL = "https://v16.tiktokcdn.com/video.mp4?x-expires=9999999999";

describe("TikTok 批量媒体地址恢复", () => {
  it("从视频详情 hydration 中只取目标视频的可信媒体地址", () => {
    const html = hydrationHtml(VIDEO_ID, MEDIA_URL);
    expect(extractTikTokMediaUrlFromHtml(html, VIDEO_ID)).toBe(MEDIA_URL);
    expect(extractTikTokMediaUrlFromHtml(html, "7658854290118692999")).toBeNull();
    expect(trustedTikTokMediaUrl("https://evil.example/video.mp4")).toBeNull();
  });

  it("缺少或过期地址时通过视频公开页刷新短期签名地址", async () => {
    const fetcher = vi.fn(async () => new Response(hydrationHtml(VIDEO_ID, MEDIA_URL), {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    const resolved = await resolveFreshTikTokMediaUrl({ video_id: VIDEO_ID, page_url: PAGE_URL }, { fetcher });

    expect(resolved).toBe(MEDIA_URL);
    expect(fetcher).toHaveBeenCalledWith(PAGE_URL, expect.objectContaining({
      credentials: "include",
      cache: "no-store",
    }));
  });

  it("拒绝非 TikTok 视频详情页，不发送请求", async () => {
    const fetcher = vi.fn();
    await expect(resolveFreshTikTokMediaUrl({
      video_id: VIDEO_ID,
      page_url: `https://evil.example/@creator/video/${VIDEO_ID}`,
    }, { fetcher })).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function hydrationHtml(videoId: string, mediaUrl: string): string {
  return `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": {
        itemInfo: {
          itemStruct: {
            id: videoId,
            desc: "fixture",
            author: { uniqueId: "creator" },
            stats: { playCount: 10 },
            video: { duration: 12, playAddr: mediaUrl },
          },
        },
      },
    },
  })}</script></html>`;
}
