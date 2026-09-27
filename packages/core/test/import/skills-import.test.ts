import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderRollback, renderSkills } from "../../src/import/render.ts";
import { importSkills, rollback, type SkillsOptions, type SkillsReport } from "../../src/import/skills-import.ts";
import { DEFAULT_MAX_SKILL_BYTES } from "../../src/import/skills-scan.ts";
import { readIndex } from "../../src/import/skills-registry.ts";
import type { ImportError } from "../../src/import/types.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { CONTENT_MARKER, FAKE_TOKEN, harnessHome, hermesFixture, openclawFixture, write, type OpenclawFixture } from "./fixtures.ts";
import { treeDigest } from "./tree.ts";

const opts = (source: string, home: string, over: Partial<SkillsOptions> = {}): SkillsOptions => ({
  sourceType: "openclaw", source, home, env: {}, homedir: "/nonexistent-home", apply: false, enable: false, onConflict: "skip", maxBytes: DEFAULT_MAX_SKILL_BYTES, ...over,
});
const run = (o: SkillsOptions) => importSkills(o, renderSkills);
const outcomes = (r: SkillsReport) => Object.fromEntries(r.skills.map((s) => [`${s.id}@${s.tier}${s.agentId ? `/${s.agentId}` : ""}`, s.outcome]));
const errCode = async (p: Promise<unknown> | (() => unknown)) => {
  try { await (typeof p === "function" ? p() : p); return "ok"; } catch (e) { return `${(e as ImportError).code}/${(e as ImportError).reason}`; }
};

