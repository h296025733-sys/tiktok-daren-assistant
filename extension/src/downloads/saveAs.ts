export const LOCAL_API_BASE = "http://localhost:8765";

const ALLOWED_DELIVERY_ORIGINS = new Set([
  "http://localhost:8765",
  "http://127.0.0.1:8765",
]);
const DELIVERY_PATH_PREFIX = "/api/v1/downloads/files/";

export interface DownloadableFile {
  file_name: string;
  size_bytes: number;
  download_url: string | null;
  kind?: string;
}

export interface SaveDownloadOptions {
  saveAs?: boolean;
}

/**
 * Save one backend-generated staging file through Chrome's native Save As UI.
 * The backend URL is opaque and scoped to the local delivery endpoint; callers
 * never pass a filesystem path to either Chrome or the backend.
 */
export async function saveDownloadFileAs(
  file: DownloadableFile,
  options: SaveDownloadOptions = {},
): Promise<number> {
  const url = resolveStagedDownloadUrl(file.download_url);
  return chrome.downloads.download({
    url,
    filename: safeSuggestedFilename(file.file_name),
    saveAs: options.saveAs ?? true,
    conflictAction: "uniquify",
  });
}

/** Save files one at a time so each non-batch artifact receives an explicit location choice. */
export async function saveDownloadFilesAs(
  files: readonly DownloadableFile[],
  options: SaveDownloadOptions = {},
): Promise<number[]> {
  const ids: number[] = [];
  for (const file of files) ids.push(await saveDownloadFileAs(file, options));
  return ids;
}

export function resolveStagedDownloadUrl(value: string | null | undefined): string {
  if (!value) throw new Error("本地服务未返回可保存的文件，请重试");
  let parsed: URL;
  try {
    parsed = new URL(value, LOCAL_API_BASE);
  } catch {
    throw new Error("本地服务返回了无效下载链接");
  }
  if (
    !ALLOWED_DELIVERY_ORIGINS.has(parsed.origin) ||
    !parsed.pathname.startsWith(DELIVERY_PATH_PREFIX) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("本地服务返回了不受信任的下载链接");
  }
  return parsed.href;
}

export function safeSuggestedFilename(value: string): string {
  const cleaned = value
    .replace(/[\\/\x00-\x1f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 180)
    .trim();
  return cleaned || "TikTok_下载文件";
}
