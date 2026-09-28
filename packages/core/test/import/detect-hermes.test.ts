import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
    assert.deepEqual(resolveHermesRoot({ env: { HERMES_HOME: h }, homedir: u }), { root: h, resolvedFrom: "env:HERMES_HOME", profile: null });
    // The host's own default (G1): %LOCALAPPDATA%\hermes on Windows — here unset, so ~\AppData\Local\hermes.
    const def = process.platform === "win32" ? join(u, "AppData", "Local", "hermes") : join(u, ".hermes");
    assert.equal(resolveHermesRoot({ env: {}, homedir: u }).root, def);
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
  it("narrows to the profile a HERMES_HOME of <root>/profiles/<name> selects, and refuses a contradicting --profile", async () => {
    const p = await detectHermes(ctxFor(undefined, undefined, { HERMES_HOME: join(fx.root, "profiles", "work") }));
    assert.deepEqual([p.source.root, p.source.profile, p.agents.map((a) => a.agentId)], [fx.root, "work", ["work"]]);
    await assert.rejects(detectHermes(ctxFor(undefined, "other", { HERMES_HOME: join(fx.root, "profiles", "work") })), /profile-conflict|selects profile/);
  });
  it("narrows to one profile with --profile", async () => {
    const p = await detectHermes(ctxFor(fx.root, "work"));
    assert.deepEqual(p.agents.map((a) => a.agentId), ["work"]);
    assert.deepEqual(p.skillRoots.map((s) => s.agentId), ["work"]);
  });
});

describe("Hermes external skill dirs through the path mapper (G3)", () => {
  it("resolves relative dirs against the profile, expands the source-side environment and reports foreign paths", async () => {
    const d = tempDir("p1b-imp-");
    // A path in the other OS's syntax: foreign on this host whichever CI OS runs it.
    const foreign = process.platform === "win32" ? "/opt/tools/skills" : "C:\\Tools\\skills";
    writeFileSync(join(d, "config.yaml"), `_config_version: 45\nskills:\n  external_dirs:\n    - ${foreign}\n    - $EXT_SKILLS/more\n`);
    mkdirSync(join(d, "profiles", "work"), { recursive: true });
    writeFileSync(join(d, "profiles", "work", "config.yaml"), "_config_version: 45\nskills:\n  external_dirs:\n    - shared-skills\n");
    const r = await detectHermes(ctxFor(d, undefined, { EXT_SKILLS: join(d, "ext") }));
    const ext = r.skillRoots.filter((s) => s.tier === "external").map((s) => [s.agentId, s.dir]);
    assert.deepEqual(ext, [["default", join(d, "ext", "more")], ["work", join(d, "profiles", "work", "shared-skills")]]);
    assert.deepEqual(r.portability.unmapped, [{ key: "config.yaml:skills.external_dirs[0]", value: foreign, reason: "foreign-path" }]);
  });
});

describe("Hermes profile names on case-insensitive or Windows targets (G9)", () => {
  it("reports Work/work and names Windows cannot hold", async () => {
    const d = tempDir("p1b-imp-");
    writeFileSync(join(d, "config.yaml"), "_config_version: 45\n");
    // `con` only where the OS can hold it (on Windows it would leave a device-name directory Explorer cannot delete).
    for (const n of ["Work", "work", ...(process.platform === "win32" ? [] : ["con"])]) {
      try { mkdirSync(join(d, "profiles", n), { recursive: true }); } catch { /* a case-insensitive volume holds one of Work/work */ }
    }
    const names = (await detectHermes(ctxFor(d))).agents.map((a) => a.agentId).filter((n) => n !== "default");
    // What this volume could hold: Windows refuses `con`, a case-insensitive volume keeps one of Work/work.
    const expected: unknown[] = names.includes("Work") && names.includes("work") ? [{ kind: "case-collision", subject: "profiles", names: ["Work", "work"] }] : [];
    if (names.includes("con")) expected.push({ kind: "unportable-name", subject: "profiles", names: ["con"] });
    const onWin = await detectHermes({ ...ctxFor(d), targetPlatform: "win32" });
    assert.deepEqual(onWin.portability.problems, expected);
    assert.deepEqual((await detectHermes({ ...ctxFor(d), targetPlatform: "linux" })).portability.problems, []);
    if (names.includes("con")) assert.ok(onWin.warnings.some((w) => w.startsWith("unportable-name in profiles: con")));
    else console.log("# unportable-name on disk not asserted here: Windows cannot hold a profile named con (skills-hazards tests the rule)");
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
