import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTikTokPageCaption } from "../src/content/tikTokCaption";

const VIDEO_ID = "7665101396689079566";
const PAGE_URL = `https://www.tiktok.com/@toonalertt/video/${VIDEO_ID}`;
const VTT_URL =
  "https://v16m-webapp.tiktokcdn-us.com/subtitle/test.vtt?token=signed";
const STALE_VTT_URL =
  "https://v16m-webapp.tiktokcdn-us.com/subtitle/stale.vtt?token=expired";
const VTT = `WEBVTT

00:00:00.000 --> 00:00:01.580
You will go to a rich school.

00:00:01.580 --> 00:00:03.540
How dare you!
`;

function hydrationHtml(videoId = VIDEO_ID, subtitleUrl = VTT_URL): string {
  return `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": {
        itemInfo: {
          itemStruct: {
            id: videoId,
            video: {
              claInfo: { originalLanguageInfo: { language: "eng-US" } },
              subtitleInfos: [{
                Format: "webvtt",
                LanguageCodeName: "eng-US",
                Url: subtitleUrl,
              }],
            },
          },
        },
      },
    },
  })}</script>`;
}

describe("TikTok page-context caption path", () => {
  beforeEach(() => {
    document.body.innerHTML = hydrationHtml();
  });

  it("reads the current page track and fetches only the VTT file", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(VTT_URL);
      return new Response(VTT, { status: 200 });
    }) as typeof fetch;

    const result = await resolveTikTokPageCaption(
      document,
      PAGE_URL,
      VIDEO_ID,
      { fetcher },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      video_id: VIDEO_ID,
      language: "eng-US",
      segments: [
        { start: 0, end: 1.58, text: "You will go to a rich school." },
        { start: 1.58, end: 3.54, text: "How dare you!" },
      ],
    });
  });

  it("refreshes the same TikTok page when the live hydration belongs to an old video", async () => {
    document.body.innerHTML = hydrationHtml("7555555555555555555");
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === PAGE_URL) {
        expect(init).toEqual(expect.objectContaining({
          credentials: "same-origin",
          cache: "no-cache",
        }));
        return new Response(`<!doctype html>${hydrationHtml()}`, { status: 200 });
      }
      expect(String(input)).toBe(VTT_URL);
      return new Response(VTT, { status: 200 });
    }) as typeof fetch;

    const result = await resolveTikTokPageCaption(
      document,
      PAGE_URL,
      VIDEO_ID,
      { fetcher },
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result?.segments).toHaveLength(2);
  });

  it("does not wait for a stale captured track before checking the current video page", async () => {
    document.body.innerHTML = hydrationHtml("7555555555555555555");
    let staleTrackAborted = false;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === STALE_VTT_URL) {
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => {
            staleTrackAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (url === PAGE_URL) {
        return Promise.resolve(new Response(`<!doctype html>${hydrationHtml()}`, { status: 200 }));
      }
      expect(url).toBe(VTT_URL);
      return Promise.resolve(new Response(VTT, { status: 200 }));
    }) as typeof fetch;

    const startedAt = performance.now();
    const result = await resolveTikTokPageCaption(
      document,
      PAGE_URL,
      VIDEO_ID,
      {
        fetcher,
        storedTrack: { url: STALE_VTT_URL, language: "eng-US" },
      },
    );

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(result?.segments).toHaveLength(2);
    expect(staleTrackAborted).toBe(true);
  });
});
