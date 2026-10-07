import { normalizeVideoItems, type NormalizedVideoItem } from "../extractors/normalizer";

(() => {
  const HISTORY_EVENT = "tiktok-daren-assistant:history-change";
  const DEBUG_EVENT = "tiktok-daren-assistant:debug-update";
  const NETWORK_EVENT = "tiktok-daren-assistant:network-items";
  const HYDRATION_EVENT = "tiktok-daren-assistant:hydration-items";
  const NETWORK_READY_EVENT = "tiktok-daren-assistant:network-ready";
  const HYDRATION_RESCAN_EVENT = "tiktok-daren-assistant:hydration-rescan";
  const MEDIA_FETCH_REQUEST_EVENT = "tiktok-daren-assistant:media-fetch-request";
  const MEDIA_FETCH_RESPONSE_EVENT = "tiktok-daren-assistant:media-fetch-response";
  const MEDIA_SAVE_REQUEST_EVENT = "tiktok-daren-assistant:media-save-request";
  const MEDIA_SAVE_RESPONSE_EVENT = "tiktok-daren-assistant:media-save-response";
  const BRIDGE_KEY = "__TIKTOK_DAREN_ASSISTANT_BRIDGE_STAGE12__";
  const MAX_RESPONSE_CHARS = 8_000_000;
  const MAX_EVENT_CHARS = 1_000_000;
  const MAX_QUEUED_EVENTS = 24;
  const MAX_PRIORITY_QUEUED_EVENTS = 12;
  const bridgeScope = window as typeof window & { [BRIDGE_KEY]?: boolean };
  if (bridgeScope[BRIDGE_KEY]) return;
  Object.defineProperty(bridgeScope, BRIDGE_KEY, {
    configurable: false,
    enumerable: false,
    value: true,
  });

  let currentDebugState: Readonly<Record<string, unknown>> = Object.freeze({});
  let networkConsumerReady = false;
  const queuedPublicEvents: Array<{ name: string; detail: string; priority: boolean }> = [];
  const globalStateSignatures = new Map<string, string>();
  let hydrationRescanTimer: number | null = null;

  if (!Object.getOwnPropertyDescriptor(window, "__TIKTOK_DAREN_ASSISTANT_DEBUG__")) {
    Object.defineProperty(window, "__TIKTOK_DAREN_ASSISTANT_DEBUG__", {
      configurable: false,
      enumerable: false,
      get: () => currentDebugState,
    });
  }

  const notifyHistoryChange = (): void => {
    document.dispatchEvent(new CustomEvent(HISTORY_EVENT, { detail: window.location.href }));
    scanKnownGlobalHydration();
  };

  try {
    const originalPushState = history.pushState.bind(history);
    history.pushState = (...args: Parameters<History["pushState"]>): void => {
      originalPushState(...args);
      notifyHistoryChange();
    };

    const originalReplaceState = history.replaceState.bind(history);
    history.replaceState = (...args: Parameters<History["replaceState"]>): void => {
      originalReplaceState(...args);
      notifyHistoryChange();
    };
  } catch {
    // History 被锁定时仍由 isolated content 的 URL 后备检查更新。
  }

  installFetchObserver();
  installXhrObserver();
  window.addEventListener("popstate", notifyHistoryChange);
  scanKnownGlobalHydration();
  queueMicrotask(scanKnownGlobalHydration);
  document.addEventListener("DOMContentLoaded", scanKnownGlobalHydration, { once: true });
  window.addEventListener("load", scanKnownGlobalHydration, { once: true });
  for (const delay of [250, 1_000, 3_000]) window.setTimeout(scanKnownGlobalHydration, delay);

  document.addEventListener(NETWORK_READY_EVENT, () => {
    networkConsumerReady = true;
    for (const event of queuedPublicEvents.splice(0)) dispatchPublicDetail(event.name, event.detail);
    scanKnownGlobalHydration();
  });

  document.addEventListener(HYDRATION_RESCAN_EVENT, () => {
    if (hydrationRescanTimer !== null) return;
    hydrationRescanTimer = window.setTimeout(() => {
      hydrationRescanTimer = null;
      scanKnownGlobalHydration();
    }, 60);
  });

  const fullMediaResponses = new Map<string, { bytes: Uint8Array; contentType: string | null }>();
  document.addEventListener(MEDIA_FETCH_REQUEST_EVENT, (event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "string" || event.detail.length > 5_000) return;
    let request: { transfer_id: string; media_url: string; offset: number; chunk_size: number };
    try {
      request = JSON.parse(event.detail) as typeof request;
    } catch {
      return;
    }
    if (!validMediaChunkRequest(request)) return;
    void fetchMediaChunkInPage(request)
      .then((response) => dispatchPublicDetail(MEDIA_FETCH_RESPONSE_EVENT, JSON.stringify(response)))
      .catch((error: unknown) => dispatchPublicDetail(MEDIA_FETCH_RESPONSE_EVENT, JSON.stringify({
        ok: false,
        transfer_id: request.transfer_id,
        error: error instanceof Error ? error.message : "页面读取视频失败",
      })));
  });

  document.addEventListener(MEDIA_SAVE_REQUEST_EVENT, (event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "string" || event.detail.length > 5_000) return;
    let request: { request_id: string; media_url: string; file_name: string };
    try {
      request = JSON.parse(event.detail) as typeof request;
    } catch {
      return;
    }
    if (
      !/^[a-zA-Z0-9_-]{8,80}$/.test(request.request_id) ||
      !isAllowedMediaUrl(request.media_url) ||
      !validDownloadFileName(request.file_name)
    ) return;
    void saveMediaFromPage(request)
      .then((response) => dispatchPublicDetail(MEDIA_SAVE_RESPONSE_EVENT, JSON.stringify(response)))
      .catch((error: unknown) => dispatchPublicDetail(MEDIA_SAVE_RESPONSE_EVENT, JSON.stringify({
        ok: false,
        request_id: request.request_id,
        error: error instanceof Error ? error.message : "TikTok 页面保存视频失败",
      })));
  });

  document.addEventListener(DEBUG_EVENT, (event) => {
    if (
      !(event instanceof CustomEvent) ||
      typeof event.detail !== "string" ||
      event.detail.length > 500_000
    ) {
      return;
    }
    try {
      const parsed = JSON.parse(event.detail) as Record<string, unknown>;
      if (
        typeof parsed.page_url !== "string" ||
        typeof parsed.content_session_id !== "string" ||
        typeof parsed.generation !== "number" ||
        typeof parsed.snapshot_sequence !== "number"
      ) {
        return;
      }
      currentDebugState = deepFreeze(parsed);
    } catch {
      // 无效诊断事件直接忽略；调试对象不会反向参与采集或保存。
    }
  });

  function installFetchObserver(): void {
    try {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
        const response = await originalFetch(...args);
        const pathname = inspectableFetchPathname(response);
        if (!pathname) return response;
        try {
          const clone = response.clone();
          void inspectFetchResponse(clone, pathname);
        } catch {
          // clone 失败不能影响 TikTok 原响应。
        }
        return response;
      };
    } catch {
      // fetch 不可写时保持页面原行为。
    }
  }

  function installXhrObserver(): void {
    try {
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null,
      ): void {
        this.addEventListener(
          "load",
          () => {
            try {
              inspectXhrResponse(this);
            } catch {
              // XHR 解析异常不能影响页面。
            }
          },
          { once: true },
        );
        originalSend.call(this, body);
      };
    } catch {
      // XHR 原型不可写时保持页面原行为。
    }
  }

  function inspectableFetchPathname(response: Response): string | null {
    // These statuses cannot carry a response body, so cloning cannot produce
    // anything for the JSON parser while still allocating a second body stream.
    if (response.status === 204 || response.status === 205 || response.status === 304) return null;
    const pathname = inspectablePathname(response.url, response.headers.get("content-type"));
    if (!pathname) return null;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > MAX_RESPONSE_CHARS) return null;
    return pathname;
  }

  async function inspectFetchResponse(response: Response, pathname: string): Promise<void> {
    try {
      const text = await response.text();
      if (!text || text.length > MAX_RESPONSE_CHARS) return;
      publishNormalizedPayload(JSON.parse(text) as unknown, pathname);
    } catch {
      // 非 JSON 或 clone 读取失败直接忽略。
    }
  }

  function inspectXhrResponse(xhr: XMLHttpRequest): void {
    const pathname = inspectablePathname(xhr.responseURL, xhr.getResponseHeader("content-type"));
    if (!pathname) return;
    let payload: unknown;
    if (xhr.responseType === "json") {
      payload = xhr.response;
    } else if (xhr.responseType === "" || xhr.responseType === "text") {
      const text = xhr.responseText;
      if (!text || text.length > MAX_RESPONSE_CHARS) return;
      payload = JSON.parse(text) as unknown;
    } else {
      return;
    }
    publishNormalizedPayload(payload, pathname);
  }

  function publishNormalizedPayload(payload: unknown, pathname: string): void {
    const result = normalizeVideoItems(payload, "network_response", {
      maxDepth: 10,
      maxNodes: 20_000,
      maxChildrenPerNode: 250,
      maxItems: 300,
    });
    if (result.items.length === 0) return;
    const items = compactItems(result.items);
    publishNormalizedItems(
      NETWORK_EVENT,
      pathname,
      items,
      result.scanned_node_count,
      result.truncated || items.length < result.items.length,
      isPriorityNetworkPath(pathname),
    );
  }

  function scanKnownGlobalHydration(): void {
    const globalScope = bridgeScope as typeof window & Record<string, unknown>;
    for (const name of ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE"] as const) {
      try {
        const payload = globalScope[name];
        if (!payload || typeof payload !== "object") continue;
        const result = normalizeVideoItems(payload, "hydration_json", {
          maxDepth: 12,
          maxNodes: 30_000,
          maxChildrenPerNode: 300,
          maxItems: 1_000,
        });
        if (result.items.length === 0) continue;
        const items = compactItems(result.items);
        const signature = compactPublicSignature(items);
        if (globalStateSignatures.get(name) === signature) continue;
        globalStateSignatures.set(name, signature);
        publishNormalizedItems(
          HYDRATION_EVENT,
          `/__global_state__/${name}`,
          items,
          result.scanned_node_count,
          result.truncated || items.length < result.items.length,
          true,
        );
      } catch {
        // 页面全局状态 getter 或框架对象异常不能影响 TikTok。
      }
    }
  }

  function publishNormalizedItems(
    eventName: string,
    pathname: string,
    items: readonly NormalizedVideoItem[],
    scannedNodeCount: number,
    truncated: boolean,
    priority: boolean,
  ): void {
    const observedAt = new Date().toISOString();
    const details: string[] = [];
    let chunk: NormalizedVideoItem[] = [];
    const serialize = (values: readonly NormalizedVideoItem[]): string => JSON.stringify({
      schema_version: 1,
      pathname,
      items: values,
      normalized_item_count: values.length,
      scanned_node_count: scannedNodeCount,
      matched_video_ids: values.map((item) => item.video_id),
      truncated,
      observed_at: observedAt,
    });

    for (const item of items) {
      const candidate = [...chunk, item];
      const detail = serialize(candidate);
      if (detail.length <= MAX_EVENT_CHARS) {
        chunk = candidate;
        continue;
      }
      if (chunk.length) details.push(serialize(chunk));
      chunk = [item];
      if (serialize(chunk).length > MAX_EVENT_CHARS) chunk = [];
    }
    if (chunk.length) details.push(serialize(chunk));
    for (const detail of details) publishPublicDetail(eventName, detail, priority);
  }

  function publishPublicDetail(name: string, detail: string, priority = false): void {
    if (!networkConsumerReady) {
      queuedPublicEvents.push({ name, detail, priority });
      trimQueuedPublicEvents();
      return;
    }
    dispatchPublicDetail(name, detail);
  }

  function trimQueuedPublicEvents(): void {
    while (queuedPublicEvents.filter((event) => event.priority).length > MAX_PRIORITY_QUEUED_EVENTS) {
      const oldestPriority = queuedPublicEvents.findIndex((event) => event.priority);
      if (oldestPriority < 0) break;
      queuedPublicEvents.splice(oldestPriority, 1);
    }
    while (queuedPublicEvents.length > MAX_QUEUED_EVENTS) {
      const oldestNormal = queuedPublicEvents.findIndex((event) => !event.priority);
      queuedPublicEvents.splice(oldestNormal >= 0 ? oldestNormal : 0, 1);
    }
  }

  function dispatchPublicDetail(name: string, detail: string): void {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function validMediaChunkRequest(value: unknown): value is {
    transfer_id: string;
    media_url: string;
    offset: number;
    chunk_size: number;
  } {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    if (typeof item.transfer_id !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(item.transfer_id)) return false;
    if (typeof item.media_url !== "string" || !isAllowedMediaUrl(item.media_url)) return false;
    return Number.isSafeInteger(item.offset) && Number(item.offset) >= 0 &&
      Number.isSafeInteger(item.chunk_size) && Number(item.chunk_size) >= 16_384 && Number(item.chunk_size) <= 8 * 1024 * 1024;
  }

  function isAllowedMediaUrl(value: string): boolean {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const suffixes = [
        ".tiktok.com", ".tiktokcdn.com", ".tiktokcdn-us.com", ".tiktokv.com",
        ".byteoversea.com", ".ibytedtos.com", ".akamaized.net", ".muscdn.com", ".byteimg.com",
      ];
      return url.protocol === "https:" && !url.username && !url.password &&
        suffixes.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
    } catch {
      return false;
    }
  }

  async function fetchMediaChunkInPage(request: {
    transfer_id: string;
    media_url: string;
    offset: number;
    chunk_size: number;
  }): Promise<Record<string, unknown>> {
    const cached = fullMediaResponses.get(request.transfer_id);
    if (cached) return mediaChunkFromBytes(request, cached.bytes, cached.contentType);

    const end = request.offset + request.chunk_size - 1;
    const requestOptions: RequestInit = {
      cache: "no-store",
      credentials: "include",
      headers: { Range: `bytes=${request.offset}-${end}` },
      referrer: window.location.href,
      referrerPolicy: "strict-origin-when-cross-origin",
    };
    let response = await fetch(request.media_url, requestOptions);
    if (!response.ok && request.offset === 0 && [400, 403, 416].includes(response.status)) {
      // Some TikTok CDN edges reject extension-style Range requests but accept
      // the same signed URL as an ordinary navigation-origin media request.
      response = await fetch(request.media_url, {
        cache: "no-store",
        credentials: "include",
        referrer: window.location.href,
        referrerPolicy: "strict-origin-when-cross-origin",
      });
    }
    if (!response.ok) {
      const failure = new Error(`TikTok 页面读取视频失败（HTTP ${response.status}）`) as Error & { status?: number };
      failure.status = response.status;
      throw failure;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type");
    if (response.status === 200) {
      if (bytes.byteLength > 512 * 1024 * 1024) throw new Error("当前视频过大，无法在浏览器内生成字幕");
      fullMediaResponses.set(request.transfer_id, { bytes, contentType });
      return mediaChunkFromBytes(request, bytes, contentType);
    }
    const contentRange = response.headers.get("content-range")?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
    const totalBytes = contentRange ? Number(contentRange[3]) : request.offset + bytes.byteLength;
    const done = request.offset + bytes.byteLength >= totalBytes;
    return {
      ok: true,
      transfer_id: request.transfer_id,
      offset: request.offset,
      total_bytes: totalBytes,
      chunk_base64: bytesToBase64(bytes),
      done,
      content_type: contentType,
    };
  }

  function mediaChunkFromBytes(
    request: { transfer_id: string; offset: number; chunk_size: number },
    bytes: Uint8Array,
    contentType: string | null,
  ): Record<string, unknown> {
    const chunk = bytes.subarray(request.offset, Math.min(bytes.byteLength, request.offset + request.chunk_size));
    const done = request.offset + chunk.byteLength >= bytes.byteLength;
    if (done) fullMediaResponses.delete(request.transfer_id);
    return {
      ok: true,
      transfer_id: request.transfer_id,
      offset: request.offset,
      total_bytes: bytes.byteLength,
      chunk_base64: bytesToBase64(chunk),
      done,
      content_type: contentType,
    };
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 32_768)));
    }
    return btoa(binary);
  }

  function validDownloadFileName(value: unknown): value is string {
    return typeof value === "string" && value.length > 4 && value.length <= 180 &&
      value.toLowerCase().endsWith(".mp4") && !/[\\/:*?"<>|\u0000-\u001f]/.test(value);
  }

  async function saveMediaFromPage(request: {
    request_id: string;
    media_url: string;
    file_name: string;
  }): Promise<Record<string, unknown>> {
    const baseOptions: RequestInit = {
      cache: "no-store",
      credentials: "include",
      referrer: window.location.href,
      referrerPolicy: "strict-origin-when-cross-origin",
    };
    let response = await fetch(request.media_url, baseOptions);
    if (!response.ok && [400, 403, 416].includes(response.status)) {
      response = await fetch(request.media_url, {
        ...baseOptions,
        headers: { Range: "bytes=0-" },
      });
    }
    if (!response.ok) throw new Error(`TikTok 页面读取视频失败（HTTP ${response.status}）`);
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredSize) && declaredSize > 512 * 1024 * 1024) {
      throw new Error("当前视频过大，无法在浏览器内保存");
    }
    const blob = await response.blob();
    if (!blob.size || blob.size > 512 * 1024 * 1024) throw new Error("TikTok 页面返回的视频文件无效");
    const objectUrl = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "video/mp4" }));
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = request.file_name;
    anchor.hidden = true;
    anchor.rel = "noopener";
    document.documentElement.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
    return { ok: true, request_id: request.request_id, file_name: request.file_name };
  }

  function isPriorityNetworkPath(pathname: string): boolean {
    return /^\/api\/(?:recommend|related)\/item_list\/?$/.test(pathname) ||
      /^\/api\/item\/detail\/?$/.test(pathname);
  }

  function compactItems(items: readonly NormalizedVideoItem[]): NormalizedVideoItem[] {
    return items.slice(0, 1_000).map((item) => ({
      ...item,
      author: {
        unique_id: item.author.unique_id?.slice(0, 128) ?? null,
        nickname: item.author.nickname?.slice(0, 256) ?? null,
      },
      description: item.description?.slice(0, 1_000) ?? null,
    }));
  }

  function compactPublicSignature(items: readonly NormalizedVideoItem[]): string {
    const text = JSON.stringify(items);
    let hash = 2_166_136_261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`;
  }

  function inspectablePathname(urlValue: string, contentType: string | null): string | null {
    try {
      const url = new URL(urlValue, window.location.href);
      const sameOrTikTok =
        url.origin === window.location.origin ||
        url.hostname === "tiktok.com" ||
        url.hostname.endsWith(".tiktok.com");
      if (!sameOrTikTok || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
      const jsonLike = /(?:application|text)\/(?:[^;]+\+)?json/i.test(contentType ?? "");
      if (!jsonLike && !/^\/api\//.test(url.pathname)) return null;
      return url.pathname.slice(0, 300);
    } catch {
      return null;
    }
  }

  function deepFreeze<T>(value: T): Readonly<T> {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
    return value;
  }
})();
