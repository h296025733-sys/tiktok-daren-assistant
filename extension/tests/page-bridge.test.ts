import { afterAll, describe, expect, it, vi } from "vitest";

const VIDEO_ID = "7648204047693909278";
const NETWORK_EVENT = "tiktok-daren-assistant:network-items";
const HYDRATION_EVENT = "tiktok-daren-assistant:hydration-items";
const READY_EVENT = "tiktok-daren-assistant:network-ready";
const RESCAN_EVENT = "tiktok-daren-assistant:hydration-rescan";
const MEDIA_REQUEST_EVENT = "tiktok-daren-assistant:media-fetch-request";
const MEDIA_RESPONSE_EVENT = "tiktok-daren-assistant:media-fetch-response";
const MEDIA_SAVE_REQUEST_EVENT = "tiktok-daren-assistant:media-save-request";
const MEDIA_SAVE_RESPONSE_EVENT = "tiktok-daren-assistant:media-save-response";

describe("MAIN-world 只读页面数据桥", () => {
  const originalFetch = window.fetch;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  afterAll(() => {
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.send = originalXhrSend;
  });

  it("clone fetch 响应而不消费原响应，并只发出脱敏公开视频字段", async () => {
    const networkDetails: string[] = [];
    const hydrationDetails: string[] = [];
    const mediaDetails: string[] = [];
    const mediaSaveDetails: string[] = [];
    document.addEventListener(NETWORK_EVENT, (event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") {
        networkDetails.push(event.detail);
      }
    });
    document.addEventListener(HYDRATION_EVENT, (event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") {
        hydrationDetails.push(event.detail);
      }
    });
    document.addEventListener(MEDIA_RESPONSE_EVENT, (event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") mediaDetails.push(event.detail);
    });
    document.addEventListener(MEDIA_SAVE_RESPONSE_EVENT, (event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string") mediaSaveDetails.push(event.detail);
    });
    const createObjectUrl = vi.fn(() => "blob:https://www.tiktok.com/media-fixture");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const responseClone = vi.spyOn(Response.prototype, "clone");

    Object.defineProperty(window, "SIGI_STATE", {
      configurable: true,
      value: {
        ItemModule: {
          [VIDEO_ID]: videoItem("global hydration", 4_600_000),
        },
        cookie: "GLOBAL_SECRET",
      },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const target = String(input);
      const isMedia = /\.(?:mp4|m4a|mp3|jpe?g|png|webp|woff2?)(?:[?#]|$)/i.test(target);
      const isBodyless = target.includes("/api/status-204");
      const response = new Response(
        isBodyless
          ? null
          : isMedia
            ? new Uint8Array([1, 2, 3])
            : JSON.stringify({
                itemList: [videoItem("network response", 4_700_000)],
                request_headers: { cookie: "NETWORK_SECRET" },
              }),
        {
          status: isBodyless ? 204 : 200,
          headers: { "content-type": isMedia ? "video/mp4" : "application/json" },
        },
      );
      Object.defineProperty(response, "url", {
        configurable: true,
        value: target,
      });
      return response;
    });
    window.fetch = fetchMock as typeof window.fetch;
    XMLHttpRequest.prototype.send = function (): void {
      this.dispatchEvent(new Event("load"));
    };

    await import("../src/content/pageBridge");

    const initialResponse = await window.fetch(
      "https://www.tiktok.com/api/recommend/item_list/?token=NETWORK_SECRET",
    );
    await initialResponse.json();
    const relatedResponse = await window.fetch(
      "https://www.tiktok.com/api/related/item_list/?token=RELATED_SECRET",
    );
    await relatedResponse.json();
    for (let index = 0; index < 30; index += 1) {
      const response = await window.fetch(`https://www.tiktok.com/api/post/item_list/?cursor=${index}`);
      await response.json();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.dispatchEvent(new CustomEvent(READY_EVENT));

    await vi.waitFor(() => expect(networkDetails).toHaveLength(23));
    expect(
      networkDetails.some((detail) => JSON.parse(detail).pathname === "/api/recommend/item_list/"),
    ).toBe(true);
    expect(
      networkDetails.some((detail) => JSON.parse(detail).pathname === "/api/related/item_list/"),
    ).toBe(true);

    const returned = await window.fetch("https://www.tiktok.com/api/recommend/item_list/");
    const originalPayload = (await returned.json()) as { itemList: unknown[] };
    expect(originalPayload.itemList).toHaveLength(1);
    expect(responseClone).toHaveBeenCalledTimes(33);

    await vi.waitFor(() => expect(networkDetails).toHaveLength(24));
    await vi.waitFor(() => expect(hydrationDetails).toHaveLength(1));
    const network = JSON.parse(networkDetails[23]!) as Record<string, unknown>;
    const hydration = JSON.parse(hydrationDetails[0]!) as Record<string, unknown>;
    expect(network.pathname).toBe("/api/recommend/item_list/");
    expect(hydration.pathname).toBe("/__global_state__/SIGI_STATE");
    expect(JSON.stringify({ network, hydration })).not.toContain("NETWORK_SECRET");
    expect(JSON.stringify({ network, hydration })).not.toContain("GLOBAL_SECRET");
    expect(JSON.stringify(network)).not.toContain("request_headers");
    expect(JSON.stringify(hydration)).not.toContain("cookie");

    const xhr = new XMLHttpRequest();
    Object.defineProperties(xhr, {
      responseURL: {
        configurable: true,
        value: "https://www.tiktok.com/api/post/item_list/?token=XHR_SECRET",
      },
      responseType: { configurable: true, value: "" },
      responseText: {
        configurable: true,
        value: JSON.stringify({
          itemList: [videoItem("xhr response", 4_800_000)],
          cookie: "XHR_SECRET",
        }),
      },
      getResponseHeader: {
        configurable: true,
        value: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
    });
    xhr.send();
    expect(networkDetails).toHaveLength(25);
    const xhrEvent = JSON.parse(networkDetails[24]!) as Record<string, unknown>;
    expect(xhrEvent.pathname).toBe("/api/post/item_list/");
    expect(JSON.stringify(xhrEvent)).not.toContain("XHR_SECRET");

    const cloneCallsBeforeUnrelatedResponses = responseClone.mock.calls.length;
    const mediaFetchResponse = await window.fetch("https://www.tiktok.com/video.mp4");
    expect(new Uint8Array(await mediaFetchResponse.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const bodylessResponse = await window.fetch("https://www.tiktok.com/api/status-204");
    expect(bodylessResponse.status).toBe(204);
    expect(await bodylessResponse.text()).toBe("");
    await window.fetch("https://evil.example/data");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(networkDetails).toHaveLength(25);
    expect(responseClone).toHaveBeenCalledTimes(cloneCallsBeforeUnrelatedResponses);

    document.dispatchEvent(new CustomEvent(MEDIA_REQUEST_EVENT, {
      detail: JSON.stringify({
        transfer_id: "mediafixture1234",
        media_url: "https://v16.tiktokcdn.com/video.mp4",
        offset: 0,
        chunk_size: 16_384,
      }),
    }));
    await vi.waitFor(() => expect(mediaDetails).toHaveLength(1));
    const mediaResponse = JSON.parse(mediaDetails[0]!) as {
      ok: boolean;
      done: boolean;
      total_bytes: number;
      chunk_base64: string;
    };
    expect(mediaResponse.ok).toBe(true);
    expect(mediaResponse.done).toBe(true);
    expect(atob(mediaResponse.chunk_base64).length).toBe(mediaResponse.total_bytes);
    expect(responseClone).toHaveBeenCalledTimes(cloneCallsBeforeUnrelatedResponses);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://v16.tiktokcdn.com/video.mp4",
      expect.objectContaining({
        credentials: "include",
        headers: { Range: "bytes=0-16383" },
        referrer: window.location.href,
      }),
    );

    document.dispatchEvent(new CustomEvent(MEDIA_SAVE_REQUEST_EVENT, {
      detail: JSON.stringify({
        request_id: "savefixture1234",
        media_url: "https://v16.tiktokcdn.com/video.mp4",
        file_name: "TikTok_fixture.mp4",
      }),
    }));
    await vi.waitFor(() => expect(mediaSaveDetails).toHaveLength(1));
    expect(JSON.parse(mediaSaveDetails[0]!).ok).toBe(true);
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(anchorClick).toHaveBeenCalledOnce();

    const rescannedVideoId = "7555555555555555555";
    Object.defineProperty(window, "SIGI_STATE", {
      configurable: true,
      value: {
        ItemModule: {
          [VIDEO_ID]: videoItem("global hydration", 4_600_000),
          [rescannedVideoId]: videoItem("late hydration", 5_100_000, rescannedVideoId),
        },
      },
    });
    document.dispatchEvent(new CustomEvent(RESCAN_EVENT));
    await vi.waitFor(() => expect(hydrationDetails).toHaveLength(2));
    expect(hydrationDetails[1]).toContain(rescannedVideoId);

    const largeItems = Object.fromEntries(Array.from({ length: 300 }, (_, index) => {
      const videoId = (7_600_000_000_000_000_000n + BigInt(index)).toString();
      return [videoId, {
        ...videoItem(`large ${index}`, index + 1, videoId),
        video: {
          duration: 10,
          playAddr: `https://v16.tiktokcdn.com/${videoId}.mp4?token=${"x".repeat(3_700)}`,
        },
      }];
    }));
    Object.defineProperty(window, "SIGI_STATE", {
      configurable: true,
      value: { ItemModule: largeItems },
    });
    const beforeChunkedRescan = hydrationDetails.length;
    document.dispatchEvent(new CustomEvent(RESCAN_EVENT));
    await vi.waitFor(() => expect(hydrationDetails.length).toBeGreaterThan(beforeChunkedRescan + 1));
    const chunked = hydrationDetails.slice(beforeChunkedRescan);
    expect(chunked.every((detail) => detail.length <= 1_000_000)).toBe(true);
    expect(chunked.flatMap((detail) => JSON.parse(detail).items)).toHaveLength(300);
  });
});

function videoItem(description: string, playCount: number, videoId = VIDEO_ID): Record<string, unknown> {
  return {
    id: videoId,
    desc: description,
    author: { uniqueId: "creator", nickname: "Creator", token: "AUTHOR_SECRET" },
    stats: { playCount, diggCount: 38_900_000 },
    video: {
      duration: 40,
      playAddr: "https://cdn.test/a.mp4?token=MEDIA_SECRET",
      cover: "https://cdn.test/a.jpg?token=COVER_SECRET",
    },
  };
}
