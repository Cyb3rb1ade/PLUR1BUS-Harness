import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate } from "../src/index.ts";

it("fixtures/format-cases.json matches ajv-formats (run pnpm gen after a schema change); crates/plur1bus-config runs the same cases", () => {
  const cases = JSON.parse(readFileSync(new URL("../fixtures/format-cases.json", import.meta.url), "utf8"));
  assert.ok(cases.some((c: any) => c.valid) && cases.some((c: any) => !c.valid), "both valid and invalid cases");
  for (const { name, config, valid } of cases) assert.equal(validate(config).ok, valid, name);
  assert.ok(cases.some((c: any) => c.name === 'agents.bernd.createdAt = "yesterday"' && c.valid === false));
});

it("fixtures/cross-field-cases.json matches validate() (run pnpm gen after a schema change); crates/plur1bus-config runs the same cases", () => {
  const cases = JSON.parse(readFileSync(new URL("../fixtures/cross-field-cases.json", import.meta.url), "utf8"));
  assert.ok(cases.some((c: any) => c.valid) && cases.some((c: any) => !c.valid), "both valid and invalid cases");
  for (const { name, config, valid } of cases) assert.equal(validate(config).ok, valid, name);
  assert.ok(cases.some((c: any) => c.name === "core.recall soft 601 / hard 600" && c.valid === false), "soft above hard is refused");
  assert.ok(cases.some((c: any) => c.name === "core.recall soft 600 / hard 600" && c.valid === true), "soft equal to hard is accepted");
});

it("fixtures/engine-path-cases.json matches validate() (run pnpm gen after a schema change); crates/plur1bus-config runs the same cases", () => {
  const cases = JSON.parse(readFileSync(new URL("../fixtures/engine-path-cases.json", import.meta.url), "utf8"));
  for (const { name, config, valid } of cases) assert.equal(validate(config).ok, valid, name);
  const verdict = (value: string) => cases.find((c: any) => c.config.engine.baseDbPathOverride === value)?.valid;
  assert.equal(verdict("/var/lib/plur1bus/lancedb"), true);
  assert.equal(verdict(""), true, "blank keeps the default");
  assert.equal(verdict("lancedb"), false, "relative");
  assert.equal(verdict("~/lancedb"), false, "the core does not expand ~");
  assert.equal(verdict(" /abs"), false, "the core does not trim");
});
