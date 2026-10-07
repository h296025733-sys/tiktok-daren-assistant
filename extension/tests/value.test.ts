import { describe, expect, it } from "vitest";

import { parseMetricText, splitNicknameAndPublishTime } from "../src/extractors/value";

describe("parseMetricText", () => {
  it.each([
    ["65", 65],
    ["1,488", 1_488],
    ["1.3K", 1_300],
    ["63.5K", 63_500],
    ["1M", 1_000_000],
    ["10.2M", 10_200_000],
    ["9.1万", 91_000],
    ["1020万", 10_200_000],
  ])("将 %s 解析为原始整数 %i", (raw, expected) => {
    expect(parseMetricText(raw)).toBe(expected);
  });
});

describe("splitNicknameAndPublishTime", () => {
  it.each([
    ["Boomskill · 5小时前", "Boomskill", "5小时前"],
    ["老闆娘蘇蘇 · 1週前", "老闆娘蘇蘇", "1週前"],
  ])("拆分昵称与相对发布时间", (raw, nickname, publishTimeText) => {
    expect(splitNicknameAndPublishTime(raw)).toEqual({ nickname, publishTimeText });
  });
});

