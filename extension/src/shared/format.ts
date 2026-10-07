export function formatCompactCount(value: number | null, unknownValue = "--"): string {
  if (value === null) return unknownValue;
  if (value >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trim(value / 1_000)}K`;
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function formatDuration(value: number | null, unknownValue = "--"): string {
  if (value === null) return unknownValue;
  const minutes = Math.floor(value / 60);
  const seconds = Math.max(0, value % 60);
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

function trim(value: number): string {
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, "");
}

