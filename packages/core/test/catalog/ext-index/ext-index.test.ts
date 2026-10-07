import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash, type KeyObject } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtIndexClient, createFileCacheStore, createMemoryCacheStore, assertFresh, ExtIndexError } from "../../../src/catalog/ext-index/index.ts";
import type { EgressPort, ExtIndexConfig, ExtIndexErrorCode, IndexCacheStore } from "../../../src/catalog/ext-index/index.ts";
import { startFakeEndpoint } from "../../helpers/fake-endpoint.ts";
import type { FakeEndpoint } from "../../helpers/fake-endpoint.ts";

const URL_INDEX = "https://extensions.test/v1/index.json";
const URL_SIG = `${URL_INDEX}.minisig`;
const T0 = Date.parse("2026-10-07T00:00:00Z");

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { privateKey, pub: Buffer.from(x, "base64url").toString("base64") };
}
const K1 = keypair();
const K2 = keypair();

function indexDoc(serial: number, over: Record<string, unknown> = {}) {
  return {
    format: 1, serial, generatedAt: "2026-10-01T12:00:00Z", expires: "2026-11-15T12:00:00Z",
    keys: { active: ["k1"], retired: [] },
    packages: [{
      id: "plur1bus/zabbix-triage", kind: "skill", name: "zabbix-triage",
      versions: [{ version: "1.2.0", url: "https://github.com/Cyb3rb1ade/plur1bus-extensions/releases/download/z-v1.2.0/z.p1x", sha256: "a".repeat(64), size: 18422 }],
    }],
    revocations: [],
    ...over,
  };
}
const bytesOf = (o: unknown) => Buffer.from(JSON.stringify(o));
const signWith = (k: KeyObject, b: Uint8Array) => sign(null, b, k).toString("base64");

/** A scripted egress port: url -> answer. Counts calls; honours maxBytes like a real one must. */
function fakeEgress(routes: Map<string, { status?: number; body?: Uint8Array; fail?: boolean }>): EgressPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url, { maxBytes }) {
      calls.push(url);
      const r = routes.get(url);
      if (!r || r.fail) throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
      const body = r.body ?? new Uint8Array();
      if (body.byteLength > maxBytes) throw new ExtIndexError("too-large", "over cap");
      return { status: r.status ?? 200, body };
    },
  };
}
function serve(routes: Map<string, { status?: number; body?: Uint8Array; fail?: boolean }>, doc: unknown, key = K1.privateKey, tamper?: (b: Buffer) => Buffer) {
  const b = bytesOf(doc);
  routes.set(URL_INDEX, { body: tamper ? tamper(b) : b });
  routes.set(URL_SIG, { body: Buffer.from(signWith(key, b)) });
}

const cfg = (over: Partial<ExtIndexConfig> = {}): ExtIndexConfig => ({ enabled: true, url: URL_INDEX, publicKeys: { k1: K1.pub }, ...over });
function setup(over: Partial<ExtIndexConfig> = {}, store: IndexCacheStore = createMemoryCacheStore()) {
  const routes = new Map<string, { status?: number; body?: Uint8Array; fail?: boolean }>();
  const egress = fakeEgress(routes);
  let t = T0;
  const client = createExtIndexClient({ config: cfg(over), egress, store, now: () => t });
  return { routes, egress, store, client, setNow: (n: number) => { t = n; } };
}
async function code(p: Promise<unknown>): Promise<ExtIndexErrorCode> {
  try { await p; } catch (e) { assert.ok(e instanceof ExtIndexError, String(e)); return e.code; }
  return assert.fail("expected an ExtIndexError");
}

describe("ext-index: signature", () => {
  it("accepts a validly signed index and caches it", async () => {
    const s = setup(); serve(s.routes, indexDoc(5));
    const r = await s.client.refresh();
    assert.equal(r.index.serial, 5); assert.equal(r.keyId, "k1"); assert.equal(r.stale, false); assert.equal(r.source, "network");
    const c = await s.client.cached();
    assert.equal(c?.source, "cache"); assert.equal(c?.index.serial, 5);
  });
  it("refuses a signature from a key that is not configured", async () => {
    const s = setup(); serve(s.routes, indexDoc(5), K2.privateKey);
    assert.equal(await code(s.client.refresh()), "signature-invalid");
    assert.equal((await s.store.read()).cached, null, "nothing cached on failure");
  });
  it("accepts any configured key (rotation) and reports which", async () => {
    const s = setup({ publicKeys: { k1: K1.pub, k2: K2.pub } }); serve(s.routes, indexDoc(5), K2.privateKey);
    assert.equal((await s.client.refresh()).keyId, "k2");
  });
  it("refuses a garbled or short signature", async () => {
    const s = setup(); serve(s.routes, indexDoc(5));
    s.routes.set(URL_SIG, { body: Buffer.from("not base64!!") });
    assert.equal(await code(s.client.refresh()), "signature-invalid");
    s.routes.set(URL_SIG, { body: Buffer.from(Buffer.alloc(10).toString("base64")) });
    assert.equal(await code(s.client.refresh()), "signature-invalid");
  });
  it("refuses a manipulated entry (one changed byte in a signed index)", async () => {
    const s = setup();
    serve(s.routes, indexDoc(5), K1.privateKey, () => bytesOf(indexDoc(5, { packages: [{ ...indexDoc(5).packages[0]!, name: "evil" }] })));
    assert.equal(await code(s.client.refresh()), "signature-invalid");
  });
  it("has no built-in key: an empty key map refuses everything", async () => {
    const s = setup({ publicKeys: {} }); serve(s.routes, indexDoc(5));
    assert.equal(await code(s.client.refresh()), "no-trusted-key");
    assert.equal(s.egress.calls.length, 0, "no request is made without a key");
  });
  it("rejects an unusable configured key", async () => {
    const s = setup({ publicKeys: { k1: "AAAA" } }); serve(s.routes, indexDoc(5));
    assert.equal(await code(s.client.refresh()), "invalid-config");
  });
});

