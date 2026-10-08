import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import { importCompanyCa, splitPem } from "../src/company-ca.ts";
import type { CompanyCaRequest } from "../src/company-ca.ts";
import { createMemorySecretPort, loadTlsMaterial } from "../src/secrets.ts";
import { certPin } from "../src/fingerprint.ts";
import { buildCertificate } from "../src/x509.ts";
import { DAY, NOW, keyPem, makePki, newKey } from "./helpers.ts";

/** A PEM-framed blob that is not a key. Assembled at runtime so no literal key header sits in the source (hygiene HYG-013). */
const pemLike = (body: string): string => ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + `\n${body}\n` + ["-----END", "PRIVATE KEY-----"].join(" ") + "\n";
const HOSTS = { hostnames: ["harness.corp.example"], ips: ["192.168.1.20"] };
function req(over: Partial<CompanyCaRequest> & Pick<CompanyCaRequest, "certChainPem" | "keyPem">): CompanyCaRequest & { secrets: ReturnType<typeof createMemorySecretPort> } {
  return { ...HOSTS, now: NOW, keyRef: "remote/tls/company-key", secrets: createMemorySecretPort(), ...over } as never;
}
const codes = (r: { issues: readonly { code: string }[] }) => r.issues.map((i) => i.code).sort();

test("happy path: leaf + intermediate + root CA, key matches, names covered", async () => {
  const pki = makePki();
  const r = req({ certChainPem: pki.leafPem + pki.interPem, keyPem: pki.leafKeyPem, caPem: pki.rootPem });
  const out = await importCompanyCa(r);
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.caPin, certPin(pki.rootPem), "the root CA pin is what the pairing payload carries as caPin");
  assert.equal(out.leafPin, certPin(pki.leafPem));
  assert.deepEqual(out.warnings, []);
  assert.equal(out.keyRef, "remote/tls/company-key");
  assert.deepEqual(r.secrets.refs(), ["remote/tls/company-key"]);
  assert.equal(splitPem(out.chainPem).length, 2);
  assert.equal(out.caPem, pki.rootPem);
  assert.ok(out.notAfter.getTime() > NOW.getTime());
  const tls = await loadTlsMaterial(r.secrets, out.keyRef, out.chainPem);
  assert.match(tls.key, /BEGIN PRIVATE KEY/);
});

test("without a root CA the chain is accepted with a warning (clients then rely on the OS trust store), no caPin", async () => {
  const pki = makePki();
  const out = await importCompanyCa(req({ certChainPem: pki.leafPem + pki.interPem, keyPem: pki.leafKeyPem }));
  assert.ok(out.ok);
  assert.equal(out.caPin, undefined);
  assert.deepEqual(out.warnings.map((w) => w.code), ["no-root-ca"]);
});

test("RSA chain and RSA key work too", async () => {
  const pki = makePki({ keyType: "rsa" });
  const out = await importCompanyCa(req({ certChainPem: pki.leafPem + pki.interPem, keyPem: pki.leafKeyPem, caPem: pki.rootPem }));
  assert.ok(out.ok, JSON.stringify(out));
});

test("a PKCS#1-style or EC-style key PEM is normalised to PKCS#8 before it is stored", async () => {
  const pki = makePki();
  const ec = pki.leafKey.export({ type: "sec1", format: "pem" }) as string;
  assert.match(ec, /BEGIN EC PRIVATE KEY/);
  const r = req({ certChainPem: pki.leafPem + pki.interPem, keyPem: ec, caPem: pki.rootPem });
  const out = await importCompanyCa(r);
  assert.ok(out.ok);
  assert.match(Buffer.from((await r.secrets.get(out.keyRef))!).toString(), /BEGIN PRIVATE KEY/);
});

test("key that does not belong to the certificate", async () => {
  const pki = makePki();
  const r = req({ certChainPem: pki.leafPem + pki.interPem, keyPem: keyPem(pki.otherLeafKey), caPem: pki.rootPem });
  const out = await importCompanyCa(r);
  assert.ok(!out.ok);
  assert.deepEqual(codes(out), ["key-mismatch"]);
  assert.deepEqual(r.secrets.refs(), [], "nothing is stored on failure");
});

test("names the certificate does not cover: host and IP are reported separately", async () => {
  const pki = makePki({ dns: ["other.corp.example"], ips: ["10.9.9.9"] });
  const out = await importCompanyCa(req({ certChainPem: pki.leafPem + pki.interPem, keyPem: pki.leafKeyPem, caPem: pki.rootPem }));
  assert.ok(!out.ok);
  assert.deepEqual(codes(out), ["san-missing", "san-missing"]);
  assert.ok(out.issues.some((i) => i.message.includes("harness.corp.example")));
  assert.ok(out.issues.some((i) => i.message.includes("192.168.1.20")));
  const none = await importCompanyCa(req({ certChainPem: pki.leafPem, keyPem: pki.leafKeyPem, hostnames: [], ips: [] } as never));
  assert.ok(!none.ok);
  assert.ok(codes(none).includes("no-names"));
});

