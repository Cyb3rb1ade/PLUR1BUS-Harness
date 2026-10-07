import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { generateSelfSigned } from "../src/selfsigned.ts";
import { certPin, formatHex, parsePin, pinsEqual, spkiPin } from "../src/fingerprint.ts";
import { inspectCertificate } from "../src/certs.ts";
import { createMemorySecretPort, loadTlsMaterial } from "../src/secrets.ts";

const NOW = new Date("2026-10-08T10:00:00Z");
const DAY = 86_400_000;
const REQ = {
  hostnames: ["harness.corp.example", "localhost"],
  ips: ["192.168.1.20", "fd00::20"],
  magicDnsName: "box.tail1234.ts.net",
  now: NOW,
  keyRef: "remote/tls/key-1",
};

test("generateSelfSigned: a real certificate that node parses, with every name in the SAN", async () => {
  const secrets = createMemorySecretPort();
  const out = await generateSelfSigned({ ...REQ, secrets });
  const x = new X509Certificate(out.certPem);
  assert.equal(x.checkHost("harness.corp.example"), "harness.corp.example");
  assert.equal(x.checkHost("box.tail1234.ts.net"), "box.tail1234.ts.net");
  assert.equal(x.checkHost("localhost"), "localhost");
  assert.equal(x.checkHost("evil.example"), undefined);
  assert.equal(x.checkIP("192.168.1.20"), "192.168.1.20");
  assert.ok(x.checkIP("fd00::20"));
  assert.equal(x.checkIP("192.168.1.21"), undefined);
  assert.equal(x.ca, false);
  assert.ok(x.verify(x.publicKey), "self-signed: its own key verifies the signature");
  assert.equal(x.subject, x.issuer);
  assert.equal(x.checkIssued(x), false, "a leaf is not a CA: OpenSSL refuses it as an issuer, clients pin it instead of chaining to it");
  assert.ok(x.keyUsage?.includes("1.3.6.1.5.5.7.3.1"), "serverAuth");
  assert.deepEqual([...out.dns].sort(), ["box.tail1234.ts.net", "harness.corp.example", "localhost"]);
  assert.deepEqual([...out.ips].sort(), ["192.168.1.20", "fd00::20"]);
});

test("generateSelfSigned: validity window, default and custom", async () => {
  const secrets = createMemorySecretPort();
  const out = await generateSelfSigned({ ...REQ, secrets });
  const x = new X509Certificate(out.certPem);
  assert.equal(Math.round((new Date(x.validToDate).getTime() - NOW.getTime()) / DAY), 365);
  assert.ok(new Date(x.validFromDate).getTime() <= NOW.getTime(), "valid from slightly before now (clock skew)");
  assert.equal(out.notAfter.getTime(), new Date(x.validToDate).getTime());
  const short = await generateSelfSigned({ ...REQ, keyRef: "k2", validityDays: 30, secrets });
  assert.equal(Math.round((short.notAfter.getTime() - NOW.getTime()) / DAY), 30);
});

test("generateSelfSigned: the private key goes to the secret port and nowhere else", async () => {
  const secrets = createMemorySecretPort();
  const out = await generateSelfSigned({ ...REQ, secrets });
  assert.equal(out.keyRef, "remote/tls/key-1");
  assert.deepEqual(secrets.refs(), ["remote/tls/key-1"]);
  assert.ok(!JSON.stringify(out).includes("PRIVATE KEY"), "the result carries no key material");
  const stored = await secrets.get("remote/tls/key-1");
  assert.ok(stored);
  const key = createPrivateKey(Buffer.from(stored).toString("utf8"));
  assert.ok(new X509Certificate(out.certPem).checkPrivateKey(key));
  const tls = await loadTlsMaterial(secrets, out.keyRef, out.certPem);
  assert.match(tls.key, /BEGIN PRIVATE KEY/);
  assert.equal(tls.cert, out.certPem);
  await assert.rejects(loadTlsMaterial(secrets, "missing", out.certPem), /not found/i);
  const other = await generateSelfSigned({ ...REQ, keyRef: "k-other", secrets });
  await assert.rejects(loadTlsMaterial(secrets, "k-other", out.certPem), /does not match/i);
  assert.notEqual(other.certPin, out.certPin);
});

