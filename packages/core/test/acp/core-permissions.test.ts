/** The ACP option is only a selection; the actual D109 record, live scopes and OS attestation remain authoritative. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalRecord } from "@plur1bus/rpc-schema";
import type { RpcCaller } from "../../src/acp/backend.ts";
import { AcpApprovalRelay } from "../../src/acp/core-permissions.ts";
import type { AcpPermissionAsk, AcpPermissionOutcome } from "../../src/acp/permissions.ts";

const record = (extra: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: "apr", status: "pending", principal: "person",
  subject: { kind: "agent", id: "agent" }, capability: "fs.write", tool: "file.write", actionHash: "a".repeat(64),
  sessionId: "session", turnId: "turn", taskId: "task", requiredSurface: 2, originSurface: 0,
  grantOptions: [{ scope: "once", requiredSurface: 2 }, { scope: "task", requiredSurface: 2 },
    { scope: "session", requiredSurface: 2 }, { scope: "always", requiredSurface: 3 }],
  createdAt: "2026-11-01T00:00:00Z", expiresAt: "2026-11-02T00:00:00Z", delegable: false, ...extra });
function rig(o: {
  outcome?: AcpPermissionOutcome; fresh?: ApprovalRecord; decideFails?: boolean; records?: ApprovalRecord[];
} = {}) {
  const calls: { method: string; params: object | undefined }[] = [];
  const questions: AcpPermissionAsk[] = [];
  let finished!: () => void;
  let refused = 0;
  const decision = new Promise<void>(resolve => {
    finished = resolve;
  });
  const client: RpcCaller = { async call(method, params) {
    calls.push({ method, params });
    if (method === "approval.list") return { approvals: o.records ?? [record()] } as never;
    if (method === "approval.get") return (o.fresh ?? record()) as never;
    if (method === "approval.decide" || method === "approval.cancel") {
      if (method === "approval.decide" && o.decideFails) throw new Error("OS confirmation failed");
      finished();
      return {} as never;
    }
    throw new Error("unexpected RPC");
  } };
  const relay = new AcpApprovalRelay({ client, agentId: "agent", sessionId: "session", turnId: "turn",
    requestPermission: async ask => {
      questions.push(ask);
      return o.outcome ?? { outcome: "selected", optionId: "allow-once" };
    },
    refused: () => { refused++; } });
  return { relay, calls, questions, decision, refused: () => refused };
}

test("the editor sees only offered T2-or-less scopes and a remembered session choice uses the existing OS-confirmed decision", { timeout: 10_000 }, async t => {
  const r = rig({ outcome: { outcome: "selected", optionId: "allow-session" } });
  t.after(() => r.relay.close());
  await r.relay.poll();
  await r.decision;
  assert.deepEqual(r.questions[0]!.options.map(o => [o.optionId, o.kind]), [
    ["allow-once", "allow_once"], ["allow-task", "allow_always"],
    ["allow-session", "allow_always"], ["deny", "reject_once"]]);
  assert.match(r.questions[0]!.options[2]!.name, /until it ends/);
  assert.deepEqual(r.calls.find(c => c.method === "approval.decide")?.params,
    { id: "apr", decision: "approve", scope: "session", attest: true });
  assert.ok(!r.calls.some(c => c.method === "grant.create"));
  await r.relay.poll();
  assert.equal(r.questions.length, 1, "a pending request is never shown twice");
});

test("a forged always option and a scope removed before the choice are cancelled instead of widened", { timeout: 10_000 }, async t => {
  for (const options of [{ outcome: { outcome: "selected", optionId: "allow-always" } as const },
    { outcome: { outcome: "selected", optionId: "allow-session" } as const,
      fresh: record({ grantOptions: [{ scope: "once", requiredSurface: 2 }] }) }]) {
    const r = rig(options);
    t.after(() => r.relay.close());
    await r.relay.poll();
    await r.decision;
    assert.ok(!r.calls.some(c => c.method === "approval.decide"));
    assert.equal(r.calls.at(-1)!.method, "approval.cancel");
  }
});

test("deny is an explicit decision; cancellation and failed OS confirmation cancel without any grant fallback", { timeout: 10_000 }, async t => {
  for (const options of [{ outcome: { outcome: "selected", optionId: "deny" } as const },
    { outcome: { outcome: "cancelled" } as const }, { decideFails: true }]) {
    const r = rig(options);
    t.after(() => r.relay.close());
    await r.relay.poll();
    await r.decision;
    assert.ok(!r.calls.some(c => c.method === "grant.create"));
    if ("outcome" in options && options.outcome.outcome === "selected")
      assert.deepEqual(r.calls.at(-1)!.params, { id: "apr", decision: "deny" });
    else assert.equal(r.calls.at(-1)!.method, "approval.cancel");
  }
});

test("requests belonging to another session, turn or subject are never forwarded", { timeout: 10_000 }, async () => {
  const r = rig({ records: [record({ sessionId: "other" }), record({ turnId: "other" }),
    record({ subject: { kind: "agent", id: "other" } })] });
  await r.relay.poll();
  r.relay.close();
  assert.equal(r.questions.length, 0);
  assert.deepEqual(r.calls.map(c => c.method), ["approval.list"]);
});

test("a withdrawn Core request aborts its pending editor question; closing prevents any late decision", { timeout: 10_000 }, async () => {
  let listed = true;
  let aborted!: () => void;
  let allow!: (outcome: AcpPermissionOutcome) => void;
  const stopped = new Promise<void>(resolve => { aborted = resolve; });
  const response = new Promise<AcpPermissionOutcome>(resolve => { allow = resolve; });
  const calls: string[] = [];
  const client: RpcCaller = { async call(method) {
    calls.push(method);
    if (method === "approval.list") return { approvals: listed ? [record()] : [] } as never;
    if (method === "approval.get") return record({ status: "cancelled" }) as never;
    throw new Error("no decision is allowed after withdrawal");
  } };
  const relay = new AcpApprovalRelay({ client, agentId: "agent", sessionId: "session", turnId: "turn",
    requestPermission: async (_ask, signal) => {
      signal!.addEventListener("abort", aborted, { once: true });
      return response;
    } });
  await relay.poll();
  listed = false;
  await relay.poll();
  await stopped;
  relay.close();
  allow({ outcome: "selected", optionId: "allow-once" });
  await Promise.resolve();
  assert.ok(!calls.includes("approval.decide"));
});
