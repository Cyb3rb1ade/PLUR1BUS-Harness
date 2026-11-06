/** An actual backend turn keeps following events while a D109 request awaits the ACP client. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CoreSessionBackend, type RpcCaller } from "../../src/acp/backend.ts";
import type { AcpPermissionAsk } from "../../src/acp/permissions.ts";

test("the running backend relays D109, then continues the same turn after the recorded decision", { timeout: 10_000 }, async () => {
  const questions: AcpPermissionAsk[] = [];
  const calls: string[] = [];
  let page = 0;
  let release!: () => void;
  const decided = new Promise<void>(resolve => {
    release = resolve;
  });
  const approval = { id: "a", status: "pending", principal: "person", subject: { kind: "agent", id: "agent" },
    capability: "fs.write", actionHash: "a".repeat(64), sessionId: "s", turnId: "t", requiredSurface: 2,
    grantOptions: [{ scope: "once", requiredSurface: 2 }], createdAt: "2026-11-01T00:00:00Z",
    expiresAt: "2026-11-02T00:00:00Z", delegable: false };
  const client = {
    hello: { capabilities: { methods: Object.fromEntries(
      ["approval.list", "approval.get", "approval.decide", "approval.cancel"].map(method => [method, {}])) } },
    async call(method: string, params?: object) {
      calls.push(method);
      if (method === "session.submit") return { turnId: "t" };
      if (method === "session.events") {
        if (page++ === 0) return { running: true,
          events: [{ seq: 1, turnId: "t", type: "tool.call", data: { id: "c", name: "file.write" } }] };
        // Fail promptly if the backend never tried to ask; no timeout or sleep masks the missing mapping.
        assert.equal(questions.length, 1, "D109 permission must be relayed before waiting for the next event page");
        await decided;
        return { events: [{ seq: 2, turnId: "t", type: "turn.completed", data: {} }], running: false };
      }
      if (method === "approval.list") return { approvals: [approval] };
      if (method === "approval.get") return approval;
      if (method === "approval.decide") {
        assert.deepEqual(params, { id: "a", decision: "approve", scope: "once", attest: true });
        release();
        return {};
      }
      if (method === "session.cancel" || method === "approval.cancel") return {};
      throw new Error("unexpected method");
    },
  } as RpcCaller;
  const backend = new CoreSessionBackend({ client, caller: { channel: "cli", accountId: "a", userId: "u" },
    agentId: "agent", sleep: async () => {} });
  const result = await backend.prompt({ sessionId: "s", text: "edit" }, () => {}, async ask => {
    questions.push(ask);
    return { outcome: "selected", optionId: "allow-once" };
  });
  assert.deepEqual(result, { state: "completed" });
  assert.equal(calls.filter(m => m === "session.submit").length, 1);
  assert.ok(!calls.includes("grant.create"));
});
