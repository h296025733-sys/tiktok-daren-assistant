import type { BrowserWritableFile } from "./filePicker";

interface ZipEntryRecord {
  name: Uint8Array;
  crc32: number;
  size: number;
  offset: bigint;
  dosDate: number;
  dosTime: number;
}

const encoder = new TextEncoder();
const UTF8_DATA_DESCRIPTOR_FLAGS = 0x0808;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffffn;
const CRC32_TABLE = createCrc32Table();

export interface StoredZipWriterOptions {
  /** Test hook; production always uses the real 4 GiB ZIP32 boundary. */
  zip64Threshold?: bigint;
}

export class StoredZipWriter {
  private readonly entries: ZipEntryRecord[] = [];
  private offset = 0n;
  private closed = false;
  private readonly zip64Threshold: bigint;

  constructor(
    private readonly writable: BrowserWritableFile,
    options: StoredZipWriterOptions = {},
  ) {
    this.zip64Threshold = options.zip64Threshold ?? UINT32_MAX;
  }

  async add(name: string, data: Uint8Array, modifiedAt = new Date()): Promise<void> {
    if (this.closed) throw new Error("ZIP 已经结束写入");
    if (!data.byteLength) throw new Error(`文件 ${name} 内容为空`);
    if (BigInt(data.byteLength) > UINT32_MAX) throw new Error(`文件 ${name} 超过单文件 4GB 限制`);
    const encodedName = encoder.encode(name);
    if (!encodedName.byteLength || encodedName.byteLength > 0xffff) throw new Error("ZIP 内文件名过长");
    const { date, time } = dosDateTime(modifiedAt);
    const entryOffset = this.offset;
    await this.write(localHeader(encodedName, date, time));
    await this.write(data);
    const checksum = crc32(data);
    await this.write(dataDescriptor(checksum, data.byteLength));
    this.entries.push({
      name: encodedName,
      crc32: checksum,
      size: data.byteLength,
      offset: entryOffset,
      dosDate: date,
      dosTime: time,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.entries.length) throw new Error("没有成功生成可写入 ZIP 的文件");
    const centralOffset = this.offset;
    for (const entry of this.entries) await this.write(centralHeader(entry, this.zip64Threshold));
    const centralSize = this.offset - centralOffset;
    const requiresZip64 =
      this.entries.length >= UINT16_MAX ||
      centralSize >= this.zip64Threshold ||
      centralOffset >= this.zip64Threshold ||
      this.entries.some((entry) => entry.offset >= this.zip64Threshold);
    if (requiresZip64) {
      const zip64Offset = this.offset;
      await this.write(zip64EndOfCentralDirectory(this.entries.length, centralSize, centralOffset));
      await this.write(zip64EndOfCentralDirectoryLocator(zip64Offset));
    }
    await this.write(endOfCentralDirectory(this.entries.length, centralSize, centralOffset, requiresZip64));
    await this.writable.close();
    this.closed = true;
  }

  async abort(reason?: unknown): Promise<void> {
    this.closed = true;
    await this.writable.abort?.(reason);
  }

  private async write(data: Uint8Array): Promise<void> {
    await this.writable.write(data);
    this.offset += BigInt(data.byteLength);
  }
}

function localHeader(name: Uint8Array, date: number, time: number): Uint8Array {
  const bytes = new Uint8Array(30 + name.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, UTF8_DATA_DESCRIPTOR_FLAGS, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  view.setUint16(26, name.byteLength, true);
  bytes.set(name, 30);
  return bytes;
}

function dataDescriptor(checksum: number, size: number): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, checksum, true);
  view.setUint32(8, size, true);
  view.setUint32(12, size, true);
  return bytes;
}

function centralHeader(entry: ZipEntryRecord, zip64Threshold = UINT32_MAX): Uint8Array {
  const usesZip64Offset = entry.offset >= zip64Threshold;
  const extraLength = usesZip64Offset ? 12 : 0;
  const bytes = new Uint8Array(46 + entry.name.byteLength + extraLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, usesZip64Offset ? 45 : 20, true);
  view.setUint16(6, usesZip64Offset ? 45 : 20, true);
  view.setUint16(8, UTF8_DATA_DESCRIPTOR_FLAGS, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, entry.dosTime, true);
  view.setUint16(14, entry.dosDate, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.size, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.name.byteLength, true);
  view.setUint16(30, extraLength, true);
  view.setUint32(42, usesZip64Offset ? Number(UINT32_MAX) : Number(entry.offset), true);
  bytes.set(entry.name, 46);
  if (usesZip64Offset) {
    const extraOffset = 46 + entry.name.byteLength;
    view.setUint16(extraOffset, 0x0001, true);
    view.setUint16(extraOffset + 2, 8, true);
    view.setBigUint64(extraOffset + 4, entry.offset, true);
  }
  return bytes;
}

function endOfCentralDirectory(
  entries: number,
  size: bigint,
  offset: bigint,
  usesZip64: boolean,
): Uint8Array {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, usesZip64 ? UINT16_MAX : entries, true);
  view.setUint16(10, usesZip64 ? UINT16_MAX : entries, true);
  view.setUint32(12, usesZip64 ? Number(UINT32_MAX) : Number(size), true);
  view.setUint32(16, usesZip64 ? Number(UINT32_MAX) : Number(offset), true);
  return bytes;
}

function zip64EndOfCentralDirectory(entries: number, size: bigint, offset: bigint): Uint8Array {
  const bytes = new Uint8Array(56);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06064b50, true);
  view.setBigUint64(4, 44n, true);
  view.setUint16(12, 45, true);
  view.setUint16(14, 45, true);
  view.setBigUint64(24, BigInt(entries), true);
  view.setBigUint64(32, BigInt(entries), true);
  view.setBigUint64(40, size, true);
  view.setBigUint64(48, offset, true);
  return bytes;
}

function zip64EndOfCentralDirectoryLocator(zip64Offset: bigint): Uint8Array {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x07064b50, true);
  view.setBigUint64(8, zip64Offset, true);
  view.setUint32(16, 1, true);
  return bytes;
}

function dosDateTime(value: Date): { date: number; time: number } {
  const year = Math.max(1980, Math.min(2107, value.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffff_ffff) >>> 0;
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
    }
    table[value] = crc >>> 0;
  }
  return table;
}
