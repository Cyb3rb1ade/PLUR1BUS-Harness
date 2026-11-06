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