describe("skills import", () => {
  let fx: OpenclawFixture; let srcDigest: string;
  before(async () => { fx = await openclawFixture(); srcDigest = treeDigest(fx.base); });
  after(() => { const same = treeDigest(fx.base) === srcDigest; fx.close(); assert.ok(same, "source changed"); });

  it("dry-run writes nothing to the home or the source", async () => {
    const home = harnessHome();
    const before = treeDigest(home);
    const r = await run(opts(fx.root, home));
    assert.equal(r.mode, "dry-run");
    assert.equal(r.reportPath, null);
    assert.ok(r.skills.every((s) => s.outcome === "planned"));
    assert.equal(treeDigest(home), before);
    assert.equal(treeDigest(fx.base), srcDigest);
  });

  it("apply imports disabled skills, skips the conflict, never copies secrets or escaped targets; a second run writes nothing", async () => {
    const home = harnessHome();
    const r = await run(opts(fx.root, home, { apply: true }));
    assert.equal(r.status, "completed");
    assert.deepEqual(outcomes(r), {
      "escape@workspace/alpha": "imported", "notes@workspace/alpha": "imported", "runner@workspace/alpha": "imported",
      "notes@workspace/beta": "skipped", "conflict@managed": "skipped", "ws-made@workshop/alpha": "imported", "extra-one@extra": "imported",
    });
    const idx = readIndex(home);
    const runner = idx.skills.find((s) => s.id === "runner")!;
    assert.deepEqual(Object.keys(runner).sort(), ["enabled", "id", "importedAt", "sha256", "source", "sourcePath"]);
    assert.deepEqual([runner.enabled, runner.source], [false, "openclaw"]);
    assert.equal(idx.skills.find((s) => s.id === "conflict")!.note, "kept", "unknown fields of foreign entries survive");
    assert.equal(readFileSync(join(home, "skills", "conflict", "SKILL.md"), "utf8").includes("harness version"), true);
    assert.ok(!existsSync(join(home, "skills", "escape", ".env")));
    assert.ok(!existsSync(join(home, "skills", "escape", "leak.txt")));
    assert.ok(existsSync(join(home, "skills", "escape", "alias.md")));
    assert.ok((statSync(join(home, "skills", "runner", "scripts", "run.sh")).mode & 0o100) !== 0);
    assert.ok(!existsSync(join(home, "skills", ".staging")));
    assert.ok(existsSync(join(home, "imports", r.runId, "report.json")) && existsSync(join(home, "imports", r.runId, "report.txt")));
    for (const text of [JSON.stringify(r), renderSkills(r), readFileSync(r.reportPath!, "utf8")]) {
      assert.ok(!text.includes(FAKE_TOKEN), "token leaked");
      assert.ok(!text.includes(CONTENT_MARKER), "content leaked");
    }
    const afterFirst = treeDigest(join(home, "skills"));
    const again = await run(opts(fx.root, home, { apply: true }));
    assert.ok(again.skills.every((s) => s.outcome === "skipped"), JSON.stringify(outcomes(again)));
    assert.equal(treeDigest(join(home, "skills")), afterFirst, "second run wrote to skills/");
  });

  it("converges after an interrupted apply (folder in place but not indexed, leftover staging)", async () => {
    const home = harnessHome();
    cpSync(join(fx.root, "ws-alpha", "skills", "notes"), join(home, "skills", "notes"), { recursive: true });
    write(join(home, "skills", ".staging", "runner-dead", "SKILL.md"), "partial");
    const r = await run(opts(fx.root, home, { apply: true }));
    assert.equal(outcomes(r)["notes@workspace/alpha"], "adopted");
    assert.ok(!existsSync(join(home, "skills", ".staging")));
    assert.equal(readIndex(home).skills.filter((s) => s.id === "notes").length, 1);
  });

  it("renames or replaces on conflict, and --enable enables", async () => {
    const home = harnessHome();
    const r = await run(opts(fx.root, home, { apply: true, onConflict: "rename", enable: true }));
    const conflict = r.skills.find((s) => s.id === "conflict")!;
    assert.deepEqual([conflict.outcome, conflict.targetId], ["renamed", "conflict-openclaw"]);
    const beta = r.skills.find((s) => s.id === "notes" && s.agentId === "beta")!;
    assert.deepEqual([beta.outcome, beta.targetId], ["renamed", "notes-openclaw"]);
    assert.equal(readIndex(home).skills.find((s) => s.id === "conflict-openclaw")!.enabled, true);

    const home2 = harnessHome();
    const r2 = await run(opts(fx.root, home2, { apply: true, onConflict: "replace" }));
    const c2 = r2.skills.find((s) => s.id === "conflict")!;
    assert.equal(c2.outcome, "replaced");
    assert.ok(readFileSync(join(c2.backupPath!, "SKILL.md"), "utf8").includes("harness version"));
    assert.ok(readFileSync(join(home2, "skills", "conflict", "SKILL.md"), "utf8").includes("clashes with the harness"));
    assert.equal(r2.skills.find((s) => s.id === "notes" && s.agentId === "beta")!.outcome, "skipped", "replace never overwrites a skill of the same run");
  });

  it("refuses while another live process holds the lock", async () => {
    const home = harnessHome();
    mkdirSync(join(home, "imports"), { recursive: true });
    writeFileSync(join(home, "imports", ".lock"), JSON.stringify({ pid: process.ppid }));
    assert.equal(await errCode(run(opts(fx.root, home, { apply: true }))), "E_LOCKED/skills-locked");
    writeFileSync(join(home, "imports", ".lock"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    assert.equal(await errCode(run(opts(fx.root, home, { apply: true }))), "ok", "a dead holder's lock is taken over");
  });

  it("rolls back exactly, refuses a stale or tampered rollback", async () => {
    const home = harnessHome();
    const before = treeDigest(join(home, "skills"), { mtime: false });
    const r = await run(opts(fx.root, home, { apply: true }));
    const dry = rollback({ home, reportPath: r.reportPath!, apply: false, sourceType: "openclaw" });
    assert.equal(dry.status, "planned");
    assert.deepEqual(dry.changes.filter((c) => c.change === "remove").map((c) => c.id), ["escape", "extra-one", "notes", "runner", "ws-made"]);
    assert.match(renderRollback(dry), /DRY RUN/);
    assert.notEqual(treeDigest(join(home, "skills"), { mtime: false }), before, "dry-run rolled back");

    assert.equal(await errCode(() => rollback({ home, reportPath: r.reportPath!, apply: true, sourceType: "hermes" })), "E_ROLLBACK_INVALID/source-mismatch");
    const copy = join(tempDir("p1b-imp-"), "report.json");
    cpSync(r.reportPath!, copy);
    assert.equal(await errCode(() => rollback({ home, reportPath: copy, apply: true, sourceType: "openclaw" })), "E_ROLLBACK_INVALID/report-outside-home");
    const tampered = JSON.parse(readFileSync(r.reportPath!, "utf8"));
    const orig = readFileSync(r.reportPath!, "utf8");
    writeFileSync(r.reportPath!, JSON.stringify({ ...tampered, snapshot: { path: join(home, ".."), existed: true } }));
    assert.equal(await errCode(() => rollback({ home, reportPath: r.reportPath!, apply: true, sourceType: "openclaw" })), "E_ROLLBACK_INVALID/snapshot-invalid");
    writeFileSync(r.reportPath!, JSON.stringify({ ...tampered, runId: "../../etc" }));
    assert.equal(await errCode(() => rollback({ home, reportPath: r.reportPath!, apply: true, sourceType: "openclaw" })), "E_ROLLBACK_INVALID/run-id-invalid");
    writeFileSync(r.reportPath!, orig);

    const done = rollback({ home, reportPath: r.reportPath!, apply: true, sourceType: "openclaw" });
    assert.equal(done.status, "completed");
    assert.equal(treeDigest(join(home, "skills"), { mtime: false }), before, "not restored exactly");
    assert.equal(await errCode(() => rollback({ home, reportPath: r.reportPath!, apply: true, sourceType: "openclaw" })), "E_ROLLBACK_INVALID/already-rolled-back");

    const r1 = await run(opts(fx.root, home, { apply: true }));
    const hx = hermesFixture();
    await importSkills({ ...opts(hx.root, home, { apply: true }), sourceType: "hermes" }, renderSkills);
    assert.equal(await errCode(() => rollback({ home, reportPath: r1.reportPath!, apply: true, sourceType: "openclaw" })), "E_ROLLBACK_STALE/skills-changed-since");
  });

  it("rolls back a first import into a home without skills/ by removing skills/", async () => {
    const home = tempDir("p1b-imp-home-");
    const r = await run(opts(fx.root, home, { apply: true }));
    assert.equal(r.snapshot!.existed, false);
    rollback({ home, reportPath: r.reportPath!, apply: true, sourceType: "openclaw" });
    assert.ok(!existsSync(join(home, "skills")));
  });
});
