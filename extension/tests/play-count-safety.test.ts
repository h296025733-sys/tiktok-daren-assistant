import { describe, expect, it } from "vitest";

import type { ActiveVideoContext } from "../src/extractors";
import { extractDomDataWithDiagnostics } from "../src/extractors/dom";
import { mockRect, mockVideoState } from "./helpers";

describe("首页播放量危险兜底保护", () => {
  it("拒绝全屏按钮 00、vidIQ 百分比，也不把点赞量当播放量", () => {
    document.body.innerHTML = `
      <article id="current-card" data-e2e="recommend-list-item-container">
        <a href="/@author/video/7111111111111111111"><video id="video"></video></a>
        <button aria-label="以全螢幕觀看"><span>00</span></button>
        <div title="Stats by vidIQ"><span>2%</span></div>
        <strong data-e2e="browse-like-count">38.9M</strong>
      </article>
    `;
    const root = document.querySelector<HTMLElement>("#current-card")!;
    const video = document.querySelector<HTMLVideoElement>("#video")!;
    mockRect(video, { left: 240, top: 40, width: 480, height: 700 });
    mockVideoState(video, { paused: false, readyState: 4, duration: 12 });
    const context: ActiveVideoContext = {
      video,
      mediaElement: video,
      contentType: "video",
      activeRoot: root,
      videoId: "7111111111111111111",
      videoIdSource: "fixture",
      permalink: "https://www.tiktok.com/@author/video/7111111111111111111",
      authorUniqueId: "author",
      visibleRatio: 1,
      score: 100,
      candidateCount: 1,
      rootSignature: "article#current-card",
      identity: "video:7111111111111111111:fixture:0",
    };

    const result = extractDomDataWithDiagnostics(context);

    expect(result.fields["metrics.play_count"]).toBeUndefined();
    expect(result.fields["metrics.like_count"]?.value).toBe(38_900_000);
    expect(result.rejectedPlayCountCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "semantic_play_count_forbidden" }),
      ]),
    );
    expect(
      result.rejectedPlayCountCandidates.some((candidate) =>
        String(candidate.raw_value).includes("2%"),
      ),
    ).toBe(true);
  });

  it("活跃视频根外的第三方浮层不进入字段或拒绝候选", () => {
    document.body.innerHTML = `
      <div id="third-party" style="position:fixed;z-index:9999">播放 999M · 点赞 88M</div>
      <article id="current-card" data-e2e="recommend-list-item-container">
        <a href="/@author/video/7111111111111111111"><video id="video"></video></a>
        <strong data-e2e="browse-like-count">12.3K</strong>
      </article>
    `;
    const root = document.querySelector<HTMLElement>("#current-card")!;
    const video = document.querySelector<HTMLVideoElement>("#video")!;
    mockRect(video, { left: 240, top: 40, width: 480, height: 700 });
    mockVideoState(video, { paused: false, readyState: 4, duration: 12 });
    const result = extractDomDataWithDiagnostics({
      video,
      mediaElement: video,
      contentType: "video",
      activeRoot: root,
      videoId: "7111111111111111111",
      videoIdSource: "fixture",
      permalink: "https://www.tiktok.com/@author/video/7111111111111111111",
      authorUniqueId: "author",
      visibleRatio: 1,
      score: 100,
      candidateCount: 1,
      rootSignature: "article#current-card",
      identity: "video:7111111111111111111:fixture:0",
    });

    expect(JSON.stringify(result)).not.toContain("999M");
    expect(result.fields["metrics.play_count"]).toBeUndefined();
    expect(result.fields["metrics.like_count"]?.value).toBe(12_300);
  });
});
