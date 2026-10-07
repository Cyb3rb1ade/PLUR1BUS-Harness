// Test helper: a throw-away PKI (root CA -> intermediate CA -> server leaf) built with the package's own certificate
// builder, so the company-CA checks run against real, independently parsed certificates.
import { generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { buildCertificate } from "../src/x509.ts";

export const NOW = new Date("2026-10-08T10:00:00Z");
export const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

export type KeyType = "ec" | "rsa";
export function newKey(type: KeyType = "ec"): { publicKey: KeyObject; privateKey: KeyObject } {
  return type === "rsa"
    ? generateKeyPairSync("rsa", { modulusLength: 2048 })
    : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}
export const keyPem = (k: KeyObject): string => k.export({ type: "pkcs8", format: "pem" }) as string;

export interface PkiOptions {
  keyType?: KeyType;
  dns?: string[];
  ips?: string[];
  leafFrom?: number;   // days relative to NOW
  leafTo?: number;
  rootFrom?: number;
  rootTo?: number;
}

export interface Pki {
  rootPem: string;
  interPem: string;
  leafPem: string;
  leafKey: KeyObject;
  leafKeyPem: string;
  /** A second leaf under the same intermediate, with its own key (for "right chain, wrong key" cases). */
  otherLeafKey: KeyObject;
  /** A CA that has nothing to do with this PKI, same subject names (for "wrong issuer signature" cases). */
  strangerInterKey: KeyObject;
}

export function makePki(o: PkiOptions = {}): Pki {
  const type = o.keyType ?? "ec";
  const root = newKey(type);
  const inter = newKey(type);
  const leaf = newKey(type);
  const other = newKey(type);
  const stranger = newKey(type);
  const rootName = { cn: "Corp Root CA", o: "Corp" };
  const interName = { cn: "Corp Issuing CA", o: "Corp" };
  const rootCert = buildCertificate({
    subject: rootName, publicKey: root.publicKey, signingKey: root.privateKey,
    notBefore: at(o.rootFrom ?? -3000), notAfter: at(o.rootTo ?? 3000), isCa: true,
  });
  const interCert = buildCertificate({
    subject: interName, issuer: rootName, publicKey: inter.publicKey, signingKey: root.privateKey,
    notBefore: at(-2000), notAfter: at(2000), isCa: true, pathLen: 0,
  });
  const leafCert = buildCertificate({
    subject: { cn: "harness.corp.example" }, issuer: interName, publicKey: leaf.publicKey, signingKey: inter.privateKey,
    notBefore: at(o.leafFrom ?? -30), notAfter: at(o.leafTo ?? 300),
    dns: o.dns ?? ["harness.corp.example"], ips: o.ips ?? ["192.168.1.20"],
  });
  return {
    rootPem: rootCert.pem, interPem: interCert.pem, leafPem: leafCert.pem,
    leafKey: leaf.privateKey, leafKeyPem: keyPem(leaf.privateKey),
    otherLeafKey: other.privateKey, strangerInterKey: stranger.privateKey,
  };
}
