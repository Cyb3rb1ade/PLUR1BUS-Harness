// The signed extension catalogue's entries (src/catalog/verify.ts + ext-index/verify.ts; docs: extensions spec §7.2):
// every field a client acts on is validated, an invalid entry is rejected with a typed error and never skipped, ids and
// versions are unique, and references between the index, its revocation file and the trust root hold. Synthetic
// documents only; the existing trust.test.ts and ext-index.test.ts exercise the client end to end.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CatalogError, type CatalogErrorCode } from "../../src/catalog/types.ts";
import { ExtIndexError } from "../../src/catalog/ext-index/types.ts";
import { parseIndex } from "../../src/catalog/ext-index/verify.ts";
import { digest, envelope, parseCatalogIndex, parseRevocations, parseRoot, payload, timestamp, verifyEnvelope } from "../../src/catalog/verify.ts";
import { EXPIRES, NOW, hash, index, key, revocations, root, signed } from "./signing.ts";
import { mulberry32 } from "./helpers.ts";

const ARTIFACT = Buffer.from("package");
const bytes = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v));
const REV_HASH = "b".repeat(64);
/** A well-formed catalogue index document (the signing helper leaves the revocation pin empty). */
const doc = (over: Record<string, unknown> = {}) => index(1, ARTIFACT, { revocation: { version: 1, sha256: REV_HASH }, ...over }) as Record<string, any>;
const pkg = (id: string, versions: Array<Record<string, unknown>> = [{}]) => ({ id, kind: "skill", name: id.split("/").pop()!, versions: versions.map((v, i) => ({ version: `1.0.${i}`, url: "https://assets.test/p.p1x", size: 7, sha256: hash(ARTIFACT), ...v })) });
const code = (e: unknown) => (e instanceof CatalogError || e instanceof ExtIndexError ? e.code : `non-catalog error ${String(e)}`);
const rejectsCatalog = (d: unknown, expect: CatalogErrorCode = "signature_invalid", fragment?: string) => assert.throws(() => parseCatalogIndex(bytes(d)), (e: unknown) => {
  assert.ok(e instanceof CatalogError, `not a CatalogError: ${String(e)}`); assert.equal(e.code, expect); if (fragment) assert.ok(e.message.includes(fragment), `${e.message} lacks ${fragment}`); return true;
});

