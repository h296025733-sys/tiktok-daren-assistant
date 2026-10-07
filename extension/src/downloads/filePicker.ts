export interface BrowserWritableFile {
  write(data: unknown): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface BrowserSaveFileHandle {
  createWritable(): Promise<BrowserWritableFile>;
  getFile?(): Promise<File>;
}

interface SaveFilePickerType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: SaveFilePickerType[];
  excludeAcceptAllOption?: boolean;
}

type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<BrowserSaveFileHandle>;

export async function pickSaveFile(
  suggestedName: string,
  description: string,
  mimeType: string,
  extension: string,
): Promise<BrowserSaveFileHandle | null> {
  const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (typeof picker !== "function") {
    throw new Error("当前 Chrome 不支持先选择保存位置，请升级 Chrome 后重试");
  }
  try {
    return await picker({
      suggestedName,
      types: [{ description, accept: { [mimeType]: [extension] } }],
      excludeAcceptAllOption: false,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}
