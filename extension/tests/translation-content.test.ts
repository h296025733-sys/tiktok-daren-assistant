import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TranslationRequest, TranslationResponse } from "../src/types/messages";
import {
  AUTO_TRANSLATION_REFRESH_INTERVAL_MS,
  TranslationClient,
  TranslationController,
  collectPublicTranslationTargets,
  openOfficialTranslateFallback,
  type TranslationPageContext,
} from "../src/content/translation";

function successResponse(texts: string[]): TranslationResponse {
  return {
    ok: true,
    data: {
      items: texts.map((text) => ({
        source_text: text,
        translated_text: `中文：${text}`,
        detected_source_language: "en",
        target_language: "zh-CN",
        cached: false,
        provider: "google_translate_web",
      })),
      provider: "google_first_chain",
      provider_notice: "非稳定接口",
    },
  };
}

function successfulSendMessage() {
  return vi.fn(async (request: TranslationRequest): Promise<TranslationResponse> => {
    const texts = request.type === "TRANSLATE_PUBLIC_TEXT" ? [request.text] : request.texts;
    return successResponse(texts);
  });
}

function translationHosts(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-tiktok-daren-assistant="translation"]'),
  );
}

const profileSecondaryVideoCommentsFixture = readFileSync(
  resolve(process.cwd(), "tests/fixtures/profile-secondary-video-comments.html"),
  "utf8",
);

beforeEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  for (const element of document.querySelectorAll("[data-tiktok-daren-assistant]")) element.remove();
});

describe("content-script translation transport", () => {
  it("keeps the production translation path in the background without opening a panel", async () => {
    const runtimeSendMessage = vi.fn(async (request: TranslationRequest): Promise<TranslationResponse> => {
      const texts = request.type === "TRANSLATE_PUBLIC_TEXT" ? [request.text] : request.texts;
      return successResponse(texts);
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage: runtimeSendMessage } });

    const client = new TranslationClient();
    await expect(client.translateText("Inline comment")).resolves.toMatchObject({
      source_text: "Inline comment",
    });
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "Inline comment",
    });
  });

  it("honors an explicit legacy side-panel bridge override", async () => {
    const foregroundBridge = {
      prepare: vi.fn(),
      translate: vi.fn(async (request: TranslationRequest): Promise<TranslationResponse> => {
        const texts = request.type === "TRANSLATE_PUBLIC_TEXT" ? [request.text] : request.texts;
        return successResponse(texts);
      }),
    };
    const client = new TranslationClient({ foregroundBridge });

    await expect(client.translateText("Visible comment")).resolves.toMatchObject({
      translated_text: "中文：Visible comment",
    });
    expect(foregroundBridge.translate).toHaveBeenCalledTimes(1);
  });

  it("uses foreground Google translation without messaging the MV3 worker", async () => {
    const handle = vi.fn(async (request: TranslationRequest): Promise<TranslationResponse> => {
      const texts = request.type === "TRANSLATE_PUBLIC_TEXT" ? [request.text] : request.texts;
      return successResponse(texts);
    });
    const backgroundSendMessage = vi.fn(async (): Promise<TranslationResponse> => ({
      ok: false,
      error: "background should not run",
      code: "PROVIDER_UNAVAILABLE",
    }));
    const client = new TranslationClient({
      directService: { handle },
      backgroundSendMessage,
    });

    await expect(client.translateText("Visible TikTok comment")).resolves.toMatchObject({
      source_text: "Visible TikTok comment",
    });
    expect(handle).toHaveBeenCalledWith({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "Visible TikTok comment",
    });
    expect(backgroundSendMessage).not.toHaveBeenCalled();
  });

  it("uses the MV3/backend chain only when the foreground Google request fails", async () => {
    const handle = vi.fn(async (): Promise<TranslationResponse> => ({
      ok: false,
      error: "Google unavailable",
      code: "PROVIDER_UNAVAILABLE",
      diagnostic: "google_direct_fetch_failed:TypeError",
    }));
    const backgroundSendMessage = vi.fn(async (request: TranslationRequest) => {
      const texts = request.type === "TRANSLATE_PUBLIC_TEXT" ? [request.text] : request.texts;
      return successResponse(texts);
    });
    const client = new TranslationClient({
      directService: { handle },
      backgroundSendMessage,
    });

    await expect(client.translateText("Fallback comment")).resolves.toMatchObject({
      source_text: "Fallback comment",
    });
    expect(backgroundSendMessage).toHaveBeenCalledTimes(1);
  });

  it("queues work to the visible side panel after both direct and MV3 transports fail", async () => {
    const directHandle = vi.fn(async (): Promise<TranslationResponse> => ({
      ok: false,
      error: "Google unavailable",
      code: "PROVIDER_UNAVAILABLE",
      diagnostic: "google_direct_failed",
    }));
    const backgroundSendMessage = vi.fn(async (): Promise<TranslationResponse> => ({
      ok: false,
      error: "Worker loopback unavailable",
      code: "PROVIDER_UNAVAILABLE",
      diagnostic: "worker_local_failed",
    }));
    const foregroundBridge = {
      prepare: vi.fn(),
      translate: vi.fn(async (request: TranslationRequest): Promise<TranslationResponse> => {
        const texts = request.type === "TRANSLATE_PUBLIC_TEXT" ? [request.text] : request.texts;
        const response = successResponse(texts);
        if (!response.ok) throw new Error("测试成功响应构造失败");
        return {
          ...response,
          data: { ...response.data, provider: "local_foreground" },
        };
      }),
    };
    const client = new TranslationClient({
      directService: { handle: directHandle },
      backgroundSendMessage,
      foregroundBridge,
    });

    await expect(client.translateText("Foreground fallback comment")).resolves.toMatchObject({
      translated_text: "中文：Foreground fallback comment",
    });
    expect(backgroundSendMessage).toHaveBeenCalledTimes(1);
    expect(foregroundBridge.translate).toHaveBeenCalledWith({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "Foreground fallback comment",
    });
  });

  it("does not bypass validation or activate the reserved expert provider", async () => {
    const handle = vi.fn(async (): Promise<TranslationResponse> => ({
      ok: false,
      error: "Expert provider is not configured",
      code: "PROVIDER_NOT_CONFIGURED",
    }));
    const backgroundSendMessage = vi.fn();
    const client = new TranslationClient({
      directService: { handle },
      backgroundSendMessage,
    });

    await expect(client.translateText("Private provider", "zh-CN", "deepseek_expert"))
      .rejects.toMatchObject({ message: "Expert provider is not configured" });
    expect(backgroundSendMessage).not.toHaveBeenCalled();
  });
});