describe("catalogue index: the document", () => {
  it("a well-formed index is accepted, embedded revocations come back empty, and the pinned fields are kept", () => {
    const i = parseCatalogIndex(bytes(doc()));
    assert.equal(i.serial, 1); assert.equal(i.rootVersion, 1); assert.deepEqual(i.revocation, { version: 1, sha256: REV_HASH }); assert.deepEqual(i.revocations, []);
    assert.equal(i.packages[0]!.id, "owner/skill");
  });

  it("the payload must be UTF-8 JSON: bytes that are not JSON, invalid UTF-8 and an empty payload are refused", () => {
    for (const b of [Buffer.from("not json"), Buffer.from([0x7b, 0xff, 0x7d]), Buffer.alloc(0), Buffer.from("{} trailing")]) assert.throws(() => parseCatalogIndex(b), (e: unknown) => code(e) === "signature_invalid");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: a UTF-8 byte order mark in front of the JSON is tolerated (the decoder drops it; the signature still covers the original bytes)", () => {
    assert.equal(parseCatalogIndex(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(doc())])).serial, 1);
  });

  it("the index must pin the root version and the revocation file (version and a 64-character lowercase sha256)", () => {
    for (const bad of [{ rootVersion: undefined }, { rootVersion: 0 }, { rootVersion: -1 }, { rootVersion: 1.5 }, { rootVersion: "1" }, { revocation: undefined }, { revocation: null }, { revocation: [] }, { revocation: { version: 1 } }, { revocation: { sha256: REV_HASH } },
      { revocation: { version: 0, sha256: REV_HASH } }, { revocation: { version: 1, sha256: REV_HASH.toUpperCase() } }, { revocation: { version: 1, sha256: REV_HASH.slice(1) } }, { revocation: { version: 1, sha256: REV_HASH + "a" } }, { revocation: { version: 1, sha256: 5 } }])
      rejectsCatalog(doc(bad), "signature_invalid", "pin rootVersion and revocation");
  });

  it("an index that carries its own revocations is refused: only the separately signed, pinned file counts", () => {
    rejectsCatalog(doc({ revocations: [{ id: "owner/skill" }] }), "signature_invalid", "pinned signed revocation file");
    rejectsCatalog(doc({ revocations: "none" }), "signature_invalid", "pinned signed revocation file");
    assert.deepEqual(parseCatalogIndex(bytes(doc({ revocations: [] }))).revocations, []);
  });

  it("generatedAt must come strictly before expires", () => {
    rejectsCatalog(doc({ generatedAt: EXPIRES }), "signature_invalid", "generatedAt must precede expires");
    rejectsCatalog(doc({ generatedAt: "2026-12-01T00:00:00Z" }), "signature_invalid", "generatedAt must precede expires");
    assert.ok(parseCatalogIndex(bytes(doc({ generatedAt: "2026-10-31T23:59:59Z" }))));
  });

  it("format must be 1 and the serial a non-negative safe integer", () => {
    assert.throws(() => parseCatalogIndex(bytes(doc({ format: 2 }))), (e: unknown) => code(e) === "signature_invalid");
    for (const serial of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseCatalogIndex(bytes({ ...doc(), serial })), (e: unknown) => code(e) === "signature_invalid", String(serial));
    for (const serial of [0, 1, Number.MAX_SAFE_INTEGER]) assert.equal(parseCatalogIndex(bytes({ ...doc(), serial })).serial, serial);
  });

  it("every malformed shape is a typed CatalogError, never a crash: arrays, nulls, scalars at the top", () => {
    for (const v of ["[]", "null", "5", '"x"', "true", "{}"]) assert.throws(() => parseCatalogIndex(bytes(v)), (e: unknown) => code(e) === "signature_invalid", v);
  });
});

describe("catalogue index: package ids and versions are unique", () => {
  it("a repeated package id is refused", () => {
    rejectsCatalog(doc({ packages: [pkg("owner/a"), pkg("owner/a")] }), "signature_invalid");
    assert.throws(() => parseIndex(bytes(doc({ packages: [pkg("owner/a"), pkg("owner/a")] }))), (e: unknown) => e instanceof ExtIndexError && e.code === "malformed" && e.message.includes("duplicate package id owner/a"));
  });

  it("a repeated version within one package is refused with its own message", () => {
    rejectsCatalog(doc({ packages: [pkg("owner/a", [{ version: "1.0.0" }, { version: "1.0.0" }])] }), "signature_invalid", "duplicate package version");
  });

  it("the same version in two different packages is fine", () => {
    assert.equal(parseCatalogIndex(bytes(doc({ packages: [pkg("owner/a", [{ version: "1.0.0" }]), pkg("owner/b", [{ version: "1.0.0" }])] }))).packages.length, 2);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: ids are compared exactly, so look-alike ids (case, trailing space, Cyrillic letters, zero-width) are separate packages and none of them is refused", () => {
    const ids = ["owner/skill", "Owner/Skill", "owner/skill ", "owner/skіll", "owner/skill​", "owner∕skill"];
    const i = parseCatalogIndex(bytes(doc({ packages: ids.map((id) => pkg(id)) })));
    assert.deepEqual(i.packages.map((p) => p.id), ids);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: a duplicate package id surfaces as the generic 'invalid index/package metadata', the specific id is only in the lower-level parser's message", () => {
    assert.throws(() => parseCatalogIndex(bytes(doc({ packages: [pkg("owner/a"), pkg("owner/a")] }))), (e: unknown) => e instanceof CatalogError && e.message === "invalid index/package metadata");
  });

  it("an index with no packages, and a package with no versions, are accepted by the parser (characterization: Ist-Verhalten, nicht spezifiziert; the client later drops a package without versions from the offer)", () => {
    assert.deepEqual(parseCatalogIndex(bytes(doc({ packages: [] }))).packages, []);
    assert.equal(parseCatalogIndex(bytes(doc({ packages: [pkg("owner/a", [])] }))).packages[0]!.versions.length, 0);
  });
});