test("fingerprints: cert pin = SHA-256 of the DER, SPKI pin = SHA-256 of the SubjectPublicKeyInfo", async () => {
  const secrets = createMemorySecretPort();
  const out = await generateSelfSigned({ ...REQ, secrets });
  const x = new X509Certificate(out.certPem);
  const certHash = createHash("sha256").update(x.raw).digest();
  const spkiHash = createHash("sha256").update(x.publicKey.export({ type: "spki", format: "der" })).digest();
  assert.equal(out.certPin, `sha256:${certHash.toString("base64url")}`);
  assert.equal(out.spkiPin, `sha256:${spkiHash.toString("base64url")}`);
  assert.equal(certPin(out.certPem), out.certPin);
  assert.equal(certPin(x.raw), out.certPin);
  assert.equal(certPin(x), out.certPin);
  assert.equal(spkiPin(x), out.spkiPin);
  assert.equal(formatHex(certHash), x.fingerprint256);
  assert.equal(out.certPin.length, "sha256:".length + 43);
  assert.deepEqual(parsePin(out.certPin), certHash);
});

test("pins: parse strictly, compare in constant time", () => {
  const good = `sha256:${Buffer.alloc(32, 7).toString("base64url")}`;
  assert.ok(parsePin(good));
  for (const bad of ["", "sha256:", "sha1:abc", `sha256:${Buffer.alloc(31).toString("base64url")}`, `sha256:${Buffer.alloc(32).toString("base64")}=`, `SHA256:${Buffer.alloc(32).toString("base64url")}`, "sha256:!!!"]) {
    assert.equal(parsePin(bad), undefined, bad);
  }
  assert.equal(pinsEqual(good, good), true);
  assert.equal(pinsEqual(good, `sha256:${Buffer.alloc(32, 8).toString("base64url")}`), false);
  assert.equal(pinsEqual(good, "garbage"), false);
  assert.equal(pinsEqual("garbage", "garbage"), false, "an unparseable pin never matches, not even itself");
});

test("inspectCertificate: names, expiry arithmetic, expired and not-yet-valid", async () => {
  const secrets = createMemorySecretPort();
  const out = await generateSelfSigned({ ...REQ, validityDays: 40, secrets });
  const fresh = inspectCertificate(out.certPem, NOW);
  assert.equal(fresh.expired, false);
  assert.equal(fresh.notYetValid, false);
  assert.equal(fresh.daysLeft, 40);
  assert.equal(fresh.selfSigned, true);
  assert.equal(fresh.isCa, false);
  assert.deepEqual([...fresh.dns].sort(), ["box.tail1234.ts.net", "harness.corp.example", "localhost"]);
  assert.ok(fresh.ips.includes("192.168.1.20"));
  assert.ok(fresh.ips.includes("fd00::20"), "IPv6 comes back in compressed form");
  assert.equal(fresh.certPin, out.certPin);
  const later = inspectCertificate(out.certPem, new Date(NOW.getTime() + 41 * DAY));
  assert.equal(later.expired, true);
  assert.ok(later.daysLeft < 0);
  const earlier = inspectCertificate(out.certPem, new Date(NOW.getTime() - 2 * DAY));
  assert.equal(earlier.notYetValid, true);
});

test("generateSelfSigned: rejects bad input before touching the secret port", async () => {
  const secrets = createMemorySecretPort();
  const bad: Array<[string, Partial<typeof REQ>]> = [
    ["no names", { hostnames: [], ips: [], magicDnsName: undefined as never }],
    ["underscore host", { hostnames: ["bad_name"] }],
    ["trailing dot garbage", { hostnames: ["a..b"] }],
    ["IDN not in punycode", { hostnames: ["bücher.example"] }],
    ["host too long", { hostnames: ["a".repeat(64) + ".example"] }],
    ["wildcard", { hostnames: ["*.example"] }],
    ["bad ip", { ips: ["999.1.1.1"] }],
    ["hostname as ip", { ips: ["localhost"] }],
    ["too many names", { hostnames: Array.from({ length: 30 }, (_, i) => `h${i}.example`) }],
  ];
  for (const [label, over] of bad) {
    await assert.rejects(generateSelfSigned({ ...REQ, ...over, secrets }), /.+/, label);
  }
  for (const days of [0, -1, 1.5, 2000]) {
    await assert.rejects(generateSelfSigned({ ...REQ, validityDays: days, secrets }), /validity/i, String(days));
  }
  assert.deepEqual(secrets.refs(), []);
  const ok = await generateSelfSigned({ ...REQ, hostnames: ["Harness.Corp.Example", "harness.corp.example"], ips: ["::ffff:192.168.1.20", "192.168.1.20"], secrets });
  assert.deepEqual([...ok.dns].sort(), ["box.tail1234.ts.net", "harness.corp.example"], "case-folded and de-duplicated");
  assert.deepEqual([...ok.ips], ["192.168.1.20"], "IPv4-mapped duplicate collapses");
});
