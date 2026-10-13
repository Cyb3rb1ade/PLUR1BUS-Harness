// Step 8 of the server hardening sweep: the DER reader, X.509 handling, self-signed and company-CA certificates, pinning
// and trust rollover. Time is the injected `now`/Date of this package; generative cases use mulberry32 with a fixed seed
// that appears in every failure message. Network use is in-process only (127.0.0.1, port 0).
// Already pinned elsewhere (not repeated): the builder's output against node's parser and a real handshake (der.test.ts,
// x509.coverage.test.ts, pinning-e2e.test.ts), the company-CA finding matrix (company-ca*.test.ts), the rollover happy
// path and its refusals by example (trust-rollover.test.ts), strict pin parsing (selfsigned.test.ts).
import assert from "node:assert/strict";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import tls from "node:tls";
import test from "node:test";
import { importCompanyCa } from "../src/company-ca.ts";
import { inspectCertificate } from "../src/certs.ts";
import { children, readTlv, seq, tlv } from "../src/der.ts";
import { certPin, parsePin, pinOf, pinsEqual } from "../src/fingerprint.ts";
import { verifySocket } from "../src/pinning.ts";
import { generateSelfSigned } from "../src/selfsigned.ts";
import { createMemorySecretPort } from "../src/secrets.ts";
import { buildCertificate, pemEncode } from "../src/x509.ts";
import {
  ackTrust, acceptedAnchors, evaluateConnection, initTrust, parseTrust, promote, receiveAnnouncement, announcementFor, serializeTrust, stageTrust, switchTrust, trustProgress, cancelTrust,
  type Anchor, type DeviceTrust, type TrustDevice, type TrustState,
} from "../src/trust-rollover.ts";
import { makePki, NOW } from "./helpers.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ec = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const DAY = 86_400_000;

// ---- the DER reader ------------------------------------------------------------------------------------------------

/** Walks every constructed value below `buf` with an explicit stack (no recursion): returns how many values were read. Throws only what the reader throws. */
function walk(buf: Uint8Array, budget = 200_000): number {
  const stack: Array<[number, number]> = [[0, buf.length]]; let count = 0;
  while (stack.length > 0) {
    const [from, to] = stack.pop()!; let at = from;
    while (at < to) {
      if (++count > budget) throw new Error("walk budget exceeded: the reader is not making progress");
      const t = readTlv(buf.subarray(0, to), at); if (t.end <= at || t.start < at || t.end > to) throw new Error(`der result out of range: ${JSON.stringify(t)} in [${at}, ${to})`);
      if (t.tag & 0x20) stack.push([t.start, t.end]);
      at = t.end;
    }
  }
  return count;
}
const derClass = (e: unknown) => e instanceof Error && e.constructor === Error && /^der: /.test(e.message);

