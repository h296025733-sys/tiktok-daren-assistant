import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { ActiveVideoSession } from "../src/content/session";
import { ActiveVideoResolver } from "../src/extractors/activeVideo";
import {
  collectGridCardPage,
  collectHomePage,
  collectHomeRegistrySnapshot,
  collectVideoDetailPage,
} from "../src/extractors/pageData";
import {
  resolveHomeActiveVideo,
  resolveVideoCards,
  resolveVideoDetailContext,
} from "../src/extractors/surfaces";
import { VideoItemRegistry } from "../src/registry/videoItemRegistry";
import { mockRect, mockVideoState } from "./helpers";

const DETAIL_ID = "7648204047693909278";
const VIDEO_A = "7111111111111111111";
const VIDEO_B = "7222222222222222222";
const detailFixture = readFileSync(
  resolve(process.cwd(), "tests/fixtures/video-detail-composite.html"),
  "utf8",
);
const coarseHomeFixture = readFileSync(
  resolve(process.cwd(), "tests/fixtures/home-feed-coarse-metrics.html"),
  "utf8",
);
const closedCommentsDurationDriftFixture = readFileSync(
  resolve(process.cwd(), "tests/fixtures/home-feed-closed-comments-duration-drift.html"),
  "utf8",
);

describe("pageData video detail composite binding", () => {
  beforeEach(() => {
    document.body.innerHTML = detailFixture;
    const video = document.querySelector<HTMLVideoElement>("#detail-video")!;
    mockVideoState(video, { paused: false, readyState: 4, duration: 40 });
  });

  it("combines registry, metadata, actions and media while excluding recommendation numbers", () => {
    const pageUrl = `https://www.tiktok.com/@user9041729790596/video/${DETAIL_ID}`;
    const context = resolveVideoDetailContext(pageUrl, document)!;
    const registry = new VideoItemRegistry();
    registry.upsert(
      {
        video_id: DETAIL_ID,
        created_at: 1_720_000_000,
        metrics: { play_count: 4_600_000 },
      },
      "hydration_json",
    );
    registry.upsert(
      {
        video_id: "7999999999999999999",
        description: "recommendation must stay isolated",
        metrics: { play_count: 99_000_000, like_count: 99_000_000 },
      },
      "hydration_json",
    );

    const result = collectVideoDetailPage(context, registry);
    const metadataText = document.querySelector<HTMLElement>("#metadata")!.textContent!;

    expect(result.snapshot).toMatchObject({
      page_type: "video_detail",
      page_url: pageUrl,
      video_id: DETAIL_ID,
      created_at: 1_720_000_000,
      duration_seconds: 40,
      metrics: {
        play_count: 4_600_000,
        like_count: 47_300,
        comment_count: 71,
        collect_count: 898,
        share_count: 766,
      },
    });
    expect(result.snapshot.author.unique_id).toBe("user9041729790596");
    expect(result.snapshot.author.nickname).not.toBeNull();
    expect(metadataText).toContain(result.snapshot.author.nickname!);
    expect(result.snapshot.description).not.toBeNull();
    expect(metadataText).toContain(result.snapshot.description!);
    expect(result.snapshot.metrics.like_count).not.toBe(99_000_000);
    expect(result.snapshot.field_evidence["metrics.play_count"]?.source).toBe(
      "registry:hydration_json",
    );
    expect(result.context).toMatchObject({
      media_root: 'div[data-e2e="browse-video"]#media',
      metadata_root: 'div[data-e2e="video-info"]#metadata',
      action_root: 'div[data-e2e="video-actions"]#actions',
      page_root: 'section[data-e2e="video-detail"]#detail-page',
      video_id_source: "page_url",
    });
  });

  it("uses only URL video B even when DOM and registry also contain a larger video A", () => {
    const pageUrl = `https://www.tiktok.com/@creator_b/video/${VIDEO_B}`;
    document.body.innerHTML = `
      <main data-e2e="video-detail" data-video-id="${VIDEO_B}">
        <div data-e2e="browse-video"><video id="target-video"></video></div>
        <aside>
          <div data-e2e="video-info">
            <a data-e2e="browse-username" href="/@creator_b/video/${VIDEO_B}">creator_b</a>
            <strong data-e2e="browser-nickname">Creator B</strong>
            <p data-e2e="browse-video-desc">B DOM description</p>
          </div>
          <div data-e2e="video-actions"><strong data-e2e="browse-like-count">47.3K</strong></div>
        </aside>
        <article data-e2e="video-card">
          <a href="/@creator_a/video/${VIDEO_A}"><img src="https://cdn.test/a.jpg"></a>
          <strong data-e2e="browse-like-count">99M</strong>
          <p data-e2e="browse-video-desc">A DOM description</p>
        </article>
      </main>
    `;
    const target = document.querySelector<HTMLVideoElement>("#target-video")!;
    mockVideoState(target, { paused: false, readyState: 4, duration: 42 });
    const registry = new VideoItemRegistry();
    registry.upsert(
      {
        video_id: VIDEO_A,
        author: { unique_id: "creator_a" },
        description: "A registry description",
        metrics: { play_count: 99_000_000, like_count: 99_000_000 },
      },
      "hydration_json",
    );
    registry.upsert(
      {
        video_id: VIDEO_B,
        author: { unique_id: "creator_b" },
        description: "B registry description",
        metrics: { play_count: 125_700, like_count: 47_300 },
      },
      "hydration_json",
    );

    const context = resolveVideoDetailContext(pageUrl, document)!;
    const result = collectVideoDetailPage(context, registry);

    expect(context.videoId).toBe(VIDEO_B);
    expect(result.registryRecord?.video_id).toBe(VIDEO_B);
    expect(result.snapshot.video_id).toBe(VIDEO_B);
    expect(result.snapshot.author.unique_id).toBe("creator_b");
    expect(result.snapshot.description).toBe("B registry description");
    expect(result.snapshot.metrics.play_count).toBe(125_700);
    expect(result.snapshot.metrics.like_count).toBe(47_300);
    expect(JSON.stringify(result.snapshot)).not.toContain("A registry description");
    expect(result.snapshot.metrics.play_count).not.toBe(99_000_000);
  });

  it("图文详情无 video 时仍按 photo ID 合并结构化播放量与当前动作指标", () => {
    const photoId = "7555555555555555555";
    const pageUrl = `https://www.tiktok.com/@photo_creator/photo/${photoId}`;
    document.body.innerHTML = `
      <section id="photo-detail" data-e2e="photo-detail" data-item-id="${photoId}">
        <div id="photo-media" data-e2e="photo-viewer"><img src="https://p16.example/photo.jpg" alt="当前图文"></div>
        <aside id="photo-metadata">
          <a data-e2e="browse-username" href="/@photo_creator/photo/${photoId}">photo_creator</a>
          <p data-e2e="browse-video-desc">当前图文描述</p>
          <time data-e2e="video-publish-time">2026-07-20</time>
        </aside>
        <div id="photo-actions">
          <strong data-e2e="browse-like-count">12.5K</strong>
          <strong data-e2e="browse-comment-count">86</strong>
          <strong data-e2e="favorite-count">703</strong>
          <strong data-e2e="browse-share-count">42</strong>
        </div>
      </section>
    `;
    const context = resolveVideoDetailContext(pageUrl, document)!;
    const registry = new VideoItemRegistry();
    registry.upsert({
      video_id: photoId,
      content_type: "photo",
      created_at: 1_721_424_000,
      metrics: { play_count: 131_800 },
    }, "hydration_json");

    const result = collectVideoDetailPage(context, registry);

    expect(result.snapshot).toMatchObject({
      video_id: photoId,
      description: "当前图文描述",
      metrics: {
        play_count: 131_800,
        like_count: 12_500,
        comment_count: 86,
        collect_count: 703,
        share_count: 42,
      },
      raw_data: { content_type: "photo" },
    });
    expect(result.context.media_root).toContain("photo-viewer");
  });

  it("详情页只用当前视频的 TikTok 原生商业披露纠正默认非广告状态", () => {
    const pageUrl = `https://www.tiktok.com/@creator_b/video/${VIDEO_B}`;
    document.body.innerHTML = `
      <main data-e2e="video-detail" data-video-id="${VIDEO_B}">
        <div data-e2e="browse-video"><video id="target-video"></video></div>
        <aside data-e2e="video-info">
          <a data-e2e="browse-username" href="/@creator_b/video/${VIDEO_B}">creator_b</a>
          <p data-e2e="browse-video-desc">ordinary description</p>
          <div data-e2e="search-comment-container">
            <div class="css-live--DivAnchorTagWrapper">符合佣金領取資格</div>
          </div>
        </aside>
        <div data-e2e="video-actions"><strong data-e2e="browse-like-count">47.3K</strong></div>
      </main>
    `;
    const target = document.querySelector<HTMLVideoElement>("#target-video")!;
    mockVideoState(target, { paused: false, readyState: 4, duration: 42 });
    const registry = new VideoItemRegistry();
    registry.upsert({ video_id: VIDEO_B, is_ad: false }, "hydration_json");

    const context = resolveVideoDetailContext(pageUrl, document)!;
    const result = collectVideoDetailPage(context, registry);

    expect(result.snapshot.raw_data.is_ad).toBe(true);
    expect(registry.getItem(VIDEO_B)?.is_ad).toBe(true);
  });

  it("详情页商业披露是元数据区的兄弟节点时仍能识别", () => {
    const pageUrl = `https://www.tiktok.com/@creator_b/video/${VIDEO_B}`;
    document.body.innerHTML = `
      <main data-e2e="video-detail" data-video-id="${VIDEO_B}">
        <div data-e2e="browse-video"><video id="target-video"></video></div>
        <aside data-e2e="video-info">
          <a data-e2e="browse-username" href="/@creator_b/video/${VIDEO_B}">creator_b</a>
          <p data-e2e="browse-video-desc">ordinary description</p>
        </aside>
        <div class="css-live--DivAnchorTagWrapper">符合佣金領取資格</div>
        <div data-e2e="video-actions"><strong data-e2e="browse-like-count">47.3K</strong></div>
      </main>
    `;
    const target = document.querySelector<HTMLVideoElement>("#target-video")!;
    mockVideoState(target, { paused: false, readyState: 4, duration: 42 });
    const registry = new VideoItemRegistry();
    registry.upsert({ video_id: VIDEO_B, is_ad: false }, "hydration_json");

    const context = resolveVideoDetailContext(pageUrl, document)!;
    expect(context.metadataRoot?.contains(document.querySelector(".css-live--DivAnchorTagWrapper"))).toBe(false);

    const result = collectVideoDetailPage(context, registry);
    expect(result.snapshot.raw_data.is_ad).toBe(true);
  });

  it("详情页不会借用相邻推荐卡的商业披露", () => {
    const pageUrl = `https://www.tiktok.com/@creator_b/video/${VIDEO_B}`;
    document.body.innerHTML = `
      <main data-e2e="video-detail" data-video-id="${VIDEO_B}">
        <div data-e2e="browse-video"><video id="target-video"></video></div>
        <aside data-e2e="video-info">
          <a data-e2e="browse-username" href="/@creator_b/video/${VIDEO_B}">creator_b</a>
          <p data-e2e="browse-video-desc">ordinary description</p>
        </aside>
        <article data-e2e="video-card">
          <a href="/@creator_a/video/${VIDEO_A}">related video</a>
          <div data-e2e="sponsored-tag">Paid partnership</div>
        </article>
      </main>
    `;
    const target = document.querySelector<HTMLVideoElement>("#target-video")!;
    mockVideoState(target, { paused: false, readyState: 4, duration: 42 });
    const registry = new VideoItemRegistry();
    registry.upsert({ video_id: VIDEO_B, is_ad: false }, "hydration_json");

    const context = resolveVideoDetailContext(pageUrl, document)!;
    const result = collectVideoDetailPage(context, registry);

    expect(result.snapshot.raw_data.is_ad).toBe(false);
    expect(registry.getItem(VIDEO_B)?.is_ad).toBe(false);
  });
});

