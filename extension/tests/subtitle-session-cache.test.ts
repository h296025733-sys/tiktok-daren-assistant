import { describe, expect, it } from "vitest";

import {
  parseSubtitleSessionCache,
  serializeSubtitleSessionCache,
  type SessionSubtitleCacheEntry,
} from "../src/sidepanel/subtitleSessionCache";

function cacheEntry(videoId: string, text: string): SessionSubtitleCacheEntry {
  return {
    result: {
      video_id: videoId,
      language: "en",
      language_probability: 0.98,
      duration_seconds: 4,
      device_used: "tiktok-webvtt",
      compute_type: "existing-caption",
      fallback_reason: null,
      text,
      segments: [{ start: 0, end: 4, text }],
    },
    translations: new Map([
      ["zh-CN", { texts: [`译文：${text}`], providerLabel: "Google 在线" }],
    ]),
  };
}

describe("side-panel subtitle session cache", () => {
  it("round-trips captions and translations without storing stale download files", () => {
    const source = new Map([
      ["7652906415371209997", cacheEntry("7652906415371209997", "Hello.")],
    ]);

    const stored = serializeSubtitleSessionCache(source, 12);
    const restored = parseSubtitleSessionCache(stored, 12);

    expect(restored.get("7652906415371209997")).toEqual(source.get("7652906415371209997"));
    expect(JSON.stringify(stored)).not.toContain("download_url");
  });

  it("keeps only the newest entries and ignores corrupted session data", () => {
    const source = new Map([
      ["1", cacheEntry("1", "First")],
      ["2", cacheEntry("2", "Second")],
      ["3", cacheEntry("3", "Third")],
    ]);
    const stored = serializeSubtitleSessionCache(source, 2);
    const restored = parseSubtitleSessionCache(stored, 2);

    expect([...restored.keys()]).toEqual(["2", "3"]);
    expect(parseSubtitleSessionCache({ version: 1, entries: [{ video_id: "4" }] }, 12).size)
      .toBe(0);
    expect(parseSubtitleSessionCache({ version: 99, entries: [] }, 12).size).toBe(0);
  });
});
