import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import {
  formatTopicText,
  GridOverlayController,
  type GridVideoCardContext,
} from "../src/content/gridOverlay";

const LABEL_SELECTOR = '[data-tiktok-daren-assistant="grid-card-label"]';

function fixtureCards(): GridVideoCardContext[] {
  const roots = Array.from(document.querySelectorAll<HTMLElement>("article"));
  return [
    {
      cardRoot: roots[0]!, videoId: "7111111111111111111", play_count: 3_100_000, duration: 42,
      like_count: 98_000, comment_count: 1200, collect_count: 3300, share_count: 600,
      created_at: 1_720_000_000, publish_time_text: "6天前", data_complete: true,
      is_ad: true, has_product: true,
    },
    {
      cardRoot: roots[1]!, videoId: "7222222222222222222", play_count: 247_300, duration: 42,
      like_count: 12_000, comment_count: 900, collect_count: 800, share_count: 70,
      created_at: 1_710_000_000, data_complete: true,
    },
    {
      cardRoot: roots[2]!, videoId: "7333333333333333333", play_count: 125_700, duration: 9,
      like_count: 5500, comment_count: null, collect_count: 898, share_count: 36,
      created_at: null, publish_time_text: "3天前", data_complete: false,
      has_product: true,
    },
  ];
}

function shadowAt(selector: string): ShadowRoot {
  return document.querySelector<HTMLElement>(selector)!.querySelector<HTMLElement>(LABEL_SELECTOR)!.shadowRoot!;
}

function chip(shadow: ShadowRoot, key: string): HTMLElement {
  return shadow.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
}

