import type { FieldEvidence } from "../types/snapshot";
import { cleanText, evidence, nonNegativeInteger } from "./value";

export interface StructuredExtraction {
  fields: Record<string, FieldEvidence>;
  raw: Record<string, unknown>;
  videoId: string | null;
}

export interface StructuredMatchContext {
  authorUniqueId: string | null;
  description: string | null;
  mediaUrls: string[];
}

type JsonObject = Record<string, unknown>;

interface ParsedScript {
  text: string;
  value: unknown;
  index: VideoIndex;
}

interface VideoIndex {
  items: JsonObject[];
  byId: Map<string, JsonObject>;
  complete: boolean;
}

interface StructuredRoot {
  root: unknown;
  source: string;
  signature: string;
  index: VideoIndex;
}

const parsedScriptCache = new WeakMap<HTMLScriptElement, ParsedScript>();
const structuredMatchCache = new Map<string, { id: string; source: string } | null>();

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(root: unknown, path: string[]): JsonObject | null {
  let current: unknown = root;
  for (const segment of path) {
    if (!isObject(current)) return null;
    current = current[segment];
  }
  return isObject(current) ? current : null;
}

function knownVideoObject(root: unknown, videoId: string): JsonObject | null {
  const knownPaths = [
    ["__DEFAULT_SCOPE__", "webapp.video-detail", "itemInfo", "itemStruct"],
    ["ItemModule", videoId],
    ["itemInfo", "itemStruct"],
  ];
  for (const path of knownPaths) {
    const candidate = objectAt(root, path);
    if (candidate && String(candidate.id ?? candidate.itemId ?? "") === videoId) return candidate;
  }
  return null;
}

