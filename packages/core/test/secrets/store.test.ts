import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createFileBackend } from "../../src/secrets/file-backend.ts";
import { createKeyringBackend } from "../../src/secrets/keyring-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { SecretError, type SecretPrincipal } from "../../src/secrets/types.ts";
import { MARKER, fakeClock, fakeKeyring, secure } from "./helpers.ts";

const owner: SecretPrincipal = { kind: "owner", id: "tester" };
const core: SecretPrincipal = { kind: "core" };
const agent: SecretPrincipal = { kind: "agent", agentId: "a1" };
const code = (c: string) => (e: unknown) => { assert.ok(e instanceof SecretError, String(e)); assert.equal(e.code, c); return true; };

function setup(o: { fallback?: boolean; keyringDown?: boolean } = {}) {
  const kr = fakeKeyring(); kr.down = o.keyringDown ?? false;
  const dir = join(tempDir("p1b-sec-"), "secrets");
  const clock = fakeClock();
  const audit = createMemoryAuditSink();
  const flag = { on: o.fallback ?? false };
  const keyring = createKeyringBackend({ service: "plur1bus:test", load: async () => kr });
  const file = createFileBackend({ dir, secure });
  const store = createSecretStore({ keyring, file, fileFallback: () => flag.on, audit, clock });
  return { kr, flag, store, audit, clock, keyring, file };
}

describe("secret store selection", () => {
  it("uses the keyring when it is available", async () => {
    const { store, kr } = setup({ fallback: true });
    const m = await store.set(owner, "k", MARKER);
    assert.equal(m.backend, "keyring");
    assert.ok([...kr.items.values()].includes(MARKER));
    const st = await store.status(owner);
    assert.deepEqual([st.backend, st.degraded, st.keyring.available, st.file.enabled, st.count], ["keyring", false, true, true, 1]);
  });
  it("falls back to the file when the keyring is down and the flag is on, and says so", async () => {
    const { store } = setup({ fallback: true, keyringDown: true });
    assert.equal((await store.set(owner, "k", MARKER)).backend, "file");
    const st = await store.status(owner);
    assert.deepEqual([st.backend, st.degraded, st.keyring.available, st.keyring.reason, st.file.available], ["file", true, false, "keyring-error", true]);
  });
  it("without the flag and without a keyring there is no backend, with the remedy", async () => {
    const { store } = setup({ fallback: false, keyringDown: true });
    const st = await store.status(owner);
    assert.deepEqual([st.backend, st.degraded, st.count, st.file.enabled], ["none", true, null, false]);
    assert.match(st.remedy ?? "", /secrets\.fileFallback\.enabled/);
    for (const op of [() => store.set(owner, "k", "v"), () => store.reveal(owner, "k"), () => store.list(owner), () => store.delete(owner, "k")]) await assert.rejects(op, code("no-backend"));
  });
  it("a keyring that appears later does not hide file entries; delete clears both", async () => {
    const { store, kr, flag } = setup({ fallback: true, keyringDown: true });
    await store.set(owner, "k", MARKER);
    kr.down = false;
    assert.equal((await store.status(owner)).backend, "keyring");
    assert.equal((await store.reveal(owner, "k")).value, MARKER);
    assert.deepEqual((await store.list(owner)).map((m) => [m.name, m.backend]), [["k", "file"]]);
    await store.delete(owner, "k");
    await assert.rejects(() => store.reveal(owner, "k"), code("not-found"));
    flag.on = false;
    assert.equal((await store.status(owner)).backend, "keyring");
  });
  it("turning the flag off hides the file store (fails closed to none)", async () => {
    const { store, flag } = setup({ fallback: true, keyringDown: true });
    await store.set(owner, "k", MARKER);
    flag.on = false;
    await assert.rejects(() => store.reveal(owner, "k"), code("no-backend"));
  });
});

