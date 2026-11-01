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

  it("refuses configuration schemas whose privacy declarations cannot be interpreted", () => {
    const base = { name: "fixture", version: "0.1.0", apiVersion: "1", entry: "index.js",
      scope: "installation", priority: 500 };
    for (const configSchema of [
      { allOf: [{ properties: { ordinary: { type: "string", "x-sensitive": true } } }] },
      { properties: { ordinary: { $ref: "https://schema.example.test/private" } } },
      { properties: { ordinary: { type: "string", "x-sensitive": "sometimes" } } },
      { properties: { ordinary: { type: "string", "x-url-credentials": true, "x-sensitive": true } } },
    ]) {
      const result = validateManifest({ ...base, configSchema });
      assert.equal(result.ok, false, JSON.stringify(configSchema));
      if (!result.ok) assert.deepEqual(result.errors,
        ["/configSchema contains unsupported configuration disclosure metadata"]);
    }
    assert.equal(validateManifest({ ...base, configSchema: { type: "object", properties: {
      ordinary: { type: "string", "x-sensitive": true },
      endpoint: { type: "string", "x-url-credentials": true },
    } } }).ok, true);
  });

  it("kind accepts module and channel and refuses others", () => {
    const base = { name: "fixture", version: "0.1.0", apiVersion: "1", entry: "index.js", scope: "installation", priority: 500 };
    for (const kind of ["module", "channel"]) {
      const r = validateManifest({ ...base, kind });
      assert.ok(r.ok, `${kind}: ${r.ok ? "" : r.errors.join("; ")}`);
      assert.equal(r.manifest.kind, kind);
    }
    const absent = validateManifest(base);
    assert.ok(absent.ok);
    assert.equal("kind" in absent.manifest, false, "kind has no default: absent means module");
    for (const kind of ["skill", "mcp-server", "bundle", "", "Module", 1, null]) {
      assert.equal(validateManifest({ ...base, kind }).ok, false, String(kind));
    }
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
