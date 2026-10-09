import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAuditSink, type AuditAction, type AuditSink } from "../../src/secrets/audit.ts";
import { createSecretStore, type SecretStoreLogger } from "../../src/secrets/store.ts";
import { SecretError, type BackendKind, type BackendProbe, type SecretBackend, type SecretMeta, type SecretPrincipal } from "../../src/secrets/types.ts";
import { MARKER, fakeClock } from "./helpers.ts";

const owner: SecretPrincipal = { kind: "owner", id: "tester" };
const core: SecretPrincipal = { kind: "core" };
const agent: SecretPrincipal = { kind: "agent", agentId: "a1" };
const code = (c: string) => (e: unknown) => { assert.ok(e instanceof SecretError, String(e)); assert.equal(e.code, c); return true; };

interface MemBackend extends SecretBackend {
  items: Map<string, SecretMeta & { value: string }>;
  probeResult: BackendProbe; failList: boolean; hideMeta: boolean; probes: number;
}
function memBackend(kind: BackendKind, probeResult: BackendProbe = { available: true }): MemBackend {
  const items = new Map<string, SecretMeta & { value: string }>();
  const b: MemBackend = {
    kind, items, probeResult, failList: false, hideMeta: false, probes: 0,
    async probe() { b.probes++; return b.probeResult; },
    async get(name) { return items.get(name)?.value ?? null; },
    async put(name, value, now) {
      const prev = items.get(name);
      const iso = now.toISOString();
      const meta = { name, backend: kind, createdAt: prev?.createdAt ?? iso, updatedAt: iso };
      items.set(name, { ...meta, value });
      return meta;
    },
    async delete(name) { return items.delete(name); },
    async list() {
      if (b.failList) throw new SecretError("storage", "list failed");
      if (b.hideMeta) return [];
      return [...items.values()].map(({ value: _v, ...m }) => m);
    },
  };
  return b;
}

function setup(o: { fallback?: boolean; keyring?: BackendProbe; file?: BackendProbe; logger?: boolean; noClock?: boolean; audit?: AuditSink } = {}) {
  const keyring = memBackend("keyring", o.keyring ?? { available: true });
  const file = memBackend("file", o.file ?? { available: true });
  const clock = fakeClock();
  const audit = createMemoryAuditSink();
  const flag = { on: o.fallback ?? false };
  const logs: { level: string; msg: string; fields?: Record<string, unknown> | undefined }[] = [];
  const logger: SecretStoreLogger = {
    debug: (msg, fields) => { logs.push({ level: "debug", msg, fields }); },
    info: (msg, fields) => { logs.push({ level: "info", msg, fields }); },
    warn: (msg, fields) => { logs.push({ level: "warn", msg, fields }); },
  };
  const store = createSecretStore({ keyring, file, fileFallback: () => flag.on, audit: o.audit ?? audit, ...(o.noClock ? {} : { clock }), ...(o.logger === false ? {} : { logger }) });
  return { keyring, file, clock, audit, flag, logs, store };
}
const actions = (a: ReturnType<typeof createMemoryAuditSink>) => a.events.map((e) => e.action);

