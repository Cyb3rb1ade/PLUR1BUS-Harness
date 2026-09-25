import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigInvalid, loadConfig } from "../src/config-load.ts";

describe("config-load", () => {
  it("creates defaults when missing and loads them back", () => {
    const p = join(mkdtempSync(join(tmpdir(), "p1b-cfg-")), "config.json");
    const first = loadConfig(p); assert.equal(first.created, true); assert.equal(first.config.schemaVersion, 1);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).core.recall.softBudgetMs, 400);
    const second = loadConfig(p); assert.equal(second.created, false); assert.deepEqual(second.config, first.config);
  });
  it("rejects an invalid file with the schema errors and does not rewrite it", () => {
    const p = join(mkdtempSync(join(tmpdir(), "p1b-cfg-")), "config.json");
    writeFileSync(p, '{ "schemaVersion": 1, "core": { "logLevel": "loud" } }');
    assert.throws(() => loadConfig(p), (e: any) => e instanceof ConfigInvalid && e.errors.some((s: string) => s.includes("logLevel")));
    assert.equal(readFileSync(p, "utf8"), '{ "schemaVersion": 1, "core": { "logLevel": "loud" } }');
  });
});
