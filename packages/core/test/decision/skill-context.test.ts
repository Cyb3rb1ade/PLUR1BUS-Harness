/** D69/D103 skill routing context and per-task fairness, without provider I/O. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichedSkillQuery, fairTaskSkills, isSkillFollowup } from "../../src/decision/skill-context.ts";
import type { SkillPick } from "../../src/decision/skills.ts";
import { CapabilityIndex } from "../../src/toolcall/capabilities.ts";

const pick = (name: string, source: SkillPick["source"] = "rule"): SkillPick => ({
  id: `skill:${name}`, name, description: name, source,
});
const names = (selected: readonly SkillPick[]) => selected.map(skill => skill.name);

test("previous user text and triage summaries make relevant skills discoverable for a terse current message", () => {
  const index = new CapabilityIndex();
  for (const [name, description] of [["rust", "Rust compiler"], ["docs", "documentation"], ["image", "photography"]]) {
    index.upsert({
      id: `skill:${name}`, name: name!, description: description!, category: "code.edit", kind: "skill",
      effect: "read", risk: "low", source: "first-party", version: "1",
    });
  }
  const query = enrichedSkillQuery({
    current: "continue", previousUser: "Fix the Rust compiler", tasks: [{ summary: "Update documentation" }],
  });
  assert(query.startsWith("continue"), "the current intent comes first for bounded decision inputs");
  assert.deepEqual(index.search(query).filter(hit => hit.score > 0).map(hit => hit.entry.name).sort(), ["docs", "rust"]);
  assert.equal(enrichedSkillQuery({ current: "Fix Rust" }), "Fix Rust");
});

test("continuations in German and English reuse skills while new requests trigger a fresh selection", () => {
  for (const text of ["ja, weiter", "Ja, bitte weiter!", "yes, continue", "Go ahead.", "mach weiter", "ok", "nein"]) {
    assert.equal(isSkillFollowup(text), true, text);
  }
  for (const text of ["", "ja, erstelle einen Bericht", "yes, search today's news", "continue with another project"]) {
    assert.equal(isSkillFollowup(text), false, text);
  }
});

test("each task receives a slot before an earlier task receives its second skill", () => {
  const a = [pick("rust"), pick("tests"), pick("format")];
  const b = [pick("docs"), pick("review")];
  assert.deepEqual(names(fairTaskSkills([a, b])), ["rust", "docs", "tests"]);
  assert.deepEqual(names(fairTaskSkills([a, b, [pick("images")], [pick("audio")]])), ["rust", "docs", "images"]);
});

test("pins keep precedence and duplicate skills cannot consume several task slots", () => {
  const pinned = pick("policy", "pinned");
  assert.deepEqual(names(fairTaskSkills([[pick("rust"), pick("docs")], [pick("rust"), pick("tests")]], [pinned])),
    ["policy", "rust", "tests"]);
  assert.deepEqual(names(fairTaskSkills([[pick("rust")], [], [pick("docs")]])), ["rust", "docs"]);
  assert.deepEqual(names(fairTaskSkills([[pick("rust")]], [pinned, pinned, pick("style", "pinned")])),
    ["policy", "style", "rust"]);
});
