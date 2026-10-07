import { beforeEach, describe, expect, it } from "vitest";

import { HydrationScanner } from "../src/content/hydrationScanner";
import { VideoItemRegistry } from "../src/registry/videoItemRegistry";

const VIDEO_A = "7648204047693909278";
const VIDEO_B = "7648988578118143262";

describe("HydrationScanner", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("normalizes multiple hydration scripts into one registry and reports stable statistics", () => {
    appendJsonScript("__UNIVERSAL_DATA_FOR_REHYDRATION__", {
      __DEFAULT_SCOPE__: {
        "webapp.video-detail": {
          itemInfo: {
            itemStruct: {
              id: VIDEO_A,
              desc: "detail A",
              author: { uniqueId: "creator_a", nickname: "Creator A" },
              stats: { playCount: 4_600_000, diggCount: 38_900_000 },
              video: { duration: 40 },
            },
          },
        },
      },
    });
    appendJsonScript("SIGI_STATE", {
      ItemModule: {
        [VIDEO_B]: {
          id: VIDEO_B,
          desc: "detail B",
          author: { uniqueId: "creator_b", nickname: "Creator B" },
          stats: { playCount: 125_700, commentCount: 71 },
          video: { duration: 42 },
        },
      },
    });

    const registry = new VideoItemRegistry();
    const scanner = new HydrationScanner();
    const first = scanner.scan(document, registry);

    expect(first.scanned_script_count).toBe(2);
    expect(first.parsed_script_count).toBe(2);
    expect(first.normalized_item_count).toBe(2);
    expect(first.matched_video_ids).toEqual(expect.arrayContaining([VIDEO_A, VIDEO_B]));
    expect(first.script_ids).toEqual(
      expect.arrayContaining(["#__UNIVERSAL_DATA_FOR_REHYDRATION__", "#SIGI_STATE"]),
    );
    expect(registry.size).toBe(2);
    expect(registry.getItem(VIDEO_A)).toMatchObject({
      video_id: VIDEO_A,
      author: { unique_id: "creator_a" },
      duration_seconds: 40,
      metrics: { play_count: 4_600_000, like_count: 38_900_000 },
    });
    expect(registry.getItem(VIDEO_B)).toMatchObject({
      video_id: VIDEO_B,
      author: { unique_id: "creator_b" },
      duration_seconds: 42,
      metrics: { play_count: 125_700, comment_count: 71 },
    });
    expect(registry.get(VIDEO_A)?.sources).toContain("hydration_json");
    expect(registry.get(VIDEO_B)?.sources).toContain("hydration_json");

    // Unchanged scripts must not be parsed and counted repeatedly.
    expect(scanner.scan(document, registry)).toEqual(first);
  });

  it("accepts only normalized public fields from the MAIN-world global hydration bridge", () => {
    const registry = new VideoItemRegistry();
    const scanner = new HydrationScanner();
    const accepted = scanner.consumeBridge(
      JSON.stringify({
        pathname: "/__global_state__/SIGI_STATE?token=SHOULD_NOT_SURVIVE",
        cookie: "SHOULD_NOT_SURVIVE",
        items: [
          {
            video_id: VIDEO_A,
            author: { unique_id: "creator_a", nickname: "Creator A", token: "hidden" },
            description: "global hydration item",
            duration_seconds: 40,
            metrics: { play_count: 4_600_000 },
            cover_url: "https://cdn.test/a.jpg?token=hidden",
          },
        ],
      }),
      registry,
    );

    expect(accepted).toBe(1);
    expect(registry.get(VIDEO_A)?.fields["metrics.play_count"]?.source).toBe("hydration_json");
    expect(scanner.getStats().matched_video_ids).toContain(VIDEO_A);
    expect(scanner.getStats().script_ids.some((value) => value.startsWith("main_world:"))).toBe(true);
    expect(JSON.stringify({ item: registry.getItem(VIDEO_A), stats: scanner.getStats() })).not.toContain(
      "SHOULD_NOT_SURVIVE",
    );
  });

  it("优先扫描已知 hydration 脚本，不会被前面的普通 JSON 脚本挤出上限", () => {
    for (let index = 0; index < 40; index += 1) {
      appendJsonScript(`ordinary-${index}`, { unrelated: index });
    }
    appendJsonScript("SIGI_STATE", {
      ItemModule: {
        [VIDEO_B]: {
          id: VIDEO_B,
          desc: "known script must win priority",
          author: { uniqueId: "creator_b" },
          stats: { playCount: 125_700 },
          video: { duration: 42 },
        },
      },
    });

    const registry = new VideoItemRegistry();
    const stats = new HydrationScanner().scan(document, registry);
    expect(stats.truncated).toBe(true);
    expect(stats.script_ids).toContain("#SIGI_STATE");
    expect(registry.getItem(VIDEO_B)?.metrics.play_count).toBe(125_700);
  });

  it("同长度 JSON 只改变中间内容时也会重新扫描，并兼容 updated-items 实际结构", () => {
    const script = document.createElement("script");
    script.id = "__UNIVERSAL_DATA_FOR_REHYDRATION__";
    script.type = "application/json";
    const payload = (videoId: string, author: string, playCount: number) => ({
      prefix: "x".repeat(500),
      __DEFAULT_SCOPE__: {
        "webapp.updated-items": [
          {
            id: videoId,
            desc: "Old vine video with trending sound",
            createTime: "1780068183",
            author: { uniqueId: author, nickname: author },
            stats: {
              playCount,
              diggCount: 16_600_000,
              commentCount: 87_000,
              collectCount: "1039746",
              shareCount: 3_000_000,
            },
            video: { duration: 6 },
          },
        ],
      },
      suffix: "y".repeat(500),
    });
    script.textContent = JSON.stringify(payload(VIDEO_A, "creator_a", 169_500_000));
    document.head.append(script);
    const registry = new VideoItemRegistry();
    const scanner = new HydrationScanner();
    scanner.scan(document, registry);
    expect(registry.getItem(VIDEO_A)).toMatchObject({
      created_at: 1_780_068_183,
      metrics: { play_count: 169_500_000, collect_count: 1_039_746 },
    });

    // ID、账号和播放量都保持相同字符长度，JSON 首尾各 256 字符也不变。
    script.textContent = JSON.stringify(payload(VIDEO_B, "creator_b", 269_500_000));
    scanner.scan(document, registry);
    expect(registry.getItem(VIDEO_B)).toMatchObject({
      author: { unique_id: "creator_b" },
      metrics: { play_count: 269_500_000 },
    });
  });
});

function appendJsonScript(id: string, value: unknown): void {
  const script = document.createElement("script");
  script.id = id;
  script.type = "application/json";
  script.textContent = JSON.stringify(value);
  document.head.append(script);
}
