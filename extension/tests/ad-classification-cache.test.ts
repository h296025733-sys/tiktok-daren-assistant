import { describe, expect, it } from "vitest";
import {
  appendKnownAdVideoId,
  appendKnownAdVideoIds,
  MAX_KNOWN_AD_VIDEO_IDS,
  normalizeKnownAdVideoIds,
} from "../src/background/adClassificationCache";

describe("cross-tab advertisement classification cache", () => {
  it("keeps only unique exact TikTok ids", () => {
    expect(normalizeKnownAdVideoIds([
      "7667711506724769054",
      "bad-id",
      7667711506724769054,
      "7667711506724769054",
      "7670233079767665951",
    ])).toEqual(["7667711506724769054", "7670233079767665951"]);
  });

  it("moves a confirmed id to the newest tail and stays bounded", () => {
    const ids = Array.from(
      { length: MAX_KNOWN_AD_VIDEO_IDS },
      (_, index) => String(7_000_000_000_000_000_000n + BigInt(index)),
    );
    const known = appendKnownAdVideoId(ids, ids[0]!);
    expect(known).toHaveLength(MAX_KNOWN_AD_VIDEO_IDS);
    expect(known.at(-1)).toBe(ids[0]);

    const added = appendKnownAdVideoId(known, "7999999999999999999");
    expect(added).toHaveLength(MAX_KNOWN_AD_VIDEO_IDS);
    expect(added.at(-1)).toBe("7999999999999999999");
    expect(added).not.toContain(ids[1]);
  });

  it("merges a batch once without duplicating existing ids", () => {
    expect(appendKnownAdVideoIds(
      ["7667711506724769054", "7670233079767665951"],
      ["7670233079767665951", "7670231209351449886"],
    )).toEqual([
      "7667711506724769054",
      "7670233079767665951",
      "7670231209351449886",
    ]);
  });
});
