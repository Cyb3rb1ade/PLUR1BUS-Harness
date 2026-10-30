// N-C1: the authored skill catalogue is bounded, deterministic, and independent of ranking snippets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAvailableSkills } from "../../src/prompt/skills.ts";

function skill(name: string, authoredDescription = "Read the appropriate workflow.") {
  return { entry: { name, description: "Short ranking description" }, authoredDescription };
}

test("the catalogue sorts names and preserves author descriptions beyond the ranking limit", () => {
  const description = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  assert.equal(renderAvailableSkills([skill("zebra"), skill("alpha", description)]),
    `Available skills\nalpha: ${description}\nzebra: Read the appropriate workflow.`);
});

test("the catalogue clips each authored description at 1024 characters and keeps one line per skill", () => {
  const result = renderAvailableSkills([skill("reports", `line one\nline two\u0000 ${"x".repeat(1100)}`)]);
  assert.equal(result.split("\n").length, 2);
  assert.equal(result.split("reports: ")[1]!.length, 1024);
  assert(!result.includes("\u0000"));
});

test("the catalogue reserves its overflow hint inside the token budget", () => {
  const skills = Array.from({ length: 40 }, (_, i) => skill(`skill-${String(i).padStart(2, "0")}`, "x".repeat(1024)));
  const result = renderAvailableSkills(skills);
  assert(Math.ceil(result.length / 4) <= 4000);
  assert.match(result, /\n\d+ more: use capabilities\.search$/);
  const lines = result.split("\n");
  assert.equal(Number.parseInt(lines.at(-1)!, 10), 40 - (lines.length - 2));
});

test("empty catalogues add no prompt bytes and fallback descriptions remain available", () => {
  assert.equal(renderAvailableSkills([]), "");
  assert.equal(renderAvailableSkills([{ entry: { name: "reports", description: "Ranked summary" } }]),
    "Available skills\nreports: Ranked summary");
});

test("catalogue output is identical after registration order changes", () => {
  const skills = [skill("zebra"), skill("alpha"), skill("middle")];
  assert.equal(renderAvailableSkills(skills), renderAvailableSkills([...skills].reverse()));
});
