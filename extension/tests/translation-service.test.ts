import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BING_TRANSLATOR_PAGE_ENDPOINT,
  DEFAULT_BING_HEDGE_DELAY_MS,
  GOOGLE_TRANSLATE_HTML_API_KEY,
  GOOGLE_TRANSLATE_HTML_ENDPOINT,
  GOOGLE_TRANSLATION_ARRAY_ENDPOINT,
  GOOGLE_TRANSLATION_ENDPOINT,
  GOOGLE_TRANSLATION_PRIMARY_ENDPOINT,
  DEFAULT_TRANSLATION_MAX_CONCURRENCY,
  LOCAL_GOOGLE_TRANSLATION_FALLBACK_ENDPOINT,
  LOCAL_TRANSLATION_ENDPOINT,
  LOCAL_TRANSLATION_FALLBACK_ENDPOINT,
  MAX_TRANSLATION_BATCH_SIZE,
  MAX_TRANSLATION_TEXT_LENGTH,
  TRANSLATION_PROVIDER_NOTICE,
  TranslationService,
  buildGoogleTranslateFallbackUrl,
  createGoogleWebTranslateToken,
  normalizeStoredBingBootstrap,
  parseBingTranslateResponse,
  parseBingTranslatorBootstrap,
  parseGoogleArrayTranslateResponse,
  parseGoogleTranslateHtmlResponse,
  parseGoogleTranslateResponse,
} from "../src/background/translationService";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("binds the default Window.fetch receiver before translating", async () => {
  const receiverCheckedFetch = vi.fn(function (this: typeof globalThis) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(googleResponse());
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", receiverCheckedFetch);
  const service = new TranslationService();

  const result = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "Hello world" });

  expect(result.ok).toBe(true);
  expect(receiverCheckedFetch).toHaveBeenCalledTimes(1);
});

