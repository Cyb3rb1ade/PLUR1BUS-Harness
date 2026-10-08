// IP address parsing, CIDR matching and address scopes. Pure functions, no I/O, node:net only for the syntax check.
// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are normalised to plain IPv4: a dual-stack listener reports an IPv4
// client that way, and an allow-list rule written as 10.0.0.0/8 has to match it.
import { isIPv6 } from "node:net";

export interface ParsedIp {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
}
export interface ParsedCidr extends ParsedIp {
  readonly prefix: number;
}
export type AddressScope = "loopback" | "private" | "link-local" | "cgnat" | "unspecified" | "public";

function parseV4(text: string): Uint8Array | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return undefined;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = m[i + 1]!;
    if (part.length > 1 && part.startsWith("0")) return undefined; // no leading zeros: ambiguous (octal) in some stacks
    const n = Number(part);
    if (n > 255) return undefined;
    out[i] = n;
  }
  return out;
}

/** The 16 raw bytes of an IPv6 text form, without any mapped-address normalisation. */
function parseV6Raw(input: string): Uint8Array | undefined {
  const text = input.includes("%") ? input.slice(0, input.indexOf("%")) : input;
  if (!isIPv6(text)) return undefined;
  let head = text;
  let tail4: Uint8Array | undefined;
  const dot = text.lastIndexOf(".");
  if (dot !== -1) {
    const colon = text.lastIndexOf(":");
    tail4 = parseV4(text.slice(colon + 1));
    if (!tail4) return undefined;
    head = text.slice(0, colon + 1) + "0:0";
  }
  const halves = head.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const left = toGroups(halves[0]!);
  const right = halves.length === 2 ? toGroups(halves[1]!) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    const v = parseInt(g, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  if (tail4) out.set(tail4, 12);
  return out;
}

function isMapped(b: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return false;
  return b[10] === 0xff && b[11] === 0xff;
}

export function parseIp(text: string): ParsedIp | undefined {
  const v4 = parseV4(text);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseV6Raw(text);
  if (!v6) return undefined;
  return isMapped(v6) ? { family: 4, bytes: v6.slice(12) } : { family: 6, bytes: v6 };
}

function maskBytes(bytes: Uint8Array, prefix: number): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    out[i] = bytes[i]! & (bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff);
  }
  return out;
}

export function parseCidr(text: string): ParsedCidr | undefined {
  const parts = text.split("/");
  if (parts.length > 2 || parts[0] === "" || text.includes("%")) return undefined;
  const ipText = parts[0]!;
  let prefix: number | undefined;
  if (parts.length === 2) {
    if (!/^\d{1,3}$/.test(parts[1]!)) return undefined;
    prefix = Number(parts[1]);
  }
  const v4 = parseV4(ipText);
  if (v4) {
    const p = prefix ?? 32;
    return p > 32 ? undefined : { family: 4, bytes: maskBytes(v4, p), prefix: p };
  }
  const raw = parseV6Raw(ipText);
  if (!raw) return undefined;
  const p = prefix ?? 128;
  if (p > 128) return undefined;
  // A mapped range that stays inside ::ffff:0:0/96 is the IPv4 range it names; a wider one keeps its IPv6 meaning.
  if (isMapped(raw) && p >= 96) return { family: 4, bytes: maskBytes(raw.slice(12), p - 96), prefix: p - 96 };
  return { family: 6, bytes: maskBytes(raw, p), prefix: p };
}

function formatV6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

export function formatIp(ip: ParsedIp): string {
  return ip.family === 4 ? Array.from(ip.bytes).join(".") : formatV6(ip.bytes);
}

export function formatCidr(cidr: ParsedCidr): string {
  return `${formatIp(cidr)}/${cidr.prefix}`;
}

function matches(net: Uint8Array, ip: Uint8Array, prefix: number): boolean {
  const masked = maskBytes(ip, prefix);
  for (let i = 0; i < net.length; i++) if (net[i] !== masked[i]) return false;
  return true;
}

export function cidrContains(cidr: ParsedCidr, ip: ParsedIp): boolean {
  if (cidr.family === ip.family) return matches(cidr.bytes, ip.bytes, cidr.prefix);
  if (cidr.family === 6 && ip.family === 4) {
    // An IPv4 client on a dual-stack socket really is ::ffff:a.b.c.d; a wide IPv6 rule (::/0) covers it.
    const mapped = new Uint8Array(16);
    mapped[10] = 0xff;
    mapped[11] = 0xff;
    mapped.set(ip.bytes, 12);
    return matches(cidr.bytes, mapped, cidr.prefix);
  }
  return false;
}

export function addressScope(ip: ParsedIp): AddressScope {
  const b = ip.bytes;
  if (ip.family === 4) {
    if (b[0] === 127) return "loopback";
    if (b[0] === 0) return "unspecified";
    if (b[0] === 10) return "private";
    if (b[0] === 172 && b[1]! >= 16 && b[1]! <= 31) return "private";
    if (b[0] === 192 && b[1] === 168) return "private";
    if (b[0] === 169 && b[1] === 254) return "link-local";
    if (b[0] === 100 && b[1]! >= 64 && b[1]! <= 127) return "cgnat";
    return "public";
  }
  if (b.every((x, i) => (i === 15 ? x === 1 : x === 0))) return "loopback";
  if (b.every((x) => x === 0)) return "unspecified";
  if ((b[0]! & 0xfe) === 0xfc) return "private";
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "link-local";
  return "public";
}
