import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AutoScrollController,
  EMPTY_PROFILE_FILTER,
  ProfileToolbarController,
  calculateEngagementRate,
  exportProfileVideosCsv,
  filterProfileVideos,
  resolveProfileCardLayoutRoot,
  sortProfileVideos,
  type ProfileVideoItem,
} from "../src/content/profileToolbar";

function items(withRoots = false): ProfileVideoItem[] {
  const roots = withRoots ? Array.from(document.querySelectorAll<HTMLElement>("article")) : [];
  return [
    {
      video_id: "1111111111111111111", is_ad: false, cardRoot: roots[0], author_unique_id: "creator",
      description: "低播放 户外", created_at: 1_700_000_000, play_count: 100, like_count: 50,
      comment_count: 5, collect_count: 10, share_count: 2, duration_seconds: 12,
      page_url: "https://www.tiktok.com/@creator/video/1111111111111111111", isVisible: true,
    },
    {
      video_id: "2222222222222222222", is_ad: true, cardRoot: roots[1], author_unique_id: "creator",
      description: "高播放 厨房", created_at: 1_720_000_000, play_count: 3000, like_count: 800,
      comment_count: 70, collect_count: 400, share_count: 30, duration_seconds: 45,
      page_url: "https://www.tiktok.com/@creator/video/2222222222222222222", isVisible: true,
    },
    {
      video_id: "3333333333333333333", is_ad: null, cardRoot: roots[2], author_unique_id: "guest",
      description: "=危险公式", created_at: null, play_count: null, like_count: 200,
      comment_count: null, collect_count: 90, share_count: null, duration_seconds: 90,
      page_url: "https://www.tiktok.com/@guest/video/3333333333333333333", isVisible: false,
    },
  ];
}

function dynamicItem(root: HTMLElement): ProfileVideoItem {
  return {
    video_id: "4444444444444444444", is_ad: false, cardRoot: root, author_unique_id: "creator",
    description: "动态加载 厨房", created_at: 1_730_000_000, play_count: 6000, like_count: 1000,
    comment_count: 100, collect_count: 500, share_count: 40, duration_seconds: 36,
    page_url: "https://www.tiktok.com/@creator/video/4444444444444444444", isVisible: true,
  };
}

describe("达人主页互动率、排序和筛选纯逻辑", () => {
  it("严格按已确认公式计算互动率，播放为空或指标不完整时返回 null", () => {
    expect(calculateEngagementRate(items()[0]!)).toBeCloseTo(67, 8);
    expect(calculateEngagementRate(items()[1]!)).toBeCloseTo(43.333333, 5);
    expect(calculateEngagementRate(items()[2]!)).toBeNull();
    expect(calculateEngagementRate({ ...items()[0]!, play_count: 0 })).toBeNull();
    expect(calculateEngagementRate({ ...items()[0]!, share_count: null })).toBeNull();
  });

  it("支持默认、时间、全部核心指标和互动率排序，空值始终置后", () => {
    const source = items();
    expect(sortProfileVideos(source, "default").map((item) => item.video_id)).toEqual([
      "1111111111111111111", "2222222222222222222", "3333333333333333333",
    ]);
    expect(sortProfileVideos(source, "created_desc").map((item) => item.video_id)).toEqual([
      "2222222222222222222", "1111111111111111111", "3333333333333333333",
    ]);
    expect(sortProfileVideos(source, "created_asc").map((item) => item.video_id)).toEqual([
      "1111111111111111111", "2222222222222222222", "3333333333333333333",
    ]);
    for (const mode of ["play_desc", "like_desc", "comment_desc", "collect_desc", "share_desc"] as const) {
      expect(sortProfileVideos(source, mode)[0]?.video_id).toBe("2222222222222222222");
    }
    expect(sortProfileVideos(source, "engagement_desc").map((item) => item.video_id)).toEqual([
      "1111111111111111111", "2222222222222222222", "3333333333333333333",
    ]);
    expect(source[0]?.video_id).toBe("1111111111111111111");
  });

  it("关键词和所有日期/指标/互动率范围可组合，边界包含且未知值不误入", () => {
    const result = filterProfileVideos(items(), {
      ...EMPTY_PROFILE_FILTER,
      keyword: "厨房",
      createdFrom: 1_710_000_000,
      createdTo: 1_720_000_000,
      minDurationSeconds: 40,
      maxDurationSeconds: 50,
      minPlayCount: 2000,
      maxPlayCount: 3000,
      minLikeCount: 700,
      maxLikeCount: 800,
      minCommentCount: 60,
      maxCommentCount: 70,
      minCollectCount: 300,
      maxCollectCount: 400,
      minShareCount: 20,
      maxShareCount: 30,
      minEngagementRate: 40,
      maxEngagementRate: 44,
    });
    expect(result.map((item) => item.video_id)).toEqual(["2222222222222222222"]);
    expect(filterProfileVideos(items(), { ...EMPTY_PROFILE_FILTER, keyword: "GUEST" })[0]?.video_id)
      .toBe("3333333333333333333");
    expect(filterProfileVideos(items(), { ...EMPTY_PROFILE_FILTER, minEngagementRate: 0 }))
      .toHaveLength(2);
  });

  it("广告、非广告和未知状态严格分开，并可与其他条件组合", () => {
    expect(filterProfileVideos(items(), { ...EMPTY_PROFILE_FILTER, adMode: "ad" })
      .map((item) => item.video_id)).toEqual(["2222222222222222222"]);
    expect(filterProfileVideos(items(), { ...EMPTY_PROFILE_FILTER, adMode: "non_ad" })
      .map((item) => item.video_id)).toEqual(["1111111111111111111"]);
    expect(filterProfileVideos(items(), { ...EMPTY_PROFILE_FILTER, adMode: "all" }))
      .toHaveLength(3);
    expect(filterProfileVideos(items(), {
      ...EMPTY_PROFILE_FILTER,
      adMode: "ad",
      minPlayCount: 2_000,
      maxDurationSeconds: 50,
    }).map((item) => item.video_id)).toEqual(["2222222222222222222"]);
    expect(filterProfileVideos(items(), {
      ...EMPTY_PROFILE_FILTER,
      adMode: "ad",
      minPlayCount: 4_000,
    })).toEqual([]);
  });
});