function googleResponse(translated = "你好，世界", language = "en"): Response {
  return new Response(JSON.stringify([[[translated, "Hello world"]], null, language]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function bingBootstrapResponse(): Response {
  return new Response(`
    <html data-iid="translator.5023">
      <script>
        var _G={IG:"0123456789ABCDEF0123456789ABCDEF"};
        var params_AbusePreventionHelper = [1770000000000,"anonymous-token",3600000];
      </script>
    </html>
  `, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

function bingResponse(translated = "你好，世界", language = "en"): Response {
  return new Response(JSON.stringify([{
    detectedLanguage: { language, score: 1 },
    translations: [{ text: translated, to: "zh-Hans" }],
  }]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("自动翻译后台服务", () => {
  it("Google 整批接口 token 支持中文和 emoji，且相同输入结果稳定", () => {
    const first = createGoogleWebTranslateToken("评论🙂subtitle");
    const second = createGoogleWebTranslateToken("评论🙂subtitle");
    expect(first).toBe(second);
    expect(first).toMatch(/^\d+\.\d+$/);
  });

  it("Google 整批接口清理包装标签并严格校验结果数量", () => {
    expect(parseGoogleArrayTranslateResponse([
      ["<b>第一条</b>", "en"],
      ["<i>占位内容</i><b>第二条</b>", "en"],
    ], 2)).toEqual(["第一条", "第二条"]);
    expect(() => parseGoogleArrayTranslateResponse([["只有一条", "en"]], 2))
      .toThrow("结果数量不完整");
  });

  it("Google translateHtml 主通道只读取首层整批结果", () => {
    expect(parseGoogleTranslateHtmlResponse([[
      ["第一条", "en"],
      ["第二条", "en"],
    ]], 2)).toEqual(["第一条", "第二条"]);
    expect(() => parseGoogleTranslateHtmlResponse([], 1))
      .toThrow("无法识别");
  });

  it("优先自动调用 Google、只发送公开文本并命中目标语言缓存", async () => {
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => googleResponse());
    const service = new TranslationService({ fetchImpl });

    const first = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "Hello world" });
    const second = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "Hello world" });

    expect(first.ok && first.data.items[0]?.translated_text).toBe("你好，世界");
    expect(first.ok && first.data.items[0]?.provider).toBe("google_translate_web");
    expect(first.ok && first.data.items[0]?.cached).toBe(false);
    expect(second.ok && second.data.items[0]?.cached).toBe(true);
    expect(first.ok && first.data.provider).toBe("google_first_chain");
    expect(first.ok && first.data.provider_notice).toBe(TRANSLATION_PROVIDER_NOTICE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [requestUrl, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_TRANSLATION_PRIMARY_ENDPOINT);
    expect(url.searchParams.get("sl")).toBe("auto");
    expect(url.searchParams.get("tl")).toBe("zh-CN");
    expect(url.searchParams.get("q")).toBe("Hello world");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store" });
    expect(JSON.stringify(init)).not.toMatch(/cookie|authorization|token/i);
  });

  it("Chrome 专用版把多条原文一次发给无 key Google 整批接口并按原顺序返回", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_TRANSLATION_ARRAY_ENDPOINT);
      expect(url.searchParams.get("client")).toBe("tee");
      expect(url.searchParams.get("sl")).toBe("auto");
      expect(url.searchParams.get("tl")).toBe("zh-CN");
      expect(url.searchParams.get("key")).toBe("");
      expect(url.searchParams.get("tk")).toMatch(/^\d+\.\d+$/);
      expect(init).toMatchObject({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
      });
      const body = new URLSearchParams(String(init?.body));
      expect(body.getAll("q")).toEqual(["first comment", "second comment"]);
      expect(JSON.stringify(init?.headers)).not.toMatch(/authorization|api[-_]?key/i);
      return new Response(JSON.stringify([
        ["第一条评论", "en"],
        ["第二条评论", "en"],
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const service = new TranslationService({
      fetchImpl,
      googleArrayEndpoint: GOOGLE_TRANSLATION_ARRAY_ENDPOINT,
      googleEndpoints: [],
      bingTranslatorPages: [],
      localFallbackEndpoints: [],
    });

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: ["first comment", "second comment"],
    });

    expect(result.ok && result.data.items.map((item) => item.translated_text)).toEqual([
      "第一条评论",
      "第二条评论",
    ]);
    expect(result.ok && result.data.items.every(
      (item) => item.provider === "google_translate_web",
    )).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("配置 HTML 翻译通道后，一次提交整批文字和测试 key", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe(GOOGLE_TRANSLATE_HTML_ENDPOINT);
      expect(init).toMatchObject({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
      });
      expect(new Headers(init?.headers).get("x-goog-api-key"))
        .toBe(["AIza", "0".repeat(35)].join(""));
      expect(JSON.parse(String(init?.body))).toEqual([
        [["first subtitle", "second subtitle"], "auto", "zh-CN"],
        "te_lib",
      ]);
      return new Response(JSON.stringify([[
        ["第一句字幕", "en"],
        ["第二句字幕", "en"],
      ]]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const service = new TranslationService({
      fetchImpl,
      googleTranslateHtmlEndpoint: GOOGLE_TRANSLATE_HTML_ENDPOINT,
      googleTranslateHtmlApiKey: ["AIza", "0".repeat(35)].join(""),
      googleArrayEndpoint: GOOGLE_TRANSLATION_ARRAY_ENDPOINT,
      googleEndpoints: [],
      bingTranslatorPages: [],
      localFallbackEndpoints: [],
    });

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: ["first subtitle", "second subtitle"],
    });

    expect(result.ok && result.data.items.map((item) => item.translated_text)).toEqual([
      "第一句字幕",
      "第二句字幕",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("主通道失败后在同一 Google 尝试中自动使用无 key 整批通道", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url === GOOGLE_TRANSLATE_HTML_ENDPOINT) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      expect(url).toContain(GOOGLE_TRANSLATION_ARRAY_ENDPOINT);
      return new Response(JSON.stringify([
        ["无 key 第一条", "en"],
        ["无 key 第二条", "en"],
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const service = new TranslationService({
      fetchImpl,
      googleTranslateHtmlEndpoint: GOOGLE_TRANSLATE_HTML_ENDPOINT,
      googleTranslateHtmlApiKey: ["AIza", "0".repeat(35)].join(""),
      googleArrayEndpoint: GOOGLE_TRANSLATION_ARRAY_ENDPOINT,
      googleEndpoints: [],
      bingTranslatorPages: [],
      localFallbackEndpoints: [],
    });

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: ["first", "second"],
    });

    expect(result.ok && result.data.items.map((item) => item.translated_text)).toEqual([
      "无 key 第一条",
      "无 key 第二条",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("无 key Google 整批接口失败时立即切到 Bing，不让整批字幕直接失败", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.startsWith(GOOGLE_TRANSLATION_ARRAY_ENDPOINT)) {
        return new Response("rate limited", { status: 429 });
      }
      if (url === BING_TRANSLATOR_PAGE_ENDPOINT) return bingBootstrapResponse();
      if (url.includes("/ttranslatev3")) {
        return bingResponse("\uE0000000\uE001 第一条\n\uE0000001\uE001 第二条");
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const service = new TranslationService({
      fetchImpl,
      googleArrayEndpoint: GOOGLE_TRANSLATION_ARRAY_ENDPOINT,
      googleEndpoints: [],
      localFallbackEndpoints: [],
    });

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: ["first subtitle", "second subtitle"],
    });

    expect(result.ok && result.data.items.map((item) => item.translated_text)).toEqual([
      "第一条",
      "第二条",
    ]);
    expect(result.ok && result.data.items.every(
      (item) => item.provider === "bing_translate_web",
    )).toBe(true);
  });

  it("translate.google.com 被限流或阻断时自动切换备用 Google 端点", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.startsWith(GOOGLE_TRANSLATION_PRIMARY_ENDPOINT)) {
        return new Response("rate limited", { status: 429 });
      }
      expect(url).toMatch(/^https:\/\/translate\.googleapis\.com\//);
      return googleResponse("备用端点译文");
    });
    const service = new TranslationService({ fetchImpl, localFallbackEndpoints: [] });

    const result = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "Hello" });

    expect(result.ok && result.data.items[0]?.translated_text).toBe("备用端点译文");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("同一条翻译被同时触发时复用正在进行的请求", async () => {
    const releases: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => {
        releases.push(resolve);
      }),
    );
    const service = new TranslationService({ fetchImpl, localFallbackEndpoints: [] });

    const first = service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "same comment" });
    const second = service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "same comment" });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    releases.shift()?.(googleResponse("同一份译文"));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("429 后记住恢复时间，冷却期内重复点击不再请求 Google", async () => {
    let now = 10_000;
    const fetchImpl = vi.fn(async () => {
      if (fetchImpl.mock.calls.length === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "120" },
        });
      }
      return googleResponse("恢复后的译文");
    });
    const service = new TranslationService({
      fetchImpl,
      now: () => now,
      googleEndpoint: GOOGLE_TRANSLATION_PRIMARY_ENDPOINT,
      bingTranslatorPages: [],
      localFallbackEndpoints: [],
    });

    const limited = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "hello" });
    const repeated = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "hello" });
    now += 120_001;
    const recovered = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "hello" });

    expect(limited).toMatchObject({ ok: false, diagnostic: "google_direct_http_429" });
    expect(repeated).toMatchObject({
      ok: false,
      diagnostic: "google_direct_rate_limit_cooldown",
    });
    expect(recovered).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("把 Google 冷却状态保留在浏览器会话中，service worker 重启后也不会继续撞限流", async () => {
    let stored: unknown;
    const cooldownStore = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (value: unknown) => {
        stored = value;
      }),
    };
    const firstFetch = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const firstService = new TranslationService({
      fetchImpl: firstFetch,
      googleEndpoint: GOOGLE_TRANSLATION_PRIMARY_ENDPOINT,
      bingTranslatorPages: [],
      localFallbackEndpoints: [],
      cooldownStore,
    });
    await firstService.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "first" });

    const restartedFetch = vi.fn(async () => googleResponse("不应请求"));
    const restartedService = new TranslationService({
      fetchImpl: restartedFetch,
      googleEndpoint: GOOGLE_TRANSLATION_PRIMARY_ENDPOINT,
      bingTranslatorPages: [],
      localFallbackEndpoints: [],
      cooldownStore,
    });
    const result = await restartedService.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "after restart",
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: "google_direct_rate_limit_cooldown",
    });
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(restartedFetch).not.toHaveBeenCalled();
    expect(cooldownStore.save).toHaveBeenCalled();
  });

  it("Google 失败后依次尝试 127.0.0.1 与 localhost", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (
        url.startsWith(GOOGLE_TRANSLATION_PRIMARY_ENDPOINT) ||
        url.startsWith(GOOGLE_TRANSLATION_ENDPOINT)
      ) throw new TypeError("Failed to fetch");
      if (url === LOCAL_TRANSLATION_ENDPOINT) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({
        translated_text: "本地译文",
        detected_source_language: "en",
        target_language: "zh-CN",
        provider: "argos_local",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const service = new TranslationService({ fetchImpl, bingTranslatorPages: [] });

    const result = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "Hello" });

    expect(result.ok && result.data.items[0]?.translated_text).toBe("本地译文");
    expect(result.ok && result.data.items[0]?.provider).toBe("argos_local");
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringMatching(/^https:\/\/translate\.google\.com\//),
      expect.stringMatching(/^https:\/\/translate\.googleapis\.com\//),
      LOCAL_TRANSLATION_ENDPOINT,
      LOCAL_TRANSLATION_FALLBACK_ENDPOINT,
    ]);
    const localInit = fetchImpl.mock.calls[2]?.[1] as RequestInit;
    expect(localInit).not.toHaveProperty("targetAddressSpace");
    expect(JSON.parse(String(localInit.body))).toEqual({ text: "Hello", target_language: "zh-CN" });
  });

  it("Google 失败且离线翻译包未安装时返回可操作的模型标识", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      if (
        String(input).startsWith(GOOGLE_TRANSLATION_PRIMARY_ENDPOINT) ||
        String(input).startsWith(GOOGLE_TRANSLATION_ENDPOINT)
      ) {
        throw new TypeError("Failed to fetch");
      }
      return new Response(JSON.stringify({
        detail: {
          code: "LOCAL_MODEL_REQUIRED",
          model_ids: ["argos-ru-en", "argos-en-zh"],
          message: "Local translation model is required",
        },
      }), { status: 409, headers: { "Content-Type": "application/json" } });
    });
    const service = new TranslationService({ fetchImpl, bingTranslatorPages: [] });

    const result = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "Hello" });

    expect(result).toMatchObject({
      ok: false,
      code: "LOCAL_MODEL_REQUIRED",
      required_model_ids: ["argos-ru-en", "argos-en-zh"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("侧栏前景模式先走 localhost 后端，不再依赖 Chrome 直连 Google", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      expect(String(input)).toBe(LOCAL_GOOGLE_TRANSLATION_FALLBACK_ENDPOINT);
      return new Response(JSON.stringify({
        translated_text: "前景后端译文",
        detected_source_language: "en",
        target_language: "zh-CN",
        provider: "google_translate_web",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const service = new TranslationService({
      fetchImpl,
      preferLocalBackend: true,
      localFallbackEndpoints: [LOCAL_GOOGLE_TRANSLATION_FALLBACK_ENDPOINT],
    });

    const result = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "Hello" });

    expect(result.ok && result.data.items[0]?.translated_text).toBe("前景后端译文");
    expect(result.ok && result.data.items[0]?.provider).toBe("google_translate_web");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("translate.googleapis.com");
    expect(fetchImpl.mock.calls[0]?.[1]).not.toHaveProperty("targetAddressSpace");
  });

  it("全部自动链路失败时返回脱敏的组合诊断", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("private text must not leak");
    });
    const service = new TranslationService({ fetchImpl, bingTranslatorPages: [] });

    const result = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "private text" });

    expect(result).toMatchObject({
      ok: false,
      code: "PROVIDER_UNAVAILABLE",
      error: "自动翻译暂时不可用，请检查网络或本地后端后重试",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result.ok || result.diagnostic).toBe(
      "google_direct_fetch_failed:TypeError;google_direct_fetch_failed:TypeError;local_backend_fetch_failed:TypeError;local_backend_fetch_failed:TypeError",
    );
    expect(result.ok || result.diagnostic).not.toContain("private text");
  });

  it("支持多目标语言且缓存键包含目标语言", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const target = new URL(String(input)).searchParams.get("tl");
      return googleResponse(target === "ja" ? "こんにちは" : "你好");
    });
    const service = new TranslationService({ fetchImpl });

    const chinese = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "hello",
      target_language: "zh-CN",
    });
    const japanese = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "hello",
      target_language: "ja",
    });
    const japaneseCached = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "hello",
      target_language: "ja",
    });

    expect(chinese.ok && chinese.data.items[0]?.target_language).toBe("zh-CN");
    expect(japanese.ok && japanese.data.items[0]?.translated_text).toBe("こんにちは");
    expect(japanese.ok && japanese.data.items[0]?.target_language).toBe("ja");
    expect(japaneseCached.ok && japaneseCached.data.items[0]?.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(service.getCacheSize()).toBe(2);
  });

  it("批量翻译去重请求并保持原始顺序", async () => {
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const combined = new URLSearchParams(String(init?.body)).get("q") ?? "";
      const translated = combined
        .split("\n")
        .map((line) => line.replace(
          /^(\uE000+\d{4}\uE001+)\s+(.+)$/,
          "$1 译文:$2",
        ))
        .join("\n");
      return googleResponse(translated);
    });
    const service = new TranslationService({ fetchImpl, maxConcurrentRequests: 2 });
    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: ["one", "two", "one"],
    });

    expect(result.ok && result.data.items.map((item) => item.translated_text)).toEqual([
      "译文:one",
      "译文:two",
      "译文:one",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("多个独立翻译任务也统一受全局并发上限控制", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return googleResponse();
    });
    const service = new TranslationService({ fetchImpl });
    const pending = ["one", "two", "three", "four", "five"].map((text) =>
      service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text } as const));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_TRANSLATION_MAX_CONCURRENCY));
    expect(maximumActive).toBe(DEFAULT_TRANSLATION_MAX_CONCURRENCY);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_TRANSLATION_MAX_CONCURRENCY * 2));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
    releases.splice(0).forEach((release) => release());

    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 5 }, () => expect.objectContaining({ ok: true })),
    );
    expect(maximumActive).toBe(DEFAULT_TRANSLATION_MAX_CONCURRENCY);
  });

  it("拒绝超长文本、超量批次和未知目标语言", async () => {
    const fetchImpl = vi.fn();
    const service = new TranslationService({ fetchImpl });
    const tooLong = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "a".repeat(MAX_TRANSLATION_TEXT_LENGTH + 1),
    });
    const tooMany = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: Array.from({ length: MAX_TRANSLATION_BATCH_SIZE + 1 }, (_, index) => `text-${index}`),
    });
    const unknown = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "hello",
      target_language: "xx" as "zh-CN",
    });

    expect(tooLong).toMatchObject({ ok: false, code: "TEXT_TOO_LONG" });
    expect(tooMany).toMatchObject({ ok: false, code: "BATCH_TOO_LARGE" });
    expect(unknown).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("单个 provider 超时会中止请求并返回明确诊断", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const service = new TranslationService({
      fetchImpl,
      timeoutMs: 500,
      localFallbackEndpoints: [],
      googleEndpoint: GOOGLE_TRANSLATION_ENDPOINT,
      bingTranslatorPages: [],
    });
    const pending = service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "timeout" });
    await vi.advanceTimersByTimeAsync(502);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "PROVIDER_UNAVAILABLE",
      diagnostic: "google_direct_timeout",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("解析 Google 多段响应并拒绝空响应", () => {
    expect(parseGoogleTranslateResponse([
      [["你", "you"], ["好", "good"]],
      null,
      "en",
    ])).toEqual({ translatedText: "你好", detectedSourceLanguage: "en" });
    expect(() => parseGoogleTranslateResponse([[], null, "en"])).toThrow("未返回有效译文");
  });

  it("解析 Bing 初始化信息和译文响应", () => {
    const bootstrap = parseBingTranslatorBootstrap(
      `
        <html data-iid="translator.5023">
          <script>
            var _G={IG:"0123456789ABCDEF0123456789ABCDEF"};
            var params_AbusePreventionHelper = [1770000000000,"anonymous-token",3600000];
          </script>
        </html>
      `,
      BING_TRANSLATOR_PAGE_ENDPOINT,
      10_000,
    );
    expect(bootstrap).toMatchObject({
      origin: "https://www.bing.com",
      iid: "translator.5023",
      key: "1770000000000",
      token: "anonymous-token",
    });
    expect(bootstrap.expiresAt).toBeGreaterThan(10_000);
    expect(parseBingTranslateResponse([{
      detectedLanguage: { language: "en" },
      translations: [{ text: "你好", to: "zh-Hans" }],
    }])).toEqual({ translatedText: "你好", detectedSourceLanguage: "en" });
    expect(() => parseBingTranslateResponse([{ translations: [] }]))
      .toThrow("未返回有效译文");
    expect(normalizeStoredBingBootstrap(bootstrap, 10_000)).toEqual(bootstrap);
    expect(normalizeStoredBingBootstrap({
      ...bootstrap,
      origin: "https://example.com",
    }, 10_000)).toBeNull();
    expect(normalizeStoredBingBootstrap({
      ...bootstrap,
      expiresAt: 10_001,
    }, 10_000)).toBeNull();
  });

  it("专家翻译只保留 provider 契约且不会发起请求", async () => {
    const fetchImpl = vi.fn();
    const service = new TranslationService({ fetchImpl });
    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "hello",
      target_language: "fr",
      provider: "deepseek_expert",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "PROVIDER_NOT_CONFIGURED",
      diagnostic: "deepseek_expert_not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("手动回退地址固定为 Google 官方页面并保留目标语言", () => {
    const fallback = new URL(buildGoogleTranslateFallbackUrl("hello", "fr"));
    expect(fallback.origin).toBe("https://translate.google.com");
    expect(fallback.searchParams.get("tl")).toBe("fr");
  });
});

