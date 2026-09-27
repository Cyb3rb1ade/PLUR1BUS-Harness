import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODULE_API_VERSION, apiVersionSupported, validateManifest } from "../src/manifest.ts";

describe("module manifest", () => {
  it("manifest cases match the shared fixture", () => {
    const cases = JSON.parse(readFileSync(new URL("../fixtures/manifest-cases.json", import.meta.url), "utf8")) as { name: string; manifest: unknown; valid: boolean }[];
    assert.ok(cases.length >= 9);
    for (const { name, manifest, valid } of cases) {
      const r = validateManifest(manifest);
      assert.equal(r.ok, valid, `${name}: ${r.ok ? "accepted" : r.errors.join("; ")}`);
    }
  });

  it("fills restart, lifeline and the empty lists by default", () => {
    const r = validateManifest({ name: "fixture", version: "0.1.0", apiVersion: "1", entry: "index.js", scope: "installation", priority: 500 });
    assert.ok(r.ok);
    assert.equal(r.manifest.restart, "on-failure");
    assert.equal(r.manifest.lifeline, true);
    assert.deepEqual([r.manifest.needs, r.manifest.provides, r.manifest.consumes, r.manifest.implements, r.manifest.extensionPoints], [[], [], [], [], {}]);
  });

  it("does not mutate its input", () => {
    const input = { name: "fixture", version: "0.1.0", apiVersion: "1", entry: "index.js", scope: "installation", priority: 500 };
    validateManifest(input);
    assert.equal("restart" in input, false);
  });

  it("api version policy: the current and the previous major (B12)", () => {
    assert.equal(MODULE_API_VERSION, 1);
    assert.equal(apiVersionSupported("1"), true);
    assert.equal(apiVersionSupported("2"), false);
    assert.equal(apiVersionSupported("1", 2), true);
    assert.equal(apiVersionSupported("2", 2), true);
    for (const v of ["0", "3", "01", "x", "", "1.0"]) assert.equal(apiVersionSupported(v, 2), false, v);
  });
});
