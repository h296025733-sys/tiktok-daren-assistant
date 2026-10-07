import { describe, expect, it } from "vitest";

import { selectGridCardsForBatch } from "../src/content/batchSelection";
import {
  batchDownloadPollingTimeoutMs,
  limitBatchDownloadItems,
} from "../src/downloads/batchLimit";

const cards = [
  { videoId: "video-a", contentType: "video" as const, marker: "A" },
  { videoId: "photo-b", contentType: "photo" as const, marker: "B" },
  { videoId: "video-c", contentType: "video" as const, marker: "C" },
  { videoId: "video-a", contentType: "video" as const, marker: "duplicate" },
];

describe("批量下载卡片范围", () => {
  it("达人页严格沿用当前筛选和排序结果", () => {
    expect(selectGridCardsForBatch(cards, [
      { video_id: "video-c" },
      { video_id: "missing" },
      { video_id: "photo-b" },
      { video_id: "video-a" },
    ]).map((card) => card.marker)).toEqual(["C", "A"]);
  });

  it("取消全选的空范围不会退回整页，其他网格则保留识别顺序", () => {
    expect(selectGridCardsForBatch(cards, [])).toEqual([]);
    expect(selectGridCardsForBatch(cards).map((card) => card.marker)).toEqual(["A", "C"]);
  });

  it("keeps all 70 selected videos in the toolbar order", () => {
    const seventyCards = Array.from({ length: 70 }, (_, index) => ({
      videoId: `video-${index}`,
      contentType: "video" as const,
      marker: index,
    }));
    const toolbarOrder = seventyCards
      .map((card) => ({ video_id: card.videoId }))
      .reverse();

    const selected = selectGridCardsForBatch(seventyCards, toolbarOrder);
    const batch = limitBatchDownloadItems(selected);

    expect(batch.items.map((item) => item.marker)).toEqual(
      Array.from({ length: 70 }, (_, index) => 69 - index),
    );
    expect(batch.totalAvailable).toBe(70);
    expect(batch.truncated).toBe(false);
  });

  it("用户选择多少条就保留多少条，不再静默截断", () => {
    const candidates = Array.from({ length: 1_200 }, (_, index) => index);
    const batch = limitBatchDownloadItems(candidates);

    expect(batch.items).toHaveLength(1_200);
    expect(batch.items.at(-1)).toBe(1_199);
    expect(batch.totalAvailable).toBe(1_200);
    expect(batch.truncated).toBe(false);
  });

  it("extends polling for a 70-item job instead of abandoning it at 30 minutes", () => {
    expect(batchDownloadPollingTimeoutMs(70)).toBe(105 * 60_000);
  });
});
