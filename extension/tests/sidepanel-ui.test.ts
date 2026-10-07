import { beforeAll, describe, expect, it, vi } from "vitest";

import type { PageUpdateMessage } from "../src/types/messages";
import type { Snapshot } from "../src/types/snapshot";

const chromeOnlyIt = process.env.TDA_CHROME_ONLY_BUILD === "1" ? it : it.skip;
if (process.env.TDA_CHROME_ONLY_BUILD === "1") {
  vi.stubGlobal("__TDA_CHROME_ONLY__", true);
}

const browserSpeech = vi.hoisted(() => ({
  ready: false,
  pauseMedia: false,
  releaseMedia: null as null | (() => void),
  readyCheck: vi.fn(async () => browserSpeech.ready),
  prepare: vi.fn(async () => {
    browserSpeech.ready = true;
  }),
  result: {
    language: "en",
    durationSeconds: 4,
    text: "Browser fallback works.",
    segments: [{ start: 0, end: 4, text: "Browser fallback works." }],
  },
  transcribeStaged: vi.fn(async () => browserSpeech.result),
  transcribeMedia: vi.fn(async () => {
    if (browserSpeech.pauseMedia) {
      await new Promise<void>((resolve) => {
        browserSpeech.releaseMedia = resolve;
      });
    }
    return browserSpeech.result;
  }),
}));

vi.mock("../src/sidepanel/browserTranscription", () => ({
  BROWSER_SPEECH_MODEL_ESTIMATED_BYTES: 90_000_000,
  browserSpeechModelIsReady: browserSpeech.readyCheck,
  prepareBrowserSpeechModel: browserSpeech.prepare,
  transcribeStagedAudio: browserSpeech.transcribeStaged,
  transcribeMediaUrl: browserSpeech.transcribeMedia,
}));

const TAB_URL = "https://www.tiktok.com/@fixture/video/7444444444444444444";
let runtimeListener:
  | ((message: PageUpdateMessage, sender: chrome.runtime.MessageSender) => void)
  | null = null;
let runtimeSendMessage: ReturnType<typeof vi.fn>;
let tabsSendMessage: ReturnType<typeof vi.fn>;
let downloadsDownload: ReturnType<typeof vi.fn>;
let showSaveFilePicker: ReturnType<typeof vi.fn>;
let writableWrite: ReturnType<typeof vi.fn>;
let transcriptionSegments: Array<{ start: number; end: number; text: string }>;
let lastTranscriptionBody: Record<string, unknown> | null;
let translationBatchBodies: Array<{ texts: string[]; target_language: string }>;
let subtitleTranslationRequests: Array<{ texts: string[]; target_language: string }>;
let pauseSubtitleTranslation: boolean;
let releaseSubtitleTranslation: (() => void) | null;
let subtitleTranslationCancellationsRemaining: number;
let transcriptionModelRequired: boolean;
let transcriptionRuntimeBlocked: boolean;
let backendUnavailable: boolean;
let downloadBackendUnavailable: boolean;
let currentMediaUrl: string | null;
let currentSubtitleUrl: string | null;
let currentVideoId: string;
let currentMediaGeneration: number;
let freshPageSubtitleUrl: string | null;
let freshPageFetchCalls: number;
let pageContextCaptionAvailable: boolean;
let pageContextCaptionEnd: number;
let mediaDescriptorFailuresRemaining: number;
let translationModelRequired: boolean;
let whisperInstalled: boolean;
let argosInstalled: boolean;
let ruEnInstalled: boolean;
let failNextModelStatus: boolean;
let modelStatusErrorId: string | null;
let modelStatusCalls: number;
let modelInstallCalls: string[];
let sessionStorageState: Record<string, unknown>;
let localStorageState: Record<string, unknown>;
let storageSessionSet: ReturnType<typeof vi.fn>;
let storageLocalSet: ReturnType<typeof vi.fn>;
let storageChangedListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;