describe("catalogue index: entry fields", () => {
  const withVersion = (change: Record<string, unknown>) => doc({ packages: [pkg("owner/a", [change])] });
  const reject = (d: unknown) => assert.throws(() => parseCatalogIndex(bytes(d)), (e: unknown) => code(e) === "signature_invalid");

  it("package id, kind and name must be strings and the id non-empty", () => {
    for (const p of [{ ...pkg("a"), id: "" }, { ...pkg("a"), id: 5 }, { ...pkg("a"), kind: 5 }, { ...pkg("a"), kind: undefined }, { ...pkg("a"), name: null }, { ...pkg("a"), versions: "1.0.0" }, { ...pkg("a"), versions: null }, 5, null, "x", []]) reject(doc({ packages: [p] }));
    assert.ok(parseCatalogIndex(bytes(doc({ packages: [{ ...pkg("a"), kind: "", name: "" }] }))), "empty kind and name are strings");
  });

  it("a version entry needs a non-empty version string, a lowercase 64-hex sha256, a positive safe-integer size and a plain https URL", () => {
    for (const change of [{ version: "" }, { version: 1 }, { version: null }, { sha256: "A".repeat(64) }, { sha256: "a".repeat(63) }, { sha256: "a".repeat(65) }, { sha256: 5 }, { sha256: undefined },
      { size: 0 }, { size: -1 }, { size: 1.5 }, { size: "7" }, { size: Number.MAX_SAFE_INTEGER + 1 }, { size: undefined }, { url: undefined }, { url: 5 }, { url: "" }, { url: "not a url" }, { url: "https://" }]) reject(withVersion(change));
    for (const change of [{ size: 1 }, { size: Number.MAX_SAFE_INTEGER }, { version: "0" }, { version: "1.0.0-rc.1+build" }]) assert.ok(parseCatalogIndex(bytes(withVersion(change))), JSON.stringify(change));
  });

  it("URLs: only https, no credentials; http, ftp, file, data, javascript and protocol-relative ones are refused", () => {
    for (const url of ["http://assets.test/p", "ftp://assets.test/p", "file:///etc/passwd", "data:text/plain,x", "javascript:alert(1)", "//assets.test/p", "https://user@assets.test/p", "https://user:pw@assets.test/p", "https://:pw@assets.test/p"]) reject(withVersion({ url }));
    for (const url of ["https://assets.test/p", "https://assets.test:8443/p?x=1#f", "HTTPS://ASSETS.TEST/p", "https://[::1]/p"]) assert.ok(parseCatalogIndex(bytes(withVersion({ url }))), url);
  });

  it("an http URL is accepted only at the caller's declared test origin, and only that origin", () => {
    const d = withVersion({ url: "http://127.0.0.1:4000/p" });
    assert.ok(parseCatalogIndex(bytes(d), "http://127.0.0.1:4000"));
    assert.throws(() => parseCatalogIndex(bytes(d), "http://127.0.0.1:4001"), (e: unknown) => code(e) === "signature_invalid");
    assert.throws(() => parseCatalogIndex(bytes(d)), (e: unknown) => code(e) === "signature_invalid");
    assert.throws(() => parseCatalogIndex(bytes(withVersion({ url: "http://assets.test/p" })), "http://127.0.0.1:4000"), (e: unknown) => code(e) === "signature_invalid");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: unknown extra fields on the index, a package or a version are carried along untouched", () => {
    const d = doc({ note: "x", packages: [{ ...pkg("a"), licence: "research-only", preselected: true, versions: [{ ...pkg("a").versions[0]!, channel: "beta" }] }] });
    const i = parseCatalogIndex(bytes(d));
    assert.equal(i["note"], "x"); assert.equal(i.packages[0]!["preselected"], true); assert.equal(i.packages[0]!.versions[0]!["channel"], "beta");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: a calendar-invalid date that still matches the timestamp pattern rolls over instead of being refused (2026-02-30 is 2 March)", () => {
    assert.equal(timestamp("2026-02-30T00:00:00Z"), Date.parse("2026-03-02T00:00:00Z"));
    assert.equal(timestamp("2026-10-07T24:00:00Z"), Date.parse("2026-10-08T00:00:00Z"));
  });
});

