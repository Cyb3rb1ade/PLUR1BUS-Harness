import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RpcCallError } from "@plur1bus/module-api";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createBridgeSecretStore, REOPEN_AFTER_MS } from "../../src/secrets/bridge-store.ts";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { SecretError, type SecretPrincipal } from "../../src/secrets/types.ts";

// The legacy core's secret store as a client of the bridge (P4-20 flip B1). The front door is a function here; its real
// side is tested in crates/plur1bus-core (bridge.rs, tests/front_door.rs) and both together in tests/core-parity.

const VALUE = "a value in plain words for the bridge store";
const OWNER: SecretPrincipal = { kind: "owner", id: "user-1", surface: 1 };
const CORE: SecretPrincipal = { kind: "core" };
const READY = { state: "ready", safeToFlush: true } as const;
const quiet = { startup: READY, revoked: { all: false, names: [] as string[] } };
const META = { name: "api.key", backend: "keyring", createdAt: "2026-11-15T10:00:00.000Z", updatedAt: "2026-11-15T10:00:00.000Z" } as const;

type Call = { method: string; params: any };
/** A front door: `answer` gets every call and returns its result or throws; `calls` records them. A connection opens
 *  with the preload: that first call is kept in `openings` (its params), answered by `answer` when it has an answer
 *  with effects for it and with quiet effects otherwise, so that `calls` is what a test did on an open store. */
function frontDoor(answer: (c: Call) => unknown) {
  const calls: Call[] = [], openings: unknown[] = [], closers: (() => void)[] = [];
  let opened = 0, closed = 0;
  const open = async () => {
    opened++;
    let first = true;
    return {
      async call<T>(method: string, params: object = {}): Promise<T> {
        if (first) {
          first = false;
          assert.equal(method, "bridge.secret.preload", "a connection opens with the preload");
          openings.push(params);
          const own = answer({ method, params }) as { effects?: unknown } | undefined;
          return (own?.effects ? own : { effects: quiet }) as T;
        }
        calls.push({ method, params });
        return answer({ method, params }) as T;
      },
      onClose(h: () => void) { closers.push(h); return () => {}; },
      async close() { closed++; },
    };
  };
  return { open, calls, openings, drop: () => { for (const h of closers.splice(0)) h(); }, get opened() { return opened; }, get closed() { return closed; } };
}
function storeOver(fd: ReturnType<typeof frontDoor>, now = () => 1_767_323_045_678) {
  const redaction = createSecretRedaction(), audit = createMemoryAuditSink();
  const store = createBridgeSecretStore({ open: fd.open, service: "plur1bus:test", redaction, audit, clock: now });
  return { store, redaction, audit };
}
const lease = (id: string, name = "api.key", expiresAt = 1_767_323_045_678 + 5000) => ({ leaseId: id, name, value: VALUE, expiresAt, purpose: "web-search", profileId: "web-search" });
const refused = (code: string, error: string, message: string) => new RpcCallError(error === "E_INVALID_PARAMS" ? -32602 : -32000, error, message, code);

