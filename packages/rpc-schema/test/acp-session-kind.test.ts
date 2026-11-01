/** The harness ACP server creates the already-stored ACP session kind; this does not open arbitrary kinds or params. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateParams } from "../src/index.ts";

test("session.create admits ACP server sessions while rejecting unknown kinds and mode injection", () => {
  const params = { caller: { channel: "cli", accountId: "host", userId: "owner" }, agentId: "worker", kind: "acp" };
  assert.deepEqual(validateParams("session.create", params), { ok: true });
  assert.equal(validateParams("session.create", { ...params, kind: "external" }).ok, false);
  assert.equal(validateParams("session.create", { ...params, codingMode: "coding" }).ok, false);
});
