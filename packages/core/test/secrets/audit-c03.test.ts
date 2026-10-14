import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createFileAuditSink, createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createFileBackend } from "../../src/secrets/file-backend.ts";
import { createKeyringBackend } from "../../src/secrets/keyring-backend.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { buildSecretMethods } from "../../src/secrets/rpc.ts";
import { SecretError, type SecretBackend, type SecretPrincipal } from "../../src/secrets/types.ts";
import { MARKER, fakeClock, fakeKeyring, secure } from "./helpers.ts";

const owner: SecretPrincipal = { kind: "owner", id: "tester" };
const core: SecretPrincipal = { kind: "core" };
const agent: SecretPrincipal = { kind: "agent", agentId: "a1" };
const code = (c: string) => (e: unknown) => { assert.ok(e instanceof SecretError, String(e)); assert.equal(e.code, c); return true; };
const now = new Date("2026-10-14T10:00:00.000Z");
const fileDir = () => join(tempDir("p1b-sec-c03-"), "secrets");

describe("c03: names that exist on Object.prototype are plain absent names", () => {
  const PROTO = ["constructor", "toString", "hasOwnProperty", "valueOf"];
  it("file backend: get/delete of an absent prototype name is null/false and does not rewrite the store", async () => {
    for (const empty of [true, false]) {
      const dir = fileDir(); const b = createFileBackend({ dir, secure });
      if (!empty) await b.put("real", MARKER, now);
      const store = join(dir, "store.json");
      const before = empty ? null : readFileSync(store, "utf8");
      for (const n of PROTO) {
        assert.equal(await b.get(n), null, n);
        assert.equal(await b.delete(n), false, n);
      }
      if (before !== null) assert.equal(readFileSync(store, "utf8"), before);
    }
  });
  it("keyring backend: delete of an absent prototype name is false and writes no index", async () => {
    const kr = fakeKeyring();
    const b = createKeyringBackend({ service: "s", load: async () => kr });
    for (const n of PROTO) assert.equal(await b.delete(n), false, n);
    assert.equal(kr.items.size, 0);
  });
  it("a prototype name can still be stored, listed and deleted for real", async () => {
    const b = createFileBackend({ dir: fileDir(), secure });
    await b.put("constructor", MARKER, now);
    assert.equal(await b.get("constructor"), MARKER);
    assert.deepEqual((await b.list()).map((m) => m.name), ["constructor"]);
    assert.equal(await b.delete("constructor"), true);
    assert.equal(await b.get("constructor"), null);
  });
});

describe("c03: audit trail content is bounded and attributable", () => {
  it("a refused call does not copy an arbitrary caller string into the audit target", async () => {
    const audit = createMemoryAuditSink();
    const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit });
    const junk = `${MARKER}${"x".repeat(5000)}`;
    await assert.rejects(() => store.set(agent, junk, "v"), code("denied"));
    await assert.rejects(() => store.reveal(agent, MARKER), code("denied"));
    const targets = audit.events.map((e) => e.target);
    assert.ok(targets.every((t) => t === null || (t.length <= 128 && t !== junk)), JSON.stringify(targets.map((t) => t?.length)));
    assert.equal(targets[0], null);
  });
  it("file sink: unknown principal kinds are not attributed to core; ids are capped", () => {
    const file = join(tempDir("p1b-aud-c03-"), "logs", "audit.log");
    const sink = createFileAuditSink({ file, secure });
    sink.record({ action: "secret.denied", target: null, principal: { kind: "root" } as unknown as SecretPrincipal });
    sink.record({ action: "secret.denied", target: null, principal: { kind: "agent", agentId: "a".repeat(10_000) } });
    sink.record({ action: "secret.get", target: "k", principal: { kind: "owner", id: "o\nforged".repeat(500) } });
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.notEqual(lines[0].actor.user, "core");
    for (const l of lines) assert.ok(l.actor.user.length <= 160, String(l.actor.user.length));
  });
});

