import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import type { SecretBackend } from "../../src/secrets/types.ts";

const owner = { kind: "owner" } as const, core = { kind: "core" } as const;
const unavailable = (error: unknown) => (error as { code?: string }).code === "backend-unavailable";
const rig = (keyring: SecretBackend, startup: { budgetMs?: number; retryAfterMs?: number } = {}) =>
  createSecretStore({ keyring, file: createMemoryBackend({ available: false }), fileFallback: () => false,
    audit: createMemoryAuditSink(), startup });

test("one startup deadline covers every read and abandoned values never register", async () => {
  const raw = createMemoryBackend(), values = Array.from({ length: 6 }, () => randomUUID());
  for (const [i, value] of values.entries()) await raw.put(`item.${i}`, value, new Date());
  let reads = 0;
  const store = rig({ ...raw, async get(name) { reads++; await delay(20); return raw.get(name); } },
    { budgetMs: 45, retryAfterMs: 60_000 });
  await store.preloadRedaction();
  assert.equal(store.startupStatus().state, "unavailable");
  assert.equal(store.startupStatus().safeToFlush, false);
  assert.equal(store.startupStatus().reason, "startup-timeout");
  assert.ok(reads < values.length, "the startup budget restarted for each entry");
  assert.equal((await store.status(core)).backend, "none");
  await assert.rejects(store.reveal(owner, "item.0"), unavailable);
  await delay(35);
  assert.deepEqual(store.redaction.values(), [], "a late preload completion published an abandoned snapshot");
  assert.equal(store.startupStatus().state, "unavailable");
  await store.close();
});

test("an empty available Store and a Store with no available backend have distinct startup states", async () => {
  const empty = rig(createMemoryBackend()), down = rig(createMemoryBackend({ available: false }));
  await Promise.all([empty.preloadRedaction(), down.preloadRedaction()]);
  assert.equal(empty.startupStatus().state, "ready");
  assert.equal((await empty.status(core)).count, 0);
  assert.equal(down.startupStatus().state, "unavailable");
  assert.equal((await down.status(core)).count, null);
  assert.match((await down.status(core)).remedy!, /fileFallback/);
  await assert.rejects(down.reveal(owner, "item"), error => (error as { code?: string }).code === "no-backend");
  await Promise.all([empty.close(), down.close()]);
});

test("fresh recovery pins its snapshot before values can be released and retains the initial snapshot", async () => {
  const raw = createMemoryBackend(), first = randomUUID(), recovered = randomUUID();
  await raw.put("item", first, new Date());
  const store = rig(raw, { retryAfterMs: 0 });
  await store.preloadRedaction();
  store.backendUnavailable();
  await raw.put("item", recovered, new Date());
  await store.preloadRedaction();
  assert.equal(store.startupStatus().state, "ready");
  assert.ok(store.redaction.contains(recovered));
  assert.equal((await store.reveal(owner, "item")).value, recovered);
  for (let i = 0; i < 300; i++) store.redaction.register(randomUUID());
  assert.ok(store.redaction.contains(first), "recovery retired the process-lifetime initial snapshot");
  assert.ok(store.redaction.contains(recovered));
  await store.close();
});

for (const operation of ["reveal", "lease"] as const) test(`a ${operation} read completing after invalidation cannot release or register a value`, async () => {
  const raw = createMemoryBackend(), original = randomUUID(), abandoned = randomUUID();
  await raw.put("item", original, new Date());
  let hold = false, release!: (value: string) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const store = rig({ ...raw, get(name) {
    if (!hold) return raw.get(name);
    entered(); return new Promise<string>(resolve => { release = resolve; });
  } });
  await store.preloadRedaction(); hold = true;
  const result = operation === "reveal" ? store.reveal(owner, "item")
    : store.lease(core, "item", { purpose: "test", profileId: "test" });
  const rejected = assert.rejects(result, unavailable);
  await started;
  store.backendUnavailable();
  release(abandoned);
  await rejected;
  assert.ok(!store.redaction.contains(abandoned));
  assert.deepEqual(store.activeLeases(core), []);
  await store.close();
});

for (const operation of ["list", "meta"] as const) test(`${operation} completing after invalidation reports unavailable rather than stale metadata`, async () => {
  const raw = createMemoryBackend(); await raw.put("item", randomUUID(), new Date());
  let hold = false, release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const store = rig({ ...raw, async list() {
    if (hold) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
    return raw.list();
  } });
  await store.preloadRedaction(); hold = true;
  const result = operation === "list" ? store.list(owner) : store.meta(owner, "item");
  const rejected = assert.rejects(result, unavailable);
  await started;
  store.backendUnavailable(); release();
  await rejected;
  await store.close();
});
