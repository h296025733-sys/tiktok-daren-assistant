import { afterEach, describe, expect, it, vi } from "vitest";

describe("Chrome-only loopback boundary", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetModules();
  });

  it("blocks stale local backends while allowing browser model downloads", async () => {
    const transport = vi.fn(async () => new Response("ok"));
    globalThis.fetch = transport as typeof fetch;
    const { installChromeOnlyLoopbackGuard } = await import("../src/runtimeMode");
    installChromeOnlyLoopbackGuard(true);

    await expect(fetch("http://localhost:8765/api/v1/models/whisper-base/install"))
      .rejects.toThrow("TDA_CHROME_ONLY_LOOPBACK_BLOCKED");
    await expect(fetch("http://127.0.0.1:8765/api/v1/transcriptions"))
      .rejects.toThrow("TDA_CHROME_ONLY_LOOPBACK_BLOCKED");
    await expect(fetch("https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/model_q8.onnx"))
      .resolves.toBeInstanceOf(Response);

    expect(transport).toHaveBeenCalledTimes(1);
  });
});