test("expired and not-yet-valid certificates, leaf or CA", async () => {
  const expired = makePki({ leafFrom: -400, leafTo: -1 });
  const a = await importCompanyCa(req({ certChainPem: expired.leafPem + expired.interPem, keyPem: expired.leafKeyPem, caPem: expired.rootPem }));
  assert.ok(!a.ok);
  assert.deepEqual(codes(a), ["expired"]);
  const future = makePki({ leafFrom: 1, leafTo: 400 });
  const b = await importCompanyCa(req({ certChainPem: future.leafPem + future.interPem, keyPem: future.leafKeyPem, caPem: future.rootPem }));
  assert.ok(!b.ok);
  assert.deepEqual(codes(b), ["not-yet-valid"]);
  const oldRoot = makePki({ rootFrom: -4000, rootTo: -1 });
  const c = await importCompanyCa(req({ certChainPem: oldRoot.leafPem + oldRoot.interPem, keyPem: oldRoot.leafKeyPem, caPem: oldRoot.rootPem }));
  assert.ok(!c.ok);
  assert.ok(codes(c).includes("ca-expired"));
});

test("incomplete chain: the intermediate is missing, or its signature does not check out", async () => {
  const pki = makePki();
  const missing = await importCompanyCa(req({ certChainPem: pki.leafPem, keyPem: pki.leafKeyPem, caPem: pki.rootPem }));
  assert.ok(!missing.ok);
  assert.deepEqual(codes(missing), ["chain-incomplete"]);
  // an intermediate with the right name but another key: names match, signatures do not
  const impostor = buildCertificate({
    subject: { cn: "Corp Issuing CA", o: "Corp" }, issuer: { cn: "Corp Root CA", o: "Corp" },
    publicKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey, signingKey: pki.strangerInterKey,
    notBefore: new Date(NOW.getTime() - DAY), notAfter: new Date(NOW.getTime() + DAY), isCa: true,
  });
  const forged = await importCompanyCa(req({ certChainPem: pki.leafPem + impostor.pem, keyPem: pki.leafKeyPem, caPem: pki.rootPem }));
  assert.ok(!forged.ok);
  assert.ok(codes(forged).includes("chain-incomplete"));
});

test("the root CA argument must be a self-signed CA", async () => {
  const pki = makePki();
  const chain = pki.leafPem + pki.interPem;
  const notCa = await importCompanyCa(req({ certChainPem: chain, keyPem: pki.leafKeyPem, caPem: pki.leafPem }));
  assert.ok(!notCa.ok);
  assert.ok(codes(notCa).includes("ca-invalid"));
  const notRoot = await importCompanyCa(req({ certChainPem: chain, keyPem: pki.leafKeyPem, caPem: pki.interPem }));
  assert.ok(!notRoot.ok);
  assert.ok(codes(notRoot).includes("ca-invalid"));
  const garbage = await importCompanyCa(req({ certChainPem: chain, keyPem: pki.leafKeyPem, caPem: "not a pem" }));
  assert.ok(!garbage.ok);
  assert.ok(codes(garbage).includes("ca-invalid"));
});

test("unusable input: no certificate, garbage key, passphrase-protected key, leaf not first", async () => {
  const pki = makePki();
  const noCert = await importCompanyCa(req({ certChainPem: "hello", keyPem: pki.leafKeyPem }));
  assert.ok(!noCert.ok);
  assert.deepEqual(codes(noCert), ["chain-unparseable"]);
  const badKey = await importCompanyCa(req({ certChainPem: pki.leafPem + pki.interPem, keyPem: pemLike("AAAA") }));
  assert.ok(!badKey.ok);
  assert.deepEqual(codes(badKey), ["key-unparseable"]);
  const protectedKey = newKey().privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "secret" }) as string;
  const enc = await importCompanyCa(req({ certChainPem: pki.leafPem + pki.interPem, keyPem: protectedKey }));
  assert.ok(!enc.ok);
  assert.deepEqual(codes(enc), ["key-encrypted"]);
  const swapped = await importCompanyCa(req({ certChainPem: pki.interPem + pki.leafPem, keyPem: pki.leafKeyPem, caPem: pki.rootPem }));
  assert.ok(!swapped.ok);
  assert.ok(codes(swapped).includes("leaf-not-first"));
});

test("several problems are reported together, not one at a time", async () => {
  const pki = makePki({ leafFrom: -400, leafTo: -1, dns: ["x.example"], ips: [] });
  const out = await importCompanyCa(req({ certChainPem: pki.leafPem + pki.interPem, keyPem: keyPem(pki.otherLeafKey), caPem: pki.rootPem }));
  assert.ok(!out.ok);
  assert.deepEqual(codes(out), ["expired", "key-mismatch", "san-missing", "san-missing"]);
  const x = new X509Certificate(pki.leafPem);
  assert.ok(x.validToDate);
});
