// IP address parsing and classification for the SSRF guard (D94 "Safety"). Pure, no I/O.
//
// Rule: an address is public only when it is positively known to be (default deny). IPv4 legacy spellings that
// inet_aton accepts (decimal, octal, hex, short forms) are parsed the way a C resolver would, so a spelling that
// reaches a socket as 127.0.0.1 is classified as 127.0.0.1. IPv6 forms that embed an IPv4 address (IPv4-mapped,
// NAT64, 6to4) are classified by the embedded address.

export interface ParsedAddress {
  family: 4 | 6;
  bytes: Uint8Array;
}

export interface Verdict {
  public: boolean;
  /** Present when `public` is false: a stable, short category name. */
  reason?: string;
}

export interface Cidr {
  family: 4 | 6;
  bytes: Uint8Array;
  prefix: number;
}

function parseV4Part(s: string): number | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) return Number.parseInt(s.slice(2), 16);
  if (/^0[0-7]*$/.test(s)) return s.length === 1 ? 0 : Number.parseInt(s, 8);
  if (/^[1-9][0-9]*$/.test(s)) return Number.parseInt(s, 10);
  return null;
}

function parseV4(s: string, strict: boolean): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  if (strict && parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (strict && !/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = parseV4Part(p);
    if (n === null || !Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1]!;
  const lastBytes = 5 - nums.length; // the last part fills the remaining bytes
  if (last >= 256 ** lastBytes) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i]! > 255) return null;
    out[i] = nums[i]!;
  }
  for (let i = 0; i < lastBytes; i++) out[3 - i] = Math.floor(last / 256 ** i) % 256;
  return out;
}

function parseV6(s: string): Uint8Array | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(":")) return null; // no zone ids, no junk
  let head = s;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = parseV4(s.slice(lastColon + 1), true);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    head = s.slice(0, lastColon + 1);
    if (!head.endsWith("::")) head = head.slice(0, -1);
  }
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const g: number[] = [];
    for (const h of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
      g.push(Number.parseInt(h, 16));
    }
    return g;
  };
  let groups: number[];
  const dbl = head.indexOf("::");
  if (dbl !== head.lastIndexOf("::")) return null;
  if (dbl >= 0) {
    const a = toGroups(head.slice(0, dbl));
    const b = toGroups(head.slice(dbl + 2));
    if (!a || !b) return null;
    const fill = 8 - a.length - b.length - tail.length;
    if (fill < 1) return null;
    groups = [...a, ...new Array<number>(fill).fill(0), ...b, ...tail];
  } else {
    const a = toGroups(head);
    if (!a) return null;
    groups = [...a, ...tail];
  }
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    out[i * 2] = g >> 8;
    out[i * 2 + 1] = g & 0xff;
  });
  return out;
}

/** Parse an IP literal (brackets allowed). `strict` accepts only canonical dotted-quad IPv4 (for configuration). */
export function parseAddress(input: string, opts: { strict?: boolean } = {}): ParsedAddress | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s === "") return null;
  if (s.includes(":")) {
    const b = parseV6(s);
    return b ? { family: 6, bytes: b } : null;
  }
  const b = parseV4(s, opts.strict === true);
  return b ? { family: 4, bytes: b } : null;
}

const isV4Mapped = (b: Uint8Array): boolean => b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;

/** IPv4-mapped IPv6 addresses become the IPv4 address they carry; everything else is returned unchanged. */
export function canonical(a: ParsedAddress): ParsedAddress {
  return a.family === 6 && isV4Mapped(a.bytes) ? { family: 4, bytes: a.bytes.slice(12) } : a;
}