describe("secret store coverage: gate and principals", () => {
  const weird: { name: string; p: unknown }[] = [
    { name: "null", p: null },
    { name: "undefined", p: undefined },
    { name: "a string", p: "owner" },
    { name: "a number", p: 5 },
    { name: "an object without kind", p: {} },
    { name: "a numeric kind", p: { kind: 5 } },
    { name: "an unknown kind", p: { kind: "root" } },
    { name: "a case-variant kind", p: { kind: "Owner" } },
  ];
  for (const c of weird) {
    it(`every operation refuses ${c.name} with denied`, async () => {
      const s = setup();
      const p = c.p as SecretPrincipal;
      const ops: (() => unknown)[] = [
        () => s.store.status(p), () => s.store.set(p, "k", "v"), () => s.store.meta(p, "k"), () => s.store.reveal(p, "k"), () => s.store.delete(p, "k"),
        () => s.store.list(p), () => s.store.lease(p, "k", { purpose: "p", profileId: "q" }), () => s.store.readLease(p, "x"), () => s.store.revokeLease(p, "x"), () => s.store.activeLeases(p),
      ];
      for (const op of ops) await assert.rejects(async () => op(), code("denied"));
      assert.ok(s.audit.events.every((e) => e.action === "secret.denied"));
      assert.equal(s.audit.events.length, ops.length);
      assert.equal(s.keyring.probes, 0, "no backend is touched before the gate");
    });
  }
  it("a denial is audited with the principal when it has a kind, else as agent, and logs the kind", async () => {
    const s = setup();
    await assert.rejects(() => s.store.reveal(agent, "k"), code("denied"));
    await assert.rejects(() => s.store.reveal({} as never, "k"), code("denied"));
    await assert.rejects(() => s.store.reveal(null as never, "k"), code("denied"));
    assert.deepEqual(s.audit.events.map((e) => e.principal), [agent, { kind: "agent" }, { kind: "agent" }]);
    assert.deepEqual(s.audit.events[0]!.detail, { method: "reveal" });
    assert.deepEqual(s.audit.events[0]!.target, "k");
    assert.deepEqual(s.logs.filter((l) => l.level === "warn").map((l) => l.fields), [{ method: "reveal", kind: "agent" }, { method: "reveal", kind: "unknown" }, { method: "reveal", kind: "unknown" }]);
  });
  it("a non-string name is audited as target null", async () => {
    const s = setup();
    await assert.rejects(() => s.store.set(agent, 5 as never, "v"), code("denied"));
    assert.equal(s.audit.events[0]!.target, null);
  });
  it("a failing audit sink or a missing logger does not turn a denial into another error", async () => {
    const failing: AuditSink = { record() { throw new Error("disk"); } };
    const s = setup({ audit: failing, logger: false });
    await assert.rejects(() => s.store.list(agent), code("denied"));
  });
  it("the denial message and detail do not echo names or values", async () => {
    const s = setup();
    await assert.rejects(() => s.store.set(agent, "my-name", MARKER), (e) => {
      assert.ok(e instanceof SecretError);
      assert.ok(!JSON.stringify([e.message, e.detail]).includes(MARKER));
      assert.deepEqual(e.detail, { method: "set" });
      return true;
    });
  });
  it("owner is allowed everywhere; core only on status and lease operations", async () => {
    const s = setup();
    await s.store.set(owner, "k", MARKER);
    assert.equal((await s.store.status(core)).backend, "keyring");
    assert.deepEqual(s.store.activeLeases(core), []);
    for (const op of [() => s.store.set(core, "k", "v"), () => s.store.meta(core, "k"), () => s.store.reveal(core, "k"), () => s.store.delete(core, "k"), () => s.store.list(core)]) await assert.rejects(async () => op(), code("denied"));
  });
});

