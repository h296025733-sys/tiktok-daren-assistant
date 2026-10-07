import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveBrowserAudioWav, saveBrowserVideo, validatedMediaUrl } from "../src/media/browserMedia";

const media = {
  video_id: "7444444444444444444",
  media_url: "https://v16.tiktokcdn.com/video.mp4?x=1",
  author_unique_id: "fixture_author",
};

let download: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  download = vi.fn(async () => 42);
  vi.stubGlobal("chrome", { downloads: { download } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
  vi.stubGlobal("AudioContext", class {
    async decodeAudioData(): Promise<Partial<AudioBuffer>> {
      return {
        duration: 2 / 16_000,
        length: 2,
        numberOfChannels: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array([-1, 0.5]),
      };
    }
    async close(): Promise<void> {}
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chrome-audio");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

describe("纯 Chrome 媒体处理", () => {
  it("直接保存可信 TikTok 视频地址", async () => {
    const result = await saveBrowserVideo(media);
    expect(result.fileName).toBe("fixture_author_7444444444444444444.mp4");
    expect(download).toHaveBeenCalledWith(expect.objectContaining({
      url: media.media_url,
      saveAs: true,
    }));
  });

  it("在浏览器内把视频音轨导出为 PCM WAV", async () => {
    const result = await saveBrowserAudioWav(media);
    expect(result.fileName).toBe("fixture_author_7444444444444444444.wav");
    expect(result.sizeBytes).toBe(48);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({
      url: "blob:chrome-audio",
      filename: result.fileName,
    }));
  });

  it("拒绝非 TikTok 媒体主机", () => {
    expect(() => validatedMediaUrl("https://example.com/file.mp4"))
      .toThrow("不是受支持的 TikTok 媒体地址");
  });
});
