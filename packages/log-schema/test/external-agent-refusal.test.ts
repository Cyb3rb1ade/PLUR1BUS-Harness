import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupEvent, validateRecord } from "../src/index.ts";

test("ACP acceptance refusal permits only the fixed cause and process role", () => {
  const entry = lookupEvent("external.agent.refused");
  assert.ok(entry);
  const example = entry.examples[0]!;
  const attrs = { process: "connector", reason: "sandbox-unavailable", cause: "macos-acceptance-pending" };
  for (const process of ["connector", "terminal", "discovery"])
    assert.equal(validateRecord({ ...example, attrs: { ...attrs, process } }).ok, true);
  for (const field of ["process", "reason", "cause", "argv", "path", "error", "detail"])
    assert.equal(validateRecord({ ...example, attrs: { ...attrs, [field]: "PRIVATE-CONTENT" } }).ok, false, field);
  for (const field of ["process", "reason", "cause"] as const) {
    const incomplete: Partial<typeof attrs> = { ...attrs }; delete incomplete[field];
    assert.equal(validateRecord({ ...example, attrs: incomplete }).ok, false, field);
  }
});
