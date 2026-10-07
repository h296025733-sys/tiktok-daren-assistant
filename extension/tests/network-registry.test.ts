import { beforeEach, describe, expect, it, vi } from "vitest";

import { NetworkRegistryConsumer } from "../src/content/networkRegistry";
import { VideoItemRegistry } from "../src/registry/videoItemRegistry";

const VIDEO_A = "7648204047693909278";
const VIDEO_B = "7648988578118143262";

describe("NetworkRegistryConsumer", () => {
  let registry: VideoItemRegistry;
  let consumer: NetworkRegistryConsumer;

  beforeEach(() => {
    registry = new VideoItemRegistry();
    consumer = new NetworkRegistryConsumer();
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  it("accepts normalized public fields, sanitizes URLs/pathnames, and never merges different ids", () => {
    const acceptedA = consumer.consume(
      JSON.stringify({
        pathname: "/api/recommend/item_list/?cursor=10&token=TOP_SECRET",
        cookie: "session=TOP_SECRET",
        items: [
          {
            video_id: VIDEO_A,
            author: { unique_id: "creator_a", nickname: "Creator A", token: "TOP_SECRET" },
            description: "video A",
            created_at: 1_720_000_000,
            publish_time_text: null,
            duration_seconds: 40,
            metrics: {
              play_count: 4_600_000,
              like_count: 38_900_000,
              comment_count: 41_200,
              collect_count: 201_600,
              share_count: 105_600,
            },
            cover_url: "https://name:password@cdn.test/a.jpg?token=TOP_SECRET#fragment",
            media_signature: "duration=40;width=720;height=1280",
            request_headers: { cookie: "TOP_SECRET" },
          },
        ],
      }),
      registry,
    );
    const acceptedB = consumer.consume(
      JSON.stringify({
        pathname: "/api/post/item_list/",
        items: [
          {
            video_id: VIDEO_B,
            author: { unique_id: "creator_b", nickname: "Creator B" },
            description: "video B",
            duration_seconds: 42,
            metrics: { play_count: 125_700, like_count: 47_300 },
            cover_url: "https://cdn.test/b.jpg?signature=TOP_SECRET",
          },
        ],
      }),
      registry,
    );

    expect(acceptedA).toBe(1);
    expect(acceptedB).toBe(1);
    expect(registry.getItem(VIDEO_A)?.metrics.play_count).toBe(4_600_000);
    expect(registry.getItem(VIDEO_B)?.metrics.play_count).toBe(125_700);
    expect(registry.getItem(VIDEO_A)?.description).toBe("video A");
    expect(registry.getItem(VIDEO_B)?.description).toBe("video B");
    expect(registry.getItem(VIDEO_A)?.cover_url).toBe("https://cdn.test/a.jpg");
    expect(registry.getItem(VIDEO_B)?.cover_url).toBe("https://cdn.test/b.jpg");
    expect(registry.get(VIDEO_A)?.fields["metrics.play_count"]?.source).toBe(
      "network_response",
    );
    expect(registry.get(VIDEO_B)?.fields["metrics.play_count"]?.source).toBe(
      "network_response",
    );

    const stats = consumer.getStats();
    expect(stats.accepted_event_count).toBe(2);
    expect(stats.normalized_item_count).toBe(2);
    expect(stats.matched_video_ids).toEqual(expect.arrayContaining([VIDEO_A, VIDEO_B]));
    expect(stats.recent_pathnames).toEqual([
      "/api/recommend/item_list/",
      "/api/post/item_list/",
    ]);
    expect(JSON.stringify({ stats, records: registry.list() })).not.toContain("TOP_SECRET");
    expect(JSON.stringify({ stats, records: registry.list() })).not.toContain("password");
  });

  it("rejects malformed, non-path, query-only and id-invalid events without touching the registry", () => {
    const invalidEvents: unknown[] = [
      { pathname: "/api/item/list", items: [] },
      "not-json",
      JSON.stringify({ pathname: "https://www.tiktok.com/api/item/list", items: [item(VIDEO_A)] }),
      JSON.stringify({ pathname: "?token=TOP_SECRET", items: [item(VIDEO_A)] }),
      JSON.stringify({ pathname: "/api/item/list", items: [item("not-a-video-id")] }),
      JSON.stringify({ pathname: "/api/item/list", items: [] }),
    ];

    for (const event of invalidEvents) {
      expect(consumer.consume(event, registry)).toBe(0);
    }

    expect(registry.size).toBe(0);
    expect(consumer.getStats()).toMatchObject({
      normalized_item_count: 0,
      accepted_event_count: 0,
      rejected_event_count: invalidEvents.length,
      recent_pathnames: [],
    });
  });
});

function item(videoId: string): Record<string, unknown> {
  return {
    video_id: videoId,
    author: { unique_id: "creator", nickname: "Creator" },
    description: "normalized public item",
    duration_seconds: 10,
    metrics: { play_count: 100 },
  };
}