describe("页面按需翻译", () => {
  it("仅在本地模型确实缺失时显示离线包入口，并把安装意图交给小侧栏", async () => {
    document.body.innerHTML = '<p data-e2e="video-desc">Translate me</p>';
    const translate = vi.fn(async (): Promise<TranslationResponse> => ({
      ok: false,
      error: "在线翻译暂不可用",
      code: "LOCAL_MODEL_REQUIRED",
      required_model_ids: ["argos-ru-en", "argos-en-zh"],
    }));
    const runtimeSendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("chrome", { runtime: { sendMessage: runtimeSendMessage } });
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage: translate }),
      showBulkToolbar: false,
    });
    controller.refresh();

    await controller.translateElement(
      document.querySelector<HTMLElement>('[data-e2e="video-desc"]')!,
    );

    const install = translationHosts()[0]?.shadowRoot
      ?.querySelector<HTMLButtonElement>(".install-model");
    expect(install?.hidden).toBe(false);
    install?.click();
    await vi.waitFor(() => {
      expect(runtimeSendMessage).toHaveBeenCalledWith({
        type: "OPEN_SIDE_PANEL",
        view: "models",
        model_ids: ["argos-ru-en", "argos-en-zh"],
      });
    });
    controller.dispose();
  });

  it("Google 翻译成功时不显示也不触发任何离线模型流程", async () => {
    document.body.innerHTML = '<p data-e2e="video-desc">Translate me</p>';
    const runtimeSendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage: runtimeSendMessage } });
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage: successfulSendMessage() }),
      showBulkToolbar: false,
    });
    controller.refresh();

    await controller.translateElement(
      document.querySelector<HTMLElement>('[data-e2e="video-desc"]')!,
    );

    const install = translationHosts()[0]?.shadowRoot
      ?.querySelector<HTMLButtonElement>(".install-model");
    expect(install?.hidden).toBe(true);
    expect(runtimeSendMessage).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("失败时显示脱敏诊断码，便于一次定位链路", async () => {
    document.body.innerHTML = '<p data-e2e="video-desc">Translate me</p>';
    const sendMessage = vi.fn(async (): Promise<TranslationResponse> => ({
      ok: false,
      error: "侧栏无法完成翻译",
      code: "PROVIDER_UNAVAILABLE",
      diagnostic: "TDA-TR-03-B1:TypeError",
    }));
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      showBulkToolbar: false,
    });
    controller.refresh();

    await controller.translateElement(
      document.querySelector<HTMLElement>('[data-e2e="video-desc"]')!,
    );

    expect(translationHosts()[0]?.shadowRoot?.querySelector(".status")?.textContent)
      .toContain("诊断 TDA-TR-03-B1");
    controller.dispose();
  });

  it("只收集明确的公开文案和评论节点，排除输入区、草稿与助手自身节点", () => {
    document.body.innerHTML = `
      <p data-e2e="browse-video-desc">Public caption</p>
      <div data-e2e="comment-level-1"><p data-e2e="comment-text">Public comment</p></div>
      <div data-e2e="comment-level-1"><span class="TUXText">真实页面评论</span></div>
      <div data-e2e="comment-level-1"><span class="TUXText">[贴纸]</span><span class="TUXText">Second sentence</span></div>
      <div data-e2e="comment-level-1"><span class="TUXText">[貼圖]</span></div>
      <div data-e2e="comment-input"><div data-e2e="comment-text">添加评论...</div></div>
      <form><p data-e2e="comment-text">Draft text</p></form>
      <div contenteditable><p data-e2e="comment-text">Editing text</p></div>
      <div data-tiktok-daren-assistant="translation"><p data-e2e="comment-text">Assistant result</p></div>
      <div aria-hidden="true"><div data-e2e="comment-level-1"><span class="TUXText">Hidden text</span></div></div>
      <p class="unrelated">Unrelated page text</p>
    `;

    const targets = collectPublicTranslationTargets(document);
    expect(targets.map((target) => [target.kind, target.text])).toEqual([
      ["description", "Public caption"],
      ["comment", "Public comment"],
      ["comment", "真实页面评论"],
      ["comment", "Second sentence"],
    ]);
  });

  it("详情文案优先读取稳定文本子节点，不把展开按钮混入译文", () => {
    document.body.innerHTML = `
      <div data-e2e="browse-video-desc">
        <span data-e2e="new-desc-span">Mist &amp; shade, walking cloud.</span>
        <span data-e2e="search-common-link"><strong>#summer</strong></span>
        <button>更多</button>
      </div>
    `;
    expect(collectPublicTranslationTargets(document).map((target) => target.text)).toEqual([
      "Mist & shade, walking cloud. #summer",
    ]);
  });

  it("覆盖作者主页二次打开详情弹层中正文位于 comment-level 节点本身的评论与回复", async () => {
    document.body.innerHTML = profileSecondaryVideoCommentsFixture;
    const sendMessage = successfulSendMessage();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      resolveContext: () => ({
        identity: "detail:7647835388605943060",
        roots: [dialog],
        commentsOpen: true,
      }),
      showBulkToolbar: false,
    });

    expect(collectPublicTranslationTargets(dialog).map((target) => [target.kind, target.text]))
      .toEqual([
        ["description", "Smile more!!!"],
        ["comment", "Your so gorgeous this I literally your twin"],
        ["comment", "Literally Alex and Ava"],
        ["comment", "Thank you so much"],
      ]);

    controller.install();
    await expect(controller.translateLoaded()).resolves.toEqual({ translated: 4, total: 4 });
    expect(translationHosts()).toHaveLength(4);
    expect((sendMessage.mock.calls[0]?.[0] as { texts: string[] }).texts).toEqual([
      "Smile more!!!",
      "Your so gorgeous this I literally your twin",
      "Literally Alex and Ava",
      "Thank you so much",
    ]);
    expect(document.querySelector(
      '[data-e2e="comment-input"] [data-tiktok-daren-assistant="translation"]',
    )).toBeNull();

    document.querySelector('[data-e2e="comment-list"]')?.insertAdjacentHTML(
      "beforeend",
      '<div class="DivCommentItemContainer"><p data-e2e="comment-level-1">Loaded after scroll</p></div>',
    );
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    expect((sendMessage.mock.calls[1]?.[0] as { texts: string[] }).texts)
      .toEqual(["Loaded after scroll"]);

    document.querySelector('[data-e2e="comment-list"]')?.insertAdjacentHTML(
      "beforeend",
      '<div class="DivReplyContainer"><p data-e2e="comment-level-2">Loaded reply</p></div>',
    );
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3), { timeout: 1_000 });
    expect((sendMessage.mock.calls[2]?.[0] as { texts: string[] }).texts)
      .toEqual(["Loaded reply"]);
    controller.dispose();
  });

  it("只在真实评论区内显示两个图标工具，主页和普通文案场景保持隐藏", () => {
    document.body.innerHTML = '<div data-e2e="comment-input"><div data-e2e="comment-text">添加评论...</div></div>';
    const controller = new TranslationController(document, window);
    controller.install();
    const toolbar = document.querySelector<HTMLElement>(
      '[data-tiktok-daren-assistant="translation-toolbar"]',
    )!;
    expect(toolbar.hidden).toBe(true);

    const comment = document.createElement("div");
    comment.setAttribute("data-e2e", "comment-level-1");
    comment.innerHTML = '<span class="TUXText">Translate this public comment</span>';
    document.body.append(comment);
    controller.refresh();
    expect(toolbar.hidden).toBe(true);

    const commentList = document.createElement("section");
    commentList.setAttribute("data-e2e", "comment-list");
    commentList.append(comment);
    document.body.append(commentList);
    controller.refresh();
    expect(toolbar.hidden).toBe(false);
    expect(toolbar.parentElement).toBe(commentList);
    expect(toolbar.shadowRoot?.querySelectorAll("button")).toHaveLength(2);
    expect(toolbar.shadowRoot?.querySelectorAll("button span")).toHaveLength(0);
    controller.dispose();
  });

  it("用户点击单条文案后直接翻译，不再调用确认弹窗或 consent 存储", async () => {
    document.body.innerHTML = '<p data-e2e="video-desc">Translate me</p>';
    const confirmSpy = vi.spyOn(window, "confirm");
    const sendMessage = successfulSendMessage();
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      showBulkToolbar: false,
    });
    controller.refresh();
    expect(sendMessage).not.toHaveBeenCalled();

    const element = document.querySelector<HTMLElement>('[data-e2e="video-desc"]')!;
    const item = await controller.translateElement(element);

    expect(item?.translated_text).toBe("中文：Translate me");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "Translate me",
    });
    expect(translationHosts()[0]?.shadowRoot?.querySelector(".result")?.textContent).toBe(
      "中文：Translate me",
    );
    expect(translationHosts()[0]?.shadowRoot?.querySelector("style")?.textContent)
      .toContain(":host { display: inline;");
    expect(translationHosts()[0]?.shadowRoot?.querySelector("style")?.textContent)
      .not.toContain(":host { display: none;");
    controller.dispose();
  });

  it("长时间浏览时只保留限定数量的旧译文，并优先保留最近看过的内容", async () => {
    const sendMessage = successfulSendMessage();
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      showBulkToolbar: false,
      maxRememberedTranslations: 2,
    });
    const showAndTranslate = async (text: string): Promise<void> => {
      document.body.innerHTML = `<p data-e2e="video-desc">${text}</p>`;
      controller.refresh();
      await controller.translateElement(
        document.querySelector<HTMLElement>('[data-e2e="video-desc"]')!,
      );
    };

    await showAndTranslate("first");
    await showAndTranslate("second");
    await showAndTranslate("third");
    expect(sendMessage).toHaveBeenCalledTimes(3);

    document.body.innerHTML = '<p data-e2e="video-desc">first</p>';
    controller.refresh();
    expect(
      translationHosts()[0]?.shadowRoot?.querySelector<HTMLElement>(".result")?.hidden,
    ).toBe(true);
    await controller.translateElement(
      document.querySelector<HTMLElement>('[data-e2e="video-desc"]')!,
    );
    expect(sendMessage).toHaveBeenCalledTimes(4);
    controller.dispose();
  });

  it("真实按钮点击会先预打开前景桥，再开始可能耗时的在线翻译", async () => {
    document.body.innerHTML = '<p data-e2e="video-desc">Prepare foreground</p>';
    const sendMessage = successfulSendMessage();
    const foregroundBridge = {
      prepare: vi.fn(),
      translate: vi.fn(async (): Promise<TranslationResponse> => successResponse(["Prepare foreground"])),
    };
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage, foregroundBridge }),
      showBulkToolbar: false,
    });
    controller.refresh();
    translationHosts()[0]?.shadowRoot?.querySelector<HTMLButtonElement>(".single")?.click();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(foregroundBridge.prepare).toHaveBeenCalledTimes(1);
    expect(foregroundBridge.prepare.mock.invocationCallOrder[0])
      .toBeLessThan(sendMessage.mock.invocationCallOrder[0]!);
    controller.dispose();
  });

  it("单条评论使用 textContent 安全展示远端字符串，并支持收起后重新翻译", async () => {
    document.body.innerHTML = `
      <div data-e2e="comment-level-1"><span class="TUXText">Comment text</span></div>
    `;
    const sendMessage = vi.fn(async (): Promise<TranslationResponse> => ({
      ok: true,
      data: {
        items: [{
          source_text: "Comment text",
          translated_text: '<img src=x onerror="globalThis.hacked=true">安全译文',
          detected_source_language: "en",
          target_language: "zh-CN",
          cached: false,
        }],
        provider: "google_first_chain",
        provider_notice: "非稳定接口",
      },
    }));
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      showBulkToolbar: false,
    });
    controller.refresh();
    const element = document.querySelector<HTMLElement>(".TUXText")!;

    await controller.translateElement(element);
    const shadow = translationHosts()[0]!.shadowRoot!;
    expect(shadow.querySelector(".result")?.textContent).toContain("<img src=x");
    expect(shadow.querySelector(".result img")).toBeNull();

    await expect(controller.translateElement(element)).resolves.toBeNull();
    expect(shadow.querySelector<HTMLElement>(".result")?.hidden).toBe(true);
    controller.refresh();
    expect(shadow.querySelector<HTMLElement>(".result")?.hidden).toBe(true);
    await controller.translateElement(element);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("翻译成功后在评论旁明确显示实际翻译来源", async () => {
    document.body.innerHTML = `
      <div data-e2e="comment-level-1"><span class="TUXText">Provider visibility</span></div>
    `;
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage: successfulSendMessage() }),
      showBulkToolbar: false,
    });
    controller.refresh();

    await controller.translateElement(document.querySelector<HTMLElement>(".TUXText")!);

    const status = translationHosts()[0]!.shadowRoot!.querySelector<HTMLElement>(".status")!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("Google 在线");
    controller.dispose();
  });

  it("大量评论先快速显示首批，再按页面顺序渐进翻译后续评论", async () => {
    document.body.innerHTML = Array.from(
      { length: 21 },
      (_, index) => `<div data-e2e="comment-level-1"><span class="TUXText">Comment ${index + 1}</span></div>`,
    ).join("");
    let releaseSecond = (): void => undefined;
    const secondPending = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const sendMessage = vi.fn(async (request: TranslationRequest): Promise<TranslationResponse> => {
      const texts = request.type === "TRANSLATE_PUBLIC_TEXT" ? [request.text] : request.texts;
      if (sendMessage.mock.calls.length === 2) await secondPending;
      return successResponse(texts);
    });
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      showBulkToolbar: false,
    });

    const translating = controller.translateLoaded();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(translationHosts().filter((host) =>
      host.shadowRoot?.querySelector<HTMLElement>(".result")?.hidden === false
    )).toHaveLength(8);

    releaseSecond();
    await expect(translating).resolves.toEqual({ translated: 21, total: 21 });
    expect(sendMessage.mock.calls.map(([request]) =>
      (request as { texts: string[] }).texts.length
    )).toEqual([8, 13]);
    expect(translationHosts()).toHaveLength(21);
    controller.dispose();
  });

  it("评论很多时不再因为80条页面登记上限漏掉后面的评论", () => {
    document.body.innerHTML = Array.from(
      { length: 120 },
      (_, index) => `<div data-e2e="comment-level-1"><span class="TUXText">Loaded ${index + 1}</span></div>`,
    ).join("");

    expect(collectPublicTranslationTargets(document)).toHaveLength(120);
  });

  it("中间一批临时失败后继续翻译下面评论，并按冷却时间自动补回中间缺口", async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = Array.from(
        { length: 40 },
        (_, index) => `<div data-e2e="comment-level-1"><span class="TUXText">Retry ${index + 1}</span></div>`,
      ).join("");
      const sentTexts: string[][] = [];
      const sendMessage = vi.fn(async (
        request: TranslationRequest,
      ): Promise<TranslationResponse> => {
        const texts = request.type === "TRANSLATE_PUBLIC_TEXT" ? [request.text] : request.texts;
        sentTexts.push(texts);
        if (sentTexts.length === 2) {
          return {
            ok: false,
            error: "Google 自动翻译连接暂时不可用",
            code: "PROVIDER_UNAVAILABLE",
            diagnostic: "google_direct_fetch_failed:TypeError",
          };
        }
        return successResponse(texts);
      });
      const controller = new TranslationController(document, window, {
        client: new TranslationClient({ sendMessage }),
        showBulkToolbar: false,
      });

      await controller.translateLoaded();
      expect(sentTexts.map((texts) => texts.length)).toEqual([8, 16, 16]);
      expect(translationHosts().filter((host) =>
        host.shadowRoot?.querySelector<HTMLElement>(".result")?.hidden === false
      )).toHaveLength(24);

      await vi.advanceTimersByTimeAsync(15_100);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(5));

      expect([...sentTexts[3]!, ...sentTexts[4]!]).toEqual(
        Array.from({ length: 16 }, (_, index) => `Retry ${index + 9}`),
      );
      expect(translationHosts().every((host) =>
        host.shadowRoot?.querySelector<HTMLElement>(".result")?.hidden === false
      )).toBe(true);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("扫描到下一屏评论时保留上一屏已经完成的译文", async () => {
    document.body.innerHTML = `
      <section id="earlier"><div data-e2e="comment-level-1"><span class="TUXText">Earlier comment</span></div></section>
      <section id="later"><div data-e2e="comment-level-1"><span class="TUXText">Later comment</span></div></section>
    `;
    const earlier = document.querySelector<HTMLElement>("#earlier")!;
    const later = document.querySelector<HTMLElement>("#later")!;
    let context: TranslationPageContext = {
      identity: "post-scroll",
      roots: [earlier],
      commentsOpen: true,
    };
    const sendMessage = successfulSendMessage();
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      resolveContext: () => context,
      showBulkToolbar: false,
    });

    await controller.translateLoaded();
    const earlierHost = earlier.querySelector<HTMLElement>(
      '[data-tiktok-daren-assistant="translation"]',
    )!;
    expect(earlierHost.shadowRoot?.querySelector<HTMLElement>(".result")?.hidden).toBe(false);

    context = { ...context, roots: [later] };
    controller.refresh();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

    expect(earlierHost.isConnected).toBe(true);
    expect(earlierHost.shadowRoot?.querySelector<HTMLElement>(".result")?.hidden).toBe(false);
    expect(translationHosts()).toHaveLength(2);
    controller.dispose();
  });

  it("用户快速滚到中间时，新出现的评论仍排在顶部首批评论之后", async () => {
    document.body.innerHTML = `
      <section id="top"><div data-e2e="comment-level-1"><span class="TUXText">Top comment</span></div></section>
      <section id="middle"><div data-e2e="comment-level-1"><span class="TUXText">Middle comment</span></div></section>
    `;
    const top = document.querySelector<HTMLElement>("#top")!;
    const middle = document.querySelector<HTMLElement>("#middle")!;
    let context: TranslationPageContext = {
      identity: "post-fast-scroll",
      roots: [top],
      commentsOpen: true,
    };
    let releaseTop = (): void => undefined;
    const topPending = new Promise<void>((resolve) => {
      releaseTop = resolve;
    });
    const sentTexts: string[][] = [];
    const sendMessage = vi.fn(async (request: TranslationRequest): Promise<TranslationResponse> => {
      const texts = request.type === "TRANSLATE_PUBLIC_TEXT" ? [request.text] : request.texts;
      sentTexts.push(texts);
      if (sentTexts.length === 1) await topPending;
      return successResponse(texts);
    });
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      resolveContext: () => context,
      showBulkToolbar: false,
    });

    const translating = controller.translateLoaded();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    context = { ...context, roots: [middle] };
    controller.refresh();
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    releaseTop();
    await translating;

    expect(sentTexts).toEqual([["Top comment"], ["Middle comment"]]);
    expect(translationHosts().every((host) =>
      host.shadowRoot?.querySelector<HTMLElement>(".result")?.hidden === false
    )).toBe(true);
    controller.dispose();
  });

  it("TikTok 后插入上方评论时仍按当前页面从上到下发送和显示", async () => {
    document.body.innerHTML =
      '<div data-e2e="comment-level-1"><span class="TUXText">Second on page</span></div>';
    const sendMessage = successfulSendMessage();
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      showBulkToolbar: false,
    });
    controller.refresh();
    document.querySelector('[data-e2e="comment-level-1"]')?.insertAdjacentHTML(
      "beforebegin",
      '<div data-e2e="comment-level-1"><span class="TUXText">First on page</span></div>',
    );
    controller.refresh();

    await controller.translateLoaded();

    expect((sendMessage.mock.calls[0]?.[0] as { texts: string[] }).texts).toEqual([
      "First on page",
      "Second on page",
    ]);
    const displayed = translationHosts().map((host) =>
      host.shadowRoot?.querySelector<HTMLElement>(".result")?.textContent
    );
    expect(displayed).toEqual(["中文：First on page", "中文：Second on page"]);
    controller.dispose();
  });

  it("评论节点滚出后被 TikTok 重建，滚回时直接恢复已有译文", async () => {
    document.body.innerHTML =
      '<div data-e2e="comment-level-1"><span class="TUXText">Keep after scroll</span></div>';
    const sendMessage = successfulSendMessage();
    const context: TranslationPageContext = {
      identity: "post-scroll",
      roots: [document],
      commentsOpen: true,
    };
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      resolveContext: () => context,
      showBulkToolbar: false,
    });

    await controller.translateLoaded();
    controller.stopAutoTranslation();
    document.body.innerHTML =
      '<div data-e2e="comment-level-1"><span class="TUXText">Keep after scroll</span></div>';
    controller.refresh();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const restored = translationHosts()[0]?.shadowRoot?.querySelector<HTMLElement>(".result");
    expect(restored?.hidden).toBe(false);
    expect(restored?.textContent).toBe("中文：Keep after scroll");
    controller.dispose();
  });

  it("持续翻译动态评论，并对同一评论和相同文本去重请求", async () => {
    document.body.innerHTML = '<div data-e2e="comment-level-1"><span class="TUXText">Alpha</span></div>';
    const sendMessage = successfulSendMessage();
    const context: TranslationPageContext = {
      identity: "post-1",
      roots: [document],
      commentsOpen: true,
    };
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      resolveContext: () => context,
      showBulkToolbar: false,
    });

    await controller.translateLoaded();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    controller.refresh();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-e2e="comment-level-1"><span class="TUXText">Alpha</span></div>',
    );
    controller.refresh();
    await vi.waitFor(() => expect(translationHosts()).toHaveLength(2));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(translationHosts().every((host) =>
      host.shadowRoot?.querySelector<HTMLElement>(".result")?.hidden === false
    )).toBe(true);

    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-e2e="comment-level-2"><span class="TUXText">Beta reply</span></div>',
    );
    controller.refresh();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect((sendMessage.mock.calls[1]?.[0] as { texts: string[] }).texts).toEqual(["Beta reply"]);
    controller.dispose();
  });

  it("滚动评论容器本身没有新增DOM时也会立即扫描下一屏评论", async () => {
    document.body.innerHTML = `
      <section id="top"><div data-e2e="comment-level-1"><span class="TUXText">Scroll top</span></div></section>
      <section id="next"><div data-e2e="comment-level-1"><span class="TUXText">Scroll next</span></div></section>
    `;
    const top = document.querySelector<HTMLElement>("#top")!;
    const next = document.querySelector<HTMLElement>("#next")!;
    let context: TranslationPageContext = {
      identity: "post-scroll-detection",
      roots: [top],
      commentsOpen: true,
    };
    const sendMessage = successfulSendMessage();
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      resolveContext: () => context,
      showBulkToolbar: false,
    });
    controller.install();
    await controller.translateLoaded();

    context = { ...context, roots: [next] };
    next.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 1_000 });

    expect((sendMessage.mock.calls[1]?.[0] as { texts: string[] }).texts).toEqual([
      "Scroll next",
    ]);
    controller.dispose();
  });

  it("TikTok复用评论节点只替换文字时也能识别为新评论", async () => {
    document.body.innerHTML =
      '<div data-e2e="comment-level-1"><span class="TUXText">Recycled before</span></div>';
    const sendMessage = successfulSendMessage();
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      showBulkToolbar: false,
    });
    controller.install();
    await controller.translateLoaded();

    const textNode = document.querySelector(".TUXText")?.firstChild;
    expect(textNode).toBeInstanceOf(Text);
    (textNode as Text).data = "Recycled after";
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 1_000 });

    expect((sendMessage.mock.calls[1]?.[0] as { texts: string[] }).texts).toEqual([
      "Recycled after",
    ]);
    controller.dispose();
  });

  it("滚动事件和DOM变化都漏掉时，自动翻译兜底扫描仍会发现下一屏", async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = `
        <section id="watch-top"><div data-e2e="comment-level-1"><span class="TUXText">Watch top</span></div></section>
        <section id="watch-next"><div data-e2e="comment-level-1"><span class="TUXText">Watch next</span></div></section>
      `;
      const top = document.querySelector<HTMLElement>("#watch-top")!;
      const next = document.querySelector<HTMLElement>("#watch-next")!;
      let context: TranslationPageContext = {
        identity: "post-watchdog",
        roots: [top],
        commentsOpen: true,
      };
      const sendMessage = successfulSendMessage();
      const controller = new TranslationController(document, window, {
        client: new TranslationClient({ sendMessage }),
        resolveContext: () => context,
        showBulkToolbar: false,
      });
      controller.install();
      await controller.translateLoaded();

      context = { ...context, roots: [next] };
      await vi.advanceTimersByTimeAsync(AUTO_TRANSLATION_REFRESH_INTERVAL_MS + 10);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

      expect((sendMessage.mock.calls[1]?.[0] as { texts: string[] }).texts).toEqual([
        "Watch next",
      ]);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("帖子切换会停止旧会话，忽略旧请求的迟到结果", async () => {
    document.body.innerHTML = '<p data-e2e="video-desc">Old post</p>';
    let resolveOld: ((response: TranslationResponse) => void) | null = null;
    const sendMessage = vi.fn(
      () => new Promise<TranslationResponse>((resolve) => { resolveOld = resolve; }),
    );
    let context: TranslationPageContext = {
      identity: "post-old",
      roots: [document],
      commentsOpen: true,
    };
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      resolveContext: () => context,
      showBulkToolbar: false,
    });

    const oldRun = controller.translateLoaded();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    document.body.innerHTML = '<p data-e2e="video-desc">New post</p>';
    context = { identity: "post-new", roots: [document], commentsOpen: true };
    controller.refresh();
    resolveOld!(successResponse(["Old post"]));
    await oldRun;

    const newHost = translationHosts()[0]!;
    expect(newHost.shadowRoot?.querySelector<HTMLElement>(".result")?.hidden).toBe(true);
    expect(newHost.shadowRoot?.querySelector(".result")?.textContent).toBe("");
    controller.dispose();
  });

  it("切换帖子后相同评论直接复用已有译文，不重复发送请求", async () => {
    document.body.innerHTML =
      '<div data-e2e="comment-level-1"><span class="TUXText">Part two please</span></div>';
    const sendMessage = successfulSendMessage();
    let context: TranslationPageContext = {
      identity: "post-cache-a",
      roots: [document],
      commentsOpen: true,
    };
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      resolveContext: () => context,
      showBulkToolbar: false,
    });

    await controller.translateLoaded();
    controller.stopAutoTranslation();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    document.body.innerHTML =
      '<div data-e2e="comment-level-1"><span class="TUXText">Part two please</span></div>';
    context = {
      identity: "post-cache-b",
      roots: [document],
      commentsOpen: true,
    };
    controller.refresh();
    await controller.translateLoaded();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(translationHosts()[0]?.shadowRoot?.querySelector<HTMLElement>(".result")?.textContent)
      .toBe("中文：Part two please");
    controller.dispose();
  });

  it("评论区关闭后停止持续翻译，不再发送后续评论", async () => {
    document.body.innerHTML = '<div data-e2e="comment-level-1"><span class="TUXText">First</span></div>';
    const sendMessage = successfulSendMessage();
    let context: TranslationPageContext = {
      identity: "post-1",
      roots: [document],
      commentsOpen: true,
    };
    const controller = new TranslationController(document, window, {
      client: new TranslationClient({ sendMessage }),
      resolveContext: () => context,
      showBulkToolbar: false,
    });
    await controller.translateLoaded();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    context = { ...context, commentsOpen: false };
    controller.refresh();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-e2e="comment-level-1"><span class="TUXText">Should not send</span></div>',
    );
    controller.refresh();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    controller.dispose();
  });

  it("失败回退只允许用户打开官方 Google 翻译域名", () => {
    const open = vi.fn();
    const windowRef = { open } as unknown as Window;
    expect(
      openOfficialTranslateFallback(
        "https://translate.google.com/?sl=auto&tl=zh-CN&text=hello&op=translate",
        windowRef,
      ),
    ).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(openOfficialTranslateFallback("https://evil.example/steal", windowRef)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