describe("secret store coverage: backend selection and status", () => {
  it("logs the selected backend only when it changes, with the keyring reason", async () => {
    const s = setup({ fallback: true, keyring: { available: false, reason: "keyring-error" } });
    await s.store.status(owner); await s.store.status(owner);
    const infos = s.logs.filter((l) => l.level === "info");
    assert.deepEqual(infos.map((l) => l.fields), [{ backend: "file", keyringReason: "keyring-error" }]);
    s.keyring.probeResult = { available: true };
    await s.store.status(owner);
    assert.deepEqual(s.logs.filter((l) => l.level === "info").at(-1)?.fields, { backend: "keyring" });
  });
  it("without a logger selection works silently", async () => {
    const s = setup({ logger: false });
    assert.equal((await s.store.status(owner)).backend, "keyring");
  });
  it("status shapes: keyring healthy, file disabled (not probed)", async () => {
    const s = setup();
    await s.store.set(owner, "a", "1");
    const st = await s.store.status(owner);
    assert.deepEqual(st, { backend: "keyring", degraded: false, keyring: { available: true }, file: { enabled: false, available: null }, count: 1, activeLeases: 0 });
    assert.equal(s.file.probes, 0, "the file backend is not probed while the flag is off");
  });
  it("status with the file enabled and healthy reports file.available true, file reason when present", async () => {
    const s = setup({ fallback: true, file: { available: true, reason: "perm-warning" } });
    const st = await s.store.status(owner);
    assert.deepEqual(st.file, { enabled: true, available: true, reason: "perm-warning" });
  });
  it("keyring down and file unavailable: none, file.available false with its reason, remedy set, count null", async () => {
    const s = setup({ fallback: true, keyring: { available: false, reason: "no-service" }, file: { available: false, reason: "bad-perms" } });
    const st = await s.store.status(owner);
    assert.equal(st.backend, "none");
    assert.equal(st.degraded, true);
    assert.deepEqual(st.keyring, { available: false, reason: "no-service" });
    assert.deepEqual(st.file, { enabled: true, available: false, reason: "bad-perms" });
    assert.equal(st.count, null);
    assert.match(st.remedy ?? "", /secrets\.fileFallback\.enabled/);
  });
  it("keyring down without a reason omits it; file in use is degraded", async () => {
    const s = setup({ fallback: true, keyring: { available: false } });
    const st = await s.store.status(owner);
    assert.deepEqual(st.keyring, { available: false });
    assert.deepEqual([st.backend, st.degraded, "remedy" in st], ["file", true, false]);
  });
  it("a backend that cannot list gives count null; leases are counted", async () => {
    const s = setup();
    s.keyring.failList = true;
    await s.store.set(owner, "k", MARKER);
    await s.store.lease(owner, "k", { purpose: "p", profileId: "q" });
    const st = await s.store.status(owner);
    assert.equal(st.count, null);
    assert.equal(st.activeLeases, 1);
  });
  it("the flag is read per use", async () => {
    const s = setup({ keyring: { available: false } });
    assert.equal((await s.store.status(owner)).backend, "none");
    s.flag.on = true;
    assert.equal((await s.store.status(owner)).backend, "file");
    s.flag.on = false;
    assert.equal((await s.store.status(owner)).backend, "none");
  });
});

