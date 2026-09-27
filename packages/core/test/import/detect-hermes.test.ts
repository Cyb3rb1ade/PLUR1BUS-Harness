import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { targetIdentity } from "../../src/import/identity.ts";
import { detectHermes, resolveHermesRoot } from "../../src/import/sources/hermes.ts";
import type { ImportError, SourceReport } from "../../src/import/types.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { CONTENT_MARKER, FAKE_TOKEN, hermesFixture, type HermesFixture } from "./fixtures.ts";
import { treeDigest } from "./tree.ts";

const ctxFor = (source: string | undefined, profile?: string, env: NodeJS.ProcessEnv = {}) => {
  const home = tempDir("p1b-imp-home-");
  return { sourceType: "hermes" as const, source, profile, env, homedir: "/nonexistent-home", home, target: targetIdentity(home) };
};

describe("Hermes source", () => {
  let fx: HermesFixture; let r: SourceReport; let digest: string;
  before(async () => { fx = hermesFixture(); digest = treeDigest(fx.base); r = await detectHermes(ctxFor(fx.root)); });

  it("resolves --source, HERMES_HOME and the default", () => {
    const [s, h, u] = [resolve("/s"), resolve("/h"), resolve("/u")];
    assert.equal(resolveHermesRoot({ source: s, env: { HERMES_HOME: h }, homedir: u }).root, s);
    assert.deepEqual(resolveHermesRoot({ env: { HERMES_HOME: h }, homedir: u }), { root: h, resolvedFrom: "env:HERMES_HOME" });
    assert.equal(resolveHermesRoot({ env: {}, homedir: u }).root, join(u, ".hermes"));
  });
  it("leaves the source byte-identical", () => assert.equal(treeDigest(fx.base), digest));
  it("reads config and sessions versions", () => {
    assert.equal(r.version.configVersion, 45);
    assert.equal(r.version.sessionsSchema, 30);
    assert.equal(r.version.supported, true);
  });
  it("makes the root and each profile an agent", () => {
    assert.deepEqual(r.agents.map((a) => a.agentId), ["default", "work"]);
  });
  it("lists skill roots incl. the external dir", () => {
    assert.deepEqual(r.skillRoots.map((s) => [s.tier, s.agentId]), [["external", "default"], ["profile", "default"], ["profile", "work"]]);
    assert.equal(r.skillRoots[0]!.dir, fx.external);
  });
  it("reports secrets by presence and key name only", () => {
    assert.deepEqual(r.secrets.envKeys, [{ file: ".env", keys: ["OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN"] }]);
    assert.deepEqual(r.secrets.files.map((f) => f.path), [".env", "auth.json"]);
    assert.deepEqual(r.secrets.configKeys, [{ path: "config.yaml:model.api_key", form: "inline" }]);
  });
  it("has no PLUR1BUS store or reranker and notes M7 entities by presence", () => {
    assert.equal(r.plur1bus.installed, false);
    assert.deepEqual(r.rerankers, []);
    assert.deepEqual([r.other.soul, r.other.memoryFiles, r.other.cronFiles, r.other.sessionsDb], [2, 1, 1, true]);
  });
  it("never carries the fake token or content", () => {
    const s = JSON.stringify(r);
    assert.ok(!s.includes(FAKE_TOKEN));
    assert.ok(!s.includes(CONTENT_MARKER));
  });
  it("narrows to one profile with --profile", async () => {
    const p = await detectHermes(ctxFor(fx.root, "work"));
    assert.deepEqual(p.agents.map((a) => a.agentId), ["work"]);
    assert.deepEqual(p.skillRoots.map((s) => s.agentId), ["work"]);
  });
});

describe("Hermes refusals", () => {
  const code = async (p: Promise<unknown>) => { try { await p; return "resolved"; } catch (e) { return `${(e as ImportError).code}/${(e as ImportError).reason}`; } };
  it("refuses an empty dir, a missing profile and an unreadable config version", async () => {
    const d = tempDir("p1b-imp-");
    assert.equal(await code(detectHermes(ctxFor(d))), "E_SOURCE_NOT_FOUND/not-a-hermes-home");
    writeFileSync(join(d, "config.yaml"), "model: x\n");
    assert.equal(await code(detectHermes(ctxFor(d))), "E_SOURCE_UNSUPPORTED/config-version-unreadable");
    assert.equal(await code(detectHermes(ctxFor(d, "../etc"))), "E_SOURCE_NOT_FOUND/profile-missing");
  });
  it("warns on a newer config version", async () => {
    const d = tempDir("p1b-imp-");
    writeFileSync(join(d, "config.yaml"), "_config_version: 99\n");
    const r = await detectHermes(ctxFor(d));
    assert.equal(r.version.supported, false);
    assert.match(r.version.warnings[0]!, /newer than the tested 45/);
  });
});
