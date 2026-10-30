/** A browser folder becomes a store-only ZIP Blob. File bodies remain Blob parts; only CRC chunks are read. */
const encoder = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function safePath(file: File): string {
  const relative = file.webkitRelativePath || file.name;
  const path = (file.webkitRelativePath ? relative.split("/").slice(1).join("/") : relative).normalize("NFC");
  const segments = path.split("/");
  if (
    !path ||
    encoder.encode(path).length > 240 ||
    segments.length > 16 ||
    /[\\\u0000-\u001f\u007f]/.test(path) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) ||
        segment.includes(":"),
    )
  )
    throw new Error("unsafe folder path");
  return path;
}
async function checksum(file: File, signal?: AbortSignal): Promise<number> {
  const reader = file.stream().getReader();
  let crc = 0xffffffff;
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel();
        signal.throwIfAborted();
      }
      const { value, done } = await reader.read();
      if (done) break;
      for (const byte of value) crc = table[(crc ^ byte) & 255]! ^ (crc >>> 8);
    }
  } finally {
    reader.releaseLock();
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export async function archiveFolder(
  files: readonly File[],
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<Blob> {
  const max = options.maxBytes ?? 1073741824;
  if (!files.length || files.length > 20000 || !Number.isSafeInteger(max) || max < 1) throw new Error("folder limit");
  const paths = new Set<string>(),
    parts: BlobPart[] = [],
    directory: Uint8Array<ArrayBuffer>[] = [];
  let size = 0,
    offset = 0;
  for (const file of files) {
    options.signal?.throwIfAborted();
    const path = safePath(file),
      folded = path.toLowerCase(),
      name = encoder.encode(path);
    if (paths.has(folded) || file.size > 128 * 1024 * 1024) throw new Error("folder limit or ambiguous path");
    paths.add(folded);
    size += file.size + 76 + 2 * name.length;
    if (size + 22 > max) throw new Error("folder limit");
    const crc = await checksum(file, options.signal),
      local = new Uint8Array(30 + name.length),
      header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x800, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, file.size, true);
    header.setUint32(22, file.size, true);
    header.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length),
      record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 0x314, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x800, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, file.size, true);
    record.setUint32(24, file.size, true);
    record.setUint16(28, name.length, true);
    record.setUint32(38, 0o100644 << 16, true);
    record.setUint32(42, offset, true);
    central.set(name, 46);
    parts.push(local, file);
    directory.push(central);
    offset += local.length + file.size;
  }
  const end = new Uint8Array(22),
    record = new DataView(end.buffer),
    centralSize = directory.reduce((total, value) => total + value.length, 0);
  record.setUint32(0, 0x06054b50, true);
  record.setUint16(8, files.length, true);
  record.setUint16(10, files.length, true);
  record.setUint32(12, centralSize, true);
  record.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}
