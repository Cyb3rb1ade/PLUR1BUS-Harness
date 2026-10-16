import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { renderOpenclaw } from "../../src/import/render.ts";
import { validateProfile } from "../../src/auth/profile.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("D110: real D13 route-3 import persists disabled metadata, no credential and the supported alternatives", async () => {
  const root = tempDir("p1b-route3-source-"), home = tempDir("p1b-route3-target-");
  const marker = "redact-probe-foreign-registration";
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify(defaults()));
    writeFileSync(join(root, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" }, agents: { list: [] }, auth: { profiles: { "openai:chatgpt-oauth-restricted": { provider: "openai", mode: "oauth" } } } }));
    mkdirSync(join(root, "credentials"));
    // Not valid JSON: the importer succeeds because it inventories presence, never loads token values.
    writeFileSync(join(root, "credentials", "auth.json"), marker);
    const before = readFileSync(join(root, "credentials", "auth.json"));
    const report = await importOpenclaw({ home, source: root, apply: true });
    const profiles = report.disabledAuthProfiles!;
    assert.equal(profiles.length, 1); assert.equal(profiles[0]!.enabled, false);
    assert.match(profiles[0]!.reason, /retired/); assert.match(profiles[0]!.action, /API key.*ACP/);
    assert.equal(profiles[0]!.replacement, "openai:chatgpt-plan");
    const persisted = JSON.parse(readFileSync(report.reportPath!, "utf8"));
    assert.deepEqual(persisted.disabledAuthProfiles, profiles);
    assert.match(renderOpenclaw(report), /disabled.*route 3/);
    for (const text of [JSON.stringify(report), JSON.stringify(persisted), readFileSync(join(home, "config.json"), "utf8"), renderOpenclaw(report)]) assert.ok(!text.includes(marker));
    assert.deepEqual(readFileSync(join(root, "credentials", "auth.json")), before);
    assert.throws(() => validateProfile({ id: profiles[0]!.id }), /superseded/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