describe("阶段 1.4 网格卡片常驻数据 UI", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <section id="grid" data-e2e="user-post-item-list">
        <article id="card-a"><a href="/@fixture/video/7111111111111111111">A</a><strong data-e2e="video-views">3.1M</strong></article>
        <article id="card-b"><a href="/@fixture/video/7222222222222222222">B</a><strong data-e2e="video-views">247.3K</strong><span data-e2e="video-duration">0:42</span><span data-e2e="like-count">12K</span><span data-e2e="comment-count">900</span><span data-e2e="bookmark-count">800</span><span data-e2e="share-count">70</span></article>
        <article id="card-c"><a href="/@fixture/photo/7333333333333333333"><img alt="图文卡"></a><strong data-e2e="browse-favorite-count">898</strong></article>
      </section>
    `;
  });

  it("无需 hover 即按固定区域显示运营指标，不包含质量分或调试面板", () => {
    const controller = new GridOverlayController(document, window);
    controller.render(fixtureCards());

    const a = shadowAt("#card-a");
    expect(chip(a, "like").hidden).toBe(false);
    expect(chip(a, "like").textContent).toContain("98K");
    expect(chip(a, "comment").textContent).toContain("1.2K");
    expect(chip(a, "collect").textContent).toContain("3.3K");
    expect(chip(a, "share").textContent).toContain("600");
    expect(chip(a, "engagement").textContent).toContain("3.3%");
    expect(chip(a, "date").textContent).toMatch(/\d{2}\/\d{2}/);
    expect(chip(a, "date").textContent).not.toContain("6天前");
    expect(chip(a, "ad").hidden).toBe(false);
    expect(chip(a, "ad").textContent).toContain("推广");
    expect(chip(a, "ad").textContent).not.toContain("广告/推广");
    expect(chip(a, "ad").getAttribute("aria-label")).toContain("广告或推广");
    expect(chip(a, "ad").title).toContain("广告或推广");
    expect(chip(a, "product").hidden).toBe(true);
    expect(a.querySelector('[data-zone="play"]')?.contains(chip(a, "ad"))).toBe(false);
    expect(a.querySelector('[data-zone="actions"]')?.contains(chip(a, "ad"))).toBe(false);
    expect(a.querySelector('[data-zone="classification"]')?.contains(chip(a, "ad"))).toBe(true);
    expect(a.querySelector('[data-zone="classification"]')?.contains(chip(a, "product"))).toBe(true);
    expect(a.querySelector('[data-zone="right"]')?.contains(chip(a, "engagement"))).toBe(true);
    expect(a.querySelector('[data-zone="right"]')?.contains(chip(a, "duration"))).toBe(true);
    expect(a.querySelector('[data-zone="favorite"]')?.contains(chip(a, "collect"))).toBe(true);
    expect(a.querySelector('[data-zone="date"]')?.contains(chip(a, "date"))).toBe(true);
    expect(Array.from(a.querySelector('[data-zone="actions"]')?.children ?? []).map((node) => node.getAttribute("data-key")))
      .toEqual(["share", "comment", "like"]);
    expect(a.querySelector(".tda-grid-status")).toBeNull();
    expect(a.querySelector(".tda-grid-panel")).toBeNull();
    expect(a.querySelector(".tda-grid-pin")).toBeNull();
    expect(a.textContent).not.toContain("质量");
    const style = a.querySelector("style")?.textContent ?? "";
    expect(style).toContain("rgba(239, 246, 255, .94)");
    expect(style).toContain("text-overflow: clip");
    controller.destroy();
  });

  it("只有广告或带货标记时仍显示现有底栏，不增加底栏高度或遮挡缩略图", () => {
    const cards = fixtureCards().slice(0, 2);
    for (const card of cards) {
      card.like_count = null;
      card.comment_count = null;
      card.share_count = null;
      card.description = null;
    }
    cards[0]!.is_ad = true;
    cards[0]!.has_product = true;
    cards[1]!.is_ad = null;
    cards[1]!.has_product = true;

    const controller = new GridOverlayController(document, window);
    controller.render(cards);

    const ad = shadowAt("#card-a");
    const product = shadowAt("#card-b");
    const adFooter = ad.querySelector<HTMLElement>("[data-footer]")!;
    const productFooter = product.querySelector<HTMLElement>("[data-footer]")!;
    const style = ad.querySelector("style")?.textContent ?? "";
    expect(adFooter.hidden).toBe(false);
    expect(productFooter.hidden).toBe(false);
    expect(chip(ad, "ad").hidden).toBe(false);
    expect(chip(ad, "product").hidden).toBe(true);
    expect(chip(product, "ad").hidden).toBe(true);
    expect(chip(product, "product").hidden).toBe(false);
    expect(ad.querySelector<HTMLElement>("[data-footer-meta]")?.hidden).toBe(false);
    expect(product.querySelector<HTMLElement>("[data-footer-meta]")?.hidden).toBe(false);
    expect(ad.querySelector('[data-zone="classification"]')?.contains(chip(ad, "ad"))).toBe(true);
    expect(product.querySelector('[data-zone="classification"]')?.contains(chip(product, "product"))).toBe(true);
    expect(ad.querySelector<HTMLElement>("[data-description]")?.hidden).toBe(true);
    expect(product.querySelector<HTMLElement>("[data-description]")?.hidden).toBe(true);
    expect(style).toContain("height: 70px");
    expect(document.querySelector<HTMLElement>("#card-a")?.style.marginBottom).toBe("84px");
    expect(document.querySelector<HTMLElement>("#card-b")?.style.marginBottom).toBe("84px");
    controller.destroy();
  });

  it("六列窄卡仍保留分享评论点赞三等分，推广或带货只占文案同行的短徽标", () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    grid.innerHTML = Array.from({ length: 6 }, (_, index) => `
      <article id="narrow-${index}" style="width:150px">
        <a href="/@fixture/video/71${String(index).padStart(17, "0")}">card ${index}</a>
      </article>
    `).join("");
    const cards: GridVideoCardContext[] = Array.from(grid.querySelectorAll<HTMLElement>("article"))
      .map((cardRoot, index) => ({
        cardRoot,
        videoId: `71${String(index).padStart(17, "0")}`,
        play_count: 10_000 + index,
        duration: 15,
        like_count: 1_000 + index,
        comment_count: 100 + index,
        share_count: 10 + index,
        is_ad: index === 0,
        has_product: index === 1,
      }));
    const controller = new GridOverlayController(document, window);
    controller.render(cards);

    expect(document.querySelectorAll(LABEL_SELECTOR)).toHaveLength(6);
    for (let index = 0; index < 6; index += 1) {
      const shadow = shadowAt(`#narrow-${index}`);
      const actionKeys = Array.from(
        shadow.querySelector<HTMLElement>('[data-zone="actions"]')?.children ?? [],
      ).map((node) => node.getAttribute("data-key"));
      expect(actionKeys).toEqual(["share", "comment", "like"]);
      expect(shadow.querySelector('[data-zone="actions"]')?.contains(chip(shadow, "ad"))).toBe(false);
      expect(shadow.querySelector('[data-zone="actions"]')?.contains(chip(shadow, "product"))).toBe(false);
      expect(document.querySelector<HTMLElement>(`#narrow-${index}`)?.style.marginBottom).toBe("84px");
      const metaRow = shadow.querySelector<HTMLElement>("[data-footer-meta]")!;
      if (index === 0) {
        expect(metaRow.hidden).toBe(false);
        expect(chip(shadow, "ad").textContent).toContain("推广");
        expect(chip(shadow, "product").hidden).toBe(true);
      } else if (index === 1) {
        expect(metaRow.hidden).toBe(false);
        expect(chip(shadow, "ad").hidden).toBe(true);
        expect(chip(shadow, "product").textContent).toContain("带货");
      } else {
        expect(metaRow.hidden).toBe(true);
      }
    }
    const style = shadowAt("#narrow-0").querySelector("style")?.textContent ?? "";
    expect(style).toContain("height: 70px");
    controller.destroy();
  });

  it("释放 TikTok 卡片裁剪后在预留区域显示互动数据与文案，并在销毁时恢复", () => {
    const cards = fixtureCards();
    const root = cards[0]!.cardRoot;
    root.style.overflow = "hidden";
    cards[0]!.description = "这是一条需要显示在视频下方的完整文案";
    const controller = new GridOverlayController(document, window);
    controller.render(cards);

    const shadow = shadowAt("#card-a");
    expect(root.style.overflow).toBe("visible");
    expect(root.style.getPropertyPriority("overflow")).toBe("important");
    expect(shadow.querySelector<HTMLElement>("[data-footer]")?.hidden).toBe(false);
    expect(shadow.querySelector<HTMLElement>("[data-description-text]")?.textContent)
      .toBe("这是一条需要显示在视频下方的完整文案");
    const metaRow = shadow.querySelector<HTMLElement>("[data-footer-meta]")!;
    expect(metaRow.hidden).toBe(false);
    expect(metaRow.contains(chip(shadow, "ad"))).toBe(true);
    expect(metaRow.contains(shadow.querySelector<HTMLElement>("[data-description]"))).toBe(true);
    expect(chip(shadow, "share").hidden).toBe(false);
    expect(chip(shadow, "comment").hidden).toBe(false);
    expect(chip(shadow, "like").hidden).toBe(false);

    controller.destroy();
    expect(root.style.overflow).toBe("hidden");
  });

  it("把底栏指标排成等宽边框，并提供去井号的一键复制文案", async () => {
    const cards = fixtureCards();
    cards[0]!.description = "Part 1 #aistory #fruitstory #aifruit";
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const controller = new GridOverlayController(document, window);
    controller.render(cards);

    const shadow = shadowAt("#card-a");
    const metrics = shadow.querySelector<HTMLElement>("[data-footer] .tda-grid-footer-metrics")!;
    const metaRow = shadow.querySelector<HTMLElement>("[data-footer-meta]")!;
    const classification = shadow.querySelector<HTMLElement>('[data-zone="classification"]')!;
    const description = shadow.querySelector<HTMLButtonElement>("[data-copy-description]")!;
    const style = shadow.querySelector("style")?.textContent ?? "";
    expect(style).toContain("border: 1px solid rgba(96,165,250,.62)");
    expect(style).toContain("grid-auto-columns: minmax(0, 1fr)");
    expect(style).toContain(".tda-grid-footer-meta { display: flex");
    expect(style).toContain("min-height: 18px");
    expect(style).toContain("flex: 0 0 auto");
    expect(metrics.hidden).toBe(false);
    expect(metrics.nextElementSibling).toBe(metaRow);
    expect(metaRow.contains(classification)).toBe(true);
    expect(metaRow.contains(description)).toBe(true);
    expect(chip(shadow, "ad").querySelector("svg")).toBeNull();
    expect(chip(shadow, "product").querySelector("svg")).toBeNull();
    expect(description.textContent).toContain("Part 1 aistory fruitstory aifruit");
    expect(description.textContent).not.toContain("#");
    expect(formatTopicText("#topic 普通文案 #第二话题")).toBe("topic 普通文案 第二话题");

    description.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(
      "Part 1 aistory fruitstory aifruit",
    ));
    expect(description.dataset.copyState).toBe("success");
    controller.destroy();
  });

  it("不重复 TikTok 已显示的播放量和时长，缺失原生值时才补充", () => {
    const controller = new GridOverlayController(document, window);
    controller.render(fixtureCards());

    expect(chip(shadowAt("#card-a"), "play").hidden).toBe(true);
    expect(chip(shadowAt("#card-a"), "duration").hidden).toBe(false);
    expect(chip(shadowAt("#card-b"), "play").hidden).toBe(true);
    expect(chip(shadowAt("#card-b"), "duration").hidden).toBe(true);
    expect(chip(shadowAt("#card-b"), "like").hidden).toBe(false);
    expect(chip(shadowAt("#card-b"), "comment").hidden).toBe(false);
    expect(chip(shadowAt("#card-b"), "collect").hidden).toBe(true);
    expect(chip(shadowAt("#card-b"), "share").hidden).toBe(false);
    expect(chip(shadowAt("#card-c"), "play").hidden).toBe(false);
    expect(chip(shadowAt("#card-c"), "play").textContent).toContain("125.7K");
    expect(chip(shadowAt("#card-c"), "duration").textContent).toContain("0:09");
    expect(chip(shadowAt("#card-c"), "collect").hidden).toBe(true);
    controller.destroy();
  });

  it("图文卡同样注入；指标不全时隐藏互动率，缺绝对时间不显示相对日期", () => {
    const controller = new GridOverlayController(document, window);
    controller.render(fixtureCards());
    const c = shadowAt("#card-c");

    expect(chip(c, "comment").hidden).toBe(true);
    expect(chip(c, "engagement").hidden).toBe(true);
    expect(chip(c, "date").hidden).toBe(true);
    expect(chip(c, "product").hidden).toBe(false);
    expect(chip(c, "product").textContent).toContain("带货");
    expect(document.querySelector<HTMLElement>("#card-c")?.querySelector(LABEL_SELECTOR)?.getAttribute("data-tiktok-daren-assistant")).toBe("grid-card-label");
    expect(c.querySelector(".tda-grid-layer")?.textContent).not.toContain("--");
    controller.destroy();
  });

  it("重复扫描不重复注入，并只保留调用方标记的视口附近卡片", () => {
    const cards = fixtureCards();
    cards[1]!.isNearViewport = false;
    const first = new GridOverlayController(document, window);
    first.render(cards);
    first.render(cards);
    expect(document.querySelectorAll(LABEL_SELECTOR)).toHaveLength(2);

    first.destroy();
    const rebuilt = new GridOverlayController(document, window);
    expect(rebuilt.render(fixtureCards())).toBe(3);
    expect(document.querySelectorAll(LABEL_SELECTOR)).toHaveLength(3);
    for (const card of fixtureCards()) expect(card.cardRoot.querySelectorAll(LABEL_SELECTOR)).toHaveLength(1);
    rebuilt.destroy();
  });

  it("网格模式隐藏遗留单视频大浮层", () => {
    const legacy = document.createElement("div");
    legacy.setAttribute("data-tiktok-daren-assistant", "video-overlay");
    legacy.style.display = "block";
    document.body.append(legacy);
    const controller = new GridOverlayController(document, window);
    controller.render(fixtureCards());
    expect(legacy.style.display).toBe("none");
    controller.destroy();
  });

  it("只在 hover 卡片显示快捷操作，并把点击绑定到该卡片 descriptor", async () => {
    const cards = fixtureCards();
    const descriptorA = {
      video_id: cards[0]!.videoId!,
      page_url: `https://www.tiktok.com/@fixture/video/${cards[0]!.videoId}`,
      media_url: "https://v16.tiktokcdn.com/a.mp4",
      media_source: "registry_play_url" as const,
      background_music_url: null,
      music_title: null,
      author_unique_id: "author_a",
      author_nickname: "作者 A",
      description: "A 视频",
      created_at: 1_720_000_000,
    };
    const descriptorB = {
      ...descriptorA,
      video_id: cards[1]!.videoId!,
      page_url: `https://www.tiktok.com/@fixture/video/${cards[1]!.videoId}`,
      media_url: "https://v16.tiktokcdn.com/b.mp4",
      author_unique_id: "author_b",
      description: "B 视频",
    };
    cards[0]!.mediaDescriptor = descriptorA;
    cards[1]!.mediaDescriptor = descriptorB;
    const onDownload = vi.fn(async () => undefined);
    const controller = new GridOverlayController(document, window, { onDownload });
    controller.render(cards);
    controller.setHoveredVideoId(descriptorB.video_id);

    const hostA = document.querySelector<HTMLElement>("#card-a")!.querySelector<HTMLElement>(LABEL_SELECTOR)!;
    const hostB = document.querySelector<HTMLElement>("#card-b")!.querySelector<HTMLElement>(LABEL_SELECTOR)!;
    expect(hostA.hasAttribute("data-hovered")).toBe(false);
    expect(hostB.hasAttribute("data-hovered")).toBe(true);
    expect(hostB.shadowRoot!.querySelector<HTMLElement>("[data-quick-actions]")!.hidden).toBe(false);

    hostB.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="audio_track"]')!.click();
    await vi.waitFor(() => expect(onDownload).toHaveBeenCalledTimes(1));
    expect(onDownload).toHaveBeenCalledWith(descriptorB, "audio_track");
    expect(onDownload).not.toHaveBeenCalledWith(descriptorA, expect.anything());
    controller.destroy();
  });

  it("作者主页卡片显示独立勾选框，点击不会穿透到视频链接", () => {
    const cards = fixtureCards();
    cards[0]!.batchSelectable = true;
    cards[0]!.batchSelected = true;
    const onBatchSelectionChange = vi.fn();
    const controller = new GridOverlayController(document, window, { onBatchSelectionChange });
    controller.render(cards);

    const host = document.querySelector<HTMLElement>("#card-a")!.querySelector<HTMLElement>(LABEL_SELECTOR)!;
    const select = host.shadowRoot!.querySelector<HTMLButtonElement>("[data-batch-select]")!;
    expect(select.hidden).toBe(false);
    expect(select.getAttribute("aria-checked")).toBe("true");
    expect(host.hasAttribute("data-batch-selected")).toBe(true);

    select.click();
    expect(onBatchSelectionChange).toHaveBeenCalledWith(cards[0]!.videoId, false);
    expect(select.getAttribute("aria-checked")).toBe("false");
    expect(host.hasAttribute("data-batch-selected")).toBe(false);
    controller.destroy();
  });
});
