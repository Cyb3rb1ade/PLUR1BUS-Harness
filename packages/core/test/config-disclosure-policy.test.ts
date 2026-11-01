// Module policies keep unknown values private while preserving each installed schema's own reference root.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfigDisclosurePolicy } from "../src/config-disclosure.ts";
import { createSecretRedaction } from "../src/secrets/redaction.ts";
import { tempDir } from "./helpers/temp-dir.ts";

test("installed reference-only policies behind references and conditionals cannot become raw log registrations", async () => {
  for (const schema of [
    { $defs: { name: { type: "string", "x-secret-reference": true } },
      properties: { ordinary: { $ref: "#/$defs/name" } } },
    { allOf: [{ properties: { ordinary: { type: "string", "x-secret-reference": true } } }] },
  ]) {
    const home = tempDir("p1b-reference-policy-");
    const directory = join(home, "modules", "fixture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "module.json"), JSON.stringify({ name: "fixture", version: "0.1.0",
      apiVersion: "1", entry: "index.js", scope: "installation", priority: 500, configSchema: schema }));
    const policy = await loadConfigDisclosurePolicy(home);
    const pasted = "sk-" + randomUUID();
    assert.ok(policy.values({ modules: { fixture: { enabled: false, ordinary: pasted } } }).includes(pasted),
      "an unsupported declaration falls back to private registration without disabling logging");
  }
});

test("installed modules are classified before the Harness unknown-member pass with isolated definitions", async () => {
  const home = tempDir("p1b-isolated-policy-");
  const first = "alpha.primary";
  const second = "beta.primary";
  const knownPublic = "public-config-region";
  const unknown = "sk-" + randomUUID();
  const missing = "sk-" + randomUUID();
  for (const [name, reference] of [["alpha", first], ["beta", second]]) {
    const directory = join(home, "modules", name!);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "module.json"), JSON.stringify({ name, version: "0.1.0", apiVersion: "1",
      entry: "index.js", scope: "installation", priority: 500, configSchema: {
        type: "object", $defs: { shared: { type: "string", enum: [reference] } },
        properties: {
          reference: { type: "string", "x-sensitive": true, "x-secret-reference": { $ref: "#/$defs/shared" } },
          region: { type: "string" },
        },
      } }));
  }
  const config = { modules: {
    alpha: { enabled: false, reference: first, region: knownPublic, unknown },
    beta: { enabled: false, reference: second },
    absent: { enabled: false, ordinary: missing },
  } };
  const before = structuredClone(config);
  const values = (await loadConfigDisclosurePolicy(home)).values(config);
  assert.ok(!values.includes(first), "the first module's valid reference was registered as an unknown string");
  assert.ok(!values.includes(second), "the second module's definition collided with the first module's root");
  assert.ok(!values.includes(knownPublic), "a typed public module member was registered by the Harness pass");
  assert.ok(!values.includes("false"), "Harness enabled remains a boolean control");
  assert.ok(values.includes(unknown), "unknown members of an installed module stay private");
  assert.ok(values.includes(missing), "uninstalled module strings stay private");
  assert.deepEqual(config, before);
});

test("missing or damaged module metadata uses a private fallback and a repaired manifest restores the policy", async () => {
  const home = tempDir("p1b-repaired-policy-");
  const directory = join(home, "modules", "fixture");
  mkdirSync(directory, { recursive: true });
  const ordinary = randomUUID();
  const config = { modules: { fixture: { enabled: false, ordinary } } };
  for (const text of ["{", JSON.stringify({ name: "fixture" })]) {
    writeFileSync(join(directory, "module.json"), text);
    assert.ok((await loadConfigDisclosurePolicy(home)).values(config).includes(ordinary));
  }
  writeFileSync(join(directory, "module.json"), JSON.stringify({ name: "fixture", version: "0.1.0", apiVersion: "1",
    entry: "index.js", scope: "installation", priority: 500,
    configSchema: { type: "object", properties: { ordinary: { type: "string" } } } }));
  assert.ok(!(await loadConfigDisclosurePolicy(home)).values(config).includes(ordinary));
});

test("damaged installed metadata protects a low-entropy literal in the global registry and recovers after repair", async () => {
  const home = tempDir("p1b-private-module-fallback-");
  const directory = join(home, "modules", "fixture");
  const manifestPath = join(directory, "module.json");
  mkdirSync(directory, { recursive: true });
  const ordinary = `quiet-meadow-${randomUUID().slice(0, 2)}`;
  const config = { modules: { fixture: { enabled: false, ordinary } } };
  const manifest = { name: "fixture", version: "0.1.0", apiVersion: "1", entry: "index.js",
    scope: "installation", priority: 500 };
  const registry = createSecretRedaction();
  const group = Symbol("module fallback");
  for (const configSchema of [
    { type: "object", properties: { ordinary: { type: "string", "x-sensitive": true } } },
    { allOf: [{ properties: { ordinary: { type: "string", "x-sensitive": true } } }] },
  ]) {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, configSchema }));
    const values = (await loadConfigDisclosurePolicy(home)).values(config);
    assert.ok(values.includes(ordinary), "damaged or unsupported metadata released an explicitly private literal");
    registry.replaceGroup(group, values);
    assert.ok(!registry.redactor().text(`ordinary ${ordinary}`).includes(ordinary));
  }
  writeFileSync(manifestPath, "{");
  assert.ok((await loadConfigDisclosurePolicy(home)).values(config).includes(ordinary));
  rmSync(manifestPath);
  assert.ok((await loadConfigDisclosurePolicy(home)).values(config).includes(ordinary));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest,
    configSchema: { type: "object", properties: { ordinary: { type: "string" } } } }));
  assert.ok(!(await loadConfigDisclosurePolicy(home)).values(config).includes(ordinary));
});

test("an unavailable module registry protects module literals while absent or schema-free modules use normal selection", async () => {
  const home = tempDir("p1b-unavailable-module-registry-");
  const modules = join(home, "modules");
  const ordinary = `quiet-region-${randomUUID().slice(0, 2)}`;
  const config = { modules: { fixture: { enabled: false, ordinary } } };
  writeFileSync(modules, "unavailable registry");
  assert.ok((await loadConfigDisclosurePolicy(home)).values(config).includes(ordinary));
  rmSync(modules);
  assert.ok(!(await loadConfigDisclosurePolicy(home)).values(config).includes(ordinary));
  mkdirSync(join(modules, "fixture"), { recursive: true });
  writeFileSync(join(modules, "fixture", "module.json"), JSON.stringify({ name: "fixture", version: "0.1.0",
    apiVersion: "1", entry: "index.js", scope: "installation", priority: 500 }));
  assert.ok(!(await loadConfigDisclosurePolicy(home)).values(config).includes(ordinary));
});
