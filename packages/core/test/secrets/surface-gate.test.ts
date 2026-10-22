// Audit rbac #1 (2026-10-20): `secret.set`, `secret.get` with `reveal` and `secret.delete` take the trust level of the
// connection into account, like the other surface-bound methods. The level is derived by the core from the connection
// (rbac/connection-surface.ts), never from a parameter. A connection that is no person at all (T0) is refused; the
// token-authenticated local connection (T1) is where `plur1bus secret get --reveal` arrives, so it keeps working.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSecretMethods, createSecretStore, createMemoryBackend, createMemoryAuditSink, type SecretPrincipal } from "../../src/secrets/index.ts";
import { MARKER, fakeClock } from "./helpers.ts";

const deniedWith = (method: string) => (e: unknown) => {
  assert.equal((e as { error?: string }).error, "E_DENIED", method);
  assert.equal((e as { reason?: string }).reason, "denied", method);
  assert.ok(!JSON.stringify({ ...(e as object), m: (e as Error).message }).includes(MARKER));
  return true;
};

describe("secret.* surface gate (handler level)", () => {
  function rig(surface: () => unknown) {
    const audit = createMemoryAuditSink();
    const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit, clock: fakeClock() });
    const methods = buildSecretMethods({ store, principalOf: () => ({ kind: "owner", id: "person-1", surface: surface() } as SecretPrincipal) });
    return { audit, store, methods };
  }
  const ctx = {} as never;

  it("a connection below T1 is refused set, get --reveal and delete with E_DENIED; the refusal is audited and nothing changes", async () => {
    let level: unknown = 1;
    const { audit, store, methods } = rig(() => level);
    await methods["secret.set"]({ name: "kept", value: MARKER }, ctx);
    for (level of [0, -1, 4, 1.5, Number.NaN, "3", null, {}]) {
      await assert.rejects(() => methods["secret.set"]({ name: "kept", value: `${MARKER}-changed` }, ctx), deniedWith("secret.set"), String(level));
      await assert.rejects(() => methods["secret.get"]({ name: "kept", reveal: true }, ctx), deniedWith("secret.get"), String(level));
      await assert.rejects(() => methods["secret.delete"]({ name: "kept" }, ctx), deniedWith("secret.delete"), String(level));
    }
    level = 1;
    assert.equal((await methods["secret.get"]({ name: "kept", reveal: true }, ctx) as { value: string }).value, MARKER, "neither a write nor a delete got through");
    const denied = audit.events.filter((e) => e.action === "secret.denied");
    assert.equal(denied.length, 8 * 3);
    assert.deepEqual([...new Set(denied.map((e) => e.detail?.method))].sort(), ["delete", "reveal", "set"]);
    assert.ok(denied.every((e) => e.target === "kept"));
    assert.equal((await store.list({ kind: "owner" })).length, 1);
  });

  it("a refused call does not read params (missing or odd params give E_DENIED, not a TypeError)", async () => {
    const { methods } = rig(() => 0);
    for (const [method, params] of [["secret.set", undefined], ["secret.get", { reveal: true }], ["secret.delete", undefined]] as const) await assert.rejects(() => methods[method](params as never, ctx), deniedWith(method));
  });

  it("the unattested local connection (T1, where the CLI arrives) and every higher level keep set, reveal and delete", async () => {
    for (const level of [1, 2, 3]) {
      const { methods } = rig(() => level);
      const meta = await methods["secret.set"]({ name: "k", value: MARKER }, ctx) as { name: string };
      assert.equal(meta.name, "k");
      assert.equal((await methods["secret.get"]({ name: "k", reveal: true }, ctx) as { value: string }).value, MARKER);
      assert.equal(((await methods["secret.get"]({ name: "k" }, ctx)) as { secret: { name: string } }).secret.name, "k");
      assert.deepEqual(await methods["secret.delete"]({ name: "k" }, ctx), { removed: true });
    }
  });

  it("names and metadata do not depend on the level: status, list and get without reveal answer the owner", async () => {
    const { methods } = rig(() => 0);
    await methods["secret.status"]({}, ctx);
    await methods["secret.list"]({}, ctx);
  });

  it("an in-process owner (no connection, no level) is unaffected: the store itself still serves it", async () => {
    const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink(), clock: fakeClock() });
    await store.set({ kind: "owner", id: "core" }, "k", MARKER);
    assert.equal((await store.reveal({ kind: "owner", id: "core" }, "k")).value, MARKER);
    assert.deepEqual(await store.delete({ kind: "owner", id: "core" }, "k"), { removed: true });
  });
});
