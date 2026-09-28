import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { findSkillDirs, folderHash, scanSkill, scanSkills } from "../../src/import/skills-scan.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { FAKE_TOKEN, linkDir, needsFileSymlinks, POSIX, skill, write } from "./fixtures.ts";

const R = { tier: "t", agentId: null, precedence: 1 };

describe("skill scan", () => {
  it("hashes with plur1bus-skill-sha256/v1", () => {
    const d = tempDir("p1b-imp-");
    write(join(d, "s", "SKILL.md"), "A");
    write(join(d, "s", "b", "c.txt"), "B");
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    const expected = `sha256:${createHash("sha256").update(`SKILL.md\0${sha("A")}\nb/c.txt\0${sha("B")}\n`).digest("hex")}`;
    const s = scanSkill(join(d, "s"), R);
    assert.equal(s.sha256, expected);
    assert.equal(folderHash(s.entries), expected);
  });
  it("detects scripts by extension, shebang and scripts/", () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "a"), "a", "x"); write(join(d, "a", "tool"), "#!/usr/bin/env node\n");
    skill(join(d, "b"), "b", "x"); write(join(d, "b", "x.py"), "print(1)\n");
    skill(join(d, "d"), "d", "x"); write(join(d, "d", "scripts", "notes.txt"), "data");
    skill(join(d, "e"), "e", "plain");
    assert.deepEqual(["a", "b", "d", "e"].map((n) => scanSkill(join(d, n), R).hasScripts), [true, true, true, false]);
  });
  it("detects scripts by the exec bit", { skip: POSIX ? false : "Windows has no exec bit" }, () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "c"), "c", "x"); write(join(d, "c", "bin"), "data", 0o755);
    assert.equal(scanSkill(join(d, "c"), R).hasScripts, true);
  });
  it("skips escaping symlinks, directory links and secret files; keeps inside file links", needsFileSymlinks, () => {
    const d = tempDir("p1b-imp-");
    write(join(d, "outside.txt"), FAKE_TOKEN);
    skill(join(d, "s"), "s", "x");
    symlinkSync(join(d, "outside.txt"), join(d, "s", "leak.txt"), "file");
    symlinkSync("SKILL.md", join(d, "s", "alias.md"), "file");
    mkdirSync(join(d, "s", "sub"));
    linkDir(join(d, "s", "sub"), join(d, "s", "loop"));
    write(join(d, "s", ".env"), `K=${FAKE_TOKEN}`);
    write(join(d, "s", "key.pem"), FAKE_TOKEN);
    write(join(d, "s", ".git", "HEAD"), "ref");
    const s = scanSkill(join(d, "s"), R);
    assert.deepEqual(s.skipped, { symlinkEscapes: ["leak.txt"], symlinkDirs: ["loop"], secretFiles: 2, vcs: 1 });
    assert.deepEqual(s.entries.map((e) => e.rel), ["SKILL.md", "alias.md"]);
    assert.deepEqual(s.problems, []);
  });
  it("treats a junction (directory link) like a symlink: inside is skipped as a directory link, outside as an escape", () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "s"), "s", "x");
    write(join(d, "s", "docs", "a.md"), "a");
    write(join(d, "secrets", "k.txt"), FAKE_TOKEN);
    linkDir(join(d, "s", "docs"), join(d, "s", "docs-again"));
    linkDir(join(d, "secrets"), join(d, "s", "outside"));
    const s = scanSkill(join(d, "s"), R);
    assert.deepEqual([s.skipped.symlinkDirs, s.skipped.symlinkEscapes], [["docs-again"], ["outside"]]);
    assert.deepEqual(s.entries.map((e) => e.rel), ["SKILL.md", "docs/a.md"]);
    assert.ok(!JSON.stringify(s).includes(FAKE_TOKEN));
  });
  it("refuses a folder over the cap and an invalid id", () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "big"), "big", "x"); write(join(d, "big", "blob"), "x".repeat(2048));
    const big = scanSkill(join(d, "big"), R, { maxBytes: 1024 });
    assert.deepEqual([big.problems, big.sha256, big.entries.length], [["too-large"], null, 0]);
    skill(join(d, "Bad Name"), "bad", "x");
    assert.deepEqual(scanSkill(join(d, "Bad Name"), R).problems, ["invalid-id"]);
  });
  it("lowercases ids, reads the frontmatter and cuts long descriptions", () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "MySkill"), "My Skill", "d".repeat(400));
    const s = scanSkill(join(d, "MySkill"), R);
    assert.equal(s.id, "myskill");
    assert.equal(s.name, "My Skill");
    assert.equal(s.description!.length, 300);
  });
  it("finds nested skills and follows a linked skill folder (junction on Windows)", () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "root", "cat", "nested"), "nested", "x");
    skill(join(d, "elsewhere", "linked"), "linked", "x");
    linkDir(join(d, "elsewhere", "linked"), join(d, "root", "linked"));
    skill(join(d, "root", ".hidden", "h"), "h", "x");
    assert.deepEqual(findSkillDirs(join(d, "root")).map((p) => relative(join(d, "root"), p).replaceAll("\\", "/")), ["cat/nested", "linked"]);
    const linked = scanSkill(join(d, "root", "linked"), R);
    assert.equal(linked.rootIsSymlink, true);
    assert.deepEqual(linked.problems, []);
  });
  it("orders by precedence and marks shadowed ids", () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "low", "x"), "x", "low");
    skill(join(d, "high", "x"), "x", "high");
    const s = scanSkills([{ dir: join(d, "low"), tier: "low", agentId: null, precedence: 1 }, { dir: join(d, "high"), tier: "high", agentId: null, precedence: 9 }]);
    assert.deepEqual(s.map((k) => [k.tier, k.shadowedBy]), [["high", null], ["low", join(d, "high", "x")]]);
  });
});
