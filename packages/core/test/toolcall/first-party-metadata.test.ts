// N-C6: shipped discovery metadata is authored, complete and bounded; external registrations are never guessed at.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { HOST_TOOLS } from "../../src/host-tools/catalog.ts";
import { frontmatter } from "../../src/import/yaml-lite.ts";
import { CATEGORIES } from "../../src/toolcall/categories.ts";
import { FS_CAPABILITIES } from "../../src/tools/fs/tools.ts";
import { WEB_CAPABILITIES } from "../../src/tools/web/tools.ts";
import { SPECS } from "../../../hostctl/src/index.ts";

const SKILLS = fileURLToPath(new URL("../../../../skills/", import.meta.url));
const categories = new Set(CATEGORIES.map(category => category.id));

test("every first-party bundled skill declares its routing category and useWhen", () => {
  const names = readdirSync(SKILLS, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "third-party")
    .map(entry => entry.name)
    .sort();
  assert(names.length > 0);
  let catalogue = "Available skills\n";
  for (const name of names) {
    const meta = frontmatter(readFileSync(join(SKILLS, name, "SKILL.md"), "utf8"));
    assert(meta, name);
    assert.equal(typeof meta.category, "string", `${name}: category`);
    assert(categories.has(String(meta.category)), `${name}: known category`);
    assert.equal(typeof meta.useWhen, "string", `${name}: useWhen`);
    assert(String(meta.useWhen).trim().length > 0, `${name}: nonempty useWhen`);
    catalogue += `${name}: ${String(meta.description).slice(0, 1024)}\n`;
  }
  assert(Math.ceil(catalogue.length / 4) <= 4000, "bundled skills fit the prompt catalogue budget");
});

test("web and file discovery reuses the authored capability catalogue text", async () => {
  const { firstPartyDiscovery } = await import("../../src/toolcall/first-party-metadata.ts");
  for (const row of [...WEB_CAPABILITIES, ...FS_CAPABILITIES]) {
    const metadata = firstPartyDiscovery(row.name);
    assert(metadata, row.name);
    assert.equal(metadata.summary, row.summary);
    assert.equal(metadata.useWhen, row.useWhen);
    assert.equal(metadata.notFor, row.notFor);
    assert(categories.has(metadata.category!));
  }
});

test("all registered first-party tool families have trusted complete discovery metadata", async () => {
  const { firstPartyDiscovery } = await import("../../src/toolcall/first-party-metadata.ts");
  const names = [
    ...HOST_TOOLS.map(tool => tool.name), ...Object.keys(SPECS).map(name => `hostctl.${name}`),
    "exec.run", "secret_names", "document.render", "image.generate", "image.edit", "media.generate", "media.edit",
    "consult_agent", "delegate_task", "request_review", "handoff", "post_to_project", "read_project_board",
    "coding_complete", "capabilities.search", "skill.load", "skill.read", "memory.recall", "memory.capture",
  ];
  for (const name of names) {
    const metadata = firstPartyDiscovery(name);
    assert(metadata, name);
    assert(categories.has(metadata.category!), `${name}: known category`);
    assert(metadata.summary?.trim(), `${name}: summary`);
    assert(metadata.useWhen?.trim(), `${name}: useWhen`);
    assert(metadata.notFor?.trim(), `${name}: notFor`);
  }
});

test("unknown or third-party names receive no first-party metadata and returned values are isolated", async () => {
  const { firstPartyDiscovery } = await import("../../src/toolcall/first-party-metadata.ts");
  assert.equal(firstPartyDiscovery("mcp.untrusted.web.search"), undefined);
  assert.equal(firstPartyDiscovery("unknown.new_tool"), undefined);
  const first = firstPartyDiscovery("web.search")!;
  const expected = firstPartyDiscovery("web.search");
  first.summary = "changed by caller";
  assert.deepEqual(firstPartyDiscovery("web.search"), expected);
});
