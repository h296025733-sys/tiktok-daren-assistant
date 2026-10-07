import type { ContainerStructureExport, DiagnosticInfo, Snapshot } from "./snapshot";

export type ContentRequest =
  | { type: "COLLECT_CURRENT_PAGE"; force?: boolean }
  | { type: "GET_DIAGNOSTICS" }
  | { type: "GET_PAGE_EVIDENCE" }
  | { type: "GET_CONTAINER_SUMMARY" }
  | { type: "GET_CURRENT_MEDIA_DESCRIPTOR" }
  | { type: "GET_CURRENT_TIKTOK_CAPTION"; video_id: string }
  | { type: "GET_BATCH_MEDIA_DESCRIPTORS" }
  | {
      type: "FETCH_PAGE_MEDIA_CHUNK";
      transfer_id: string;
      media_url: string;
      offset: number;
      chunk_size: number;
    }
  | {
      type: "SAVE_PAGE_MEDIA";
      request_id: string;
      media_url: string;
      file_name: string;
    }
  | KnownAdVideoIdsSyncMessage;

export interface ReportKnownAdVideoRequest {
  type: "REPORT_KNOWN_AD_VIDEO";
  video_ids: string[];
}

export interface GetKnownAdVideoIdsRequest {
  type: "GET_KNOWN_AD_VIDEO_IDS";
}

export interface KnownAdVideoIdsSyncMessage {
  type: "KNOWN_AD_VIDEO_IDS_SYNC";
  video_ids: string[];
}

export type KnownAdVideoIdsResponse =
  | { ok: true; video_ids: string[] }
  | { ok: false; error: string };

export type PageMediaChunkResponse =
  | {
      ok: true;
      transfer_id: string;
      offset: number;
      total_bytes: number;
      chunk_base64: string;
      done: boolean;
      content_type: string | null;
    }
  | { ok: false; transfer_id: string; error: string; status?: number };

export type PageMediaSaveResponse =
  | { ok: true; request_id: string; file_name: string }
  | { ok: false; request_id: string; error: string; status?: number };

export type CardMediaDownloadMode = "video" | "audio_track";

export interface CardMediaDownloadRequest {
  type: "DOWNLOAD_CARD_MEDIA";
  mode: CardMediaDownloadMode;
  media: CurrentMediaDescriptor;
}

export type CardMediaDownloadResponse =
  | { ok: true; request_id: string }
  | { ok: false; error: string };

export interface ProfileBatchDownloadRequest {
  type: "DOWNLOAD_PROFILE_BATCH";
  request_id: string;
  items: BatchMediaDescriptor[];
}

export type ProfileBatchDownloadResponse =
  | { ok: true; request_id: string; download_id: number; succeeded: number; failed: number }
  | { ok: false; error: string };

export interface ProfileBatchProgressMessage {
  type: "PROFILE_BATCH_PROGRESS";
  request_id: string;
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
}

export interface QueuedCardMediaDownload {
  request_id: string;
  tab_id: number;
  requested_at: number;
  mode: CardMediaDownloadMode;
  media: CurrentMediaDescriptor;
}

export type ForegroundTranslationDiagnosticCode =
  | "fg_prepare_opened"
  | "fg_prepare_unconfirmed"
  | "fg_queue_enqueued"
  | "fg_queue_panel_unconfirmed"
  | "fg_queue_pending"
  | "fg_queue_completed"
  | "fg_queue_invalid"
  | "fg_queue_message_failed"
  | "fg_queue_timeout";

export type ContentResponse =
  | {
      ok: true;
      data: Snapshot;
      generation: number;
      snapshot_sequence: number;
      session_id: string;
    }
  | { ok: false; error: string };

export type DiagnosticResponse =
  | { ok: true; data: DiagnosticInfo }
  | { ok: false; error: string };

export type PageEvidenceResponse = DiagnosticResponse;

export type ContainerSummaryResponse =
  | { ok: true; data: ContainerStructureExport }
  | { ok: false; error: string };

export interface CurrentMediaDescriptor {
  video_id: string;
  page_url: string;
  media_url: string | null;
  media_source: "registry_play_url" | "active_video_src" | "yt_dlp_fallback";
  background_music_url: string | null;
  music_title: string | null;
  subtitle_url?: string | null;
  subtitle_language?: string | null;
  author_unique_id: string | null;
  author_nickname: string | null;
  description: string | null;
  created_at: number | null;
}

export type MediaDescriptorResponse =
  | {
      ok: true;
      data: CurrentMediaDescriptor;
      generation: number;
      snapshot_sequence: number;
      session_id: string;
    }
  | { ok: false; error: string };

export interface TikTokCaptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface CurrentTikTokCaption {
  video_id: string;
  language: string | null;
  segments: TikTokCaptionSegment[];
}

export type CurrentTikTokCaptionResponse =
  | { ok: true; data: CurrentTikTokCaption | null }
  | { ok: false; error: string };

export interface BatchMediaDescriptor {
  video_id: string;
  page_url: string;
  media_url: string | null;
  media_source: "registry_play_url" | "yt_dlp_fallback";
  background_music_url: string | null;
  author_unique_id: string | null;
  author_nickname: string | null;
  description: string | null;
  created_at: number | null;
}

export type BatchMediaDescriptorsResponse =
  | {
      ok: true;
      data: {
        items: BatchMediaDescriptor[];
        total_available: number;
        truncated: boolean;
      };
      generation: number;
      snapshot_sequence: number;
      session_id: string;
    }
  | { ok: false; error: string };