test("DER reader on 7000 generated broken inputs (seeded): always a result inside the buffer or a 'der:' error, never another exception, never a hang", () => {
  const SEED = 0xDE6A11; const rand = mulberry32(SEED); const base = ec(); const cert = buildCertificate({ subject: { cn: "fuzz.example" }, publicKey: base.publicKey, signingKey: base.privateKey, notBefore: new Date(+NOW - DAY), notAfter: new Date(+NOW + DAY), dns: ["fuzz.example"], isCa: false }).der;
  let accepted = 0; let refused = 0; const t0 = Date.now();
  const run = (label: string, buf: Buffer) => { try { walk(buf); accepted++; } catch (e) { refused++; assert.ok(derClass(e), `seed ${SEED} ${label}: ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`); } };
  for (let cut = 0; cut < cert.length; cut++) run(`truncated at ${cut}`, cert.subarray(0, cut));                                   // truncated: every length
  for (let i = 0; i < 2500; i++) { const b = Buffer.from(cert); const n = 1 + Math.floor(rand() * 4); for (let k = 0; k < n; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256); run(`random bytes ${i}`, b); }
  for (let i = 0; i < 1500; i++) run(`noise ${i}`, Buffer.from(Array.from({ length: Math.floor(rand() * 64) }, () => Math.floor(rand() * 256))));
  for (let i = 0; i < 1500; i++) {                                                                                                // length fields: too big, indefinite, wide, nested wrongly
    const pick = Math.floor(rand() * 7); const body = Buffer.from(Array.from({ length: Math.floor(rand() * 8) }, () => Math.floor(rand() * 256)));
    const length = [Buffer.from([0x84, 0xff, 0xff, 0xff, 0xff]), Buffer.from([0x85, 0, 0, 0, 0, 1]), Buffer.from([0x80]), Buffer.from([0x82, 0xff, 0xff]), Buffer.from([0x81, 0xff]), Buffer.from([0x88, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), Buffer.from([0x7f])][pick]!;
    run(`length ${i} (${pick})`, Buffer.concat([Buffer.from([0x30]), length, body]));
  }
  assert.ok(accepted > 0 && refused > 3000, `seed ${SEED}: ${accepted} accepted, ${refused} refused: the generator did not exercise both outcomes`);
  assert.ok(Date.now() - t0 < 20_000, `seed ${SEED}: the run took ${Date.now() - t0} ms`);
});

test("nesting 100 000 levels deep and a million siblings are read or refused in bounded time without a stack overflow", () => {
  const depth = 100_000; const headerSize = (len: number) => (len < 0x80 ? 2 : len < 0x100 ? 3 : len < 0x10000 ? 4 : len < 0x1000000 ? 5 : 6);
  const total: number[] = [2]; for (let k = 1; k <= depth; k++) total.push(total[k - 1]! + headerSize(total[k - 1]!)); // total size of level k, level 0 being an empty SEQUENCE
  const buf = Buffer.alloc(total[depth]!); let at = 0;
  for (let level = depth; level >= 1; level--) { // outermost first, every length minimal, as DER writes it
    const len = total[level - 1]!; buf[at++] = 0x30;
    if (len < 0x80) buf[at++] = len; else { const n = headerSize(len) - 2; buf[at++] = 0x80 | n; for (let k = n - 1; k >= 0; k--) buf[at++] = (len >>> (8 * k)) & 0xff; }
  }
  buf[at++] = 0x30; buf[at++] = 0x00; assert.equal(at, buf.length, "the fixture is exactly one well-formed value");
  const t0 = Date.now(); assert.equal(walk(buf, 300_000) > depth, true); assert.ok(Date.now() - t0 < 5_000, `${Date.now() - t0} ms`);
  const flat = Buffer.alloc(2_000_000, 0x05); for (let i = 1; i < flat.length; i += 2) flat[i] = 0x00; const t1 = Date.now();
  assert.equal(children(flat).length, 1_000_000); assert.ok(Date.now() - t1 < 5_000, `${Date.now() - t1} ms`);
});

test("lengths must be minimal, as DER requires: the long form for a value below 128 and leading zero length octets are refused", () => {
  for (const hex of ["3081050102030405", "308200050102030405", "30830000050102030405", "3082007f" + "01".repeat(0x7f)]) assert.throws(() => readTlv(Buffer.from(hex, "hex"), 0), (e: unknown) => derClass(e), hex.slice(0, 12));
  for (const hex of ["30050102030405", "308180" + "01".repeat(0x80), "30820100" + "00".repeat(256)]) assert.doesNotThrow(() => readTlv(Buffer.from(hex, "hex"), 0), hex.slice(0, 12));
});

// ---- X.509 with node's parser ---------------------------------------------------------------------------------------

function leafFor(cn = "h.example") { const k = ec(); const c = buildCertificate({ subject: { cn }, publicKey: k.publicKey, signingKey: k.privateKey, notBefore: new Date(+NOW - DAY), notAfter: new Date(+NOW + DAY), dns: [cn] }); return { ...c, key: k }; }
const asPem = (der: Uint8Array) => pemEncode("CERTIFICATE", der);

test("1200 mutated certificates (seeded): node's parser refuses or accepts each without throwing anything but an Error; an accepted one with an unreadable validity period is never 'valid'", () => {
  const SEED = 0x509A; const rand = mulberry32(SEED); const base = leafFor(); let parsed = 0; let broke = 0; const unreadable: string[] = [];
  for (let i = 0; i < 1200; i++) {
    const b = Buffer.from(base.der); const n = 1 + Math.floor(rand() * 3); for (let k = 0; k < n; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
    let x: X509Certificate | undefined;
    try { x = new X509Certificate(b); } catch (e) { broke++; assert.ok(e instanceof Error, `seed ${SEED} case ${i}`); }
    if (!x) continue; parsed++;
    let info; try { info = inspectCertificate(x, NOW); } catch (e) { assert.ok(e instanceof Error, `seed ${SEED} case ${i}: ${String(e)}`); continue; } // a certificate node parses lazily may fail late: as an Error
    if (Number.isNaN(info.notBefore.getTime()) || Number.isNaN(info.notAfter.getTime())) { if (!info.expired) unreadable.push(`case ${i}`); }
  }
  assert.ok(broke > 300 && parsed > 0, `seed ${SEED}: ${parsed} parsed, ${broke} refused`);
  assert.deepEqual(unreadable, [], `seed ${SEED}: certificates with an unreadable validity period were reported as not expired (fail-open)`);
});

test("a certificate whose validity dates cannot be read is refused by the company-CA import, never imported as valid with an Invalid Date", async () => {
  const k = ec(); const c = buildCertificate({ subject: { cn: "h.example" }, publicKey: k.publicKey, signingKey: k.privateKey, notBefore: new Date(+NOW - DAY), notAfter: new Date(+NOW + DAY), dns: ["h.example"] });
  const text = Buffer.from(c.der).toString("latin1"); const at = text.indexOf("261007"); assert.ok(at > 0, "found the notBefore UTCTime");
  for (const [label, patch] of [["letters", "26AB07100000Z"], ["month 13", "261307100000Z"], ["no Z", "2610071000000"], ["day 99", "261099100000Z"]] as const) {
    const m = Buffer.from(c.der); m.write(patch, at, "latin1"); const secrets = createMemorySecretPort();
    const r = await importCompanyCa({ certChainPem: asPem(m), keyPem: k.privateKey.export({ type: "pkcs8", format: "pem" }) as string, hostnames: ["h.example"], now: NOW, keyRef: "k", secrets });
    assert.equal(r.ok, false, `${label}: imported with notAfter ${r.ok ? String(r.notAfter) : ""}`); assert.deepEqual(secrets.refs(), [], `${label}: a key was stored for a certificate that could not be validated`);
  }
});

test("1000 hostile uploads (seeded PEM armour around noise, truncated blocks, nested armour, huge blocks): always a defined refusal, nothing stored, never an exception", async () => {
  const SEED = 0xBAD9E3; const rand = mulberry32(SEED); const k = ec(); const keyPem = k.privateKey.export({ type: "pkcs8", format: "pem" }) as string; const good = leafFor().pem;
  const noise = (n: number) => Buffer.from(Array.from({ length: n }, () => Math.floor(rand() * 256))).toString("base64").replace(/(.{64})/g, "$1\n");
  const shapes = [
    () => `-----BEGIN CERTIFICATE-----\n${noise(Math.floor(rand() * 400))}\n-----END CERTIFICATE-----\n`, () => `-----BEGIN CERTIFICATE-----\n${noise(200)}`, () => `${good.slice(0, Math.floor(rand() * good.length))}`,
    () => `-----BEGIN CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\n${noise(80)}\n-----END CERTIFICATE-----\n-----END CERTIFICATE-----\n`, () => good.replace(/[A-Za-z0-9]/, () => "!"), () => Buffer.from(noise(300), "base64").toString("latin1"),
    () => { const b = Buffer.from(new X509Certificate(good).raw); for (let k = 0; k < 1 + Math.floor(rand() * 3); k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256); return pemEncode("CERTIFICATE", b); },
    () => good + good + good, () => `\u0000${good}`, () => good.replace(/\n/g, "\r\n"), () => `-----BEGIN CERTIFICATE-----\n${"A".repeat(200_000)}\n-----END CERTIFICATE-----\n`, () => "", () => "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n",
  ];
  const secrets = createMemorySecretPort(); const t0 = Date.now(); let okCount = 0;
  for (let i = 0; i < 1000; i++) {
    const text = shapes[Math.floor(rand() * shapes.length)]!();
    const r = await importCompanyCa({ certChainPem: text, keyPem: rand() < 0.5 ? keyPem : noise(40), caPem: rand() < 0.3 ? shapes[Math.floor(rand() * shapes.length)]!() : undefined, hostnames: ["h.example"], now: NOW, keyRef: `k${i}`, secrets } as never);
    if (r.ok) okCount++; else assert.ok(r.issues.length > 0 && r.issues.every((x) => /^[a-z][a-z-]+$/.test(x.code) && x.message.length > 0), `seed ${SEED} case ${i}: ${JSON.stringify(r)}`);
  }
  assert.equal(okCount, 0, `seed ${SEED}: a hostile upload was imported`); assert.deepEqual(secrets.refs(), [], "no key was stored for any of them");
  assert.ok(Date.now() - t0 < 60_000, `${Date.now() - t0} ms`);
});

test("an upload whose fields are not text at all (a JSON body that was not checked) is a refusal with findings, not a TypeError", async () => {
  const secrets = createMemorySecretPort(); const pki = makePki();
  for (const bad of [undefined, null, 5, {}, [], ["x"], true]) {
    for (const field of ["certChainPem", "keyPem", "caPem"] as const) {
      const req = { certChainPem: pki.leafPem + pki.interPem, keyPem: pki.leafKeyPem, caPem: pki.rootPem, hostnames: ["harness.corp.example"], now: NOW, keyRef: "k", secrets, [field]: bad };
      if (field === "caPem" && bad === undefined) continue;
      const r = await importCompanyCa(req as never); assert.equal(r.ok, false, `${field}=${JSON.stringify(bad)}`);
    }
  }
  assert.deepEqual(secrets.refs(), []);
});

test("a thousand certificate blocks in one upload are bounded work and a defined refusal", async () => {
  const pki = makePki(); const secrets = createMemorySecretPort(); const t0 = Date.now();
  const r = await importCompanyCa({ certChainPem: pki.leafPem + pki.interPem.repeat(1000), keyPem: pki.leafKeyPem, caPem: pki.rootPem, hostnames: ["harness.corp.example"], now: NOW, keyRef: "k", secrets });
  assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0} ms`); assert.equal(r.ok === true ? r.chainPem.split("BEGIN CERTIFICATE").length - 1 <= 20 : true, true, "a stored chain is never absurdly long");
});

// ---- unknown OIDs --------------------------------------------------------------------------------------------------

/** Replaces the first occurrence of `from` in the certificate's DER by `to` (same length): used to put an OID nobody knows where a known one was. */
const swap = (der: Buffer, from: string, to: string): Buffer => { const out = Buffer.from(der); const i = out.indexOf(Buffer.from(from, "hex")); assert.ok(i >= 0, `${from} not found`); Buffer.from(to, "hex").copy(out, i); return out; };

test("unknown OIDs (a signature algorithm, an extended key usage, a critical extension) never throw: each ends in a defined import result", async () => {
  const pki = makePki(); const secrets = createMemorySecretPort(); const leafDer = Buffer.from(new X509Certificate(pki.leafPem).raw);
  const variants: Array<[string, Buffer]> = [
    ["unknown signature algorithm", swap(leafDer, "2a8648ce3d040302", "2a8648ce3d040363")], ["unknown extended key usage", swap(leafDer, "2b06010505070301", "2b06010505070363")],
    ["unknown critical extension", swap(leafDer, "551d0f", "551d63")], ["unknown name attribute", swap(leafDer, "550403", "550463")],
  ];
  for (const [label, der] of variants) {
    let r; try { r = await importCompanyCa({ certChainPem: asPem(der) + pki.interPem, keyPem: pki.leafKeyPem, caPem: pki.rootPem, hostnames: ["harness.corp.example"], now: NOW, keyRef: "k", secrets }); } catch (e) { assert.fail(`${label}: threw ${(e as Error).message}`); }
    assert.ok(typeof r.ok === "boolean", label); if (!r.ok) assert.ok(r.issues.length > 0, label);
  }
  const eku = await importCompanyCa({ certChainPem: asPem(variants[1]![1]) + pki.interPem, keyPem: pki.leafKeyPem, caPem: pki.rootPem, hostnames: ["harness.corp.example"], now: NOW, keyRef: "k2", secrets });
  assert.equal(eku.ok === false && eku.issues.some((i) => i.code === "eku-no-server-auth"), true, "a certificate that is valid for no known purpose is not a server certificate");
});

test("KNOWN GAP: a leaf with a critical extension nobody understands is imported (TLS clients such as rustls will refuse it at connect time)", { todo: "KNOWN GAP: the import does not look at critical extensions; see SICHERHEIT in the PR" }, async () => {
  const pki = makePki(); const secrets = createMemorySecretPort(); const bad = swap(Buffer.from(new X509Certificate(pki.leafPem).raw), "551d0f", "551d63");
  const r = await importCompanyCa({ certChainPem: asPem(bad), keyPem: pki.leafKeyPem, hostnames: ["harness.corp.example"], now: NOW, keyRef: "k", secrets });
  assert.equal(r.ok, false);
});

// ---- self-signed and company-CA time -------------------------------------------------------------------------------

/** The TLVs directly below [from, to), with absolute offsets. */
const kids = (buf: Buffer, from: number, to: number) => children(buf.subarray(from, to)).map((t) => ({ tag: t.tag, start: t.start + from, end: t.end + from }));
function extensionsOf(der: Buffer): Map<string, { critical: boolean; value: Buffer }> {
  const cert = readTlv(der, 0); const tbs = kids(der, cert.start, cert.end)[0]!; const items = kids(der, tbs.start, tbs.end);
  const ext = items.find((t) => t.tag === 0xa3)!; const list = readTlv(der, ext.start); const out = new Map<string, { critical: boolean; value: Buffer }>();
  for (const e of kids(der, list.start, list.end)) {
    const parts = kids(der, e.start, e.end); const critical = parts.length === 3 && der[parts[1]!.start] === 0xff; const last = parts[parts.length - 1]!;
    out.set(Buffer.from(der.subarray(parts[0]!.start, parts[0]!.end)).toString("hex"), { critical, value: Buffer.from(der.subarray(last.start, last.end)) });
  }
  return out;
}

test("a generated self-signed certificate says what the documentation says: leaf only, digitalSignature, serverAuth, the exact names, P-256, the validity window on the injected clock", async () => {
  const secrets = createMemorySecretPort(); const now = new Date("2026-10-08T10:00:00.789Z");
  const r = await generateSelfSigned({ hostnames: ["Harness.LAN", "harness.lan", "nas"], ips: ["192.168.1.20", "fe80::1%eth0", "192.168.1.20"], magicDnsName: "box.tail1234.ts.net", now, keyRef: "k", secrets });
  const x = new X509Certificate(r.certPem); const info = inspectCertificate(x, now);
  assert.deepEqual([...info.dns].sort(), ["box.tail1234.ts.net", "harness.lan", "nas"]); assert.deepEqual(info.ips.length, 2);
  assert.equal(info.isCa, false); assert.equal(info.selfSigned, true); assert.equal(x.publicKey.asymmetricKeyType, "ec"); assert.equal(x.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
  assert.equal(info.notBefore.getTime(), Math.floor((+now - 300_000) / 1000) * 1000, "valid from five minutes before now (clock skew), to the second"); assert.equal(info.notAfter.getTime(), Math.floor((+now + 365 * DAY) / 1000) * 1000);
  const ext = extensionsOf(x.raw);
  assert.equal(ext.get("551d0f")!.critical, true); assert.deepEqual([...ext.get("551d0f")!.value], [0x03, 0x02, 0x07, 0x80], "keyUsage: digitalSignature only");
  assert.deepEqual([...ext.get("551d13")!.value], [0x30, 0x00], "basicConstraints: CA is false"); assert.equal(ext.get("551d13")!.critical, true);
  assert.ok(ext.get("551d25")!.value.includes(Buffer.from("2b06010505070301", "hex")), "extended key usage: serverAuth"); assert.equal(ext.get("551d25")!.value.includes(Buffer.from("2b06010505070302", "hex")), false, "never clientAuth");
  for (const [label, at, expiredAt] of [["at notBefore", info.notBefore.getTime(), false], ["a millisecond before notBefore", info.notBefore.getTime() - 1, false], ["at notAfter", info.notAfter.getTime(), false], ["a millisecond after notAfter", info.notAfter.getTime() + 1, true]] as const) {
    const i = inspectCertificate(x, new Date(at)); assert.equal(i.expired, expiredAt, label); assert.equal(i.notYetValid, label.startsWith("a millisecond before"), label);
  }
});

test("self-signed input limits: names, wildcards, IDN, underscores, trailing dots, 253 characters, 20 names, 1 and 825 days, an invalid clock", async () => {
  const mk = (o: Record<string, unknown>) => generateSelfSigned({ hostnames: ["ok.example"], now: NOW, keyRef: "k", secrets: createMemorySecretPort(), ...o } as never);
  for (const bad of ["*.example", "bücher.example", "under_score.example", "trailing.dot.", "-lead.example", "trail-.example", "sp ace.example", "", ".", "a..b", `${"a".repeat(64)}.example`, `${"a.".repeat(130)}x`]) await assert.rejects(mk({ hostnames: [bad] }), /invalid host name/, JSON.stringify(bad.slice(0, 20)));
  await assert.doesNotReject(mk({ hostnames: [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`] }));
  await assert.rejects(mk({ hostnames: Array.from({ length: 21 }, (_, i) => `h${i}.example`) }), /at most 20/); await assert.doesNotReject(mk({ hostnames: Array.from({ length: 20 }, (_, i) => `h${i}.example`) }));
  for (const days of [0, -1, 826, 1.5, NaN, Infinity]) await assert.rejects(mk({ validityDays: days }), /validity/, String(days));
  await assert.doesNotReject(mk({ validityDays: 1 })); await assert.doesNotReject(mk({ validityDays: 825 }));
  await assert.rejects(mk({ now: new Date(NaN) }), /invalid date/); await assert.rejects(mk({ hostnames: [], ips: [] }), /at least one/);
  for (const ip of ["999.1.1.1", "1.2.3", "::g", "1.2.3.4.5", "01.2.3.4"]) await assert.rejects(mk({ ips: [ip] }), /invalid IP/, ip);
});

