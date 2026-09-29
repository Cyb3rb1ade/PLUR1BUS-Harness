// The skills index gains one additive entry field for the extensions layer: `package: { id, version, trust } | null`
// (X1-R14). The Rust writer in `crates/plur1bus/src/ext/index.rs` shares this file with the importer; both sides read
// `test/fixtures/skills-index-ext.json` (`input` is what the Rust reader parses, `outputText` is the exact bytes both
// writers produce for it).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { indexPath, readIndex, writeIndex } from "../../src/import/skills-registry.ts";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/skills-index-ext.json", import.meta.url)), "utf8")) as {
  input: unknown;
  outputText: string;
};

function withHome(text: string, fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "p1b-skills-ext-"));
  try {
    mkdirSync(join(home, "skills"));
    writeFileSync(indexPath(home), text);
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("skills index with extension entries", () => {
  it("readIndex accepts the ext writer's output (entries with `package`, source `file`)", () => {
    withHome(fixture.outputText, (home) => {
      const idx = readIndex(home);
      assert.deepEqual(idx.skills.map((e) => e.id), ["alpha", "demo-skill", "zeta"]);
      const zeta = idx.skills.find((e) => e.id === "zeta");
      assert.equal(zeta?.source, "file");
      assert.deepEqual(zeta?.package, { id: "local/zeta", version: "1.2.0", trust: "unsigned" });
      assert.equal(idx.skills.find((e) => e.id === "alpha")?.package, null);
    });
  });

  it("writeIndex after readIndex keeps `package` on every entry and reproduces the ext writer's bytes", () => {
    withHome(fixture.outputText, (home) => {
      writeIndex(home, readIndex(home));
      const text = readFileSync(indexPath(home), "utf8");
      assert.equal(text, fixture.outputText);
      const back = JSON.parse(text) as { skills: Array<Record<string, unknown>> };
      for (const e of back.skills) assert.ok("package" in e, `${String(e.id)} lost its package field`);
    });
  });

  it("the fixture's input half sorts into the output half", () => {
    withHome(JSON.stringify(fixture.input), (home) => {
      writeIndex(home, readIndex(home));
      assert.equal(readFileSync(indexPath(home), "utf8"), fixture.outputText);
    });
  });
});
