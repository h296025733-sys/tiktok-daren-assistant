import { describe, expect, it, vi } from "vitest";

import {
  pickBatchArchiveTarget,
  pickSingleMediaTarget,
  writeBatchArchiveTarget,
  writeSingleMediaTarget,
  type BrowserMediaDescriptor,
} from "../src/downloads/browserWorkflow";
import { batchArchiveFileName, mediaDownloadFileName, stripCaptionTags } from "../src/downloads/naming";
import { StoredZipWriter } from "../src/downloads/zipWriter";

const first = {
  video_id: "7658854290118692126",
  page_url: "https://www.tiktok.com/@creator/video/7658854290118692126",
  media_url: "https://v16.tiktokcdn.com/one.mp4",
  media_source: "registry_play_url" as const,
  background_music_url: "https://v16.tiktokcdn.com/one-music.mp3",
  author_unique_id: "creator",
  author_nickname: "Creator",
  description: "A useful caption #fyp #TikTok",
  created_at: 1_721_424_000,
};

describe("浏览器下载工作流", () => {
  it("按日期、视频 ID、TK 号和去标签文案生成单个文件名", () => {
    expect(stripCaptionTags("Hello #fyp world #测试")).toBe("Hello world");
    expect(mediaDownloadFileName(first, "video"))
      .toBe("2024-07-20_7658854290118692126_creator_A useful caption.mp4");
    expect(mediaDownloadFileName(first, "audio_track"))
      .toBe("2024-07-20_7658854290118692126_creator_A useful caption.wav");
    expect(batchArchiveFileName([first], new Date(2026, 6, 23)))
      .toBe("2026-07-23_creator.zip");
  });

  it("在任何媒体读取前同步打开单个与批量保存位置选择器", async () => {
    const picker = vi.fn(async () => ({ createWritable: vi.fn() }));
    vi.stubGlobal("showSaveFilePicker", picker);

    const singlePromise = pickSingleMediaTarget(first, "video");
    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker).toHaveBeenLastCalledWith(expect.objectContaining({
      suggestedName: expect.stringMatching(/\.mp4$/),
    }));
    await singlePromise;

    const batchPromise = pickBatchArchiveTarget([first]);
    expect(picker).toHaveBeenCalledTimes(2);
    expect(picker).toHaveBeenLastCalledWith(expect.objectContaining({
      suggestedName: expect.stringMatching(/_creator\.zip$/),
    }));
    await batchPromise;
    vi.unstubAllGlobals();
  });

  it("批量视频只写入一个有效 ZIP，并保留每条媒体的规范文件名", async () => {
    const writes: Uint8Array[] = [];
    const handle = {
      createWritable: async () => ({
        write: async (value: unknown) => {
          const bytes = value instanceof Uint8Array
            ? value
            : new Uint8Array(value as ArrayBuffer);
          writes.push(bytes.slice());
        },
        close: async () => undefined,
        abort: async () => undefined,
      }),
    };
    const second = {
      ...first,
      video_id: "7658854290118692127",
      media_url: "https://v16.tiktokcdn.com/two.mp4",
      description: "Second #tag",
    };
    const loader = vi.fn(async (url: string) => (
      new Uint8Array(url.includes("one.") ? [1, 2, 3] : [4, 5]).buffer
    ));

    const result = await writeBatchArchiveTarget(handle, [first, second], "video", loader);
    const totalLength = writes.reduce((sum, value) => sum + value.byteLength, 0);
    const zip = new Uint8Array(totalLength);
    let offset = 0;
    for (const value of writes) {
      zip.set(value, offset);
      offset += value.byteLength;
    }
    const text = new TextDecoder().decode(zip);
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new DataView(zip.buffer).getUint32(zip.byteLength - 22, true)).toBe(0x06054b50);
    expect(text).toContain("2024-07-20_7658854290118692126_creator_A useful caption.mp4");
    expect(text).toContain("2024-07-20_7658854290118692127_creator_Second.mp4");
    expect(result).toMatchObject({ succeeded: 2, failed: 0 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("批量地址过期或缺失时刷新地址重试，并上报真实成功失败数", async () => {
    const writes: Uint8Array[] = [];
    const handle = {
      createWritable: async () => ({
        write: async (value: unknown) => {
          writes.push((value as Uint8Array).slice());
        },
        close: async () => undefined,
        abort: async () => undefined,
      }),
    };
    const missing = {
      ...first,
      video_id: "7658854290118692127",
      page_url: "https://www.tiktok.com/@creator/video/7658854290118692127",
      media_url: null,
    };
    const failed = {
      ...first,
      video_id: "7658854290118692128",
      page_url: "https://www.tiktok.com/@creator/video/7658854290118692128",
      media_url: null,
    };
    const loader = vi.fn(async (url: string) => {
      if (url.includes("expired")) throw new Error("HTTP 403");
      return new Uint8Array([1, 2, 3]).buffer;
    });
    const resolver = vi.fn(async (media: BrowserMediaDescriptor) => (
      media.video_id === failed.video_id
        ? null
        : `https://v16.tiktokcdn.com/${media.video_id}.mp4?fresh=1`
    ));
    const progress = vi.fn();
    const result = await writeBatchArchiveTarget(
      handle,
      [{ ...first, media_url: "https://v16.tiktokcdn.com/expired.mp4" }, missing, failed],
      "video",
      loader,
      progress,
      resolver,
    );

    expect(result).toMatchObject({ succeeded: 2, failed: 1 });
    expect(result.failures).toEqual([expect.objectContaining({ video_id: failed.video_id })]);
    expect(resolver).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith("ZIP 保存完成", 3, 3, 2, 1);
    expect(new TextDecoder().decode(concatBytes(writes))).toContain(missing.video_id);
  });

  it("总压缩包超过传统 4GB 边界时写入 ZIP64 目录记录", async () => {
    const writes: Uint8Array[] = [];
    const writer = new StoredZipWriter({
      write: async (value: unknown) => {
        writes.push((value as Uint8Array).slice());
      },
      close: async () => undefined,
      abort: async () => undefined,
    }, { zip64Threshold: 0n });
    await writer.add("one.mp4", new Uint8Array([1, 2, 3]));
    await writer.close();
    const zip = concatBytes(writes);
    const signatures = Array.from({ length: zip.byteLength - 3 }, (_, index) => (
      new DataView(zip.buffer, zip.byteOffset + index, 4).getUint32(0, true)
    ));
    expect(signatures).toContain(0x06064b50);
    expect(signatures).toContain(0x07064b50);
    const centralIndex = signatures.indexOf(0x02014b50);
    expect(centralIndex).toBeGreaterThanOrEqual(0);
    const central = new DataView(zip.buffer, zip.byteOffset + centralIndex);
    expect(central.getUint32(42, true)).toBe(0xffff_ffff);
    const nameLength = central.getUint16(28, true);
    const extraOffset = centralIndex + 46 + nameLength;
    expect(new DataView(zip.buffer, zip.byteOffset + extraOffset).getUint16(0, true)).toBe(0x0001);
    expect(new DataView(zip.buffer, zip.byteOffset + zip.byteLength - 22, 22).getUint32(0, true))
      .toBe(0x06054b50);
  });

  it("单个音频始终读取原视频音轨并写成 WAV", async () => {
    const write = vi.fn(async (_value: unknown) => undefined);
    const handle = {
      createWritable: async () => ({
        write,
        close: async () => undefined,
        abort: async () => undefined,
      }),
    };
    const loader = vi.fn(async () => new Uint8Array([9, 8, 7]).buffer);
    vi.stubGlobal("AudioContext", class {
      async decodeAudioData(): Promise<{
        duration: number;
        numberOfChannels: number;
        length: number;
        sampleRate: number;
        getChannelData(index: number): Float32Array;
      }> {
        return {
          duration: 1,
          numberOfChannels: 1,
          length: 2,
          sampleRate: 8_000,
          getChannelData: () => new Float32Array([0, 0.25]),
        };
      }
      async close(): Promise<void> {}
    });

    const fileName = await writeSingleMediaTarget(handle, first, "audio_track", loader);
    expect(loader).toHaveBeenCalledWith(first.media_url, expect.any(Function));
    expect(write).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(fileName).toBe("2024-07-20_7658854290118692126_creator_A useful caption.wav");
    const wav = write.mock.calls[0]?.[0] as Uint8Array;
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    vi.unstubAllGlobals();
  });

  it("批量音频同样只读取各自原视频并写入一个 ZIP", async () => {
    const writes: Uint8Array[] = [];
    const handle = {
      createWritable: async () => ({
        write: async (value: unknown) => {
          writes.push((value as Uint8Array).slice());
        },
        close: async () => undefined,
        abort: async () => undefined,
      }),
    };
    const loader = vi.fn(async (
      _url: string,
      _onProgress?: (loadedBytes: number, totalBytes: number) => void,
    ) => new Uint8Array([7, 8, 9]).buffer);
    vi.stubGlobal("AudioContext", class {
      async decodeAudioData(): Promise<{
        duration: number; numberOfChannels: number; length: number; sampleRate: number;
        getChannelData(): Float32Array;
      }> {
        return {
          duration: 1, numberOfChannels: 1, length: 1, sampleRate: 8_000,
          getChannelData: () => new Float32Array([0]),
        };
      }
      async close(): Promise<void> {}
    });

    const result = await writeBatchArchiveTarget(handle, [first], "audio_track", loader);
    expect(loader.mock.calls[0]?.[0]).toBe(first.media_url);
    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
    expect(new TextDecoder().decode(concatBytes(writes)))
      .toContain("2024-07-20_7658854290118692126_creator_A useful caption.wav");
    vi.unstubAllGlobals();
  });

});

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, value) => sum + value.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
