import { resolveStagedDownloadUrl, type DownloadableFile } from "../downloads/saveAs";
import { createSpeedTaskId, speedLog, speedNow } from "../shared/speedDiagnostics";

export const BROWSER_SPEECH_MODEL_ESTIMATED_BYTES = 90_000_000;
const BROWSER_SPEECH_MODEL = "onnx-community/whisper-base";
const MODEL_READY_STORAGE_KEY = "browserWhisperBaseReadyV1";
const TARGET_SAMPLE_RATE = 16_000;
const REQUIRED_MODEL_CACHE_URLS = [
  "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx",
  "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/decoder_model_merged_quantized.onnx",
] as const;

export interface BrowserSpeechProgress {
  phase: "audio" | "model" | "inference";
  percent: number | null;
  loadedBytes: number;
  totalBytes: number;
  message: string;
}

export interface BrowserTranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface BrowserTranscriptionResult {
  language: string;
  durationSeconds: number;
  text: string;
  segments: BrowserTranscriptSegment[];
}

type ProgressCallback = (progress: BrowserSpeechProgress) => void;
export type BrowserMediaBytesLoader = (
  mediaUrl: string,
  onProgress: ProgressCallback,
) => Promise<ArrayBuffer>;
type SpeechPipelineOutput = {
  text: string;
  chunks?: Array<{ timestamp: [number | null, number | null]; text: string }>;
};
type SpeechPipeline = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<SpeechPipelineOutput | SpeechPipelineOutput[]>;

let pipelinePromise: Promise<SpeechPipeline> | null = null;

export async function browserSpeechModelIsReady(
  taskId = createSpeedTaskId("subtitle-model-ready"),
): Promise<boolean> {
  const startedAt = speedNow();
  const storage = chrome.storage?.local;
  if (!storage) {
    speedLog("subtitle.model", taskId, "ready_check_complete", startedAt, {
      ready: false,
      reason: "storage_unavailable",
    });
    return false;
  }
  const stored = await storage.get(MODEL_READY_STORAGE_KEY);
  if (stored[MODEL_READY_STORAGE_KEY] !== true) {
    speedLog("subtitle.model", taskId, "ready_check_complete", startedAt, {
      ready: false,
      reason: "marker_missing",
    });
    return false;
  }
  if (typeof caches === "undefined") {
    speedLog("subtitle.model", taskId, "ready_check_complete", startedAt, {
      ready: true,
      reason: "cache_storage_unavailable",
    });
    return true;
  }
  try {
    const cache = await caches.open("transformers-cache");
    const requiredFiles = await Promise.all(
      REQUIRED_MODEL_CACHE_URLS.map((url) => cache.match(url)),
    );
    if (requiredFiles.every(Boolean)) {
      speedLog("subtitle.model", taskId, "ready_check_complete", startedAt, {
        ready: true,
        cached_file_count: requiredFiles.filter(Boolean).length,
      });
      return true;
    }
    await markModelReady(false);
    speedLog("subtitle.model", taskId, "ready_check_complete", startedAt, {
      ready: false,
      reason: "cached_files_missing",
      cached_file_count: requiredFiles.filter(Boolean).length,
    });
    return false;
  } catch (error) {
    // Some managed/incognito contexts expose CacheStorage but deny access.
    // Transformers.js will make the final cache decision when loading.
    speedLog("subtitle.model", taskId, "ready_check_complete", startedAt, {
      ready: true,
      reason: "cache_check_denied",
      error_name: error instanceof Error ? error.name : "unknown",
    });
    return true;
  }
}

export async function prepareBrowserSpeechModel(
  onProgress: ProgressCallback = () => undefined,
  taskId = createSpeedTaskId("subtitle-model-prepare"),
): Promise<void> {
  const startedAt = speedNow();
  await getSpeechPipeline(onProgress, taskId);
  speedLog("subtitle.model", taskId, "prepare_complete", startedAt);
}

