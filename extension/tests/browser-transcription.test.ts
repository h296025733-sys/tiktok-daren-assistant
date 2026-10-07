import { beforeEach, describe, expect, it, vi } from "vitest";

const speechRuntime = vi.hoisted(() => ({
  pipeline: vi.fn(async () => vi.fn(async () => ({
    text: "Page fallback works.",
    chunks: [{ timestamp: [0, 1], text: "Page fallback works." }],
  }))),
  env: {
    allowLocalModels: true,
    allowRemoteModels: false,
    useBrowserCache: false,
    backends: {
      onnx: {
        wasm: {} as { wasmPaths?: string; numThreads?: number; proxy?: boolean },
      },
    },
  },
}));

vi.mock("@huggingface/transformers", () => speechRuntime);

describe("browser speech model storage", () => {
  const storageSet = vi.fn(async () => undefined);

  beforeEach(() => {
    speechRuntime.pipeline.mockClear();
    storageSet.mockClear();
    vi.stubGlobal("chrome", {
      runtime: { getURL: (path: string) => `chrome-extension://fixture/${path}` },
      storage: {
        local: {
          get: vi.fn(async () => ({ browserWhisperBaseReadyV1: true })),
          set: storageSet,
          remove: vi.fn(async () => undefined),
        },
      },
    });
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({ match: vi.fn(async () => new Response("weights")) })),
    });
    vi.stubGlobal("AudioContext", class {
      async decodeAudioData(): Promise<Record<string, unknown>> {
        return {
          duration: 1,
          numberOfChannels: 1,
          sampleRate: 16_000,
          length: 16_000,
          getChannelData: () => new Float32Array(16_000),
        };
      }
      async close(): Promise<void> {}
    });
  });

  it("loads immutable weights through Transformers.js and marks the Chrome cache ready", async () => {
    const { browserSpeechModelIsReady, prepareBrowserSpeechModel } = await import(
      "../src/sidepanel/browserTranscription"
    );

    await prepareBrowserSpeechModel();
    expect(speechRuntime.pipeline).toHaveBeenCalledWith(
      "automatic-speech-recognition",
      "onnx-community/whisper-base",
      expect.objectContaining({ device: "wasm", dtype: "q8" }),
    );
    expect(speechRuntime.env.allowLocalModels).toBe(false);
    expect(speechRuntime.env.allowRemoteModels).toBe(true);
    expect(speechRuntime.env.useBrowserCache).toBe(true);
    expect(speechRuntime.env.backends.onnx.wasm.wasmPaths)
      .toBe("chrome-extension://fixture/assets/onnx/");
    expect(speechRuntime.env.backends.onnx.wasm.numThreads).toBe(1);
    expect(speechRuntime.env.backends.onnx.wasm.proxy).toBe(true);
    expect(storageSet).toHaveBeenCalledWith({ browserWhisperBaseReadyV1: true });
    await expect(browserSpeechModelIsReady()).resolves.toBe(true);
  });

  it("falls back to the active TikTok page when the extension CDN request returns 403", async () => {
    const directFetch = vi.fn(async () => new Response("Forbidden", { status: 403 }));
    vi.stubGlobal("fetch", directFetch);
    const pageLoader = vi.fn(async () => new ArrayBuffer(32));
    const { transcribeMediaUrl } = await import("../src/sidepanel/browserTranscription");

    const result = await transcribeMediaUrl(
      "https://v16.tiktokcdn.com/video.mp4",
      () => undefined,
      pageLoader,
    );

    expect(directFetch).toHaveBeenCalledOnce();
    expect(pageLoader).toHaveBeenCalledWith(
      "https://v16.tiktokcdn.com/video.mp4",
      expect.any(Function),
    );
    expect(result.text).toBe("Page fallback works.");
  });
});
