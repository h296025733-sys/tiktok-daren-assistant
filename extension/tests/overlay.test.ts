import { describe, expect, it, vi } from "vitest";

import {
  collectLayoutObstacles,
  OverlayController,
  type OverlayVideoTarget,
} from "../src/content/overlay";
import type { Snapshot } from "../src/types/snapshot";
import { MemorySettingsStorage } from "../src/ui/settings";
import { mockRect, mockVideoState } from "./helpers";

function context(video: HTMLVideoElement, root?: HTMLElement): OverlayVideoTarget {
  return { video, nativeRoot: root ?? video.parentElement };
}

function snapshot(id: string, playCount: number | null = 1_300): Snapshot {
  return {
    page_type: "home_feed",
    page_url: "https://www.tiktok.com/",
    video_id: id,
    author: { nickname: null, unique_id: null },
    description: null,
    created_at: Date.UTC(2026, 6, 20, 12, 30) / 1_000,
    publish_time_text: "3天前",
    duration_seconds: 10,
    metrics: {
      play_count: playCount,
      like_count: 65,
      comment_count: 3,
      collect_count: 0,
      share_count: 6,
    },
    extraction: { source: "fixture", confidence: "high" },
    field_evidence: {
      "metrics.play_count": {
        value: playCount,
        source: "fixture:registry",
        confidence: "high",
        raw_value: playCount,
      },
    },
    raw_data: {},
  };
}

function advertisementSnapshot(id: string, playCount: number | null = 1_300): Snapshot {
  const data = snapshot(id, playCount);
  data.raw_data.is_ad = true;
  return data;
}

function mountedShadow(): ShadowRoot {
  return document.querySelector<HTMLElement>('[data-tiktok-daren-assistant="video-overlay"]')!.shadowRoot!;
}