describe("Bing free web translation fallback", () => {
  it("并发预热只初始化一次，并在 service worker 重启后复用会话凭证", async () => {
    let stored: unknown;
    const bootstrapStore = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (bootstrap: unknown) => {
        stored = structuredClone(bootstrap);
      }),
      clear: vi.fn(async () => {
        stored = undefined;
      }),
    };
    const bootstrapReleases: Array<(response: Response) => void> = [];
    const warmFetch = vi.fn(() =>
      new Promise<Response>((resolve) => {
        bootstrapReleases.push(resolve);
      }));
    const warmingService = new TranslationService({
      fetchImpl: warmFetch,
      now: () => 10_000,
      googleEndpoints: [],
      localFallbackEndpoints: [],
      bingBootstrapStore: bootstrapStore,
    });

    const firstWarm = warmingService.warmOnlineProvider();
    const secondWarm = warmingService.warmOnlineProvider();
    await vi.waitFor(() => expect(warmFetch).toHaveBeenCalledTimes(1));
    bootstrapReleases.shift()?.(bingBootstrapResponse());
    await Promise.all([firstWarm, secondWarm]);

    const restartedFetch = vi.fn(async (input: URL | RequestInfo) => {
      expect(String(input)).toMatch(/^https:\/\/www\.bing\.com\/ttranslatev3\?/);
      return bingResponse("重启后直接翻译");
    });
    const restartedService = new TranslationService({
      fetchImpl: restartedFetch,
      now: () => 10_000,
      googleEndpoints: [],
      localFallbackEndpoints: [],
      bingBootstrapStore: bootstrapStore,
    });
    const result = await restartedService.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "hello",
    });

    expect(result.ok && result.data.items[0]?.translated_text).toBe("重启后直接翻译");
    expect(restartedFetch).toHaveBeenCalledTimes(1);
    expect(bootstrapStore.save).toHaveBeenCalledTimes(1);
    expect(bootstrapStore.clear).not.toHaveBeenCalled();
  });

  it("丢弃伪造或过期的 Bing 会话凭证，并重新获取有效凭证", async () => {
    let stored: unknown = {
      origin: "https://example.com",
      ig: "0123456789ABCDEF0123456789ABCDEF",
      iid: "translator.5023",
      key: "1770000000000",
      token: "anonymous-token",
      expiresAt: 3_000_000,
    };
    const bootstrapStore = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (bootstrap: unknown) => {
        stored = structuredClone(bootstrap);
      }),
      clear: vi.fn(async () => {
        stored = undefined;
      }),
    };
    const fetchImpl = vi.fn(async () => bingBootstrapResponse());
    const service = new TranslationService({
      fetchImpl,
      now: () => 10_000,
      googleEndpoints: [],
      localFallbackEndpoints: [],
      bingBootstrapStore: bootstrapStore,
    });

    await service.warmOnlineProvider();

    expect(bootstrapStore.clear).toHaveBeenCalledTimes(1);
    expect(bootstrapStore.save).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(normalizeStoredBingBootstrap(stored, 10_000)).not.toBeNull();
  });

  it("字幕 Google 卡住时 300ms 后启动 Bing，并取消仍在等待的 Google 请求", async () => {
    vi.useFakeTimers();
    let googleAbortCount = 0;
    const fetchImpl = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (
        url.startsWith(GOOGLE_TRANSLATION_PRIMARY_ENDPOINT) ||
        url.startsWith(GOOGLE_TRANSLATION_ENDPOINT)
      ) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            googleAbortCount += 1;
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      if (url === BING_TRANSLATOR_PAGE_ENDPOINT) {
        return Promise.resolve(bingBootstrapResponse());
      }
      const combined = new URLSearchParams(String(init?.body)).get("text") ?? "";
      return Promise.resolve(bingResponse(combined));
    });
    const service = new TranslationService({
      fetchImpl,
      localFallbackEndpoints: [],
    });
    const texts = ["subtitle one", "subtitle two"];

    const pending = service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_BING_HEDGE_DELAY_MS + 1);

    const result = await pending;
    expect(result.ok && result.data.items.map((item) => item.translated_text)).toEqual(texts);
    expect(result.ok && result.data.items.every(
      (item) => item.provider === "bing_translate_web",
    )).toBe(true);
    expect(googleAbortCount).toBe(1);
    expect(fetchImpl.mock.calls.filter(([url]) =>
      String(url).startsWith(GOOGLE_TRANSLATION_PRIMARY_ENDPOINT) ||
      String(url).startsWith(GOOGLE_TRANSLATION_ENDPOINT))).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("Google 在竞速中先返回时仍使用 Google，并取消较慢的 Bing", async () => {
    vi.useFakeTimers();
    let bingAbortCount = 0;
    const fetchImpl = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(GOOGLE_TRANSLATION_PRIMARY_ENDPOINT)) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(googleResponse("Google 更快")), 1_000);
        });
      }
      if (url === BING_TRANSLATOR_PAGE_ENDPOINT) {
        return Promise.resolve(bingBootstrapResponse());
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          bingAbortCount += 1;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    const service = new TranslationService({
      fetchImpl,
      localFallbackEndpoints: [],
    });

    const pending = service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "hello" });
    await vi.advanceTimersByTimeAsync(1_001);

    const result = await pending;
    expect(result.ok && result.data.items[0]).toMatchObject({
      translated_text: "Google 更快",
      provider: "google_translate_web",
    });
    expect(bingAbortCount).toBe(1);
  });

  it("Google 连接失败后自动切换 Bing，且不发送账号 Cookie 或授权头", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (
        url.startsWith(GOOGLE_TRANSLATION_PRIMARY_ENDPOINT) ||
        url.startsWith(GOOGLE_TRANSLATION_ENDPOINT)
      ) {
        throw new TypeError("Failed to fetch");
      }
      if (url === BING_TRANSLATOR_PAGE_ENDPOINT) return bingBootstrapResponse();
      const body = new URLSearchParams(String(init?.body));
      expect(url).toMatch(/^https:\/\/www\.bing\.com\/ttranslatev3\?/);
      expect(body.get("fromLang")).toBe("auto-detect");
      expect(body.get("to")).toBe("zh-Hans");
      expect(body.get("text")).toBe("Hello");
      expect(init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store" });
      expect(JSON.stringify(init?.headers)).not.toMatch(/cookie|authorization/i);
      return bingResponse("必应译文");
    });
    const service = new TranslationService({
      fetchImpl,
      localFallbackEndpoints: [],
    });

    const result = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "Hello" });

    expect(result.ok && result.data.items[0]).toMatchObject({
      translated_text: "必应译文",
      provider: "bing_translate_web",
      detected_source_language: "en",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("复用匿名初始化信息，连续翻译不会重复下载 Bing 页面", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input) === BING_TRANSLATOR_PAGE_ENDPOINT) return bingBootstrapResponse();
      const text = new URLSearchParams(String(init?.body)).get("text");
      return bingResponse(`译文:${text}`);
    });
    const service = new TranslationService({
      fetchImpl,
      googleEndpoints: [],
      localFallbackEndpoints: [],
    });

    const first = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "one" });
    const second = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "two" });

    expect(first.ok && first.data.items[0]?.translated_text).toBe("译文:one");
    expect(second.ok && second.data.items[0]?.translated_text).toBe("译文:two");
    expect(fetchImpl.mock.calls.filter(([url]) =>
      String(url) === BING_TRANSLATOR_PAGE_ENDPOINT)).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("批量评论或字幕通过一次 Bing 翻译请求完成并保持原顺序", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input) === BING_TRANSLATOR_PAGE_ENDPOINT) return bingBootstrapResponse();
      const combined = new URLSearchParams(String(init?.body)).get("text") ?? "";
      const translated = combined
        .split("\n")
        .map((line) => line.replace(
          /^(\uE000+\d{4}\uE001+)\s+(.+)$/,
          "$1 必应:$2",
        ))
        .join("\n");
      return bingResponse(translated);
    });
    const service = new TranslationService({
      fetchImpl,
      googleEndpoints: [],
      localFallbackEndpoints: [],
    });
    const texts = ["one", "two", "three"];

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts,
    });

    expect(result.ok && result.data.items.map((item) => item.translated_text)).toEqual([
      "必应:one",
      "必应:two",
      "必应:three",
    ]);
    expect(result.ok && result.data.items.every(
      (item) => item.provider === "bing_translate_web",
    )).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("评论和视频翻译可同时推进，取消旧视频不会误伤评论或新视频", async () => {
    let activePosts = 0;
    let maximumActivePosts = 0;
    let oldSubtitleAborted = false;
    const fetchImpl = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input) === BING_TRANSLATOR_PAGE_ENDPOINT) {
        return Promise.resolve(bingBootstrapResponse());
      }
      const combined = new URLSearchParams(String(init?.body)).get("text") ?? "";
      activePosts += 1;
      maximumActivePosts = Math.max(maximumActivePosts, activePosts);
      if (combined.includes("old subtitle")) {
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => {
            activePosts -= 1;
            oldSubtitleAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      const translated = combined
        .split("\n")
        .map((line) => line.replace(
          /^(\uE000+\d{4}\uE001+)\s+(.+)$/,
          "$1 Bing:$2",
        ))
        .join("\n");
      activePosts -= 1;
      return Promise.resolve(bingResponse(translated));
    });
    const service = new TranslationService({
      fetchImpl,
      googleEndpoints: [],
      localFallbackEndpoints: [],
      maxConcurrentRequests: 2,
    });
    const oldController = new AbortController();
    const oldSubtitle = service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: ["old subtitle one", "old subtitle two"],
    }, oldController.signal);
    const comments = service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: ["comment one", "comment two"],
    });

    await vi.waitFor(() => {
      expect(fetchImpl.mock.calls.filter(([url]) =>
        String(url).includes("/ttranslatev3"))).toHaveLength(2);
    });
    await expect(comments).resolves.toMatchObject({ ok: true });

    oldController.abort();
    await expect(oldSubtitle).resolves.toMatchObject({
      ok: false,
      diagnostic: "bing_web_cancelled",
    });

    const currentSubtitle = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: ["new subtitle one", "new subtitle two"],
    });
    expect(currentSubtitle.ok && currentSubtitle.data.items.map(
      (item) => item.translated_text,
    )).toEqual([
      "Bing:new subtitle one",
      "Bing:new subtitle two",
    ]);
    expect(oldSubtitleAborted).toBe(true);
    expect(maximumActivePosts).toBe(2);
    expect(fetchImpl.mock.calls.filter(([url]) =>
      String(url) === BING_TRANSLATOR_PAGE_ENDPOINT)).toHaveLength(1);
  });

  it("Bing 返回 429 后进入冷却，重复点击不会继续撞接口", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input) === BING_TRANSLATOR_PAGE_ENDPOINT) return bingBootstrapResponse();
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    });
    const service = new TranslationService({
      fetchImpl,
      googleEndpoints: [],
      localFallbackEndpoints: [],
    });

    const limited = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "one" });
    const repeated = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "two" });

    expect(limited).toMatchObject({ ok: false, diagnostic: "bing_web_http_429" });
    expect(repeated).toMatchObject({
      ok: false,
      diagnostic: "bing_web_rate_limit_cooldown",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("Google batch translation fast path", () => {
  it("批量请求被两条 Google 通道限流后不再拆成几十个单条请求", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const service = new TranslationService({
      fetchImpl,
      localFallbackEndpoints: [],
      bingTranslatorPages: [],
    });
    const texts = Array.from({ length: 20 }, (_, index) => `limited-${index}`);

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts,
    });

    expect(result).toMatchObject({ ok: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("combines a normal subtitle track into one request and preserves item order", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(input)).toMatch(/^https:\/\/translate\.googleapis\.com\//);
      expect(new URL(String(input)).searchParams.has("q")).toBe(false);
      const combined = new URLSearchParams(String(init?.body)).get("q") ?? "";
      const translated = combined
        .split("\n")
        .map((line) => line.replace(
          /^(\uE000+\d{4}\uE001+)\s+(.+)$/,
          "$1 translated:$2",
        ))
        .join("\n");
      return googleResponse(translated);
    });
    const service = new TranslationService({ fetchImpl, bingTranslatorPages: [] });
    const texts = Array.from({ length: 12 }, (_, index) => `item-${index}`);

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts,
    });

    expect(result.ok && result.data.items.map((item) => item.translated_text)).toEqual(
      texts.map((text) => `translated:${text}`),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("abandons a stalled batch endpoint after three seconds and uses the fallback", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).startsWith(GOOGLE_TRANSLATION_ENDPOINT)) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      const combined = new URLSearchParams(String(init?.body)).get("q") ?? "";
      return Promise.resolve(googleResponse(combined));
    });
    const service = new TranslationService({
      fetchImpl,
      timeoutMs: 8_000,
      localFallbackEndpoints: [],
      bingTranslatorPages: [],
    });
    const texts = Array.from({ length: 8 }, (_, index) => `timeout-${index}`);

    const pending = service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts,
    });
    await vi.advanceTimersByTimeAsync(3_002);

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0]))
      .toMatch(/^https:\/\/translate\.google\.com\//);
  });

  it("falls back to the existing per-item route when batch markers are incomplete", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") return googleResponse("missing batch markers");
      const text = new URL(String(input)).searchParams.get("q");
      return googleResponse(`individual:${text}`);
    });
    const service = new TranslationService({ fetchImpl, bingTranslatorPages: [] });
    const texts = Array.from({ length: 8 }, (_, index) => `fallback-${index}`);

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts,
    });

    expect(result.ok && result.data.items.map((item) => item.translated_text)).toEqual(
      texts.map((text) => `individual:${text}`),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });
});
