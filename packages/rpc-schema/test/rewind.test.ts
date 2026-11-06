/** D120 CX1: rewind/undo are closed, human-facing core methods on the allocated RPC minor. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCHEMA, validateParams } from "../src/index.ts";

const caller = { channel: "cli", accountId: "local", userId: "owner" };

describe("D120 rewind contract", () => {
  for (const method of ["session.rewind", "chat.rewind"]) {
    const base = { sessionId: "session-a", ...(method.startsWith("session.") ? { caller } : {}) };
    it(`${method} accepts either a kept path sequence or undo and rejects ambiguous mutations`, () => {
      const methods = (SCHEMA as unknown as { $defs: { methods: Record<string, Record<string, unknown>> } }).$defs.methods;
      assert.equal(methods[method]?.["x-since"], "1.18.0");
      for (const params of [{ ...base, toSeq: 0 }, { ...base, toSeq: "last", lesson: "Check types first." },
        { ...base, toSeq: 2, files: true }, { ...base, undo: "rew_one" }]) {
        assert.deepEqual(validateParams(method, params), { ok: true });
      }
      for (const params of [{ ...base }, { ...base, toSeq: -1 }, { ...base, toSeq: 1, undo: "rew_one" },
        { ...base, undo: "rew_one", files: true }, { ...base, undo: "rew_one", lesson: "ignored" },
        { ...base, toSeq: 1, trigger: "agent" }, { ...base, toSeq: 1, actor: "somebody" }]) {
        assert.equal(validateParams(method, params).ok, false);
      }
    });
  }
});

for (const method of ["chat.rewind", "session.rewind"] as const) {
  it(`${method} accepts 1567-character notes and refuses 1568`, () => {
    const params = { sessionId: "ses_example", toSeq: 0,
      ...(method === "session.rewind" ? { caller: { channel: "cli", accountId: "local", userId: "owner" } } : {}) };
    assert.equal(validateParams(method, { ...params, lesson: "N".repeat(1567) }).ok, true);
    assert.equal(validateParams(method, { ...params, lesson: "N".repeat(1568) }).ok, false);
  });
}
