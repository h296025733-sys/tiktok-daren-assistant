import { encodePcm16Wav } from "../media/browserMedia";
import type { BatchMediaDescriptor, CurrentMediaDescriptor } from "../types/messages";
import { pickSaveFile, type BrowserSaveFileHandle } from "./filePicker";
import {
  batchArchiveFileName,
  mediaDownloadFileName,
  type BrowserDownloadMode,
  type DownloadNamingDescriptor,
} from "./naming";
import { StoredZipWriter } from "./zipWriter";

export type BrowserMediaDescriptor = CurrentMediaDescriptor | BatchMediaDescriptor;
export type BrowserMediaBytesLoader = (
  mediaUrl: string,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
) => Promise<ArrayBuffer>;
export type BrowserMediaUrlResolver = (media: BrowserMediaDescriptor) => Promise<string | null>;
export type BrowserDownloadProgress = (
  message: string,
  processed: number,
  total: number,
  succeeded?: number,
  failed?: number,
) => void;

export interface BrowserBatchDownloadResult {
  fileName: string;
  succeeded: number;
  failed: number;
  failures: Array<{ video_id: string; message: string }>;
}

export function pickSingleMediaTarget(
  media: Readonly<DownloadNamingDescriptor>,
  mode: BrowserDownloadMode,
): Promise<BrowserSaveFileHandle | null> {
  return pickSaveFile(
    mediaDownloadFileName(media, mode),
    mode === "video" ? "无水印 MP4 视频" : "WAV 原视频音频",
    mode === "video" ? "video/mp4" : "audio/wav",
    mode === "video" ? ".mp4" : ".wav",
  );
}

export function pickBatchArchiveTarget(
  items: readonly DownloadNamingDescriptor[],
): Promise<BrowserSaveFileHandle | null> {
  return pickSaveFile(batchArchiveFileName(items), "TikTok 批量下载 ZIP", "application/zip", ".zip");
}

export async function writeSingleMediaTarget(
  handle: BrowserSaveFileHandle,
  media: BrowserMediaDescriptor,
  mode: BrowserDownloadMode,
  loadBytes: BrowserMediaBytesLoader,
  onProgress: BrowserDownloadProgress = () => undefined,
): Promise<string> {
  const fileName = mediaDownloadFileName(media, mode);
  onProgress(mode === "video" ? "正在读取无水印视频…" : "正在读取背景音频…", 0, 1);
  const output = mode === "video"
    ? new Uint8Array(await loadBytes(requiredVideoUrl(media), progressReporter(onProgress)))
    : new Uint8Array(await loadAudioAsWav(media, loadBytes, progressReporter(onProgress)));
  const writable = await handle.createWritable();
  try {
    await writable.write(output);
    await writable.close();
  } catch (error) {
    await writable.abort?.(error).catch(() => undefined);
    throw error;
  }
  const savedFile = await handle.getFile?.();
  if (savedFile && savedFile.size !== output.byteLength) {
    throw new Error(`文件写入不完整：应为 ${output.byteLength} 字节，实际为 ${savedFile.size} 字节`);
  }
  onProgress("保存完成", 1, 1);
  return fileName;
}

export async function writeBatchArchiveTarget(
  handle: BrowserSaveFileHandle,
  items: readonly BrowserMediaDescriptor[],
  mode: BrowserDownloadMode,
  loadBytes: BrowserMediaBytesLoader,
  onProgress: BrowserDownloadProgress = () => undefined,
  resolveMediaUrl?: BrowserMediaUrlResolver,
): Promise<BrowserBatchDownloadResult> {
  const writable = await handle.createWritable();
  const zip = new StoredZipWriter(writable);
  let succeeded = 0;
  let failed = 0;
  const failures: BrowserBatchDownloadResult["failures"] = [];
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      onProgress(`正在处理 ${index + 1}/${items.length}`, index, items.length, succeeded, failed);
      try {
        const mediaBytes = await loadBatchMediaBytes(item, loadBytes, resolveMediaUrl);
        const output = mode === "video"
          ? mediaBytes
          : new Uint8Array(await convertToWav(mediaBytes.buffer as ArrayBuffer));
        await zip.add(mediaDownloadFileName(item, mode), output, mediaDate(item.created_at));
        succeeded += 1;
      } catch (error) {
        failed += 1;
        failures.push({
          video_id: item.video_id,
          message: error instanceof Error ? error.message : "媒体处理失败",
        });
        console.error(`[TikTok 达人助手] 批量项目 ${item.video_id} 处理失败`, error);
      }
      onProgress(`已处理 ${index + 1}/${items.length}`, index + 1, items.length, succeeded, failed);
    }
    if (!succeeded) throw new Error("所选媒体全部处理失败，ZIP 未生成");
    await zip.close();
  } catch (error) {
    await zip.abort(error).catch(() => undefined);
    throw error;
  }
  onProgress("ZIP 保存完成", items.length, items.length, succeeded, failed);
  return { fileName: batchArchiveFileName(items), succeeded, failed, failures };
}

async function loadBatchMediaBytes(
  media: BrowserMediaDescriptor,
  loadBytes: BrowserMediaBytesLoader,
  resolveMediaUrl?: BrowserMediaUrlResolver,
): Promise<Uint8Array> {
  let firstError: unknown = null;
  if (media.media_url) {
    try {
      return new Uint8Array(await loadBytes(media.media_url));
    } catch (error) {
      firstError = error;
    }
  }

  if (resolveMediaUrl) {
    try {
      const freshUrl = await resolveMediaUrl(media);
      if (freshUrl) return new Uint8Array(await loadBytes(freshUrl));
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }

  if (firstError instanceof Error) throw firstError;
  throw new Error("当前视频尚未捕获无水印视频地址，重新获取后仍不可用");
}

function requiredVideoUrl(media: BrowserMediaDescriptor): string {
  if (!media.media_url) throw new Error("当前视频尚未捕获无水印视频地址");
  return media.media_url;
}

async function loadAudioAsWav(
  media: BrowserMediaDescriptor,
  loadBytes: BrowserMediaBytesLoader,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): Promise<ArrayBuffer> {
  return convertToWav(await loadBytes(requiredVideoUrl(media), onProgress));
}

function progressReporter(
  onProgress: BrowserDownloadProgress,
): (loadedBytes: number, totalBytes: number) => void {
  return (loaded, total) => {
    const percent = total > 0 ? Math.round(loaded / total * 100) : 0;
    onProgress(`正在读取媒体 ${percent}%…`, 0, 1);
  };
}

async function convertToWav(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(bytes.slice(0));
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
      throw new Error("当前媒体没有可导出的音轨");
    }
    return encodePcm16Wav(decoded);
  } finally {
    await context.close();
  }
}

function mediaDate(createdAt: number | null | undefined): Date {
  const value = typeof createdAt === "number" && Number.isFinite(createdAt)
    ? (createdAt < 10_000_000_000 ? createdAt * 1_000 : createdAt)
    : Date.now();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
