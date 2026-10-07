// X.509 v3 certificate builder on top of der.ts, signing with node:crypto. Used to create the harness's self-signed
// server certificate (selfsigned.ts) and, in tests, a throw-away certificate authority for the company-CA checks.
//
// Scope is deliberate: server-auth leaf certificates and CA certificates; EC P-256/P-384 and RSA signing keys;
// extensions basicConstraints, keyUsage, extKeyUsage (serverAuth), subjectAltName, subjectKeyIdentifier and
// authorityKeyIdentifier. Nothing else is needed, so nothing else is implemented.
import { createHash, createPublicKey, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { bitString, bool, children, ctx, ctxPrimitive, integerFromBytes, integerFromNumber, nul, octets, oid, readTlv, seq, set, time, utf8 } from "./der.ts";
import { formatIp, parseIp } from "./net-address.ts";

export interface Name { readonly cn: string; readonly o?: string }

export interface CertificateSpec {
  readonly subject: Name;
  /** The subject's public key. */
  readonly publicKey: KeyObject;
  /** The signing (issuer) private key. For a self-signed certificate this is the subject's own key. */
  readonly signingKey: KeyObject;
  /** The issuer's name; defaults to the subject (self-signed). */
  readonly issuer?: Name;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly serial?: Uint8Array;
  readonly isCa?: boolean;
  readonly pathLen?: number;
  readonly dns?: readonly string[];
  readonly ips?: readonly string[];
}

const OID = {
  cn: "2.5.4.3", o: "2.5.4.10",
  basicConstraints: "2.5.29.19", keyUsage: "2.5.29.15", extKeyUsage: "2.5.29.37", san: "2.5.29.17", ski: "2.5.29.14", aki: "2.5.29.35",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  ecdsaSha256: "1.2.840.10045.4.3.2", ecdsaSha384: "1.2.840.10045.4.3.3", rsaSha256: "1.2.840.113549.1.1.11",
} as const;

function name(n: Name): Buffer {
  const attr = (o: string, v: string) => set(seq(oid(o), utf8(v)));
  return seq(...(n.o !== undefined ? [attr(OID.o, n.o)] : []), attr(OID.cn, n.cn));
}

interface SigAlg { readonly hash: "sha256" | "sha384"; readonly id: Buffer }
function signatureAlgorithm(key: KeyObject): SigAlg {
  if (key.asymmetricKeyType === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve === "prime256v1") return { hash: "sha256", id: seq(oid(OID.ecdsaSha256)) };
    if (curve === "secp384r1") return { hash: "sha384", id: seq(oid(OID.ecdsaSha384)) };
    throw new Error(`unsupported EC curve ${String(curve)}`);
  }
  if (key.asymmetricKeyType === "rsa") return { hash: "sha256", id: seq(oid(OID.rsaSha256), nul()) };
  throw new Error(`unsupported signing key type ${String(key.asymmetricKeyType)}`);
}

/** RFC 5280 §4.2.1.2 method 1: SHA-1 of the subjectPublicKey BIT STRING contents. */
function keyIdentifier(publicKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const top = readTlv(spki, 0);
  const parts = children(spki.subarray(top.start, top.end));
  const bits = parts[1];
  if (!bits || bits.tag !== 0x03) throw new Error("malformed SubjectPublicKeyInfo");
  const content = spki.subarray(top.start + bits.start, top.start + bits.end);
  return createHash("sha1").update(content.subarray(1)).digest();
}

function extension(id: string, critical: boolean, value: Uint8Array): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
}

function extensions(spec: CertificateSpec): Buffer[] {
  const out: Buffer[] = [];
  out.push(extension(OID.basicConstraints, true, seq(...(spec.isCa ? [bool(true), ...(spec.pathLen !== undefined ? [integerFromNumber(spec.pathLen)] : [])] : []))));
  // digitalSignature for a server leaf; keyCertSign + cRLSign for a CA.
  out.push(extension(OID.keyUsage, true, spec.isCa ? bitString(Uint8Array.from([0x06]), 1) : bitString(Uint8Array.from([0x80]), 7)));
  if (!spec.isCa) out.push(extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))));
  const names: Buffer[] = [];
  for (const d of spec.dns ?? []) names.push(ctxPrimitive(2, Buffer.from(d, "latin1")));
  for (const a of spec.ips ?? []) {
    const ip = parseIp(a);
    if (!ip) throw new Error(`invalid IP address ${a}`);
    names.push(ctxPrimitive(7, ip.bytes));
  }
  if (names.length > 0) out.push(extension(OID.san, false, seq(...names)));
  out.push(extension(OID.ski, false, octets(keyIdentifier(spec.publicKey))));
  out.push(extension(OID.aki, false, seq(ctxPrimitive(0, keyIdentifier(createPublicKey(spec.signingKey))))));
  return out;
}

export function pemEncode(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64");
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

export function buildCertificate(spec: CertificateSpec): { der: Buffer; pem: string } {
  const alg = signatureAlgorithm(spec.signingKey);
  let serial = spec.serial;
  if (serial === undefined) {
    const bytes = randomBytes(16);
    bytes[0] = (bytes[0]! & 0x7f) || 0x01; // positive, never zero
    serial = bytes;
  }
  const tbs = seq(
    ctx(0, integerFromNumber(2)),
    integerFromBytes(serial),
    alg.id,
    name(spec.issuer ?? spec.subject),
    seq(time(spec.notBefore), time(spec.notAfter)),
    name(spec.subject),
    spec.publicKey.export({ type: "spki", format: "der" }),
    ctx(3, seq(...extensions(spec))),
  );
  const signature = sign(alg.hash, tbs, spec.signingKey);
  const der = seq(tbs, alg.id, bitString(signature, 0));
  return { der, pem: pemEncode("CERTIFICATE", der) };
}

/** Canonical IP text for a SAN entry (also used to de-duplicate). */
export function canonicalIp(address: string): string | undefined {
  const ip = parseIp(address);
  return ip ? formatIp(ip) : undefined;
}

