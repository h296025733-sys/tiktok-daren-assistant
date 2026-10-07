import { describe, expect, it, vi } from "vitest";

import {
  ForegroundTranslationBridge,
  sanitizeForegroundTranslationRequest,
  usableForegroundTranslationResults,
  usableQueuedForegroundTranslations,
} from "../src/translation/foregroundQueue";
import type { TranslationResponse } from "../src/types/messages";

const success: TranslationResponse = {
  ok: true,
  data: {
    items: [{
      source_text: "Public comment",
      translated_text: "公开评论",
      detected_source_language: "en",
      target_language: "zh-CN",
      cached: false,
    }],
    provider: "local_foreground",
    provider_notice: "侧栏本地翻译",
  },
};

describe("前景翻译 session 队列", () => {
  it("只保留短期、同扩展生成且边界合法的任务与结果", () => {
    const now = 1_800_000_000_000;
    const validQueue = {
      request_id: "request_12345678",
      tab_id: 17,
      requested_at: now,
      request: { type: "TRANSLATE_PUBLIC_TEXT", text: " Public comment " },
    };
    expect(usableQueuedForegroundTranslations([
      { ...validQueue, request_id: "expired_123456", requested_at: now - 6 * 60_000 },
      { ...validQueue, request_id: "bad_12345678", request: { ...validQueue.request, text: "" } },
      validQueue,
    ], now)).toEqual([validQueue]);

    const validResult = {
      request_id: validQueue.request_id,
      tab_id: 17,
      updated_at: now,
      response: success,
    };
    expect(usableForegroundTranslationResults([
      { ...validResult, request_id: "expired_result", updated_at: now - 6 * 60_000 },
      { ...validResult, response: { ok: true, data: { items: [] } } },
      validResult,
    ], now)).toEqual([validResult]);
  });

  it("入队前删除未知字段、修剪文本并拒绝超限批量", () => {
    expect(sanitizeForegroundTranslationRequest({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: [" Alpha ", "Beta"],
      target_language: "ja",
      provider: "standard",
      cookie: "must-not-persist",
    })).toEqual({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: ["Alpha", "Beta"],
      target_language: "ja",
      provider: "standard",
    });
    expect(sanitizeForegroundTranslationRequest({
      type: "TRANSLATE_PUBLIC_TEXT_BATCH",
      texts: Array.from({ length: 81 }, () => "x"),
    })).toBeNull();
  });

  it("排队后轮询 pending 直至侧栏写回 completed", async () => {
    let now = 10_000;
    const messages: unknown[] = [];
    let polls = 0;
    const bridge = new ForegroundTranslationBridge({
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds; },
      pollIntervalMs: 50,
      timeoutMs: 2_000,
      sendMessage: vi.fn(async (message: unknown) => {
        messages.push(message);
        const type = (message as { type?: string }).type;
        if (type === "QUEUE_FOREGROUND_TRANSLATION") {
          return { ok: true, request_id: "request_12345678", diagnostic: "fg_queue_enqueued" };
        }
        polls += 1;
        return polls === 1
          ? { ok: true, status: "pending", diagnostic: "fg_queue_pending" }
          : { ok: true, status: "completed", response: success, diagnostic: "fg_queue_completed" };
      }),
    });

    await expect(bridge.translate({
      type: "TRANSLATE_PUBLIC_TEXT",
      text: "Public comment",
    })).resolves.toEqual(success);
    expect(messages.map((message) => (message as { type: string }).type)).toEqual([
      "QUEUE_FOREGROUND_TRANSLATION",
      "GET_FOREGROUND_TRANSLATION_RESULT",
      "GET_FOREGROUND_TRANSLATION_RESULT",
    ]);
  });

  it("超时只返回固定诊断码，不泄露待翻译原文", async () => {
    let now = 0;
    const privateText = "private-comment-should-not-enter-diagnostic";
    const bridge = new ForegroundTranslationBridge({
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds; },
      pollIntervalMs: 250,
      timeoutMs: 1_000,
      sendMessage: async (message) => (message as { type?: string }).type === "QUEUE_FOREGROUND_TRANSLATION"
        ? { ok: true, request_id: "request_12345678", diagnostic: "fg_queue_enqueued" }
        : { ok: true, status: "pending", diagnostic: "fg_queue_pending" },
    });
    const response = await bridge.translate({ type: "TRANSLATE_PUBLIC_TEXT", text: privateText });
    expect(response).toMatchObject({ ok: false, code: "REQUEST_TIMEOUT", diagnostic: "fg_queue_timeout" });
    expect(JSON.stringify(response)).not.toContain(privateText);
  });
});
