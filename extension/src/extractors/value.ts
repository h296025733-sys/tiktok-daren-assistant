import type { Confidence, FieldEvidence } from "../types/snapshot";

export function evidence<T>(
  value: T | null,
  source: string,
  confidence: Confidence,
  rawValue: unknown,
): FieldEvidence<T> {
  return { value, source, confidence, raw_value: rawValue };
}

export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function parseMetricText(raw: unknown): number | null {
  if (typeof raw === "number") return nonNegativeInteger(raw);
  if (typeof raw !== "string") return null;

  const normalized = raw.trim().replace(/,/g, "").toUpperCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(K|M|B|万|亿)?$/);
  if (!match) return null;

  const numericPart = Number(match[1]);
  if (!Number.isFinite(numericPart)) return null;
  const multipliers: Record<string, number> = {
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
    万: 10_000,
    亿: 100_000_000,
  };
  const multiplier = match[2] ? multipliers[match[2]] : 1;
  if (multiplier === undefined) return null;
  const result = Math.round(numericPart * multiplier);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

const RELATIVE_TIME_PATTERN =
  /(?:刚刚|剛剛|\d+(?:\.\d+)?\s*(?:秒|分钟|分鐘|分|小时|小時|时|時|天|日|周|週|星期|个月|個月|月|年)前)/i;

export function splitNicknameAndPublishTime(raw: unknown): {
  nickname: string | null;
  publishTimeText: string | null;
} {
  const text = cleanText(raw);
  if (!text) return { nickname: null, publishTimeText: null };

  const separated = text.match(/^(.*?)\s*[·•]\s*(.+)$/);
  if (separated) {
    const possibleTime = cleanText(separated[2]);
    if (possibleTime && RELATIVE_TIME_PATTERN.test(possibleTime)) {
      return {
        nickname: cleanText(separated[1]),
        publishTimeText: possibleTime.match(RELATIVE_TIME_PATTERN)?.[0] ?? possibleTime,
      };
    }
  }

  const timeMatch = text.match(RELATIVE_TIME_PATTERN);
  if (timeMatch && timeMatch.index !== undefined && timeMatch.index > 0) {
    const nickname = cleanText(text.slice(0, timeMatch.index).replace(/[·•|｜\-–—]+\s*$/, ""));
    return { nickname, publishTimeText: timeMatch[0] };
  }
  return { nickname: text, publishTimeText: null };
}
