// A real Core with queued startup logs and live configuration changes; module mocks observe existing private ports only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { defaults } from "@plur1bus/config-schema";
import { flatTestInternals } from "../../helpers/flat-embedder.ts";
import { redactProtocolOutput } from "../../../src/secrets/redaction.ts";
import type { ConfigSource, ConfigSourceOptions } from "../../../src/config-source.ts";
import type { SecretStoreLogger } from "../../../src/secrets/store.ts";
import { createFileBackend } from "../../../src/secrets/file-backend.ts";
import { layout } from "../../../src/paths.ts";
import { secure } from "../helpers.ts";

const initial = randomUUID();
const rotated = randomUUID();
const query = randomUUID();
const moduleSecret = randomUUID();
const providerSecret = randomUUID();
const storeOnly = process.argv.includes("--store-only") ? randomUUID() : undefined;
const endpoint = `https://relay.example.test/public/path?ordinary=${query}`;
const configSource = await import("../../../src/config-source.ts");
let source: ConfigSource;
mock.module(new URL("../../../src/config-source.ts", import.meta.url).href, { namedExports: {
  ...configSource,
  async openConfigSource(options: ConfigSourceOptions) {
    options.logger?.warn("queued configuration fixture", { ordinary: initial, endpoint, moduleOrdinary: moduleSecret });
    if (storeOnly) options.logger?.warn(`queued Store fixture ${storeOnly}`,
      { ordinary: storeOnly, public: "public startup detail" });
    source = await configSource.openConfigSource(options);
    return source;
  },
} });
const runtime = await import("../../../src/secrets/runtime.ts");
let registry: ReturnType<typeof runtime.createCoreSecretStore>["redaction"];
let logger: SecretStoreLogger;
mock.module(new URL("../../../src/secrets/runtime.ts", import.meta.url).href, { namedExports: {
  ...runtime,
  createCoreSecretStore(options: Parameters<typeof runtime.createCoreSecretStore>[0]) {
    const store = runtime.createCoreSecretStore(options);
    registry = store.redaction;
    logger = options.logger!;
    if (storeOnly) logger.warn("Store construction fixture", { ordinary: storeOnly });
    return store;
  },
} });
const platform = await import("../../../src/platform.ts");
mock.module(new URL("../../../src/platform.ts", import.meta.url).href, { namedExports: {
  ...platform,
  createPlatformCapabilities(options: Parameters<typeof platform.createPlatformCapabilities>[0]) {
    if (storeOnly) options?.logger?.warn("platform startup fixture", { ordinary: storeOnly });
    return platform.createPlatformCapabilities(options);
  },
} });
const bootstrap = await import("../../../src/logs/bootstrap.ts");
const { createCore } = await import("../../../src/core.ts");
const home = mkdtempSync(join(tmpdir(), "p1b-config-registration-"));
const config = defaults();
if (storeOnly) {
  config.secrets.fileFallback.enabled = true;
  await createFileBackend({ dir: layout(home).secrets, secure }).put("startup.only", storeOnly, new Date());
}
const initialStore = storeOnly ? ["store.json", "store.key"].map(name =>
  readFileSync(join(layout(home).secrets, name))) : [];
config.agents.main = {};
config.models.scan.enabled = false;
config.engine = { neo: { enabled: false }, gc: { enabled: false }, dreaming: { enabled: false },
  skillMiner: { enabled: false }, reranker: { enabled: false }, merging: { headers: { ordinary: initial } } };
config.voice.providers.elevenlabs.baseUrl = endpoint;
config.providers.fixture = { wireFormat: "chat_completions", entries: [], profile: {
  id: "fixture", display_name: "Fixture", kind: "api_key", capabilities: ["chat"],
  auth_header_scheme: "Authorization: Bearer {token}", policy_status: "allowed", policy_source: "fixture",
  policy_checked: "2026-11-01", extra_headers: { "X-Ordinary-Name": providerSecret },
} };
config.modules.fixture = { enabled: false, ordinary: moduleSecret };
mkdirSync(join(home, "modules/fixture"), { recursive: true });
writeFileSync(join(home, "modules/fixture/index.js"), "export {};\n");
writeFileSync(join(home, "modules/fixture/module.json"), JSON.stringify({ name: "fixture", version: "0.1.0", apiVersion: "1",
  entry: "index.js", scope: "installation", priority: 500, configSchema: {
    properties: { ordinary: { type: "string", "x-sensitive": true } },
  } }));