test("serial numbers: 400 generated certificates are all positive, 16 bytes wide and distinct", async () => {
  const seen = new Set<string>(); const k = ec();
  for (let i = 0; i < 400; i++) { const c = buildCertificate({ subject: { cn: "s.example" }, publicKey: k.publicKey, signingKey: k.privateKey, notBefore: NOW, notAfter: new Date(+NOW + DAY) }); const x = new X509Certificate(c.der); assert.match(x.serialNumber, /^[0-9A-F]{30,32}$/); assert.ok(!/^[89A-F]/.test(x.serialNumber) || x.serialNumber.length === 32, "never negative"); assert.ok(!seen.has(x.serialNumber), "duplicate serial"); seen.add(x.serialNumber); }
});

test("company CA, time: valid from the very second of notBefore to the very second of notAfter on the injected clock, one millisecond outside is refused (leaf, intermediate and root alike)", async () => {
  const root = ec(); const inter = ec(); const leaf = ec(); const n = (cn: string) => ({ cn, o: "Corp" }); const at = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);
  const mkChain = (o: { leaf: [Date, Date]; inter: [Date, Date]; root: [Date, Date] }) => {
    const r = buildCertificate({ subject: n("Root"), publicKey: root.publicKey, signingKey: root.privateKey, notBefore: o.root[0], notAfter: o.root[1], isCa: true });
    const i = buildCertificate({ subject: n("Inter"), issuer: n("Root"), publicKey: inter.publicKey, signingKey: root.privateKey, notBefore: o.inter[0], notAfter: o.inter[1], isCa: true, pathLen: 0 });
    const l = buildCertificate({ subject: { cn: "h.example" }, issuer: n("Inter"), publicKey: leaf.publicKey, signingKey: inter.privateKey, notBefore: o.leaf[0], notAfter: o.leaf[1], dns: ["h.example"] });
    return { chain: l.pem + i.pem, root: r.pem };
  };
  const base = at(+NOW); const wide: [Date, Date] = [new Date(+base - 400 * DAY), new Date(+base + 400 * DAY)]; const keyPem = leaf.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const run = async (c: { chain: string; root: string }, now: Date) => importCompanyCa({ certChainPem: c.chain, keyPem, caPem: c.root, hostnames: ["h.example"], now, keyRef: "k", secrets: createMemorySecretPort() });
  for (const which of ["leaf", "inter", "root"] as const) {
    const from = at(+base - DAY); const to = at(+base + DAY); const window: [Date, Date] = [from, to];
    const c = mkChain({ leaf: which === "leaf" ? window : wide, inter: which === "inter" ? window : wide, root: which === "root" ? window : wide });
    assert.equal((await run(c, from)).ok, true, `${which}: valid at notBefore`); assert.equal((await run(c, to)).ok, true, `${which}: valid at notAfter`);
    const early = await run(c, new Date(+from - 1)); assert.equal(early.ok, false, `${which}: a millisecond before notBefore`); assert.ok(!early.ok && early.issues.some((i) => /not-yet-valid/.test(i.code)), `${which}: ${JSON.stringify(early)}`);
    const late = await run(c, new Date(+to + 1)); assert.equal(late.ok, false, `${which}: a millisecond after notAfter`); assert.ok(!late.ok && late.issues.some((i) => /expired/.test(i.code)), `${which}: ${JSON.stringify(late)}`);
  }
});

