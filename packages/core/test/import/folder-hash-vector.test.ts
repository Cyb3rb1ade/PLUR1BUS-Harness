// The shared vector for the skill folder hash `plur1bus-skill-sha256/v1`: the Rust port in `crates/plur1bus-ext`
// (`skill_folder_hash`) reads the same directory and the same `expected.json` (X1-R14). The TS implementation is the
// reference: `expected.json` is generated from it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { folderHash, scanSkill } from "../../src/import/skills-scan.ts";

const dir = fileURLToPath(new URL("../../../../crates/plur1bus-ext/tests/fixtures/skill-hash/", import.meta.url));
const expected = JSON.parse(readFileSync(`${dir}expected.json`, "utf8")) as { algorithm: string; sha256: string; files: Record<string, string> };

describe("skill folder hash vector", () => {
  it("folderHash over the fixture directory equals expected.json", () => {
    const scanned = scanSkill(dir, { tier: "t", agentId: null, precedence: 1 });
    // expected.json sits in the directory it describes and is not part of the skill.
    const entries = scanned.entries.filter((e) => e.rel !== "expected.json");
    assert.equal(expected.algorithm, "plur1bus-skill-sha256/v1");
    assert.deepEqual(Object.fromEntries(entries.map((e) => [e.rel, e.sha256])), expected.files);
    assert.equal(folderHash(entries), expected.sha256);
  });
});
