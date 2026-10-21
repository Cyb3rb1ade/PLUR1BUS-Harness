// Read-only facts about a certificate, computed with node's own X.509 parser (an independent check of anything the
// DER builder produced) and an injected clock.
import { children, readTlv } from "./der.ts";
import { formatIp, parseIp } from "./net-address.ts";
import { certPin, formatHex, sha256, spkiPin, toX509 } from "./fingerprint.ts";
import type { CertInput, Pin } from "./fingerprint.ts";

export interface CertInfo {
  readonly subject: string;
  readonly issuer: string;
  readonly dns: readonly string[];
  /** IP addresses from the SAN, in canonical (compressed IPv6) form. */
  readonly ips: readonly string[];
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly isCa: boolean;
  readonly selfSigned: boolean;
  readonly certPin: Pin;
  readonly spkiPin: Pin;
  /** `AB:CD:…` SHA-256 of the DER, for display next to the pin. */
  readonly fingerprintHex: string;
  readonly expired: boolean;
  readonly notYetValid: boolean;
  /** Whole days until notAfter (negative once expired). */
  readonly daysLeft: number;
}

const DAY_MS = 86_400_000;

/** Splits node's `subjectAltName` string ("DNS:a, IP Address:1.2.3.4") into DNS names and IP addresses. */
export function parseSan(san: string | undefined): { dns: string[]; ips: string[] } {
  const dns: string[] = [];
  const ips: string[] = [];
  if (!san) return { dns, ips };
  for (const part of san.split(/, (?=DNS:|IP Address:|email:|URI:|Registered ID:|othername:)/)) {
    if (part.startsWith("DNS:")) dns.push(part.slice(4).toLowerCase());
    else if (part.startsWith("IP Address:")) {
      const ip = parseIp(part.slice(11));
      if (ip) ips.push(formatIp(ip));
    }
  }
  return { dns, ips };
}

export function inspectCertificate(input: CertInput, now: Date): CertInfo {
  const x = toX509(input);
  const notBefore = new Date(x.validFromDate);
  const notAfter = new Date(x.validToDate);
  const readable = Number.isFinite(notBefore.getTime()) && Number.isFinite(notAfter.getTime());
  let selfSigned = false;
  try { selfSigned = x.subject === x.issuer && x.verify(x.publicKey); } catch { selfSigned = false; }
  const { dns, ips } = parseSan(x.subjectAltName);
  return {
    subject: x.subject.replace(/\n/g, ", "),
    issuer: x.issuer.replace(/\n/g, ", "),
    dns, ips, notBefore, notAfter,
    isCa: x.ca,
    selfSigned,
    certPin: certPin(x),
    spkiPin: spkiPin(x),
    fingerprintHex: formatHex(sha256(x.raw)),
    // A validity period that cannot be read is never "valid": every comparison with an Invalid Date is false, which would read as fine.
    expired: !readable || now.getTime() > notAfter.getTime(),
    notYetValid: readable && now.getTime() < notBefore.getTime(),
    daysLeft: readable ? Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS) : -1,
  };
}

/**
 * The certificate extensions a TLS client of this harness understands, all under 2.5.29: keyUsage (15), subjectAltName (17),
 * basicConstraints (19), nameConstraints (30), cRLDistributionPoints (31) and extendedKeyUsage (37). This is exactly the set
 * rustls-webpki "remembers" in `cert.rs` (version 0.103.x, the one in Cargo.lock): it refuses a certificate with
 * `UnsupportedCriticalExtension` for any other critical extension, including subjectKeyIdentifier, authorityKeyIdentifier
 * and certificatePolicies. A non-critical extension of any kind is ignored by clients. Keep this list in step with the
 * rustls-webpki version in Cargo.lock.
 */
export const CLIENT_UNDERSTOOD_EXTENSIONS: readonly string[] = ["2.5.29.15", "2.5.29.17", "2.5.29.19", "2.5.29.30", "2.5.29.31", "2.5.29.37"];

function dottedOid(der: Uint8Array, from: number, to: number): string {
  const arcs: bigint[] = []; let acc = 0n;
  for (let i = from; i < to; i++) { acc = (acc << 7n) | BigInt(der[i]! & 0x7f); if ((der[i]! & 0x80) === 0) { arcs.push(acc); acc = 0n; } }
  if (to <= from || (der[to - 1]! & 0x80) !== 0 || arcs.length === 0) throw new Error("der: malformed object identifier");
  const first = arcs[0]! < 40n ? 0n : arcs[0]! < 80n ? 1n : 2n;
  return [first, arcs[0]! - first * 40n, ...arcs.slice(1)].join(".");
}

/**
 * The OIDs of the critical extensions of a certificate that clients do not understand (see CLIENT_UNDERSTOOD_EXTENSIONS),
 * in certificate order. Node's X509Certificate does not expose the extension list, so this reads the DER itself.
 * Throws an `Error("der: …")` when the extension block is not shaped as RFC 5280 says: callers fail closed on that.
 */
export function unknownCriticalExtensions(input: CertInput): string[] {
  const der = toX509(input).raw;
  const kids = (from: number, to: number) => children(der.subarray(from, to)).map((t) => ({ tag: t.tag, start: t.start + from, end: t.end + from }));
  const cert = readTlv(der, 0); const tbs = kids(cert.start, cert.end)[0];
  if (!tbs || tbs.tag !== 0x30) throw new Error("der: no TBSCertificate");
  const wrapper = kids(tbs.start, tbs.end).find((t) => t.tag === 0xa3);
  if (!wrapper) return [];                                                                   // a v1 certificate or one without extensions: nothing critical
  const list = readTlv(der, wrapper.start); if (list.tag !== 0x30) throw new Error("der: extensions are not a sequence");
  const out: string[] = [];
  for (const e of kids(list.start, list.end)) {
    const parts = kids(e.start, e.end);
    if ((parts.length !== 2 && parts.length !== 3) || parts[0]!.tag !== 0x06 || parts[parts.length - 1]!.tag !== 0x04) throw new Error("der: malformed extension");
    let critical = false;
    if (parts.length === 3) { const flag = parts[1]!; if (flag.tag !== 0x01 || flag.end - flag.start !== 1) throw new Error("der: malformed critical flag"); critical = der[flag.start] !== 0; }
    const id = dottedOid(der, parts[0]!.start, parts[0]!.end);
    if (critical && !CLIENT_UNDERSTOOD_EXTENSIONS.includes(id)) out.push(id);
  }
  return out;
}