describe("timestamps", () => {
  it("only UTC 'YYYY-MM-DDTHH:MM:SS[.mmm]Z' is accepted", () => {
    assert.equal(timestamp("2026-10-07T12:00:00Z"), NOW); assert.equal(timestamp("2026-10-07T12:00:00.250Z"), NOW + 250);
    for (const bad of ["2026-10-07", "2026-10-07 12:00:00Z", "2026-10-07T12:00:00", "2026-10-07T12:00:00+00:00", "2026-10-07T12:00:00z", "2026-10-07T12:00:00.1Z", "2026-10-07T12:00:00.1234Z", "2026-13-01T00:00:00Z", "2026-10-07T23:59:60Z", " 2026-10-07T12:00:00Z", "2026-10-07T12:00:00Z\n", "soon", "", 5, null, undefined, {}])
      assert.throws(() => timestamp(bad), (e: unknown) => code(e) === "signature_invalid", String(bad));
  });
});

describe("revocation files", () => {
  const ok = (over: Record<string, unknown> = {}) => parseRevocations(bytes(revocations(over)));
  const no = (over: Record<string, unknown>, frag?: string) => assert.throws(() => ok(over), (e: unknown) => code(e) === "signature_invalid" && (frag === undefined || (e as Error).message.includes(frag)));

  it("a well-formed list is accepted, with keys and package versions", () => {
    const r = ok({ keys: ["k1"], packages: [{ id: "owner/skill", versions: ["1.0.0", "1.0.1"], reason: "malware" }] });
    assert.deepEqual(r.keys, ["k1"]); assert.equal(r.packages[0]!.versions.length, 2);
    assert.deepEqual(ok().packages, []);
  });

  it("type, versions and expiry are required and checked", () => {
    for (const bad of [{ type: "root" }, { type: undefined }, { version: 0 }, { version: "1" }, { rootVersion: 0 }, { rootVersion: undefined }, { keys: "k" }, { keys: [""] }, { keys: [5] }, { packages: "p" }, { packages: undefined }, { expires: "soon" }, { expires: undefined }]) no(bad);
  });

  it("a key revoked twice in one list is refused (the list is a set)", () => no({ keys: ["k", "k"] }));

  it("each revoked package names an id, a reason and at least one non-empty version", () => {
    for (const p of [{ id: "", versions: ["1"], reason: "r" }, { id: 5, versions: ["1"], reason: "r" }, { id: "a", versions: ["1"], reason: 5 }, { id: "a", versions: ["1"] }, { id: "a", versions: [], reason: "r" }, { id: "a", versions: "1", reason: "r" }, { id: "a", versions: [""], reason: "r" }, { id: "a", versions: [1], reason: "r" }, null, 5, "a"])
      no({ packages: [p] }, "exact versions required");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: 'exact versions required' is only checked as non-empty strings, so a range or wildcard such as '1.*' is accepted and (matched literally by the client) revokes nothing", () => {
    assert.deepEqual(ok({ packages: [{ id: "owner/skill", versions: ["1.*", "<2.0.0", "*"], reason: "r" }] }).packages[0]!.versions, ["1.*", "<2.0.0", "*"]);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: a revocation may name a package or key the index does not contain (nothing requires it to resolve)", () => {
    const r = ok({ keys: ["no-such-key"], packages: [{ id: "no/such-package", versions: ["9.9.9"], reason: "r" }] });
    assert.equal(r.keys[0], "no-such-key"); assert.equal(r.packages[0]!.id, "no/such-package");
  });
});

