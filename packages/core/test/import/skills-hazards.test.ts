// File-system hazards of skills across OSes (plugin-distribution spec §B.6, gaps G9/G10/G11): case collisions, names
// Windows cannot hold, CRLF/BOM twins, long paths. Target platform is injected, so the Windows and macOS rules run on
// every CI OS; the few cases that need two case-variant files on disk run only where the volume is case-sensitive.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderSkills } from "../../src/import/render.ts";
import { importSkills, planSkills } from "../../src/import/skills-import.ts";
import { caseCollisions, DEFAULT_MAX_SKILL_BYTES, folderTextHash, scanSkill, scanSkills, unportableName } from "../../src/import/skills-scan.ts";
import { readIndex } from "../../src/import/skills-registry.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { skill, write } from "./fixtures.ts";

const R = { tier: "t", agentId: null, precedence: 1 };
const caseSensitiveVolume = (() => {
  const d = tempDir("p1b-imp-case-");
  writeFileSync(join(d, "a"), "1");
  return !existsSync(join(d, "A"));
})();
const needsCaseSensitive = caseSensitiveVolume ? {} : { skip: "this volume is case-insensitive: two case-variant names cannot both exist" };
// Such names reach a Windows harness only from a POSIX source (WSL, a copy); creating them on Windows itself would
// leave device-name files Explorer cannot delete, so the on-disk cases run where the source OS can hold them.
const posixNames = process.platform === "win32" ? { skip: "reserved names and trailing dots come from POSIX sources; the pure rule is tested above" } : {};

describe("unportableName (Windows target)", () => {
  it("names reserved devices with any extension, trailing dots and spaces, and forbidden characters", () => {
    for (const n of ["CON", "con", "Prn.txt", "aux.tar.gz", "NUL", "com1", "COM9.log", "lpt1", "LPT9.md", "com¹"]) assert.equal(unportableName(n), "reserved-name", n);
    for (const n of ["notes.", "notes ", "a. "]) assert.equal(unportableName(n), "trailing-dot-or-space", JSON.stringify(n));
    for (const n of ["a<b", "a>b", "a:b", 'a"b', "a|b", "a?b", "a*b", "a\\b", "a\u0001b"]) assert.equal(unportableName(n), "invalid-character", JSON.stringify(n));
    for (const n of ["console.md", "com10", "lpt", "auxiliary", "SKILL.md", ".hidden", "Jürgen.md"]) assert.equal(unportableName(n), null, n);
  });
});

describe("caseCollisions", () => {
  it("finds files and directories that differ only by case or Unicode normalisation", () => {
    assert.deepEqual(caseCollisions(["README.md", "readme.md", "x"]), [["README.md", "readme.md"]]);
    assert.deepEqual(caseCollisions(["Docs/a.md", "docs/b.md"]), [["Docs", "docs"]]);
    assert.deepEqual(caseCollisions(["café.md", "café.md"]), [["café.md", "café.md"]]);
    assert.deepEqual(caseCollisions(["a/b.md", "a/c.md", "B.md"]), []);
  });
});

describe("scan problems per target platform (G9)", () => {
  it("refuses a skill with names Windows cannot hold only on a Windows target", posixNames, () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "s"), "s", "x");
    write(join(d, "s", "docs", "aux.md"), "x");
    write(join(d, "s", "notes."), "x");
    assert.deepEqual(scanSkill(join(d, "s"), R, { targetPlatform: "linux" }).problems, []);
    assert.deepEqual(scanSkill(join(d, "s"), R, { targetPlatform: "win32" }).problems, ["unportable-name:docs/aux.md", "unportable-name:notes."]);
  });
  it("refuses a skill id Windows cannot hold as a folder name", posixNames, () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "con"), "con", "x");
    assert.deepEqual(scanSkill(join(d, "con"), R, { targetPlatform: "win32" }).problems, ["unportable-name:con"]);
    assert.deepEqual(scanSkill(join(d, "con"), R, { targetPlatform: "darwin" }).problems, []);
  });
  it("refuses files that differ only by case on a case-insensitive target", needsCaseSensitive, () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "s"), "s", "x");
    write(join(d, "s", "README.md"), "a"); write(join(d, "s", "readme.md"), "b");
    assert.deepEqual(scanSkill(join(d, "s"), R, { targetPlatform: "linux" }).problems, []);
    for (const t of ["win32", "darwin"] as const) assert.deepEqual(scanSkill(join(d, "s"), R, { targetPlatform: t }).problems, ["case-collision:README.md|readme.md"], t);
  });
  it("names two skill folders of one root that differ only by case as a case collision, not a shadow", needsCaseSensitive, () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "root", "Notes"), "Notes", "x"); skill(join(d, "root", "notes"), "notes", "y");
    const s = scanSkills([{ dir: join(d, "root"), tier: "t", agentId: null, precedence: 1 }]);
    assert.deepEqual(s.map((k) => [k.id, k.problems]), [["notes", []], ["notes", ["case-collision:Notes|notes"]]]);
  });
  it("copies and hashes a skill nested past 300 characters", () => {
    const d = tempDir("p1b-imp-Jürgen-");
    let dir = join(d, "s");
    while (dir.length < 320) dir = join(dir, "deeply-nested-directory-name");
    skill(join(d, "s"), "s", "x");
    write(join(dir, "leaf.md"), "leaf");
    const s = scanSkill(join(d, "s"), R);
    assert.deepEqual(s.problems, []);
    assert.ok(s.entries.some((e) => e.rel.endsWith("leaf.md") && e.abs.length > 300));
  });
});