test("an intermediate that is not a CA (no basicConstraints CA) is not accepted as an issuer in the chain", async () => {
  const root = ec(); const mid = ec(); const leaf = ec(); const n = (cn: string) => ({ cn, o: "Corp" }); const from = new Date(+NOW - DAY); const to = new Date(+NOW + DAY);
  const r = buildCertificate({ subject: n("Root"), publicKey: root.publicKey, signingKey: root.privateKey, notBefore: from, notAfter: to, isCa: true });
  const notCa = buildCertificate({ subject: n("Not A CA"), issuer: n("Root"), publicKey: mid.publicKey, signingKey: root.privateKey, notBefore: from, notAfter: to, isCa: false, dns: ["x.example"] });
  const l = buildCertificate({ subject: { cn: "h.example" }, issuer: n("Not A CA"), publicKey: leaf.publicKey, signingKey: mid.privateKey, notBefore: from, notAfter: to, dns: ["h.example"] });
  const out = await importCompanyCa({ certChainPem: l.pem + notCa.pem, keyPem: leaf.privateKey.export({ type: "pkcs8", format: "pem" }) as string, caPem: r.pem, hostnames: ["h.example"], now: NOW, keyRef: "k", secrets: createMemorySecretPort() });
  assert.equal(out.ok, false); assert.ok(!out.ok && out.issues.some((i) => i.code === "chain-incomplete"), JSON.stringify(out));
});