describe("secret store coverage: set / meta / reveal", () => {
  it("set validates the name and value before touching a backend or the audit", async () => {
    const s = setup();
    for (const n of ["", " ", "-x", "a b", "x".repeat(129), 5 as never, null as never]) await assert.rejects(() => s.store.set(owner, n, "v"), code("invalid-name"));
    for (const v of ["", "a\u0000b", "x".repeat(64 * 1024 + 1), 5 as never, null as never]) await assert.rejects(() => s.store.set(owner, "k", v), code("invalid-value"));
    assert.equal(s.audit.events.length, 0);
    assert.equal(s.keyring.probes, 0);
  });
  it("accepts boundary names and values (128 chars, 64 KiB, unicode)", async () => {
    const s = setup();
    await s.store.set(owner, `a${"b".repeat(127)}`, "v");
    await s.store.set(owner, "big", "x".repeat(64 * 1024));
    await s.store.set(owner, "uni", "日本語-ü-🔑");
    assert.equal((await s.store.reveal(owner, "uni")).value, "日本語-ü-🔑");
  });
  it("set audits first with the backend kind and stamps the clock; rotating keeps createdAt", async () => {
    const s = setup();
    const m1 = await s.store.set(owner, "k", "v1");
    s.clock.advance(5000);
    const m2 = await s.store.set(owner, "k", "v2");
    assert.equal(m2.createdAt, m1.createdAt);
    assert.notEqual(m2.updatedAt, m1.updatedAt);
    assert.deepEqual(s.audit.events[0], { action: "secret.set", target: "k", principal: owner, detail: { backend: "keyring" } });
  });
  it("set without a backend fails no-backend before auditing", async () => {
    const s = setup({ keyring: { available: false } });
    await assert.rejects(() => s.store.set(owner, "k", "v"), code("no-backend"));
    assert.equal(s.audit.events.length, 0);
  });
  it("set with the default clock stamps a current date", async () => {
    const s = setup({ noClock: true });
    const before = Date.now();
    const m = await s.store.set(owner, "k", "v");
    assert.ok(Date.parse(m.updatedAt) >= before - 1000);
  });
  it("a failing audit blocks set (nothing stored) and reveal (no value returned)", async () => {
    const s = setup();
    s.audit.failNext = true;
    await assert.rejects(() => s.store.set(owner, "k", MARKER), code("audit-unavailable"));
    assert.equal(s.keyring.items.size, 0);
    await s.store.set(owner, "k", MARKER);
    s.audit.failNext = true;
    await assert.rejects(() => s.store.reveal(owner, "k"), code("audit-unavailable"));
    s.audit.failNext = true;
    await assert.rejects(() => s.store.meta(owner, "k"), code("audit-unavailable"));
    s.audit.failNext = true;
    await assert.rejects(() => s.store.list(owner), code("audit-unavailable"));
    s.audit.failNext = true;
    await assert.rejects(() => s.store.delete(owner, "k"), code("audit-unavailable"));
    assert.equal(s.keyring.items.size, 1, "the delete did not happen");
  });
  it("meta finds metadata in the selected or the other backend, never returns the value", async () => {
    const s = setup({ fallback: true });
    await s.file.put("only-file", MARKER, new Date(0));
    await s.keyring.put("only-keyring", MARKER, new Date(0));
    const a = await s.store.meta(owner, "only-keyring");
    const b = await s.store.meta(owner, "only-file");
    assert.equal(a.backend, "keyring"); assert.equal(b.backend, "file");
    assert.ok(!JSON.stringify([a, b]).includes(MARKER));
    await assert.rejects(() => s.store.meta(owner, "missing"), code("not-found"));
    await assert.rejects(() => s.store.meta(owner, "bad name"), code("invalid-name"));
  });
  it("meta with no usable backend is not-found (nothing to search)", async () => {
    const s = setup({ keyring: { available: false } });
    await assert.rejects(() => s.store.meta(owner, "k"), code("not-found"));
  });
  it("meta audits before searching, even for a name that does not exist", async () => {
    const s = setup();
    await assert.rejects(() => s.store.meta(owner, "ghost"), code("not-found"));
    assert.deepEqual(actions(s.audit), ["secret.get"]);
  });
  it("reveal returns value and meta; a missing name is not-found (after the audit line)", async () => {
    const s = setup();
    await s.store.set(owner, "k", MARKER);
    const r = await s.store.reveal(owner, "k");
    assert.equal(r.value, MARKER);
    assert.equal(r.meta.name, "k");
    await assert.rejects(() => s.store.reveal(owner, "nope"), code("not-found"));
    assert.deepEqual(actions(s.audit), ["secret.set", "secret.reveal", "secret.reveal"]);
  });
  it("reveal falls back to a synthetic meta when the backend lists no entry for a found value", async () => {
    const s = setup();
    await s.store.set(owner, "k", MARKER);
    s.keyring.hideMeta = true;
    const r = await s.store.reveal(owner, "k");
    assert.deepEqual(r.meta, { name: "k", backend: "keyring", createdAt: "", updatedAt: "" });
  });
  it("reveal finds a value in the other backend and reports that backend", async () => {
    const s = setup({ fallback: true });
    await s.file.put("k", MARKER, new Date(0));
    const r = await s.store.reveal(owner, "k");
    assert.equal(r.meta.backend, "file");
  });
  it("the selected backend wins when both hold a name", async () => {
    const s = setup({ fallback: true });
    await s.file.put("k", "from-file", new Date(0));
    await s.keyring.put("k", "from-keyring", new Date(0));
    assert.equal((await s.store.reveal(owner, "k")).value, "from-keyring");
  });
  it("reveal with an invalid name never audits", async () => {
    const s = setup();
    await assert.rejects(() => s.store.reveal(owner, "a b"), code("invalid-name"));
    assert.equal(s.audit.events.length, 0);
  });
});