describe("页面内轻量视频浮层", () => {
  it("重复扫描和 A/B 切换始终只有一个实例且不保留旧视频状态", async () => {
    document.body.innerHTML = `
      <article id="a"><video id="a-video"></video></article>
      <article id="b"><video id="b-video"></video></article>
      <div data-tiktok-daren-assistant="video-overlay"></div>
    `;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_200 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const rootA = document.querySelector<HTMLElement>("#a")!;
    const rootB = document.querySelector<HTMLElement>("#b")!;
    const videoA = document.querySelector<HTMLVideoElement>("#a-video")!;
    const videoB = document.querySelector<HTMLVideoElement>("#b-video")!;
    mockRect(videoA, { left: 200, top: 60, width: 400, height: 600 });
    mockRect(videoB, { left: 220, top: 70, width: 400, height: 600 });
    mockVideoState(videoA, { paused: false, readyState: 4, duration: 10 });
    mockVideoState(videoB, { paused: false, readyState: 4, duration: 8 });

    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;
    overlay.render(snapshot("7111111111111111111", 1_300), context(videoA, rootA));
    mountedShadow().querySelector<HTMLButtonElement>(".tda-date-badge")!.click();
    expect(overlay.isExpanded()).toBe(true);

    overlay.showLoading(context(videoB, rootB));
    overlay.reposition();
    expect(document.querySelector<HTMLElement>(
      '[data-tiktok-daren-assistant="video-overlay"]',
    )?.style.display).toBe("block");
    expect(mountedShadow().querySelector<HTMLElement>(".tda-panel")?.textContent)
      .not.toContain("1.3K");
    expect(mountedShadow().querySelector<HTMLElement>(".tda-quick-actions")?.style.transform)
      .toBe("translate3d(634px, 140px, 0)");
    expect(Array.from(
      mountedShadow().querySelectorAll<HTMLButtonElement>(".tda-quick-action"),
    ).every((button) => button.disabled)).toBe(true);

    overlay.render(snapshot("7222222222222222222", 63_500), context(videoB, rootB));
    overlay.reposition();

    expect(overlay.countInstances()).toBe(1);
    expect(overlay.isExpanded()).toBe(false);
    expect(mountedShadow().querySelector<HTMLElement>(".tda-compact-value")?.textContent).toBe("63.5K");
    expect(mountedShadow().querySelector<HTMLElement>(".tda-data-card")?.style.transform)
      .toBe("translate3d(634px, 322px, 0)");
    expect(Array.from(
      mountedShadow().querySelectorAll<HTMLButtonElement>(".tda-quick-action"),
    ).every((button) => !button.disabled)).toBe(true);
    expect(rootA.querySelector('[data-tiktok-daren-assistant="video-overlay"]')).toBeNull();
    expect(rootB.querySelector('[data-tiktok-daren-assistant="video-overlay"]')).toBeNull();
  });

  it("默认只显示缺失的紧凑播放量，并在媒体左下显示绝对日期", async () => {
    document.body.innerHTML = "<article><video></video></article>";
    const video = document.querySelector<HTMLVideoElement>("video")!;
    mockRect(video, { left: 200, top: 60, width: 400, height: 600 });
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;

    overlay.render(snapshot("7111111111111111111"), { video });
    overlay.reposition();
    const shadow = mountedShadow();
    const compact = shadow.querySelector<HTMLElement>(".tda-play-chip")!;
    const details = shadow.querySelector<HTMLElement>(".tda-details")!;
    const date = shadow.querySelector<HTMLButtonElement>(".tda-date-badge")!;

    expect(compact.hidden).toBe(false);
    expect(compact.textContent).toContain("播放");
    expect(compact.textContent).toContain("1.3K");
    expect(details.hidden).toBe(true);
    expect(date.hidden).toBe(false);
    expect(date.textContent).toContain("2026/07/20");
    expect(date.style.transform).toMatch(/^translate3d\(212px, (4[5-9]\d|5[0-2]\d)px, 0\)$/);
    expect(shadow.textContent).not.toContain("质量");
    expect(shadow.textContent).not.toContain("VQ");
  });

  it("播放量只作展示，只有日期点击会展开或收起简洁指标栏", async () => {
    document.body.innerHTML = "<article><video></video></article>";
    const video = document.querySelector<HTMLVideoElement>("video")!;
    mockRect(video, { left: 200, top: 60, width: 400, height: 600 });
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;
    overlay.render(snapshot("7111111111111111111"), { video });
    const shadow = mountedShadow();
    const playChip = shadow.querySelector<HTMLElement>(".tda-play-chip")!;
    const date = shadow.querySelector<HTMLButtonElement>(".tda-date-badge")!;
    const details = shadow.querySelector<HTMLElement>(".tda-details")!;

    playChip.click();
    expect(overlay.isExpanded()).toBe(false);
    expect(details.hidden).toBe(true);

    date.click();
    expect(overlay.isExpanded()).toBe(true);
    expect(details.hidden).toBe(false);
    expect(date.getAttribute("aria-expanded")).toBe("true");
    expect(shadow.querySelector<HTMLElement>('[data-field="play_count"] .tda-detail-value')?.textContent).toBe("1.3K");
    expect(shadow.querySelector<HTMLElement>('[data-field="like_count"] .tda-detail-value')?.textContent).toBe("65");
    expect(shadow.querySelector<HTMLElement>('[data-field="comment_count"] .tda-detail-value')?.textContent).toBe("3");
    expect(shadow.querySelector<HTMLElement>('[data-field="collect_count"] .tda-detail-value')?.textContent).toBe("0");
    expect(shadow.querySelector<HTMLElement>('[data-field="share_count"] .tda-detail-value')?.textContent).toBe("6");
    expect(shadow.querySelector<HTMLElement>('[data-field="duration_seconds"] .tda-detail-value')?.textContent).toBe("0:10");
    expect(shadow.querySelector<HTMLElement>('[data-field="interaction_rate"] .tda-detail-value')?.textContent).toBe("5.69%");

    date.click();
    expect(overlay.isExpanded()).toBe(false);
    expect(details.hidden).toBe(true);
    expect(date.getAttribute("aria-expanded")).toBe("false");
  });

  it("视频详情页不悬浮独立播放圆钮，播放量随日期面板展开", async () => {
    document.body.innerHTML = "<main><video></video></main>";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_200 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const video = document.querySelector<HTMLVideoElement>("video")!;
    mockRect(video, { left: 120, top: 20, width: 720, height: 760 });
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;

    overlay.render(snapshot("7111111111111111111"), { video, surface: "detail" });
    overlay.reposition();
    const shadow = mountedShadow();
    expect(shadow.querySelector<HTMLElement>(".tda-play-chip")?.hidden).toBe(true);
    expect(shadow.querySelector<HTMLElement>(".tda-quick-actions")?.style.transform)
      .toBe("translate3d(694px, 34px, 0)");
    shadow.querySelector<HTMLButtonElement>(".tda-date-badge")!.click();
    expect(shadow.querySelector<HTMLElement>('[data-field="play_count"] .tda-detail-value')?.textContent)
      .toBe("1.3K");
  });

  it("主页提供视频、音频和字幕三枚圆形快捷操作，下载与字幕走各自处理器", async () => {
    document.body.innerHTML = "<article><video></video></article>";
    const video = document.querySelector<HTMLVideoElement>("video")!;
    mockRect(video, { left: 200, top: 60, width: 400, height: 600 });
    const downloads: string[] = [];
    let subtitles = 0;
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
      onDownload: async (mode) => { downloads.push(mode); },
      onOpenSubtitles: async () => { subtitles += 1; },
    });
    await overlay.ready;
    overlay.render(snapshot("7111111111111111111"), { video });
    const shadow = mountedShadow();
    const actions = shadow.querySelector<HTMLElement>(".tda-quick-actions")!;

    expect(actions.hidden).toBe(false);
    expect(actions.querySelectorAll(".tda-quick-action")).toHaveLength(3);
    actions.querySelector<HTMLButtonElement>('[data-action="video"]')!.click();
    await vi.waitFor(() => expect(downloads).toEqual(["video"]));
    for (const button of actions.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false;
    actions.querySelector<HTMLButtonElement>('[data-action="subtitles"]')!.click();
    await vi.waitFor(() => expect(subtitles).toBe(1));
  });

  it("操作尚未完成时切换视频不会提前解锁新视频按钮", async () => {
    document.body.innerHTML = `
      <article id="a"><video id="a-video"></video></article>
      <article id="b"><video id="b-video"></video></article>
    `;
    const videoA = document.querySelector<HTMLVideoElement>("#a-video")!;
    const videoB = document.querySelector<HTMLVideoElement>("#b-video")!;
    mockRect(videoA, { left: 200, top: 60, width: 400, height: 600 });
    mockRect(videoB, { left: 220, top: 70, width: 400, height: 600 });
    let releaseDownload: (() => void) | null = null;
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
      onDownload: () => new Promise<void>((resolve) => {
        releaseDownload = resolve;
      }),
    });
    await overlay.ready;
    overlay.render(snapshot("7111111111111111111"), { video: videoA });
    const actions = mountedShadow().querySelector<HTMLElement>(".tda-quick-actions")!;
    actions.querySelector<HTMLButtonElement>('[data-action="video"]')!.click();
    await vi.waitFor(() => expect(releaseDownload).not.toBeNull());

    overlay.showLoading({ video: videoB });
    overlay.render(snapshot("7222222222222222222"), { video: videoB });

    expect(Array.from(actions.querySelectorAll<HTMLButtonElement>("button"))
      .every((button) => button.disabled)).toBe(true);
    releaseDownload!();
  });

  it("未知指标直接隐藏，不显示 --、加载点或错误感叹号", async () => {
    document.body.innerHTML = "<article><video></video></article>";
    const video = document.querySelector<HTMLVideoElement>("video")!;
    mockRect(video, { left: 200, top: 60, width: 400, height: 600 });
    const data = snapshot("7111111111111111111", null);
    data.metrics.comment_count = null;
    data.metrics.collect_count = null;
    data.metrics.share_count = null;
    data.duration_seconds = null;
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;

    overlay.render(data, { video });
    const shadow = mountedShadow();
    expect(shadow.querySelector<HTMLElement>(".tda-play-chip")?.hidden).toBe(true);
    shadow.querySelector<HTMLButtonElement>(".tda-date-badge")!.click();
    expect(overlay.isExpanded()).toBe(true);
    expect(shadow.querySelector<HTMLElement>('[data-field="play_count"]')?.hidden).toBe(true);
    expect(shadow.querySelector<HTMLElement>('[data-field="like_count"]')?.hidden).toBe(false);
    expect(shadow.querySelector<HTMLElement>('[data-field="interaction_rate"]')?.hidden).toBe(true);
    const visibleUiText = shadow.querySelector<HTMLElement>(".tda-panel")!.textContent;
    expect(visibleUiText).not.toContain("--");
    expect(visibleUiText).not.toContain("···");
    expect(visibleUiText).not.toContain("!");
  });

  it("推荐流即使存在复用的 video-views 节点也稳定显示当前视频播放量", async () => {
    document.body.innerHTML = `
      <article data-e2e="recommend-list-item-container">
        <video></video>
        <strong data-e2e="video-views">3.1M</strong>
      </article>
    `;
    const root = document.querySelector<HTMLElement>("article")!;
    const video = root.querySelector<HTMLVideoElement>("video")!;
    mockRect(video, { left: 200, top: 60, width: 400, height: 600 });
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;

    overlay.render(snapshot("7111111111111111111", 3_100_000), context(video, root));
    const shadow = mountedShadow();
    expect(shadow.querySelector<HTMLElement>(".tda-play-chip")?.hidden).toBe(false);
    expect(shadow.querySelector<HTMLElement>(".tda-compact-value")?.textContent).toBe("3.1M");
    expect(shadow.querySelector<HTMLButtonElement>(".tda-date-badge")?.hidden).toBe(false);

    shadow.querySelector<HTMLButtonElement>(".tda-date-badge")!.click();
    expect(overlay.isExpanded()).toBe(true);
    expect(shadow.querySelector<HTMLElement>('[data-field="play_count"] .tda-detail-value')?.textContent).toBe("3.1M");
  });

  it("切换到查询中或失败状态时立即跟随新视频，但不遗留数据或允许误点", async () => {
    document.body.innerHTML = "<article><video></video></article>";
    const video = document.querySelector<HTMLVideoElement>("video")!;
    mockRect(video, { left: 200, top: 60, width: 400, height: 600 });
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;
    overlay.render(snapshot("7111111111111111111"), { video });
    expect(document.querySelector<HTMLElement>('[data-tiktok-daren-assistant="video-overlay"]')?.style.display).toBe("block");

    overlay.showLoading({ video });
    overlay.reposition();
    expect(document.querySelector<HTMLElement>('[data-tiktok-daren-assistant="video-overlay"]')?.style.display).toBe("block");
    expect(mountedShadow().querySelector<HTMLElement>(".tda-quick-actions")?.hidden).toBe(false);
    expect(Array.from(
      mountedShadow().querySelectorAll<HTMLButtonElement>(".tda-quick-action"),
    ).every((button) => button.disabled)).toBe(true);
    expect(mountedShadow().querySelector<HTMLElement>(".tda-panel")?.textContent).not.toContain("1.3K");
    overlay.showError({ video });
    expect(document.querySelector<HTMLElement>('[data-tiktok-daren-assistant="video-overlay"]')?.style.display).toBe("block");
    expect(mountedShadow().querySelector<HTMLElement>(".tda-panel")?.textContent).not.toContain("!");
  });

  it("位置更新不再使用会让组件落后于视频的 transform 追赶动画", async () => {
    document.body.innerHTML = "<article><video></video></article>";
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;

    const styleText = mountedShadow().querySelector("style")?.textContent ?? "";
    expect(styleText).not.toContain("transition: transform 72ms");
    expect(styleText).toContain(
      "transition: opacity var(--tda-motion-fast) var(--tda-motion-easing)",
    );
  });

  it("左下日期为作者信息预留安全区，并在冲突时继续上移避让", async () => {
    document.body.innerHTML = `
      <article><video></video><div data-e2e="video-subtitle">字幕区域</div></article>
    `;
    const video = document.querySelector<HTMLVideoElement>("video")!;
    const subtitle = document.querySelector<HTMLElement>('[data-e2e="video-subtitle"]')!;
    mockRect(video, { left: 200, top: 60, width: 400, height: 600 });
    mockRect(subtitle, { left: 200, top: 480, width: 190, height: 50 });
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;
    overlay.render(snapshot("7111111111111111111"), { video });
    overlay.reposition();

    const date = mountedShadow().querySelector<HTMLElement>(".tda-date-badge")!;
    expect(date.style.transform).toBe("translate3d(212px, 424px, 0)");
  });

  it("第三方固定节点仅用于避让且不会被读取或修改", () => {
    document.body.innerHTML = '<video></video><div id="third-party" style="position:fixed;z-index:9999">第三方 999M</div>';
    const video = document.querySelector<HTMLVideoElement>("video")!;
    const thirdParty = document.querySelector<HTMLElement>("#third-party")!;
    mockRect(video, { left: 200, top: 60, width: 400, height: 600 });
    mockRect(thirdParty, { left: 610, top: 80, width: 80, height: 260 });

    const obstacles = collectLayoutObstacles(document, window, video);

    expect(obstacles).toEqual(expect.arrayContaining([expect.objectContaining({ left: 610, width: 80 })]));
    expect(thirdParty.textContent).toBe("第三方 999M");
    expect(thirdParty.getAttributeNames()).not.toContain("data-tiktok-daren-assistant");
  });

  it("横屏视频在操作工具条旁保留独立播放量，并同时保留日期详情数据", async () => {
    document.body.innerHTML = "<article><video></video></article>";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 760 });
    const video = document.querySelector<HTMLVideoElement>("video")!;
    mockRect(video, { left: 52, top: 54, width: 1_152, height: 648 });
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;

    overlay.render(snapshot("7111111111111111111"), { video, surface: "feed" });
    overlay.reposition();
    const host = document.querySelector<HTMLElement>(
      '[data-tiktok-daren-assistant="video-overlay"]',
    )!;
    const shadow = mountedShadow();

    expect(host.dataset.layout).toBe("inside-toolbar");
    expect(shadow.querySelector<HTMLElement>(".tda-data-card")?.hidden).toBe(false);
    expect(shadow.querySelector<HTMLElement>(".tda-play-chip")?.hidden).toBe(false);
    expect(shadow.querySelector<HTMLElement>(".tda-data-card")?.style.transform)
      .toBe("translate3d(998px, 68px, 0)");
    expect(shadow.querySelector<HTMLElement>(".tda-quick-actions")?.style.transform)
      .toBe("translate3d(1058px, 68px, 0)");

    shadow.querySelector<HTMLButtonElement>(".tda-date-badge")!.click();
    expect(shadow.querySelector<HTMLElement>('[data-field="play_count"] .tda-detail-value')?.textContent)
      .toBe("1.3K");
  });

  it("推荐流组件挂进当前视频原生操作栏，切换时整组移动且播放量不会串条", async () => {
    document.body.innerHTML = `
      <article id="a">
        <video id="video-a"></video>
        <section class="tiktok-a-SectionActionBarContainer">
          <div class="tiktok-a-DivAvatarActionItemContainer" data-e2e="feed-avatar"></div>
        </section>
      </article>
      <article id="b">
        <video id="video-b"></video>
        <section class="tiktok-b-SectionActionBarContainer">
          <div class="tiktok-b-DivAvatarActionItemContainer" data-e2e="feed-avatar"></div>
        </section>
      </article>
    `;
    const rootA = document.querySelector<HTMLElement>("#a")!;
    const rootB = document.querySelector<HTMLElement>("#b")!;
    const barA = rootA.querySelector<HTMLElement>("section")!;
    const barB = rootB.querySelector<HTMLElement>("section")!;
    const videoA = document.querySelector<HTMLVideoElement>("#video-a")!;
    const videoB = document.querySelector<HTMLVideoElement>("#video-b")!;
    mockRect(videoA, { left: 200, top: 60, width: 400, height: 600 });
    mockRect(videoB, { left: 200, top: 60, width: 400, height: 600 });
    const downloads: string[] = [];
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
      onDownload: async (mode) => { downloads.push(mode); },
    });
    await overlay.ready;

    overlay.render(advertisementSnapshot("7111111111111111111", 1_300), {
      video: videoA,
      mediaElement: videoA,
      nativeRoot: rootA,
      surface: "feed",
    });
    overlay.reposition();

    const quickHost = barA.querySelector<HTMLElement>(
      '[data-tiktok-daren-assistant="native-quick-actions"]',
    )!;
    const playHost = barA.querySelector<HTMLElement>(
      '[data-tiktok-daren-assistant="native-play-count"]',
    )!;
    const commercialHost = barA.querySelector<HTMLElement>(
      '[data-tiktok-daren-assistant="native-commercial-label"]',
    )!;
    expect(quickHost).not.toBeNull();
    expect(commercialHost).not.toBeNull();
    expect(commercialHost.shadowRoot?.textContent).toContain("广告/推广");
    expect(commercialHost.shadowRoot?.querySelector("style")?.textContent).toContain("width: 52px");
    expect(commercialHost.shadowRoot?.querySelector("style")?.textContent).not.toContain("box-shadow");
    expect(playHost.shadowRoot?.querySelector(".tda-compact-value")?.textContent).toBe("1.3K");
    expect([
      quickHost,
      commercialHost,
      playHost,
      barA.querySelector<HTMLElement>('[data-e2e="feed-avatar"]'),
    ]).toEqual(Array.from(barA.children));
    expect(mountedShadow().querySelector<HTMLElement>(".tda-quick-actions")?.hidden).toBe(true);
    expect(mountedShadow().querySelector<HTMLElement>(".tda-data-card")?.hidden).toBe(true);
    expect(
      quickHost.shadowRoot?.querySelector("style")?.textContent,
    ).not.toContain("0 5px 16px");
    quickHost.shadowRoot
      ?.querySelector<HTMLButtonElement>('[data-action="video"]')
      ?.click();
    await vi.waitFor(() => expect(downloads).toEqual(["video"]));

    overlay.render(snapshot("7222222222222222222", 63_500), {
      video: videoB,
      mediaElement: videoB,
      nativeRoot: rootB,
      surface: "feed",
    });
    overlay.reposition();

    expect(barA.querySelector('[data-tiktok-daren-assistant="native-quick-actions"]')).toBeNull();
    expect(barA.querySelector('[data-tiktok-daren-assistant="native-commercial-label"]')).toBeNull();
    expect(barA.querySelector('[data-tiktok-daren-assistant="native-play-count"]')).toBeNull();
    expect(barB.querySelector('[data-tiktok-daren-assistant="native-quick-actions"]')).toBe(quickHost);
    expect(barB.querySelector('[data-tiktok-daren-assistant="native-commercial-label"]')).toBeNull();
    expect(barB.querySelector('[data-tiktok-daren-assistant="native-play-count"]')).toBe(playHost);
    expect(playHost.shadowRoot?.querySelector(".tda-compact-value")?.textContent).toBe("63.5K");
  });

  it("广告到普通再回广告的快速切换会立即移除旧标记且只保留一个实例", async () => {
    document.body.innerHTML = `
      <article id="ad-card">
        <video id="ad-video"></video>
        <section class="tiktok-ad-SectionActionBarContainer">
          <div data-e2e="feed-avatar"></div>
        </section>
      </article>
      <article id="normal-card">
        <video id="normal-video"></video>
        <section class="tiktok-normal-SectionActionBarContainer">
          <div data-e2e="feed-avatar"></div>
        </section>
      </article>
    `;
    const adRoot = document.querySelector<HTMLElement>("#ad-card")!;
    const normalRoot = document.querySelector<HTMLElement>("#normal-card")!;
    const adVideo = document.querySelector<HTMLVideoElement>("#ad-video")!;
    const normalVideo = document.querySelector<HTMLVideoElement>("#normal-video")!;
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;
    const adContext: OverlayVideoTarget = {
      video: adVideo,
      mediaElement: adVideo,
      nativeRoot: adRoot,
      surface: "feed",
    };
    const normalContext: OverlayVideoTarget = {
      video: normalVideo,
      mediaElement: normalVideo,
      nativeRoot: normalRoot,
      surface: "feed",
    };

    overlay.render(advertisementSnapshot("7111111111111111111"), adContext);
    const firstHost = adRoot.querySelector<HTMLElement>(
      '[data-tiktok-daren-assistant="native-commercial-label"]',
    )!;
    expect(firstHost).not.toBeNull();

    overlay.showLoading(normalContext);
    expect(document.querySelectorAll('[data-tiktok-daren-assistant="native-commercial-label"]')).toHaveLength(0);
    overlay.render(advertisementSnapshot("7111111111111111111"), adContext);
    overlay.showError(normalContext);
    expect(document.querySelectorAll('[data-tiktok-daren-assistant="native-commercial-label"]')).toHaveLength(0);

    overlay.render(snapshot("7222222222222222222"), normalContext);
    expect(normalRoot.querySelector('[data-tiktok-daren-assistant="native-commercial-label"]')).toBeNull();
    overlay.render(advertisementSnapshot("7333333333333333333"), adContext);
    expect(adRoot.querySelector('[data-tiktok-daren-assistant="native-commercial-label"]')).toBe(firstHost);
    expect(document.querySelectorAll('[data-tiktok-daren-assistant="native-commercial-label"]')).toHaveLength(1);
  });

  it("详情页广告标记只挂在简介之后，重复渲染会去重且普通视频立即移除", async () => {
    document.body.innerHTML = `
      <main id="detail-root">
        <section id="media"><video></video></section>
        <aside id="metadata">
          <strong data-e2e="browse-username">creator</strong>
          <p data-e2e="browse-video-desc">商品介绍文案</p>
          <time>2026-07-20</time>
        </aside>
      </main>
    `;
    const pageRoot = document.querySelector<HTMLElement>("#detail-root")!;
    const mediaRoot = document.querySelector<HTMLElement>("#media")!;
    const metadataRoot = document.querySelector<HTMLElement>("#metadata")!;
    const description = metadataRoot.querySelector<HTMLElement>('[data-e2e="browse-video-desc"]')!;
    const video = mediaRoot.querySelector<HTMLVideoElement>("video")!;
    const detailContext: OverlayVideoTarget = {
      video,
      mediaElement: video,
      nativeRoot: pageRoot,
      metadataRoot,
      surface: "detail",
    };
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;

    overlay.render(advertisementSnapshot("7111111111111111111"), detailContext);
    const commercialHost = metadataRoot.querySelector<HTMLElement>(
      '[data-tiktok-daren-assistant="native-commercial-label"]',
    )!;
    expect(commercialHost).not.toBeNull();
    expect(description.nextElementSibling).toBe(commercialHost);
    expect(mediaRoot.contains(commercialHost)).toBe(false);
    expect(commercialHost.shadowRoot?.textContent).toContain("广告/推广");

    const duplicate = document.createElement("div");
    duplicate.setAttribute("data-tiktok-daren-assistant", "native-commercial-label");
    metadataRoot.append(duplicate);
    overlay.render(advertisementSnapshot("7111111111111111111"), detailContext);
    expect(metadataRoot.querySelectorAll('[data-tiktok-daren-assistant="native-commercial-label"]')).toHaveLength(1);
    expect(description.nextElementSibling).toBe(commercialHost);

    overlay.render(snapshot("7222222222222222222"), detailContext);
    expect(document.querySelectorAll('[data-tiktok-daren-assistant="native-commercial-label"]')).toHaveLength(0);
  });

  it("详情页没有简介时把广告标记放在元数据末尾而不是视频里", async () => {
    document.body.innerHTML = `
      <main id="detail-root">
        <section id="media"><video></video></section>
        <aside id="metadata">
          <strong data-e2e="browse-username">creator</strong>
          <time data-e2e="video-publish-time">2026-07-20</time>
        </aside>
      </main>
    `;
    const mediaRoot = document.querySelector<HTMLElement>("#media")!;
    const metadataRoot = document.querySelector<HTMLElement>("#metadata")!;
    const time = metadataRoot.querySelector<HTMLElement>("time")!;
    const video = mediaRoot.querySelector<HTMLVideoElement>("video")!;
    const overlay = new OverlayController(document, window, {
      settingsStorage: new MemorySettingsStorage(),
    });
    await overlay.ready;

    overlay.render(advertisementSnapshot("7111111111111111111"), {
      video,
      mediaElement: video,
      nativeRoot: document.querySelector<HTMLElement>("#detail-root"),
      metadataRoot,
      surface: "detail",
    });

    const commercialHost = document.querySelector<HTMLElement>(
      '[data-tiktok-daren-assistant="native-commercial-label"]',
    )!;
    expect(time.nextElementSibling).toBe(commercialHost);
    expect(mediaRoot.contains(commercialHost)).toBe(false);
  });
});
