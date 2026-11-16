import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "@plur1bus/config-schema";
import { RpcError } from "@plur1bus/module-api";
import { createEngineSecrets } from "../../src/engine-host-ports.ts";
import { createHostMethods } from "../../src/engine/host-methods.ts";
import { engineSecretNames } from "../../src/engine/secret-scope.ts";
import { createHarnessHost } from "../../src/host.ts";
import { createAgentRegistry } from "../../src/agents.ts";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { createLogger } from "../../src/logger.ts";
import { layout } from "../../src/paths.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { importEnginePorts } from "../../src/import/engine-ports.ts";
import { rmSync } from "node:fs";
import { tempDir } from "../helpers/temp-dir.ts";

// P4D-29: the engine resolves the names its configuration refers to, and nothing else.
const owner = { kind: "owner" } as const;
async function fixture(names: () => ReadonlySet<string>) {
  const audit = createMemoryAuditSink();
  const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit });
  await store.set(owner, "embedding-key", "embedding-value");
  await store.set(owner, "personal/bank-token", "bank-value");
  await store.set(owner, "OPENAI_API_KEY", "default-value");
  audit.events.length = 0;
  const failures: unknown[] = [];
  return { audit, store, failures, secrets: createEngineSecrets(store, names, { onFailure: f => failures.push(f) }) };
}
const caught = async (run: () => Promise<unknown>): Promise<Error> => { try { await run(); } catch (e) { return e as Error; } throw new Error("expected a refusal"); };
const actions = (f: { audit: { events: { action: string }[] } }) => f.audit.events.map(e => e.action);

test("a name in the set is resolved: the value, one lease and its revocation", async () => {
  const f = await fixture(() => new Set(["embedding-key"]));
  assert.equal(await f.secrets.resolve("embedding-key", "memory-engine"), "embedding-value");
  assert.deepEqual(actions(f), ["secret.lease", "secret.lease.revoke"]);
  assert.deepEqual(f.failures, []);
});

test("a stored name outside the set is refused as an unknown name is: same error, no lease, one denied record", async () => {
  const f = await fixture(() => new Set(["embedding-key"]));
  const outside = await caught(() => f.secrets.resolve("personal/bank-token", "memory-engine"));
  assert.deepEqual(actions(f), ["secret.denied"]);
  assert.deepEqual(f.audit.events[0], { action: "secret.denied", target: "personal/bank-token", principal: { kind: "agent" }, detail: { method: "lease" } });
  const stored = f.failures.length;
  f.audit.events.length = 0;
  const unknown = await caught(() => createEngineSecrets(f.store, () => new Set(["no-such-name"]), { onFailure: x => f.failures.push(x) }).resolve("no-such-name", "memory-engine"));
  assert.equal(outside.message, unknown.message);
  assert.deepEqual(Object.keys(outside).sort(), Object.keys(unknown).sort());
  assert.equal((outside as { code?: string }).code, (unknown as { code?: string }).code);
  assert.equal((outside as { errorClass?: string }).errorClass, (unknown as { errorClass?: string }).errorClass);
  assert.equal(f.failures.length, stored + 1, "a refusal is reported to the failure observer once, like any unresolved key");
  assert.deepEqual(f.failures[0], f.failures[1]);
  assert.ok(!JSON.stringify(outside).includes("bank-value"));
});

test("a name outside the set that the store does not hold gets the same answer, and the same record", async () => {
  const f = await fixture(() => new Set());
  const missing = await caught(() => f.secrets.resolve("personal/never-stored", "memory-engine"));
  const present = await caught(() => f.secrets.resolve("personal/bank-token", "memory-engine"));
  assert.equal(missing.message, present.message);
  assert.deepEqual(actions(f), ["secret.denied", "secret.denied"]);
  assert.deepEqual(f.audit.events.map(e => e.target), ["personal/never-stored", "personal/bank-token"]);
});

test("a reference removed from the configuration is refused by the next request", async () => {
  let config: Record<string, unknown> = { engine: { merging: { apiKeyRef: "embedding-key" } } };
  const f = await fixture(() => engineSecretNames(config));
  assert.equal(await f.secrets.resolve("embedding-key", "memory-engine"), "embedding-value");
  config = { engine: { merging: {} } };
  await assert.rejects(() => f.secrets.resolve("embedding-key", "memory-engine"), /could not be resolved/u);
  assert.equal(actions(f).at(-1), "secret.denied");
});

