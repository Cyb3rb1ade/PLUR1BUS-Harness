// `remote.tls` = `company-ca` (desktop spec §6.2): the operator uploads a server certificate chain issued by the
// company's CA together with its key, and (recommended) the company's root CA certificate. This module validates the
// upload as one unit — key matches, names covered, nothing expired, chain complete and correctly signed — and only
// then hands the key to the SecretPort. The root CA is returned for the pairing payload (`caPin`), so no device ever
// installs a CA file itself.
//
// PEM only (chain + key). A PKCS#12 bundle needs a PKCS#12 parser that node:crypto does not have; it is a follow-up.
import { X509Certificate, createPrivateKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { pemEncode } from "./x509.ts";
import { inspectCertificate } from "./certs.ts";
import { certPin } from "./fingerprint.ts";
import type { Pin } from "./fingerprint.ts";
import type { Note, SecretPort } from "./types.ts";

export interface CompanyCaRequest {
  /** PEM, leaf certificate first, then intermediates. A root may be included; the CA argument is the usual place for it. */
  readonly certChainPem: string;
  /** PEM private key of the leaf (PKCS#8, PKCS#1 or SEC1), not passphrase-protected. */
  readonly keyPem: string;
  /** The company's root CA certificate (PEM), handed to devices through pairing. */
  readonly caPem?: string;
  readonly hostnames: readonly string[];
  readonly ips?: readonly string[];
  readonly now: Date;
  readonly keyRef: string;
  readonly secrets: SecretPort;
}

export type ImportResult =
  | {
    readonly ok: true;
    readonly keyRef: string;
    /** Normalised PEM chain, leaf first. */
    readonly chainPem: string;
    readonly caPem?: string;
    readonly leafPin: Pin;
    /** Pin of the root CA certificate; present exactly when a valid root CA was supplied. */
    readonly caPin?: Pin;
    /** The earliest expiry among the leaf and the chain. */
    readonly notAfter: Date;
    readonly dns: readonly string[];
    readonly ips: readonly string[];
    readonly warnings: readonly Note[];
  }
  | { readonly ok: false; readonly issues: readonly Note[] };

const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const ANY_EKU = "2.5.29.37.0";

export function splitPem(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

function parseCerts(text: string): { certs: X509Certificate[]; bad: number } {
  const certs: X509Certificate[] = [];
  let bad = 0;
  for (const block of splitPem(text)) {
    try { certs.push(new X509Certificate(block)); } catch { bad++; }
  }
  return { certs, bad };
}

const normal = (c: X509Certificate): string => pemEncode("CERTIFICATE", c.raw);
const subjectOf = (c: X509Certificate): string => c.subject.replace(/\n/g, ", ");

function issuedBy(child: X509Certificate, parent: X509Certificate): boolean {
  try { return child.checkIssued(parent) && child.verify(parent.publicKey); } catch { return false; }
}

export async function importCompanyCa(req: CompanyCaRequest): Promise<ImportResult> {
  const issues: Note[] = [];
  const warnings: Note[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });

  const { certs, bad } = parseCerts(req.certChainPem);
  if (certs.length === 0) return { ok: false, issues: [{ code: "chain-unparseable", message: "no certificate found in the uploaded chain" }] };
  if (bad > 0) add("chain-unparseable", `${bad} certificate block(s) in the chain could not be parsed`);

  let key: KeyObject | undefined;
  if (/ENCRYPTED/.test(req.keyPem.split("\n").slice(0, 3).join("\n"))) {
    add("key-encrypted", "the private key is passphrase-protected; upload an unencrypted key (it is stored in the secret store)");
  } else {
    try { key = createPrivateKey(req.keyPem); } catch { add("key-unparseable", "the private key could not be parsed"); }
  }

  const leaf = certs[0]!;
  if (key !== undefined && !leaf.checkPrivateKey(key)) {
    if (certs.slice(1).some((c) => c.checkPrivateKey(key!))) {
      return { ok: false, issues: [{ code: "leaf-not-first", message: "the key belongs to a later certificate in the chain: the server certificate must come first" }] };
    }
    add("key-mismatch", "the private key does not match the first certificate of the chain");
  }

  const names = [...req.hostnames.map((h) => h.trim().toLowerCase()), ...(req.ips ?? [])];
  if (names.length === 0) add("no-names", "no host name or address to check the certificate against");
  for (const host of req.hostnames) {
    if (leaf.checkHost(host.trim().toLowerCase(), { subject: "never" }) === undefined) add("san-missing", `the certificate does not cover host name ${host}`);
  }
  for (const ip of req.ips ?? []) {
    if (leaf.checkIP(ip) === undefined) add("san-missing", `the certificate does not cover address ${ip}`);
  }

  const ekus = leaf.keyUsage ?? [];
  if (ekus.length > 0 && !ekus.includes(SERVER_AUTH) && !ekus.includes(ANY_EKU)) add("eku-no-server-auth", "the certificate is not valid for TLS server authentication");

  const time = (c: X509Certificate, prefix: "" | "ca-") => {
    const info = inspectCertificate(c, req.now);
    if (info.expired) add(`${prefix}expired`, `${subjectOf(c)} expired on ${info.notAfter.toISOString()}`);
    else if (info.notYetValid) add(`${prefix}not-yet-valid`, `${subjectOf(c)} is not valid before ${info.notBefore.toISOString()}`);
  };
  for (const c of certs) time(c, "");

  let ca: X509Certificate | undefined;
  let caValid = false;
  if (req.caPem !== undefined) {
    const parsed = parseCerts(req.caPem).certs[0];
    if (!parsed) {
      add("ca-invalid", "the root CA upload contains no certificate");
    } else {
      ca = parsed;
      const info = inspectCertificate(ca, req.now);
      if (!info.isCa) add("ca-invalid", "the root CA certificate is not a certificate authority");
      else if (!info.selfSigned) add("ca-invalid", "the root CA certificate is not self-signed (is it an intermediate?)");
      else caValid = true;
      time(ca, "ca-");
    }
  }

  // Chain walk: leaf -> ... -> a self-signed root, or the supplied root CA.
  let reachedRoot = false;
  let cur = leaf;
  const rest = certs.slice(1);
  for (let hops = 0; hops < 10; hops++) {
    if (inspectCertificate(cur, req.now).selfSigned) { reachedRoot = true; break; }
    const next = rest.find((c) => c !== cur && issuedBy(cur, c)) ?? (caValid && ca !== undefined && issuedBy(cur, ca) ? ca : undefined);
    if (next === undefined) break;
    cur = next;
    if (next === ca) { reachedRoot = true; break; }
  }
  if (!reachedRoot) {
    if (caValid) add("chain-incomplete", `no valid issuer found for ${subjectOf(cur)}: an intermediate certificate is missing or the signature does not match`);
    else if (req.caPem === undefined) warnings.push({ code: "no-root-ca", message: "no root CA was supplied: devices must already trust the issuer through their operating system" });
  } else if (caValid && ca !== undefined && cur !== ca && !cur.raw.equals(ca.raw)) {
    add("chain-incomplete", "the chain ends at a different root than the supplied root CA certificate");
  }

  if (issues.length > 0 || key === undefined) return { ok: false, issues };

  await req.secrets.put(req.keyRef, Buffer.from(key.export({ type: "pkcs8", format: "pem" }) as string, "utf8"));
  const info = inspectCertificate(leaf, req.now);
  const notAfter = new Date(Math.min(...certs.map((c) => new Date(c.validToDate).getTime())));
  return {
    ok: true,
    keyRef: req.keyRef,
    chainPem: certs.map(normal).join(""),
    ...(caValid && ca !== undefined ? { caPem: normal(ca), caPin: certPin(ca) } : {}),
    leafPin: certPin(leaf),
    notAfter,
    dns: info.dns,
    ips: info.ips,
    warnings,
  };
}
