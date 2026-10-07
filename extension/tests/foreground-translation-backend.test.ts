import { afterEach, describe, expect, it, vi } from "vitest";

import { ForegroundTranslationBackend } from "../src/translation/foregroundBackend";
import type { TranslationResponse } from "../src/types/messages";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("binds the default Window.fetch receiver before posting to localhost", async () => {
  const receiverCheckedFetch = vi.fn(function (this: typeof globalThis) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(JSON.stringify(successfulBatch(["hello"])), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", receiverCheckedFetch);
  const service = new ForegroundTranslationBackend({ fallbackService: { handle: vi.fn() } });

  const result = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: "hello" });

  expect(result.ok).toBe(true);
  expect(receiverCheckedFetch).toHaveBeenCalledTimes(1);
});

function successfulBatch(texts: string[], target = "zh-CN") {
  return {
    target_language: target,
    results: texts.map((text, index) => ({
      index,
      ok: true,
      translated_text: `译文:${text}`,
      detected_source_language: "en",
      provider: "google_translate_web",
    })),
    succeeded: texts.length,
    failed: 0,
  };
}

describe("侧栏前景翻译后端", () => {
  it("从可见侧栏一次 POST 批量端点并保持字幕顺序", async () => {
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) =>
      new Response(JSON.stringify(successfulBatch(["one", "two"])), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    const fallbackService = { handle: vi.fn() };
    const service = new ForegroundTranslationBackend({ fetchImpl, fallbackService });

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: ["one", "two"],
      target_language: "zh-CN",
    });

    expect(result.ok && result.data.items.map((item) => item.translated_text)).toEqual([
      "译文:one",
      "译文:two",
    ]);
    expect(result.ok && result.data.items.map((item) => item.provider)).toEqual([
      "google_translate_web",
      "google_translate_web",
    ]);
    expect(result.ok && result.data.provider).toBe("local_foreground");
    expect(result.ok && result.data.provider_notice).toContain("Google 在线");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://localhost:8765/api/v1/translations/batch",
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({ method: "POST", credentials: "omit" });
    expect(init).not.toHaveProperty("targetAddressSpace");
    expect(JSON.parse(String(init.body))).toEqual({ texts: ["one", "two"], target_language: "zh-CN" });
    expect(fallbackService.handle).not.toHaveBeenCalled();
  });

  it("保留逐条 provider，并把在线与本地回退明确标为混合通道", async () => {
    const payload = successfulBatch(["one", "two"]);
    payload.results[1]!.provider = "argos_local";
    const service = new ForegroundTranslationBackend({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
      fallbackService: { handle: vi.fn() },
    });

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: ["one", "two"],
    });

    expect(result.ok && result.data.items.map((item) => item.provider)).toEqual([
      "google_translate_web",
      "argos_local",
    ]);
    expect(result.ok && result.data.provider_notice).toContain("混合通道");
  });

  it("接受 Bing 回退结果并在界面明确标出本次通道", async () => {
    const payload = successfulBatch(["one"]);
    payload.results[0]!.provider = "bing_translate_web";
    const service = new ForegroundTranslationBackend({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
      fallbackService: { handle: vi.fn() },
    });

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "one",
    });

    expect(result.ok && result.data.items[0]?.provider).toBe("bing_translate_web");
    expect(result.ok && result.data.provider_notice).toContain("Bing 在线");
  });

  it("在线翻译失败且离线包缺失时保留模型提示，不重复请求或降级丢失元数据", async () => {
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({
      target_language: "zh-CN",
      results: [{
        index: 0,
        ok: false,
        error: "local translation model is not installed",
        error_code: "LOCAL_MODEL_REQUIRED",
        required_model_ids: ["argos-ru-en", "argos-en-zh"],
      }],
      succeeded: 0,
      failed: 1,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const fallbackService = { handle: vi.fn() };
    const service = new ForegroundTranslationBackend({ fetchImpl, fallbackService });

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "hello",
      target_language: "zh-CN",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "LOCAL_MODEL_REQUIRED",
      required_model_ids: ["argos-ru-en", "argos-en-zh"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fallbackService.handle).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/models"))).toBe(false);
  });

  it("localhost 不可达时自动尝试 127.0.0.1", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes("localhost")) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(successfulBatch(["hello"], "ja")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const service = new ForegroundTranslationBackend({
      fetchImpl,
      fallbackService: { handle: vi.fn() },
    });

    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "hello",
      target_language: "ja",
    });

    expect(result.ok && result.data.items[0]?.translated_text).toBe("译文:hello");
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:8765/api/v1/translations/batch",
      "http://127.0.0.1:8765/api/v1/translations/batch",
    ]);
  });

  it("坏响应和最终失败只暴露诊断码，不泄露待翻译文本", async () => {
    const privateText = "private comment must not leak";
    const fallback: TranslationResponse = {
      ok: false,
      error: "provider failed",
      code: "PROVIDER_UNAVAILABLE",
      diagnostic: "local_backend_fetch_failed:TypeError",
    };
    const service = new ForegroundTranslationBackend({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
      fallbackService: { handle: vi.fn(async () => fallback) },
    });

    const result = await service.handle({ type: "TRANSLATE_PUBLIC_TEXT", text: privateText });

    expect(result).toMatchObject({ ok: false, code: "PROVIDER_UNAVAILABLE" });
    expect(result.ok || result.diagnostic).toContain("TDA-TR-05-SCHEMA");
    expect(result.ok || result.diagnostic).not.toContain(privateText);
  });

  it("专家模式仍只保留接口，不访问任何网络", async () => {
    const fetchImpl = vi.fn();
    const service = new ForegroundTranslationBackend({ fetchImpl });
    const result = await service.handle({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "hello",
      provider: "deepseek_expert",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "PROVIDER_NOT_CONFIGURED",
      diagnostic: "TDA-TR-EXPERT",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
