/** CLI-1 human coding RPC: closed inputs, paired D115 ids, bounded pages and lossless check results. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { validateParams, validateResult } from "../src/index.ts";

const caller = { channel: "cli", accountId: "host", userId: "user" };
test("code.session.open accepts the independent 1.19 contract and refuses wider or half-bound inputs", () => {
  const p = { caller, agentId: "a", root: "/worktree" };
  assert.equal(validateParams("code.session.open", p).ok, true);
  assert.equal(validateParams("code.session.open", { ...p, projectId: "p", cardId: "c", interactive: false }).ok, true);
  for (const extra of [{ projectId: "p" }, { cardId: "c" }, { yes: true }, { approved: true }, { owner: "someone" }]) {
    assert.equal(validateParams("code.session.open", { ...p, ...extra }).ok, false);
  }
});
test("diff/check inputs are closed and bounded, while future result fields survive validation", () => {
  assert.equal(validateParams("code.session.diff", { caller, sessionId: "s", limit: 65536 }).ok, true);
  assert.equal(validateParams("code.session.diff", { caller, sessionId: "s", limit: 65537 }).ok, false);
  assert.equal(validateParams("code.session.check", { caller, sessionId: "s", kind: "test" }).ok, true);
  assert.equal(validateParams("code.session.check", { caller, sessionId: "s", argv: ["delete", "/"] }).ok, false);
  assert.equal(
    validateResult("code.session.check", { sessionId: "s", advisory: true, ok: true, checks: [], future: 7 }).ok,
    true,
  );
});

test("a folder request exposes one OS-confirmed session decision, never a caller-created task or always grant", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/methods/code.session.open.json", import.meta.url), "utf8"),
  );
  const result = {
    state: "grant-required",
    session: fixture.result.session,
    root: "/repo",
    grant: {
      path: "/repo",
      recursive: true,
      capabilities: ["fs.read", "fs.write"],
      scope: "session",
      approvalId: "request",
    },
  };
  assert.equal(validateResult("code.session.open", result).ok, true);
  for (const scope of ["task", "always"])
    assert.equal(validateResult("code.session.open", { ...result, grant: { ...result.grant, scope } }).ok, false);
  const { approvalId: removed, ...missing } = result.grant;
  assert.equal(validateResult("code.session.open", { ...result, grant: missing }).ok, false);
  assert.equal(removed, "request");
});