describe("c03: rotation and deletion leave no second copy", () => {
  function twoBackends() {
    const keyring = createMemoryBackend(); const file = createMemoryBackend();
    const store = createSecretStore({ keyring, file, fileFallback: () => true, audit: createMemoryAuditSink(), clock: fakeClock() });
    return { keyring, file, store };
  }
  it("set into the selected backend removes a stale copy from the other one", async () => {
    const { keyring, file, store } = twoBackends();
    await file.put("k", "old-value-in-file", now);
    await store.set(owner, "k", MARKER);
    assert.equal(await file.get("k"), null);
    keyring.available = false; // the keyring disappears: the old value must not come back
    await assert.rejects(() => store.reveal(owner, "k"), code("not-found"));
  });
  it("delete also removes a copy in the file backend when the fallback flag is off", async () => {
    const keyring = createMemoryBackend(); const file = createMemoryBackend();
    let on = true;
    const store = createSecretStore({ keyring, file, fileFallback: () => on, audit: createMemoryAuditSink(), clock: fakeClock() });
    await file.put("k", MARKER, now);
    on = false;
    assert.deepEqual(await store.delete(owner, "k"), { removed: true }); // the hidden copy counts
    assert.equal(await file.get("k"), null);
  });
  it("a lease being issued while the secret is rotated never carries the old value", async () => {
    const mem = createMemoryBackend();
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let slow = false;
    const backend: SecretBackend = Object.assign(Object.create(mem) as SecretBackend, {
      async get(n: string) { const v = await mem.get(n); if (slow) await gate; return v; },
    });
    const store = createSecretStore({ keyring: backend, file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink(), clock: fakeClock() });
    await store.set(owner, "k", "old-value");
    slow = true;
    const pending = store.lease(core, "k", { purpose: "p", profileId: "q" }).then((l) => ({ l }), (e) => ({ e }));
    await new Promise((r) => setImmediate(r));
    slow = false;
    await store.set(owner, "k", "new-value");
    release();
    const r = await pending;
    if ("l" in r) assert.equal(r.l.value, "new-value"); else assert.equal((r.e as SecretError).code, "lease-invalid");
    for (const info of store.activeLeases(core)) assert.notEqual(store.readLease(core, info.leaseId).value, "old-value");
  });
});

describe("c03: leases do not print or mutate", () => {
  const mk = async () => {
    const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink(), clock: fakeClock() });
    await store.set(owner, "k", MARKER);
    return store;
  };
  it("JSON, inspect and string conversion of a lease never contain the value", async () => {
    const store = await mk();
    const l = await store.lease(core, "k", { purpose: "p", profileId: "q" });
    const r = store.readLease(core, l.leaseId);
    for (const x of [l, r]) {
      assert.ok(!JSON.stringify(x).includes(MARKER));
      assert.ok(!inspect(x, { depth: 5 }).includes(MARKER));
      assert.ok(!`${JSON.stringify([x])}${String(x)}`.includes(MARKER));
      assert.equal(x.value, MARKER);
    }
  });
  it("mutating a returned lease cannot extend it or change the held value", async () => {
    const clock = fakeClock();
    const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink(), clock });
    await store.set(owner, "k", MARKER);
    const l = await store.lease(core, "k", { purpose: "p", profileId: "q", ttlMs: 1000 });
    try { (l as { expiresAt: number }).expiresAt = Number.MAX_SAFE_INTEGER; (l as { value: string }).value = "tampered"; } catch { /* frozen: fine */ }
    clock.advance(1000);
    assert.throws(() => store.readLease(core, l.leaseId), code("lease-invalid"));
    const l2 = await store.lease(core, "k", { purpose: "p", profileId: "q" });
    try { (store.readLease(core, l2.leaseId) as { value: string }).value = "tampered"; } catch { /* frozen */ }
    assert.equal(store.readLease(core, l2.leaseId).value, MARKER);
  });
  it("purpose and profileId must be strings", async () => {
    const store = await mk();
    await assert.rejects(() => store.lease(core, "k", { purpose: ["ok"] as unknown as string, profileId: "q" }), code("invalid-value"));
  });
});

describe("c03: a broken file store never leaks platform errors", () => {
  it("an unreadable key file (a directory) is a SecretError without a path", async () => {
    const dir = fileDir(); const b = createFileBackend({ dir, secure });
    await b.put("k", MARKER, now);
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "store.key")); mkdirSync(join(dir, "store.key"));
    for (const op of [() => b.get("k"), () => b.put("k2", "v", now)]) {
      await assert.rejects(op, (e: unknown) => { assert.ok(e instanceof SecretError, String(e)); assert.ok(!e.message.includes(dir), e.message); return true; });
    }
  });
  it("a half-written key file next to an empty store is replaced, not a permanent failure", async () => {
    const dir = fileDir(); mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "store.key"), "", { mode: 0o600 });
    const b = createFileBackend({ dir, secure });
    await b.put("k", MARKER, now);
    assert.equal(await b.get("k"), MARKER);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "store.key")).mode & 0o777, 0o600);
  });
  it("a key file that no longer matches existing entries still refuses (never regenerated)", async () => {
    const dir = fileDir(); const b = createFileBackend({ dir, secure });
    await b.put("k", MARKER, now);
    writeFileSync(join(dir, "store.key"), "");
    await assert.rejects(() => b.put("k2", "v", now), code("corrupt"));
  });
});

describe("c03: rpc handlers refuse before touching params", () => {
  it("a non-owner with missing params gets denied, not a TypeError", async () => {
    const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() });
    const m = buildSecretMethods({ store, principalOf: () => agent });
    for (const method of ["secret.set", "secret.get", "secret.delete"] as const) {
      await assert.rejects(() => m[method](undefined as never, {} as never), (e: unknown) => { assert.equal((e as { error?: string }).error, "E_DENIED", method); return true; });
    }
  });
});
