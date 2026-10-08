// Read-only facts about a certificate, computed with node's own X.509 parser (an independent check of anything the
// DER builder produced) and an injected clock.
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
    expired: now.getTime() > notAfter.getTime(),
    notYetValid: now.getTime() < notBefore.getTime(),
    daysLeft: Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS),
  };
}
