import { beforeEach, describe, expect, it } from "vitest";

import { ActiveVideoResolver } from "../src/extractors/activeVideo";
import { extractCurrentPage } from "../src/extractors";
import { ActiveVideoSession } from "../src/content/session";
import { mockRect, mockVideoState } from "./helpers";

const pageUrl = "https://www.tiktok.com/";

describe("URL 不变时的活跃视频切换", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <article id="card-a" data-e2e="recommend-list-item-container">
        <a href="/@a/video/7111111111111111111"><video id="video-a"></video></a>
        <span data-e2e="video-views">1.3K</span>
        <span data-e2e="browse-comment-count">3</span>
      </article>
      <article id="card-b" data-e2e="recommend-list-item-container" style="display:none">
        <a href="/@b/video/7222222222222222222"><video id="video-b"></video></a>
        <span data-e2e="video-views">63.5K</span>
      </article>
    `;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_200 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  });

  it("A 切到 B 后立即清空 A 缓存，并返回 B 的数据", () => {
    const videoA = document.querySelector<HTMLVideoElement>("#video-a")!;
    const videoB = document.querySelector<HTMLVideoElement>("#video-b")!;
    const cardA = document.querySelector<HTMLElement>("#card-a")!;
    const cardB = document.querySelector<HTMLElement>("#card-b")!;
    mockRect(videoA, { left: 300, top: 60, width: 440, height: 680 });
    mockRect(videoB, { left: 300, top: 60, width: 440, height: 680 });
    mockVideoState(videoA, { paused: false, readyState: 4, duration: 10 });
    mockVideoState(videoB, { paused: true, readyState: 4, duration: 8 });

    const resolver = new ActiveVideoResolver(document, window);
    const session = new ActiveVideoSession();
    resolver.setVisibilityRatio(videoA, 1);
    resolver.setVisibilityRatio(videoB, 0);
    const activeA = resolver.resolve()!;
    expect(session.observe(activeA.identity)).toBe(true);
    const snapshotA = extractCurrentPage({
      pageUrl,
      activeVideo: activeA,
      switchCount: session.switchCount,
      activeChanged: true,
    });
    session.store(activeA.identity, snapshotA);
    expect(session.get(activeA.identity, pageUrl)?.metrics.comment_count).toBe(3);

    expect(session.observe(null)).toBe(true);
    expect(session.switchCount).toBe(0);
    cardA.style.display = "none";
    cardB.style.display = "block";
    Object.defineProperty(videoA, "paused", { configurable: true, value: true });
    Object.defineProperty(videoB, "paused", { configurable: true, value: false });
    resolver.setVisibilityRatio(videoA, 0);
    resolver.setVisibilityRatio(videoB, 1);
    const activeB = resolver.resolve()!;

    expect(activeB.identity).not.toBe(activeA.identity);
    expect(session.observe(activeB.identity)).toBe(true);
    expect(session.switchCount).toBe(1);
    expect(session.get(activeA.identity, pageUrl)).toBeNull();
    expect(session.get(activeB.identity, pageUrl)).toBeNull();
    const snapshotB = extractCurrentPage({
      pageUrl,
      activeVideo: activeB,
      switchCount: session.switchCount,
      activeChanged: true,
    });
    expect(snapshotB.video_id).toBe("7222222222222222222");
    expect(snapshotB.metrics.play_count).toBeNull();
    expect(snapshotB.metrics.comment_count).toBeNull();
    expect(snapshotB.video_id).not.toBe(snapshotA.video_id);
  });

  it("同一 video 已切到 B 但链接仍是 A 时丢弃冲突 ID，不回填 A 的结构化数据", () => {
    document.body.innerHTML = `
      <article data-e2e="recommend-list-item-container">
        <a href="/@author/video/7111111111111111111">
          <video id="reused" src="https://cdn.example/a.mp4"></video>
        </a>
        <span data-e2e="video-views">1.3K</span>
      </article>
      <script id="SIGI_STATE" type="application/json">${JSON.stringify({
        ItemModule: {
          "7111111111111111111": {
            id: "7111111111111111111",
            stats: { playCount: 10_200_000 },
            video: { playAddr: "https://cdn.example/a.mp4", duration: 9 },
          },
          "7222222222222222222": {
            id: "7222222222222222222",
            stats: { playCount: 63_500 },
            video: { playAddr: "https://cdn.example/b.mp4", duration: 8 },
          },
        },
      })}</script>
    `;
    const video = document.querySelector<HTMLVideoElement>("#reused")!;
    mockRect(video, { left: 320, top: 50, width: 440, height: 680 });
    mockVideoState(video, { paused: false, readyState: 4, duration: 8 });
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(video, 1);
    const activeA = resolver.resolve()!;

    video.setAttribute("src", "https://cdn.example/b.mp4");
    resolver.bumpRevision(video);
    const activeDuringSwitch = resolver.resolve()!;
    const snapshot = extractCurrentPage({
      pageUrl,
      activeVideo: activeDuringSwitch,
      switchCount: 1,
      activeChanged: true,
    });

    expect(activeDuringSwitch.videoId).toBe("7111111111111111111");
    expect(activeDuringSwitch.identity).not.toBe(activeA.identity);
    expect(snapshot.video_id).toBeNull();
    expect(snapshot.metrics.play_count).toBeNull();
    expect(snapshot.metrics.play_count).not.toBe(10_200_000);
    expect(snapshot.raw_data.video_id_conflict).toEqual({
      active_root_id: "7111111111111111111",
      structured_media_id: "7222222222222222222",
      action: "discarded_both_ids",
    });
  });
});