// ---- pinning -------------------------------------------------------------------------------------------------------

test("pins are compared exactly as documented: one spelling per value; case, padding, alphabet, length and whitespace variants never match anything, themselves included", () => {
  const SEED = 0x9195; const rand = mulberry32(SEED); const good = pinOf(Buffer.from("a certificate"));
  assert.equal(pinsEqual(good, good), true);
  const body = good.slice(7); const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const variants = [good.toUpperCase(), `SHA256:${body}`, `${good}=`, ` ${good}`, `${good} `, `${good}\n`, good.replace(/-/g, "+").replace(/_/g, "/"), body, `sha256:${body.slice(1)}`, `sha256:${body}A`, `sha256: ${body}`, `sha256:${body.slice(0, 42)}é`, "sha256:", "", "sha1:" + body, `sha256:${body}`.replace("sha256", "sha-256")];
  for (const v of variants) if (v !== good) { assert.equal(pinsEqual(good, v), false, JSON.stringify(v)); assert.equal(pinsEqual(v, v), false, `${JSON.stringify(v)} against itself`); }
  // The last base64url character carries two spare bits: only one of its four spellings is canonical.
  const lastIdx = alphabet.indexOf(body[42]!); let canonical = 0; for (let k = 0; k < 64; k++) { const v = `sha256:${body.slice(0, 42)}${alphabet[k]}` as const; if (parsePin(v)) canonical++; }
  assert.equal(canonical, 16, "of the 64 possible last characters 16 are canonical for 32 bytes (the other 48 have non-zero spare bits)"); assert.ok(lastIdx >= 0);
  for (let i = 0; i < 400; i++) { const t = Buffer.from(Array.from({ length: 1 + Math.floor(rand() * 60) }, () => Math.floor(rand() * 256))).toString("latin1"); assert.doesNotThrow(() => pinsEqual(good, t)); assert.equal(pinsEqual(good, t), false); }
});

