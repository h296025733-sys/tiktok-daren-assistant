import { describe, expect, it } from "vitest";

import {
  formatChineseCount,
  formatCount,
  formatDateCompact,
  formatDateFull,
  formatDuration,
  formatFullNumber,
  formatPublishTime,
} from "../src/ui/formatter";

describe("统一指标格式化", () => {
  it.each([
    [999, "999"],
    [1_200, "1.2K"],
    [125_700, "125.7K"],
    [3_100_000, "3.1M"],
    [1_200_000_000, "1.2B"],
  ])("默认将 %d 格式化为国际单位 %s", (value, expected) => {
    expect(formatCount(value)).toBe(expected);
  });

  it("支持中文万和亿", () => {
    expect(formatChineseCount(12_570)).toBe("1.3万");
    expect(formatCount(936_000, "chinese")).toBe("93.6万");
    expect(formatCount(120_000_000, "chinese")).toBe("1.2亿");
  });

  it("支持完整数字，并统一处理未知值", () => {
    expect(formatFullNumber(1_234_567)).toBe("1,234,567");
    expect(formatCount(1_234_567, "full")).toBe("1,234,567");
    expect(formatCount(null)).toBe("--");
    expect(formatCount(Number.NaN)).toBe("--");
    expect(formatCount(-1)).toBe("--");
  });
});

describe("日期与时长格式化", () => {
  it("紧凑日期只显示月日，完整日期保留秒", () => {
    const value = "2026-07-20T15:04:05.000Z";
    expect(formatDateCompact(value, { timeZone: "UTC" })).toBe("07/20");
    expect(formatDateFull(value, { timeZone: "UTC" })).toBe("2026-07-20 15:04:05");
  });

  it("有时间戳时稳定显示绝对日期，相对时间只在无时间戳时兜底", () => {
    expect(formatDateCompact(1_753_027_200, { timeZone: "UTC" })).not.toBe("--");
    expect(formatPublishTime(null, "3天前")).toBe("3天前");
    expect(formatPublishTime("2026-07-20T15:04:05.000Z", "3天前", { timeZone: "UTC" })).toBe("07/20");
    expect(formatPublishTime("2026-07-20T15:04:05.000Z", "2026-07-20", { timeZone: "UTC" })).toBe("07/20");
    expect(formatPublishTime("无效日期", null)).toBe("--");
  });

  it.each([
    [0, "0:00"],
    [40, "0:40"],
    [65, "1:05"],
    [3_661, "1:01:01"],
    [null, "--"],
  ])("将时长 %s 格式化为 %s", (value, expected) => {
    expect(formatDuration(value)).toBe(expected);
  });
});
