import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const schema = JSON.parse(readFileSync(new URL("../schema/rpc.schema.json", import.meta.url), "utf8")) as {
  $defs: { methods: Record<string, { description?: unknown }> };
};
const methods = schema.$defs.methods;
const fixtureFiles = readdirSync(new URL("../fixtures/methods/", import.meta.url))
  .filter((name) => name.endsWith(".json"));
const fixtureNames = fixtureFiles.map((name) => name.slice(0, -".json".length));

const TODO_MISSING_DESCRIPTIONS = [
  "agent.close", "agent.list", "agent.open", "agent.status",
  "core.auth", "core.shutdown", "core.status",
  "events.subscribe", "events.unsubscribe",
  "memory.capture", "memory.checkpoint", "memory.correct", "memory.forget",
  "memory.proposals.accept", "memory.proposals.list", "memory.proposals.reject", "memory.propose",
  "memory.recall", "memory.share", "memory.state",
  "module.status",
].sort();
const TODO_MISSING_FIXTURES: string[] = [];
const FIXTURE_METHOD_ALIASES: Record<string, string> = {
  "jobs.run.system": "jobs.run",
};

describe("rpc-schema method descriptions and fixtures", () => {
  it("documents every method, tracking existing omissions as TODOs", () => {
    const missing = Object.entries(methods)
      .filter(([, definition]) => typeof definition.description !== "string" || !definition.description.trim())
      .map(([name]) => name)
      .sort();

    assert.deepEqual(missing, TODO_MISSING_DESCRIPTIONS);
  });

  it("has a fixture for every method and no orphan fixtures", () => {
    const methodNames = Object.keys(methods);
    const knownFixtures = new Set([...methodNames, ...Object.keys(FIXTURE_METHOD_ALIASES)]);
    const orphans = fixtureNames.filter((name) => !knownFixtures.has(name)).sort();
    const invalidAliases = Object.entries(FIXTURE_METHOD_ALIASES)
      .filter(([fixture, method]) => !fixtureNames.includes(fixture) || !methodNames.includes(method))
      .map(([fixture]) => fixture)
      .sort();
    const coveredMethods = new Set(fixtureNames
      .map((name) => FIXTURE_METHOD_ALIASES[name] ?? name)
      .filter((name) => methodNames.includes(name)));
    const missing = methodNames.filter((name) => !coveredMethods.has(name)).sort();

    assert.deepEqual(orphans, [], "fixture files must correspond to a method or declared fixture variant");
    assert.deepEqual(invalidAliases, [], "fixture variants must point to an existing method and fixture");
    assert.deepEqual(missing, TODO_MISSING_FIXTURES);
  });
});
