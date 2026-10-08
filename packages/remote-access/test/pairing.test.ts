import { test } from "node:test";
import assert from "node:assert/strict";
import { PairCodeStore } from "../src/pair-code.ts";
import { buildPairingOffer, encodePairingLink, offerTag, parseOrigin, parsePairingLink, qrData, verifyOfferTag } from "../src/pairing.ts";
import type { BuildOfferInput, SignedOffer } from "../src/pairing.ts";
import { pinOf } from "../src/fingerprint.ts";

const T0 = 1_700_000_000_000;
const KEY = Buffer.alloc(32, 9);
const CERT = pinOf(Buffer.from("leaf certificate"));
const CA = pinOf(Buffer.from("root ca"));
const NEXT_CERT = pinOf(Buffer.from("next leaf"));
const NEXT_CA = pinOf(Buffer.from("next ca"));
const mkStore = () => new PairCodeStore({ params: { memoryKiB: 64, passes: 1, parallelism: 1 } });
const input = (over: Partial<BuildOfferInput> = {}): BuildOfferInput => ({
  store: mkStore(), now: T0, publish: "network", tls: "self-signed",
  origins: ["https://192.168.1.20:18701"], certPin: CERT, signKey: KEY, ...over,
});
function built(over: Partial<BuildOfferInput> = {}) {
  const r = buildPairingOffer(input(over));
  assert.ok(r.ok, JSON.stringify(r));
  return r;
}

