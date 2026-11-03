// Startup registration reads usable backend values without exposing them or changing stored state.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink, createFileAuditSink } from "../../src/secrets/audit.ts";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import type { SecretBackend, BackendKind } from "../../src/secrets/types.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { secure } from "./helpers.ts";

function backend(kind: BackendKind, available = true) {
  const raw = createMemoryBackend({ available });
  const calls = { probe: 0, list: 0, get: 0, mutations: 0 };
  const faults = { probe: false, list: false, reads: new Set<string>() };
  const failure = randomUUID();
  const store: SecretBackend = {
    kind,
    async probe() {
      calls.probe++;
      if (faults.probe) throw new Error(failure);
      return raw.probe();
    },
    async list() {
      calls.list++;
      if (faults.list) throw new Error(failure);
      return raw.list();
    },
    async get(name) {
      calls.get++;
      if (faults.reads.has(name)) throw new Error(failure);
      return raw.get(name);
    },
    async put(...args) { calls.mutations++; return raw.put(...args); },
    async describe(...args) { calls.mutations++; return raw.describe(...args); },
    async delete(...args) { calls.mutations++; return raw.delete(...args); },
    async tombstones() { calls.mutations++; return {}; },
    async clearTombstone() { calls.mutations++; },
  };
  return { raw, store, calls, faults, failure };
}

function rig(enabled = true, keyring = backend("keyring"), file = backend("file")) {
  const audit = createMemoryAuditSink();
  const logs: { message: string; fields: Record<string, unknown> | undefined }[] = [];
  const record = (message: string, fields?: Record<string, unknown>) => { logs.push({ message, fields }); };
  const store = createSecretStore({ keyring: keyring.store, file: file.store, fileFallback: () => enabled,
    audit, logger: { debug: record, info: record, warn: record } });
  return { store, keyring, file, audit, logs };
}

test("preload pins both accessible copies without migration, leases, audit access or repeated reads", async () => {
  const r = rig();
  const winner = randomUUID(), older = randomUUID(), fallbackOnly = randomUUID();
  await r.keyring.raw.put("duplicate", winner, new Date(2000));
  await r.file.raw.put("duplicate", older, new Date(1000));
  await r.file.raw.put("fallback.only", fallbackOnly, new Date(1000));
  const initial = [r.keyring.raw.dump(), r.file.raw.dump()];
  assert.equal(await r.store.preloadRedaction(), undefined);
  await Promise.all([r.store.preloadRedaction(), r.store.preloadRedaction()]);
  assert.deepEqual([r.keyring.calls, r.file.calls], [
    { probe: 1, list: 1, get: 1, mutations: 0 }, { probe: 1, list: 1, get: 2, mutations: 0 },
  ]);
  assert.deepEqual([r.keyring.raw.dump(), r.file.raw.dump()], initial);
  assert.deepEqual(r.audit.events, []);
  assert.deepEqual(r.store.activeLeases({ kind: "core" }), []);
  assert.deepEqual(r.logs, []);
  // Later logical reads must not retire either physical startup copy from the lifetime snapshot.
  await r.store.reveal({ kind: "owner" }, "duplicate");
  for (let i = 0; i < 300; i++) r.store.redaction.register(randomUUID());
  const text = r.store.redaction.redactor().text(`${winner} ${older} ${fallbackOnly} public text`);
  for (const value of [winner, older, fallbackOnly]) assert.equal(text.includes(value), false);
  assert.ok(text.includes("public text"));
});

test("disabled file fallback is never probed or read", async () => {
  const r = rig(false);
  const hidden = randomUUID(), visible = randomUUID();
  await r.file.raw.put("hidden", hidden, new Date(1000));
  await r.keyring.raw.put("visible", visible, new Date(1000));
  await r.store.preloadRedaction();
  assert.deepEqual(r.file.calls, { probe: 0, list: 0, get: 0, mutations: 0 });
  assert.equal(r.store.redaction.contains(hidden), false);
  assert.equal(r.store.redaction.contains(visible), true);
});

test("unavailable backends and an empty usable store keep startup nonfatal", async () => {
  for (const [keyringUp, fileUp] of [[false, false], [false, true], [true, false], [true, true]]) {
    const r = rig(true, backend("keyring", keyringUp), backend("file", fileUp));
    assert.equal(await r.store.preloadRedaction(), undefined);
    assert.equal(r.keyring.calls.list, keyringUp ? 1 : 0);
    assert.equal(r.file.calls.list, fileUp ? 1 : 0);
    assert.deepEqual(r.store.redaction.values(), []);
    assert.deepEqual(r.audit.events, []);
    assert.deepEqual(r.logs, []);
  }
});

test("a usable fallback value registers while the keyring is unavailable", async () => {
  const r = rig(true, backend("keyring", false));
  const value = randomUUID();
  await r.file.raw.put("fallback", value, new Date(1000));
  await r.store.preloadRedaction();
  assert.equal(r.store.redaction.contains(value), true);
  assert.equal(r.keyring.calls.get, 0);
});

test("probe, list and entry failures leave other readable values registered with value-free warnings", async () => {
  for (const phase of ["probe", "list", "read"] as const) {
    const r = rig();
    const readable = randomUUID(), inaccessible = randomUUID();
    await r.keyring.raw.put("broken", inaccessible, new Date(1000));
    await r.keyring.raw.put("good", readable, new Date(1000));
    await r.file.raw.put("fallback", readable, new Date(1000));
    if (phase === "read") r.keyring.faults.reads.add("broken");
    else r.keyring.faults[phase] = true;
    await r.store.preloadRedaction();
    assert.equal(r.store.redaction.contains(readable), true);
    assert.equal(r.store.redaction.contains(inaccessible), false);
    assert.equal(r.logs.length, 1);
    assert.deepEqual(r.logs[0]!.fields, { backend: "keyring", phase, count: 1 });
    assert.equal(JSON.stringify(r.logs).includes(r.keyring.failure), false);
    assert.equal(JSON.stringify(r.logs).includes(inaccessible), false);
    assert.deepEqual(r.audit.events, []);
  }
});

test("the audit sink sees every pinned startup value through the populated live redactor", () => {
  const dir = tempDir("p1b-startup-audit-");
  const registry = createSecretRedaction();
  const sink = createFileAuditSink({ file: join(dir, "audit.log"), secure, redactor: registry.redactor() });
  const values = Array.from({ length: 512 }, () => randomUUID());
  registry.replaceGroup(Symbol("startup"), values);
  sink.record({ action: "secret.list", target: null, principal: { kind: "core" },
    detail: { reason: `${values[0]} ${values[511]}` } });
  for (const filename of ["audit.log", "audit-chain.jsonl"]) {
    const text = readFileSync(join(dir, filename), "utf8");
    assert.equal(text.includes(values[0]!), false);
    assert.equal(text.includes(values[511]!), false);
    assert.ok(text.includes("[REDACTED:secret]"));
  }
});
