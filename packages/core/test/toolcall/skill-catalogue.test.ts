// N-C1: retained author descriptions and strict skill-directory admission feed the per-agent catalogue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LiveCapabilityIndex } from "../../src/toolcall/live-index.ts";
import { renderAvailableSkills } from "../../src/prompt/skills.ts";
import { useTempDirs } from "../composition/helpers.ts";

const dirs = useTempDirs("n-skill-catalogue-");

function setup(description: string) {
  const home = dirs.make();
  mkdirSync(join(home, "state"));
  mkdirSync(join(home, "skills", "reports"), { recursive: true });
  writeFileSync(join(home, "skills", "reports", "SKILL.md"),
    `---\nname: reports\ndescription: ${description}\ncategory: docs.create\n---\nReport workflow.`);
  writeFileSync(join(home, "skills", "index.json"), JSON.stringify({ version: 1,
    skills: [{ id: "reports", enabled: true }] }));
  const live = new LiveCapabilityIndex(home);
  dirs.onCleanup(() => live.close());
  return { home, live };
}

test("the live view retains author prose separately from its 25-word ranking summary", () => {
  const description = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const { live } = setup(description);
  const view = live.view("A", [], {}, "A");
  assert.equal(view.skills[0]?.authoredDescription, description);
  assert.equal(view.skills[0]?.entry.description.split(/\s+/).length, 25);
  assert.match(renderAvailableSkills(view.skills), /word39/);
});

test("retained descriptions are bounded to 1024 characters without changing full instruction text", () => {
  const { live } = setup("a".repeat(1100));
  const skill = live.view("A", [], {}, "A").skills[0]!;
  assert.equal(skill.authoredDescription?.length, 1024);
  assert.match(skill.text, /a{1100}/);
});

test("the catalogue includes only this agent's enabled and unblocked skills", async () => {
  const { live } = setup("Create reports");
  live.extensionFeed = { async snapshot() {
    return [{ name: "reports", kind: "skill", enabled: true, agents: ["A"], overlays: [] }];
  } };
  await live.syncExtensions();
  assert.match(renderAvailableSkills(live.view("A", [], {}, "A").skills), /reports: Create reports/);
  assert.equal(renderAvailableSkills(live.view("B", [], {}, "B").skills), "");
  assert.equal(renderAvailableSkills(live.view("A", [], { blocked: ["reports"] }, "A").skills), "");
});

test("a skill directory symlink inside the same store is excluded from the catalogue", () => {
  const { home, live } = setup("Create reports");
  symlinkSync(join(home, "skills", "reports"), join(home, "skills", "alias"), "dir");
  writeFileSync(join(home, "skills", "index.json"), JSON.stringify({ version: 1,
    skills: [{ id: "alias", enabled: true }] }));
  assert.equal(live.view("A", [], {}, "A").skills.length, 0);
});
