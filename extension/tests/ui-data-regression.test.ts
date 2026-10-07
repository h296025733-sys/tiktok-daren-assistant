import { describe, expect, it } from "vitest";

import { OverlayController } from "../src/content/overlay";
import type { Snapshot } from "../src/types/snapshot";
import { MemorySettingsStorage } from "../src/ui/settings";
import { mockRect } from "./helpers";

describe("阶段 1.4 UI 数据回归", () => {
  it("渲染完整浮层不会修改原快照任何字段", async () => {
    document.body.innerHTML = "<video></video>";
    const video = document.querySelector<HTMLVideoElement>("video")!;
    mockRect(video, { left: 240, top: 40, width: 480, height: 700 });
    const snapshot: Snapshot = {
      page_type: "video_detail",
      page_url: "https://www.tiktok.com/@creator/video/7111111111111111111",
      video_id: "7111111111111111111",
      author: { nickname: "示例作者", unique_id: "creator" },
      description: "字段回归固定数据",
      created_at: 1_753_027_200,
      publish_time_text: "3天前",
      duration_seconds: 42,
      metrics: {
        play_count: 3_100_000,
        like_count: 147_300,
        comment_count: 7_794,
        collect_count: 898,
        share_count: 766,
      },
      extraction: { source: "fixture", confidence: "high" },
      field_evidence: {
        "metrics.play_count": {
          value: 3_100_000,
          source: "fixture:registry",
          confidence: "high",
          raw_value: 3_100_000,
        },
      },
      raw_data: { marker: "不可修改" },
    };
    const before = structuredClone(snapshot);
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;

    overlay.render(snapshot, { video });

    expect(snapshot).toEqual(before);
  });
});
