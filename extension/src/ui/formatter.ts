export const UNKNOWN_DISPLAY_VALUE = "--";

export type MetricUnitMode = "international" | "chinese" | "full";
export type DateValue = Date | string | number | null | undefined;

export interface DateFormatOptions {
  timeZone?: string;
}

function validNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function compactDecimal(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 100 ? 1 : value >= 10 ? 1 : 1,
    minimumFractionDigits: 0,
    useGrouping: false,
  }).format(value);
}

export function formatFullNumber(value: number | null | undefined): string {
  const number = validNumber(value);
  if (number === null) return UNKNOWN_DISPLAY_VALUE;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(number);
}

export function formatInternationalCount(value: number | null | undefined): string {
  const number = validNumber(value);
  if (number === null) return UNKNOWN_DISPLAY_VALUE;
  if (number >= 1_000_000_000) return `${compactDecimal(number / 1_000_000_000)}B`;
  if (number >= 1_000_000) return `${compactDecimal(number / 1_000_000)}M`;
  if (number >= 1_000) return `${compactDecimal(number / 1_000)}K`;
  return formatFullNumber(number);
}

export function formatChineseCount(value: number | null | undefined): string {
  const number = validNumber(value);
  if (number === null) return UNKNOWN_DISPLAY_VALUE;
  if (number >= 100_000_000) return `${compactDecimal(number / 100_000_000)}亿`;
  if (number >= 10_000) return `${compactDecimal(number / 10_000)}万`;
  return formatFullNumber(number);
}

/** 指标统一入口，默认遵循 TikTok 常用的 K/M 国际单位。 */
export function formatCount(
  value: number | null | undefined,
  mode: MetricUnitMode = "international",
): string {
  if (mode === "chinese") return formatChineseCount(value);
  if (mode === "full") return formatFullNumber(value);
  return formatInternationalCount(value);
}

export function formatDuration(value: number | null | undefined): string {
  const number = validNumber(value);
  if (number === null) return UNKNOWN_DISPLAY_VALUE;
  const totalSeconds = Math.round(number);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function parseDate(value: DateValue): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    const result = new Date(milliseconds);
    return Number.isNaN(result.getTime()) ? null : result;
  }
  if (typeof value === "string" && value.trim()) {
    const result = new Date(value);
    return Number.isNaN(result.getTime()) ? null : result;
  }
  return null;
}

function dateParts(value: DateValue, options: DateFormatOptions): Record<string, string> | null {
  const date = parseDate(value);
  if (!date) return null;
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
  return Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
}

/** 紧凑时间只显示 MM/DD，避免年份被无意义截断。 */
export function formatDateCompact(value: DateValue, options: DateFormatOptions = {}): string {
  const parts = dateParts(value, options);
  return parts ? `${parts.month}/${parts.day}` : UNKNOWN_DISPLAY_VALUE;
}

export function formatDateFull(value: DateValue, options: DateFormatOptions = {}): string {
  const parts = dateParts(value, options);
  return parts
    ? `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
    : UNKNOWN_DISPLAY_VALUE;
}

/** 有绝对时间时始终稳定显示 MM/DD；相对时间只作为无时间戳时的兜底。 */
export function formatPublishTime(
  value: DateValue,
  relativeText: string | null | undefined,
  options: DateFormatOptions = {},
): string {
  const absolute = formatDateCompact(value, options);
  if (absolute !== UNKNOWN_DISPLAY_VALUE) return absolute;
  const relative = relativeText?.trim();
  if (relative && (/前$/.test(relative) || relative === "刚刚" || relative === "昨天" || relative === "前天")) {
    return relative;
  }
  return UNKNOWN_DISPLAY_VALUE;
}