describe("secret store coverage: delete and list", () => {
  it("delete removes from both backends and reports not-found when neither had it", async () => {
    const s = setup({ fallback: true });
    await s.file.put("k", "1", new Date(0)); await s.keyring.put("k", "2", new Date(0));
    assert.deepEqual(await s.store.delete(owner, "k"), { removed: true });
    assert.equal(s.file.items.size + s.keyring.items.size, 0);
    await assert.rejects(() => s.store.delete(owner, "k"), code("not-found"));
    assert.deepEqual(actions(s.audit), ["secret.delete", "secret.delete"]);
  });
  it("delete from only the other backend still counts as removed", async () => {
    const s = setup({ fallback: true });
    await s.file.put("k", "1", new Date(0));
    assert.deepEqual(await s.store.delete(owner, "k"), { removed: true });
  });
  it("delete needs a backend and a valid name, and revokes leases on the name even when not found", async () => {
    const s = setup({ keyring: { available: false } });
    await assert.rejects(() => s.store.delete(owner, "k"), code("no-backend"));
    await assert.rejects(() => s.store.delete(owner, "a b"), code("invalid-name"));
    const s2 = setup();
    await s2.store.set(owner, "k", MARKER);
    const lease = await s2.store.lease(owner, "k", { purpose: "p", profileId: "q" });
    s2.keyring.items.delete("k");
    await assert.rejects(() => s2.store.delete(owner, "k"), code("not-found"));
    assert.throws(() => s2.store.readLease(owner, lease.leaseId), code("lease-invalid"));
  });
  it("list merges both backends sorted by name, the selected backend winning duplicates", async () => {
    const s = setup({ fallback: true });
    await s.keyring.put("b", "1", new Date(0)); await s.keyring.put("a", "1", new Date(0));
    await s.file.put("b", "2", new Date(0)); await s.file.put("c", "3", new Date(0));
    const l = await s.store.list(owner);
    assert.deepEqual(l.map((m) => [m.name, m.backend]), [["a", "keyring"], ["b", "keyring"], ["c", "file"]]);
    assert.ok(!JSON.stringify(l).includes('"value"'));
    assert.deepEqual(s.audit.events[0]!.detail, { backend: "keyring" });
  });
  it("list is empty for an empty store and needs a backend; a list failure propagates", async () => {
    const s = setup();
    assert.deepEqual(await s.store.list(owner), []);
    s.keyring.failList = true;
    await assert.rejects(() => s.store.list(owner), code("storage"));
    const s2 = setup({ keyring: { available: false } });
    await assert.rejects(() => s2.store.list(owner), code("no-backend"));
  });
  it("list sorting is locale-stable for mixed case and punctuation", async () => {
    const s = setup();
    for (const n of ["b", "A", "a", "a.b", "a-b", "10", "9"]) await s.keyring.put(n, "v", new Date(0));
    const names = (await s.store.list(owner)).map((m) => m.name);
    assert.deepEqual(names, [...names].sort((x, y) => x.localeCompare(y)));
  });
});

