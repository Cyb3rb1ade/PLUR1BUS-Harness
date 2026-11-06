// Config values already known to Core must protect exported companion files as well as config.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configTextSecretEntries, defaults } from "@plur1bus/config-schema";
import { exportAgent } from "../../src/agents/export.ts";
import { exportSecretCanaries } from "../../src/agents/signing.ts";
import { agentRequiredSecrets } from "../../src/agents/secrets.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { SecretFormsCache } from "../../src/logs/secret-forms.ts";

test("agent exports conceal global config values from the shared registry without requiring a store value", async t => {
  const root = mkdtempSync(join(tmpdir(), "p1b-export-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = randomUUID();
  const config = defaults();
  config.engine = { embedding: { apiKey: secret } };
  const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend({ available: false }),
    fileFallback: () => false, audit: createMemoryAuditSink() });
  store.redaction.replaceGroup(Symbol("configuration"), configTextSecretEntries(config).map(({ value }) => value));
  assert.equal((await store.list({ kind: "owner", id: "core" })).length, 0);
  writeFileSync(join(root, "SOUL.md"), `Public persona\n${secret}\n`);
  const bundle = await exportAgent({ root, agentId: "fixture", config: {}, memories: [{ text: secret }],
    secrets: await exportSecretCanaries(store), signer: async () => ({ publicKey: "unused", signature: "unused" }) });
  assert.deepEqual(bundle.files.filter(file => file.text.includes(secret)).map(file => file.path), [],
    "known config values must not escape through any exported file");
  assert.ok(bundle.files.find(file => file.path === "SOUL.md")!.text.includes("Public persona"));
  assert.ok(bundle.files.some(file => file.path === "memory/cards.json"));
});

test("export preserves ordinary reference metadata and refuses a name colliding with a known store value before signing", async t => {
  const root = mkdtempSync(join(tmpdir(), "p1b-export-reference-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const name = `fixture.reference.${randomUUID().slice(0, 8)}`;
  const config = defaults();
  config.channels.telegram.tokenSecret = name;
  const agent = { channels: ["telegram"] };
  const requiredSecrets = agentRequiredSecrets(config, agent);
  assert.deepEqual(requiredSecrets, [name]);
  const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend({ available: false }),
    fileFallback: () => false, audit: createMemoryAuditSink() });
  let signatures = 0;
  const signer = async () => { signatures++; return { publicKey: "unused", signature: "unused" }; };
  const input = { root, agentId: "fixture", config: agent, memories: [], requiredSecrets, signer };
  const ordinary = await exportAgent({ ...input, secrets: await exportSecretCanaries(store) });
  assert.deepEqual(ordinary.manifest.requiredSecrets, [name]);
  await store.set({ kind: "owner", id: "test" }, "independent-store-value", name);
  await assert.rejects(() => exportAgent({ ...input, secrets: store.redaction.values() }),
    (error: unknown) => error instanceof RpcError && error.reason === "export-secret-metadata" &&
      !error.message.includes(name));
  assert.equal(signatures, 1, "a bundle containing known secret metadata must not be signed");
});

test("exports reuse one local secret generation across config, memory, files and manifest checks", async t => {
  const root = mkdtempSync(join(tmpdir(), "p1b-export-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = randomUUID(), second = randomUUID();
  writeFileSync(join(root, "SOUL.md"), `public ${first} ${second}`);
  const encode = globalThis.encodeURIComponent;
  let derivations = 0;
  t.mock.method(globalThis, "encodeURIComponent", (value: string) => {
    if (value === first || value === second) derivations++;
    return encode(value);
  });
  for (const secrets of [[first, second], [second, first, first]]) {
    const bundle = await exportAgent({ root, agentId: "fixture", config: {}, memories: [{ text: first }], secrets,
      signer: async () => ({ publicKey: "unused", signature: "unused" }) });
    for (const secret of [first, second]) assert.ok(!JSON.stringify(bundle.files).includes(secret));
  }
  assert.equal(derivations, 2, "the export must prepare each raw secret once for unchanged membership");
});

test("an export captures one complete shared snapshot and keeps local raw canaries distinct from encoded forms", async t => {
  const root = mkdtempSync(join(tmpdir(), "p1b-export-shared-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stored = randomUUID();
  const local = Buffer.from(stored).toString("base64");
  const localEncoding = Buffer.from(local).toString("base64");
  const snapshot = new SecretFormsCache().snapshot([stored]);
  const reference = `fixture.reference.${randomUUID().slice(0, 8)}`;
  writeFileSync(join(root, "SOUL.md"), `public ${stored} ${localEncoding}`);
  let snapshots = 0;
  const bundle = await exportAgent({ root, agentId: "fixture", config: {}, memories: [{ text: stored }, { text: localEncoding }],
    secrets: [local], requiredSecrets: [reference], knownSecrets: () => { snapshots++; return snapshot; },
    signer: async () => ({ publicKey: "unused", signature: "unused" }) });
  assert.equal(snapshots, 2, "one shaping generation is captured, then refreshed only after the async signer");
  const text = JSON.stringify(bundle.files);
  assert.ok(!text.includes(stored)); assert.ok(!text.includes(localEncoding));
  assert.deepEqual(bundle.manifest.requiredSecrets, [reference]);
});

test("an export refuses content that becomes secret while its signer is awaiting", async t => {
  const root = mkdtempSync(join(tmpdir(), "p1b-export-signing-rotation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const late = randomUUID();
  writeFileSync(join(root, "SOUL.md"), `public ${late}`);
  const cache = new SecretFormsCache();
  let current: string[] = [];
  await assert.rejects(() => exportAgent({ root, agentId: "fixture", config: {}, memories: [],
    knownSecrets: () => cache.snapshot(current), signer: async () => {
      await Promise.resolve();
      current = [late];
      return { publicKey: "unused", signature: "unused" };
    } }), (error: unknown) => error instanceof RpcError && error.error === "E_NOT_AVAILABLE" &&
      !error.message.includes(late));
});
