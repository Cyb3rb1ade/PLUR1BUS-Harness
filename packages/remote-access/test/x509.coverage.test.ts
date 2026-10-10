import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { buildCertificate, pemEncode } from "../src/x509.ts";
import type { CertificateSpec } from "../src/x509.ts";
import { inspectCertificate } from "../src/certs.ts";
import { DAY, NOW } from "./helpers.ts";

// Coverage for the X.509 builder: the signature algorithm per key type (P-384 and the unsupported-key errors), the
// SAN / EKU / basicConstraints extensions, validity encodings (UTCTime and GeneralizedTime), serials, and PEM framing.
// Every certificate built here is checked by node's independent X509Certificate parser.

const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

type Pair = { publicKey: KeyObject; privateKey: KeyObject };
const ec256 = (): Pair => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const ec384 = (): Pair => generateKeyPairSync("ec", { namedCurve: "secp384r1" });
const rsa = (): Pair => generateKeyPairSync("rsa", { modulusLength: 2048 });

/** A server leaf that signs itself unless told otherwise; the returned key pair is the one that signed it. */
function leaf(over: Partial<CertificateSpec> = {}, key: Pair = ec256()): { der: Buffer; pem: string; x: X509Certificate; key: Pair } {
  const cert = buildCertificate({
    subject: { cn: "harness.example" },
    publicKey: key.publicKey,
    signingKey: key.privateKey,
    notBefore: at(-1),
    notAfter: at(30),
    ...over,
  });
  return { ...cert, x: new X509Certificate(cert.pem), key };
}

// --- signature algorithm per signing key ----------------------------------------------------------------------------

test("signature algorithm follows the signing key: P-256 -> ecdsa-sha256, P-384 -> ecdsa-sha384, RSA -> sha256WithRSA", () => {
  const cases: Array<[string, Pair, string]> = [
    ["P-256", ec256(), "06082a8648ce3d040302"],
    ["P-384", ec384(), "06082a8648ce3d040303"],
    ["RSA-2048", rsa(), "06092a864886f70d01010b"],
  ];
  for (const [label, key, algOid] of cases) {
    const { der, x } = leaf({ dns: ["harness.example"] }, key);
    assert.ok(der.includes(Buffer.from(algOid, "hex")), `${label}: the algorithm identifier is in the certificate`);
    assert.equal(x.verify(key.publicKey), true, `${label}: the signature verifies with the signing key`);
  }
});

test("a P-384 self-signed leaf is accepted by node and carries the SHA-384 signature", () => {
  const key = ec384();
  const { x, der } = leaf({ dns: ["p384.example"] }, key);
  assert.equal(inspectCertificate(x, NOW).subject, "CN=harness.example");
  assert.equal(Buffer.from(x.raw).equals(der), true);
  assert.equal(x.verify(key.publicKey), true);
});

test("unsupported EC curve: P-521 is refused with the curve name", () => {
  const p521 = generateKeyPairSync("ec", { namedCurve: "secp521r1" });
  assert.throws(() => leaf({}, { publicKey: p521.publicKey, privateKey: p521.privateKey }), /unsupported EC curve secp521r1/);
});

test("unsupported signing key type: Ed25519 is refused with the key type name", () => {
  const ed = generateKeyPairSync("ed25519");
  assert.throws(() => leaf({}, { publicKey: ed.publicKey, privateKey: ed.privateKey }), /unsupported signing key type ed25519/);
});

test("a certificate signed by a key other than the named issuer does not verify under the issuer key", () => {
  const issuer = ec256();
  const other = ec256();
  const subject = ec256();
  const cert = buildCertificate({
    subject: { cn: "harness.example" }, issuer: { cn: "Corp Issuing CA" }, publicKey: subject.publicKey,
    signingKey: other.privateKey, notBefore: at(-1), notAfter: at(30), dns: ["harness.example"],
  });
  const x = new X509Certificate(cert.pem);
  assert.equal(x.verify(issuer.publicKey), false);
  assert.equal(x.verify(other.publicKey), true);
  assert.match(x.issuer, /CN=Corp Issuing CA/);
});