describe("secret store operations", () => {
  it("set, meta, reveal, list, delete", async () => {
    const { store, clock } = setup();
    await store.set(owner, "b", MARKER); clock.advance(5000); await store.set(owner, "a", `${MARKER}2`);
    assert.deepEqual((await store.list(owner)).map((m) => m.name), ["a", "b"]);
    const m = await store.meta(owner, "b");
    assert.ok(!JSON.stringify(m).includes(MARKER));
    assert.equal((await store.reveal(owner, "a")).value, `${MARKER}2`);
    assert.deepEqual(await store.delete(owner, "a"), { removed: true });
    await assert.rejects(() => store.delete(owner, "a"), code("not-found"));
    await assert.rejects(() => store.meta(owner, "a"), code("not-found"));
  });
  it("validates names and values", async () => {
    const { store } = setup();
    for (const n of ["", " x", "a b", "../x", "x".repeat(129), "é"]) await assert.rejects(() => store.set(owner, n, "v"), code("invalid-name"));
    for (const v of ["", "a\u0000b", "x".repeat(64 * 1024 + 1)]) await assert.rejects(() => store.set(owner, "k", v), code("invalid-value"));
    await assert.rejects(() => store.set(owner, "k", 5 as never), code("invalid-value"));
  });
  it("rotating or deleting revokes the leases on that name", async () => {
    const { store } = setup();
    await store.set(owner, "k", "v1");
    const l1 = await store.lease(core, "k", { purpose: "embedding", profileId: "p" });
    await store.set(owner, "k", "v2");
    assert.throws(() => store.readLease(core, l1.leaseId), code("lease-invalid"));
    const l2 = await store.lease(core, "k", { purpose: "embedding", profileId: "p" });
    assert.equal(l2.value, "v2");
    await store.delete(owner, "k");
    assert.throws(() => store.readLease(core, l2.leaseId), code("lease-invalid"));
  });
  it("leases expire on the clock and can be revoked", async () => {
    const { store, clock } = setup();
    await store.set(owner, "k", MARKER);
    const l = await store.lease(core, "k", { purpose: "embedding", profileId: "p", ttlMs: 2000 });
    assert.equal((await store.status(owner)).activeLeases, 1);
    clock.advance(1999); assert.equal(store.readLease(core, l.leaseId).value, MARKER);
    clock.advance(1); assert.throws(() => store.readLease(core, l.leaseId), code("lease-invalid"));
    const l2 = await store.lease(core, "k", { purpose: "embedding", profileId: "p" });
    assert.equal(store.revokeLease(owner, l2.leaseId), true);
    assert.throws(() => store.readLease(core, l2.leaseId), code("lease-invalid"));
    await assert.rejects(() => store.lease(core, "missing", { purpose: "x", profileId: "y" }), code("not-found"));
    await assert.rejects(() => store.lease(core, "k", { purpose: "has space", profileId: "y" }), code("invalid-value"));
  });
});

describe("secret store principals and audit", () => {
  it("refuses agent and unknown principals everywhere, and audits the refusal", async () => {
    const { store, audit } = setup();
    await store.set(owner, "k", MARKER);
    const calls: [string, (p: SecretPrincipal) => unknown][] = [
      ["status", (p) => store.status(p)], ["set", (p) => store.set(p, "k", "x")], ["meta", (p) => store.meta(p, "k")], ["reveal", (p) => store.reveal(p, "k")],
      ["delete", (p) => store.delete(p, "k")], ["list", (p) => store.list(p)], ["lease", (p) => store.lease(p, "k", { purpose: "a", profileId: "b" })],
      ["readLease", (p) => store.readLease(p, "lse_x")], ["revokeLease", (p) => store.revokeLease(p, "lse_x")], ["activeLeases", (p) => store.activeLeases(p)],
    ];
    for (const bad of [agent, { kind: "agent" } as SecretPrincipal, { kind: "admin" } as never, { kind: "OWNER" } as never, null as never, undefined as never, "owner" as never, {} as never]) {
      for (const [, call] of calls) await assert.rejects(async () => call(bad), code("denied"));
    }
    assert.equal((await store.reveal(owner, "k")).value, MARKER); // untouched
    assert.ok(audit.events.some((e) => e.action === "secret.denied"));
    assert.ok(!JSON.stringify(audit.events).includes(MARKER));
  });
  it("core may lease and read leases but not reveal, set, delete or list", async () => {
    const { store } = setup();
    await store.set(owner, "k", MARKER);
    assert.equal((await store.lease(core, "k", { purpose: "a", profileId: "b" })).value, MARKER);
    for (const op of [() => store.reveal(core, "k"), () => store.set(core, "k", "x"), () => store.delete(core, "k"), () => store.list(core)]) await assert.rejects(op, code("denied"));
  });
  it("writes an audit line per access, none with a value", async () => {
    const { store, audit } = setup();
    await store.set(owner, "k", MARKER); await store.meta(owner, "k"); await store.reveal(owner, "k"); await store.list(owner);
    const l = await store.lease(core, "k", { purpose: "embedding", profileId: "p", ttlMs: 1000 });
    store.revokeLease(owner, l.leaseId); await store.delete(owner, "k");
    assert.deepEqual(audit.events.map((e) => e.action), ["secret.set", "secret.get", "secret.reveal", "secret.list", "secret.lease", "secret.lease.revoke", "secret.delete"]);
    assert.equal(audit.events[4]!.detail?.purpose, "embedding");
    assert.ok(!JSON.stringify(audit.events).includes(MARKER));
  });
  it("a failing audit blocks the release and the change (no audit line, no value)", async () => {
    const { store, audit } = setup();
    await store.set(owner, "k", MARKER);
    audit.failNext = true; await assert.rejects(() => store.reveal(owner, "k"), code("audit-unavailable"));
    audit.failNext = true; await assert.rejects(() => store.set(owner, "k", "changed"), code("audit-unavailable"));
    audit.failNext = true; await assert.rejects(() => store.delete(owner, "k"), code("audit-unavailable"));
    audit.failNext = true; await assert.rejects(() => store.lease(core, "k", { purpose: "a", profileId: "b" }), code("audit-unavailable"));
    assert.equal((await store.reveal(owner, "k")).value, MARKER);
  });
});