writeFileSync(join(home, "config.json"), JSON.stringify(config));
const provided = process.argv.includes("--injected") ? bootstrap.createCoreLog({ dir: join(home, "logs"), role: "core",
  source: { kind: "harness", id: "core", version: "0.1.0" }, timers: false }) : undefined;
const core = createCore({ home, testInternals: flatTestInternals(), ...(provided ? { logger: provided } : {}) });
const text = (): string => readdirSync(join(home, "logs")).filter((name) => name.endsWith(".log"))
  .map((name) => readFileSync(join(home, "logs", name), "utf8")).join("\n");
try {
  await core.start();
  if (storeOnly) {
    assert.ok(text().includes("queued Store fixture"), "the queued startup record was not written");
    assert.ok(text().includes("platform startup fixture"), "the platform startup record was not written");
    assert.ok(text().includes("Store construction fixture"), "the Store startup record was not written");
    assert.ok(!text().includes(storeOnly), "a persisted Store-only value escaped before any Store access");
    assert.ok(registry!.values().includes(storeOnly), "the initial Store value was not registered at startup");
    assert.ok(text().includes("public startup detail"), "ordinary startup text was hidden");
    for (const [index, name] of ["store.json", "store.key"].entries()) {
      assert.ok(readFileSync(join(layout(home).secrets, name)).equals(initialStore[index]!),
        "startup modified the persisted credential store");
    }
  }
  assert.ok(!text().includes(initial), "a config secret escaped the queued startup log before any store read");
  assert.ok(!text().includes(moduleSecret), "an installed module annotation was ignored before startup logs");
  assert.ok(!text().includes(query), "a URL query value escaped startup logging");
  assert.ok(text().includes("relay.example.test/public/path"), "a public endpoint host or path was hidden");
  assert.ok(registry!.values().includes(initial));
  assert.ok(!registry!.values().includes(endpoint));
  assert.ok(!registry!.values().includes("relay.example.test"));
  const stop = source!.onChange(() => logger!.warn("accepted configuration fixture", { ordinary: rotated }));
  config.engine.merging = { headers: { ordinary: rotated } };
  config.providers.fixture = { ...config.providers.fixture as object, profile: {
    ...(config.providers.fixture as { profile: object }).profile, extra_headers: { "X-Ordinary-Name": rotated },
  } };
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  source!.current();
  assert.ok(!text().includes(rotated), "a listener logged a new secret before registration");
  assert.ok(!redactProtocolOutput(`echo ${rotated} ${query}`, "mcp", registry!).includes(rotated));
  stop();
  const added = randomUUID();
  mkdirSync(join(home, "modules/added"), { recursive: true });
  writeFileSync(join(home, "modules/added/index.js"), "export {};\n");
  writeFileSync(join(home, "modules/added/module.json"), JSON.stringify({ name: "added", version: "0.1.0", apiVersion: "1",
    entry: "index.js", scope: "installation", priority: 500, configSchema: {
      properties: { ordinary: { type: "string", "x-sensitive": true } },
    } }));
  let addedApplied = false;
  const stopAdded = source!.onChange((_previous, next) => {
    if (!next.modules.added) return;
    logger!.warn("new module configuration fixture", { ordinary: added });
    addedApplied = true;
  });
  config.modules.added = { enabled: false, ordinary: added };
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  source!.current();
  const deadline = Date.now() + 3_000;
  while (!addedApplied) {
    assert.ok(Date.now() < deadline, "module policy preparation did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(registry!.values().includes(added), "a newly installed module's secret was not registered before its config listener");
  assert.ok(!text().includes(added), "a new module value reached a log before policy loading");
  stopAdded();
  for (let index = 0; index < 300; index++) registry!.register(randomUUID());
  logger!.warn("the Engine still holds its build configuration until restart", { ordinary: initial });
  assert.ok(!text().includes(initial), "a running Core build's credential was retired while the Engine still holds it");
  logger!.warn("the provider composition still holds its initial profile", { ordinary: providerSecret });
  assert.ok(!text().includes(providerSecret), "a running provider's initial header was retired before restart");
  await core.stop();
  for (const secret of [initial, rotated, query, moduleSecret]) assert.ok(!text().includes(secret));
} finally {
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
