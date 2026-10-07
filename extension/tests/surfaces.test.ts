import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  detectSurfaceMode,
  resolveHomeActiveVideo,
  resolveHoveredCard,
  resolveVideoCards,
  resolveVideoDetailContext,
} from "../src/extractors/surfaces";
import type { ActiveVideoContext } from "../src/extractors/activeVideo";
import { mockVideoState } from "./helpers";

const profileFixture = readFileSync(
  resolve(process.cwd(), "tests/fixtures/profile-three-cards.html"),
  "utf8",
);
const detailFixture = readFileSync(
  resolve(process.cwd(), "tests/fixtures/video-detail-composite.html"),
  "utf8",
);

describe("SurfaceMode", () => {
  it.each([
    ["https://www.tiktok.com/", "home_feed"],
    ["https://www.tiktok.com/@tester/video/7111111111111111111", "video_detail"],
    ["https://www.tiktok.com/@tester/photo/7111111111111111112", "video_detail"],
    ["https://www.tiktok.com/photo/7111111111111111113", "video_detail"],
    ["https://www.tiktok.com/@tester", "profile_grid"],
    ["https://www.tiktok.com/search?q=test", "search_grid"],
    ["https://www.tiktok.com/tag/test", "hashtag_grid"],
    ["https://www.tiktok.com/music/test-123", "music_grid"],
  ] as const)("%s => %s", (url, expected) => {
    expect(detectSurfaceMode(url)).toBe(expected);
  });

  it("首页封装拒绝整个 profile 网格作为 activeRoot", () => {
    document.body.innerHTML = profileFixture;
    const grid = document.querySelector<HTMLElement>('[data-e2e="user-post-item-list"]')!;
    const video = document.createElement("video");
    grid.append(video);
    const context = {
      video,
      mediaElement: video,
      contentType: "video",
      activeRoot: grid,
      videoId: null,
      videoIdSource: null,
      permalink: null,
      authorUniqueId: null,
      visibleRatio: 1,
      score: 100,
      candidateCount: 1,
      rootSignature: "grid",
      identity: "wrong-grid",
    } satisfies ActiveVideoContext;

    expect(resolveHomeActiveVideo({ resolve: () => context })).toBeNull();
  });
});

describe("profile 网格单卡上下文", () => {
  beforeEach(() => {
    document.body.innerHTML = profileFixture;
    const preview = document.querySelector<HTMLVideoElement>("#preview-c")!;
    mockVideoState(preview, { paused: true, readyState: 4, duration: 42 });
  });

  it("三张卡片严格绑定自身 /video/id 和自身 video-views", () => {
    const cards = resolveVideoCards(document, "profile_grid");

    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.playCount.value)).toEqual([3_100_000, 247_300, 125_700]);
    expect(cards.every((card) => card.cardRoot.id !== "profile-grid")).toBe(true);
    expect(cards.every((card) => card.cardRoot.getAttribute("data-e2e") === "user-post-item")).toBe(true);
    expect(cards.every((card) => card.cardRoot.querySelectorAll('a[href*="/video/"]').length === 1)).toBe(
      true,
    );
  });

  it("悬浮卡片 C 只能返回 125.7K，不能读取 A 的 3.1M", () => {
    const cards = resolveVideoCards(document, "profile_grid");
    const hovered = resolveHoveredCard(cards);

    expect(hovered?.cardRoot.id).toBe("card-c");
    expect(hovered?.videoId).toBe("7333333333333333333");
    expect(hovered?.playCount.value).toBe(125_700);
    expect(hovered?.playCount.value).not.toBe(3_100_000);
    expect(hovered?.durationSeconds).toBe(42);
  });

  it("事件目标精确选择对应卡片，不依赖页面唯一 video", () => {
    const cards = resolveVideoCards(document, "profile_grid");
    const target = document.querySelector<HTMLElement>("#card-b strong")!;
    const hovered = resolveHoveredCard(cards, target);

    expect(hovered?.cardRoot.id).toBe("card-b");
    expect(hovered?.playCount.value).toBe(247_300);
  });

  it("没有 video 元素的 /photo/id 图文卡也会按自身 ID 和播放量解析", () => {
    const grid = document.querySelector<HTMLElement>('[data-e2e="user-post-item-list"]')!;
    grid.insertAdjacentHTML("beforeend", `
      <article id="card-photo" data-e2e="user-post-item">
        <a href="/@photo_creator/photo/7444444444444444444"><img src="https://p16.example/photo.jpg" alt="图文封面"></a>
        <strong data-e2e="video-views">88.6K</strong>
      </article>
    `);

    const photo = resolveVideoCards(document, "profile_grid")
      .find((card) => card.videoId === "7444444444444444444");
    expect(photo?.cardRoot.id).toBe("card-photo");
    expect(photo?.contentType).toBe("photo");
    expect(photo?.videoLinkPathname).toBe("/@photo_creator/photo/7444444444444444444");
    expect(photo?.authorUniqueId).toBe("photo_creator");
    expect(photo?.playCount.value).toBe(88_600);
    expect(photo?.hoverVideo).toBeNull();
    expect(photo?.coverUrl).toContain("photo.jpg");
  });
});