describe("secret store coverage: leases", () => {
  it("validates purpose and profileId (including a missing options object)", async () => {
    const s = setup();
    await s.store.set(owner, "k", MARKER);
    const bad: unknown[] = [
      undefined, {}, { purpose: "p" }, { profileId: "q" }, { purpose: "", profileId: "q" }, { purpose: "p q", profileId: "q" },
      { purpose: "-p", profileId: "q" }, { purpose: "p", profileId: "x".repeat(129) }, { purpose: "p", profileId: null },
    ];
    for (const o of bad) await assert.rejects(() => s.store.lease(owner, "k", o as never), code("invalid-value"));
    assert.deepEqual(actions(s.audit), ["secret.set"], "invalid labels are refused before the audit");
  });
  it("BUG: a non-string purpose is refused", { skip: "BUG: RegExp.test coerciert Zahlen zu Strings, purpose 5 wird akzeptiert – siehe docs/testing/coverage-2026-10.md#secrets-lease-label-coercion" }, async () => {
    const s = setup();
    await s.store.set(owner, "k", MARKER);
    await assert.rejects(() => s.store.lease(owner, "k", { purpose: 5, profileId: "q" } as never), code("invalid-value"));
  });
  it("accepts identifier-shaped labels (colon, slash, at, dot)", async () => {
    const s = setup();
    await s.store.set(owner, "k", MARKER);
    const l = await s.store.lease(owner, "k", { purpose: "chat:send/v1", profileId: "user@host.example" });
    assert.equal(l.value, MARKER);
    assert.equal(l.name, "k");
  });
  it("audits the lease with purpose, profile and ttl only when given", async () => {
    const s = setup();
    await s.store.set(owner, "k", MARKER);
    await s.store.lease(owner, "k", { purpose: "p", profileId: "q" });
    await s.store.lease(core, "k", { purpose: "p", profileId: "q", ttlMs: 1000 });
    const ev = s.audit.events.filter((e) => e.action === "secret.lease");
    assert.deepEqual(ev[0]!.detail, { purpose: "p", profileId: "q" });
    assert.deepEqual(ev[1]!.detail, { purpose: "p", profileId: "q", ttlMs: 1000 });
    assert.deepEqual(ev[1]!.principal, core);
    assert.ok(!JSON.stringify(s.audit.events).includes(MARKER));
  });
  it("ttl bounds are enforced by the lease table (1 ms..5 min, integers)", async () => {
    const s = setup();
    await s.store.set(owner, "k", MARKER);
    for (const ttlMs of [0, -1, 1.5, 300_001, Number.NaN]) await assert.rejects(() => s.store.lease(owner, "k", { purpose: "p", profileId: "q", ttlMs }), code("invalid-ttl"));
    for (const ttlMs of [1, 300_000]) assert.equal((await s.store.lease(owner, "k", { purpose: "p", profileId: "q", ttlMs })).expiresAt, s.clock() + ttlMs);
  });
  it("a missing secret is not-found; no backend is no-backend; an invalid name is invalid-name", async () => {
    const s = setup();
    await assert.rejects(() => s.store.lease(owner, "ghost", { purpose: "p", profileId: "q" }), code("not-found"));
    await assert.rejects(() => s.store.lease(owner, "a b", { purpose: "p", profileId: "q" }), code("invalid-name"));
    const s2 = setup({ keyring: { available: false } });
    await assert.rejects(() => s2.store.lease(owner, "k", { purpose: "p", profileId: "q" }), code("no-backend"));
  });
  it("a lease finds the value in the other backend", async () => {
    const s = setup({ fallback: true });
    await s.file.put("k", MARKER, new Date(0));
    assert.equal((await s.store.lease(owner, "k", { purpose: "p", profileId: "q" })).value, MARKER);
  });
  it("a failing audit blocks a lease before the value is read", async () => {
    const s = setup();
    await s.store.set(owner, "k", MARKER);
    s.audit.failNext = true;
    await assert.rejects(() => s.store.lease(owner, "k", { purpose: "p", profileId: "q" }), code("audit-unavailable"));
    assert.deepEqual(s.store.activeLeases(owner), []);
  });
  it("read/revoke/active: ids audited, expiry on the injected clock, revoke is idempotent-false", async () => {
    const s = setup();
    await s.store.set(owner, "k", MARKER);
    const l = await s.store.lease(owner, "k", { purpose: "p", profileId: "q", ttlMs: 1000 });
    assert.equal(s.store.readLease(core, l.leaseId).value, MARKER);
    const info = s.store.activeLeases(owner);
    assert.equal(info.length, 1);
    assert.ok(!("value" in info[0]!));
    s.clock.advance(1000);
    assert.throws(() => s.store.readLease(owner, l.leaseId), code("lease-invalid"));
    assert.deepEqual(s.store.activeLeases(owner), []);
    const l2 = await s.store.lease(owner, "k", { purpose: "p", profileId: "q" });
    assert.equal(s.store.revokeLease(owner, l2.leaseId), true);
    assert.equal(s.store.revokeLease(core, l2.leaseId), false);
    assert.throws(() => s.store.readLease(owner, l2.leaseId), code("lease-invalid"));
    assert.deepEqual(s.audit.events.filter((e) => e.action === "secret.lease.read").map((e) => e.detail), [{ leaseId: l.leaseId }, { leaseId: l.leaseId }, { leaseId: l2.leaseId }]);
    assert.deepEqual(s.audit.events.filter((e) => e.action === "secret.lease.revoke").map((e) => e.target), [null, null]);
  });
  it("a failing audit blocks reading and revoking a lease", async () => {
    const s = setup();
    await s.store.set(owner, "k", MARKER);
    const l = await s.store.lease(owner, "k", { purpose: "p", profileId: "q" });
    s.audit.failNext = true;
    assert.throws(() => s.store.readLease(owner, l.leaseId), code("audit-unavailable"));
    s.audit.failNext = true;
    assert.throws(() => s.store.revokeLease(owner, l.leaseId), code("audit-unavailable"));
    assert.equal(s.store.activeLeases(owner).length, 1, "still live");
  });
  it("rotating a secret revokes its leases but not others'", async () => {
    const s = setup();
    await s.store.set(owner, "a", "1"); await s.store.set(owner, "b", "2");
    const la = await s.store.lease(owner, "a", { purpose: "p", profileId: "q" });
    const lb = await s.store.lease(owner, "b", { purpose: "p", profileId: "q" });
    await s.store.set(owner, "a", "3");
    assert.throws(() => s.store.readLease(owner, la.leaseId), code("lease-invalid"));
    assert.equal(s.store.readLease(owner, lb.leaseId).value, "2");
  });
  it("lease expiry works with the default clock too", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const s = setup({ noClock: true });
    await s.store.set(owner, "k", MARKER);
    const l = await s.store.lease(owner, "k", { purpose: "p", profileId: "q", ttlMs: 10 });
    t.mock.timers.setTime(1_000_009);
    assert.equal(s.store.readLease(owner, l.leaseId).value, MARKER);
    t.mock.timers.setTime(1_000_010);
    assert.throws(() => s.store.readLease(owner, l.leaseId), code("lease-invalid"));
  });
});

describe("secret store coverage: audit action vocabulary", () => {
  it("covers each audit action exactly once per operation type", async () => {
    const s = setup();
    await s.store.set(owner, "k", "v");
    await s.store.meta(owner, "k");
    await s.store.reveal(owner, "k");
    await s.store.list(owner);
    const l = await s.store.lease(owner, "k", { purpose: "p", profileId: "q" });
    s.store.readLease(owner, l.leaseId);
    s.store.revokeLease(owner, l.leaseId);
    await s.store.delete(owner, "k");
    await assert.rejects(() => s.store.reveal(agent, "k"));
    const want: AuditAction[] = ["secret.set", "secret.get", "secret.reveal", "secret.list", "secret.lease", "secret.lease.read", "secret.lease.revoke", "secret.delete", "secret.denied"];
    assert.deepEqual(actions(s.audit), want);
  });
});
