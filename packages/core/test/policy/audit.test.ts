import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createPolicyAudit, hashAndSize, MAX_AUDIT_TARGETS } from "../../src/policy/audit.ts";
import { createAuditChain, ACTIVE_NAME } from "../../src/audit/chain.ts";
import { memoryAuditSink, type AuditSink } from "../../src/rbac/audit.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const clock = { now: () => NOW };
// Built from parts so this file holds no secret-shaped literal.
const GHP = `ghp_${"A".repeat(36)}`;
const SK = `sk-${"proj-"}${"F".repeat(24)}`;

function rig() {
  const sink = memoryAuditSink();
  return { sink, audit: createPolicyAudit({ sink, clock, host: "h1" }) };
}

describe("policy audit (D109 §9, D9)", () => {
  it("writes the five-key audit line: who, what, target, detail", () => {
    const { sink, audit } = rig();
    audit.record("policy.decision", {
      person: "user:v1:christian", agentId: "bernd", subjectKind: "agent", sessionId: "s1", taskId: "t1", tool: "fs.read", capability: "fs.read",
      effect: "read", risk: "low", outcome: "approval", via: "ask", rule: "approval-class", surface: 3, actionHash: "ab".repeat(32), targets: ["/work/a.txt"], argsBytes: 17,
    });
    assert.equal(sink.events.length, 1);
    const e = sink.events[0]!;
    assert.deepEqual(e.actor, { user: "user:v1:christian", host: "h1" });
    assert.equal(e.at, NOW);
    assert.equal(e.action, "policy.decision");
    assert.equal(e.target, "tool:fs.read");
    assert.deepEqual(e.detail, {
      person: "user:v1:christian", agentId: "bernd", subjectKind: "agent", sessionId: "s1", taskId: "t1", tool: "fs.read", capability: "fs.read", effect: "read", risk: "low",
      outcome: "approval", via: "ask", rule: "approval-class", surface: 3, actionHash: "ab".repeat(32), targets: ["/work/a.txt"], argsBytes: 17,
    });
  });

  it("targets follow the subject: grant, approval, integrity", () => {
    const { sink, audit } = rig();
    audit.record("grant.created", { person: "p", grantId: "grt_1", capability: "fs.read", grantScope: "task" });
    audit.record("approval.requested", { person: "p", requestId: "apr_1" });
    audit.record("approvals.integrity-failure", { brokenAt: 4, failure: "mac-mismatch" });
    assert.deepEqual(sink.events.map((e) => e.target), ["grant:grt_1", "approval:apr_1", "approvals"]);
    assert.equal(sink.events[2]!.actor.user, "core");
  });

  it("never carries file contents, tool results, arguments or diffs: unknown keys are dropped", () => {
    const { sink, audit } = rig();
    audit.record("policy.decision", {
      tool: "fs.write", outcome: "allowed",
      ...({ args: { path: "/x", content: "TOP SECRET BODY" }, content: "file body", result: "tool output", output: "o", diff: "--- a\n+++ b\n+secret", value: "v", env: { A: "b" } } as object),
    });
    const d = sink.events[0]!.detail;
    assert.deepEqual(Object.keys(d).sort(), ["outcome", "tool"]);
    assert.ok(!JSON.stringify(sink.events[0]).includes("BODY"));
    assert.ok(!JSON.stringify(sink.events[0]).includes("secret"));
  });

  it("keeps only primitives of the expected type for each field", () => {
    const { sink, audit } = rig();
    audit.record("policy.decision", {
      ...({ tool: { nested: "obj" }, outcome: 5, surface: "3", argsBytes: Number.NaN, targets: "not-a-list", flags: { outsideRoots: true, evil: "x", denyListHit: 1 } } as object),
    });
    assert.deepEqual(sink.events[0]!.detail, { flags: { outsideRoots: true } });
  });

  it("masks secret-shaped values in every string field and in targets", () => {
    const { sink, audit } = rig();
    audit.record("policy.decision", {
      tool: "net.submit", outcome: "never", reason: `denied after Authorization: Bearer abc123DEF456ghi789 and key=${SK}`,
      targets: [`/work/${GHP}/a.txt`, "https://u:pw@example.com/x?token=abcdef123456"],
    });
    const raw = JSON.stringify(sink.events[0]);
    for (const leak of [GHP, SK, "abc123DEF456ghi789", "pw@example.com", "abcdef123456"]) assert.ok(!raw.includes(leak), `leaked ${leak.slice(0, 8)}`);
    assert.match(raw, /REDACTED|redacted|\[/);
  });

  it("a path in a credential store is replaced by its class, not logged", () => {
    const { sink, audit } = rig();
    audit.record("policy.decision", { tool: "fs.read", outcome: "never", rule: "deny-list", targets: ["/home/c/.ssh/id_ed25519"] });
    const t = (sink.events[0]!.detail.targets as string[])[0]!;
    assert.ok(!t.includes("id_ed25519"));
    assert.match(t, /deny:/);
  });

  it("registered secrets of this process are masked as exact values", () => {
    const sink = memoryAuditSink();
    const audit = createPolicyAudit({ sink, clock, host: "h", secrets: ["correct-horse-battery"] });
    audit.record("policy.decision", { tool: "t", outcome: "allowed", reason: "note correct-horse-battery here" });
    assert.ok(!JSON.stringify(sink.events[0]).includes("correct-horse-battery"));
  });

  it("clips long strings and caps the target list", () => {
    const { sink, audit } = rig();
    audit.record("policy.decision", { tool: "fs.read", outcome: "allowed", reason: "x".repeat(5000), targets: Array.from({ length: 100 }, (_, i) => `/w/${i}`) });
    const d = sink.events[0]!.detail;
    assert.ok((d.reason as string).length <= 300);
    assert.equal((d.targets as string[]).length, MAX_AUDIT_TARGETS);
    assert.equal(d.targetsTotal, 100);
  });

  it("a diff or payload is recorded as hash and size only", () => {
    const h = hashAndSize("--- a\n+++ b\n+hello");
    assert.match(h.hash, /^[0-9a-f]{64}$/);
    assert.equal(h.bytes, Buffer.byteLength("--- a\n+++ b\n+hello"));
    const { sink, audit } = rig();
    audit.record("approval.requested", { requestId: "apr_1", payloadHash: h.hash, payloadBytes: h.bytes });
    assert.deepEqual(sink.events[0]!.detail, { requestId: "apr_1", payloadHash: h.hash, payloadBytes: h.bytes });
  });

  it("rejected hand-off references are listed with a closed reason, ids clipped", () => {
    const { sink, audit } = rig();
    audit.record("approvals.held-rejected", { person: "p", taskId: "t1", rejected: [{ id: "grt_forged", reason: "unknown" }, { id: "x".repeat(500), reason: "not-delegable" }, { id: "g", reason: ({ evil: 1 } as unknown) as never }] });
    const r = sink.events[0]!.detail.rejected as { id: string; reason: string }[];
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { id: "grt_forged", reason: "unknown" });
    assert.ok(r[1]!.id.length <= 128);
  });

  it("throws when the sink cannot record: callers that must not act unrecorded rely on it", () => {
    const sink: AuditSink = { append() { throw new Error("disk full"); } };
    const audit = createPolicyAudit({ sink, clock, host: "h" });
    assert.throws(() => audit.record("policy.decision", { tool: "t", outcome: "allowed" }), /disk full/);
  });

  it("lands in the hash-chained audit file (B5) and the chain still verifies", () => {
    const dir = tempDir("policy-audit-");
    const chain = createAuditChain({ dir });
    const audit = createPolicyAudit({ sink: chain, clock, host: "h" });
    audit.record("policy.decision", { person: "p", tool: "fs.read", outcome: "allowed", via: "grant", grantId: "grt_1", surface: 3, actionHash: "a".repeat(64) });
    audit.record("grant.revoked", { person: "p", grantId: "grt_1", by: "p" });
    const v = chain.verify();
    assert.equal(v.ok, true);
    assert.equal(v.records, 2);
    const lines = readFileSync(path.join(dir, ACTIVE_NAME), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { rec: { action: string; detail: Record<string, unknown> } });
    assert.deepEqual(lines.map((l) => l.rec.action), ["policy.decision", "grant.revoked"]);
    assert.equal(lines[0]!.rec.detail.grantId, "grt_1");
  });
});
