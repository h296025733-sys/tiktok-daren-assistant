import { describe, expect, it } from "vitest";

import {
  applyOverlayDefaultState,
  ChromeLocalSettingsStorage,
  DEFAULT_OVERLAY_SETTINGS,
  loadOverlaySettings,
  MemorySettingsStorage,
  normalizeOverlaySettings,
  OverlaySettingsStore,
  patchOverlaySettings,
  saveOverlaySettings,
} from "../src/ui/settings";

describe("浮层设置", () => {
  it("默认显示紧凑栏、使用国际单位并自动更新", async () => {
    const settings = await loadOverlaySettings(new MemorySettingsStorage());
    expect(settings).toEqual(DEFAULT_OVERLAY_SETTINGS);
    expect(settings.defaultState).toBe("compact");
    expect(settings.collapsed).toBe(false);
    expect(settings.unit).toBe("international");
    expect(settings.autoUpdate).toBe(true);
  });

  it("持久化当前折叠状态、显示字段和单位", async () => {
    const storage = new MemorySettingsStorage();
    await patchOverlaySettings(
      {
        collapsed: true,
        unit: "chinese",
        visibleFields: { share_count: false, publish_time: false },
      },
      storage,
    );

    const restored = await loadOverlaySettings(storage);
    expect(restored.collapsed).toBe(true);
    expect(restored.unit).toBe("chinese");
    expect(restored.visibleFields.share_count).toBe(false);
    expect(restored.visibleFields.publish_time).toBe(false);
    expect(restored.visibleFields.play_count).toBe(true);
  });

  it("patch/save 保留未修改字段", async () => {
    const storage = new MemorySettingsStorage();
    const store = new OverlaySettingsStore(storage);
    await store.save({ ...DEFAULT_OVERLAY_SETTINGS, position: "left" });
    const result = await store.patch({ autoUpdate: false });
    expect(result.position).toBe("left");
    expect(result.autoUpdate).toBe(false);
    expect((await store.load()).autoUpdate).toBe(false);
  });

  it("损坏或未知的持久化值会安全回落", () => {
    const normalized = normalizeOverlaySettings({
      unit: "错误单位",
      position: "页面外",
      collapsed: "true",
      visibleFields: { play_count: false, fake_field: true },
    });
    expect(normalized.unit).toBe("international");
    expect(normalized.position).toBe("auto");
    expect(normalized.collapsed).toBe(false);
    expect(normalized.visibleFields.play_count).toBe(false);
    expect(Object.keys(normalized.visibleFields)).toHaveLength(7);
  });

  it("默认状态和当前折叠状态相互独立", () => {
    const compact = applyOverlayDefaultState({ ...DEFAULT_OVERLAY_SETTINGS, collapsed: true });
    const collapsed = applyOverlayDefaultState({
      ...DEFAULT_OVERLAY_SETTINGS,
      defaultState: "collapsed",
      collapsed: false,
    });
    expect(compact.collapsed).toBe(false);
    expect(collapsed.collapsed).toBe(true);
  });

  it("适配 chrome.storage.local 读写接口", async () => {
    const records: Record<string, unknown> = {};
    const storage = new ChromeLocalSettingsStorage({
      async get(key) {
        return typeof key === "string" ? { [key]: records[key] } : { ...records };
      },
      async set(items) {
        Object.assign(records, items);
      },
    });
    await saveOverlaySettings({ ...DEFAULT_OVERLAY_SETTINGS, position: "inside" }, storage);
    expect((await loadOverlaySettings(storage)).position).toBe("inside");
  });
});

