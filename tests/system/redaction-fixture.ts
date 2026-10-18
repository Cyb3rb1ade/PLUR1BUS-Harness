import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync, gunzipSync } from "node:zlib";

/** One inventory for both execution and schema drift detection. Absent surfaces are explicit. */
export const REDACTION_CHANNELS = {
  logs: [], api: [], agentExport: ["agent.export"], backup: ["admin.backup.snapshot"],
  importReports: [], bundle: [], doctor: ["doctor.report"],
} as const;
export const ABSENT_EXPORTS = ["session.export", "config.export"] as const;
export const MARKERS = ["vault", "provider", "channel", "mcp", "import"].map(n => `redact-probe-${n}-alpha /+\"`);
export function forms(s: string): string[] {
  return [...new Set([s, `Bearer ${s}`, encodeURIComponent(s), JSON.stringify(s).slice(1, -1), Buffer.from(s).toString("base64"), Buffer.from(s).toString("base64url")])];
}
export function leaks(channel: string, path: string, bytes: string | Buffer): string[] {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("latin1") : bytes;
  return MARKERS.flatMap((s, i) => forms(s).some(f => text.includes(f)) ? [`${channel}: ${path} (marker ${i})`] : []);
}
export function put(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
export function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(root, e.name)) : e.isFile() ? [join(root, e.name)] : []);
}
/** Read every regular tar entry; neither extracts paths nor executes archive contents. */
export function tarEntries(path: string): Array<[string, Buffer]> {
  const bytes = gunzipSync(readFileSync(path)), entries: Array<[string, Buffer]> = [];
  for (let at = 0; at + 512 <= bytes.length && bytes[at] !== 0;) {
    const name = bytes.subarray(at, at + 100).toString().replace(/\0.*$/s, "");
    const size = parseInt(bytes.subarray(at + 124, at + 136).toString().replace(/\0.*$/s, "").trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > bytes.length) throw new Error("invalid tar entry");
    if (bytes[at + 156] === 48 || bytes[at + 156] === 0) entries.push([name, bytes.subarray(at + 512, at + 512 + size)]);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
/** Use the central directory, including entries whose local header uses a data descriptor. */
export function zipEntries(path: string): Array<[string, Buffer]> {
  const b = readFileSync(path), out: Array<[string, Buffer]> = [];
  let end = b.length - 22;
  while (end >= 0 && b.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("missing ZIP directory");
  let at = b.readUInt32LE(end + 16);
  for (let i = 0; i < b.readUInt16LE(end + 10); i++) {
    if (b.readUInt32LE(at) !== 0x02014b50) throw new Error("invalid ZIP directory");
    const method = b.readUInt16LE(at + 10), size = b.readUInt32LE(at + 20), n = b.readUInt16LE(at + 28), extra = b.readUInt16LE(at + 30), comment = b.readUInt16LE(at + 32), local = b.readUInt32LE(at + 42);
    const name = b.subarray(at + 46, at + 46 + n).toString();
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + size);
    if (![0, 8].includes(method)) throw new Error("unsupported ZIP compression");
    out.push([name, method === 8 ? inflateRawSync(raw) : raw]);
    at += 46 + n + extra + comment;
  }
  return out;
}