const v4Ranges: Array<[Cidr, string]> = [];
const addV4 = (cidr: string, reason: string): void => {
  const c = parseCidr(cidr);
  if (c) v4Ranges.push([c, reason]);
};
addV4("0.0.0.0/8", "unspecified");
addV4("10.0.0.0/8", "private");
addV4("100.64.0.0/10", "shared-address-space"); // CGNAT; also Alibaba metadata 100.100.100.200
addV4("127.0.0.0/8", "loopback");
addV4("169.254.0.0/16", "link-local"); // includes the cloud metadata address 169.254.169.254
addV4("172.16.0.0/12", "private");
addV4("192.0.0.0/24", "reserved");
addV4("192.0.2.0/24", "reserved");
addV4("192.88.99.0/24", "reserved");
addV4("192.168.0.0/16", "private");
addV4("198.18.0.0/15", "reserved");
addV4("198.51.100.0/24", "reserved");
addV4("203.0.113.0/24", "reserved");
addV4("224.0.0.0/4", "multicast");
addV4("240.0.0.0/4", "reserved");

const v6Ranges: Array<[Cidr, string]> = [];
const addV6 = (cidr: string, reason: string): void => {
  const c = parseCidr(cidr);
  if (c) v6Ranges.push([c, reason]);
};
addV6("::/128", "unspecified");
addV6("::1/128", "loopback");
addV6("::/96", "reserved"); // IPv4-compatible (deprecated)
addV6("64:ff9b:1::/48", "reserved");
addV6("100::/64", "reserved");
addV6("2001::/23", "reserved"); // IETF protocol assignments incl. Teredo
addV6("2001:db8::/32", "reserved");
addV6("3fff::/20", "reserved");
addV6("fc00::/7", "private"); // ULA, includes fd00:ec2::254 (AWS)
addV6("fe80::/10", "link-local");
addV6("fec0::/10", "reserved"); // deprecated site-local
addV6("ff00::/8", "multicast");

export function inCidr(a: ParsedAddress, c: Cidr): boolean {
  const addr = canonical(a);
  if (addr.family !== c.family) return false;
  let bits = c.prefix;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((addr.bytes[i]! & mask) !== (c.bytes[i]! & mask)) return false;
  }
  return true;
}

/** `addr` or `addr/prefix`; a bare address is a host route. Canonical dotted-quad only for IPv4. */
export function parseCidr(input: string): Cidr | null {
  const parts = input.split("/");
  if (parts.length > 2) return null;
  const a = parseAddress(parts[0]!, { strict: true });
  if (!a) return null;
  const max = a.family === 4 ? 32 : 128;
  let prefix = max;
  if (parts.length === 2) {
    if (!/^[0-9]{1,3}$/.test(parts[1]!)) return null;
    prefix = Number.parseInt(parts[1]!, 10);
    if (prefix > max) return null;
  }
  return { family: a.family, bytes: a.bytes, prefix };
}

function classifyV4(bytes: Uint8Array): Verdict {
  const a: ParsedAddress = { family: 4, bytes };
  if (bytes.every((x) => x === 255)) return { public: false, reason: "reserved" }; // limited broadcast
  for (const [c, reason] of v4Ranges) if (inCidr(a, c)) return { public: false, reason };
  return { public: true };
}

export function classifyAddress(input: ParsedAddress): Verdict {
  const a = canonical(input);
  if (a.family === 4) return classifyV4(a.bytes);
  const b = a.bytes;
  const w = (i: number) => (b[i]! << 8) | b[i + 1]!;
  // NAT64 (RFC 6052) and 6to4 carry an IPv4 address: judge that one.
  if (w(0) === 0x64 && w(2) === 0xff9b && b.slice(4, 12).every((x) => x === 0)) return classifyV4(b.slice(12));
  if (w(0) === 0x2002) return classifyV4(b.slice(2, 6));
  for (const [c, reason] of v6Ranges) if (inCidr(a, c)) return { public: false, reason };
  // Only global unicast 2000::/3 is public; everything else is unassigned or special.
  if ((b[0]! & 0xe0) !== 0x20) return { public: false, reason: "reserved" };
  return { public: true };
}