describe("video_detail 组合上下文", () => {
  beforeEach(() => {
    document.body.innerHTML = detailFixture;
    const video = document.querySelector<HTMLVideoElement>("#detail-video")!;
    mockVideoState(video, { paused: false, readyState: 4, duration: 40 });
  });

  it("用 URL ID 组合媒体、元数据与动作兄弟根，不跨到推荐卡", () => {
    const context = resolveVideoDetailContext(
      "https://www.tiktok.com/@user9041729790596/video/7648204047693909278",
      document,
    );

    expect(context?.videoId).toBe("7648204047693909278");
    expect(context?.videoIdSource).toBe("page_url");
    expect(context?.pageRoot?.id).toBe("detail-page");
    expect(context?.mediaRoot?.id).toBe("media");
    expect(context?.metadataRoot?.id).toBe("metadata");
    expect(context?.actionRoot?.id).toBe("actions");
    expect(context?.metadataRoot?.textContent).toContain("当前详情视频描述");
    expect(context?.actionRoot?.textContent).toContain("47.3K");
    expect(context?.actionRoot?.textContent).not.toContain("99M");
    expect(context?.metadataRoot?.textContent).not.toContain("推荐视频");
  });

  it("URL 没有 /video/id 时不创建详情上下文", () => {
    expect(resolveVideoDetailContext("https://www.tiktok.com/@user9041729790596", document)).toBeNull();
  });

  it("/photo/id 被识别为详情，并在没有 video 时组合图文媒体、元数据和动作根", () => {
    document.body.innerHTML = `
      <section id="photo-detail" data-e2e="photo-detail" data-item-id="7555555555555555555">
        <div id="photo-media" data-e2e="photo-viewer"><img src="https://p16.example/current-photo.jpg" alt="当前图文"></div>
        <aside id="photo-metadata">
          <a data-e2e="browse-username" href="/@photo_creator/photo/7555555555555555555">photo_creator</a>
          <p data-e2e="browse-video-desc">当前图文描述</p>
          <time data-e2e="video-publish-time">2026-07-20</time>
        </aside>
        <div id="photo-actions">
          <strong data-e2e="browse-like-count">12.5K</strong>
          <strong data-e2e="browse-comment-count">86</strong>
          <strong data-e2e="browse-bookmark-count">703</strong>
          <strong data-e2e="browse-share-count">42</strong>
        </div>
        <article data-e2e="user-post-item"><a href="/@other/video/7999999999999999999"><img alt="推荐视频"></a><strong data-e2e="browse-like-count">99M</strong></article>
      </section>
    `;

    const context = resolveVideoDetailContext(
      "https://www.tiktok.com/@photo_creator/photo/7555555555555555555",
      document,
    );
    expect(context?.videoId).toBe("7555555555555555555");
    expect(context?.contentType).toBe("photo");
    expect(context?.video).toBeNull();
    expect(context?.pageRoot?.id).toBe("photo-detail");
    expect(context?.mediaRoot?.id).toBe("photo-media");
    expect(context?.metadataRoot?.id).toBe("photo-metadata");
    expect(context?.actionRoot?.id).toBe("photo-actions");
    expect(context?.metadataRoot?.textContent).toContain("当前图文描述");
    expect(context?.actionRoot?.textContent).not.toContain("99M");
  });

  it.each([
    "favorite-count",
    "browse-favorite-count",
    "collect-count",
    "browse-collect-count",
  ])("仅有 %s 时仍能定位详情动作根", (metricSelector) => {
    const photoId = "7555555555555555555";
    document.body.innerHTML = `
      <section data-e2e="photo-detail" data-item-id="${photoId}">
        <div data-e2e="photo-viewer"><img src="https://p16.example/current-photo.jpg"></div>
        <a data-e2e="browse-username" href="/@photo_creator/photo/${photoId}">photo_creator</a>
        <div id="favorite-action"><strong data-e2e="${metricSelector}">703</strong></div>
      </section>
    `;

    const context = resolveVideoDetailContext(
      `https://www.tiktok.com/@photo_creator/photo/${photoId}`,
      document,
    );

    expect(context?.actionRoot?.getAttribute("data-e2e")).toBe(metricSelector);
    expect(context?.actionRoot?.textContent).toBe("703");
  });

  it("最近媒体 strong root 只有单一信号时继续向外组合兄弟元数据和动作区", () => {
    document.body.innerHTML = `
      <section id="detail-shell" data-e2e="video-detail" data-video-id="7648204047693909278">
        <div id="near-media" data-e2e="browse-video-container">
          <a data-e2e="browse-username" href="/@current/video/7648204047693909278">current</a>
          <div data-e2e="browse-video"><video id="nested-video"></video></div>
        </div>
        <aside id="sibling-metadata">
          <strong data-e2e="browser-nickname">Current Creator</strong>
          <p data-e2e="browse-video-desc">兄弟容器中的当前详情描述</p>
        </aside>
        <div id="sibling-actions" data-e2e="video-actions">
          <strong data-e2e="browse-like-count">47.3K</strong>
          <strong data-e2e="browse-comment-count">71</strong>
        </div>
      </section>
    `;
    const video = document.querySelector<HTMLVideoElement>("#nested-video")!;
    mockVideoState(video, { paused: false, readyState: 4, duration: 40 });

    const context = resolveVideoDetailContext(
      "https://www.tiktok.com/@current/video/7648204047693909278",
      document,
    );

    expect(context?.pageRoot?.id).toBe("detail-shell");
    expect(context?.pageRoot?.id).not.toBe("near-media");
    expect(context?.metadataRoot?.textContent).toContain("兄弟容器中的当前详情描述");
    expect(context?.actionRoot?.id).toBe("sibling-actions");
    expect(context?.actionRoot?.textContent).toContain("47.3K");
  });
});