describe("达人主页 sticky 工具栏和真实 DOM 行为", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main><section id="grid"><article id="a"><span>A 原内容</span></article><article id="b"><span>B 原内容</span></article><article id="c"><span>C 原内容</span></article></section></main>`;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("工具栏滚动时 sticky，提供全部真实排序选项且没有质量得分", () => {
    const controller = new ProfileToolbarController(document, window);
    const host = controller.mount(document.querySelector<HTMLElement>("#grid")!, items(true));
    expect(host.style.position).toBe("sticky");
    expect(host.style.top).toBe("8px");
    const sortLabels = Array.from(host.shadowRoot!.querySelectorAll('[data-action="sort"] option'))
      .map((option) => option.textContent);
    expect(sortLabels).toEqual([
      "默认顺序",
      "最新发布",
      "最早发布",
      "播放量最高",
      "点赞量最高",
      "评论量最高",
      "收藏量最高",
      "分享量最高",
      "互动率最高",
    ]);
    const adLabels = Array.from(host.shadowRoot!.querySelectorAll('[data-action="filter-ad"] option'))
      .map((option) => option.textContent);
    expect(adLabels).toEqual(["全部视频", "广告视频", "非广告视频"]);
    expect(host.shadowRoot?.textContent).not.toContain("质量得分");
    controller.destroy();
  });

  it("祖先布局限制 sticky 时会固定到视口，并可在自动滚动中停止后归位", () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const alignmentRoot = grid.parentElement!;
    const controller = new ProfileToolbarController(document, window, { autoScrollStep: vi.fn() });
    const host = controller.mount(grid, items(true));
    const anchor = document.querySelector<HTMLElement>(
      '[data-tiktok-daren-assistant="profile-toolbar-anchor"]',
    )!;
    let anchorTop = -20;
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(() => ({
      x: 40, y: anchorTop, top: anchorTop, left: 40, right: 740, bottom: anchorTop,
      width: 700, height: 0, toJSON: () => ({}),
    }));
    vi.spyOn(alignmentRoot, "getBoundingClientRect").mockImplementation(() => ({
      x: 40, y: 0, top: 0, left: 40, right: 740, bottom: 900,
      width: 700, height: 900, toJSON: () => ({}),
    }));
    vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => ({
      x: 40, y: 8, top: 8, left: 40, right: 740, bottom: 48,
      width: 700, height: 40, toJSON: () => ({}),
    }));

    window.dispatchEvent(new Event("scroll"));
    expect(host.parentElement).toBe(document.body);
    expect(host.style.getPropertyValue("position")).toBe("fixed");
    expect(host.style.getPropertyPriority("position")).toBe("important");
    expect(host.style.top).toBe("8px");
    expect(host.style.left).toBe("40px");
    expect(host.style.width).toBe("700px");
    expect(anchor.style.height).toBe("56px");

    const autoButton = host.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="toggle-auto-scroll"]')!;
    autoButton.click();
    expect(controller.getState().autoScrolling).toBe(true);
    autoButton.click();
    expect(controller.getState().autoScrolling).toBe(false);

    anchorTop = 120;
    window.dispatchEvent(new Event("scroll"));
    expect(host.parentElement).toBe(alignmentRoot);
    expect(anchor.nextSibling).toBe(host);
    expect(host.style.position).toBe("sticky");
    expect(host.style.getPropertyPriority("position")).toBe("important");
    expect(anchor.style.height).toBe("0px");
    controller.destroy();
  });

  it("排序后可恢复默认视觉顺序；只移动/隐藏卡片根，不修改 TikTok 卡片内容", () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const originalContent = Array.from(grid.querySelectorAll("article")).map((node) => node.innerHTML);
    const controller = new ProfileToolbarController(document, window);
    controller.mount(grid, items(true));
    controller.setSortMode("play_desc");
    expect(Array.from(grid.querySelectorAll("article")).map((node) => node.id)).toEqual(["b", "a", "c"]);

    controller.setFilter({ ...EMPTY_PROFILE_FILTER, minPlayCount: 500 });
    expect(document.querySelector<HTMLElement>("#a")?.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#b")?.style.display).not.toBe("none");
    expect(Array.from(grid.querySelectorAll("article")).map((node) => node.innerHTML).sort()).toEqual([...originalContent].sort());

    controller.setSortMode("default");
    expect(Array.from(grid.querySelectorAll("article")).map((node) => node.id)).toEqual(["a", "b", "c"]);
    controller.destroy();
    expect(document.querySelector<HTMLElement>("#a")?.style.display).toBe("");
  });

  it("动态新增卡片后继续执行当前筛选和排序，重复更新不重复移动", () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const controller = new ProfileToolbarController(document, window);
    const source = items(true);
    controller.mount(grid, source);
    controller.setSortMode("play_desc");
    controller.setFilter({ ...EMPTY_PROFILE_FILTER, minPlayCount: 500 });

    const rootD = document.createElement("article");
    rootD.id = "d";
    rootD.innerHTML = "<span>D 原内容</span>";
    grid.append(rootD);
    const next = [...source, dynamicItem(rootD)];
    controller.update(next);
    const visibleOrder = Array.from(grid.querySelectorAll<HTMLElement>("article"))
      .filter((root) => root.style.display !== "none")
      .map((root) => root.id);
    expect(visibleOrder).toEqual(["d", "b"]);

    const observer = new MutationObserver(() => undefined);
    observer.observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    observer.takeRecords();
    controller.update(next.map((item) => ({ ...item })));
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    controller.destroy();
  });

  it("筛选后遇到瞬时空或部分快照时保留当前结果且不反复恢复卡片", () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const source = items(true);
    const controller = new ProfileToolbarController(document, window);
    const host = controller.mount(grid, source);
    controller.setFilter({ ...EMPTY_PROFILE_FILTER, adMode: "non_ad" });

    const observer = new MutationObserver(() => undefined);
    observer.observe(grid, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "hidden", "data-tiktok-daren-assistant-filtered"],
    });
    observer.takeRecords();

    controller.update([]);
    expect(controller.getDisplayedItems().map((item) => item.video_id))
      .toEqual(["1111111111111111111"]);
    expect(controller.getBatchItems().map((item) => item.video_id))
      .toEqual(["1111111111111111111"]);
    expect(host.shadowRoot?.querySelector('[data-count="identified"]')?.textContent).toBe("3");
    expect(host.shadowRoot?.querySelector('[data-count="visible"]')?.textContent).toBe("1");
    expect(document.querySelector<HTMLElement>("#a")?.style.display).toBe("");
    expect(document.querySelector<HTMLElement>("#b")?.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#c")?.style.display).toBe("none");
    expect(observer.takeRecords()).toHaveLength(0);

    controller.update([{ ...source[0]!, play_count: 150 }]);
    expect(controller.getDisplayedItems().map((item) => item.video_id))
      .toEqual(["1111111111111111111"]);
    expect(host.shadowRoot?.querySelector('[data-count="identified"]')?.textContent).toBe("3");
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    controller.destroy();
  });

  it("卡片真的离开网格后才清理记录，并且不会用旧锚点把节点插回来", () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const source = items(true);
    const removedRoot = source[1]!.cardRoot!;
    const controller = new ProfileToolbarController(document, window);
    controller.mount(grid, source);
    controller.setFilter({ ...EMPTY_PROFILE_FILTER, adMode: "ad" });

    removedRoot.remove();
    controller.update([source[0]!, source[2]!]);

    expect(removedRoot.isConnected).toBe(false);
    expect(grid.contains(removedRoot)).toBe(false);
    expect(controller.getDisplayedItems()).toEqual([]);
    expect(controller.getBatchItems()).toEqual([]);
    controller.destroy();
  });

  it("广告状态从非广告更新为广告后立即重排结果，全部模式会完整恢复卡片", () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const source = items(true);
    const controller = new ProfileToolbarController(document, window);
    const host = controller.mount(grid, source);
    const adSelect = host.shadowRoot!.querySelector<HTMLSelectElement>('[data-action="filter-ad"]')!;

    adSelect.value = "ad";
    adSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(controller.getState().filter.adMode).toBe("ad");
    expect(controller.getDisplayedItems().map((item) => item.video_id)).toEqual(["2222222222222222222"]);
    expect(controller.getBatchItems().map((item) => item.video_id)).toEqual(["2222222222222222222"]);
    expect(document.querySelector<HTMLElement>("#a")?.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#b")?.style.display).toBe("");
    expect(document.querySelector<HTMLElement>("#c")?.style.display).toBe("none");
    expect(host.shadowRoot?.querySelector('[data-count="visible"]')?.textContent).toBe("1");

    controller.update(source.map((item) => item.video_id === "1111111111111111111"
      ? { ...item, is_ad: true }
      : item));
    expect(controller.getDisplayedItems().map((item) => item.video_id)).toEqual([
      "1111111111111111111", "2222222222222222222",
    ]);
    expect(controller.getBatchItems()).toHaveLength(2);
    expect(document.querySelector<HTMLElement>("#a")?.style.display).toBe("");
    expect(document.querySelector<HTMLElement>("#c")?.style.display).toBe("none");

    adSelect.value = "all";
    adSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(controller.getDisplayedItems()).toHaveLength(3);
    expect(Array.from(grid.querySelectorAll<HTMLElement>("article"))
      .every((root) => root.style.display === "" && !root.hidden)).toBe(true);
    controller.destroy();
  });

  it("非广告筛选排除未知状态，并让批量范围和 CSV 只使用当前结果", () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const onExport = vi.fn();
    const controller = new ProfileToolbarController(document, window, { onExport });
    const host = controller.mount(grid, items(true));
    const adSelect = host.shadowRoot!.querySelector<HTMLSelectElement>('[data-action="filter-ad"]')!;

    adSelect.value = "non_ad";
    adSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(controller.getDisplayedItems().map((item) => item.video_id)).toEqual(["1111111111111111111"]);
    expect(controller.getBatchItems().map((item) => item.video_id)).toEqual(["1111111111111111111"]);
    expect(host.shadowRoot?.querySelector('[data-count="selected"]')?.textContent).toBe("1");
    host.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="export"]')!.click();

    expect(onExport).toHaveBeenCalledTimes(1);
    const csv = onExport.mock.calls[0]?.[0] as string;
    expect(csv).toContain("1111111111111111111");
    expect(csv).not.toContain("2222222222222222222");
    expect(csv).not.toContain("3333333333333333333");
    expect(csv).toContain("video_id,作者账号,视频描述,发布时间,播放量,点赞量,评论量,收藏量,分享量,互动率(%),时长(秒),视频链接");
    controller.destroy();
  });

  it("隐藏和排序真正的网格布局项，不留下只有白色外壳的占位", () => {
    document.body.innerHTML = `
      <section id="grid" data-e2e="user-post-item-list">
        <div id="slot-a"><article id="a"><a href="/@creator/video/1111111111111111111"><span>A 原内容</span></a></article></div>
        <div id="slot-b"><article id="b"><a href="/@creator/video/2222222222222222222"><span>B 原内容</span></a></article></div>
        <div id="slot-c"><article id="c"><a href="/@guest/photo/3333333333333333333"><span>C 原内容</span></a></article></div>
      </section>`;
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const innerRoots = Array.from(document.querySelectorAll<HTMLElement>("article"));
    const source = items().map((item, index) => ({
      ...item,
      content_type: index === 2 ? "photo" as const : "video" as const,
      cardRoot: resolveProfileCardLayoutRoot(innerRoots[index]!, grid, item.video_id),
    }));
    expect(source.map((item) => item.cardRoot?.id)).toEqual(["slot-a", "slot-b", "slot-c"]);

    const controller = new ProfileToolbarController(document, window);
    const host = controller.mount(grid, source);
    controller.setSortMode("play_desc");
    expect(Array.from(grid.children).filter((node) => node instanceof HTMLElement).map((node) => node.id))
      .toEqual(["slot-b", "slot-a", "slot-c"]);
    expect(document.querySelector<HTMLElement>("#slot-b")?.style.getPropertyPriority("order")).toBe("important");

    controller.setFilter({ ...EMPTY_PROFILE_FILTER, minPlayCount: 500 });
    expect(document.querySelector<HTMLElement>("#slot-a")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#slot-a")?.style.getPropertyPriority("display")).toBe("important");
    expect(document.querySelector<HTMLElement>("#slot-a")?.getAttribute("data-tiktok-daren-assistant-filtered")).toBe("true");
    expect(document.querySelector<HTMLElement>("#a")?.hidden).toBe(false);
    expect(host.shadowRoot?.querySelector('[data-count="visible"]')?.textContent).toBe("1");
    expect(controller.getBatchItems().map((item) => item.video_id)).toEqual(["2222222222222222222"]);
    controller.destroy();
  });

  it("批量范围沿用筛选和排序顺序，并可在工具栏全选或取消", () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const source = items(true).map((item, index) => ({
      ...item,
      content_type: index === 2 ? "photo" as const : "video" as const,
    }));
    const controller = new ProfileToolbarController(document, window);
    const host = controller.mount(grid, source);
    controller.setFilter({ ...EMPTY_PROFILE_FILTER, minPlayCount: 0 });
    controller.setSortMode("play_desc");
    expect(controller.getBatchItems().map((item) => item.video_id)).toEqual([
      "2222222222222222222", "1111111111111111111",
    ]);
    expect(host.shadowRoot?.querySelector('[data-count="selected"]')?.textContent).toBe("2");

    const checkbox = host.shadowRoot!.querySelector<HTMLInputElement>('[data-action="select-all-results"]')!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(controller.getBatchItems()).toEqual([]);
    expect(host.shadowRoot?.querySelector('[data-count="selected"]')?.textContent).toBe("0");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(controller.getBatchItems()).toHaveLength(2);
    controller.destroy();
  });

  it("支持逐条排除和恢复视频，并同步全选框的半选状态", () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const onBatchSelectionChange = vi.fn();
    const controller = new ProfileToolbarController(document, window, { onBatchSelectionChange });
    const host = controller.mount(grid, items(true));
    const firstId = controller.getBatchItems()[0]!.video_id;
    const selectAll = host.shadowRoot!.querySelector<HTMLInputElement>('[data-action="select-all-results"]')!;

    controller.setItemSelected(firstId, false);
    expect(controller.isItemSelected(firstId)).toBe(false);
    expect(controller.getBatchItems()).toHaveLength(2);
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);

    controller.setItemSelected(firstId, true);
    expect(controller.getBatchItems()).toHaveLength(3);
    expect(selectAll.checked).toBe(true);
    expect(selectAll.indeterminate).toBe(false);
    expect(onBatchSelectionChange).toHaveBeenCalledTimes(2);
    controller.destroy();
  });

  it("页内批量按钮直接处理筛选结果，并且只显示圆形进度反馈", async () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const onBatchDownload = vi.fn(async (
      selected: readonly ProfileVideoItem[],
      mode: "video" | "audio_track",
      onProgress: (progress: {
        processed: number; total: number; succeeded: number; failed: number;
        status: "running";
      }) => void,
    ) => {
      expect(selected).toHaveLength(3);
      expect(mode).toBe("video");
      onProgress({ processed: 2, total: 3, succeeded: 2, failed: 0, status: "running" });
    });
    const controller = new ProfileToolbarController(document, window, { onBatchDownload });
    const host = controller.mount(grid, items(true));
    const button = host.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="batch-download-video"]')!;
    expect(host.shadowRoot!.querySelector('[data-action="batch-download-audio"]')).not.toBeNull();
    expect(button.textContent?.trim()).toBe("");
    button.click();

    await vi.waitFor(() => expect(onBatchDownload).toHaveBeenCalledTimes(1));
    const progress = host.shadowRoot!.querySelector<HTMLOutputElement>("[data-batch-progress]")!;
    expect(progress.hidden).toBe(false);
    expect(progress.querySelector("[data-batch-percent]")?.textContent).toBe("100%");
    expect(host.shadowRoot?.querySelector(".tda-batch-modal")).toBeNull();
    controller.destroy();
  });

  it("筛选面板应用和重置会真实隐藏/恢复卡片，重复 mount 仍只有一条工具栏", () => {
    const grid = document.querySelector<HTMLElement>("#grid")!;
    const controller = new ProfileToolbarController(document, window);
    const host = controller.mount(grid, items(true));
    controller.mount(grid, items(true));
    expect(document.querySelectorAll('[data-tiktok-daren-assistant="profile-toolbar"]')).toHaveLength(1);
    const shadow = host.shadowRoot!;

    shadow.querySelector<HTMLButtonElement>('[data-action="toggle-filter"]')!.click();
    shadow.querySelector<HTMLInputElement>('[data-filter="keyword"]')!.value = "厨房";
    shadow.querySelector<HTMLInputElement>('[data-filter="min-play"]')!.value = "1000";
    shadow.querySelector<HTMLButtonElement>('[data-action="apply-filter"]')!.click();
    expect(document.querySelector<HTMLElement>("#a")?.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#b")?.style.display).toBe("");
    expect(document.querySelector<HTMLElement>("#c")?.style.display).toBe("none");
    expect(controller.getState().filter.keyword).toBe("厨房");

    shadow.querySelector<HTMLButtonElement>('[data-action="toggle-filter"]')!.click();
    shadow.querySelector<HTMLButtonElement>('[data-action="reset-filter"]')!.click();
    expect(Array.from(grid.querySelectorAll<HTMLElement>("article")).every((root) => root.style.display === "")).toBe(true);
    expect(shadow.querySelector<HTMLInputElement>('[data-filter="keyword"]')?.value).toBe("");
    expect(shadow.querySelector<HTMLSelectElement>('[data-action="filter-ad"]')?.value).toBe("all");
    controller.destroy();
  });

  it("自动滚动默认关闭、开启不叠加、停止后立即不再滚动", () => {
    vi.useFakeTimers();
    const step = vi.fn();
    const controller = new ProfileToolbarController(document, window, { autoScrollStep: step, autoScrollIntervalMs: 100 });
    controller.mount(document.querySelector<HTMLElement>("#grid")!, items(true));
    controller.startAutoScroll();
    controller.startAutoScroll();
    expect(step).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(step).toHaveBeenCalledTimes(3);
    controller.stopAutoScroll();
    vi.advanceTimersByTime(500);
    expect(step).toHaveBeenCalledTimes(3);
    expect(controller.getState().autoScrolling).toBe(false);
    controller.destroy();
  });
});

describe("达人主页 CSV", () => {
  it("包含 UTF-8 BOM、真实指标、互动率和每条 video_id，并防止公式注入", () => {
    const csv = exportProfileVideosCsv(items());
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(new TextEncoder().encode(csv).slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(csv).toContain("video_id,作者账号,视频描述,发布时间,播放量,点赞量,评论量,收藏量,分享量,互动率(%),时长(秒),视频链接");
    expect(csv).toContain("2222222222222222222");
    expect(csv).toContain("43.333333333333336");
    expect(csv).toContain("'=危险公式");
  });
});

describe("自动滚动计时器", () => {
  it("stop 会清除唯一计时器", () => {
    const step = vi.fn();
    const cancel = vi.fn();
    const controller = new AutoScrollController(step, () => 7, cancel, 100);
    expect(controller.running).toBe(false);
    controller.start();
    controller.start();
    expect(step).toHaveBeenCalledTimes(1);
    controller.stop();
    expect(cancel).toHaveBeenCalledWith(7);
    expect(controller.running).toBe(false);
  });
});
