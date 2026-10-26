/** Tests generated cache-profile facts, drift refusal and preservation of handwritten documentation. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkDocLinks } from "./check-doc-links.mjs";

const SCRIPT = new URL("./gen-provider-matrix.mjs", import.meta.url);
const TABLE = JSON.parse(await readFile(new URL("../packages/providers/schema/cache-profiles.json", import.meta.url)));
const START = "<!-- BEGIN GENERATED CACHE PROFILES -->";
const END = "<!-- END GENERATED CACHE PROFILES -->";

async function generator() {
  try {
    return await import(SCRIPT.href);
  } catch (error) {
    assert.fail(`The provider-matrix generator must exist and load: ${error.message}`);
  }
}

// Removing a profile, route or gateway fact must fail coverage; changing a leaf must affect rendered output.
test("the renderer includes every profile, alias, host and gateway with source, date and status", async () => {
  const { renderProviderMatrix } = await generator();
  const output = renderProviderMatrix(TABLE);
  for (const row of TABLE.rows) {
    for (const fact of [row.id, row.provider, row.source, row.verified, row.status]) {
      assert.ok(output.includes(fact), `Missing ${row.id} fact: ${fact}`);
    }
  }
  for (const alias of TABLE.aliases) {
    for (const value of Object.values(alias)) assert.ok(output.includes(value), `Missing alias ${value}`);
  }
  for (const host of TABLE.hosts) {
    assert.ok(output.includes(host.pattern.replaceAll("|", "\\|")), `Missing host ${host.pattern}`);
  }
  for (const [name, gateway] of Object.entries(TABLE.gateways)) {
    for (const value of [name, gateway.source, gateway.verified, gateway.status]) assert.ok(output.includes(value));
  }
  assert.match(output, /undocumented/);
  assert.match(output, /TTL/);
  assert.match(output, /[Ww]rite/);
  assert.match(output, /[Rr]ead/);
});

function leaves(value, path = []) {
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => leaves(item, [...path, key]));
  }
  return [{ path, value }];
}

test("changing each data fact changes the generated output without consulting another source", async () => {
  const { renderProviderMatrix } = await generator();
  const original = renderProviderMatrix(TABLE);
  for (const { path, value } of leaves(TABLE).filter(({ path }) => path[0] !== "$comment")) {
    const changed = structuredClone(TABLE);
    const parent = path.slice(0, -1).reduce((object, key) => object[key], changed);
    parent[path.at(-1)] = typeof value === "number" ? value + 1 : typeof value === "boolean" ? !value : "changed-fact";
    assert.notEqual(renderProviderMatrix(changed), original, `Ignored fact ${path.join(".")}`);
  }
});

test("updating the block preserves all outside bytes and is deterministic", async () => {
  const { updateProviderMatrix } = await generator();
  const before = "# Matrix\r\n\nhandwritten  \n";
  const after = "\n\n## Background\nKeep this exactly.  \n";
  const input = `${before}${START}\nstale\n${END}${after}`;
  const output = updateProviderMatrix(input, TABLE);
  assert.ok(output.startsWith(`${before}${START}`));
  assert.ok(output.endsWith(`${END}${after}`));
  assert.equal(updateProviderMatrix(output, TABLE), output);
  assert.equal(updateProviderMatrix(input, TABLE), output);
  assert.throws(() => updateProviderMatrix("no markers", TABLE), /marker/i);
  assert.throws(() => updateProviderMatrix(`${input}\n${START}`, TABLE), /marker/i);
});

test("the real CLI check rejects stale generated content and leaves handwritten bytes unchanged", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "provider-matrix-"));
  try {
    await mkdir(join(fixture, "scripts"));
    await mkdir(join(fixture, "docs"));
    await mkdir(join(fixture, "packages/providers/schema"), { recursive: true });
    await copyFile(SCRIPT, join(fixture, "scripts/gen-provider-matrix.mjs"));
    await writeFile(join(fixture, "packages/providers/schema/cache-profiles.json"), JSON.stringify(TABLE));
    const doc = join(fixture, "docs/provider-matrix.md");
    const input = `prefix  \n${START}\nstale\n${END}\nsuffix  \n`;
    await writeFile(doc, input);
    const run = (...args) => spawnSync(process.execPath, [join(fixture, "scripts/gen-provider-matrix.mjs"), ...args], {
      encoding: "utf8",
    });
    const stale = run("--check");
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /pnpm docs:gen/);
    assert.equal(await readFile(doc, "utf8"), input);
    assert.equal(run().status, 0);
    const generated = await readFile(doc, "utf8");
    assert.deepEqual(checkDocLinks(fixture), [], "model regexes must render as code, never Markdown links");
    assert.ok(generated.startsWith(`prefix  \n${START}`));
    assert.ok(generated.endsWith(`${END}\nsuffix  \n`));
    assert.equal(run("--check").status, 0);
    assert.equal(run().status, 0);
    assert.equal(await readFile(doc, "utf8"), generated);
    const windowsDocument = generated.replaceAll("\n", "\r\n");
    await writeFile(doc, windowsDocument);
    const windowsCheck = run("--check");
    assert.equal(windowsCheck.status, 0, windowsCheck.stderr);
    assert.equal(run().status, 0);
    assert.equal(await readFile(doc, "utf8"), windowsDocument);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