export async function transcribeStagedAudio(
  audioFile: DownloadableFile,
  onProgress: ProgressCallback = () => undefined,
  taskId = createSpeedTaskId("subtitle-staged"),
  signal?: AbortSignal,
): Promise<BrowserTranscriptionResult> {
  const startedAt = speedNow();
  throwIfAborted(signal);
  const url = resolveStagedDownloadUrl(audioFile.download_url);
  onProgress({
    phase: "audio",
    percent: null,
    loadedBytes: 0,
    totalBytes: audioFile.size_bytes,
    message: "正在读取刚刚提取的音轨…",
  });
  const fetchStartedAt = speedNow();
  const response = await fetch(url, { cache: "no-store", signal });
  speedLog("subtitle.media", taskId, "staged_fetch_response", fetchStartedAt, {
    status: response.status,
    ok: response.ok,
  });
  if (!response.ok) throw new Error(`读取音轨失败（HTTP ${response.status}）`);
  const bufferStartedAt = speedNow();
  const audioBytes = await response.arrayBuffer();
  throwIfAborted(signal);
  speedLog("subtitle.media", taskId, "staged_buffer_complete", bufferStartedAt, {
    byte_length: audioBytes.byteLength,
  });
  const result = await transcribeAudioBytes(audioBytes, onProgress, taskId, signal);
  speedLog("subtitle.pipeline", taskId, "staged_transcription_complete", startedAt);
  return result;
}