function collectVideoObjects(root: unknown): VideoIndex {
  const found: JsonObject[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let cursor = 0;
  let visited = 0;
  while (cursor < queue.length && visited < 20_000 && found.length < 1_000) {
    const next = queue[cursor];
    cursor += 1;
    if (!next) continue;
    visited += 1;
    if (!isObject(next.value) && !Array.isArray(next.value)) continue;
    if (isObject(next.value)) {
      const id = String(next.value.id ?? next.value.itemId ?? "");
      if (/^\d{10,}$/.test(id) && (isObject(next.value.stats) || isObject(next.value.video))) {
        found.push(next.value);
      }
    }
    if (next.depth >= 9) continue;
    const children = Array.isArray(next.value) ? next.value : Object.values(next.value);
    for (const child of children.slice(0, 240)) {
      if (typeof child === "object" && child !== null) {
        queue.push({ value: child, depth: next.depth + 1 });
      }
    }
  }
  return {
    items: found,
    byId: new Map(
      found.map((item) => [String(item.id ?? item.itemId ?? ""), item] as const),
    ),
    complete: cursor >= queue.length,
  };
}

function findVideoObject(root: unknown, index: VideoIndex, videoId: string): JsonObject | null {
  const known = knownVideoObject(root, videoId);
  if (known) return known;
  return index.byId.get(videoId) ?? null;
}

function structuredRoots(): StructuredRoot[] {
  const scripts = [
    document.querySelector<HTMLScriptElement>("#__UNIVERSAL_DATA_FOR_REHYDRATION__"),
    document.querySelector<HTMLScriptElement>("#SIGI_STATE"),
  ].filter(
    (script, index, all): script is HTMLScriptElement => Boolean(script) && all.indexOf(script) === index,
  );
  const results: StructuredRoot[] = [];
  for (const script of scripts) {
    const text = script.textContent;
    if (!text || text.length > 8_000_000 || !text.includes("{")) continue;
    const signature = `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
    const cached = parsedScriptCache.get(script);
    if (cached?.text === text) {
      results.push({
        root: cached.value,
        source: `embedded_json:${script.id || "script"}`,
        signature,
        index: cached.index,
      });
      continue;
    }
    try {
      const value: unknown = JSON.parse(text);
      const index = collectVideoObjects(value);
      parsedScriptCache.set(script, { text, value, index });
      structuredMatchCache.clear();
      results.push({
        root: value,
        source: `embedded_json:${script.id || "script"}`,
        signature,
        index,
      });
    } catch (error) {
      console.debug("[TikTok 达人助手] 内嵌 JSON 解析失败，继续尝试其他来源", error);
    }
  }
  return results;
}

function addTextField(
  fields: Record<string, FieldEvidence>,
  name: string,
  raw: unknown,
  source: string,
): void {
  const value = cleanText(raw);
  if (value !== null) fields[name] = evidence(value, source, "high", raw);
}

function addIntegerField(
  fields: Record<string, FieldEvidence>,
  name: string,
  raw: unknown,
  source: string,
): void {
  const value = nonNegativeInteger(raw);
  if (value !== null) fields[name] = evidence(value, source, "high", raw);
}

function fieldsFromItem(item: JsonObject, videoId: string, source: string): StructuredExtraction {
  const fields: Record<string, FieldEvidence> = {};
  const author = isObject(item.author) ? item.author : {};
  const stats = isObject(item.stats) ? item.stats : {};
  const video = isObject(item.video) ? item.video : {};

  fields.video_id = evidence(videoId, source, "high", item.id ?? item.itemId);
  addTextField(fields, "author.nickname", author.nickname, source);
  addTextField(fields, "author.unique_id", author.uniqueId ?? author.unique_id, source);
  addTextField(fields, "description", item.desc ?? item.description, source);
  addIntegerField(fields, "created_at", item.createTime ?? item.create_time, source);
  addIntegerField(fields, "duration_seconds", video.duration, source);
  addIntegerField(fields, "metrics.play_count", stats.playCount, source);
  addIntegerField(fields, "metrics.like_count", stats.diggCount ?? stats.likeCount, source);
  addIntegerField(fields, "metrics.comment_count", stats.commentCount, source);
  addIntegerField(fields, "metrics.collect_count", stats.collectCount, source);
  addIntegerField(fields, "metrics.share_count", stats.shareCount, source);

  return {
    fields,
    videoId,
    raw: {
      structured_source: source,
      item: {
        id: item.id ?? item.itemId ?? null,
        desc: item.desc ?? null,
        createTime: item.createTime ?? null,
        author,
        stats,
        video: { duration: video.duration ?? null },
      },
    },
  };
}

export function extractStructuredData(videoId: string): StructuredExtraction {
  for (const { root, source, index } of structuredRoots()) {
    const item = findVideoObject(root, index, videoId);
    if (item) return fieldsFromItem(item, videoId, source);
  }
  return { fields: {}, raw: {}, videoId: null };
}

export function resolveStructuredVideoId(
  context: StructuredMatchContext,
  mode: "media" | "context",
): { id: string; source: string } | null {
  const normalizedMedia = context.mediaUrls.map(normalizeComparableUrl).filter(Boolean) as string[];
  const normalizedDescription = normalizeText(context.description);
  const normalizedAuthor = normalizeText(context.authorUniqueId)?.replace(/^@/, "") ?? null;
  const ranked: Array<{ id: string; source: string; score: number }> = [];
  const roots = structuredRoots();
  const cacheKey = [
    roots.map((root) => root.signature).join("|"),
    mode,
    normalizedAuthor ?? "",
    normalizedDescription ?? "",
    normalizedMedia.join("|"),
  ].join("::");
  if (structuredMatchCache.has(cacheKey)) return structuredMatchCache.get(cacheKey) ?? null;
  if (mode === "context" && roots.some((root) => !root.index.complete)) {
    structuredMatchCache.set(cacheKey, null);
    return null;
  }

  for (const { source, index } of roots) {
    for (const item of index.items) {
      const id = String(item.id ?? item.itemId ?? "");
      if (!/^\d{10,}$/.test(id)) continue;
      const author = isObject(item.author) ? item.author : {};
      const video = isObject(item.video) ? item.video : {};
      const itemAuthor = normalizeText(author.uniqueId ?? author.unique_id)?.replace(/^@/, "") ?? null;
      const itemDescription = normalizeText(item.desc ?? item.description);
      const itemMedia = collectStrings(video, 3).map(normalizeComparableUrl).filter(Boolean) as string[];
      const mediaMatches = normalizedMedia.some((left) =>
        itemMedia.some((right) => left === right || left.includes(right) || right.includes(left)),
      );
      let score = mediaMatches ? 8 : 0;
      if (mode === "context") {
        if (
          normalizedAuthor &&
          itemAuthor === normalizedAuthor &&
          normalizedDescription &&
          normalizedDescription.length >= 16 &&
          itemDescription &&
          normalizedDescription === itemDescription
        ) {
          score += 7;
        }
      }
      if ((mode === "media" && score >= 8) || (mode === "context" && score >= 7)) {
        ranked.push({ id, source, score });
      }
    }
  }

  ranked.sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const result =
    !best || (ranked[1] && ranked[1].score === best.score && ranked[1].id !== best.id)
      ? null
      : { id: best.id, source: `${best.source}:${mode}_match` };
  if (structuredMatchCache.size >= 50) structuredMatchCache.clear();
  structuredMatchCache.set(cacheKey, result);
  return result;
}

function collectStrings(value: unknown, maxDepth: number): string[] {
  const strings: string[] = [];
  const visit = (current: unknown, depth: number): void => {
    if (strings.length >= 100 || depth > maxDepth) return;
    if (typeof current === "string") {
      strings.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 30)) visit(item, depth + 1);
    } else if (isObject(current)) {
      for (const item of Object.values(current).slice(0, 60)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return strings;
}

function normalizeText(value: unknown): string | null {
  const text = cleanText(value);
  return text?.toLocaleLowerCase().replace(/\s+/g, " ") ?? null;
}

function normalizeComparableUrl(value: string): string | null {
  if (!value || value.startsWith("blob:")) return null;
  try {
    const url = new URL(value, document.baseURI);
    return `${url.hostname}${decodeURIComponent(url.pathname)}`.toLocaleLowerCase().slice(0, 1_000);
  } catch {
    return value.split("?")[0]?.toLocaleLowerCase().slice(0, 1_000) ?? null;
  }
}
