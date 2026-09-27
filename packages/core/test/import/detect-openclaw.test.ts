import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { targetIdentity } from "../../src/import/identity.ts";
import { detectOpenclaw, resolveOpenclawRoot } from "../../src/import/sources/openclaw.ts";
import { ImportError, type SourceReport } from "../../src/import/types.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { CONTENT_MARKER, FAKE_TOKEN, lanceStore, openclawFixture, SHARED_KEY, type OpenclawFixture } from "./fixtures.ts";
import { treeDigest } from "./tree.ts";

const ctxFor = (source: string | undefined, env: NodeJS.ProcessEnv = {}, homedir = "/nonexistent-home") => {
  const home = tempDir("p1b-imp-home-");
  return { sourceType: "openclaw" as const, source, env, homedir, home, target: targetIdentity(home) };
};

describe("OpenClaw source root", () => {
  it("resolves --source, OPENCLAW_STATE_DIR, OPENCLAW_PROFILE, OPENCLAW_HOME and the default in that order", () => {
    const h = "/home/u";
    assert.equal(resolveOpenclawRoot({ source: "/x", env: { OPENCLAW_STATE_DIR: "/y" }, homedir: h }).root, "/x");
    assert.deepEqual(resolveOpenclawRoot({ env: { OPENCLAW_STATE_DIR: "/y", OPENCLAW_PROFILE: "p" }, homedir: h }), { root: "/y", resolvedFrom: "env:OPENCLAW_STATE_DIR", configPath: "/y/openclaw.json" });
    assert.equal(resolveOpenclawRoot({ env: { OPENCLAW_PROFILE: "work" }, homedir: h }).root, "/home/u/.openclaw-work");
    assert.equal(resolveOpenclawRoot({ env: { OPENCLAW_HOME: "/alt" }, homedir: h }).root, "/alt/.openclaw");
    assert.equal(resolveOpenclawRoot({ env: {}, homedir: h }).root, "/home/u/.openclaw");
    assert.equal(resolveOpenclawRoot({ env: { OPENCLAW_CONFIG_PATH: "/c/oc.json" }, homedir: h }).configPath, "/c/oc.json");
    assert.throws(() => resolveOpenclawRoot({ env: { OPENCLAW_PROFILE: "../x" }, homedir: h }), ImportError);
  });
});

