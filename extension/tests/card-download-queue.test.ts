import { describe, expect, it } from "vitest";

import { usableQueuedCardDownloads } from "../src/downloads/cardQueue";

describe("卡片下载队列", () => {
  it("保留精确卡片 descriptor，过滤过期和伪造项目", () => {
    const now = 1_800_000_000_000;
    const valid = {
      request_id: "request-b",
      tab_id: 17,
      requested_at: now,
      mode: "audio_track",
      media: {
        video_id: "7654207540028394774",
        page_url: "https://www.tiktok.com/@exact/video/7654207540028394774",
        media_url: "https://v16.tiktokcdn.com/exact.mp4",
        media_source: "registry_play_url",
        background_music_url: null,
        music_title: null,
        author_unique_id: "exact",
        author_nickname: "精确卡片",
        description: "绑定 B",
        created_at: null,
      },
    };
    const result = usableQueuedCardDownloads([
      { ...valid, request_id: "expired", requested_at: now - 11 * 60_000 },
      { ...valid, request_id: "wrong", media: { ...valid.media, page_url: "https://evil.example/" } },
      valid,
    ], now);
    expect(result).toHaveLength(1);
    expect(result[0]?.media).toEqual(valid.media);
    expect(result[0]?.mode).toBe("audio_track");
  });
});
