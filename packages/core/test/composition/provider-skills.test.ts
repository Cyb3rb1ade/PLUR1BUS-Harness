/** N-C1: the real turn system zone exposes only authorized skill metadata. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LiveCapabilityIndex } from "../../src/toolcall/live-index.ts";
import { collect, scriptedAdapter, turnFixture, useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("n-provider-skills-");

it("keeps a sorted full-description catalogue in the system zone without blocked skills", async () => {
  const home = tmp.make();
  mkdirSync(join(home, "state"));
  const description = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  for (const name of ["zeta", "alpha", "blocked"]) {
    mkdirSync(join(home, "skills", name), { recursive: true });
    writeFileSync(join(home, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nBODY-${name}`);
  }
  writeFileSync(join(home, "skills", "index.json"), JSON.stringify({ version: 1,
    skills: ["zeta", "alpha", "blocked"].map(id => ({ id, enabled: true })) }));
  const live = new LiveCapabilityIndex(home);
  const wire = scriptedAdapter([{ text: "done" }]);
  const f = turnFixture(wire.adapter, { capabilities: live, skillsForAgent: () => ({ blocked: ["blocked"] }) }, home);
  try {
    await collect(f.provider);
    await collect(f.provider);
    const system = wire.requests.map(r => r.messages.filter(m => m.role === "system")
      .map(m => m.content).join("\n"));
    assert.match(system[0]!, /Available skills\nalpha: .*word39\nzeta: .*word39/);
    assert.doesNotMatch(system[0]!, /blocked:|BODY-/);
    assert.equal(system[0], system[1]);
  } finally { live.close(); f.close(); }
});

it("offers skill.read and returns a listed resource through the real dispatcher", async () => {
  const home = tmp.make();
  mkdirSync(join(home, "state"));
  mkdirSync(join(home, "skills", "reports"), { recursive: true });
  writeFileSync(join(home, "skills", "reports", "SKILL.md"),
    "---\nname: reports\ndescription: Create reports\n---\nRead guide.txt.");
  writeFileSync(join(home, "skills", "reports", "guide.txt"), "RESOURCE GUIDE");
  writeFileSync(join(home, "skills", "index.json"), JSON.stringify({ version: 1,
    skills: [{ id: "reports", enabled: true }] }));
  const live = new LiveCapabilityIndex(home);
  const wire = scriptedAdapter([
    { calls: [{ id: "resource", name: "skill.read", args: { name: "reports", path: "guide.txt" } }] },
    { text: "done" },
  ]);
  const f = turnFixture(wire.adapter, { capabilities: live }, home);
  try {
    const chunks = await collect(f.provider);
    const output = chunks.find(c => c.type === "tool.result" && c.id === "resource");
    assert.ok(output && output.type === "tool.result");
    assert.equal(JSON.parse(output.output).value.text, "RESOURCE GUIDE");
    assert.ok(wire.requests[0]?.tools?.some(t => t.name === "skill_read"));
  } finally { live.close(); f.close(); }
});