test("network + self-signed: certPin only", () => {
  const { offer } = built({ caPin: CA });
  assert.equal(offer.certPin, CERT);
  assert.equal(offer.caPin, undefined, "a CA pin never rides along with a self-signed certificate");
  assert.deepEqual(offer.origins, ["https://192.168.1.20:18701"]);
  assert.equal(offer.expiresAt, T0 + 3_600_000);
  assert.match(offer.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

test("network + company-ca: caPin when the root CA is held, nothing otherwise; never a certPin", () => {
  const withCa = built({ tls: "company-ca", certPin: CERT, caPin: CA }).offer;
  assert.equal(withCa.caPin, CA);
  assert.equal(withCa.certPin, undefined);
  const without = built({ tls: "company-ca", certPin: CERT }).offer;
  assert.equal(without.caPin, undefined);
  assert.equal(without.certPin, undefined, "clients then rely on the OS trust store");
});

test("tailnet and local carry no pin at all (valid certificate / loopback)", () => {
  for (const publish of ["tailnet", "local"] as const) {
    const origin = publish === "local" ? "http://127.0.0.1:18700" : "https://box.tail1234.ts.net";
    const { offer } = built({ publish, origins: [origin], certPin: CERT, caPin: CA });
    assert.equal(offer.certPin, undefined, publish);
    assert.equal(offer.caPin, undefined, publish);
  }
});

test("a missing certPin for network + self-signed, bad or missing origins and local reach are refused", () => {
  const miss = buildPairingOffer(input({ certPin: undefined as never }));
  assert.ok(!miss.ok);
  assert.equal(miss.issues[0]?.code, "cert-pin-required");
  const none = buildPairingOffer(input({ origins: [] }));
  assert.ok(!none.ok);
  assert.equal(none.issues[0]?.code, "no-origin");
  for (const bad of ["http://192.168.1.20:18701", "https://u:p@host.example", "https://host.example/path", "ftp://x", "https://host.example?x=1", "host.example"]) {
    const r = buildPairingOffer(input({ origins: [bad] }));
    assert.ok(!r.ok, bad);
    assert.equal(r.issues[0]?.code, "bad-origin", bad);
  }
  const lan = buildPairingOffer(input({ publish: "local", origins: ["https://192.168.1.20:18701"] }));
  assert.ok(!lan.ok);
  assert.equal(lan.issues[0]?.code, "origin-not-reachable-at-local");
  const many = buildPairingOffer(input({ origins: ["https://a.example", "https://b.example", "https://c.example", "https://d.example"] }));
  assert.ok(!many.ok);
  assert.equal(many.issues[0]?.code, "too-many-origins");
});

test("parseOrigin: spec §6.2 origin rules, IDN shown as punycode", () => {
  assert.equal(parseOrigin("https://host.example"), "https://host.example");
  assert.equal(parseOrigin("https://host.example:8443"), "https://host.example:8443");
  assert.equal(parseOrigin("https://HOST.example"), "https://host.example");
  assert.equal(parseOrigin("https://bücher.example"), "https://xn--bcher-kva.example");
  assert.equal(parseOrigin("http://127.0.0.1:18700"), "http://127.0.0.1:18700");
  assert.equal(parseOrigin("http://localhost:18700"), "http://localhost:18700");
  assert.equal(parseOrigin("http://[::1]:18700"), "http://[::1]:18700");
  assert.equal(parseOrigin("https://[fd00::20]:18701"), "https://[fd00::20]:18701");
  for (const bad of ["http://192.168.1.1", "http://host.example", "https://host.example/", "https://host.example/a", "https://a@host.example", "https://host.example#f", "gopher://x", "", "https://"]) {
    assert.equal(parseOrigin(bad), undefined, bad);
  }
});

test("deep link roundtrip carries everything, pins unescaped as in the spec", () => {
  const { offer, link } = built({ origins: ["https://192.168.1.20:18701", "https://box.tail1234.ts.net"], nextCertPin: NEXT_CERT, nextCaPin: NEXT_CA });
  assert.ok(link.startsWith("plur1bus://pair?origin=https%3A%2F%2F192.168.1.20%3A18701&origin=https%3A%2F%2Fbox.tail1234.ts.net&code="));
  assert.ok(link.includes(`&pin=${CERT}`), "pin=sha256:… literally");
  assert.ok(link.includes(`&nextpin=${NEXT_CERT}`));
  assert.ok(link.includes(`&nextca=${NEXT_CA}`));
  assert.equal(link, encodePairingLink(offer));
  const back = parsePairingLink(link);
  assert.ok(back.ok, JSON.stringify(back));
  assert.deepEqual(back.offer, offer);
  const company = built({ tls: "company-ca", caPin: CA });
  assert.ok(company.link.includes(`&ca=${CA}`));
  assert.ok(!company.link.includes("&pin="));
  const rt = parsePairingLink(company.link);
  assert.ok(rt.ok);
  assert.equal(rt.offer.caPin, CA);
});

test("parsePairingLink: strict about scheme, keys, duplicates, code, expiry, pins and tag", () => {
  const { link } = built();
  const bad = (l: string) => { const r = parsePairingLink(l); assert.ok(!r.ok, l); return r.issues.map((i) => i.code); };
  assert.ok(bad(link.replace("plur1bus://", "https://")).includes("bad-scheme"));
  assert.ok(bad(link.replace("//pair?", "//other?")).includes("bad-action"));
  assert.ok(bad(`${link}&extra=1`).includes("unknown-param"));
  assert.ok(bad(`${link}&code=ABCD-EFGH`).includes("duplicate-param"));
  assert.ok(bad(link.replace(/code=[^&]+/, "code=nope")).includes("bad-code"));
  assert.ok(bad(link.replace(/exp=\d+/, "exp=soon")).includes("bad-expiry"));
  assert.ok(bad(link.replace(/pin=[^&]+/, "pin=sha1:abc")).includes("bad-pin"));
  assert.ok(bad(link.replace(/&tag=[^&]+/, "")).includes("missing-param"));
  assert.ok(bad(link.replace(/origin=[^&]+/, "origin=http%3A%2F%2F10.0.0.1")).includes("bad-origin"));
  assert.ok(bad("not a url at all").length > 0);
});

test("integrity tag: HMAC over every field, truncated to 128 bits, verified in constant time", () => {
  const { offer } = built({ nextCertPin: NEXT_CERT });
  assert.equal(offer.tag.length, 22);
  assert.ok(verifyOfferTag(offer, KEY));
  assert.ok(!verifyOfferTag(offer, Buffer.alloc(32, 8)), "another key");
  const variants: SignedOffer[] = [
    { ...offer, code: "ABCD-EFGH" },
    { ...offer, origins: ["https://10.0.0.1:18701"] },
    { ...offer, expiresAt: offer.expiresAt + 1000 },
    { ...offer, certPin: CA },
    { ...offer, nextCertPin: NEXT_CA },
    { ...offer, caPin: CA },
    { ...offer, tag: offer.tag.slice(1) + "A" },
  ];
  for (const v of variants) assert.ok(!verifyOfferTag(v, KEY), JSON.stringify(v));
  assert.equal(offerTag(offer, KEY), offer.tag);
  // field boundaries are unambiguous: moving text between origin and code cannot keep a tag valid
  assert.notEqual(offerTag({ ...offer, origins: ["https://a.example", "https://b.example"] }, KEY), offerTag({ ...offer, origins: ["https://a.example,https://b.example"] }, KEY));
});

test("the code is recoverable by redeeming through the store, and the store keeps no plaintext", () => {
  const store = mkStore();
  const { offer } = built({ store });
  assert.ok(!JSON.stringify(store.snapshot(T0)).includes(offer.code));
  assert.equal(store.redeem(offer.code, T0 + 5).ok, true);
});

test("qrData: the exact deep link as byte-mode text with the recommended error correction", () => {
  const { link, qr } = built({ nextCertPin: NEXT_CERT });
  assert.deepEqual(qr, { text: link, mode: "byte", errorCorrection: "M", length: Buffer.byteLength(link), maxLength: 2331, fits: true });
  assert.ok(qr.length < 400, "a typical offer is far below the QR capacity");
  assert.equal(qrData("x".repeat(3000)).fits, false);
});