// --- basicConstraints, keyUsage, extKeyUsage ------------------------------------------------------------------------

test("leaf vs CA: a leaf is not a CA and allows serverAuth only; a CA is a CA with no extended key usage", () => {
  const l = leaf({ dns: ["harness.example"] });
  assert.equal(l.x.ca, false);
  assert.deepEqual(l.x.keyUsage, [SERVER_AUTH]);

  const ca = leaf({ isCa: true, pathLen: 0, subject: { cn: "Corp Root CA", o: "Corp" } });
  assert.equal(ca.x.ca, true);
  assert.equal(ca.x.keyUsage, undefined, "no EKU extension on a CA");
  assert.equal(inspectCertificate(ca.x, NOW).selfSigned, true);
});

test("pathLen is encoded (inside basicConstraints) only for a CA; a non-CA ignores it", () => {
  // basicConstraints content for CA + pathLen 2 is SEQUENCE { BOOLEAN TRUE, INTEGER 2 }; the version field is a different INTEGER 2 (a0 03 02 01 02)
  const CA_PATHLEN_2 = Buffer.from("0101ff020102", "hex");
  const withPath = leaf({ isCa: true, pathLen: 2, serial: Uint8Array.from([0x05]) });
  assert.equal(withPath.x.ca, true);
  assert.ok(withPath.der.includes(CA_PATHLEN_2), "pathLen 2 is in the certificate");
  const noPathLen = leaf({ isCa: true, serial: Uint8Array.from([0x05]) });
  assert.equal(noPathLen.x.ca, true);
  assert.equal(noPathLen.der.includes(CA_PATHLEN_2), false, "no pathLen when none is given");
  const nonCaWithPath = leaf({ pathLen: 2, serial: Uint8Array.from([0x05]) });
  assert.equal(nonCaWithPath.x.ca, false);
  assert.equal(nonCaWithPath.der.includes(CA_PATHLEN_2), false, "a non-CA never encodes pathLen");
});

// --- subjectAltName ------------------------------------------------------------------------------------------------

test("subjectAltName: DNS names and IPv4 addresses are both present", () => {
  const l = leaf({ dns: ["a.example", "b.example"], ips: ["10.0.0.5"] });
  assert.equal(l.x.subjectAltName, "DNS:a.example, DNS:b.example, IP Address:10.0.0.5");
});

test("subjectAltName: an IPv6 address is written in binary and read back in canonical form", () => {
  const l = leaf({ ips: ["fd00::1"] });
  assert.deepEqual(inspectCertificate(l.x, NOW).ips, ["fd00::1"]);
});

test("subjectAltName: an invalid IP address is refused", () => {
  assert.throws(() => leaf({ ips: ["not-an-ip"] }), /invalid IP address not-an-ip/);
  assert.throws(() => leaf({ ips: ["999.1.1.1"] }), /invalid IP address 999\.1\.1\.1/);
});

test("subjectAltName: omitted entirely when there are no names", () => {
  const l = leaf({ dns: [], ips: [] });
  assert.equal(l.x.subjectAltName, undefined);
  const none = leaf();
  assert.equal(none.x.subjectAltName, undefined);
});

// --- names, issuer, serial, validity ----------------------------------------------------------------------------------

test("subject with an organisation carries O before CN, and the issuer name is taken from the issuer argument", () => {
  const key = ec256();
  const cert = buildCertificate({
    subject: { cn: "harness.example", o: "Corp" }, issuer: { cn: "Corp Issuing CA", o: "Corp" },
    publicKey: key.publicKey, signingKey: key.privateKey, notBefore: at(-1), notAfter: at(30), dns: ["harness.example"],
  });
  const x = new X509Certificate(cert.pem);
  const s = inspectCertificate(x, NOW);
  assert.equal(s.subject, "O=Corp, CN=harness.example");
  assert.equal(s.issuer, "O=Corp, CN=Corp Issuing CA");
  assert.equal(s.selfSigned, false, "subject and issuer differ");
});

