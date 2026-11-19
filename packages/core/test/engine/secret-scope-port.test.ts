import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "@plur1bus/config-schema";
import { RpcError } from "@plur1bus/module-api";
import { createEngineSecrets, ENGINE_OUTSIDE_SCOPE } from "../../src/engine-host-ports.ts";
import { createHostMethods } from "../../src/engine/host-methods.ts";
import { engineSecretNames, engineSecretScope } from "../../src/engine/secret-scope.ts";
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
  assert.deepEqual(f.audit.events[0], { action: "secret.denied", target: "personal/bank-token", principal: { kind: "agent", agentId: "memory-engine" }, detail: { method: "lease" } });
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

// The correction round (R-20-37, R-20-38): the scope the port asks, its cache and what an invalid file does.
test("the set is built once for a configuration, and again for the next one", async () => {
  let reads = 0;
  const configuration = (name: string) => ({ get engine() { reads++; return { merging: { apiKeyRef: name } }; } });
  let config = configuration("embedding-key");
  const f = await fixture(() => new Set());
  const secrets = createEngineSecrets(f.store, engineSecretScope(() => config));
  for (let i = 0; i < 5; i++) assert.equal(await secrets.resolve("embedding-key", "memory-engine"), "embedding-value");
  await assert.rejects(() => secrets.resolve("personal/bank-token", "memory-engine"));
  const once = reads;
  assert.ok(once > 0);
  for (let i = 0; i < 5; i++) await secrets.resolve("embedding-key", "memory-engine");
  assert.equal(reads, once, "the same configuration is not walked again");
  // The next configuration: the reference of before is gone with the first request, whatever was kept.
  config = configuration("personal/bank-token");
  await assert.rejects(() => secrets.resolve("embedding-key", "memory-engine"), /could not be resolved/u);
  assert.equal(await secrets.resolve("personal/bank-token", "memory-engine"), "bank-value");
  assert.ok(reads > once);
  // And back: nothing of an earlier configuration is kept beside the one that holds.
  config = configuration("embedding-key");
  await assert.rejects(() => secrets.resolve("personal/bank-token", "memory-engine"), /could not be resolved/u);
});

test("a configuration that cannot be given refuses, and the next one that can is used", async () => {
  let broken = true;
  const f = await fixture(() => new Set());
  const secrets = createEngineSecrets(f.store, engineSecretScope(() => { if (broken) throw new Error("no configuration"); return { engine: { merging: { apiKeyRef: "embedding-key" } } }; }));
  await assert.rejects(() => secrets.resolve("embedding-key", "memory-engine"));
  broken = false;
  assert.equal(await secrets.resolve("embedding-key", "memory-engine"), "embedding-value");
});

test("the refusal's record names the engine as the one who asked", async () => {
  const f = await fixture(() => new Set());
  for (const name of ["personal/bank-token", "Not A Name!"]) await assert.rejects(() => f.secrets.resolve(name, "memory-engine"));
  assert.deepEqual(f.audit.events, [
    { action: "secret.denied", target: "personal/bank-token", principal: ENGINE_OUTSIDE_SCOPE, detail: { method: "lease" } },
    { action: "secret.denied", target: null, principal: ENGINE_OUTSIDE_SCOPE, detail: { method: "lease" } },
  ]);
  assert.deepEqual(ENGINE_OUTSIDE_SCOPE, { kind: "agent", agentId: "memory-engine" });
});

test("a name in the form of an extension slot is resolved when the configuration refers to it, and only then", async () => {
  const slot = "ext:my-ext:API_KEY";
  const f = await fixture(() => new Set());
  await f.store.set(owner, slot, "slot-value");
  const inside = createEngineSecrets(f.store, engineSecretScope(() => ({ engine: { merging: { apiKeyRef: slot } } })));
  assert.equal(await inside.resolve(slot, "memory-engine"), "slot-value");
  const outside = createEngineSecrets(f.store, engineSecretScope(() => ({ engine: { merging: { apiKeyRef: "embedding-key" } } })));
  await assert.rejects(() => outside.resolve(slot, "memory-engine"), /could not be resolved/u);
});

test("a reference in a block the schema does not know opens nothing", async () => {
  const f = await fixture(() => new Set());
  const secrets = createEngineSecrets(f.store, engineSecretScope(() => ({ engine: { afterthought: { apiKeyRef: "embedding-key" }, madeUp: { apiKeyRef: "personal/bank-token", embedding: {} } } })));
  for (const name of ["embedding-key", "personal/bank-token", "OPENAI_API_KEY"]) await assert.rejects(() => secrets.resolve(name, "memory-engine"), /could not be resolved/u, name);
});

test("the core's configuration source: an invalid file changes nothing until a valid one is there", async () => {
  const { openConfigSource } = await import("../../src/config-source.ts");
  const { writeFileSync, renameSync } = await import("node:fs");
  const home = tempDir("p1b-scope-source-");
  const l = layout(home);
  const write = (text: string) => { writeFileSync(`${l.configPath}.next`, text); renameSync(`${l.configPath}.next`, l.configPath); };
  const valid = (engine: Record<string, unknown>) => JSON.stringify({ ...defaults(), engine: { implementation: "node", ...engine } });
  write(valid({ merging: { apiKeyRef: "embedding-key" }, skillMiner: { apiKeyRef: "personal/bank-token" } }));
  const source = await openConfigSource({ layout: l, supervised: false, filePollMs: 20 });
  try {
    const f = await fixture(() => new Set());
    const secrets = createEngineSecrets(f.store, engineSecretScope(() => source.current()));
    const until = async (pred: () => Promise<boolean>) => { const end = Date.now() + 5000; while (!(await pred())) { if (Date.now() > end) throw new Error("condition not met in time"); await new Promise(r => setTimeout(r, 20)); } };
    const resolves = (name: string) => secrets.resolve(name, "memory-engine").then(() => true, () => false);
    assert.equal(await resolves("embedding-key"), true);
    assert.equal(await resolves("personal/bank-token"), true);
    // Cut off, then no JSON at all: the last valid configuration holds, with both references.
    for (const text of [valid({}).slice(0, 40), "{ not json", ""]) {
      write(text);
      await new Promise(r => setTimeout(r, 80));
      assert.equal(await resolves("embedding-key"), true, JSON.stringify(text));
      assert.equal(await resolves("personal/bank-token"), true, JSON.stringify(text));
    }
    // Valid again, with one reference taken out: that one is refused, the other goes on.
    write(valid({ merging: { apiKeyRef: "embedding-key" } }));
    await until(async () => !(await resolves("personal/bank-token")));
    assert.equal(await resolves("embedding-key"), true);
  } finally { await source.close(); }
});
