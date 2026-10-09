import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtIndexClient as createCatalogClient, createCatalogFileStore } from "../../src/catalog/ext-index/index.ts";
import { createEgress } from "../../src/egress/index.ts";
import { NOW, EXPIRES, key, root, signed, hash, index, revocations, type TestKey } from "./signing.ts";

async function fixture(t: { after(fn: () => unknown): void }, keys = [key("old")], threshold = 1) {
  const dir = await mkdtemp(join(tmpdir(), "catalog-trust-"));
  const routes = new Map<string, { status?: number; body: string | Buffer; location?: string; hang?: boolean }>();
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url!);
    const r = routes.get(req.url!);
    if (r?.hang) return;
    res.writeHead(r?.status ?? (r ? 200 : 404), r?.location ? { location: r.location } : {});
    res.end(r?.body ?? "missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const egress = createEgress({ config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [port], allowLoopback: true }) });
  let time = NOW;
  const config = { url: `${origin}/index`, root: root(keys, 1, threshold), testOrigin: origin, offlineGraceMs: 0, timeoutMs: 1000, maxBytes: 100_000, maxArtifactBytes: 100_000 };
  const store = createCatalogFileStore(dir);
  const reports: unknown[] = [];
  const make = () => createCatalogClient({ config, egress, store, now: () => time, installed: { list: async () => [{ id: "owner/skill", version: "1.0.0" }], report: async (items) => { reports.push(items); } } });
  const client = make();
  const put = (path: string, value: unknown) => routes.set(path, { body: JSON.stringify(value) });
  function serve(serial = 1, opts: { signers?: TestKey[]; rev?: ReturnType<typeof revocations>; rootVersion?: number; rotations?: unknown[]; overrides?: Record<string, unknown>; artifact?: Buffer } = {}) {
    const signers = opts.signers ?? keys;
    const rev = signed(opts.rev ?? revocations({ rootVersion: opts.rootVersion ?? 1 }), signers);
    const artifact = opts.artifact ?? Buffer.from("package");
    const doc = index(serial, artifact, { rootVersion: opts.rootVersion ?? 1, ...opts.overrides, revocation: { version: JSON.parse(Buffer.from(rev.payload, "base64").toString()).version, sha256: hash(Buffer.from(rev.payload, "base64")) } });
    if (Array.isArray(doc.packages) && doc.packages[0]?.versions) doc.packages[0]!.versions[0]!.url = `${origin}/artifact`;
    put("/index", signed(doc, signers)); put("/revocations", rev); put("/rotations", opts.rotations ?? []);
    routes.set("/artifact", { body: artifact });
    return doc;
  }
  return { dir, routes, hits, client, make, put, serve, config, reports, keys, setTime: (v: number) => { time = v; } };
}
function ok<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) assert.fail(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
function failure(r: { ok: boolean; error?: { code: string } }, code: string) { assert.equal(r.ok, false); assert.equal(r.error?.code, code); }

it("verifies exact bytes, downloads only metadata from the accepted version, and caches offline", async (t) => {
  const f = await fixture(t); f.serve();
  const first = ok(await f.client.refresh()); assert.equal(first.index.serial, 1);
  assert.equal(Buffer.from(ok(await f.client.download({ serial: 1, id: "owner/skill", version: "1.0.0" }))).toString(), "package");
  f.routes.clear(); const offline = ok(await f.make().get()); assert.equal(offline.source, "cache"); assert.equal(offline.refreshError?.code, "transport");
});
it("rejects tampered index, unknown signer and insufficient/duplicate threshold signatures", async (t) => {
  const keys = [key("one"), key("two")]; const f = await fixture(t, keys, 2); const doc = f.serve();
  const env = signed(doc, keys); env.payload = Buffer.from(JSON.stringify({ ...doc, serial: 9 })).toString("base64"); f.put("/index", env);
  failure(await f.client.refresh(), "signature_invalid");
  f.serve(1, { signers: [key("stranger")] }); failure(await f.client.refresh(), "key_unknown");
  f.serve(1, { signers: [keys[0]!, keys[0]!] }); failure(await f.client.refresh(), "signature_invalid");
  f.serve(); ok(await f.client.refresh());
});
it("rejects expired signer keys and refuses root placeholders before network I/O", async (t) => {
  const k = key("expired"); k.expires = "2026-01-01T00:00:00Z";
  const f = await fixture(t, [k]); f.serve(); failure(await f.client.refresh(), "signature_invalid");
  f.hits.length = 0; f.config.root.keys = []; failure(await f.make().refresh(), "key_unknown"); assert.equal(f.hits.length, 0);
});
it("persists rollback and same-version content protection even when the payload cache is damaged", async (t) => {
  const f = await fixture(t); f.serve(3); ok(await f.client.refresh());
  f.serve(2); failure(await f.make().refresh(), "rollback_detected");
  f.serve(3, { overrides: { generatedAt: "2026-10-06T00:00:00Z" } }); failure(await f.make().refresh(), "rollback_detected");
  await writeFile(join(f.dir, "snapshot.json"), "broken");
  f.serve(2); failure(await f.make().refresh(), "rollback_detected");
  f.serve(3); ok(await f.make().refresh());
});
it("rejects frozen indexes; offline grace permits reading with explicit stale marker, never downloading", async (t) => {
  const f = await fixture(t); f.serve(); ok(await f.client.refresh());
  f.setTime(Date.parse(EXPIRES) + 1); failure(await f.client.refresh(), "stale_index");
  f.routes.clear(); failure(await f.client.get(), "stale_index");
  f.config.offlineGraceMs = 1000; const stale = ok(await f.make().get()); assert.equal(stale.stale, true);
  failure(await f.make().download({ serial: 1, id: "owner/skill", version: "1.0.0" }), "stale_index");
  f.setTime(Date.parse(EXPIRES) + 1001); failure(await f.make().get(), "stale_index");
});
it("rejects mix-and-match index/revocation metadata and artifact version handles", async (t) => {
  const f = await fixture(t); f.serve(); ok(await f.client.refresh());
  f.serve(2); ok(await f.client.refresh());
  failure(await f.client.download({ serial: 1, id: "owner/skill", version: "1.0.0" }), "rollback_detected");
  f.put("/revocations", signed(revocations({ version: 2 }), f.keys)); failure(await f.client.refresh(), "signature_invalid");
});
it("accepts consecutive old-threshold-authorized rotations and replays them offline after restart", async (t) => {
  const f = await fixture(t); const next = [key("next")]; const third = [key("third")];
  const rotations = [signed(root(next, 2), f.keys), signed(root(third, 3), next)];
  f.serve(1, { signers: third, rootVersion: 3, rotations }); ok(await f.client.refresh());
  f.routes.clear(); assert.equal(ok(await f.make().get()).rootVersion, 3);
});
it("rejects skipped, forged, expired and rolled back rotations", async (t) => {
  const f = await fixture(t); const next = [key("next")];
  f.serve(1, { signers: next, rootVersion: 3, rotations: [signed(root(next, 3), f.keys)] }); failure(await f.client.refresh(), "rollback_detected");
  f.serve(1, { signers: next, rootVersion: 2, rotations: [signed(root(next, 2), next)] }); failure(await f.client.refresh(), "key_unknown");
  f.serve(1, { signers: next, rootVersion: 2, rotations: [signed({ ...root(next, 2), expires: "2026-01-01T00:00:00Z" }, f.keys)] }); failure(await f.client.refresh(), "stale_index");
  f.serve(1, { signers: next, rootVersion: 2, rotations: [signed(root(next, 2), f.keys)] }); ok(await f.client.refresh());
  f.serve(2); failure(await f.make().refresh(), "rollback_detected");
});
it("revokes keys and packages, filters offers and reports installed copies through the port", async (t) => {
  const f = await fixture(t, [key("old"), key("backup")]);
  f.serve(1, { signers: [f.keys[1]!], rev: revocations({ keys: ["old"], packages: [{ id: "owner/skill", versions: ["1.0.0"], reason: "compromised" }] }) });
  assert.equal(ok(await f.client.refresh()).index.packages.length, 0);
  assert.deepEqual(f.reports[0], [{ id: "owner/skill", version: "1.0.0", status: "revoked", reason: "compromised" }]);
  failure(await f.client.download({ serial: 1, id: "owner/skill", version: "1.0.0" }), "revoked_package");
  f.serve(2); failure(await f.client.refresh(), "key_revoked");
});
it("rejects a revocation signed solely by the key it revokes", async (t) => {
  const f = await fixture(t); f.serve(1, { rev: revocations({ keys: ["old"] }) }); failure(await f.client.refresh(), "key_revoked");
});
it("persists revocations and refuses removing them or replaying old revocation versions", async (t) => {
  const f = await fixture(t); f.serve(1, { rev: revocations({ version: 2, packages: [{ id: "owner/skill", versions: ["1.0.0"], reason: "bad" }] }) }); ok(await f.client.refresh());
  f.serve(2); failure(await f.make().refresh(), "rollback_detected");
  f.serve(2, { rev: revocations({ version: 3 }) }); failure(await f.make().refresh(), "revoked_package");
});
it("checks artifact hash and size against signed metadata", async (t) => {
  const f = await fixture(t); f.serve(); ok(await f.client.refresh()); f.routes.set("/artifact", { body: Buffer.from("tamper!") });
  failure(await f.client.download({ serial: 1, id: "owner/skill", version: "1.0.0" }), "hash_mismatch");
  f.routes.set("/artifact", { body: Buffer.alloc(8) }); failure(await f.client.download({ serial: 1, id: "owner/skill", version: "1.0.0" }), "transport");
});
it("reloads a damaged cache online; fails closed on a damaged security checkpoint", async (t) => {
  const f = await fixture(t); f.serve(); ok(await f.client.refresh());
  await writeFile(join(f.dir, "snapshot.json"), "not JSON"); ok(await f.make().get());
  const snapshot = JSON.parse(await readFile(join(f.dir, "snapshot.json"), "utf8")); snapshot.index.payload = "AAAA";
  await writeFile(join(f.dir, "snapshot.json"), JSON.stringify(snapshot)); f.routes.clear(); failure(await f.make().get(), "signature_invalid");
  f.serve(2); ok(await f.make().get()); await writeFile(join(f.dir, "checkpoint.json"), "bad"); failure(await f.make().get(), "rollback_detected");
});
it("enforces HTTPS, explicit loopback testing, egress, byte cap, deadlines and refuses redirects before following", async (t) => {
  const f = await fixture(t); f.serve();
  const origin = f.config.testOrigin; f.config.testOrigin = ""; failure(await f.make().refresh(), "transport"); assert.equal(f.hits.length, 0); f.config.testOrigin = origin;
  f.routes.set("/index", { status: 302, location: "http://localhost:1/stolen", body: "" }); failure(await f.client.refresh(), "transport"); assert.ok(!f.hits.includes("/stolen"));
  f.routes.set("/index", { body: Buffer.alloc(100001) }); failure(await f.client.refresh(), "transport");
  f.config.timeoutMs = 30; f.routes.set("/index", { body: "", hang: true }); failure(await f.make().refresh(), "transport");
  f.config.url = "https://not-allowed.test/index"; failure(await f.make().refresh(), "transport");
});
it("accepts whitespace-sensitive signed bytes without reserializing", async (t) => {
  const f = await fixture(t); const doc = f.serve(); f.put("/index", signed(JSON.stringify(doc, null, 2) + "\n", f.keys));
  ok(await f.client.refresh());
  f.routes.clear(); ok(await f.make().get());
});
it("does not mask a signature attack with a previously valid cache", async (t) => {
  const f = await fixture(t); f.serve(); ok(await f.client.refresh());
  f.serve(2, { signers: [key("untrusted")] }); failure(await f.client.get(), "key_unknown");
});
it("requires the OLD threshold for rotation and validates the new threshold", async (t) => {
  const f = await fixture(t, [key("one"), key("two")], 2); const next = [key("new")];
  f.serve(1, { signers: next, rootVersion: 2, rotations: [signed(root(next, 2), [f.keys[0]!])] }); failure(await f.client.refresh(), "signature_invalid");
  f.serve(1, { signers: next, rootVersion: 2, rotations: [signed(root(next, 2, 2), f.keys)] }); failure(await f.client.refresh(), "signature_invalid");
  f.serve(1, { signers: next, rootVersion: 2, rotations: [signed(root(next, 2), f.keys)] }); ok(await f.client.refresh());
});
it("cannot use a revoked historical key for a new rotation or restore it under an alias", async (t) => {
  const f = await fixture(t, [key("old"), key("backup")]);
  f.serve(1, { signers: [f.keys[1]!], rev: revocations({ keys: ["old"] }) }); ok(await f.client.refresh());
  const next = [key("attacker")];
  f.serve(2, { rootVersion: 2, signers: next, rev: revocations({ version: 2, rootVersion: 2, keys: ["old"] }), rotations: [signed(root(next, 2), [f.keys[0]!])] }); failure(await f.make().refresh(), "key_revoked");
  const alias = { ...f.keys[0]!, id: "alias" };
  f.serve(2, { rootVersion: 2, signers: [alias], rev: revocations({ version: 2, rootVersion: 2, keys: ["old"] }), rotations: [signed(root([alias], 2), [f.keys[1]!])] }); failure(await f.make().refresh(), "key_revoked");
});
it("validates all signed metadata, forbids unknown artifact identities and preserves independent limits", async (t) => {
  const f = await fixture(t); f.serve(1, { overrides: { packages: "invalid" } }); failure(await f.client.refresh(), "signature_invalid");
  f.serve(); ok(await f.client.refresh());
  failure(await f.client.download({ serial: 1, id: "unknown", version: "1.0.0" }), "signature_invalid");
  f.config.maxArtifactBytes = 1; failure(await f.make().download({ serial: 1, id: "owner/skill", version: "1.0.0" }), "transport");
  f.config.timeoutMs = 0; failure(await f.make().refresh(), "transport");
});
it("serializes concurrent clients so an older refresh cannot overwrite a newer checkpoint", async (t) => {
  const f = await fixture(t); f.serve(8);
  const results = await Promise.all([f.client.refresh(), f.make().refresh(), f.make().refresh()]); results.forEach(ok);
  f.serve(7); failure(await f.make().refresh(), "rollback_detected");
});
it("preserves #162's persistent serial floor when upgrading the cache format", async (t) => {
  const f = await fixture(t); await writeFile(join(f.dir, "last-serial"), "9");
  f.serve(8); failure(await f.client.refresh(), "rollback_detected");
  f.serve(9); failure(await f.client.refresh(), "rollback_detected");
  f.serve(10); ok(await f.client.refresh());
});
it("keeps accepted rotations usable when historical authorizing keys expire", async (t) => {
  const old = key("old"); old.expires = "2026-10-08T00:00:00Z";
  const f = await fixture(t, [old]); const next = [key("new")];
  f.serve(1, { rootVersion: 2, signers: next, rotations: [signed(root(next, 2), [old])] }); ok(await f.client.refresh());
  f.setTime(Date.parse("2026-10-09T00:00:00Z")); f.routes.clear(); ok(await f.make().get());
});
it("still reports cached package revocations after expiry even when grace is exhausted", async (t) => {
  const f = await fixture(t); f.serve(1, { rev: revocations({ packages: [{ id: "owner/skill", versions: ["1.0.0"], reason: "unsafe" }] }) }); ok(await f.client.refresh());
  f.reports.length = 0; f.routes.clear(); f.setTime(Date.parse(EXPIRES) + 1);
  failure(await f.make().get(), "stale_index"); assert.equal(f.reports.length, 1);
});
it("defaults a provisioned root to one-of-n and rejects duplicate key material", async (t) => {
  const f = await fixture(t); Reflect.deleteProperty(f.config.root, "threshold"); f.serve(); ok(await f.make().refresh());
  const duplicate = { ...f.config.root.keys[0]!, id: "alias" }; f.config.root.keys.push(duplicate);
  failure(await f.make().refresh(), "signature_invalid");
});
it("rejects expired revocations, future indexes and same-list-version conflicts", async (t) => {
  const f = await fixture(t); f.serve(1, { rev: revocations({ expires: "2026-10-01T00:00:00Z" }) }); failure(await f.client.refresh(), "stale_index");
  f.serve(1, { overrides: { generatedAt: "2026-10-08T00:00:00Z" } }); failure(await f.client.refresh(), "signature_invalid");
  f.serve(); ok(await f.client.refresh());
  f.serve(2, { rev: revocations({ packages: [{ id: "owner/skill", versions: ["1.0.0"], reason: "new" }] }) }); failure(await f.client.refresh(), "rollback_detected");
});
it("recovers a crash between checkpoint and snapshot without serving the older cache", async (t) => {
  const f = await fixture(t); f.serve(); ok(await f.client.refresh()); const old = await readFile(join(f.dir, "snapshot.json"));
  f.serve(2); ok(await f.client.refresh()); await writeFile(join(f.dir, "snapshot.json"), old); f.routes.clear();
  failure(await f.make().get(), "rollback_detected");
  f.serve(2); ok(await f.make().get());
});
it("advances all metadata versions on a legitimate rotation then revokes the retired key", async (t) => {
  const f = await fixture(t); f.serve(); ok(await f.client.refresh()); const next = [key("new")];
  f.serve(2, { rootVersion: 2, signers: next, rotations: [signed(root(next, 2), f.keys)], rev: revocations({ version: 2, rootVersion: 2, keys: ["old"] }) }); ok(await f.client.refresh());
  f.routes.clear(); assert.equal(ok(await f.make().get()).rootVersion, 2);
});
it("caller mutation cannot alter subsequent artifact verification", async (t) => {
  const f = await fixture(t); f.serve(); const view = ok(await f.client.refresh());
  view.index.packages[0]!.versions[0]!.url = "https://evil.test/package";
  assert.equal(Buffer.from(ok(await f.client.download({ serial: 1, id: "owner/skill", version: "1.0.0" }))).toString(), "package");
  assert.ok(!f.hits.includes("/package"));
});
it("does not interpret a JSON-null checkpoint or missing checkpoint with corrupt snapshot as a fresh trust store", async (t) => {
  const f = await fixture(t); f.serve(); ok(await f.client.refresh());
  await writeFile(join(f.dir, "checkpoint.json"), "null"); failure(await f.make().get(), "rollback_detected");
  await rm(join(f.dir, "checkpoint.json")); await writeFile(join(f.dir, "snapshot.json"), "broken"); failure(await f.make().get(), "rollback_detected");
});
