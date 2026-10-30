/** Source discovery needs effective target metadata, including valid remote embedding configurations, without inference. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults, validate } from "@plur1bus/config-schema";
import { targetIdentity } from "../../src/import/identity.ts";
import { readSource } from "../../src/import/source.ts";
import { createSourceRegistry } from "../../src/import/source-registry.ts";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { layout } from "../../src/paths.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const CANARY = "fixture-ambient-embedding-credential-never-returned";

it("characterization: retains unknown catalog fields for a custom local target without normalizing the execution pipeline", () => {
  const home = temp();
  const cfg = defaults();
  cfg.engine.embedding = { provider: "local-transformers", local: { model: "fixture/unpinned-custom-model", dimensions: 123 } };
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
  const target = targetIdentity(home);
  assert.equal(target.embedding.model.value, "fixture/unpinned-custom-model");
  assert.equal(target.embedding.dimension.value, 123);
  for (const key of ["revision", "artefactHash", "quantization"] as const) {
    assert.equal(target.embedding[key].source, "unknown");
  }
});

function fixture(provider: "openai" | "openrouter") {
  const home = temp();
  const source = temp();
  const cfg = defaults();
  const endpoint = provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined;
  cfg.engine.embedding = { provider, model: provider === "openai" ? "text-embedding-3-small" : "qwen/qwen3-embedding-8b",
    dimensions: provider === "openai" ? 1536 : 4096, apiKeyEnv: "OPENAI_API_KEY", ...(endpoint ? { baseUrl: endpoint } : {}) };
  cfg.memory.embedding = { privacyAck: { provider, acknowledgedAt: "2026-10-29T00:00:00Z", by: "owner",
    ...(endpoint ? { endpoint } : {}) } };
  assert.equal(validate(cfg).ok, true);
  assert.equal((buildEngineConfig(cfg, layout(home)).embedding as { provider: string }).provider, provider);
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
  writeFileSync(join(source, "openclaw.json"), '{"meta":{"lastTouchedVersion":"2026.9.5"},"agents":{"defaults":{"workspace":"./workspace"}}}');
  mkdirSync(join(source, "workspace"));
  writeFileSync(join(source, "workspace", "SOUL.md"), "private source persona");
  return { home, source, cfg, endpoint };
}

it("describes normalized remote target identity without local model assumptions or credential references", () => {
  for (const provider of ["openai", "openrouter"] as const) {
    const f = fixture(provider);
    const target = targetIdentity(f.home);
    assert.deepEqual(target.embedding.provider, { value: provider, source: "harness-config" });
    assert.equal(target.embedding.model.value, (f.cfg.engine.embedding as { model: string }).model);
    assert.equal(target.embedding.dimension.value, (f.cfg.engine.embedding as { dimensions: number }).dimensions);
    assert.equal(target.embedding.endpoint.value, f.endpoint ?? null);
    for (const key of ["revision", "artefactHash", "quantization", "prefixSchema", "normalization", "tokenCap"] as const) {
      assert.deepEqual(target.embedding[key], { value: null, source: "not-applicable" });
    }
    assert.equal(JSON.stringify(target).includes("OPENAI_API_KEY"), false);
  }
});

it("reads and seals a real source when the target uses a remote embedding provider, without requesting a key or network", async () => {
  const f = fixture("openai");
  const fetch = globalThis.fetch;
  const secret = process.env.OPENAI_API_KEY;
  let requests = 0;
  process.env.OPENAI_API_KEY = CANARY;
  globalThis.fetch = async () => { requests++; throw new Error("unexpected network request"); };
  try {
    const read = await readSource({ home: f.home, source: f.source, sourceType: "openclaw" });
    assert.equal(read.report.agents.length, 1);
    assert.equal(read.target.embedding.provider.value, "openai");
    const detected = await createSourceRegistry({ home: f.home }).detect({ kind: "path", family: "openclaw", path: f.source },
      { kind: "person", role: "owner", userId: "owner" });
    assert.equal(detected.agents[0]?.hasPersona, true);
    assert.equal(requests, 0);
    assert.equal(JSON.stringify({ read: read.report, target: read.target, detected }).includes(CANARY), false);
  } finally {
    globalThis.fetch = fetch;
    if (secret === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = secret;
  }
});