describe("detectOpenclaw on the synthetic fixture", () => {
  let fx: OpenclawFixture; let r: SourceReport; let beforeDigest: string;
  before(async () => {
    fx = await openclawFixture();
    beforeDigest = treeDigest(fx.base);
    r = await detectOpenclaw(ctxFor(fx.root));
  });
  after(() => fx.close());

  it("leaves the source byte-identical while its cache database stays open in WAL mode", () => {
    assert.equal(treeDigest(fx.base), beforeDigest);
  });
  it("reads the release and the state schema", () => {
    assert.deepEqual(r.version, { release: "2026.9.5", stateSchema: 17, configVersion: null, sessionsSchema: null, supported: true, warnings: [] });
  });
  it("lists agents with workspaces", () => {
    const byId = Object.fromEntries(r.agents.map((a) => [a.agentId, a]));
    assert.deepEqual(Object.keys(byId), ["alpha", "beta"]);
    assert.equal(byId.alpha!.workspace, join(fx.root, "ws-alpha"));
    assert.equal(byId.alpha!.workspaceSource, "config");
    assert.equal(byId.beta!.workspace, join(fx.root, "workspace-beta"));
    assert.deepEqual(byId.alpha!.foundIn, ["config", "directory"]);
  });
  it("finds the plugin, its version and the stores", () => {
    assert.equal(r.plur1bus.installed, true);
    assert.equal(r.plur1bus.plugin?.version, "7.16.11");
    assert.deepEqual(r.plur1bus.stores.map((s) => s.storeId).sort(), ["agent:alpha", "agent:beta", `shared:workspaces:${SHARED_KEY}`]);
    assert.equal(r.plur1bus.storeRoot?.layout, "legacy-flat");
  });
  it("gives alpha two identities (cache evidence) and a mismatch verdict", () => {
    const alpha = r.plur1bus.stores.find((s) => s.storeId === "agent:alpha")!;
    assert.equal(alpha.rows, 3);
    assert.deepEqual(alpha.identity.fields.dimension, { value: 384, source: "vector-schema" });
    assert.equal(alpha.identity.fields.model.source, "config");
    assert.equal(alpha.identity.fields.revision.source, "model-cache");
    assert.equal(alpha.identity.distinctIdentities, 2);
    assert.ok(alpha.identity.reasons.includes("multiple-identities"));
    assert.equal(alpha.identity.comparison.verdict, "mismatch");
    assert.equal(alpha.identity.plannedAction, "re-embedding-migration");
  });
  it("marks beta's 768-d schema against the 384-d config as a dimension conflict", () => {
    const beta = r.plur1bus.stores.find((s) => s.storeId === "agent:beta")!;
    assert.deepEqual(beta.identity.fields.dimension, { value: 768, source: "vector-schema", note: "other claims: config=384" });
    assert.ok(beta.identity.reasons.includes("dimension-conflict"));
    assert.equal(beta.identity.plannedAction, "re-embedding-migration");
  });
  it("matches the shared pool (one identity, every field confirmed)", () => {
    const shared = r.plur1bus.stores.find((s) => s.kind === "shared")!;
    assert.equal(shared.identity.comparison.verdict, "match", JSON.stringify(shared.identity.comparison));
    assert.equal(shared.identity.plannedAction, "take-over");
  });
  it("reports the Cohere reranker as remote, not fatal", () => {
    assert.equal(r.rerankers.length, 1);
    const rr = r.rerankers[0]!;
    assert.deepEqual([rr.provider, rr.model, rr.locality, rr.licenceClass, rr.plannedAction], ["cohere", "rerank-v3.5", "remote", "remote-service-terms", "report-only"]);
    assert.equal(rr.comparison.verdict, "mismatch");
  });
  it("lists skill roots in precedence order", () => {
    const tiers = r.skillRoots.map((s) => s.tier);
    assert.deepEqual([...new Set(tiers)], ["extra", "workshop", "managed", "project", "workspace"]);
  });
  it("reports secrets by presence and key name only", () => {
    assert.deepEqual(r.secrets.envKeys, [{ file: ".env", keys: ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY"] }]);
    assert.deepEqual(r.secrets.files.map((f) => f.kind).sort(), ["auth-store", "credential-store", "dotenv", "legacy-auth-profiles"]);
    const paths = Object.fromEntries(r.secrets.configKeys.map((k) => [k.path, k.form]));
    assert.equal(paths["models.providers.anthropic:default.apiKey"], "inline");
    assert.equal(paths["models.providers.openai:env.apiKey"], "env-ref");
    assert.equal(paths["plugins.entries.memory-lancedb-namespaced.config.reranker.apiKey"], "inline");
  });
  it("never carries the fake token or memory content", () => {
    const s = JSON.stringify(r);
    assert.ok(!s.includes(FAKE_TOKEN), "fake token leaked");
    assert.ok(!s.includes(CONTENT_MARKER), "content leaked");
  });
});

describe("detectOpenclaw on a store with unknown metadata", () => {
  it("knows only the vector-schema dimension and plans a re-embedding migration", async () => {
    const d = tempDir("p1b-imp-");
    writeFileSync(join(d, "openclaw.json"), "{ meta: { lastTouchedVersion: '2026.9.5' }, plugins: { entries: { 'memory-lancedb-namespaced': { config: {} } } } }");
    await lanceStore(join(d, "memory", "lancedb-namespaced", "main"), 768, 1);
    const before = treeDigest(d);
    const r = await detectOpenclaw(ctxFor(d));
    const s = r.plur1bus.stores[0]!;
    assert.equal(s.storeId, "agent:main");
    assert.deepEqual(s.identity.fields.dimension, { value: 768, source: "vector-schema" });
    for (const k of ["provider", "model", "revision", "artefactHash", "quantization"] as const) assert.equal(s.identity.fields[k].source, "unknown", k);
    assert.equal(s.identity.distinctIdentities, 1);
    assert.equal(s.identity.comparison.verdict, "mismatch");
    assert.equal(s.identity.comparison.fields.model, "unknown");
    assert.equal(s.identity.plannedAction, "re-embedding-migration");
    assert.equal(treeDigest(d), before);
  });
});

describe("detectOpenclaw refusals", () => {
  const code = async (p: Promise<unknown>) => { try { await p; return "resolved"; } catch (e) { return `${(e as ImportError).code}/${(e as ImportError).reason}`; } };
  it("refuses a missing directory, an empty directory and an unparseable config", async () => {
    const d = tempDir("p1b-imp-");
    assert.equal(await code(detectOpenclaw(ctxFor(join(d, "nope")))), "E_SOURCE_NOT_FOUND/source-missing");
    assert.equal(await code(detectOpenclaw(ctxFor(d))), "E_SOURCE_NOT_FOUND/not-an-openclaw-state-dir");
    writeFileSync(join(d, "openclaw.json"), "{ nope");
    assert.equal(await code(detectOpenclaw(ctxFor(d))), "E_SOURCE_UNSUPPORTED/config-unparseable");
  });
  it("refuses when no version marker is readable", async () => {
    const d = tempDir("p1b-imp-");
    writeFileSync(join(d, "openclaw.json"), "{ agents: {} }");
    assert.equal(await code(detectOpenclaw(ctxFor(d))), "E_SOURCE_UNSUPPORTED/version-undeterminable");
  });
  it("accepts a config-only install without PLUR1BUS", async () => {
    const d = tempDir("p1b-imp-");
    mkdirSync(join(d, "workspace"));
    writeFileSync(join(d, "openclaw.json"), "{ meta: { lastTouchedVersion: '2026.9.5' } }");
    const r = await detectOpenclaw(ctxFor(d));
    assert.equal(r.plur1bus.installed, false);
    assert.deepEqual(r.rerankers, []);
    assert.deepEqual(r.agents.map((a) => a.agentId), ["main"]);
  });
});
