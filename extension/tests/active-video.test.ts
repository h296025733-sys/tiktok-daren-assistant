import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { ActiveVideoResolver } from "../src/extractors/activeVideo";
import { extractCurrentPage } from "../src/extractors";
import { mockRect, mockVideoState } from "./helpers";

const fixture = readFileSync(resolve(process.cwd(), "tests/fixtures/two-video-cards.html"), "utf8");

describe("ActiveVideoResolver 与 activeRoot 作用域", () => {
  beforeEach(() => {
    document.body.innerHTML = fixture;
    window.history.replaceState({}, "", "/");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_200 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  });

  it("忽略排在前面的隐藏大数值卡片，只提取当前可见卡片", () => {
    const hidden = document.querySelector<HTMLVideoElement>("#hidden-video")!;
    const visible = document.querySelector<HTMLVideoElement>("#visible-video")!;
    mockRect(hidden, { left: 300, top: 80, width: 420, height: 620 });
    mockRect(visible, { left: 360, top: 70, width: 420, height: 650 });
    mockVideoState(hidden, { paused: false, readyState: 4, duration: 99 });
    mockVideoState(visible, { paused: false, readyState: 4, duration: 10 });

    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(hidden, 1);
    resolver.setVisibilityRatio(visible, 0.96);
    const active = resolver.resolve();

    expect(active?.video).toBe(visible);
    expect(active?.activeRoot.id).toBe("visible-card");
    expect(active?.candidateCount).toBe(2);
    const snapshot = extractCurrentPage({
      pageUrl: "https://www.tiktok.com/",
      activeVideo: active,
      switchCount: 0,
      activeChanged: true,
    });
    expect(snapshot.page_type).toBe("home_feed");
    expect(snapshot.video_id).toBe("7664439098098109716");
    // 首页的可见数字没有通过 video_id Registry 绑定时，阶段 1.2 宁可返回 null。
    expect(snapshot.metrics.play_count).toBeNull();
    expect(snapshot.metrics.play_count).not.toBe(10_200_000);
    expect(snapshot.metrics.like_count).toBe(65);
    expect(snapshot.metrics.collect_count).toBe(0);
    expect(snapshot.duration_seconds).toBe(10);
    expect(snapshot.author.nickname).toBe("Boomskill");
    expect(snapshot.publish_time_text).toBe("5小时前");
    expect(snapshot.field_evidence["metrics.play_count"]).toBeUndefined();
  });

  it("两个视频同时可见时，按可见比例、中心和播放状态选择活跃视频", () => {
    const firstCard = document.querySelector<HTMLElement>("#hidden-card")!;
    const first = document.querySelector<HTMLVideoElement>("#hidden-video")!;
    const second = document.querySelector<HTMLVideoElement>("#visible-video")!;
    firstCard.style.display = "block";
    mockRect(first, { left: 10, top: 40, width: 260, height: 360 });
    mockRect(second, { left: 380, top: 60, width: 430, height: 660 });
    mockVideoState(first, { paused: true, readyState: 2, duration: 99 });
    mockVideoState(second, { paused: false, readyState: 4, duration: 10 });
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(first, 0.35);
    resolver.setVisibilityRatio(second, 0.95);

    const active = resolver.resolve();
    expect(active?.video).toBe(second);
    expect(active?.videoId).toBe("7664439098098109716");
  });

  it("未知容器结构下不跨到离屏但仍参与布局的另一张卡片读取大数值", () => {
    document.body.innerHTML = `
      <main id="unknown-feed">
        <section id="card-a"><video id="video-a"></video><span data-e2e="video-views">10.2M</span></section>
        <section id="card-b"><video id="video-b"></video><span data-e2e="video-views">1.3K</span></section>
      </main>
    `;
    const videoA = document.querySelector<HTMLVideoElement>("#video-a")!;
    const videoB = document.querySelector<HTMLVideoElement>("#video-b")!;
    mockRect(videoA, { left: 20, top: -900, width: 260, height: 480 });
    mockRect(videoB, { left: 360, top: 50, width: 440, height: 680 });
    mockVideoState(videoA, { paused: true, readyState: 2, duration: 99 });
    mockVideoState(videoB, { paused: false, readyState: 4, duration: 10 });
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(videoA, 0.45);
    resolver.setVisibilityRatio(videoB, 1);

    const active = resolver.resolve()!;
    expect(active.video).toBe(videoB);
    expect(active.activeRoot.id).toBe("card-b");
    expect(active.activeRoot.contains(videoA)).toBe(false);
    const snapshot = extractCurrentPage({
      pageUrl: "https://www.tiktok.com/",
      activeVideo: active,
      switchCount: 0,
      activeChanged: true,
    });
    expect(snapshot.metrics.play_count).toBeNull();
    expect(snapshot.metrics.play_count).not.toBe(10_200_000);
  });

  it("两个可见视频直接共享父容器时宁可返回空字段，也不跨视频猜数值", () => {
    document.body.innerHTML = `
      <main id="shared-parent">
        <video id="video-a"></video><video id="video-b"></video>
        <span data-e2e="video-views">10.2M</span><span data-e2e="video-views">1.3K</span>
      </main>
    `;
    const videoA = document.querySelector<HTMLVideoElement>("#video-a")!;
    const videoB = document.querySelector<HTMLVideoElement>("#video-b")!;
    mockRect(videoA, { left: 20, top: 80, width: 260, height: 480 });
    mockRect(videoB, { left: 360, top: 50, width: 440, height: 680 });
    mockVideoState(videoA, { paused: true, readyState: 2, duration: 99 });
    mockVideoState(videoB, { paused: false, readyState: 4, duration: 10 });
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(videoA, 0.45);
    resolver.setVisibilityRatio(videoB, 1);

    const active = resolver.resolve()!;
    expect(active.video).toBe(videoB);
    expect(active.activeRoot).toBe(videoB);
    const snapshot = extractCurrentPage({
      pageUrl: "https://www.tiktok.com/",
      activeVideo: active,
      switchCount: 0,
      activeChanged: true,
    });
    expect(snapshot.metrics.play_count).toBeNull();
  });

  it("详情弹层与背景视频同时可见时优先选择前景弹层", () => {
    document.body.innerHTML = `
      <article id="background" data-e2e="recommend-list-item-container">
        <a href="/@background/video/7111111111111111111"><video id="background-video"></video></a>
      </article>
      <div id="dialog" role="dialog" style="z-index:1000">
        <div data-e2e="browse-video">
          <a href="/@foreground/video/7222222222222222222"><video id="dialog-video"></video></a>
        </div>
      </div>
    `;
    const background = document.querySelector<HTMLVideoElement>("#background-video")!;
    const foreground = document.querySelector<HTMLVideoElement>("#dialog-video")!;
    mockRect(background, { left: 300, top: 30, width: 500, height: 720 });
    mockRect(foreground, { left: 420, top: 130, width: 300, height: 480 });
    mockVideoState(background, { paused: false, readyState: 4, duration: 20 });
    mockVideoState(foreground, { paused: true, readyState: 2, duration: 8 });
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(background, 1);
    resolver.setVisibilityRatio(foreground, 0.55);

    const active = resolver.resolve()!;
    expect(active.video).toBe(foreground);
    expect(active.videoId).toBe("7222222222222222222");
    expect(active.video?.closest('[role="dialog"]')).not.toBeNull();
  });

  it("同一 video 元素复用且没有视频 ID 时，内容变化会生成新临时身份", () => {
    document.body.innerHTML = `
      <article data-e2e="recommend-list-item-container">
        <video id="reused-video" src="https://cdn.example/first.mp4?token=a"></video>
        <p data-e2e="browse-video-desc">第一条不同内容描述</p>
      </article>
    `;
    const video = document.querySelector<HTMLVideoElement>("#reused-video")!;
    const description = document.querySelector<HTMLElement>('[data-e2e="browse-video-desc"]')!;
    mockRect(video, { left: 350, top: 60, width: 440, height: 680 });
    mockVideoState(video, { paused: false, readyState: 4, duration: 10 });
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(video, 1);
    const first = resolver.resolve()!;

    description.textContent = "第二条已经切换的内容描述";
    video.setAttribute("src", "https://cdn.example/second.mp4?token=b");
    resolver.bumpRevision(video);
    const second = resolver.resolve()!;

    expect(first.videoId).toBeNull();
    expect(second.videoId).toBeNull();
    expect(second.identity).not.toBe(first.identity);
  });

  it("视频附近的强 ID 属性优先于业务根上的通用 data-id", () => {
    document.body.innerHTML = `
      <article data-e2e="recommend-list-item-container" data-id="7111111111111111111">
        <div data-video-id="7222222222222222222"><video id="video"></video></div>
      </article>
    `;
    const video = document.querySelector<HTMLVideoElement>("#video")!;
    mockRect(video, { left: 350, top: 60, width: 440, height: 680 });
    mockVideoState(video, { paused: false, readyState: 4, duration: 10 });
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(video, 1);

    const active = resolver.resolve()!;
    expect(active.videoId).toBe("7222222222222222222");
    expect(active.videoIdSource).toBe("active_root:data-video-id");
  });

  it("video 兄弟节点上的唯一强 ID 可识别，多个强 ID 时拒绝猜测", () => {
    document.body.innerHTML = `
      <article id="card" data-e2e="recommend-list-item-container">
        <video id="video"></video>
        <div data-item-id="7333333333333333333"></div>
        <strong data-e2e="browse-like-count">420.1K</strong>
      </article>
    `;
    const video = document.querySelector<HTMLVideoElement>("#video")!;
    mockRect(video, { left: 350, top: 60, width: 440, height: 680 });
    mockVideoState(video, { paused: false, readyState: 4, duration: 14 });
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(video, 1);

    expect(resolver.resolve()).toMatchObject({
      videoId: "7333333333333333333",
      videoIdSource: "active_root:unique_scoped_data-item-id",
    });

    document.querySelector("#card")?.insertAdjacentHTML(
      "beforeend",
      '<div data-aweme-id="7444444444444444444"></div>',
    );
    expect(resolver.resolve()?.videoId).toBeNull();
  });

  it("图文详情没有 video 时选择当前可见轮播，而不是下一条离屏视频", () => {
    window.history.replaceState({}, "", "/@heymistr_/photo/7208204190806560006?image_index=6");
    document.body.innerHTML = `
      <article id="photo" data-e2e="recommend-list-item-container">
        <div data-e2e="photo-mode">
          <img id="photo-main" src="https://p16.test/current.jpg" alt="当前图文">
          <img src="https://p16.test/next.jpg" alt="下一张">
        </div>
        <strong data-e2e="like-count">17K</strong>
        <strong data-e2e="comment-count">122</strong>
        <strong data-e2e="favorite-count">5048</strong>
        <strong data-e2e="share-count">2302</strong>
      </article>
      <article data-e2e="recommend-list-item-container"><video id="offscreen"></video></article>
    `;
    const root = document.querySelector<HTMLElement>("#photo")!;
    const image = document.querySelector<HTMLImageElement>("#photo-main")!;
    const offscreen = document.querySelector<HTMLVideoElement>("#offscreen")!;
    mockRect(root, { left: 88, top: 0, width: 535, height: 698 });
    mockRect(image, { left: 88, top: 0, width: 535, height: 698 });
    mockRect(offscreen, { left: 88, top: 820, width: 535, height: 698 });
    mockVideoState(offscreen, { paused: true, readyState: 2, duration: 10 });

    const active = new ActiveVideoResolver(document, window).resolve();

    expect(active).toMatchObject({
      contentType: "photo",
      video: null,
      mediaElement: image,
      activeRoot: root,
      videoId: "7208204190806560006",
      videoIdSource: "page_url:media_id",
    });
  });
});
