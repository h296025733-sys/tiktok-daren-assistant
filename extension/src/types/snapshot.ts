export type PageType =
  | "home_feed"
  | "video_detail"
  | "profile"
  | "search"
  | "hashtag"
  | "music"
  | "other";
export type Confidence = "high" | "medium" | "low";

export type SurfaceMode =
  | "home_feed"
  | "video_detail"
  | "profile_grid"
  | "search_grid"
  | "hashtag_grid"
  | "music_grid"
  | "other";

export interface FieldEvidence<T = unknown> {
  value: T | null;
  source: string;
  confidence: Confidence;
  raw_value: unknown;
}

export interface Snapshot {
  page_type: PageType;
  page_url: string;
  video_id: string | null;
  author: {
    nickname: string | null;
    unique_id: string | null;
  };
  description: string | null;
  created_at: number | null;
  publish_time_text: string | null;
  duration_seconds: number | null;
  metrics: {
    play_count: number | null;
    like_count: number | null;
    comment_count: number | null;
    collect_count: number | null;
    share_count: number | null;
  };
  extraction: {
    source: string;
    confidence: Confidence;
  };
  field_evidence: Record<string, FieldEvidence>;
  raw_data: Record<string, unknown>;
}

export interface SavedSnapshot extends Snapshot {
  id: number;
  saved_at: string;
}

export interface ActiveVideoDiagnostic {
  visible_ratio: number | null;
  candidate_count: number;
  active_root: string | null;
  active_identity: string | null;
  switch_count: number;
  changed: boolean;
}

export interface DiagnosticContextRoots {
  active_root: string | null;
  page_root: string | null;
  media_root: string | null;
  metadata_root: string | null;
  action_root: string | null;
  card_root: string | null;
}

export interface DiagnosticContext {
  video_id_source: string | null;
  video_id_conflict: Record<string, string> | null;
  active_identity: string | null;
  candidate_count: number;
  card_count: number;
  hovered_card_video_id: string | null;
  video_link_pathname: string | null;
  roots: DiagnosticContextRoots;
}

export interface RegistryDiagnosticStats {
  size: number;
  max_entries: number;
  ttl_ms: number;
  upsert_count: number;
  deduplicated_count: number;
  evicted_count: number;
  expired_count: number;
}

export interface RegistryDiagnostic {
  stats: RegistryDiagnosticStats;
  matched_video_id: string | null;
  /** 只允许归一化后的公开字段及其来源证据，不得包含 Cookie、Token 或请求头。 */
  matched_item: Record<string, unknown> | null;
}

export interface HydrationDiagnostic {
  scanned_script_count: number;
  parsed_script_count: number;
  normalized_item_count: number;
  matched_video_ids: string[];
  truncated: boolean;
  script_ids: string[];
  matched_current_video: boolean;
}

export interface NetworkDiagnostic {
  normalized_item_count: number;
  matched_video_ids: string[];
  recent_pathnames: string[];
  accepted_event_count: number;
  rejected_event_count: number;
  matched_current_video: boolean;
}

export interface RejectedPlayCountCandidate {
  source: string;
  raw_value: string | null;
  reason: string;
}

export interface DiagnosticInfo {
  content_session_id: string;
  generation: number;
  snapshot_sequence: number;
  page_url: string;
  page_type: PageType;
  video_id: string | null;
  active_video: ActiveVideoDiagnostic;
  fields: Record<string, FieldEvidence>;
  from_structured_json: boolean;
  /** 阶段 1.2 的脱敏采集证据；兼容阶段 1.1 内容脚本时允许暂缺。 */
  surface_mode?: SurfaceMode;
  context?: DiagnosticContext;
  registry?: RegistryDiagnostic;
  hydration?: HydrationDiagnostic;
  network?: NetworkDiagnostic;
  rejected_play_count_candidates?: RejectedPlayCountCandidate[];
  last_updated_at: string;
  extension_version: string;
}

export interface ContainerStructureNode {
  tag: string;
  data_e2e: string | null;
  aria_label: string | null;
  role: string | null;
  href_pathname: string | null;
  text_length: number;
  text_summary: string | null;
  children: ContainerStructureNode[];
}

export interface ContainerStructureSummary {
  nodes: ContainerStructureNode[];
  node_count: number;
  truncated: boolean;
}

/** 有限、脱敏的当前上下文容器摘要，不包含完整 DOM、查询参数或页面存储。 */
export interface ContainerStructureExport {
  content_session_id: string;
  generation: number;
  snapshot_sequence: number;
  page_url: string;
  page_type: PageType;
  surface_mode: SurfaceMode;
  video_id: string | null;
  roots: Record<string, ContainerStructureSummary>;
  last_updated_at: string;
  extension_version: string;
}
