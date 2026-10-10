import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, generateKeyPairSync, sign } from "node:crypto";
import { importCompanyCa, splitPem } from "../src/company-ca.ts";
import type { CompanyCaRequest } from "../src/company-ca.ts";
import { createMemorySecretPort } from "../src/secrets.ts";
import { certPin } from "../src/fingerprint.ts";
import { buildCertificate, pemEncode } from "../src/x509.ts";
import { bitString, ctx, ctxPrimitive, integerFromNumber, octets, oid, seq, set, time, utf8 } from "../src/der.ts";
import { DAY, NOW, issueLeaf, keyPem, makePki } from "./helpers.ts";

// Coverage for the company-CA import: unparseable blocks in the chain, names with no SAN at all, the EKU rules (a
// clientAuth-only leaf is refused, anyExtendedKeyUsage and an absent EKU are accepted), a chain that ends at a root
// other than the supplied one, a broken root CA upload, and the splitPem() framing.
// The helpers.ts PKI builder always writes serverAuth, so the EKU cases build their own self-signed leaf here.

const HOST = "harness.corp.example";
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const KEY_REF = "remote/tls/company-key";

/** Own minimal certificate: the only way to put an arbitrary EKU list (or none) into a leaf. Self-signed, so the chain
 *  walk ends at the leaf and no root CA is needed. */
function selfSignedWithEku(ekus: readonly string[] | undefined): { pem: string; keyPem: string; leafPin: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sigAlg = seq(oid("1.2.840.10045.4.3.2"));
  const rdn = seq(set(seq(oid("2.5.4.3"), utf8(HOST))));
  const exts: Buffer[] = [];
  if (ekus !== undefined) exts.push(seq(oid("2.5.29.37"), octets(seq(...ekus.map((o) => oid(o))))));
  exts.push(seq(oid("2.5.29.17"), octets(seq(ctxPrimitive(2, Buffer.from(HOST, "latin1"))))));
  const tbs = seq(
    ctx(0, integerFromNumber(2)), integerFromNumber(7), sigAlg, rdn,
    seq(time(at(-1)), time(at(300))), rdn,
    publicKey.export({ type: "spki", format: "der" }),
    ctx(3, seq(...exts)),
  );
  const der = seq(tbs, sigAlg, bitString(sign("sha256", tbs, privateKey), 0));
  const pem = pemEncode("CERTIFICATE", der);
  return { pem, keyPem: keyPem(privateKey), leafPin: certPin(pem) };
}

/** A request without an `ips` key at all (exactOptionalPropertyTypes forbids ips: undefined). */
function bareReq(over: { certChainPem: string; keyPem: string; hostnames: string[]; caPem?: string; secrets?: ReturnType<typeof createMemorySecretPort> }): CompanyCaRequest {
  return { now: NOW, keyRef: KEY_REF, secrets: over.secrets ?? createMemorySecretPort(), ...over } as CompanyCaRequest;
}
const codes = (r: { issues: readonly { code: string }[] }) => r.issues.map((i) => i.code).sort();

// --- splitPem --------------------------------------------------------------------------------------------------------

test("splitPem: finds every CERTIFICATE block, ignores text around them, and yields nothing for no blocks", () => {
  const a = pemEncode("CERTIFICATE", Uint8Array.from([1, 2, 3]));
  const b = pemEncode("CERTIFICATE", Uint8Array.from([4, 5, 6]));
  assert.deepEqual(splitPem(""), []);
  assert.deepEqual(splitPem("just some text"), []);
  assert.deepEqual(splitPem("-----BEGIN CERTIFICATE-----\nAAAA\n"), [], "no END line");
  assert.deepEqual(splitPem("intro\n" + a + "between\n" + b + "outro"), [a.trimEnd(), b.trimEnd()]);
  assert.equal(splitPem(a.replace(/\n/g, "\r\n")).length, 1, "CRLF line endings");
});

// --- the chain text ---------------------------------------------------------------------------------------------------

test("an unparseable CERTIFICATE block in the chain is reported and nothing is stored", async () => {
  const pki = makePki();
  const garbage = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
  const secrets = createMemorySecretPort();
  const out = await importCompanyCa(bareReq({ certChainPem: pki.leafPem + garbage + pki.interPem, keyPem: pki.leafKeyPem, hostnames: [HOST], secrets }));
  assert.ok(!out.ok);
  assert.deepEqual(codes(out), ["chain-unparseable"]);
  assert.match(out.issues[0]!.message, /^1 certificate block\(s\) in the chain could not be parsed$/);
  assert.equal(await secrets.get(KEY_REF), undefined, "a refused upload never reaches the secret store");
});