describe("text hash for CRLF/BOM twins (G10)", () => {
  const crlf = (t: string) => t.replaceAll("\n", "\r\n");
  it("is the v1 construction over CRLF→LF, BOM-stripped text and raw bytes otherwise", () => {
    const d = tempDir("p1b-imp-");
    write(join(d, "s", "SKILL.md"), `﻿${crlf("---\nname: s\n---\nbody\n")}`);
    writeFileSync(join(d, "s", "bin.dat"), Buffer.from([0, 13, 10, 1]));
    const s = scanSkill(join(d, "s"), R);
    const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
    const expected = `sha256:${createHash("sha256").update(`SKILL.md\0${sha("---\nname: s\n---\nbody\n")}\nbin.dat\0${sha(Buffer.from([0, 13, 10, 1]))}\n`).digest("hex")}`;
    assert.equal(s.textSha256, expected);
    assert.equal(folderTextHash(s.entries), expected);
    assert.notEqual(s.sha256, s.textSha256, "the byte hash (copy check) is unchanged");
  });
  it("matches a CRLF checkout with its LF twin: skip against the harness copy, adopt an unindexed folder", async () => {
    const d = tempDir("p1b-imp-");
    const body = "---\nname: notes\ndescription: n\n---\n# notes\n";
    write(join(d, "src", "skills", "notes", "SKILL.md"), crlf(body));
    write(join(d, "src", "openclaw.json"), "{ meta: { lastTouchedVersion: '2026.9.5' } }");
    const home = tempDir("p1b-imp-home-");
    write(join(home, "skills", "notes", "SKILL.md"), body);
    const r = await importSkills({ sourceType: "openclaw", source: join(d, "src"), home, env: {}, homedir: "/nonexistent-home", apply: true, enable: false, onConflict: "skip", maxBytes: DEFAULT_MAX_SKILL_BYTES }, renderSkills);
    const e = r.skills.find((s) => s.id === "notes")!;
    assert.deepEqual([e.action, e.reason, e.outcome], ["adopt", "folder-present-not-indexed", "adopted"]);
    const idx = readIndex(home).skills.find((s) => s.id === "notes")!;
    assert.equal(idx.sha256, scanSkill(join(home, "skills", "notes"), R).sha256, "the index records the bytes on disk");
    const again = await importSkills({ sourceType: "openclaw", source: join(d, "src"), home, env: {}, homedir: "/nonexistent-home", apply: false, enable: false, onConflict: "skip", maxBytes: DEFAULT_MAX_SKILL_BYTES }, renderSkills);
    const a = again.skills.find((s) => s.id === "notes")!;
    assert.deepEqual([a.action, a.reason], ["skip-identical", "line-endings-differ"]);
  });
  it("keeps index entries written before the text hash valid (byte hash only)", () => {
    const d = tempDir("p1b-imp-");
    skill(join(d, "src", "x"), "x", "x");
    const scanned = scanSkills([{ dir: join(d, "src"), tier: "t", agentId: null, precedence: 1 }]);
    const home = tempDir("p1b-imp-home-");
    mkdirSync(join(home, "skills"), { recursive: true });
    const idx = { version: 1, skills: [{ id: "x", source: "openclaw", sourcePath: "/old", sha256: scanned[0]!.sha256!, enabled: false, importedAt: "2026-09-27T00:00:00.000Z" }] };
    assert.deepEqual(planSkills(scanned, home, "openclaw", "skip", idx).map((p) => [p.action, p.reason]), [["import", "index-entry-without-folder"]]);
  });
});