test("a default name is resolved while its block is in the configuration and refused without it", async () => {
  let config: Record<string, unknown> = { engine: { embedding: { local: { model: "x" } } } };
  const f = await fixture(() => engineSecretNames(config));
  assert.equal(await f.secrets.resolve("OPENAI_API_KEY", "memory-engine"), "default-value");
  config = { engine: { reranker: { apiKeyRef: "embedding-key" } } };
  await assert.rejects(() => f.secrets.resolve("OPENAI_API_KEY", "memory-engine"), /could not be resolved/u);
  assert.equal(await f.secrets.resolve("embedding-key", "memory-engine"), "embedding-value");
  config = { engine: {} };
  await assert.rejects(() => f.secrets.resolve("embedding-key", "memory-engine"));
});

test("a set that cannot be built refuses everything, as one that is empty", async () => {
  const f = await fixture(() => { throw new Error("config unreadable"); });
  await assert.rejects(() => f.secrets.resolve("embedding-key", "memory-engine"), /could not be resolved/u);
  assert.deepEqual(actions(f), ["secret.denied"]);
});

test("a name that is not a string is refused without a lease", async () => {
  const f = await fixture(() => new Set(["embedding-key"]));
  for (const bad of [undefined, null, 7, {}, ["embedding-key"]]) await assert.rejects(() => f.secrets.resolve(bad as never, "memory-engine"));
  assert.ok(!actions(f).includes("secret.lease"));
});

test("host.secret.get answers an engine from the set only", async () => {
  const f = await fixture(() => new Set(["embedding-key"]));
  const methods = createHostMethods({ host: {} as never, egress: {} as never, secrets: f.store, engineSecretNames: () => new Set(["embedding-key"]) });
  const { bindEnginePrincipal } = await import("../../src/engine/engine-principal.ts");
  const ctx = { requestId: "r", connectionId: "c", signal: new AbortController().signal };
  bindEnginePrincipal(ctx);
  assert.deepEqual(await methods["host.secret.get"]!({ name: "embedding-key" }, ctx), { value: "embedding-value" });
  const outside = await caught(() => methods["host.secret.get"]!({ name: "personal/bank-token" }, ctx) as Promise<unknown>);
  const unknown = await caught(() => methods["host.secret.get"]!({ name: "no-such" }, ctx) as Promise<unknown>);
  assert.equal(outside.message, unknown.message);
  assert.equal(outside instanceof RpcError, unknown instanceof RpcError);
});

test("the in-process engine host takes its set from the configuration that holds now", async () => {
  const f = await fixture(() => new Set());
  const l = layout(tempDir("p1b-scope-host-"));
  const cfg = defaults(); cfg.agents.bernd = {};
  const logger = createLogger({ file: l.logFile("core"), level: "info", role: "core" });
  let current = structuredClone(cfg); current.engine = { merging: { apiKeyRef: "embedding-key" } };
  const host = createHarnessHost({ layout: l, logger, config: cfg, currentConfig: () => current, engineConfig: buildEngineConfig(cfg, l), agents: createAgentRegistry(cfg, l), events: () => {}, secrets: f.store });
  assert.equal(await host.secrets!.resolve("embedding-key", "memory-engine"), "embedding-value");
  await assert.rejects(() => host.secrets!.resolve("personal/bank-token", "memory-engine"));
  current = { ...current, engine: {} };
  await assert.rejects(() => host.secrets!.resolve("embedding-key", "memory-engine"));
  await logger.close();
});

test("the import ports read the target installation's configuration for each request", async () => {
  const f = await fixture(() => new Set());
  const home = tempDir("p1b-scope-import-");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const l = layout(home);
  mkdirSync(l.home, { recursive: true });
  const write = (engine: Record<string, unknown>) => writeFileSync(l.configPath, JSON.stringify({ ...defaults(), engine }));
  write({ merging: { apiKeyRef: "embedding-key" } });
  const ports = importEnginePorts(home, f.store);
  assert.equal(await ports.secrets.resolve("embedding-key", "memory-engine"), "embedding-value");
  await assert.rejects(() => ports.secrets.resolve("personal/bank-token", "memory-engine"));
  write({});
  await assert.rejects(() => ports.secrets.resolve("embedding-key", "memory-engine"));
  rmSync(l.configPath);
  await assert.rejects(() => ports.secrets.resolve("embedding-key", "memory-engine"));
});