describe("bridge secret store", () => {
  it("every operation is one call that names its principal, and the answer is the store's", async () => {
    const fd = frontDoor(({ method }) => ({
      "bridge.secret.preload": { effects: { ...quiet, preloaded: ["a value of the snapshot"] } },
      "bridge.secret.status": { status: { backend: "keyring", degraded: false, keyring: { available: true }, file: { enabled: false, available: null }, count: 1, activeLeases: 0 }, effects: quiet },
      "bridge.secret.list": { secrets: [META], effects: quiet },
      "bridge.secret.set": { secret: META, effects: { ...quiet, revoked: { all: false, names: ["api.key"] } } },
      "bridge.secret.describe": { secret: { ...META, description: "what it is for" }, effects: quiet },
      "bridge.secret.meta": { secret: META, effects: quiet },
      "bridge.secret.reveal": { secret: META, value: VALUE, effects: quiet },
      "bridge.secret.delete": { removed: true, effects: { ...quiet, revoked: { all: false, names: ["api.key"] } } },
    })[method]);
    const { store, redaction } = storeOver(fd);
    assert.deepEqual(store.startupStatus(), { state: "idle", safeToFlush: false });
    await store.preloadRedaction();
    assert.deepEqual(store.startupStatus(), READY);
    assert.ok(redaction.contains("x a value of the snapshot x"), "the snapshot is registered");
    assert.equal((await store.status(CORE)).backend, "keyring");
    assert.deepEqual(await store.list(OWNER), [META]);
    assert.deepEqual(await store.set(OWNER, "api.key", VALUE, "what it is for"), META);
    assert.equal((await store.describe(OWNER, "api.key", "what it is for")).description, "what it is for");
    assert.deepEqual(await store.meta({ kind: "owner" }, "api.key"), META);
    assert.deepEqual(await store.reveal(OWNER, "api.key"), { meta: META, value: VALUE });
    assert.deepEqual(await store.delete(OWNER, "api.key"), { removed: true });
    // The preload was the connection's opening; nothing was asked twice.
    assert.deepEqual(fd.openings, [{ service: "plur1bus:test" }]);
    assert.deepEqual(fd.calls, [
      { method: "bridge.secret.status", params: { principal: { kind: "core" } } },
      { method: "bridge.secret.list", params: { principal: { kind: "owner", id: "user-1", surface: 1 } } },
      { method: "bridge.secret.set", params: { principal: { kind: "owner", id: "user-1", surface: 1 }, name: "api.key", value: VALUE, description: "what it is for" } },
      { method: "bridge.secret.describe", params: { principal: { kind: "owner", id: "user-1", surface: 1 }, name: "api.key", description: "what it is for" } },
      { method: "bridge.secret.meta", params: { principal: { kind: "owner" }, name: "api.key" } },
      { method: "bridge.secret.reveal", params: { principal: { kind: "owner", id: "user-1", surface: 1 }, name: "api.key" } },
      { method: "bridge.secret.delete", params: { principal: { kind: "owner", id: "user-1", surface: 1 }, name: "api.key" } },
    ]);
    assert.equal(fd.opened, 1, "one connection for all of it");
    assert.ok(redaction.contains(VALUE), "a value that came back is masked from then on");
    await store.close();
    assert.equal(fd.closed, 1);
    assert.equal(store.startupStatus().state, "closed");
    await assert.rejects(() => store.list(OWNER), (e) => e instanceof SecretError && e.code === "backend-unavailable");
  });

  it("a connection opens with the preload; a front door that refuses it is no store, and nothing else is asked", async () => {
    let refuse = true;
    const fd = frontDoor(({ method }) => {
      if (method === "bridge.secret.preload" && refuse) throw refused("storage", "E_STORAGE", "the legacy core and the front door do not name the same secret store");
      return method === "bridge.secret.preload" ? { effects: { ...quiet, preloaded: ["a value of the later snapshot"] } } : { secrets: [], effects: quiet };
    });
    let now = 1_767_323_045_678;
    const { store, redaction } = storeOver(fd, () => now);
    await store.preloadRedaction();
    assert.deepEqual(store.startupStatus(), { state: "unavailable", reason: "backend-unavailable", safeToFlush: false });
    const same = (e: unknown) => e instanceof SecretError && e.code === "storage" && e.message === "the legacy core and the front door do not name the same secret store";
    // A bridge that could not be opened is left alone for a moment: every call in that time fails as the opening did,
    // without another attempt.
    await assert.rejects(() => store.list(OWNER), same);
    now += REOPEN_AFTER_MS - 1;
    await assert.rejects(() => store.reveal(OWNER, "api.key"), same);
    assert.equal(fd.opened, 1);
    for (const op of [() => store.list(OWNER), () => store.reveal(OWNER, "api.key"), () => store.lease(CORE, "api.key", { purpose: "p", profileId: "p" })]) {
      now += REOPEN_AFTER_MS;
      await assert.rejects(op, same);
    }
    assert.deepEqual(fd.calls, [], "no call of the store went out");
    assert.equal(fd.opened, 4);
    assert.equal(fd.closed, 4, "a connection that could not be opened is closed again");
    assert.deepEqual(fd.openings, Array(4).fill({ service: "plur1bus:test" }));
    // Once the front door answers, the next call opens the store, and a preload that is asked for again is the opening.
    refuse = false;
    now += REOPEN_AFTER_MS;
    await store.preloadRedaction();
    assert.deepEqual(store.startupStatus(), READY);
    assert.ok(redaction.contains("x a value of the later snapshot x"));
    assert.equal(fd.opened, 5);
    assert.deepEqual(fd.calls, []);
    assert.deepEqual(await store.list(OWNER), []);
    assert.equal(fd.opened, 5);
  });

  it("a value that is revealed is masked from then on, also when this process never set it", async () => {
    const fd = frontDoor(() => ({ secret: META, value: VALUE, effects: quiet }));
    const { store, redaction } = storeOver(fd);
    assert.equal(redaction.contains(VALUE), false);
    assert.deepEqual(await store.reveal(OWNER, "api.key"), { meta: META, value: VALUE });
    assert.ok(redaction.contains(`x ${VALUE} y`));
  });

  it("a principal travels as one of the store's three kinds; anything else is an agent, a surface that is none is the lowest", async () => {
    const fd = frontDoor(() => ({ secrets: [], effects: quiet }));
    const { store } = storeOver(fd);
    const odd: unknown[] = [{ kind: "owner" }, { kind: "owner", id: 7, surface: 3 }, { kind: "owner", surface: Number.NaN }, { kind: "owner", surface: "1" }, { kind: "owner", surface: null },
      { kind: "agent", agentId: "scout" }, { kind: "agent", agentId: 7, id: "user-1" }, { kind: "admin", id: "user-1" }, {}, null, "core"];
    for (const p of odd) await store.list(p as SecretPrincipal);
    assert.deepEqual(fd.calls.map((c) => c.params.principal), [{ kind: "owner" }, { kind: "owner", surface: 3 }, { kind: "owner", surface: 0 }, { kind: "owner", surface: 0 }, { kind: "owner", surface: 0 },
      { kind: "agent", agentId: "scout" }, { kind: "agent" }, { kind: "agent" }, { kind: "agent" }, { kind: "agent" }, { kind: "agent" }]);
  });

  it("a string the bridge cannot carry travels with U+FFFD in place of a lone surrogate; the registry keeps what was given", async () => {
    const fd = frontDoor(({ method }) => (method === "bridge.secret.set" ? { secret: META, effects: quiet } : { lease: lease("L1"), effects: quiet }));
    const { store, redaction } = storeOver(fd);
    const lone = "a value with \ud83d half a pair and \udc00 another half";
    await store.set({ kind: "owner", id: "u\ud800" }, "api.key", lone, "said \udfff so");
    await store.lease({ kind: "agent", agentId: "\udbffx" } as SecretPrincipal, "api.key", { purpose: "p\ud800", profileId: "q" });
    // A pair stays a pair.
    await store.set(OWNER, "api.key", "a whole pair \ud83d\ude00 here");
    assert.deepEqual(fd.calls.map((c) => c.params), [
      { principal: { kind: "owner", id: "u\ufffd" }, name: "api.key", value: "a value with \ufffd half a pair and \ufffd another half", description: "said \ufffd so" },
      { principal: { kind: "agent", agentId: "\ufffdx" }, name: "api.key", purpose: "p\ufffd", profileId: "q" },
      { principal: { kind: "owner", id: "user-1", surface: 1 }, name: "api.key", value: "a whole pair \ud83d\ude00 here" },
    ]);
    // Every frame is one the front door's reader takes: no escape of half a pair is left in it.
    for (const c of fd.calls) assert.doesNotMatch(JSON.stringify(c.params), /\\ud[89a-f]/i);
    assert.ok(redaction.contains(`x ${lone} y`), "the value is masked as it was given");
  });

  it("a lease is issued by the front door and held here: read, revoked and counted without a call", async () => {
    let n = 0;
    const fd = frontDoor(({ method }) => method === "bridge.secret.lease" ? { lease: lease(`lse_${++n}`), effects: quiet }
      : { status: { backend: "keyring", degraded: false, keyring: { available: true }, file: { enabled: false, available: null }, count: 1, activeLeases: 0 }, effects: quiet });
    let now = 1_767_323_045_678;
    const { store, audit, redaction } = storeOver(fd, () => now);
    const first = await store.lease(CORE, "api.key", { purpose: "web-search", profileId: "web-search", ttlMs: 5000 });
    assert.equal(first.value, VALUE);
    assert.equal(first.leaseId, "lse_1");
    assert.ok(Object.isFrozen(first) && !JSON.stringify(first).includes(VALUE), "presented as the store presents a lease");
    assert.ok(redaction.contains(VALUE));
    assert.deepEqual(fd.calls[0], { method: "bridge.secret.lease", params: { principal: { kind: "core" }, name: "api.key", purpose: "web-search", profileId: "web-search", ttlMs: 5000 } });
    await store.lease(CORE, "api.key", { purpose: "web-search", profileId: "web-search" });
    assert.equal("ttlMs" in fd.calls[1]!.params, false, "no lifetime is the store's default, not a number");
    const calls = fd.calls.length;
    assert.equal(store.readLease(CORE, "lse_1").value, VALUE);
    assert.equal(store.activeLeases(CORE).length, 2);
    assert.equal(store.revokeLease(CORE, "lse_1"), true);
    assert.equal(store.revokeLease(CORE, "lse_1"), false);
    assert.throws(() => store.readLease(CORE, "lse_1"), (e) => e instanceof SecretError && e.code === "lease-invalid");
    assert.equal(fd.calls.length, calls, "none of it asked the front door");
    // The records of what happened here are written here, with the id the front door gave.
    assert.deepEqual(audit.events.map((e) => [e.action, e.target, e.detail]), [
      ["secret.lease.read", null, { leaseId: "lse_1" }], ["secret.lease.revoke", null, { leaseId: "lse_1" }],
      ["secret.lease.revoke", null, { leaseId: "lse_1" }], ["secret.lease.read", null, { leaseId: "lse_1" }]]);
    // The status counts what is held here on top of what the front door counts.
    assert.equal((await store.status(CORE)).activeLeases, 1);
    // A lease ends at the time the front door gave it.
    now += 5000;
    assert.throws(() => store.readLease(CORE, "lse_2"), (e) => e instanceof SecretError && e.code === "lease-invalid");
    assert.equal(store.activeLeases(CORE).length, 0);
    // A lifetime JSON cannot carry is sent as one the store refuses.
    await store.lease(CORE, "api.key", { purpose: "web-search", profileId: "web-search", ttlMs: Number.NaN });
    assert.equal(fd.calls.at(-1)!.params.ttlMs, -1);
    // An agent has none of the three, and the refusal is recorded here.
    for (const op of [() => store.readLease({ kind: "agent" }, "lse_3"), () => store.revokeLease({ kind: "agent" }, "lse_3"), () => store.activeLeases({ kind: "agent" })]) {
      assert.throws(op, (e) => e instanceof SecretError && e.code === "denied");
    }
    assert.deepEqual(audit.events.slice(-3).map((e) => [e.action, e.detail]), [["secret.denied", { method: "lease.read" }], ["secret.denied", { method: "lease.revoke" }], ["secret.denied", { method: "lease.list" }]]);
  });

  it("the effects of an answer are applied before the call returns", async () => {
    let n = 0, effects: any = quiet;
    const fd = frontDoor(({ method }) => method === "bridge.secret.lease" ? { lease: lease(`lse_${++n}`, n === 2 ? "other.key" : "api.key"), effects: quiet } : { secrets: [], effects });
    const { store, redaction } = storeOver(fd);
    const held = async () => { n = 0; for (const name of ["api.key", "other.key"]) await store.lease(CORE, name, { purpose: "p", profileId: "p" }); };
    await held();
    // A name: its leases are void, the others stay.
    effects = { ...quiet, revoked: { all: false, names: ["api.key"] } };
    await store.list(OWNER);
    assert.deepEqual(store.activeLeases(CORE).map((l) => l.name), ["other.key"]);
    // Everything: none stays, and the state says why.
    await held();
    effects = { startup: { state: "unavailable", reason: "backend-unavailable", safeToFlush: false }, revoked: { all: true, names: [] } };
    await store.list(OWNER);
    assert.deepEqual(store.activeLeases(CORE), []);
    assert.deepEqual(store.startupStatus(), { state: "unavailable", reason: "backend-unavailable", safeToFlush: false });
    assert.throws(() => store.readLease(CORE, "lse_1"), (e) => e instanceof SecretError && e.code === "backend-unavailable");
    effects = { startup: { state: "unavailable", reason: "no-backend", safeToFlush: true }, revoked: { all: false, names: [] } };
    await store.list(OWNER);
    assert.throws(() => store.readLease(CORE, "lse_1"), (e) => e instanceof SecretError && e.code === "no-backend");
    // A snapshot replaces the one before it.
    effects = { ...quiet, preloaded: ["the first snapshot value"] };
    await store.list(OWNER);
    effects = { ...quiet, preloaded: ["the second snapshot value"] };
    await store.list(OWNER);
    assert.ok(redaction.contains("the second snapshot value"));
    assert.ok(redaction.contains("the first snapshot value"), "a value that left the snapshot stays masked among the retired ones");
  });

  it("a refusal of the store comes back as the store's error, after the effects were asked for", async () => {
    const fd = frontDoor(({ method }) => {
      if (method === "bridge.secret.reveal") throw refused("denied", "E_DENIED", "secret operations are available to the owner only");
      if (method === "bridge.secret.meta") throw refused("not-found", "E_NOT_FOUND", "no secret named never.there");
      if (method === "bridge.secret.delete") throw refused("storage", "E_STORAGE", "secret storage failed");
      if (method === "bridge.secret.lease") return { lease: lease("lse_1"), effects: quiet };
      return { effects: { ...quiet, revoked: { all: false, names: ["api.key"] }, preloaded: [] } };
    });
    const { store } = storeOver(fd);
    await store.lease(CORE, "api.key", { purpose: "p", profileId: "p" });
    await assert.rejects(() => store.reveal({ kind: "agent" }, "api.key"), (e) => e instanceof SecretError && e.code === "denied" && e.message === "secret operations are available to the owner only");
    assert.deepEqual(fd.calls.slice(-2).map((c) => c.method), ["bridge.secret.reveal", "bridge.secret.preload"]);
    assert.deepEqual(store.activeLeases(CORE), [], "what the failed call voided is void before the error is thrown");
    await assert.rejects(() => store.meta(OWNER, "never.there"), (e) => e instanceof SecretError && e.code === "not-found" && e.message === "no secret named never.there");
    await assert.rejects(() => store.delete(OWNER, "api.key"), (e) => e instanceof SecretError && e.code === "storage");
    assert.equal(fd.opened, 1, "a refusal is no lost bridge");
  });

  it("a bridge that is gone or does not answer is a store that is not available, and every lease held here is void", async () => {
    let mode: "ok" | "timeout" | "odd" = "ok";
    const fd = frontDoor(({ method }) => {
      if (mode === "timeout") throw new RpcCallError(-32000, "E_CORE_UNAVAILABLE", `${method} timed out`, "call-timeout");
      if (mode === "odd") throw new RpcCallError(-32602, "E_INVALID_PARAMS", "invalid params");
      return method === "bridge.secret.lease" ? { lease: lease("lse_1"), effects: quiet } : { secrets: [], effects: quiet };
    });
    const { store } = storeOver(fd);
    for (const failure of ["timeout", "odd"] as const) {
      mode = "ok";
      await store.lease(CORE, "api.key", { purpose: "p", profileId: "p" });
      mode = failure;
      const closedBefore = fd.closed;
      await assert.rejects(() => store.list(OWNER), (e) => e instanceof SecretError && e.code === "backend-unavailable" && e.message === "Secret-Store unavailable");
      assert.deepEqual(store.activeLeases(CORE), [], failure);
      assert.deepEqual(store.startupStatus(), { state: "unavailable", reason: "backend-unavailable", safeToFlush: false });
      // The connection is given up for good: the front door must not go on serving what was queued on it.
      await new Promise((r) => setImmediate(r));
      assert.equal(fd.closed, closedBefore + 1, failure);
    }
    // The next call opens the bridge again, and its answer says how the store is.
    mode = "ok";
    const opened = fd.opened;
    assert.deepEqual(await store.list(OWNER), []);
    assert.equal(fd.opened, opened + 1);
    assert.deepEqual(store.startupStatus(), READY);
    // A connection the front door drops: the same, without a call.
    await store.lease(CORE, "api.key", { purpose: "p", profileId: "p" });
    fd.drop();
    assert.deepEqual(store.activeLeases(CORE), []);
    assert.equal(store.startupStatus().state, "unavailable");
    // Two calls on one connection that both fail: the second failure arrives when a new connection is in use, and
    // takes nothing with it.
    {
      const gates: Array<() => void> = [];
      let hang = false;
      const slow = frontDoor(({ method }) => {
        if (method === "bridge.secret.lease") return { lease: lease("lse_9"), effects: quiet };
        if (hang) return new Promise((_, reject) => { gates.push(() => reject(new RpcCallError(-32000, "E_CORE_UNAVAILABLE", "timed out", "call-timeout"))); });
        return { secrets: [], effects: quiet };
      });
      const { store: s } = storeOver(slow);
      await s.list(OWNER);
      hang = true;
      const first = s.list(OWNER), second = s.list(OWNER);
      await new Promise((r) => setImmediate(r));
      assert.equal(gates.length, 2);
      gates[0]!();
      await assert.rejects(first, (e) => e instanceof SecretError && e.code === "backend-unavailable");
      hang = false;
      await s.lease(CORE, "api.key", { purpose: "p", profileId: "p" });
      assert.equal(slow.opened, 2);
      gates[1]!();
      await assert.rejects(second, (e) => e instanceof SecretError && e.code === "backend-unavailable");
      assert.equal(s.activeLeases(CORE).length, 1, "the lease of the new connection stands");
      assert.deepEqual(s.startupStatus(), READY);
      assert.deepEqual(await s.list(OWNER), []);
      assert.equal(slow.opened, 2);
    }
    // A bridge that cannot be opened at all.
    const none = createBridgeSecretStore({ open: async () => { throw new Error("no bridge"); }, service: "s", redaction: createSecretRedaction(), audit: createMemoryAuditSink() });
    await assert.rejects(() => none.status(CORE), (e) => e instanceof SecretError && e.code === "backend-unavailable");
    await none.preloadRedaction();
    assert.deepEqual(none.startupStatus(), { state: "unavailable", reason: "backend-unavailable", safeToFlush: false });
  });

  it("a set registers its value and tells the listeners once it is committed; a refused caller's value is not registered", async () => {
    let fail: string | null = null;
    const fd = frontDoor(({ method }) => {
      if (method === "bridge.secret.preload") return { effects: { ...quiet, preloaded: [] } };
      if (fail) throw refused(fail, fail === "denied" ? "E_DENIED" : fail.startsWith("invalid") ? "E_INVALID_PARAMS" : "E_STORAGE", "refused");
      return method === "bridge.secret.delete" ? { removed: true, effects: quiet } : { secret: META, effects: quiet };
    });
    const { store, redaction } = storeOver(fd);
    const heard: string[] = [];
    const off = store.onChange((name) => { heard.push(name); });
    store.onChange(() => { throw new Error("a listener that fails"); });
    await store.set(OWNER, "api.key", VALUE);
    await store.delete(OWNER, "api.key");
    await store.describe(OWNER, "api.key", "a description is no change of the value");
    assert.deepEqual(heard, ["api.key", "api.key"]);
    assert.ok(redaction.contains(VALUE));
    // Refused before the store accepted the value: not registered, nobody told.
    for (const code of ["denied", "invalid-name", "invalid-value", "invalid-description"]) {
      fail = code;
      const value = `a value refused as ${code}, in plain words`;
      await assert.rejects(() => store.set({ kind: "agent" }, "api.key", value), (e) => e instanceof SecretError && e.code === code);
      assert.equal(redaction.contains(value), false, code);
    }
    // Accepted and then not written: masked all the same, as the store masks it; nobody is told of a change.
    for (const code of ["audit-unavailable", "storage", "backend-unavailable"]) {
      fail = code;
      const value = `a value that failed as ${code}, in plain words`;
      await assert.rejects(() => store.set(OWNER, "api.key", value), (e) => e instanceof SecretError && e.code === code);
      assert.ok(redaction.contains(value), code);
    }
    assert.deepEqual(heard, ["api.key", "api.key"]);
    off();
    fail = null;
    await store.set(OWNER, "api.key", VALUE);
    assert.deepEqual(heard, ["api.key", "api.key"], "a listener that left hears nothing");
  });
});