function snapshot(videoId: string, playCount: number, description = "测试视频描述"): Snapshot {
  return {
    page_type: "video_detail",
    page_url: TAB_URL,
    video_id: videoId,
    author: { nickname: "示例作者", unique_id: "fixture_author" },
    description,
    created_at: 1_721_424_000,
    publish_time_text: "暂未获取",
    duration_seconds: 67,
    metrics: {
      play_count: playCount,
      like_count: 38_900,
      comment_count: 766,
      collect_count: 898,
      share_count: 71,
    },
    extraction: { source: "registry:hydration_json", confidence: "high" },
    field_evidence: {},
    raw_data: { surface_mode: "video_detail", registry_match: videoId },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  document.body.innerHTML = '<main id="app"></main>';
  const initial = snapshot("7444444444444444444", 1_250_000, "这是一段用于验证折叠功能的长描述。".repeat(8));
  transcriptionSegments = [
    { start: 2.2, end: 3.1, text: "Please let it be a boy." },
    { start: 5, end: 8, text: "Congratulations." },
  ];
  translationBatchBodies = [];
  subtitleTranslationRequests = [];
  pauseSubtitleTranslation = false;
  releaseSubtitleTranslation = null;
  subtitleTranslationCancellationsRemaining = 0;
  transcriptionModelRequired = false;
  transcriptionRuntimeBlocked = false;
  backendUnavailable = false;
  downloadBackendUnavailable = false;
  currentMediaUrl = null;
  currentSubtitleUrl = null;
  currentVideoId = initial.video_id!;
  currentMediaGeneration = 1;
  freshPageSubtitleUrl = null;
  freshPageFetchCalls = 0;
  pageContextCaptionAvailable = false;
  pageContextCaptionEnd = 12;
  mediaDescriptorFailuresRemaining = 0;
  browserSpeech.ready = false;
  browserSpeech.pauseMedia = false;
  browserSpeech.releaseMedia = null;
  browserSpeech.readyCheck.mockClear();
  browserSpeech.prepare.mockClear();
  browserSpeech.transcribeStaged.mockClear();
  browserSpeech.transcribeMedia.mockClear();
  translationModelRequired = false;
  whisperInstalled = false;
  argosInstalled = false;
  ruEnInstalled = false;
  failNextModelStatus = false;
  modelStatusErrorId = null;
  modelStatusCalls = 0;
  modelInstallCalls = [];
  sessionStorageState = {};
  localStorageState = {};
  const storageSessionGet = vi.fn(async (keys?: string | string[] | null) => {
    if (typeof keys === "string") return { [keys]: sessionStorageState[keys] };
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, sessionStorageState[key]]));
    }
    return { ...sessionStorageState };
  });
  storageSessionSet = vi.fn(async (values: Record<string, unknown>) => {
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [key, newValue] of Object.entries(values)) {
      changes[key] = { oldValue: sessionStorageState[key], newValue };
      sessionStorageState[key] = newValue;
    }
    storageChangedListener?.(changes, "session");
  });
  const storageLocalGet = vi.fn(async (keys?: string | string[] | null) => {
    if (typeof keys === "string") return { [keys]: localStorageState[keys] };
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, localStorageState[key]]));
    }
    return { ...localStorageState };
  });
  storageLocalSet = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(localStorageState, values);
  });
  tabsSendMessage = vi.fn(async (_tabId: number, message: {
    type?: string;
    request_id?: string;
    file_name?: string;
    transfer_id?: string;
    offset?: number;
    chunk_size?: number;
  }) => {
    if (message.type === "GET_CURRENT_MEDIA_DESCRIPTOR") {
      if (mediaDescriptorFailuresRemaining > 0) {
        mediaDescriptorFailuresRemaining -= 1;
        throw new Error("当前视频媒体信息尚未就绪");
      }
      return {
        ok: true,
        data: {
          video_id: currentVideoId,
          page_url: TAB_URL,
          media_url: currentMediaUrl,
          media_source: "yt_dlp_fallback",
          background_music_url: null,
          music_title: null,
          subtitle_url: currentSubtitleUrl,
          subtitle_language: currentSubtitleUrl ? "eng-US" : null,
          author_unique_id: initial.author.unique_id,
          author_nickname: initial.author.nickname,
          description: initial.description,
          created_at: initial.created_at,
        },
        session_id: "sidepanel-ui-session",
        generation: currentMediaGeneration,
        snapshot_sequence: 1,
      };
    }
    if (message.type === "GET_CURRENT_TIKTOK_CAPTION") {
      return {
        ok: true,
        data: pageContextCaptionAvailable
          ? {
              video_id: currentVideoId,
              language: "eng-US",
              segments: [{
                start: 0,
                end: pageContextCaptionEnd,
                text: "TikTok page-context caption.",
              }],
            }
          : null,
      };
    }
    if (message.type === "GET_BATCH_MEDIA_DESCRIPTORS") {
      return {
        ok: true,
        data: {
          items: [{
            video_id: initial.video_id!,
            page_url: TAB_URL,
            media_url: "https://v16.tiktokcdn.com/video.mp4",
            media_source: "registry_play_url",
            background_music_url: null,
            author_unique_id: initial.author.unique_id,
            author_nickname: initial.author.nickname,
            description: initial.description,
            created_at: initial.created_at,
          }],
          total_available: 1,
          truncated: false,
        },
        session_id: "sidepanel-ui-session",
        generation: 1,
        snapshot_sequence: 1,
      };
    }
    if (message.type === "SAVE_PAGE_MEDIA") {
      return {
        ok: true,
        request_id: message.request_id,
        file_name: message.file_name,
      };
    }
    if (message.type === "FETCH_PAGE_MEDIA_CHUNK") {
      return {
        ok: true,
        transfer_id: message.transfer_id,
        offset: message.offset,
        total_bytes: 3,
        chunk_base64: "AQID",
        done: true,
        content_type: "video/mp4",
      };
    }
    return {
      ok: true,
      data: initial,
      session_id: "sidepanel-ui-session",
      generation: 1,
      snapshot_sequence: 1,
    };
  });
  runtimeSendMessage = vi.fn(async (request: {
    type?: string;
    texts?: string[];
    target_language?: string;
  }) => {
    if (request.type === "TRANSLATE_PUBLIC_TEXT_BATCH") {
      subtitleTranslationRequests.push({
        texts: [...(request.texts ?? [])],
        target_language: request.target_language ?? "zh-CN",
      });
      if (pauseSubtitleTranslation) {
        await new Promise<void>((resolve) => {
          releaseSubtitleTranslation = resolve;
        });
      }
      if (subtitleTranslationCancellationsRemaining > 0) {
        subtitleTranslationCancellationsRemaining -= 1;
        return {
          ok: false,
          error: "已使用更快的翻译通道",
          code: "PROVIDER_UNAVAILABLE",
          diagnostic: "bing_web_cancelled",
        };
      }
      if (translationModelRequired && !argosInstalled) {
        return {
          ok: false,
          error: "在线翻译暂不可用",
          code: "LOCAL_MODEL_REQUIRED",
          required_model_ids: ["argos-ru-en", "argos-en-zh"],
        };
      }
    }
    return {
      ok: true,
      data: {
        items: (request.texts ?? []).map((text) => ({
          source_text: text,
          translated_text: `译文：${text}`,
          detected_source_language: "en",
          target_language: request.target_language ?? "zh-CN",
          cached: false,
          provider: "google_translate_web",
        })),
        provider: "google_first_chain",
        provider_notice: "测试翻译服务",
      },
    };
  });
  downloadsDownload = vi.fn(async () => 73);
  writableWrite = vi.fn(async () => undefined);
  showSaveFilePicker = vi.fn(async () => ({
    createWritable: async () => ({
      write: writableWrite,
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    }),
  }));
  vi.stubGlobal("showSaveFilePicker", showSaveFilePicker);
  const chromeMock = {
    downloads: { download: downloadsDownload },
    tabs: {
      query: vi.fn(async () => [{ id: 17, url: TAB_URL, active: true }]),
      sendMessage: tabsSendMessage,
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    runtime: {
      sendMessage: runtimeSendMessage,
      onMessage: {
        addListener: vi.fn((listener: typeof runtimeListener) => {
          runtimeListener = listener;
        }),
      },
    },
    storage: {
      session: { get: storageSessionGet, set: storageSessionSet },
      local: { get: storageLocalGet, set: storageLocalSet },
      onChanged: {
        addListener: vi.fn((listener: typeof storageChangedListener) => {
          storageChangedListener = listener;
        }),
      },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        (currentSubtitleUrl && url === currentSubtitleUrl) ||
        (freshPageSubtitleUrl && url === freshPageSubtitleUrl)
      ) {
        return new Response(`WEBVTT

00:00:00.220 --> 00:00:02.600
TikTok existing caption.

00:00:02.620 --> 00:00:05.180
No speech model is needed.
`, { status: 200, headers: { "Content-Type": "text/vtt" } });
      }
      if (freshPageSubtitleUrl && url === TAB_URL) {
        freshPageFetchCalls += 1;
        return new Response(`<!doctype html><script
          id="__UNIVERSAL_DATA_FOR_REHYDRATION__"
          type="application/json"
        >${JSON.stringify({
          __DEFAULT_SCOPE__: {
            "webapp.video-detail": {
              itemInfo: {
                itemStruct: {
                  id: initial.video_id,
                  video: {
                    claInfo: { originalLanguageInfo: { language: "eng-US" } },
                    subtitleInfos: [{
                      Format: "webvtt",
                      LanguageCodeName: "eng-US",
                      Url: freshPageSubtitleUrl,
                    }],
                  },
                },
              },
            },
          },
        })}</script>`, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.endsWith("/api/v1/transcriptions")) {
        if (backendUnavailable) throw new TypeError("Failed to fetch");
        lastTranscriptionBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (transcriptionRuntimeBlocked) {
          return new Response(JSON.stringify({
            detail: {
              code: "APPLICATION_CONTROL_BLOCKED",
              message: "Windows 企业应用控制策略阻止了本地 AI 运行库",
              browser_fallback: true,
              policy_blocked: true,
            },
          }), { status: 503, headers: { "Content-Type": "application/json" } });
        }
        if (transcriptionModelRequired && !whisperInstalled) {
          return new Response(JSON.stringify({
            detail: {
              code: "MODEL_REQUIRED",
              model_ids: ["whisper-base"],
              message: "Whisper model is required",
            },
          }), { status: 409, headers: { "Content-Type": "application/json" } });
        }
        const saveFiles = lastTranscriptionBody.save_transcript_files === true;
        return new Response(JSON.stringify({
          video_id: currentVideoId,
          language: "en",
          language_probability: 0.98,
          duration_seconds: 8,
          device_used: "cpu",
          compute_type: "int8",
          fallback_reason: null,
          text: "Please let it be a boy. Congratulations.",
          segments: transcriptionSegments,
          audio_file: null,
          transcript_files: saveFiles
            ? [{
                kind: "transcript_srt",
                file_name: "20260721_fixture_7444444444444444444_title.srt",
                size_bytes: 128,
                download_url: "/api/v1/downloads/files/subtitle-token",
              }]
            : [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/v1/downloads")) {
        if (downloadBackendUnavailable) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({
          video_id: initial.video_id,
          status: "completed",
          errors: [],
          files: [{
            kind: "audio_track",
            file_name: "fixture.m4a",
            size_bytes: 1024,
            download_url: "/api/v1/downloads/files/audio-token",
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/v1/translations/batch")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          texts: string[];
          target_language: string;
        };
        translationBatchBodies.push(body);
        if (translationModelRequired && !argosInstalled) {
          return new Response(JSON.stringify({
            target_language: body.target_language,
            results: body.texts.map((_text, index) => ({
              index,
              ok: false,
              error: "Local translation model is required",
              error_code: "LOCAL_MODEL_REQUIRED",
              required_model_ids: ["argos-ru-en", "argos-en-zh"],
            })),
            succeeded: 0,
            failed: body.texts.length,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          target_language: body.target_language,
          results: body.texts.map((text, index) => ({
            index,
            ok: true,
            translated_text: `译文：${text}`,
            detected_source_language: "en",
            provider: "google_translate_web",
          })),
          succeeded: body.texts.length,
          failed: 0,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (/\/api\/v1\/models\/[^/]+\/install$/.test(url)) {
        const id = decodeURIComponent(url.match(/\/api\/v1\/models\/([^/]+)\/install$/)?.[1] ?? "");
        modelInstallCalls.push(id);
        if (failNextModelStatus) {
          failNextModelStatus = false;
          modelStatusErrorId = id;
          return new Response(JSON.stringify({
            id,
            state: "downloading",
            installed: false,
          }), { status: 202, headers: { "Content-Type": "application/json" } });
        }
        if (modelStatusErrorId === id) modelStatusErrorId = null;
        if (id === "whisper-base") whisperInstalled = true;
        if (id === "argos-en-zh") argosInstalled = true;
        if (id === "argos-ru-en") ruEnInstalled = true;
        return new Response(JSON.stringify({
          id,
          state: "ready",
          installed: true,
        }), { status: 202, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/v1/models")) {
        modelStatusCalls += 1;
        return new Response(JSON.stringify({
          models: [
            {
              id: "whisper-base",
              name: "Whisper Base",
              purpose: "speech_to_text",
              state: modelStatusErrorId === "whisper-base"
                ? "error"
                : whisperInstalled ? "ready" : "not_installed",
              installed: whisperInstalled,
              estimated_size_bytes: 148_000_000,
              downloaded_bytes: whisperInstalled ? 148_000_000 : 0,
              total_bytes: 148_000_000,
              error: modelStatusErrorId === "whisper-base" ? "测试模型状态错误" : null,
            },
            {
              id: "argos-en-zh",
              name: "Argos English to Chinese",
              purpose: "translation",
              state: modelStatusErrorId === "argos-en-zh"
                ? "error"
                : argosInstalled ? "ready" : "not_installed",
              installed: argosInstalled,
              estimated_size_bytes: 259_000_000,
              downloaded_bytes: argosInstalled ? 259_000_000 : 0,
              total_bytes: 259_000_000,
              error: modelStatusErrorId === "argos-en-zh" ? "测试模型状态错误" : null,
            },
            {
              id: "argos-ru-en",
              name: "Argos Russian to English",
              purpose: "translation",
              state: modelStatusErrorId === "argos-ru-en"
                ? "error"
                : ruEnInstalled ? "ready" : "not_installed",
              installed: ruEnInstalled,
              estimated_size_bytes: 56_000_000,
              downloaded_bytes: ruEnInstalled ? 56_000_000 : 0,
              total_bytes: 56_000_000,
              error: modelStatusErrorId === "argos-ru-en" ? "测试模型状态错误" : null,
            },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(
        JSON.stringify({ status: "ok", service: "tiktok-daren-assistant", version: "0.1.28" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });

  await import("../src/sidepanel/index");
  await settle();
});

describe("阶段 1.4 产品级侧边栏", () => {
  it("按顶部状态、数据摘要、视频信息和工具四区呈现，技术信息默认折叠", () => {
    expect(document.querySelector(".product-header")).not.toBeNull();
    expect(document.querySelector(".status-card")).not.toBeNull();
    expect(document.querySelectorAll(".metric-card")).toHaveLength(6);
    expect(document.querySelector(".video-section")).not.toBeNull();
    expect(document.querySelector(".tools-section")).not.toBeNull();

    const details = document.querySelector<HTMLDetailsElement>("#technical-details")!;
    expect(details.open).toBe(false);
    expect(document.querySelectorAll(".metric-card svg")).toHaveLength(6);
    expect(document.querySelector(".status-card")?.textContent).not.toContain(TAB_URL);
  });

  it("突出指标、支持长描述展开，并提供 video_id 复制入口", () => {
    expect(document.querySelector("#play-count")?.textContent).toBe("1.3M");
    expect(document.querySelector("#duration")?.textContent).toBe("1:07");
    expect(document.querySelector<HTMLElement>("#publish-time-text")?.hidden).toBe(true);
    expect(document.querySelector("#publish-time-text")?.textContent).toBe("");
    expect(document.querySelector("#recognition-status")?.textContent).toBe("当前视频已识别");
    expect(document.querySelector("#registry-status")?.textContent).toContain("已命中");

    const toggle = document.querySelector<HTMLButtonElement>("#description-toggle")!;
    expect(toggle.hidden).toBe(false);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("#description")?.classList.contains("is-expanded")).toBe(true);

    const copyButton = document.querySelector<HTMLButtonElement>("#copy-video-id-button")!;
    expect(copyButton.disabled).toBe(false);
    copyButton.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("7444444444444444444");
  });

  it("只保留三个单条入口，并将识别结果按时间戳显示和分批翻译", async () => {
    expect(document.querySelector("#download-video-button")?.textContent).toContain("下载视频");
    expect(document.querySelector("#download-audio-button")?.textContent).toContain("提取音频");
    expect(document.querySelector("#transcribe-button")?.textContent).toContain("字幕和翻译");
    expect(document.querySelector("#download-music-button")).toBeNull();
    expect(document.querySelector("#batch-video-button")?.textContent).toContain("批量下载视频");
    expect(document.querySelector("#batch-audio-button")?.textContent).toContain("批量提取音频");
    expect(document.querySelector<HTMLInputElement>("#subtitle-expert-mode")?.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>("#subtitle-save-files")?.checked).toBe(false);

    const collectCallsBefore = tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "COLLECT_CURRENT_PAGE",
    ).length;
    const descriptorCallsBefore = tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
    ).length;
    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#subtitle-panel")?.hidden).toBe(false);
      expect(document.querySelectorAll(".subtitle-segment")).toHaveLength(2);
      expect(document.querySelectorAll(".subtitle-translation")).toHaveLength(2);
    });
    expect(lastTranscriptionBody?.save_transcript_files).toBe(false);

    expect(document.querySelector(".subtitle-time")?.textContent).toBe("00:02-00:04");
    expect(document.querySelector(".subtitle-original")?.textContent).toBe("Please let it be a boy.");
    expect(document.querySelector(".subtitle-translation")?.textContent).toBe("译文：Please let it be a boy.");
    expect(document.querySelector("#subtitle-translation-status")?.textContent)
      .toContain("Google 在线");
    expect(subtitleTranslationRequests).toContainEqual(expect.objectContaining({
      target_language: "zh-CN",
      texts: ["Please let it be a boy.", "Congratulations."],
    }));
    expect(tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "COLLECT_CURRENT_PAGE",
    )).toHaveLength(collectCallsBefore);
    expect(tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
    )).toHaveLength(descriptorCallsBefore + 1);

    const targetLanguage = document.querySelector<HTMLSelectElement>("#subtitle-target-language")!;
    subtitleTranslationRequests.length = 0;
    targetLanguage.value = "en";
    targetLanguage.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(subtitleTranslationRequests).toContainEqual(expect.objectContaining({
        target_language: "en",
      }));
      expect(document.querySelector(".subtitle-translation")?.textContent).toBe("译文：Please let it be a boy.");
    });
    expect(document.querySelector(".subtitle-original")?.textContent).toBe("Please let it be a boy.");

    const bilingual = document.querySelector<HTMLInputElement>("#subtitle-bilingual")!;
    bilingual.checked = false;
    bilingual.dispatchEvent(new Event("change"));
    expect(document.querySelector<HTMLElement>(".subtitle-original")?.hidden).toBe(true);
  });

  it("字幕默认只在线展示，勾选后才打开一次 SRT 另存为", async () => {
    const saveFiles = document.querySelector<HTMLInputElement>("#subtitle-save-files")!;
    saveFiles.checked = true;
    downloadsDownload.mockClear();

    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();
    await vi.waitFor(() => {
      expect(lastTranscriptionBody?.save_transcript_files).toBe(true);
      expect(downloadsDownload).toHaveBeenCalledTimes(1);
    });
    expect(downloadsDownload).toHaveBeenCalledWith(expect.objectContaining({
      filename: "20260721_fixture_7444444444444444444_title.srt",
      saveAs: true,
    }));
    saveFiles.checked = false;
  });

  it("仅在语音模型确实缺失时询问下载，确认后只安装一次并自动继续字幕", async () => {
    transcriptionSegments = [
      { start: 2.2, end: 3.1, text: "Please let it be a boy." },
      { start: 5, end: 8, text: "Congratulations." },
    ];
    const modelChecksBeforeGoogleSuccess = modelStatusCalls;
    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".subtitle-translation")).toHaveLength(2);
    });
    expect(modelStatusCalls).toBe(modelChecksBeforeGoogleSuccess);

    transcriptionModelRequired = true;
    whisperInstalled = false;
    modelInstallCalls = [];
    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#model-requirement-card")?.hidden).toBe(false);
      expect(document.querySelector("#model-requirement-title")?.textContent)
        .toBe("生成字幕需要语音模型");
    });
    expect(modelInstallCalls).toEqual([]);

    const install = document.querySelector<HTMLButtonElement>("#model-install-button")!;
    install.click();
    install.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#model-requirement-card")?.hidden).toBe(true);
      expect(document.querySelectorAll(".subtitle-translation")).toHaveLength(2);
    });
    expect(modelInstallCalls.filter((id) => id === "whisper-base")).toHaveLength(1);
    transcriptionModelRequired = false;
  });

  it("企业策略阻止原生 DLL 时不再要求修复运行库，确认后自动用 Chrome 兼容模式", async () => {
    transcriptionRuntimeBlocked = true;
    browserSpeech.ready = false;
    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#model-requirement-card")?.hidden).toBe(false);
      expect(document.querySelector("#model-requirement-title")?.textContent)
        .toBe("需要浏览器兼容语音模型");
    });
    expect(browserSpeech.prepare).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>("#model-install-button")!.click();
    await vi.waitFor(() => {
      expect(browserSpeech.prepare).toHaveBeenCalledTimes(1);
      expect(browserSpeech.transcribeStaged).toHaveBeenCalledTimes(1);
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("Browser fallback works.");
    });
    transcriptionRuntimeBlocked = false;
  });

  it("整个后端 EXE 被 Windows 阻止时，字幕直接读取视频并在 Chrome 内识别", async () => {
    backendUnavailable = true;
    currentMediaUrl = "https://v16.tiktokcdn.com/video.mp4";
    browserSpeech.ready = true;
    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();

    await vi.waitFor(() => {
      expect(browserSpeech.transcribeMedia).toHaveBeenCalledWith(
        currentMediaUrl,
        expect.any(Function),
        expect.any(Function),
        undefined,
        undefined,
      );
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("Browser fallback works.");
    });
    expect(browserSpeech.transcribeStaged).not.toHaveBeenCalled();
    backendUnavailable = false;
    currentMediaUrl = null;
  });

  it("uses an existing TikTok caption before checking or loading a speech model", async () => {
    currentMediaUrl = "https://v16.tiktokcdn.com/video.mp4";
    currentSubtitleUrl = "https://v16.tiktokcdn.com/subtitles/current.vtt?token=signed";
    browserSpeech.ready = false;
    browserSpeech.prepare.mockClear();
    browserSpeech.transcribeMedia.mockClear();
    browserSpeech.transcribeStaged.mockClear();

    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();

    await vi.waitFor(() => {
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("TikTok existing caption.");
    });
    expect(browserSpeech.prepare).not.toHaveBeenCalled();
    expect(browserSpeech.transcribeMedia).not.toHaveBeenCalled();
    expect(browserSpeech.transcribeStaged).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>("#model-requirement-card")?.hidden).toBe(true);

    currentSubtitleUrl = null;
    currentMediaUrl = null;
  });

  it("uses the TikTok page-context caption path before every speech fallback", async () => {
    currentMediaUrl = "https://v16.tiktokcdn.com/video.mp4";
    pageContextCaptionAvailable = true;
    browserSpeech.ready = false;
    browserSpeech.readyCheck.mockClear();
    browserSpeech.prepare.mockClear();
    browserSpeech.transcribeMedia.mockClear();

    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();

    await vi.waitFor(() => {
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("TikTok page-context caption.");
    });
    expect(browserSpeech.readyCheck).not.toHaveBeenCalled();
    expect(browserSpeech.prepare).not.toHaveBeenCalled();
    expect(browserSpeech.transcribeMedia).not.toHaveBeenCalled();

    pageContextCaptionAvailable = false;
    currentMediaUrl = null;
  });

  it("uses the content-script page refresh result without downloading the TikTok page twice", async () => {
    currentMediaUrl = "https://v16.tiktokcdn.com/video.mp4";
    currentSubtitleUrl = null;
    freshPageSubtitleUrl =
      "https://v16.tiktokcdn.com/subtitles/fresh-page.vtt?token=fresh";
    pageContextCaptionAvailable = true;
    browserSpeech.ready = false;
    browserSpeech.readyCheck.mockClear();
    browserSpeech.prepare.mockClear();
    browserSpeech.transcribeMedia.mockClear();
    const freshPageFetchCallsBefore = freshPageFetchCalls;

    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();

    await vi.waitFor(() => {
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("TikTok page-context caption.");
    });
    expect(freshPageFetchCalls).toBe(freshPageFetchCallsBefore);
    expect(browserSpeech.readyCheck).not.toHaveBeenCalled();
    expect(browserSpeech.prepare).not.toHaveBeenCalled();
    expect(browserSpeech.transcribeMedia).not.toHaveBeenCalled();

    pageContextCaptionAvailable = false;
    freshPageSubtitleUrl = null;
    currentMediaUrl = null;
  });

  chromeOnlyIt("同事版点击字幕只下载浏览器模型并自动继续，不触发本地安装", async () => {
    currentMediaUrl = "https://v16.tiktokcdn.com/video.mp4";
    browserSpeech.ready = false;
    browserSpeech.prepare.mockClear();
    browserSpeech.transcribeMedia.mockClear();
    modelInstallCalls = [];
    const warmCallsBefore = runtimeSendMessage.mock.calls.filter(
      ([message]) => message.type === "WARM_TRANSLATION_PROVIDER",
    ).length;

    expect(document.documentElement.dataset.tdaRelease).toBe("TDA_CHROME_ONLY_ACTIVE");
    const transcribeButton = document.querySelector<HTMLButtonElement>("#transcribe-button")!;
    await vi.waitFor(() => expect(transcribeButton.disabled).toBe(false));
    transcribeButton.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#model-requirement-card")?.hidden).toBe(false);
      expect(document.querySelector("#model-requirement-title")?.textContent)
        .toBe("需要浏览器兼容语音模型");
      expect(runtimeSendMessage.mock.calls.filter(
        ([message]) => message.type === "WARM_TRANSLATION_PROVIDER",
      )).toHaveLength(warmCallsBefore + 1);
    });

    document.querySelector<HTMLButtonElement>("#model-install-button")!.click();
    await vi.waitFor(() => {
      expect(browserSpeech.prepare).toHaveBeenCalledTimes(1);
    expect(browserSpeech.transcribeMedia).toHaveBeenCalledWith(
      currentMediaUrl,
      expect.any(Function),
      expect.any(Function),
      undefined,
      undefined,
    );
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("Browser fallback works.");
    });
    expect(modelInstallCalls).toEqual([]);
    currentMediaUrl = null;
  });

  it("视频下载先选择保存位置，再通过当前页面读取并写入文件", async () => {
    downloadBackendUnavailable = true;
    currentMediaUrl = "https://v16.tiktokcdn.com/video.mp4";
    const collectCallsBefore = tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "COLLECT_CURRENT_PAGE",
    ).length;
    const descriptorCallsBefore = tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
    ).length;
    document.querySelector<HTMLButtonElement>("#download-video-button")!.click();

    await vi.waitFor(() => {
      expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({
        suggestedName: expect.stringMatching(/^2024-07-20_7444444444444444444_fixture_author_.+\.mp4$/),
      }));
      expect(tabsSendMessage).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          type: "FETCH_PAGE_MEDIA_CHUNK",
          media_url: currentMediaUrl,
          chunk_size: 8 * 1024 * 1024,
        }),
      );
      expect(writableWrite).toHaveBeenCalledWith(expect.any(Uint8Array));
    });
    expect(tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "COLLECT_CURRENT_PAGE",
    )).toHaveLength(collectCallsBefore);
    expect(tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
    )).toHaveLength(descriptorCallsBefore + 1);
    downloadBackendUnavailable = false;
    currentMediaUrl = null;
  });

  it("批量媒体入口直接请求 content 生成描述，不再先重复强制采集", async () => {
    const collectCallsBefore = tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "COLLECT_CURRENT_PAGE",
    ).length;
    const descriptorCallsBefore = tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_BATCH_MEDIA_DESCRIPTORS",
    ).length;
    const batchVideoButton = document.querySelector<HTMLButtonElement>("#batch-video-button")!;
    batchVideoButton.disabled = false;
    batchVideoButton.click();

    await vi.waitFor(() => {
      expect(tabsSendMessage.mock.calls.filter(
        ([, message]) => message.type === "GET_BATCH_MEDIA_DESCRIPTORS",
      )).toHaveLength(descriptorCallsBefore + 1);
    });
    expect(tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "COLLECT_CURRENT_PAGE",
    )).toHaveLength(collectCallsBefore);
  });

  it("在线字幕翻译失败时提供可选离线包，失败可重试且不会重复触发", async () => {
    translationModelRequired = true;
    argosInstalled = false;
    ruEnInstalled = false;
    failNextModelStatus = true;
    modelInstallCalls = [];
    const target = document.querySelector<HTMLSelectElement>("#subtitle-target-language")!;
    target.value = "zh-CN";

    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#model-requirement-card")?.hidden).toBe(false);
      expect(document.querySelector("#model-requirement-title")?.textContent)
        .toBe("在线翻译暂不可用");
      expect(document.querySelectorAll(".subtitle-original")).toHaveLength(2);
    });

    const install = document.querySelector<HTMLButtonElement>("#model-install-button")!;
    install.click();
    install.click();
    await vi.waitFor(() => {
      expect(document.querySelector("#model-progress-text")?.textContent).toContain("下载失败");
      expect(install.disabled).toBe(false);
    });
    expect(modelInstallCalls.filter((id) => id === "argos-en-zh")).toHaveLength(1);
    expect(modelInstallCalls.filter((id) => id === "argos-ru-en")).toHaveLength(1);

    install.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#model-requirement-card")?.hidden).toBe(true);
      expect(document.querySelectorAll(".subtitle-translation")).toHaveLength(2);
    });
    expect(modelInstallCalls.filter((id) => id === "argos-en-zh")).toHaveLength(1);
    expect(modelInstallCalls.filter((id) => id === "argos-ru-en")).toHaveLength(2);
    translationModelRequired = false;
  });

  it("消费评论前景队列，并把本机批量翻译结果交还给原标签页", async () => {
    translationBatchBodies.length = 0;
    const requestId = "translation-job-0001";
    await storageSessionSet({
      pendingForegroundTranslations: [{
        request_id: requestId,
        tab_id: 17,
        requested_at: Date.now(),
        request: {
          type: "TRANSLATE_PUBLIC_TEXT",
          text: "Queued public comment",
          target_language: "zh-CN",
        },
      }],
      foregroundTranslationResults: [],
    });

    await vi.waitFor(() => {
      const results = sessionStorageState.foregroundTranslationResults as Array<{
        request_id: string;
        response: {
          ok: boolean;
          data?: { items?: Array<{ translated_text?: string; provider?: string }> };
        };
      }>;
      expect(results).toHaveLength(1);
      expect(results[0]?.request_id).toBe(requestId);
      expect(results[0]?.response.data?.items?.[0]?.translated_text)
        .toBe("译文：Queued public comment");
      expect(results[0]?.response.data?.items?.[0]?.provider)
        .toBe("google_translate_web");
    });
    expect(sessionStorageState.pendingForegroundTranslations).toEqual([]);
    expect(translationBatchBodies).toContainEqual({
      texts: ["Queued public comment"],
      target_language: "zh-CN",
    });
  });

  it("61 句字幕在后端上限内一次翻译，刷新后清空旧字幕", async () => {
    transcriptionSegments = Array.from({ length: 61 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 1,
      text: `Subtitle sentence ${index + 1}`,
    }));
    subtitleTranslationRequests.length = 0;
    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();
    await vi.waitFor(() => {
      expect(subtitleTranslationRequests).toHaveLength(1);
      expect(document.querySelectorAll(".subtitle-segment")).toHaveLength(61);
    });
    expect(subtitleTranslationRequests.map((request) => request.texts.length)).toEqual([61]);

    document.querySelector<HTMLButtonElement>("#refresh-button")!.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#subtitle-panel")?.hidden).toBe(true);
      expect(document.querySelectorAll(".subtitle-segment")).toHaveLength(0);
    });
  });

  it("打开原始数据时才展开技术区域，旧 generation 不能覆盖新视频", async () => {
    const rawButton = document.querySelector<HTMLButtonElement>("#raw-button")!;
    rawButton.click();
    expect(document.querySelector<HTMLDetailsElement>("#technical-details")?.open).toBe(true);
    expect(document.querySelector<HTMLElement>("#raw-card")?.hidden).toBe(false);

    expect(runtimeListener).not.toBeNull();
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot("7555555555555555555", 93_600),
        session_id: "sidepanel-ui-session",
        generation: 2,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await settle();
    expect(document.querySelector("#video-id")?.textContent).toBe("7555555555555555555");
    expect(document.querySelector("#play-count")?.textContent).toBe("93.6K");

    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot("7444444444444444444", 9_999_999),
        session_id: "sidepanel-ui-session",
        generation: 1,
        snapshot_sequence: 99,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await settle();
    expect(document.querySelector("#video-id")?.textContent).toBe("7555555555555555555");
    expect(document.querySelector("#play-count")?.textContent).toBe("93.6K");
  });

  it("图文与明确广告标记使用准确中文状态，不再统称单视频", async () => {
    const photo = snapshot("7666666666666666666", 131_800, "图文帖子");
    photo.raw_data = {
      surface_mode: "video_detail",
      registry_match: photo.video_id,
      content_type: "photo",
      is_ad: true,
      has_product: true,
    };
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: photo,
        session_id: "sidepanel-ui-session",
        generation: 3,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await settle();

    expect(document.querySelector("#page-type")?.textContent).toBe(
      "图文详情页 · 广告/推广标记 · 商品/带货锚点",
    );
    expect(document.querySelector("#recognition-status")?.textContent).toBe("当前图文已识别");
  });

  it("自动字幕可分开控制翻译，切换视频后继续，关闭后立即停止新任务", async () => {
    const autoEnabled = document.querySelector<HTMLInputElement>("#subtitle-auto-enabled")!;
    const autoTranslate = document.querySelector<HTMLInputElement>("#subtitle-auto-translate")!;
    const saveFiles = document.querySelector<HTMLInputElement>("#subtitle-save-files")!;
    expect(autoEnabled.checked).toBe(false);
    expect(autoTranslate.checked).toBe(false);
    expect(autoTranslate.disabled).toBe(true);
    expect(autoEnabled.closest(".download-actions")).toBeNull();
    expect(autoEnabled.closest(".download-block")).not.toBeNull();

    pageContextCaptionAvailable = true;
    currentVideoId = "7777777777777777777";
    currentMediaGeneration = 4;
    subtitleTranslationRequests.length = 0;
    downloadsDownload.mockClear();
    saveFiles.checked = true;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 321_000),
        session_id: "sidepanel-ui-session",
        generation: 4,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await settle();

    autoEnabled.checked = true;
    autoEnabled.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("TikTok page-context caption.");
    });
    expect(document.querySelectorAll(".subtitle-translation")).toHaveLength(0);
    expect(subtitleTranslationRequests).toHaveLength(0);
    expect(downloadsDownload).not.toHaveBeenCalled();
    expect(autoTranslate.disabled).toBe(false);

    autoTranslate.checked = true;
    autoTranslate.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".subtitle-translation")).toHaveLength(1);
    });
    expect(localStorageState.autoSubtitleSettingsV1).toEqual({
      enabled: true,
      translate: true,
    });
    await vi.waitFor(() => {
      expect(sessionStorageState.autoSubtitleSessionCacheV1).toEqual(expect.objectContaining({
        version: 1,
        entries: expect.arrayContaining([
          expect.objectContaining({ video_id: currentVideoId }),
        ]),
      }));
    });

    const descriptorCallsBeforeSwitch = tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
    ).length;
    currentVideoId = "7888888888888888888";
    currentMediaGeneration = 5;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 654_000),
        session_id: "sidepanel-ui-session",
        generation: 5,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await vi.waitFor(() => {
      expect(tabsSendMessage.mock.calls.filter(
        ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
      ).length).toBeGreaterThan(descriptorCallsBeforeSwitch);
      expect(document.querySelectorAll(".subtitle-translation")).toHaveLength(1);
    });

    const captionCallsBeforeReturn = tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_TIKTOK_CAPTION",
    ).length;
    currentVideoId = "7777777777777777777";
    currentMediaGeneration = 6;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 321_000),
        session_id: "sidepanel-ui-session",
        generation: 6,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await vi.waitFor(() => {
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("TikTok page-context caption.");
      expect(document.querySelectorAll(".subtitle-translation")).toHaveLength(1);
    });
    expect(tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_TIKTOK_CAPTION",
    )).toHaveLength(captionCallsBeforeReturn);

    autoEnabled.checked = false;
    autoEnabled.dispatchEvent(new Event("change"));
    const descriptorCallsAfterStop = tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
    ).length;
    currentVideoId = "7999999999999999999";
    currentMediaGeneration = 7;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 987_000),
        session_id: "sidepanel-ui-session",
        generation: 7,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
    )).toHaveLength(descriptorCallsAfterStop);
    expect(localStorageState.autoSubtitleSettingsV1).toEqual({
      enabled: false,
      translate: true,
    });

    saveFiles.checked = false;
    pageContextCaptionAvailable = false;
  });

  chromeOnlyIt("同一视频更新不会在翻译中重复启动并取消当前字幕", async () => {
    const autoEnabled = document.querySelector<HTMLInputElement>("#subtitle-auto-enabled")!;
    const autoTranslate = document.querySelector<HTMLInputElement>("#subtitle-auto-translate")!;
    runtimeSendMessage.mockClear();
    subtitleTranslationRequests.length = 0;
    pauseSubtitleTranslation = true;
    releaseSubtitleTranslation = null;
    pageContextCaptionAvailable = true;
    currentVideoId = "7999999999999999998";
    currentMediaGeneration = 8;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 988_000),
        session_id: "sidepanel-ui-session",
        generation: 8,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await settle();

    autoEnabled.checked = true;
    autoEnabled.dispatchEvent(new Event("change"));
    autoTranslate.checked = true;
    autoTranslate.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(subtitleTranslationRequests).toHaveLength(1);
      expect(releaseSubtitleTranslation).toEqual(expect.any(Function));
    }, { timeout: 2_500 });

    const cancelledBeforeRefresh = runtimeSendMessage.mock.calls.filter(
      ([message]) => message.type === "CANCEL_TRANSLATION_TASK",
    ).length;
    currentMediaGeneration = 9;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 989_000),
        session_id: "sidepanel-ui-session",
        generation: 9,
        snapshot_sequence: 2,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(subtitleTranslationRequests).toHaveLength(1);
    expect(runtimeSendMessage.mock.calls.filter(
      ([message]) => message.type === "CANCEL_TRANSLATION_TASK",
    )).toHaveLength(cancelledBeforeRefresh);

    pauseSubtitleTranslation = false;
    (releaseSubtitleTranslation as null | (() => void))?.();
    releaseSubtitleTranslation = null;
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".subtitle-translation")).toHaveLength(1);
      expect(document.querySelector("#subtitle-translation-status")?.textContent)
        .not.toContain("cancelled");
    }, { timeout: 2_500 });

    autoEnabled.checked = false;
    autoEnabled.dispatchEvent(new Event("change"));
    pageContextCaptionAvailable = false;
  });

  chromeOnlyIt("当前视频偶发收到取消响应时自动续接一次而不是显示翻译失败", async () => {
    runtimeSendMessage.mockClear();
    subtitleTranslationRequests.length = 0;
    subtitleTranslationCancellationsRemaining = 1;
    pageContextCaptionAvailable = true;
    currentVideoId = "7999999999999999997";
    currentMediaGeneration = 10;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 990_000),
        session_id: "sidepanel-ui-session",
        generation: 10,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await settle();

    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();
    await vi.waitFor(() => {
      expect(subtitleTranslationRequests).toHaveLength(2);
      expect(document.querySelectorAll(".subtitle-translation")).toHaveLength(1);
      expect(document.querySelector("#subtitle-translation-status")?.textContent)
        .not.toContain("翻译失败");
    }, { timeout: 2_500 });

    expect(subtitleTranslationCancellationsRemaining).toBe(0);
    pageContextCaptionAvailable = false;
  });

  it("自动字幕遇到当前视频信息尚未就绪时会补做，不会第一次失败后永远漏掉", async () => {
    const autoEnabled = document.querySelector<HTMLInputElement>("#subtitle-auto-enabled")!;
    pageContextCaptionAvailable = true;
    mediaDescriptorFailuresRemaining = 1;
    currentVideoId = "8000000000000000001";
    currentMediaGeneration = 8;
    const descriptorCallsBefore = tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
    ).length;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 111_000),
        session_id: "sidepanel-ui-session",
        generation: 8,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await settle();

    autoEnabled.checked = true;
    autoEnabled.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("TikTok page-context caption.");
      expect(tabsSendMessage.mock.calls.filter(
        ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
      ).length).toBeGreaterThanOrEqual(descriptorCallsBefore + 2);
    }, { timeout: 2_500 });

    autoEnabled.checked = false;
    autoEnabled.dispatchEvent(new Event("change"));
    pageContextCaptionAvailable = false;
  });

  it("长视频只返回一秒临时字幕时不当成完整结果，继续走完整识别", async () => {
    currentVideoId = "8000000000000000002";
    currentMediaGeneration = 9;
    pageContextCaptionAvailable = true;
    pageContextCaptionEnd = 1;
    transcriptionSegments = [
      { start: 2.2, end: 3.1, text: "Please let it be a boy." },
      { start: 5, end: 8, text: "Congratulations." },
    ];
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 222_000),
        session_id: "sidepanel-ui-session",
        generation: 9,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await settle();

    document.querySelector<HTMLButtonElement>("#transcribe-button")!.click();
    await vi.waitFor(() => {
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("Please let it be a boy.");
    });
    expect(document.querySelector(".subtitle-original")?.textContent)
      .not.toBe("TikTok page-context caption.");
    pageContextCaptionAvailable = false;
    pageContextCaptionEnd = 12;
  });

  chromeOnlyIt("旧视频正在语音识别时，新视频有现成字幕也能立即显示且不会被旧结果覆盖", async () => {
    const autoEnabled = document.querySelector<HTMLInputElement>("#subtitle-auto-enabled")!;
    browserSpeech.ready = true;
    browserSpeech.pauseMedia = true;
    browserSpeech.releaseMedia = null;
    currentMediaUrl = "https://v16.tiktokcdn.com/slow-old-video.mp4";
    pageContextCaptionAvailable = false;
    currentVideoId = "8000000000000000010";
    currentMediaGeneration = 10;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 333_000),
        session_id: "sidepanel-ui-session",
        generation: 10,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await settle();
    autoEnabled.checked = true;
    autoEnabled.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(browserSpeech.transcribeMedia).toHaveBeenCalled();
      expect(browserSpeech.releaseMedia).toEqual(expect.any(Function));
    }, { timeout: 2_500 });

    pageContextCaptionAvailable = true;
    currentVideoId = "8000000000000000011";
    currentMediaGeneration = 11;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 444_000),
        session_id: "sidepanel-ui-session",
        generation: 11,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await vi.waitFor(() => {
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("TikTok page-context caption.");
    }, { timeout: 2_500 });

    browserSpeech.pauseMedia = false;
    (browserSpeech.releaseMedia as null | (() => void))?.();
    browserSpeech.releaseMedia = null;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(document.querySelector(".subtitle-original")?.textContent)
      .toBe("TikTok page-context caption.");

    autoEnabled.checked = false;
    autoEnabled.dispatchEvent(new Event("change"));
    currentMediaUrl = null;
    pageContextCaptionAvailable = false;
  });

  chromeOnlyIt("语音识别中途关闭自动字幕后，旧结果不会再显示或重新启动", async () => {
    const autoEnabled = document.querySelector<HTMLInputElement>("#subtitle-auto-enabled")!;
    browserSpeech.ready = true;
    browserSpeech.pauseMedia = true;
    browserSpeech.releaseMedia = null;
    currentMediaUrl = "https://v16.tiktokcdn.com/cancelled-video.mp4";
    pageContextCaptionAvailable = false;
    currentVideoId = "8000000000000000020";
    currentMediaGeneration = 12;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 555_000),
        session_id: "sidepanel-ui-session",
        generation: 12,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await settle();
    autoEnabled.checked = true;
    autoEnabled.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(browserSpeech.releaseMedia).toEqual(expect.any(Function));
    }, { timeout: 2_500 });

    autoEnabled.checked = false;
    autoEnabled.dispatchEvent(new Event("change"));
    expect(runtimeSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "CANCEL_TRANSLATION_TASK",
      task_id: expect.stringMatching(/^subtitle-/),
    }));
    browserSpeech.pauseMedia = false;
    (browserSpeech.releaseMedia as null | (() => void))?.();
    browserSpeech.releaseMedia = null;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(document.querySelector("#subtitle-auto-status")?.textContent)
      .toContain("已关闭");
    expect(document.querySelector(".subtitle-original")).toBeNull();
    currentMediaUrl = null;
  });

  chromeOnlyIt("连续两条都需要语音模型时只保留最新一条排队，不会高频重复请求", async () => {
    const autoEnabled = document.querySelector<HTMLInputElement>("#subtitle-auto-enabled")!;
    browserSpeech.ready = true;
    browserSpeech.pauseMedia = true;
    browserSpeech.releaseMedia = null;
    pageContextCaptionAvailable = false;
    currentMediaUrl = "https://v16.tiktokcdn.com/queued-old-video.mp4";
    currentVideoId = "8000000000000000030";
    currentMediaGeneration = 13;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 666_000),
        session_id: "sidepanel-ui-session",
        generation: 13,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await settle();
    autoEnabled.checked = true;
    autoEnabled.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      expect(browserSpeech.releaseMedia).toEqual(expect.any(Function));
    }, { timeout: 2_500 });

    currentMediaUrl = "https://v16.tiktokcdn.com/queued-current-video.mp4";
    currentVideoId = "8000000000000000031";
    currentMediaGeneration = 14;
    runtimeListener?.(
      {
        type: "PAGE_DATA_UPDATED",
        data: snapshot(currentVideoId, 777_000),
        session_id: "sidepanel-ui-session",
        generation: 14,
        snapshot_sequence: 1,
      },
      { tab: { id: 17, url: TAB_URL } } as chrome.runtime.MessageSender,
    );
    await vi.waitFor(() => {
      expect(document.querySelector("#subtitle-auto-status")?.textContent)
        .toContain("等待上一条语音识别退出");
    }, { timeout: 2_500 });
    const descriptorCallsWhileQueued = tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(tabsSendMessage.mock.calls.filter(
      ([, message]) => message.type === "GET_CURRENT_MEDIA_DESCRIPTOR",
    )).toHaveLength(descriptorCallsWhileQueued);

    browserSpeech.pauseMedia = false;
    (browserSpeech.releaseMedia as null | (() => void))?.();
    browserSpeech.releaseMedia = null;
    await vi.waitFor(() => {
      expect(browserSpeech.transcribeMedia.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(document.querySelector(".subtitle-original")?.textContent)
        .toBe("Browser fallback works.");
    }, { timeout: 3_000 });

    autoEnabled.checked = false;
    autoEnabled.dispatchEvent(new Event("change"));
    currentMediaUrl = null;
  });
});
