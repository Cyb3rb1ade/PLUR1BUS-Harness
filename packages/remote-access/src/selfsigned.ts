// Self-signed server certificate for `remote.publish` = `network`, `remote.tls` = `self-signed` (spec §6.2): the
// harness generates its own key pair and certificate; clients pin the certificate's SHA-256 through the pairing
// payload, so nothing here has to be trusted by an operating system.
//
// The private key is created in memory, handed to the SecretPort and dropped. The returned object carries only the
// certificate, the reference and the pins.
import { generateKeyPairSync } from "node:crypto";
import { buildCertificate } from "./x509.ts";
import { formatIp, parseIp } from "./net-address.ts";
import { certPin, spkiPin } from "./fingerprint.ts";
import type { Pin } from "./fingerprint.ts";
import type { SecretPort } from "./types.ts";

export const DEFAULT_VALIDITY_DAYS = 365;
export const MAX_VALIDITY_DAYS = 825;
const MAX_NAMES = 20;
const SKEW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export interface SelfSignedRequest {
  /** Host names the harness is reached by (LDH ASCII; IDN names in punycode). */
  readonly hostnames: readonly string[];
  readonly ips?: readonly string[];
  /** The `*.ts.net` name, when the machine is on a tailnet, so the same certificate also covers it. */
  readonly magicDnsName?: string;
  readonly now: Date;
  readonly validityDays?: number;
  /** Where the private key is stored in the secret port. */
  readonly keyRef: string;
  readonly secrets: SecretPort;
}

export interface SelfSignedResult {
  readonly certPem: string;
  readonly keyRef: string;
  /** Pin of the DER certificate: what the pairing payload carries as `certPin`. */
  readonly certPin: Pin;
  readonly spkiPin: Pin;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly dns: readonly string[];
  readonly ips: readonly string[];
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normaliseHostname(raw: string): string {
  const host = raw.toLowerCase();
  if (host.length === 0 || host.length > 253 || !host.split(".").every((l) => LABEL.test(l))) {
    throw new Error(`invalid host name ${JSON.stringify(raw)} (letters, digits and hyphens only; IDN names in punycode; no wildcard)`);
  }
  return host;
}

export async function generateSelfSigned(req: SelfSignedRequest): Promise<SelfSignedResult> {
  const days = req.validityDays ?? DEFAULT_VALIDITY_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_VALIDITY_DAYS) {
    throw new Error(`validity must be a whole number of days from 1 to ${MAX_VALIDITY_DAYS}`);
  }
  const dns = [...new Set([...req.hostnames, ...(req.magicDnsName ? [req.magicDnsName] : [])].map(normaliseHostname))];
  const ips = [...new Set((req.ips ?? []).map((a) => {
    const ip = parseIp(a);
    if (!ip) throw new Error(`invalid IP address ${JSON.stringify(a)}`);
    return formatIp(ip);
  }))];
  if (dns.length + ips.length === 0) throw new Error("at least one host name or IP address is required");
  if (dns.length + ips.length > MAX_NAMES) throw new Error(`at most ${MAX_NAMES} names and addresses fit one certificate`);

  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const toSecond = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);
  const notBefore = toSecond(req.now.getTime() - SKEW_MS);
  const notAfter = toSecond(req.now.getTime() + days * DAY_MS);
  const cert = buildCertificate({
    subject: { cn: dns[0] ?? ips[0]!, o: "PLUR1BUS Harness (self-signed)" },
    publicKey, signingKey: privateKey, notBefore, notAfter, dns, ips,
  });
  await req.secrets.put(req.keyRef, Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }) as string, "utf8"));
  return { certPem: cert.pem, keyRef: req.keyRef, certPin: certPin(cert.pem), spkiPin: spkiPin(cert.pem), notBefore, notAfter, dns, ips };
}