describe("pageData home feed switching on the same URL", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <article id="card-a" data-e2e="recommend-list-item-container">
        <a href="/@creator_a/video/${VIDEO_A}"><video id="video-a"></video></a>
        <p data-e2e="browse-video-desc">A DOM description</p>
        <strong data-e2e="browse-like-count">101</strong>
      </article>
      <article id="card-b" data-e2e="recommend-list-item-container" style="display:none">
        <a href="/@creator_b/video/${VIDEO_B}"><video id="video-b"></video></a>
        <p data-e2e="browse-video-desc">B DOM description</p>
        <strong data-e2e="browse-like-count">202</strong>
      </article>
    `;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_200 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  });

  it("invalidates A and materializes only B after the active video changes", () => {
    const pageUrl = "https://www.tiktok.com/";
    const videoA = document.querySelector<HTMLVideoElement>("#video-a")!;
    const videoB = document.querySelector<HTMLVideoElement>("#video-b")!;
    const cardA = document.querySelector<HTMLElement>("#card-a")!;
    const cardB = document.querySelector<HTMLElement>("#card-b")!;
    mockRect(videoA, { left: 300, top: 60, width: 440, height: 680 });
    mockRect(videoB, { left: 300, top: 60, width: 440, height: 680 });
    mockVideoState(videoA, { paused: false, readyState: 4, duration: 10 });
    mockVideoState(videoB, { paused: true, readyState: 4, duration: 20 });

    const registry = new VideoItemRegistry();
    registry.upsert(
      {
        video_id: VIDEO_A,
        author: { unique_id: "creator_a" },
        description: "A registry description",
        metrics: { play_count: 3_100_000, like_count: 101 },
      },
      "hydration_json",
    );
    registry.upsert(
      {
        video_id: VIDEO_B,
        author: { unique_id: "creator_b" },
        description: "B registry description",
        metrics: { play_count: 125_700, like_count: 202 },
      },
      "hydration_json",
    );

    const resolver = new ActiveVideoResolver(document, window);
    const session = new ActiveVideoSession();
    resolver.setVisibilityRatio(videoA, 1);
    resolver.setVisibilityRatio(videoB, 0);
    const activeA = resolveHomeActiveVideo(resolver)!;
    expect(session.observe(activeA.identity)).toBe(true);
    const first = collectHomePage(pageUrl, activeA, registry, session.switchCount, true).snapshot;
    session.store(activeA.identity, first);
    expect(first.video_id).toBe(VIDEO_A);
    expect(first.description).toBe("A registry description");
    expect(first.metrics.play_count).toBe(3_100_000);

    // The orchestrator clears the current key while the next card is resolving.
    expect(session.observe(null)).toBe(true);
    expect(session.get(activeA.identity, pageUrl)).toBeNull();
    cardA.style.display = "none";
    cardB.style.display = "block";
    Object.defineProperty(videoA, "paused", { configurable: true, value: true });
    Object.defineProperty(videoB, "paused", { configurable: true, value: false });
    resolver.setVisibilityRatio(videoA, 0);
    resolver.setVisibilityRatio(videoB, 1);
    const activeB = resolveHomeActiveVideo(resolver)!;

    expect(activeB.identity).not.toBe(activeA.identity);
    expect(session.observe(activeB.identity)).toBe(true);
    expect(session.get(activeB.identity, pageUrl)).toBeNull();
    const immediate = collectHomeRegistrySnapshot(pageUrl, activeB, registry);
    expect(immediate).toMatchObject({
      video_id: VIDEO_B,
      description: "B registry description",
      metrics: { play_count: 125_700, like_count: 202 },
      raw_data: { registry_fast_path: true },
    });
    expect(immediate?.metrics.play_count).not.toBe(3_100_000);
    const second = collectHomePage(
      pageUrl,
      activeB,
      registry,
      session.switchCount,
      true,
    ).snapshot;
    session.store(activeB.identity, second);

    expect(second.video_id).toBe(VIDEO_B);
    expect(second.author.unique_id).toBe("creator_b");
    expect(second.description).toBe("B registry description");
    expect(second.metrics.play_count).toBe(125_700);
    expect(second.metrics.like_count).toBe(202);
    expect(second.duration_seconds).toBe(20);
    expect(JSON.stringify(second)).not.toContain("A registry description");
    expect(second.metrics.play_count).not.toBe(3_100_000);
    expect(session.get(activeA.identity, pageUrl)).toBeNull();
    expect(session.get(activeB.identity, pageUrl)).toEqual(second);
  });

  it("首页图文卡用自身 photo ID 绑定 Registry 播放量，不借用邻近记录", () => {
    const photoId = "7333333333333333333";
    window.history.replaceState({}, "", "/");
    document.body.innerHTML = `
      <article id="photo-card" data-e2e="recommend-list-item-container">
        <a href="/@photo_author/photo/${photoId}">
          <img id="photo-cover" src="https://p16.example/current-photo.jpg" alt="当前图文">
          <img src="https://p16.example/photo-avatar.jpg" alt="作者头像">
        </a>
        <p data-e2e="browse-video-desc">首页当前图文描述</p>
        <strong data-e2e="browse-like-count">12.5K</strong>
        <strong data-e2e="browse-favorite-count">703</strong>
      </article>
    `;
    const root = document.querySelector<HTMLElement>("#photo-card")!;
    const cover = document.querySelector<HTMLImageElement>("#photo-cover")!;
    mockRect(root, { left: 260, top: 40, width: 520, height: 700 });
    mockRect(cover, { left: 280, top: 60, width: 480, height: 640 });

    const registry = new VideoItemRegistry();
    registry.upsert({
      video_id: photoId,
      content_type: "photo",
      cover_url: "https://p16.example/current-photo.jpg",
      metrics: { play_count: 131_800 },
    }, "hydration_json");
    registry.upsert({
      video_id: "7444444444444444444",
      content_type: "photo",
      cover_url: "https://p16.example/other-photo.jpg",
      metrics: { play_count: 9_900_000 },
    }, "hydration_json");

    const active = resolveHomeActiveVideo(new ActiveVideoResolver(document, window));
    expect(active).toMatchObject({
      contentType: "photo",
      videoId: photoId,
      activeRoot: root,
      mediaElement: cover,
    });

    const result = collectHomePage("https://www.tiktok.com/", active, registry, 0, true);
    expect(result.registryRecord?.video_id).toBe(photoId);
    expect(result.snapshot).toMatchObject({
      page_type: "home_feed",
      video_id: photoId,
      description: "首页当前图文描述",
      metrics: {
        play_count: 131_800,
        like_count: 12_500,
        collect_count: 703,
      },
      raw_data: { content_type: "photo" },
    });
    expect(result.snapshot.field_evidence["metrics.play_count"]?.source).toBe(
      "registry:hydration_json",
    );
    expect(result.snapshot.field_evidence["metrics.collect_count"]?.source).toBe(
      "registry:scoped_dom",
    );
    expect(result.snapshot.field_evidence["metrics.collect_count"]?.raw_value).toBe(703);
    expect(result.snapshot.metrics.play_count).not.toBe(9_900_000);
  });

  it("推荐流没有 video 链接时用作者和四项按钮指标唯一绑定 Registry", () => {
    document.body.innerHTML = `
      <article data-e2e="recommend-list-item-container">
        <video id="video"></video>
        <a href="/@backwithali">backwithali</a>
        <strong data-e2e="browse-like-count">420.1K</strong>
        <strong data-e2e="browse-comment-count">2.7K</strong>
        <strong data-e2e="browse-bookmark-count">40.8K</strong>
        <strong data-e2e="browse-share-count">83.2K</strong>
      </article>
    `;
    const video = document.querySelector<HTMLVideoElement>("#video")!;
    mockRect(video, { left: 300, top: 60, width: 440, height: 680 });
    mockVideoState(video, { paused: false, readyState: 4, duration: 14 });
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(video, 1);
    const active = resolveHomeActiveVideo(resolver)!;
    expect(active.videoId).toBeNull();

    const registry = new VideoItemRegistry();
    registry.upsert(
      {
        video_id: VIDEO_A,
        author: { unique_id: "backwithali", nickname: "Back With Ali" },
        description: "来自 Registry 的当前推荐视频描述",
        created_at: 1_752_537_600,
        duration_seconds: 14,
        metrics: {
          play_count: 8_765_432,
          like_count: 420_076,
          comment_count: 2_669,
          collect_count: 40_812,
          share_count: 83_161,
        },
      },
      "network_response",
    );

    const result = collectHomePage("https://www.tiktok.com/", active, registry, 0, true);
    expect(result.snapshot).toMatchObject({
      video_id: VIDEO_A,
      description: "来自 Registry 的当前推荐视频描述",
      created_at: 1_752_537_600,
      duration_seconds: 14,
      metrics: {
        play_count: 8_765_432,
        like_count: 420_076,
        comment_count: 2_669,
        collect_count: 40_812,
        share_count: 83_161,
      },
    });
    expect(result.context.video_id_source).toBe("registry:unique_context_match");
  });

  it("binds a permalink-free home item using the visible precision of coarse K counters", () => {
    document.body.innerHTML = coarseHomeFixture;
    const video = document.querySelector<HTMLVideoElement>("#coarse-feed-video")!;
    mockRect(video, { left: 120, top: 14, width: 490, height: 868 });
    mockVideoState(video, { paused: false, readyState: 4, duration: 61 });

    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(video, 1);
    const active = resolveHomeActiveVideo(resolver)!;
    expect(active.videoId).toBeNull();

    const currentId = "7651590753136397589";
    const registry = new VideoItemRegistry();
    registry.upsert({
      video_id: currentId,
      author: { unique_id: "dream.cat232", nickname: "Dream Cat AI" },
      description: "Part 5: Kartoffelvater und Sohn fanden eine Zauberbohne. #funnystory",
      duration_seconds: 61,
      metrics: {
        play_count: 12_734_921,
        like_count: 845_531,
        comment_count: 6_749,
        collect_count: 95_178,
        share_count: 11_887,
      },
    }, "network_response");
    registry.upsert({
      video_id: "7666987654321098765",
      author: { unique_id: "other.creator", nickname: "Other Creator" },
      duration_seconds: 61,
      metrics: {
        play_count: 99_000_000,
        like_count: 846_400,
        comment_count: 6_730,
        collect_count: 95_150,
        share_count: 11_850,
      },
    }, "network_response");

    const result = collectHomePage("https://www.tiktok.com/", active, registry, 0, true);
    expect(result.context.video_id_source).toBe("registry:unique_context_match");
    expect(result.snapshot).toMatchObject({
      video_id: currentId,
      author: { unique_id: "dream.cat232", nickname: "Dream Cat AI" },
      created_at: 1_781_524_800,
      duration_seconds: 61,
      metrics: {
        play_count: 12_734_921,
        like_count: 845_531,
        comment_count: 6_749,
        collect_count: 95_178,
        share_count: 11_887,
      },
    });
    expect(result.snapshot.field_evidence["metrics.play_count"]?.source).toBe(
      "registry:network_response",
    );
    expect(result.snapshot.field_evidence.created_at?.source).toBe(
      "registry:unique_context_match:tiktok_id_timestamp",
    );
  });

  it("keeps a permalink-free home item bound when media duration rounds one second above API duration", () => {
    document.body.innerHTML = closedCommentsDurationDriftFixture;
    const video = document.querySelector<HTMLVideoElement>("#closed-comments-feed-video")!;
    mockRect(video, { left: 88, top: 18, width: 490, height: 868 });
    // The closed feed player renders this as 1:33, while the item API reports
    // integer duration 92 (1:32). This is the exact open/closed-comments drift
    // from the production regression: it must not invalidate four matching
    // interaction counters and the exact author account.
    mockVideoState(video, { paused: false, readyState: 4, duration: 92.6 });

    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(video, 1);
    const active = resolveHomeActiveVideo(resolver)!;
    expect(active.videoId).toBeNull();

    const currentId = "7662425054923214093";
    const registry = new VideoItemRegistry();
    registry.upsert({
      video_id: currentId,
      author: { unique_id: "vibemorph1", nickname: "VibeMorph" },
      description: "Part 01 #aistory #fruitstory #foodstory #sadstory #aifruit",
      created_at: 1_784_047_386,
      duration_seconds: 92,
      metrics: {
        play_count: 277_234,
        like_count: 8_039,
        comment_count: 164,
        collect_count: 747,
        share_count: 157,
      },
    }, "network_response");
    // Same author with different public facts must remain isolated even though
    // it is adjacent in the registry and has a plausible feed-sized play count.
    registry.upsert({
      video_id: "7662424999999999999",
      author: { unique_id: "vibemorph1", nickname: "Wrong Neighbor" },
      duration_seconds: 95,
      metrics: {
        play_count: 299_999,
        like_count: 8_040,
        comment_count: 165,
        collect_count: 748,
        share_count: 158,
      },
    }, "network_response");

    const result = collectHomePage("https://www.tiktok.com/", active, registry, 0, true);
    expect(result.context.video_id_source).toBe("registry:unique_context_match");
    expect(result.snapshot).toMatchObject({
      video_id: currentId,
      author: { unique_id: "vibemorph1", nickname: "VibeMorph" },
      created_at: 1_784_047_386,
      duration_seconds: 92,
      metrics: {
        play_count: 277_234,
        like_count: 8_039,
        comment_count: 164,
        collect_count: 747,
        share_count: 157,
      },
    });
    expect(result.snapshot.field_evidence["metrics.play_count"]?.source).toBe(
      "registry:network_response",
    );
  });

  it("keeps a guarded root id when the same registry item is uniquely confirmed without a media URL", () => {
    document.body.innerHTML = coarseHomeFixture;
    const videoId = "7651590753136397589";
    const video = document.querySelector<HTMLVideoElement>("#coarse-feed-video")!;
    video.dataset.videoId = videoId;
    mockRect(video, { left: 120, top: 14, width: 490, height: 868 });
    mockVideoState(video, { paused: false, readyState: 4, duration: 61 });
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(video, 1);
    const active = resolveHomeActiveVideo(resolver)!;
    expect(active.videoId).toBe(videoId);

    const registry = new VideoItemRegistry();
    registry.upsert({
      video_id: videoId,
      author: { unique_id: "dream.cat232", nickname: "Dream Cat AI" },
      duration_seconds: 61,
      metrics: {
        play_count: 12_734_921,
        like_count: 845_531,
        comment_count: 6_749,
        collect_count: 95_178,
        share_count: 11_887,
      },
    }, "network_response");

    const result = collectHomePage(
      "https://www.tiktok.com/",
      active,
      registry,
      1,
      true,
      true,
    );
    expect(result.snapshot.video_id).toBe(videoId);
    expect(result.snapshot.metrics.play_count).toBe(12_734_921);
    expect(result.context.video_id_source).toContain("registry:unique_context_confirmation");
    expect(result.snapshot.raw_data.video_id_conflict).toBeNull();
  });

  it("replaces a stale reused-video permalink after new public counters uniquely bind the registry", () => {
    document.body.innerHTML = `
      <article data-e2e="recommend-list-item-container">
        <a id="stale-link" href="/@creator_a/video/${VIDEO_A}">
          <video id="reused-with-stale-link" src="https://cdn.example/new-opaque-media.mp4"></video>
        </a>
        <a href="/@creator_b">creator_b</a>
        <strong data-e2e="browse-like-count">846K</strong>
        <strong data-e2e="browse-comment-count">6.7K</strong>
        <strong data-e2e="browse-bookmark-count">95.1K</strong>
        <strong data-e2e="browse-share-count">11.8K</strong>
      </article>
    `;
    const video = document.querySelector<HTMLVideoElement>("#reused-with-stale-link")!;
    mockRect(video, { left: 120, top: 14, width: 490, height: 868 });
    mockVideoState(video, { paused: false, readyState: 4, duration: 61 });
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(video, 1);
    const active = resolveHomeActiveVideo(resolver)!;
    expect(active.videoId).toBe(VIDEO_A);

    const registry = new VideoItemRegistry();
    registry.upsert({
      video_id: VIDEO_A,
      author: { unique_id: "creator_a" },
      duration_seconds: 10,
      metrics: { play_count: 10_200_000, like_count: 1_300 },
    }, "network_response");
    registry.upsert({
      video_id: VIDEO_B,
      author: { unique_id: "creator_b", nickname: "Creator B" },
      created_at: 1_784_246_400,
      duration_seconds: 61,
      metrics: {
        play_count: 12_734_921,
        like_count: 845_531,
        comment_count: 6_749,
        collect_count: 95_178,
        share_count: 11_887,
      },
    }, "network_response");

    const result = collectHomePage(
      "https://www.tiktok.com/",
      active,
      registry,
      1,
      true,
      true,
    );
    expect(result.snapshot.video_id).toBe(VIDEO_B);
    expect(result.snapshot.metrics.play_count).toBe(12_734_921);
    expect(result.snapshot.created_at).toBe(1_784_246_400);
    expect(result.context.video_id_source).toBe(
      "registry:unique_context_match_after_media_switch",
    );
    expect(result.snapshot.raw_data.video_id_conflict).toEqual({
      active_root_id: VIDEO_A,
      registry_context_id: VIDEO_B,
      action: "replaced_stale_active_root_id",
    });
  });

  it("复用 video 已切到 B 而链接仍为 A 时拒绝两个 ID，链接同步后才绑定 B", () => {
    const pageUrl = "https://www.tiktok.com/";
    document.body.innerHTML = `
      <article data-e2e="recommend-list-item-container">
        <a id="permalink" href="/@creator_a/video/${VIDEO_A}">
          <video id="reused" src="https://cdn.example/a.mp4" poster="https://cdn.example/a.jpg"></video>
        </a>
        <p data-e2e="browse-video-desc">A stale description long enough</p>
      </article>
    `;
    const video = document.querySelector<HTMLVideoElement>("#reused")!;
    const permalink = document.querySelector<HTMLAnchorElement>("#permalink")!;
    mockRect(video, { left: 300, top: 60, width: 440, height: 680 });
    mockVideoState(video, { paused: false, readyState: 4, duration: 8 });
    const registry = new VideoItemRegistry();
    registry.upsert(
      {
        video_id: VIDEO_A,
        author: { unique_id: "creator_a" },
        description: "A stale description long enough",
        cover_url: "https://cdn.example/a.jpg",
        media_signature: "media=cdn.example/a.mp4;duration=9",
        metrics: { play_count: 10_200_000 },
      },
      "hydration_json",
    );
    registry.upsert(
      {
        video_id: VIDEO_B,
        media_signature: "media=cdn.example/b.mp4;duration=8",
        metrics: { play_count: 63_500 },
      },
      "hydration_json",
    );
    const resolver = new ActiveVideoResolver(document, window);
    resolver.setVisibilityRatio(video, 1);

    video.setAttribute("src", "https://cdn.example/b.mp4");
    resolver.bumpRevision(video);
    const duringSwitch = resolveHomeActiveVideo(resolver)!;
    expect(duringSwitch.videoId).toBe(VIDEO_A);

    const registryWithoutCurrentMedia = new VideoItemRegistry();
    registryWithoutCurrentMedia.upsert(
      { video_id: VIDEO_A, metrics: { play_count: 10_200_000 } },
      "hydration_json",
    );
    const guarded = collectHomePage(
      pageUrl,
      duringSwitch,
      registryWithoutCurrentMedia,
      1,
      true,
      true,
    ).snapshot;
    expect(guarded.video_id).toBeNull();
    expect(guarded.metrics.play_count).toBeNull();
    expect(guarded.raw_data.video_id_conflict).toMatchObject({
      action: "awaiting_media_or_link_confirmation",
    });

    const rejected = collectHomePage(pageUrl, duringSwitch, registry, 1, true).snapshot;
    expect(rejected.video_id).toBeNull();
    expect(rejected.metrics.play_count).toBeNull();
    expect(rejected.raw_data.video_id_conflict).toEqual({
      active_root_id: VIDEO_A,
      registry_context_id: VIDEO_B,
      action: "discarded_both_ids",
    });

    permalink.href = `/@creator_b/video/${VIDEO_B}`;
    const synchronized = resolveHomeActiveVideo(resolver)!;
    const accepted = collectHomePage(pageUrl, synchronized, registry, 1, true).snapshot;
    expect(accepted.video_id).toBe(VIDEO_B);
    expect(accepted.metrics.play_count).toBe(63_500);
    expect(accepted.metrics.play_count).not.toBe(10_200_000);
  });
});

describe("pageData grid play source audit", () => {
  it("卡片播放量保持 video_card_dom 来源且不写成可跨页面复用的 scoped_dom", () => {
    document.body.innerHTML = `
      <section data-e2e="user-post-item-list">
        <article data-e2e="user-post-item">
          <a href="/@creator/video/${VIDEO_B}"><img src="https://cdn.test/b.jpg"></a>
          <strong data-e2e="video-views">125.7K</strong>
        </article>
      </section>
    `;
    const registry = new VideoItemRegistry();
    const card = resolveVideoCards(document, "profile_grid")[0]!;
    const result = collectGridCardPage(
      "https://www.tiktok.com/@creator",
      "profile_grid",
      card,
      registry,
      1,
    );

    expect(result.snapshot.metrics.play_count).toBe(125_700);
    expect(result.snapshot.field_evidence["metrics.play_count"]?.source).toBe(
      'video_card_dom:[data-e2e="video-views"]',
    );
    expect(registry.get(VIDEO_B)?.fields["metrics.play_count"]).toBeUndefined();
  });

  it("主页网格按卡片作用域保存商业披露且不会污染相邻视频", () => {
    document.body.innerHTML = `
      <section data-e2e="user-post-item-list">
        <article data-e2e="user-post-item">
          <a href="/@creator/video/${VIDEO_A}"><img src="https://cdn.test/a.jpg"></a>
          <div data-e2e="sponsored-tag">付費合作關係</div>
        </article>
        <article data-e2e="user-post-item">
          <a href="/@creator/video/${VIDEO_B}"><img src="https://cdn.test/b.jpg"></a>
        </article>
      </section>
    `;
    const registry = new VideoItemRegistry();
    registry.upsert({ video_id: VIDEO_A, is_ad: false }, "hydration_json");
    registry.upsert({ video_id: VIDEO_B, is_ad: false }, "hydration_json");
    const cards = resolveVideoCards(document, "profile_grid");

    collectGridCardPage("https://www.tiktok.com/@creator", "profile_grid", cards[0]!, registry, 2);
    collectGridCardPage("https://www.tiktok.com/@creator", "profile_grid", cards[1]!, registry, 2);

    expect(registry.getItem(VIDEO_A)?.is_ad).toBe(true);
    expect(registry.getItem(VIDEO_B)?.is_ad).toBe(false);
  });
});
