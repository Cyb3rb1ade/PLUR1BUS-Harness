/** MM-3a preprocessing defaults and the model's hard audio window limit. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { defaults, validate, restartClassOf } from "../src/index.ts";

it("limits audio windows to thirty seconds globally and in sparse agent overrides", () => {
  for (const seconds of [30, 31, 3600]) {
    const global = defaults();
    global.memory.mediaEmbedding.audio.segmentSec = seconds;
    assert.equal(validate(global).ok, seconds <= 30, `global ${seconds}`);
    const agent = defaults();
    agent.agents.main = { memory: { mediaEmbedding: { audio: { segmentSec: seconds } } } };
    assert.equal(validate(agent).ok, seconds <= 30, `agent ${seconds}`);
  }
});

it("defaults new or unset backfill choices to manual and preserves an explicitly saved auto choice", () => {
  assert.equal(defaults().memory.mediaEmbedding.backfill, "manual");
  const existing = defaults();
  existing.memory.mediaEmbedding.backfill = "auto";
  const explicit = validate(existing);
  assert.ok(explicit.ok);
  assert.equal(explicit.config.memory.mediaEmbedding.backfill, "auto");
  delete (existing.memory.mediaEmbedding as Partial<typeof existing.memory.mediaEmbedding>).backfill;
  const unset = validate(existing);
  assert.ok(unset.ok);
  assert.equal(unset.config.memory.mediaEmbedding.backfill, "manual");
});

it("checks the fixed local catalog and effective inherited agent settings before a config write", () => {
  for (const invalid of [{ model: "unknown" }, { model: "constructor" }, { model: "__proto__" }, { dimensions: 129 }]) {
    const global = defaults();
    Object.assign(global.memory.mediaEmbedding, invalid);
    assert.equal(validate(global).ok, false);
    const agent = defaults();
    agent.agents.main = { memory: { mediaEmbedding: invalid } };
    assert.equal(validate(agent).ok, false);
  }
  const cfg = defaults();
  cfg.memory.mediaEmbedding.enabled = false;
  cfg.agents.main = { memory: { mediaEmbedding: { enabled: true, dimensions: 256 } } };
  assert.equal(validate(cfg).ok, true);
  cfg.agents.main.memory!.mediaEmbedding!.model = "unknown";
  assert.equal(validate(cfg).ok, false);
});

it("defaults to measured token budgets and q8 on every supported platform", () => {
  const media = defaults().memory.mediaEmbedding as unknown as Record<string, unknown>;
  assert.deepEqual(media.image, { softTokens: 140 });
  assert.equal((media.video as Record<string, unknown>).softTokens, 70);
  assert.deepEqual(media.dtypes, Object.fromEntries(
    ["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64", "win32-arm64"]
      .map(platform => [platform, { text: "q8", vision: "q8", audio: "q8" }]),
  ));
  assert.equal(restartClassOf("memory.mediaEmbedding.image.softTokens"), "core");
  const cfg = defaults() as unknown as { memory: { mediaEmbedding: Record<string, unknown> }; agents: Record<string, unknown> };
  cfg.agents.main = { memory: { mediaEmbedding: { image: { softTokens: 70 }, dtypes: { "win32-x64": { text: "q8" } } } } };
  assert.equal(validate(cfg).ok, true);
  cfg.agents.main = { memory: { mediaEmbedding: { dtypes: { "win32-x64": { audio: "q4" } } } } };
  assert.equal(validate(cfg).ok, false);
});
