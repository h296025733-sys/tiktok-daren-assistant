import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveStagedDownloadUrl,
  safeSuggestedFilename,
  saveDownloadFileAs,
  saveDownloadFilesAs,
} from "../src/downloads/saveAs";

const download = vi.fn(async () => 42);

describe("Chrome 原生另存为", () => {
  beforeEach(() => {
    download.mockClear();
    vi.stubGlobal("chrome", { downloads: { download } });
  });

  it("只接受本地服务签发的一次性下载 URL，并启用 saveAs", async () => {
    await saveDownloadFileAs({
      kind: "video",
      file_name: "20260721_author_7654207540028394774_title.mp4",
      size_bytes: 123,
      download_url: "/api/v1/downloads/files/opaque_token-123",
    });
    expect(download).toHaveBeenCalledWith({
      url: "http://localhost:8765/api/v1/downloads/files/opaque_token-123",
      filename: "20260721_author_7654207540028394774_title.mp4",
      saveAs: true,
      conflictAction: "uniquify",
    });
  });

  it("逐个保存单条文件，拒绝任意远程地址和路径式文件名", async () => {
    await saveDownloadFilesAs([
      { file_name: "a.mp4", size_bytes: 1, download_url: "/api/v1/downloads/files/a" },
      { file_name: "b.m4a", size_bytes: 1, download_url: "/api/v1/downloads/files/b" },
    ]);
    expect(download).toHaveBeenCalledTimes(2);
    expect(() => resolveStagedDownloadUrl("https://evil.example/file")).toThrow("不受信任");
    expect(() => resolveStagedDownloadUrl("/api/v1/downloads/files/a?path=C:/secret")).toThrow("不受信任");
    expect(safeSuggestedFilename("../../bad:name.mp4")).toBe("_.._bad_name.mp4");
  });
});