test("a chain that ends at a root other than the supplied root CA is reported as chain-incomplete", async () => {
  const pki = makePki();
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const otherRoot = buildCertificate({
    subject: { cn: "Other Root CA", o: "Other" }, publicKey: other.publicKey, signingKey: other.privateKey,
    notBefore: at(-3000), notAfter: at(3000), isCa: true,
  });
  // the chain carries the real root, the upload names a different one
  const out = await importCompanyCa(bareReq({
    certChainPem: pki.leafPem + pki.interPem + pki.rootPem, keyPem: pki.leafKeyPem, hostnames: [HOST], caPem: otherRoot.pem,
  }));
  assert.ok(!out.ok);
  assert.deepEqual(codes(out), ["chain-incomplete"]);
  assert.match(out.issues[0]!.message, /different root/);
});

test("a root CA upload that is not a certificate at all is ca-invalid; no root warning is added (the upload was given)", async () => {
  const pki = makePki();
  const out = await importCompanyCa(bareReq({ certChainPem: pki.leafPem + pki.interPem, keyPem: pki.leafKeyPem, hostnames: [HOST], caPem: "not a certificate" }));
  assert.ok(!out.ok);
  assert.deepEqual(codes(out), ["ca-invalid"]);
  assert.match(out.issues[0]!.message, /contains no certificate/);
});

test("the earliest expiry is the notAfter of the whole chain, even when the leaf outlives its intermediate", async () => {
  const pki = makePki({ leafTo: 2500 });
  const out = await importCompanyCa(bareReq({ certChainPem: pki.leafPem + pki.interPem + pki.rootPem, keyPem: pki.leafKeyPem, hostnames: [HOST], caPem: pki.rootPem }));
  assert.ok(out.ok);
  assert.equal(out.notAfter.getTime(), at(2000).getTime(), "the intermediate expires first");
  assert.equal(out.chainPem.split("-----BEGIN CERTIFICATE-----").length - 1, 3);
  assert.equal(out.caPin, certPin(pki.rootPem));
});

// --- names --------------------------------------------------------------------------------------------------------

test("no host name and no address at all: the names check is reported, nothing else is", async () => {
  const pki = makePki();
  const out = await importCompanyCa(bareReq({ certChainPem: pki.leafPem + pki.interPem, keyPem: pki.leafKeyPem, hostnames: [] }));
  assert.ok(!out.ok);
  assert.deepEqual(codes(out), ["no-names"]);
});

test("names are compared case-insensitively and with surrounding spaces trimmed", async () => {
  const pki = makePki();
  const out = await importCompanyCa(bareReq({
    certChainPem: pki.leafPem + pki.interPem, keyPem: pki.leafKeyPem, hostnames: ["  HARNESS.Corp.EXAMPLE "],
  }));
  assert.ok(out.ok, JSON.stringify(out));
});

test("an IPv6 address on the certificate is checked and reported in canonical form", async () => {
  const pki = makePki();
  const leaf = issueLeaf(pki, { dns: [HOST], ips: ["fd00::1"] });
  const ok = await importCompanyCa(bareReq({ certChainPem: leaf.leafPem + pki.interPem, keyPem: leaf.leafKeyPem, hostnames: [HOST], }));
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(ok.ips, ["fd00::1"], "the SAN address is reported");
  const withIp = await importCompanyCa({ ...bareReq({ certChainPem: leaf.leafPem + pki.interPem, keyPem: leaf.leafKeyPem, hostnames: [HOST] }), ips: ["fd00::1"] });
  assert.ok(withIp.ok);
  assert.deepEqual(withIp.ips, ["fd00::1"]);
  const missing = await importCompanyCa({ ...bareReq({ certChainPem: leaf.leafPem + pki.interPem, keyPem: leaf.leafKeyPem, hostnames: [HOST] }), ips: ["fd00::2"] });
  assert.ok(!missing.ok);
  assert.deepEqual(codes(missing), ["san-missing"]);
});

// --- EKU rules --------------------------------------------------------------------------------------------------------

test("EKU: serverAuth passes, clientAuth only is refused, anyExtendedKeyUsage passes, an absent EKU passes", async () => {
  const serverAuth = "1.3.6.1.5.5.7.3.1";
  const clientAuth = "1.3.6.1.5.5.7.3.2";
  const anyEku = "2.5.29.37.0";
  const accepted: Array<[string, readonly string[] | undefined]> = [
    ["serverAuth", [serverAuth]],
    ["serverAuth with clientAuth", [clientAuth, serverAuth]],
    ["anyExtendedKeyUsage", [anyEku]],
    ["no EKU extension at all", undefined],
  ];
  for (const [label, ekus] of accepted) {
    const leaf = selfSignedWithEku(ekus);
    const out = await importCompanyCa(bareReq({ certChainPem: leaf.pem, keyPem: leaf.keyPem, hostnames: [HOST] }));
    assert.ok(out.ok, `${label}: ${JSON.stringify(out)}`);
    assert.equal(out.ok && out.leafPin, leaf.leafPin, `${label}: pin of the uploaded leaf`);
  }
  const refused = selfSignedWithEku([clientAuth]);
  const out = await importCompanyCa(bareReq({ certChainPem: refused.pem, keyPem: refused.keyPem, hostnames: [HOST] }));
  assert.ok(!out.ok);
  assert.deepEqual(codes(out), ["eku-no-server-auth"]);
});