async function crossSigned() {
  const k = { r1: ec(), r2: ec(), i: ec(), l: ec() }; const day = DAY; const now = new Date(); const nm = (cn: string) => ({ cn, o: "Corp" });
  const root = (key: ReturnType<typeof ec>, cn: string) => buildCertificate({ subject: nm(cn), publicKey: key.publicKey, signingKey: key.privateKey, notBefore: new Date(+now - day), notAfter: new Date(+now + 30 * day), isCa: true });
  const R1 = root(k.r1, "Root One"); const R2 = root(k.r2, "Root Two");
  const I2 = buildCertificate({ subject: nm("Issuing CA"), issuer: nm("Root Two"), publicKey: k.i.publicKey, signingKey: k.r2.privateKey, notBefore: new Date(+now - day), notAfter: new Date(+now + 30 * day), isCa: true, pathLen: 0 });
  const leaf = buildCertificate({ subject: { cn: "localhost" }, issuer: nm("Issuing CA"), publicKey: k.l.publicKey, signingKey: k.i.privateKey, notBefore: new Date(+now - day), notAfter: new Date(+now + 30 * day), dns: ["localhost"] });
  const server = tls.createServer({ key: k.l.privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert: leaf.pem + I2.pem }, (s) => { s.end("hi"); });
  const open = new Set<tls.TLSSocket>(); server.on("secureConnection", (c) => { open.add(c); c.on("close", () => open.delete(c)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { R1, R2, port: (server.address() as { port: number }).port, close: () => new Promise<void>((r) => { for (const c of open) c.destroy(); server.close(() => r()); }) };
}
const clients = new Set<tls.TLSSocket>();
const dial = (port: number, ca: string) => new Promise<tls.TLSSocket>((resolve, reject) => { const s = tls.connect({ host: "127.0.0.1", port, ca: [ca], servername: "localhost" }, () => resolve(s)); clients.add(s); s.on("error", reject); });

test("a valid chain to the wrong CA is not trust: a device pinned to root One is not satisfied by a connection that verified against root Two, whichever CA file the caller names", async () => {
  const x = await crossSigned();
  try {
    const s = await dial(x.port, x.R2.pem); assert.equal(s.authorized, true, "the chain is valid, for root Two");
    const dev: DeviceTrust = { current: { kind: "ca", pin: certPin(x.R1.pem) } };
    assert.equal(verifySocket(dev, s, x.R1.pem), "certificate-changed", "the caller named root One, but the chain ends at root Two");
    assert.equal(verifySocket({ current: { kind: "ca", pin: certPin(x.R2.pem) } }, s, x.R2.pem), "trusted", "and the right pairing of pin, file and chain is still trusted");
    s.destroy();
  } finally { for (const c of clients) c.destroy(); await x.close(); }
});

// ---- trust rollover ------------------------------------------------------------------------------------------------

const pin = (s: string) => pinOf(Buffer.from(s)); const A: Anchor = { kind: "cert", pin: pin("anchor A") }; const B: Anchor = { kind: "cert", pin: pin("anchor B") }; const C: Anchor = { kind: "ca", pin: pin("anchor C") };
const ok = (r: { ok: boolean; state?: TrustState }) => { assert.ok(r.ok, JSON.stringify(r)); return r.state!; };

test("overlap and after: staged trust accepts old and new, a switched one only the new; the device follows without pairing again", () => {
  const s0 = initTrust(A); assert.deepEqual(acceptedAnchors(s0), [A]);
  const s1 = ok(stageTrust(s0, B, 1)); assert.deepEqual(acceptedAnchors(s1), [A, B]);
  const dev0: DeviceTrust = { current: A }; const dev1 = (receiveAnnouncement(dev0, announcementFor(s1), { authenticated: true, verifiedBy: "current" }) as { device: DeviceTrust }).device; assert.deepEqual(dev1, { current: A, next: B });
  assert.equal(evaluateConnection(dev1, { leafPin: A.pin }), "trusted"); assert.equal(evaluateConnection(dev1, { leafPin: B.pin }), "trusted-next");
  const sw = switchTrust(ok(ackTrust(s1, { deviceId: "d1", pin: B.pin, now: 2, paired: ["d1"] })), [{ id: "d1", name: "d1" }], 3); assert.ok(sw.ok);
  const s2 = (sw as { state: TrustState }).state; assert.deepEqual(acceptedAnchors(s2), [B], "after the switch only the new one is accepted by the harness");
  assert.equal(evaluateConnection(promote(dev1, { leafPin: B.pin }), { leafPin: A.pin }), "certificate-changed", "a device that has promoted no longer trusts the old anchor");
  assert.equal(promote(dev1, { leafPin: A.pin }).current.pin, A.pin, "nothing is promoted while the harness still serves the old one");
});

test("a device takes an announcement only over an authenticated connection the current trust verified (every combination), and never one that does not continue its own trust", () => {
  const staged = ok(stageTrust(initTrust(A), B, 1)); const ann = announcementFor(staged); const dev: DeviceTrust = { current: A };
  for (const authenticated of [true, false]) for (const verifiedBy of ["current", "next", "os-store", "none"] as const) {
    const r = receiveAnnouncement(dev, ann, { authenticated, verifiedBy }); const should = authenticated && verifiedBy === "current";
    assert.equal(r.ok, should, `authenticated=${authenticated} verifiedBy=${verifiedBy}`); if (!r.ok) assert.equal(r.code, "untrusted-channel");
  }
  const foreign = receiveAnnouncement({ current: C }, ann, { authenticated: true, verifiedBy: "current" }); assert.ok(!foreign.ok && foreign.code === "wrong-harness");
  const selfNext = receiveAnnouncement(dev, { phase: "staged", current: A, next: A, stagedAt: 1 }, { authenticated: true, verifiedBy: "current" }); assert.ok(!selfNext.ok && selfNext.code === "bad-pin");
});

test("rollover state machine, 2000 seeded operations over 6 devices: at most two anchors, switch makes the staged one current, cancel restores the current, repair lists exactly the unconfirmed, serialisation round-trips, acks only for paired devices", () => {
  const SEED = 0x7205; const rand = mulberry32(SEED); const anchors: Anchor[] = [A, B, C, { kind: "ca", pin: pin("anchor D") }, { kind: "cert", pin: pin("anchor E") }];
  const devices: TrustDevice[] = Array.from({ length: 6 }, (_, i) => ({ id: `dev_${i}`, name: `device ${i}` })); let s = initTrust(A); let step = 0;
  for (; step < 2000; step++) {
    const where = `seed ${SEED} step ${step}`; const before = s; const op = Math.floor(rand() * 6);
    if (op === 0) { const next = anchors[Math.floor(rand() * anchors.length)]!; const r = stageTrust(s, next, step); if (r.ok) { s = r.state; assert.equal(s.phase, "staged", where); assert.deepEqual(s.next, next, where); assert.deepEqual(s.current, before.current, where); } else assert.ok(before.phase === "staged" || (before.current.kind === next.kind && before.current.pin === next.pin), `${where}: ${r.code}`); }
    else if (op === 1) { const d = devices[Math.floor(rand() * 6)]!.id; const paired = rand() < 0.8 ? devices.map((x) => x.id) : []; const r = ackTrust(s, { deviceId: d, pin: rand() < 0.9 ? (s.next?.pin ?? A.pin) : B.pin, now: step, paired }); if (r.ok) { s = r.state; assert.ok(paired.includes(d), `${where}: acked an unpaired device`); } }
    else if (op === 2) { const r = switchTrust(s, devices, step); if (r.ok) { assert.deepEqual(r.state.current, before.next, where); assert.deepEqual(r.repair.map((d) => d.id).sort(), devices.filter((d) => !(Object.hasOwn(before.acks, d.id))).map((d) => d.id).sort(), `${where}: repair list`); s = r.state; assert.equal(s.phase, "switched", where); assert.deepEqual(acceptedAnchors(s), [s.current], where); } }
    else if (op === 3) { const r = cancelTrust(s); if (r.ok) { assert.equal(before.phase, "staged", where); assert.deepEqual(r.state.current, before.current, where); s = r.state; assert.equal(s.phase, "none", where); } }
    else if (op === 4) { const p = trustProgress(s, devices); if (s.phase === "staged") assert.equal(p.received + p.missing.length, p.total, where); else assert.deepEqual(p.missing, [], where); }
    else { const back = parseTrust(serializeTrust(s)); assert.ok(back.ok, `${where}: ${JSON.stringify(back)}`); assert.deepEqual((back as { state: TrustState }).state, s, `${where}: round trip`); }
    assert.ok(acceptedAnchors(s).length <= 2, where); assert.equal(acceptedAnchors(s).length, s.phase === "staged" ? 2 : 1, where);
  }
  assert.equal(step, 2000);
});

test("device ids that are names of Object.prototype members are never mistaken for confirmations (progress, switch, ack)", () => {
  const odd: TrustDevice[] = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "dev_real"].map((id) => ({ id, name: id }));
  const staged = ok(stageTrust(initTrust(A), B, 1));
  assert.deepEqual(trustProgress(staged, odd).missing.map((d) => d.id), odd.map((d) => d.id), "nobody has confirmed anything yet");
  const sw = switchTrust(staged, odd, 2); assert.ok(sw.ok); assert.deepEqual((sw as { repair: TrustDevice[] }).repair.map((d) => d.id), odd.map((d) => d.id), "all of them must pair again");
  const acked = ackTrust(staged, { deviceId: "toString", pin: B.pin, now: 3, paired: ["toString"] }); assert.ok(acked.ok);
  assert.deepEqual(Object.keys((acked as { state: TrustState }).state.acks), ["toString"], "a real confirmation is recorded, not skipped as 'already there'");
});

test("persisted trust state is strict about its numbers: only finite, non-negative whole millisecond times; nothing is coerced", () => {
  const good = serializeTrust(ok(ackTrust(ok(stageTrust(initTrust(A), B, 1000)), { deviceId: "d1", pin: B.pin, now: 2000, paired: ["d1"] }))); assert.ok(parseTrust(good).ok);
  const base = JSON.parse(good) as Record<string, any>;
  for (const [label, patch] of [["Infinity as time", { stagedAt: "__INF__" }], ["negative time", { stagedAt: -1 }], ["fraction", { stagedAt: 1.5 }], ["huge", { stagedAt: 1e300 }], ["negative ack", { acks: { d1: -5 } }], ["Infinity ack", { acks: { d1: "__INF__" } }], ["NaN-like string", { stagedAt: "12" }]] as const) {
    const text = JSON.stringify({ ...base, ...patch }).replaceAll('"__INF__"', "1e999"); const r = parseTrust(text); assert.equal(r.ok, false, `${label}: ${text.slice(0, 80)}`);
  }
  for (const text of ["", "null", "[]", "5", "\"x\"", "{}", JSON.stringify({ ...base, extra: 1 }).replace("}", ',"__proto__":{"phase":"none"}}')]) assert.doesNotThrow(() => parseTrust(text));
  assert.equal(parseTrust("{").ok, false);
});

test("KNOWN GAP: after a switch from A to B the harness will stage the retired anchor A again, and devices will accept it as their next anchor", { todo: "KNOWN GAP: no list of retired anchors; a rollback to a key that was replaced (perhaps because it was compromised) is not refused; see SICHERHEIT in the PR" }, () => {
  const s1 = ok(stageTrust(initTrust(A), B, 1)); const sw = switchTrust(s1, [], 2); assert.ok(sw.ok); const switched = (sw as { state: TrustState }).state;
  const back = stageTrust(initTrust(switched.current), A, 3); assert.equal(back.ok, false, "staging the retired anchor again was accepted");
  const dev: DeviceTrust = { current: B }; const r = receiveAnnouncement(dev, { phase: "staged", current: B, next: A, stagedAt: 3 }, { authenticated: true, verifiedBy: "current" });
  assert.equal(r.ok, false, "a device took the retired anchor as its next trust");
});