describe("trust roots", () => {
  const k1 = key("one"), k2 = key("two"), k3 = key("three");
  const no = (r: unknown, errCode: CatalogErrorCode = "signature_invalid", frag?: string) => assert.throws(() => parseRoot(r), (e: unknown) => code(e) === errCode && (frag === undefined || (e as Error).message.includes(frag)), JSON.stringify(r).slice(0, 80));

  it("a valid root is accepted; the threshold defaults to one", () => {
    assert.equal(parseRoot(root([k1, k2], 3, 2)).threshold, 2);
    const { threshold: _t, ...bare } = root([k1]); void _t;
    assert.equal(parseRoot(bare).threshold, 1);
  });

  it("no keys is the 'nothing provisioned' failure, not a malformed one", () => no({ ...root([k1]), keys: [] }, "key_unknown", "no extension root keys provisioned"));

  it("version, threshold and key counts are bounded", () => {
    no({ ...root([k1]), version: 0 }, "signature_invalid", "invalid trust root");
    no({ ...root([k1]), type: "index" }, "signature_invalid", "invalid trust root");
    no({ ...root([k1]), keys: "x" }, "signature_invalid", "invalid trust root");
    for (const threshold of [0, -1, 1.5, "1"]) no({ ...root([k1]), threshold }, "signature_invalid", "invalid threshold");
    no(root([k1, k2], 1, 3), "signature_invalid", "threshold exceeds number of keys");
    const many = Array.from({ length: 65 }, (_, i) => key(`k${i}`));
    no(root(many), "signature_invalid", "invalid trust root");
  });

  it("every key needs an id, a raw 32-byte Ed25519 public key in canonical base64 and a valid expiry; ids and material are unique", () => {
    const base = root([k1]); const kk = base.keys[0]!;
    no({ ...base, keys: [{ ...kk, id: "" }] }, "signature_invalid", "invalid root key");
    no({ ...base, keys: [{ ...kk, id: 5 }] }, "signature_invalid", "invalid root key");
    no({ ...base, keys: [{ ...kk, publicKey: 5 }] }, "signature_invalid", "invalid root key");
    no({ ...base, keys: [5] }, "signature_invalid", "invalid root key");
    for (const publicKey of [Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), "AAAA", kk.publicKey.slice(0, -1), "!!!!", kk.publicKey.replace(/=+$/, ""), ""]) no({ ...base, keys: [{ ...kk, publicKey }] }, "signature_invalid");
    no({ ...base, keys: [{ ...kk, expires: "tomorrow" }] }, "signature_invalid", "invalid UTC timestamp");
    no({ ...base, keys: [kk, { ...root([k2]).keys[0]!, id: kk.id }] }, "signature_invalid", "duplicate root key identity or material");
    no({ ...base, keys: [kk, { ...kk, id: "alias" }] }, "signature_invalid", "duplicate root key identity or material");
    assert.ok(parseRoot(root([k1, k2, k3])));
  });
});