export type PageUpdateMessage =
  | {
      type: "PAGE_DATA_UPDATED";
      data: Snapshot;
      generation: number;
      snapshot_sequence: number;
      session_id: string;
    }
  | {
      type: "PAGE_INVALIDATED";
      url: string;
      generation: number;
      snapshot_sequence: number;
      session_id: string;
    };

export const TRANSLATION_TARGET_LANGUAGE = "zh-CN" as const;

export const SUPPORTED_TRANSLATION_TARGET_LANGUAGES = [
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "pt",
  "ru",
  "ar",
  "th",
  "vi",
  "id",
] as const;

export type TranslationTargetLanguage =
  (typeof SUPPORTED_TRANSLATION_TARGET_LANGUAGES)[number];

/**
 * standard 现在可直接使用；deepseek_expert 仅预留契约，未配置密钥且不会发起请求。
 */
export type TranslationProviderMode = "standard" | "deepseek_expert";

export type TranslationRequest =
  | {
      type: "TRANSLATE_PUBLIC_TEXT";
      text: string;
      target_language?: TranslationTargetLanguage;
      provider?: TranslationProviderMode;
      /** Internal request identity used only to cancel stale subtitle work. */
      translation_task_id?: string;
    }
  | {
      type: "TRANSLATE_PUBLIC_TEXT_BATCH";
      texts: string[];
      target_language?: TranslationTargetLanguage;
      provider?: TranslationProviderMode;
      /** Internal request identity used only to cancel stale subtitle work. */
      translation_task_id?: string;
    };

export interface WarmTranslationProviderRequest {
  type: "WARM_TRANSLATION_PROVIDER";
}

export type WarmTranslationProviderResponse =
  | { ok: true }
  | { ok: false; error: string };

export interface CancelTranslationTaskRequest {
  type: "CANCEL_TRANSLATION_TASK";
  task_id: string;
}

export interface CancelTranslationTaskResponse {
  ok: true;
  cancelled_requests: number;
}

export interface QueuedForegroundTranslation {
  request_id: string;
  tab_id: number;
  requested_at: number;
  request: TranslationRequest;
}

export interface ForegroundTranslationJobResult {
  request_id: string;
  tab_id: number;
  updated_at: number;
  response: TranslationResponse;
}

export interface PrepareForegroundTranslationRequest {
  type: "PREPARE_FOREGROUND_TRANSLATION";
}

export type PrepareForegroundTranslationResponse =
  | { ok: true; diagnostic: ForegroundTranslationDiagnosticCode }
  | { ok: false; error: string; diagnostic: ForegroundTranslationDiagnosticCode };

export interface QueueForegroundTranslationRequest {
  type: "QUEUE_FOREGROUND_TRANSLATION";
  request: TranslationRequest;
}

export type QueueForegroundTranslationResponse =
  | {
      ok: true;
      request_id: string;
      diagnostic: ForegroundTranslationDiagnosticCode;
    }
  | {
      ok: false;
      error: string;
      diagnostic: ForegroundTranslationDiagnosticCode;
    };

export interface PollForegroundTranslationRequest {
  type: "GET_FOREGROUND_TRANSLATION_RESULT";
  request_id: string;
}

export type PollForegroundTranslationResponse =
  | {
      ok: true;
      status: "pending";
      diagnostic: ForegroundTranslationDiagnosticCode;
    }
  | {
      ok: true;
      status: "completed";
      response: TranslationResponse;
      diagnostic: ForegroundTranslationDiagnosticCode;
    }
  | {
      ok: false;
      error: string;
      diagnostic: ForegroundTranslationDiagnosticCode;
    };

export type TranslationItemProvider =
  | "google_translate_web"
  | "bing_translate_web"
  | "argos_local";

export const LOCAL_MODEL_IDS = ["whisper-base", "argos-en-zh", "argos-ru-en"] as const;
export type LocalModelId = (typeof LOCAL_MODEL_IDS)[number];

export interface LocalModelStatus {
  id: LocalModelId;
  name: string;
  purpose: string;
  state: string;
  installed: boolean;
  estimated_size_bytes: number;
  downloaded_bytes: number;
  total_bytes: number | null;
  error: string | null;
}

export interface LocalModelsResponse {
  models: LocalModelStatus[];
}

export interface TranslationResultItem {
  source_text: string;
  translated_text: string;
  detected_source_language: string | null;
  target_language: TranslationTargetLanguage;
  cached: boolean;
  /** 实际完成这一条译文的通道；旧缓存/旧后端可暂时不提供。 */
  provider?: TranslationItemProvider;
}

export interface TranslationSuccessResponse {
  ok: true;
  data: {
    items: TranslationResultItem[];
    provider: "google_first_chain" | "local_foreground" | "deepseek_expert";
    provider_notice: string;
  };
}

export interface TranslationErrorResponse {
  ok: false;
  error: string;
  code:
    | "INVALID_REQUEST"
    | "TEXT_TOO_LONG"
    | "BATCH_TOO_LARGE"
    | "REQUEST_TIMEOUT"
    | "PROVIDER_UNAVAILABLE"
    | "LOCAL_MODEL_REQUIRED"
    | "PROVIDER_NOT_CONFIGURED"
    | "INVALID_PROVIDER_RESPONSE";
  /** 仅在在线翻译失败且存在可安装的离线回退时返回。 */
  required_model_ids?: LocalModelId[];
  /** 用户再次点击后才会打开，不会由扩展自动导航。 */
  fallback_url?: string;
  /** 仅写入开发者控制台的脱敏诊断，不包含待翻译文本。 */
  diagnostic?: string;
}

export type TranslationResponse = TranslationSuccessResponse | TranslationErrorResponse;
