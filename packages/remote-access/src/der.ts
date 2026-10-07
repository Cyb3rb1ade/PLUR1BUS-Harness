// A minimal ASN.1 DER writer and reader: just enough to build an X.509 certificate (x509.ts) and to pick the public
// key bits out of a SubjectPublicKeyInfo. Why it exists: node:crypto can parse certificates (X509Certificate) and sign,
// but it cannot create one, and the work package forbids new runtime dependencies and shelling out to an external certificate tool. The
// builder is small, deterministic and fully covered by tests (der.test.ts, selfsigned.test.ts, pinning-e2e.test.ts
// feed its output to node:tls and X509Certificate, which are independent parsers).

export function concat(parts: readonly Uint8Array[]): Buffer {
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}

function lengthOctets(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Uint8Array): Buffer {
  return concat([Buffer.from([tag]), lengthOctets(content.length), content]);
}

export const seq = (...parts: Uint8Array[]): Buffer => tlv(0x30, concat(parts));
export const set = (...parts: Uint8Array[]): Buffer => tlv(0x31, concat(parts));
/** Explicit context-specific constructed tag [n]. */
export const ctx = (n: number, ...parts: Uint8Array[]): Buffer => tlv(0xa0 | n, concat(parts));
/** Implicit context-specific primitive tag [n]. */
export const ctxPrimitive = (n: number, content: Uint8Array): Buffer => tlv(0x80 | n, content);
export const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
export const nul = (): Buffer => tlv(0x05, new Uint8Array(0));
export const octets = (b: Uint8Array): Buffer => tlv(0x04, b);
export const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
export const ia5 = (s: string): Buffer => tlv(0x16, Buffer.from(s, "latin1"));

export function bitString(bytes: Uint8Array, unusedBits = 0): Buffer {
  if (!Number.isInteger(unusedBits) || unusedBits < 0 || unusedBits > 7) throw new Error("bit string: unused bits must be 0..7");
  return tlv(0x03, concat([Buffer.from([unusedBits]), bytes]));
}

export function integerFromBytes(bytes: Uint8Array): Buffer {
  if (bytes.length === 0) throw new Error("integer: no bytes");
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const body = bytes.subarray(i);
  return tlv(0x02, body[0]! >= 0x80 ? concat([Buffer.from([0]), body]) : body);
}

export function integerFromNumber(n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("integer: must be a non-negative safe integer");
  const bytes: number[] = [];
  for (let v = n; ; v = Math.floor(v / 256)) {
    bytes.unshift(v & 0xff);
    if (v < 256) break;
  }
  return integerFromBytes(Uint8Array.from(bytes));
}

function base128(v: number): number[] {
  const out = [v & 0x7f];
  for (let r = Math.floor(v / 128); r > 0; r = Math.floor(r / 128)) out.unshift((r & 0x7f) | 0x80);
  return out;
}

export function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map((a) => (/^\d+$/.test(a) ? Number(a) : NaN));
  if (arcs.length < 2 || arcs.some((a) => !Number.isSafeInteger(a)) || arcs[0]! > 2 || (arcs[0]! < 2 && arcs[1]! > 39)) {
    throw new Error(`invalid oid ${dotted}`);
  }
  const body = [...base128(arcs[0]! * 40 + arcs[1]!), ...arcs.slice(2).flatMap(base128)];
  return tlv(0x06, Uint8Array.from(body));
}

/** UTCTime for 1950..2049, GeneralizedTime otherwise (RFC 5280 §4.1.2.5). */
export function time(d: Date): Buffer {
  if (Number.isNaN(d.getTime())) throw new Error("time: invalid date");
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y >= 1950 && y <= 2049
    ? tlv(0x17, Buffer.from(`${p(y % 100)}${rest}`, "latin1"))
    : tlv(0x18, Buffer.from(`${p(y, 4)}${rest}`, "latin1"));
}

// --- reader --------------------------------------------------------------------------------------------------------

export interface Tlv {
  readonly tag: number;
  /** Offset of the first content byte. */
  readonly start: number;
  /** Offset one past the last content byte. */
  readonly end: number;
}

export function readTlv(buf: Uint8Array, offset: number): Tlv {
  if (offset >= buf.length) throw new Error("der: truncated (no tag)");
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new Error("der: unsupported high tag number");
  if (offset + 1 >= buf.length) throw new Error("der: truncated (no length)");
  const first = buf[offset + 1]!;
  let len: number;
  let start: number;
  if (first < 0x80) {
    len = first;
    start = offset + 2;
  } else if (first === 0x80) {
    throw new Error("der: indefinite length is not DER");
  } else {
    const n = first & 0x7f;
    if (n > 4) throw new Error("der: length too large");
    if (offset + 2 + n > buf.length) throw new Error("der: truncated (length octets)");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i]!;
    start = offset + 2 + n;
  }
  if (start + len > buf.length) throw new Error("der: truncated (content)");
  return { tag, start, end: start + len };
}

/** The direct children of a constructed value's content bytes. */
export function children(content: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  for (let at = 0; at < content.length; ) {
    const t = readTlv(content, at);
    out.push(t);
    at = t.end;
  }
  return out;
}