describe("ext-index: rollback protection", () => {
  it("refuses a replay of an older serial after a newer one was accepted", async () => {
    const s = setup(); serve(s.routes, indexDoc(7)); await s.client.refresh();
    serve(s.routes, indexDoc(6)); // validly signed, but old
    assert.equal(await code(s.client.refresh()), "serial-rollback");
    assert.equal((await s.client.cached())?.index.serial, 7);
  });
  it("accepts a higher serial and the very same index again", async () => {
    const s = setup(); serve(s.routes, indexDoc(7)); await s.client.refresh();
    await s.client.refresh(); // identical bytes, equal serial
    serve(s.routes, indexDoc(8)); assert.equal((await s.client.refresh()).index.serial, 8);
  });
  it("refuses the same serial with different content", async () => {
    const s = setup(); serve(s.routes, indexDoc(7)); await s.client.refresh();
    serve(s.routes, indexDoc(7, { generatedAt: "2026-10-02T00:00:00Z" }));
    assert.equal(await code(s.client.refresh()), "serial-conflict");
  });
  it("keeps the serial floor across a new client over the same file store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extidx-")); after(() => rm(dir, { recursive: true, force: true }));
    const a = setup({}, createFileCacheStore(dir)); serve(a.routes, indexDoc(9)); await a.client.refresh();
    const b = setup({}, createFileCacheStore(dir)); serve(b.routes, indexDoc(8));
    assert.equal(await code(b.client.refresh()), "serial-rollback");
  });
});

describe("ext-index: expiry and offline cache", () => {
  it("refuses a freshly fetched index that is already expired and does not cache it", async () => {
    const s = setup(); s.setNow(Date.parse("2026-12-01T00:00:00Z")); serve(s.routes, indexDoc(5));
    assert.equal(await code(s.client.refresh()), "expired");
    assert.equal((await s.store.read()).cached, null);
  });
  it("serves the cache offline, and marks it stale after `expires`", async () => {
    const s = setup(); serve(s.routes, indexDoc(5)); await s.client.refresh();
    s.routes.set(URL_INDEX, { fail: true });
    const fresh = await s.client.get();
    assert.equal(fresh.source, "cache"); assert.equal(fresh.stale, false); assert.equal(fresh.refreshError?.code, "unreachable");
    assertFresh(fresh);
    s.setNow(Date.parse("2026-11-16T00:00:00Z"));
    const stale = await s.client.get();
    assert.equal(stale.stale, true); assert.equal(stale.index.packages.length, 1, "entries stay readable");
    assert.equal(await code(Promise.resolve().then(() => assertFresh(stale))), "catalog-stale");
  });
  it("reports no-cache when offline with nothing cached", async () => {
    const s = setup(); s.routes.set(URL_INDEX, { fail: true });
    assert.equal(await code(s.client.get()), "no-cache");
  });
  it("does not hide a signature failure behind the cache but still serves the cache with the error", async () => {
    const s = setup(); serve(s.routes, indexDoc(5)); await s.client.refresh();
    serve(s.routes, indexDoc(6), K2.privateKey);
    const r = await s.client.get();
    assert.equal(r.index.serial, 5); assert.equal(r.refreshError?.code, "signature-invalid");
  });
  it("with no cache a security failure surfaces as itself, not as no-cache", async () => {
    const s = setup(); serve(s.routes, indexDoc(5), K2.privateKey);
    assert.equal(await code(s.client.get()), "signature-invalid");
  });
  it("re-verifies the cache on read: a tampered cache file is not served", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extidx-")); after(() => rm(dir, { recursive: true, force: true }));
    const s = setup({}, createFileCacheStore(dir)); serve(s.routes, indexDoc(5)); await s.client.refresh();
    const p = join(dir, "index.json");
    await writeFile(p, (await readFile(p, "utf8")).replace("zabbix-triage", "zabbix-evil_"));
    assert.equal(await s.client.cached(), null);
    s.routes.set(URL_INDEX, { fail: true });
    assert.equal(await code(s.client.get()), "no-cache");
  });
  it("treats a cache below the serial floor as a rollback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extidx-")); after(() => rm(dir, { recursive: true, force: true }));
    const s = setup({}, createFileCacheStore(dir)); serve(s.routes, indexDoc(5)); await s.client.refresh();
    await writeFile(join(dir, "last-serial"), "6");
    assert.equal(await s.client.cached(), null);
    await writeFile(join(dir, "last-serial"), "garbage"); // unreadable floor: fail closed
    assert.equal(await s.client.cached(), null);
  });
});

