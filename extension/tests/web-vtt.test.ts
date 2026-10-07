import { describe, expect, it } from "vitest";

import {
  extractTikTokWebVttTrackFromDocument,
  extractTikTokWebVttTrackFromHtml,
  parseWebVtt,
  trustedTikTokSubtitleUrl,
  trustedTikTokVideoPageUrl,
} from "../src/sidepanel/webVtt";

describe("TikTok WebVTT fast path", () => {
  it("parses TikTok cue timing and text without retaining markup", () => {
    const result = parseWebVtt(`WEBVTT

00:00:00.220 --> 00:00:02.600
listen I can only take one of you

cue-2
00:00:02.620 --> 00:00:05.180 align:start position:0%
this <b>motorcycle</b> doesn&apos;t have space &amp; time
`);

    expect(result).toEqual([
      { start: 0.22, end: 2.6, text: "listen I can only take one of you" },
      {
        start: 2.62,
        end: 5.18,
        text: "this motorcycle doesn't have space & time",
      },
    ]);
  });

  it("rejects malformed cues and untrusted subtitle hosts", () => {
    expect(parseWebVtt("not a webvtt file")).toEqual([]);
    expect(trustedTikTokSubtitleUrl("https://v16m-webapp.tiktokcdn-us.com/subtitle.vtt?x=1"))
      .toBe("https://v16m-webapp.tiktokcdn-us.com/subtitle.vtt?x=1");
    expect(trustedTikTokSubtitleUrl("https://example.com/subtitle.vtt")).toBeNull();
    expect(trustedTikTokSubtitleUrl("http://v16.tiktokcdn.com/subtitle.vtt")).toBeNull();
  });

  it("extracts the original WebVTT track from a freshly fetched TikTok video page", () => {
    const videoId = "7652906415371209997";
    const html = `<!doctype html><html><body>
      <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
        __DEFAULT_SCOPE__: {
          "webapp.video-detail": {
            itemInfo: {
              itemStruct: {
                id: videoId,
                video: {
                  claInfo: { originalLanguageInfo: { language: "eng-US" } },
                  subtitleInfos: [
                    {
                      Format: "webvtt",
                      LanguageCodeName: "spa-ES",
                      Url: "https://v16.tiktokcdn.com/subtitles/spanish.vtt",
                    },
                    {
                      Format: "webvtt",
                      LanguageCodeName: "eng-US",
                      Url: "https://v16.tiktokcdn.com/subtitles/english.vtt?fresh=1",
                    },
                  ],
                },
              },
            },
          },
        },
      })}</script>
    </body></html>`;

    expect(extractTikTokWebVttTrackFromHtml(html, videoId)).toEqual({
      url: "https://v16.tiktokcdn.com/subtitles/english.vtt?fresh=1",
      language: "eng-US",
    });
    document.body.innerHTML = html;
    expect(extractTikTokWebVttTrackFromDocument(document, videoId)).toEqual({
      url: "https://v16.tiktokcdn.com/subtitles/english.vtt?fresh=1",
      language: "eng-US",
    });
    expect(extractTikTokWebVttTrackFromHtml(html, "7652906415371209998")).toBeNull();
    expect(trustedTikTokVideoPageUrl(
      `https://www.tiktok.com/@toonalertt/video/${videoId}?lang=en`,
      videoId,
    )).toBe(`https://www.tiktok.com/@toonalertt/video/${videoId}`);
    expect(trustedTikTokVideoPageUrl(`https://example.com/video/${videoId}`, videoId)).toBeNull();
  });
});
