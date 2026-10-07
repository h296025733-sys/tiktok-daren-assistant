declare const __TDA_CHROME_ONLY__: boolean;

/**
 * Compile-time release flavor. The colleague package sets this to true so it
 * never probes a stale localhost backend or exposes a native model installer.
 */
export const CHROME_ONLY_MODE =
  typeof __TDA_CHROME_ONLY__ !== "undefined" && __TDA_CHROME_ONLY__;

export const CHROME_ONLY_BUILD_MARKER = CHROME_ONLY_MODE
  ? "TDA_CHROME_ONLY_ACTIVE"
  : "TDA_HYBRID_ACTIVE";

let loopbackGuardInstalled = false;

/** Final safety boundary for the colleague build, including machines that still
 * have an older backend listening on port 8765. */
export function installChromeOnlyLoopbackGuard(
  enabled = CHROME_ONLY_MODE,
  allowedLoopbackOrigins: readonly string[] = [],
): void {
  if (!enabled || loopbackGuardInstalled) return;
  const allowedOrigins = new Set(allowedLoopbackOrigins);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    let url: URL | null = null;
    try {
      url = new URL(rawUrl, globalThis.location?.href);
    } catch {
      // Let the browser report malformed non-loopback requests normally.
    }
    if (
      url &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      !allowedOrigins.has(url.origin)
    ) {
      return Promise.reject(new TypeError("TDA_CHROME_ONLY_LOOPBACK_BLOCKED"));
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
  loopbackGuardInstalled = true;
}