export async function transcribeMediaUrl(
  mediaUrl: string,
  onProgress: ProgressCallback = () => undefined,
  fallbackLoader?: BrowserMediaBytesLoader,
  taskId = createSpeedTaskId("subtitle-media"),
  signal?: AbortSignal,
): Promise<BrowserTranscriptionResult> {
  const startedAt = speedNow();
  throwIfAborted(signal);
  let parsed: URL;
  try {
    parsed = new URL(mediaUrl);
  } catch {
    throw new Error("当前视频没有可供 Chrome 读取的媒体地址");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Chrome 兼容模式只读取 HTTPS 视频地址");
  }
  onProgress({
    phase: "audio",
    percent: null,
    loadedBytes: 0,
    totalBytes: 0,
    message: "正在由 Chrome 读取当前视频音轨…",
  });
  let mediaBytes: ArrayBuffer;
  try {
    const fetchStartedAt = speedNow();
    const response = await fetch(parsed.href, {
      cache: "no-store",
      credentials: "include",
      referrer: "https://www.tiktok.com/",
      referrerPolicy: "strict-origin-when-cross-origin",
      signal,
    });
    speedLog("subtitle.media", taskId, "direct_fetch_response", fetchStartedAt, {
      status: response.status,
      ok: response.ok,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bufferStartedAt = speedNow();
    mediaBytes = await response.arrayBuffer();
    throwIfAborted(signal);
    speedLog("subtitle.media", taskId, "direct_buffer_complete", bufferStartedAt, {
      byte_length: mediaBytes.byteLength,
    });
  } catch (directError) {
    throwIfAborted(signal);
    speedLog("subtitle.media", taskId, "direct_read_failed", startedAt, {
      error_name: directError instanceof Error ? directError.name : "unknown",
    });
    if (!fallbackLoader) {
      const detail = directError instanceof Error ? `：${directError.message}` : "";
      throw new Error(`Chrome 无法读取当前视频${detail}`);
    }
    onProgress({
      phase: "audio",
      percent: null,
      loadedBytes: 0,
      totalBytes: 0,
      message: "正在通过当前 TikTok 页面读取视频…",
    });
    const fallbackStartedAt = speedNow();
    mediaBytes = await fallbackLoader(parsed.href, onProgress);
    throwIfAborted(signal);
    speedLog("subtitle.media", taskId, "page_fallback_complete", fallbackStartedAt, {
      byte_length: mediaBytes.byteLength,
    });
  }
  speedLog("subtitle.media", taskId, "media_ready", startedAt, {
    byte_length: mediaBytes.byteLength,
  });
  return transcribeAudioBytes(mediaBytes, onProgress, taskId, signal);
}

async function transcribeAudioBytes(
  audioBytes: ArrayBuffer,
  onProgress: ProgressCallback,
  taskId: string,
  signal?: AbortSignal,
): Promise<BrowserTranscriptionResult> {
  const taskStartedAt = speedNow();
  throwIfAborted(signal);
  onProgress({
    phase: "audio",
    percent: 100,
    loadedBytes: audioBytes.byteLength,
    totalBytes: audioBytes.byteLength,
    message: "正在解码音轨…",
  });
  const decoded = await decodeToMono16Khz(audioBytes, taskId);
  throwIfAborted(signal);
  const pipelineStartedAt = speedNow();
  const transcriber = await getSpeechPipeline(onProgress, taskId);
  throwIfAborted(signal);
  speedLog("subtitle.model", taskId, "pipeline_ready", pipelineStartedAt);
  onProgress({
    phase: "inference",
    percent: null,
    loadedBytes: 0,
    totalBytes: 0,
    message: "正在浏览器内识别语音…",
  });
  const inferenceStartedAt = speedNow();
  const raw = await transcriber(decoded.samples, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    task: "transcribe",
  });
  throwIfAborted(signal);
  speedLog("subtitle.inference", taskId, "inference_complete", inferenceStartedAt, {
    audio_duration_seconds: Math.round(decoded.durationSeconds * 1000) / 1000,
    sample_count: decoded.samples.length,
  });
  const output = Array.isArray(raw) ? raw[0] : raw;
  if (!output) throw new Error("浏览器语音模型未返回识别结果");
  const normalizeStartedAt = speedNow();
  const segments = normalizeSegments(output, decoded.durationSeconds);
  speedLog("subtitle.inference", taskId, "normalize_complete", normalizeStartedAt, {
    segment_count: segments.length,
  });
  onProgress({
    phase: "inference",
    percent: 100,
    loadedBytes: 0,
    totalBytes: 0,
    message: "浏览器语音识别完成",
  });
  const result = {
    language: "auto",
    durationSeconds: decoded.durationSeconds,
    text: output.text.trim(),
    segments,
  };
  speedLog("subtitle.pipeline", taskId, "audio_pipeline_complete", taskStartedAt, {
    segment_count: segments.length,
  });
  return result;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("字幕任务已取消", "AbortError");
}

async function getSpeechPipeline(
  onProgress: ProgressCallback,
  taskId: string,
): Promise<SpeechPipeline> {
  const reused = pipelinePromise !== null;
  const startedAt = speedNow();
  if (!pipelinePromise) {
    pipelinePromise = createSpeechPipeline(onProgress, taskId).catch(async (error: unknown) => {
      pipelinePromise = null;
      await markModelReady(false);
      throw error;
    });
  }
  const result = await pipelinePromise;
  speedLog("subtitle.model", taskId, "pipeline_promise_resolved", startedAt, {
    reused,
  });
  return result;
}

async function createSpeechPipeline(
  onProgress: ProgressCallback,
  taskId: string,
): Promise<SpeechPipeline> {
  const startedAt = speedNow();
  const importStartedAt = speedNow();
  const { env, pipeline } = await import("@huggingface/transformers");
  speedLog("subtitle.model", taskId, "transformers_import_complete", importStartedAt);
  // Remote executable code is forbidden in Manifest V3. Bundle ONNX Runtime's
  // WASM and loader with the extension; only immutable model weights are fetched.
  const wasm = env.backends.onnx.wasm as {
    wasmPaths?: string;
    numThreads?: number;
    proxy?: boolean;
  } | undefined;
  if (wasm) {
    wasm.wasmPaths = chrome.runtime.getURL("assets/onnx/");
    // One thread also works without SharedArrayBuffer/cross-origin isolation,
    // which is the most compatible setting for managed Chrome installations.
    wasm.numThreads = 1;
    // A real 73-second video kept the side-panel thread busy for 23.9 seconds,
    // delaying an already-completed translation result by another 18.3 seconds.
    // ONNX Runtime's supported proxy mode keeps the exact same WASM model and
    // one-thread compatibility setting, but runs inference outside the UI thread.
    wasm.proxy = true;
  }
  speedLog("subtitle.model", taskId, "runtime_configured", undefined, {
    wasm_available: Boolean(wasm),
    wasm_threads: wasm?.numThreads ?? null,
    wasm_proxy: wasm?.proxy === true,
    cross_origin_isolated: globalThis.crossOriginIsolated === true,
    hardware_concurrency: globalThis.navigator?.hardwareConcurrency ?? null,
  });
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;

  const files = new Map<string, { loaded: number; total: number }>();
  const progressCallback = (event: unknown): void => {
    if (!event || typeof event !== "object") return;
    const item = event as Record<string, unknown>;
    const status = typeof item.status === "string" ? item.status : "";
    const file = typeof item.file === "string" ? item.file : status;
    if (status === "progress") {
      const loaded = numberOrZero(item.loaded);
      const total = numberOrZero(item.total);
      files.set(file, { loaded, total });
      const totals = [...files.values()];
      const loadedBytes = totals.reduce((sum, value) => sum + value.loaded, 0);
      const totalBytes = totals.reduce((sum, value) => sum + value.total, 0);
      onProgress({
        phase: "model",
        percent: totalBytes > 0 ? Math.min(100, Math.round(loadedBytes / totalBytes * 100)) : null,
        loadedBytes,
        totalBytes,
        message: "正在下载浏览器兼容语音模型…",
      });
    }
  };
  onProgress({
    phase: "model",
    percent: null,
    loadedBytes: 0,
    totalBytes: BROWSER_SPEECH_MODEL_ESTIMATED_BYTES,
    message: "正在检查 Chrome 中的语音模型缓存…",
  });
  const initializeStartedAt = speedNow();
  const transcriber = await pipeline(
    "automatic-speech-recognition",
    BROWSER_SPEECH_MODEL,
    {
      device: "wasm",
      dtype: "q8",
      progress_callback: progressCallback,
    },
  );
  speedLog("subtitle.model", taskId, "pipeline_initialize_complete", initializeStartedAt);
  await markModelReady(true);
  onProgress({
    phase: "model",
    percent: 100,
    loadedBytes: BROWSER_SPEECH_MODEL_ESTIMATED_BYTES,
    totalBytes: BROWSER_SPEECH_MODEL_ESTIMATED_BYTES,
    message: "浏览器兼容语音模型已就绪",
  });
  speedLog("subtitle.model", taskId, "pipeline_create_complete", startedAt);
  return transcriber as unknown as SpeechPipeline;
}

async function markModelReady(ready: boolean): Promise<void> {
  const storage = chrome.storage?.local;
  if (!storage) return;
  if (ready) await storage.set({ [MODEL_READY_STORAGE_KEY]: true });
  else await storage.remove(MODEL_READY_STORAGE_KEY);
}

async function decodeToMono16Khz(
  bytes: ArrayBuffer,
  taskId: string,
): Promise<{ samples: Float32Array; durationSeconds: number }> {
  const startedAt = speedNow();
  const decodingContext = new AudioContext();
  let decoded: AudioBuffer;
  const decodeStartedAt = speedNow();
  try {
    decoded = await decodingContext.decodeAudioData(bytes.slice(0));
  } finally {
    await decodingContext.close();
  }
  speedLog("subtitle.audio", taskId, "decode_complete", decodeStartedAt, {
    source_sample_rate: decoded.sampleRate,
    source_channels: decoded.numberOfChannels,
    duration_seconds: Math.round(decoded.duration * 1000) / 1000,
  });
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
    throw new Error("提取的音轨没有可识别内容");
  }
  if (decoded.sampleRate === TARGET_SAMPLE_RATE && decoded.numberOfChannels === 1) {
    const result = {
      samples: new Float32Array(decoded.getChannelData(0)),
      durationSeconds: decoded.duration,
    };
    speedLog("subtitle.audio", taskId, "audio_prepare_complete", startedAt, {
      resampled: false,
      sample_count: result.samples.length,
    });
    return result;
  }
  const frameCount = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const resampleStartedAt = speedNow();
  const rendered = await offline.startRendering();
  const result = {
    samples: new Float32Array(rendered.getChannelData(0)),
    durationSeconds: rendered.duration,
  };
  speedLog("subtitle.audio", taskId, "resample_complete", resampleStartedAt, {
    sample_count: result.samples.length,
  });
  speedLog("subtitle.audio", taskId, "audio_prepare_complete", startedAt, {
    resampled: true,
    sample_count: result.samples.length,
  });
  return result;
}

function normalizeSegments(
  output: SpeechPipelineOutput,
  durationSeconds: number,
): BrowserTranscriptSegment[] {
  const chunks = output.chunks ?? [];
  const segments = chunks.flatMap((chunk, index): BrowserTranscriptSegment[] => {
    const text = chunk.text.trim();
    if (!text) return [];
    const fallbackStart = index === 0 ? 0 : 0;
    const startValue = chunk.timestamp?.[0];
    const endValue = chunk.timestamp?.[1];
    const start = typeof startValue === "number" && Number.isFinite(startValue)
      ? Math.max(0, startValue)
      : fallbackStart;
    const end = typeof endValue === "number" && Number.isFinite(endValue)
      ? Math.max(start, endValue)
      : Math.max(start, durationSeconds);
    return [{ start, end, text }];
  });
  if (segments.length) return segments;
  const text = output.text.trim();
  return text ? [{ start: 0, end: durationSeconds, text }] : [];
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
