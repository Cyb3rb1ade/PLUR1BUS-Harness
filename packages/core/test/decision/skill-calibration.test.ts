/** D103 metadata floor calibration: real catalogue scoring against independent bilingual gold labels. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ruleSkills } from "../../src/decision/skills.ts";
import { CapabilityIndex } from "../../src/toolcall/capabilities.ts";

interface CalibrationFixture {
  skills: { id: string; name: string; description: string; category: string }[];
  cases: { id: string; input: string; expected: string[] }[];
}

test("the calibrated rule floor retains bilingual task skills and rejects irrelevant common-word matches", t => {
  const fixture = JSON.parse(readFileSync(
    new URL("../fixtures/turn-eval/skill-selection.json", import.meta.url), "utf8",
  )) as CalibrationFixture;
  const index = new CapabilityIndex();
  for (const skill of fixture.skills) {
    index.upsert({ ...skill, kind: "skill", effect: "read", risk: "low", source: "fixture", version: "1" });
  }
  let minimumRelevant = Infinity;
  let maximumIrrelevant = 0;
  for (const row of fixture.cases) {
    const candidates = index.search(row.input).map(hit => ({ ...hit.entry, confidence: hit.score }));
    const selected = ruleSkills({ query: row.input, candidates });
    assert.deepEqual(selected.map(skill => skill.name), row.expected, row.id);
    for (const candidate of candidates) {
      if (row.expected.includes(candidate.name)) minimumRelevant = Math.min(minimumRelevant, candidate.confidence);
      else maximumIrrelevant = Math.max(maximumIrrelevant, candidate.confidence);
    }
  }
  t.diagnostic(`6/6 cases: minimum relevant score=${minimumRelevant.toFixed(3)}, `
    + `maximum irrelevant score=${maximumIrrelevant.toFixed(3)}`);
});
