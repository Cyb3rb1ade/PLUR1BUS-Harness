import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA, defaults, validate } from "../src/index.ts";

const withRoles = (modelRoles: Record<string, string>) => ({ ...defaults(), modelRoles });

describe("modelRoles", () => {
  it("accepts the summarize role used by session compaction", () => {
    const r = validate(withRoles({ chat: "openai/gpt-4.1", summarize: "cheap" }));
    assert.equal(r.ok, true, r.ok ? "" : r.errors.join("; "));
    if (r.ok) assert.equal(r.config.modelRoles.summarize, "cheap");
  });

  it("still rejects roles the schema does not know", () => {
    const r = validate(withRoles({ summarise: "cheap" }));
    assert.equal(r.ok, false);
  });

  it("declares every role the code reads, in the schema's role enum", () => {
    const roles = CONFIG_SCHEMA.properties.modelRoles.propertyNames.enum as string[];
    assert.ok(roles.includes("summarize"));
    assert.deepEqual(roles.filter(r => r !== "summarize").sort(), ["capture", "chat", "decision", "dream", "embedding", "reasoning", "rerank"]);
  });
});
