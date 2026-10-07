import { safeSuggestedFilename } from "../downloads/saveAs";

export interface BrowserMediaDescriptor {
  video_id: string;
  media_url: string | null;
  author_unique_id?: string | null;
  author_nickname?: string | null;
}

export type BrowserMediaProgress = (message: string) => void;
export type BrowserMediaBytesLoader = (mediaUrl: string) => Promise<ArrayBuffer>;

const ALLOWED_MEDIA_HOST_SUFFIXES = [
  ".tiktok.com",
  ".tiktokcdn.com",
  ".tiktokcdn-us.com",
  ".tiktokv.com",
  ".byteoversea.com",
  ".ibytedtos.com",
  ".akamaized.net",
  ".muscdn.com",
  ".byteimg.com",
] as const;

export async function saveBrowserVideo(
  media: BrowserMediaDescriptor,
  saveAs = true,
): Promise<{ downloadId: number; fileName: string }> {
  const url = validatedMediaUrl(media.media_url);
  const fileName = safeSuggestedFilename(`${mediaBaseName(media)}.mp4`);
  const downloadId = await chrome.downloads.download({
    url,
    filename: fileName,
    saveAs,
    conflictAction: "uniquify",
  });
  return { downloadId, fileName };
}

export async function saveBrowserAudioWav(
  media: BrowserMediaDescriptor,
  saveAs = true,
  onProgress: BrowserMediaProgress = () => undefined,
  fallbackLoader?: BrowserMediaBytesLoader,
): Promise<{ downloadId: number; fileName: string; sizeBytes: number }> {
  const url = validatedMediaUrl(media.media_url);
  onProgress("正在由 Chrome 读取视频音轨…");
  let bytes: ArrayBuffer;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "include",
      referrer: "https://www.tiktok.com/",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = await response.arrayBuffer();
  } catch (directError) {
    if (!fallbackLoader) throw directError;
    onProgress("正在通过当前 TikTok 页面读取视频音轨…");
    bytes = await fallbackLoader(url);
  }
  onProgress("正在浏览器内导出 WAV 音频…");
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(bytes.slice(0));
  } finally {
    await context.close();
  }
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
    throw new Error("当前视频没有可导出的音轨");
  }
  const wav = encodePcm16Wav(decoded);
  const objectUrl = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  const fileName = safeSuggestedFilename(`${mediaBaseName(media)}.wav`);
  try {
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename: fileName,
      saveAs,
      conflictAction: "uniquify",
    });
    return { downloadId, fileName, sizeBytes: wav.byteLength };
  } finally {
    globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}

export function validatedMediaUrl(value: string | null | undefined): string {
  if (!value) throw new Error("当前页面还没有捕获到可下载的视频地址，请播放视频后重试");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("当前视频地址无效，请刷新页面后重试");
  }
  const hostname = parsed.hostname.toLowerCase();
  const allowed = parsed.protocol === "https:" && ALLOWED_MEDIA_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
  );
  if (!allowed || parsed.username || parsed.password) {
    throw new Error("当前视频地址不是受支持的 TikTok 媒体地址");
  }
  return parsed.href;
}

function mediaBaseName(media: BrowserMediaDescriptor): string {
  const author = media.author_unique_id || media.author_nickname || "TikTok";
  return `${author}_${media.video_id}`;
}

export function encodePcm16Wav(audio: AudioBuffer): ArrayBuffer {
  const channels = Math.max(1, Math.min(2, audio.numberOfChannels));
  const frames = audio.length;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const output = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(output);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  const channelData = Array.from({ length: channels }, (_, index) => audio.getChannelData(index));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel]?.[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return output;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
