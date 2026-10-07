import type { MetricUnitMode } from "./formatter";

export const overlayFieldOrder = [
  "play_count",
  "like_count",
  "comment_count",
  "collect_count",
  "share_count",
  "duration_seconds",
  "publish_time",
] as const;

export type OverlayField = (typeof overlayFieldOrder)[number];
export type OverlayPosition = "auto" | "left" | "right" | "inside";
export type OverlayDefaultState = "compact" | "collapsed";
export type OverlayUnit = Exclude<MetricUnitMode, "full">;

export const overlayFieldLabels: Record<OverlayField, string> = {
  play_count: "播放",
  like_count: "点赞",
  comment_count: "评论",
  collect_count: "收藏",
  share_count: "分享",
  duration_seconds: "时长",
  publish_time: "发布时间",
};

export interface OverlaySettings {
  visibleFields: Record<OverlayField, boolean>;
  unit: OverlayUnit;
  position: OverlayPosition;
  /** 新页面/重置时采用的默认状态。 */
  defaultState: OverlayDefaultState;
  /** 当前折叠状态，单独持久化，刷新页面后保持用户上次选择。 */
  collapsed: boolean;
  autoUpdate: boolean;
}

export type OverlaySettingsPatch = Partial<Omit<OverlaySettings, "visibleFields">> & {
  visibleFields?: Partial<Record<OverlayField, boolean>>;
};

export const DEFAULT_OVERLAY_SETTINGS: Readonly<OverlaySettings> = Object.freeze({
  visibleFields: Object.freeze({
    play_count: true,
    like_count: true,
    comment_count: true,
    collect_count: true,
    share_count: true,
    duration_seconds: true,
    publish_time: true,
  }),
  unit: "international",
  position: "auto",
  defaultState: "compact",
  collapsed: false,
  autoUpdate: true,
});

export const OVERLAY_SETTINGS_STORAGE_KEY = "tiktokDarenAssistant.ui.overlaySettings.v1";

export interface SettingsStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

interface ChromeStorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

/** 用于单元测试和 Chrome API 不可用的本地预览页。 */
export class MemorySettingsStorage implements SettingsStorage {
  private readonly values = new Map<string, unknown>();

  constructor(initialValues: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initialValues)) this.values.set(key, cloneValue(value));
  }

  async get(key: string): Promise<unknown> {
    const value = this.values.get(key);
    return value === undefined ? undefined : cloneValue(value);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, cloneValue(value));
  }
}

/** chrome.storage.local 的小型适配器，不触碰同步存储或系统设置。 */
export class ChromeLocalSettingsStorage implements SettingsStorage {
  constructor(private readonly area: ChromeStorageAreaLike) {}

  async get(key: string): Promise<unknown> {
    const values = await this.area.get(key);
    return values[key];
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.area.set({ [key]: value });
  }
}

let previewStorage: MemorySettingsStorage | null = null;

export function createDefaultSettingsStorage(): SettingsStorage {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new ChromeLocalSettingsStorage(chrome.storage.local as unknown as ChromeStorageAreaLike);
  }
  previewStorage ??= new MemorySettingsStorage();
  return previewStorage;
}

const positions = new Set<OverlayPosition>(["auto", "left", "right", "inside"]);
const defaultStates = new Set<OverlayDefaultState>(["compact", "collapsed"]);
const units = new Set<OverlayUnit>(["international", "chinese"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 忽略损坏或旧版本中的未知值，保证 UI 设置不会影响采集链路。 */
export function normalizeOverlaySettings(value: unknown): OverlaySettings {
  const input = isRecord(value) ? value : {};
  const visibleInput = isRecord(input.visibleFields) ? input.visibleFields : {};
  const visibleFields = Object.fromEntries(
    overlayFieldOrder.map((field) => [
      field,
      typeof visibleInput[field] === "boolean"
        ? visibleInput[field]
        : DEFAULT_OVERLAY_SETTINGS.visibleFields[field],
    ]),
  ) as Record<OverlayField, boolean>;

  return {
    visibleFields,
    unit: units.has(input.unit as OverlayUnit) ? (input.unit as OverlayUnit) : DEFAULT_OVERLAY_SETTINGS.unit,
    position: positions.has(input.position as OverlayPosition)
      ? (input.position as OverlayPosition)
      : DEFAULT_OVERLAY_SETTINGS.position,
    defaultState: defaultStates.has(input.defaultState as OverlayDefaultState)
      ? (input.defaultState as OverlayDefaultState)
      : DEFAULT_OVERLAY_SETTINGS.defaultState,
    collapsed: typeof input.collapsed === "boolean" ? input.collapsed : DEFAULT_OVERLAY_SETTINGS.collapsed,
    autoUpdate: typeof input.autoUpdate === "boolean" ? input.autoUpdate : DEFAULT_OVERLAY_SETTINGS.autoUpdate,
  };
}

export async function loadOverlaySettings(
  storage: SettingsStorage = createDefaultSettingsStorage(),
): Promise<OverlaySettings> {
  return normalizeOverlaySettings(await storage.get(OVERLAY_SETTINGS_STORAGE_KEY));
}

export async function saveOverlaySettings(
  settings: OverlaySettings,
  storage: SettingsStorage = createDefaultSettingsStorage(),
): Promise<OverlaySettings> {
  const normalized = normalizeOverlaySettings(settings);
  await storage.set(OVERLAY_SETTINGS_STORAGE_KEY, normalized);
  return normalized;
}

export async function patchOverlaySettings(
  patch: OverlaySettingsPatch,
  storage: SettingsStorage = createDefaultSettingsStorage(),
): Promise<OverlaySettings> {
  const current = await loadOverlaySettings(storage);
  return saveOverlaySettings(
    {
      ...current,
      ...patch,
      visibleFields: {
        ...current.visibleFields,
        ...patch.visibleFields,
      },
    },
    storage,
  );
}

/** 将“默认状态”应用到新的浮层会话，不覆盖其他设置。 */
export function applyOverlayDefaultState(settings: OverlaySettings): OverlaySettings {
  return { ...settings, collapsed: settings.defaultState === "collapsed" };
}

export class OverlaySettingsStore {
  constructor(
    private readonly storage: SettingsStorage = createDefaultSettingsStorage(),
  ) {}

  load(): Promise<OverlaySettings> {
    return loadOverlaySettings(this.storage);
  }

  save(settings: OverlaySettings): Promise<OverlaySettings> {
    return saveOverlaySettings(settings, this.storage);
  }

  patch(patch: OverlaySettingsPatch): Promise<OverlaySettings> {
    return patchOverlaySettings(patch, this.storage);
  }
}