describe("signed envelopes", () => {
  const a = key("a"), b = key("b"), stranger = key("stranger");
  const r1 = (keys = [a, b], threshold = 1) => parseRoot(root(keys, 1, threshold));
  const msg = (v: unknown = { hello: "world" }) => signed(v, [a]);
  const throwsCode = (fn: () => unknown, c: CatalogErrorCode, frag?: string) => assert.throws(fn, (e: unknown) => code(e) === c && (frag === undefined || (e as Error).message.includes(frag)));

  it("a valid signature by a trusted key verifies and reports the signer and the exact bytes", () => {
    const e = msg(); const v = verifyEnvelope(e, r1(), NOW);
    assert.deepEqual(v.signers, ["a"]); assert.equal(v.bytes.toString(), JSON.stringify({ hello: "world" }));
  });

  it("the envelope's shape is checked: non-objects, a missing payload, a non-list of signatures, more than 64 signatures, signatures without strings", () => {
    for (const bad of [null, 5, "x", [], {}, { payload: 5, signatures: [] }, { payload: "AAAA" }, { payload: "AAAA", signatures: "x" }, { payload: "AAAA", signatures: [null] }, { payload: "AAAA", signatures: [{ keyId: 1, signature: "x" }] }, { payload: "AAAA", signatures: [{ keyId: "a" }] }, { payload: "AAAA", signatures: Array.from({ length: 65 }, () => ({ keyId: "a", signature: "x" })) }])
      throwsCode(() => envelope(bad), "signature_invalid", "invalid signature envelope");
  });

  it("payload and signature must be canonical base64: padding, alphabet, length and trailing garbage are checked", () => {
    const good = msg();
    for (const p of ["", "AAA", "AAAA=", "AA=A", "A===", "!!!!", good.payload.replace(/=+$/, "") + "\n", " " + good.payload, "AB==" /* non-canonical trailing bits */]) throwsCode(() => payload({ payload: p, signatures: [] }), "signature_invalid");
    assert.ok(payload(good).length > 0);
    for (const s of ["", "AAAA", Buffer.alloc(63).toString("base64"), Buffer.alloc(65).toString("base64"), good.signatures[0]!.signature + "="]) throwsCode(() => verifyEnvelope({ ...good, signatures: [{ keyId: "a", signature: s }] }, r1(), NOW), "signature_invalid");
  });

  it("a tampered payload, a signature from another key, and a signature over other bytes all fail", () => {
    const e = msg();
    const tampered = { ...e, payload: Buffer.from(JSON.stringify({ hello: "w0rld" })).toString("base64") };
    throwsCode(() => verifyEnvelope(tampered, r1(), NOW), "signature_invalid", "invalid signature by a");
    const wrongKey = { ...e, signatures: [{ keyId: "b", signature: e.signatures[0]!.signature }] };
    throwsCode(() => verifyEnvelope(wrongKey, r1(), NOW), "signature_invalid", "invalid signature by b");
    const whitespace = { ...e, payload: Buffer.from(JSON.stringify({ hello: "world" }) + " ").toString("base64") };
    throwsCode(() => verifyEnvelope(whitespace, r1(), NOW), "signature_invalid");
  });

  it("a signature by a key the root does not list is key_unknown, even next to valid ones (characterization: Ist-Verhalten, nicht spezifiziert: one stray signature rejects the whole envelope)", () => {
    const e = signed({ x: 1 }, [a, stranger]);
    throwsCode(() => verifyEnvelope(e, r1(), NOW), "key_unknown", "unknown signing key stranger");
  });

  it("the threshold counts distinct trusted signers: two signatures by the same key are one", () => {
    const e = msg(); const doubled = { ...e, signatures: [e.signatures[0]!, e.signatures[0]!] };
    throwsCode(() => verifyEnvelope(doubled, r1([a, b], 2), NOW), "signature_invalid", "need 2 distinct trusted signatures, got 1");
    const both = signed({ x: 1 }, [a, b]);
    assert.deepEqual(verifyEnvelope(both, r1([a, b], 2), NOW).signers.sort(), ["a", "b"]);
    throwsCode(() => verifyEnvelope({ ...both, signatures: [] }, r1(), NOW), "signature_invalid", "need 1 distinct trusted signatures, got 0");
  });

  it("revoked keys never verify, expired keys and expired roots only count as history when asked to", () => {
    const e = msg();
    throwsCode(() => verifyEnvelope(e, r1(), NOW, new Set(["a"])), "key_revoked", "signing key a is revoked");
    const expiredKey = parseRoot({ ...root([a, b]), keys: [{ ...root([a]).keys[0]!, expires: "2026-10-01T00:00:00Z" }, root([b]).keys[0]!] });
    throwsCode(() => verifyEnvelope(e, expiredKey, NOW), "signature_invalid", "signing key a expired");
    assert.deepEqual(verifyEnvelope(e, expiredKey, NOW, new Set(), true).signers, ["a"]);
    const expiredRoot = parseRoot({ ...root([a]), expires: "2026-10-01T00:00:00Z" });
    throwsCode(() => verifyEnvelope(e, expiredRoot, NOW), "stale_index", "trust root expired");
    assert.deepEqual(verifyEnvelope(e, expiredRoot, NOW, new Set(), true).signers, ["a"]);
  });

  it("a key whose expiry is exactly 'now' is already expired", () => {
    const e = msg();
    const edge = parseRoot({ ...root([a]), keys: [{ ...root([a]).keys[0]!, expires: "2026-10-07T12:00:00Z" }] });
    throwsCode(() => verifyEnvelope(e, edge, NOW), "signature_invalid", "expired");
    assert.deepEqual(verifyEnvelope(e, edge, NOW - 1).signers, ["a"]);
  });

  it("digest is a plain SHA-256 hex of the bytes", () => {
    assert.equal(digest(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(digest(Buffer.alloc(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("seeded mutation of index documents", () => {
  it("600 random mutations of a valid index are either accepted or rejected with a typed catalogue error; never a crash (seed 0xCA7A106)", () => {
    const seed = 0xca7a106; const rnd = mulberry32(seed);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const junk: unknown[] = [null, undefined, 0, -1, 1.5, "", " ", "x", "http://a/b", "https://a/b", [], {}, true, Number.MAX_SAFE_INTEGER + 1, "\u0000", "é".repeat(300), "a".repeat(64), { a: 1 }, [1, [2]]];
    const paths: string[][] = [["format"], ["serial"], ["rootVersion"], ["generatedAt"], ["expires"], ["revocation"], ["revocation", "version"], ["revocation", "sha256"], ["revocations"], ["packages"], ["packages", "0"], ["packages", "0", "id"], ["packages", "0", "kind"], ["packages", "0", "name"], ["packages", "0", "versions"], ["packages", "0", "versions", "0"],
      ["packages", "0", "versions", "0", "version"], ["packages", "0", "versions", "0", "url"], ["packages", "0", "versions", "0", "sha256"], ["packages", "0", "versions", "0", "size"]];
    let accepted = 0; let rejected = 0;
    for (let n = 0; n < 600; n++) {
      const d = structuredClone(doc({ packages: [pkg("owner/a", [{}, {}])] })) as Record<string, any>;
      for (let m = 0, k = 1 + Math.floor(rnd() * 3); m < k; m++) {
        const path = pick(paths); let node: any = d;
        for (const step of path.slice(0, -1)) node = node?.[step];
        const leaf = path[path.length - 1]!;
        if (node && typeof node === "object") { if (rnd() < 0.25) delete node[leaf]; else node[leaf] = pick(junk); }
      }
      try { parseCatalogIndex(Buffer.from(JSON.stringify(d))); accepted++; }
      catch (e) { rejected++; assert.ok(e instanceof CatalogError, `seed ${seed.toString(16)} case ${n}: ${String(e)}`); assert.ok(["signature_invalid"].includes(e.code), `seed ${seed.toString(16)} case ${n}: ${e.code}`); assert.ok(e.message.length > 0); }
    }
    assert.ok(accepted + rejected === 600 && rejected > 300, `accepted ${accepted} rejected ${rejected}`);
  });
});
