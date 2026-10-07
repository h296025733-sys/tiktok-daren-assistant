import { normalizeVideoItems } from "../extractors/normalizer";
import { VideoItemRegistry } from "../registry/videoItemRegistry";
import { sanitizeEvidence } from "./evidence";
import { parseNormalizedVideoEvent } from "./networkRegistry";

const MAX_SCRIPT_COUNT = 32;
const MAX_SCRIPT_CHARS = 8_000_000;
const MAX_TOTAL_CHARS = 16_000_000;
const MAX_MATCHED_IDS = 1_000;

export interface HydrationScanStats {
  scanned_script_count: number;
  parsed_script_count: number;
  normalized_item_count: number;
  matched_video_ids: string[];
  truncated: boolean;
  script_ids: string[];
}

export class HydrationScanner {
  private readonly signatures = new WeakMap<HTMLScriptElement, string>();
  private readonly matchedIds = new Set<string>();
  private parsedScriptCount = 0;
  private normalizedItemCount = 0;
  private truncated = false;
  private scriptIds = new Set<string>();
  private lastScannedScriptCount = 0;

  scan(doc: Document, registry: VideoItemRegistry): HydrationScanStats {
    const allScripts = findCandidateScripts(doc);
    const scripts = allScripts.slice(0, MAX_SCRIPT_COUNT);
    this.lastScannedScriptCount = scripts.length;
    if (allScripts.length > MAX_SCRIPT_COUNT) this.truncated = true;
    let totalChars = 0;

    for (const script of scripts) {
      const text = script.textContent?.trim();
      if (!text || !text.startsWith("{") && !text.startsWith("[")) continue;
      totalChars += text.length;
      if (text.length > MAX_SCRIPT_CHARS || totalChars > MAX_TOTAL_CHARS) {
        this.truncated = true;
        continue;
      }

      // TikTok 连续刷视频时可能只替换大段 JSON 的中间部分，长度、开头和
      // 结尾都不变。完整文本仍受 16 MB 总量上限保护，可避免漏掉这种更新。
      if (this.signatures.get(script) === text) continue;
      this.signatures.set(script, text);
      try {
        const payload: unknown = JSON.parse(text);
        const result = normalizeVideoItems(payload, "hydration_json", {
          maxDepth: 12,
          maxNodes: 30_000,
          maxChildrenPerNode: 300,
          maxItems: 1_000,
        });
        registry.upsertMany(result.items, "hydration_json");
        this.parsedScriptCount += 1;
        this.normalizedItemCount += result.items.length;
        this.truncated ||= result.truncated;
        for (const id of result.matched_video_ids) {
          touchBoundedSet(this.matchedIds, id, MAX_MATCHED_IDS);
        }
        touchBoundedSet(this.scriptIds, safeScriptIdentifier(script), MAX_SCRIPT_COUNT);
      } catch (error) {
        console.debug("[TikTok 达人助手] hydration JSON 解析失败，已跳过", error);
      }
    }

    return this.getStats();
  }

  consumeBridge(detail: unknown, registry: VideoItemRegistry): number {
    const event = parseNormalizedVideoEvent(detail);
    if (!event) return 0;
    registry.upsertMany(event.items, "hydration_json");
    this.parsedScriptCount += 1;
    this.normalizedItemCount += event.items.length;
    for (const item of event.items) {
      touchBoundedSet(this.matchedIds, item.video_id, MAX_MATCHED_IDS);
    }
    touchBoundedSet(
      this.scriptIds,
      `main_world:${safeGlobalStatePath(event.pathname)}`,
      MAX_SCRIPT_COUNT,
    );
    return event.items.length;
  }

  getStats(): HydrationScanStats {
    return {
      scanned_script_count: this.lastScannedScriptCount,
      parsed_script_count: this.parsedScriptCount,
      normalized_item_count: this.normalizedItemCount,
      matched_video_ids: [...this.matchedIds],
      truncated: this.truncated,
      script_ids: [...this.scriptIds],
    };
  }
}

function findCandidateScripts(doc: Document): HTMLScriptElement[] {
  const known = [
    doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__"),
    doc.getElementById("SIGI_STATE"),
  ].filter((element): element is HTMLScriptElement => element instanceof HTMLScriptElement);
  const genericSelectors = [
    'script[type="application/json"]',
    'script[id*="HYDRATION" i]',
    'script[id*="STATE" i]',
    'script[id*="DATA" i]',
    "script[data-hydration]",
  ].join(",");
  return [
    ...known,
    ...Array.from(doc.querySelectorAll<HTMLScriptElement>(genericSelectors)).filter(
      (script) => !known.includes(script),
    ),
  ];
}

function safeScriptIdentifier(script: HTMLScriptElement): string {
  if (
    script.id === "__UNIVERSAL_DATA_FOR_REHYDRATION__" ||
    script.id === "SIGI_STATE"
  ) {
    return `#${script.id}`;
  }
  if (script.id) return `#${sanitizeEvidence(script.id) ?? "已脱敏"}`;
  const type = script.getAttribute("type") ?? "unknown";
  return `script[type=${sanitizeEvidence(type) ?? "unknown"}]`;
}

function safeGlobalStatePath(pathname: string): string {
  if (
    pathname === "/__global_state__/__UNIVERSAL_DATA_FOR_REHYDRATION__" ||
    pathname === "/__global_state__/SIGI_STATE"
  ) {
    return pathname;
  }
  return sanitizeEvidence(pathname) ?? "global_state";
}

function touchBoundedSet(values: Set<string>, value: string, maximum: number): void {
  values.delete(value);
  values.add(value);
  while (values.size > maximum) {
    const oldest = values.values().next().value as string | undefined;
    if (!oldest) break;
    values.delete(oldest);
  }
}