describe("ext-index: transport and shape", () => {
  it("types transport failures", async () => {
    const s = setup(); s.routes.set(URL_INDEX, { fail: true });
    assert.equal(await code(s.client.refresh()), "unreachable");
    s.routes.set(URL_INDEX, { status: 503 }); s.routes.set(URL_SIG, { body: Buffer.from("x") });
    assert.equal(await code(s.client.refresh()), "http-status");
  });
  it("enforces the size cap", async () => {
    const s = setup({ maxBytes: 100 }); serve(s.routes, indexDoc(5));
    assert.equal(await code(s.client.refresh()), "too-large");
  });
  it("refuses a disabled catalogue and non-https URLs without any request", async () => {
    const d = setup({ enabled: false }); assert.equal(await code(d.client.refresh()), "disabled");
    const h = setup({ url: "http://extensions.test/v1/index.json" }); assert.equal(await code(h.client.refresh()), "invalid-config");
    assert.equal(d.egress.calls.length + h.egress.calls.length, 0);
  });
  const signedBad = async (doc: unknown, want: ExtIndexErrorCode) => {
    const s = setup(); serve(s.routes, doc); assert.equal(await code(s.client.refresh()), want);
  };
  it("refuses validly signed but malformed content", async () => {
    await signedBad(indexDoc(1, { format: 2 }), "unsupported-format");
    await signedBad(indexDoc(-1), "malformed");
    await signedBad(indexDoc(1.5), "malformed");
    await signedBad(indexDoc(1, { expires: "soon" }), "malformed");
    await signedBad(indexDoc(1, { packages: "x" }), "malformed");
    const p = indexDoc(1).packages[0]!;
    await signedBad(indexDoc(1, { packages: [p, p] }), "malformed");
    await signedBad(indexDoc(1, { packages: [{ ...p, versions: [{ ...p.versions[0]!, url: "http://x/p.p1x" }] }] }), "malformed");
    await signedBad(indexDoc(1, { packages: [{ ...p, versions: [{ ...p.versions[0]!, sha256: "ABC" }] }] }), "malformed");
    await signedBad(indexDoc(1, { packages: [{ ...p, versions: [{ ...p.versions[0]!, size: 0 }] }] }), "malformed");
    const s = setup(); const b = Buffer.from("not json"); s.routes.set(URL_INDEX, { body: b }); s.routes.set(URL_SIG, { body: Buffer.from(signWith(K1.privateKey, b)) });
    assert.equal(await code(s.client.refresh()), "malformed");
  });
  it("verifies before parsing: unsigned garbage is a signature error, not a parse error", async () => {
    const s = setup(); s.routes.set(URL_INDEX, { body: Buffer.from("not json") }); s.routes.set(URL_SIG, { body: Buffer.from(signWith(K2.privateKey, Buffer.from("x"))) });
    assert.equal(await code(s.client.refresh()), "signature-invalid");
  });
});

describe("ext-index: against a fake HTTP server (adapter maps the https name to loopback)", () => {
  const opened: FakeEndpoint[] = [];
  after(async () => { await Promise.all(opened.map((f) => f.close())); });
  it("fetches index and signature end to end through an egress adapter", async () => {
    const b = bytesOf(indexDoc(11)); const sig = signWith(K1.privateKey, b);
    const f = await startFakeEndpoint((r) => (r.url.endsWith(".minisig") ? { body: Buffer.from(sig) } : { body: b })); opened.push(f);
    const egress: EgressPort = {
      async get(url, { maxBytes, timeoutMs }) {
        const u = new URL(url); const res = await fetch(`${f.origin}${u.pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
        const body = new Uint8Array(await res.arrayBuffer());
        if (body.byteLength > maxBytes) throw new ExtIndexError("too-large", "over cap");
        return { status: res.status, body };
      },
    };
    const client = createExtIndexClient({ config: cfg(), egress, store: createMemoryCacheStore(), now: () => T0 });
    const r = await client.refresh();
    assert.equal(r.index.serial, 11);
    assert.deepEqual(f.requests.map((q) => q.url).sort(), ["/v1/index.json", "/v1/index.json.minisig"]);
    assert.equal(createHash("sha256").update(b).digest("hex").length, 64);
  });
  it("types an http error from the server", async () => {
    const f = await startFakeEndpoint(() => ({ status: 500, body: Buffer.from("x") })); opened.push(f);
    const egress: EgressPort = { async get(url) { const res = await fetch(`${f.origin}${new URL(url).pathname}`); return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) }; } };
    const client = createExtIndexClient({ config: cfg(), egress, store: createMemoryCacheStore(), now: () => T0 });
    assert.equal(await code(client.refresh()), "http-status");
  });
});