test("serial: explicit bytes keep their value (leading zeros dropped, high bit gets a sign octet)", () => {
  assert.match(leaf({ serial: Uint8Array.from([0x00, 0x00, 0x05]) }).x.serialNumber, /^0*05$/);
  assert.ok(leaf({ serial: Uint8Array.from([0x00, 0x80, 0x01]) }).x.serialNumber.toUpperCase().endsWith("8001"));
});

test("serial: when omitted, a random positive serial is generated and never repeats", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const { x } = leaf();
    // the first byte is masked to 0x7f, so the first hex digit is 0..7 (positive INTEGER)
    assert.ok(parseInt(x.serialNumber.charAt(0), 16) < 8, x.serialNumber);
    seen.add(x.serialNumber);
  }
  assert.equal(seen.size, 3);
});

test("validity: UTCTime for 1950..2049 and GeneralizedTime outside that range both round-trip", () => {
  const dates = [
    new Date("1949-12-31T23:59:59Z"),
    new Date("2049-12-31T23:59:59Z"),
    new Date("2050-01-01T00:00:00Z"),
    new Date("2060-06-15T12:34:56Z"),
  ];
  for (const d of dates) {
    const { x } = leaf({ notBefore: d, notAfter: d });
    const info = inspectCertificate(x, NOW);
    assert.equal(info.notBefore.getTime(), d.getTime(), d.toISOString());
    assert.equal(info.notAfter.getTime(), d.getTime(), d.toISOString());
  }
});

test("validity: an invalid date is refused before anything is signed", () => {
  assert.throws(() => leaf({ notBefore: new Date("not a date") }), /time: invalid date/);
  assert.throws(() => leaf({ notAfter: new Date(Number.NaN) }), /time: invalid date/);
});

test("expired and not-yet-valid windows are reported by inspectCertificate on the injected clock", () => {
  const l = leaf({ notBefore: at(-10), notAfter: at(-1) });
  const info = inspectCertificate(l.x, NOW);
  assert.equal(info.expired, true);
  assert.equal(info.notYetValid, false);
  const future = leaf({ notBefore: at(1), notAfter: at(10) });
  assert.equal(inspectCertificate(future.x, NOW).notYetValid, true);
});

// --- PEM framing ----------------------------------------------------------------------------------------------------

test("pemEncode: 64-character base64 lines, the body decodes back to the DER", () => {
  const der = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) & 0xff);
  const pem = pemEncode("CERTIFICATE", der);
  const lines = pem.trimEnd().split("\n");
  assert.equal(lines[0], "-----BEGIN CERTIFICATE-----");
  assert.equal(lines[lines.length - 1], "-----END CERTIFICATE-----");
  const body = lines.slice(1, -1);
  for (const line of body) assert.ok(line.length <= 64 && line.length > 0, line);
  assert.equal(Buffer.from(body.join(""), "base64").equals(Buffer.from(der)), true);
});

test("pemEncode: exactly 64 base64 characters stay on one line", () => {
  const pem = pemEncode("X", new Uint8Array(48));
  assert.equal(pem.trimEnd().split("\n").length, 3);
});

test("buildCertificate: the returned PEM is the DER framed as CERTIFICATE", () => {
  const { der, pem } = leaf({ dns: ["harness.example"] }, ec256());
  assert.equal(pem, pemEncode("CERTIFICATE", der));
});

// BUG: pemEncode("X", empty DER) throws a TypeError (base64 "" has no 64-character match) instead of returning a PEM block with an empty body – siehe docs/testing/coverage-2026-10-wave2.md#x509-pem-empty
test.skip("pemEncode: empty DER gives an empty PEM body instead of throwing", () => {
  const pem = pemEncode("X", new Uint8Array(0));
  assert.match(pem, /^-----BEGIN X-----\n/);
  assert.match(pem, /-----END X-----\n$/);
});

// UNKLAR: a non-ASCII DNS name is written as latin1 bytes into the dNSName (IA5String) field. Should such a name be
// refused, punycode-encoded, or written as-is? The correct behaviour is not settled, so no expectation is asserted here.
test.skip("subjectAltName: a Unicode DNS name is handled as the correct IDNA form", () => {
  assert.fail("UNKLAR: expected behaviour for non-ASCII DNS names is not decided");
});
