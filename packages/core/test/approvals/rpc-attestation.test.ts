// #192 option C: one OS confirmation lifts ONE approval of an unattested local connection (T1) to T2. The attester is a seam the
// core owns; these tests drive the handler with a programmable attester and, once, with the real service and the fake helper.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createAttestationService } from "../../src/attestation/index.ts";
import type { AttestInput, AttestProbe, AttestResult, Attester } from "../../src/attestation/index.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { AGENT_PRINCIPAL, refused, rpcRig, type RpcRig } from "./rpc-helpers.ts";

const T = { timeout: 20_000 };
const FAKE = fileURLToPath(new URL("../attestation/fixtures/fake-attest.mjs", import.meta.url));
const SHELL = { capability: "shell.exec", tool: "shell.run", effect: "local-destructive" as const, targets: [], args: { cmd: "ls" } };

function spy(result: AttestResult = { ok: true, method: "touch-id", at: 1 }, probe: AttestProbe = { available: true, method: "touch-id" }) {
  const calls: AttestInput[] = [];
  let probes = 0;
  let hold: Promise<void> | undefined;
  const a: Attester & { calls: AttestInput[]; probes: () => number; holdUntil(p: Promise<void>): void } = {
    calls, probes: () => probes, holdUntil(p) { hold = p; },
    async attest(i) { calls.push(i); if (hold) await hold; return result; },
    async probe() { probes += 1; return probe; },
  };
  return a;
}
const withAttester = (a: Attester | undefined) => rpcRig({ deps: { ...(a ? { attester: a } : {}) } });
const auditActions = (r: RpcRig) => r.audit.events.map((e) => e.action);

describe("approval.decide with an OS attestation", () => {
  it("answers attestation-required (and names the method) when a T1 connection decides a T2 request without asking for it", T, async () => {
    const a = spy();
    const r = await withAttester(a);
    const { id } = await r.park(SHELL);
    assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", scope: "session" })), { error: "E_APPROVAL_REQUIRED", reason: "attestation-required", detail: "touch-id" });
    assert.equal(a.calls.length, 0, "no dialog before the caller opted in");
    assert.equal((await r.call("approval.get", { id })).status, "pending");
    assert.equal(r.stores.grants.inspect().length, 0);
    r.service.dispose();
  });

  it("with attest: true, one confirmation approves exactly this request as T2 and the grant remembers where it came from", T, async () => {
    const a = spy();
    const r = await withAttester(a);
    const { id, answer } = await r.park(SHELL);
    const out = await r.call("approval.decide", { id, decision: "approve", scope: "session", attest: true });
    assert.equal(out.approval.status, "approved");
    assert.equal(out.approval.decisionSurface, 2);
    assert.equal(out.grant.scope, "session");
    assert.equal(out.grant.surface, 2);
    assert.equal(out.grant.attestedVia, "attested:touch-id");
    assert.equal((await answer).approved, true);
    assert.equal(a.calls.length, 1);
    const c = a.calls[0]!;
    assert.match(c.actionHash, /^[0-9a-f]{64}$/);
    assert.equal(c.requestId, id);
    assert.equal(c.person, "christian");
    assert.equal(c.agentId, "bernd");
    assert.equal(c.scope, "session");
    assert.match(c.text, /bernd/);
    assert.match(c.text, /shell\.exec/);
    assert.match(c.text, /session/);
    const decided = r.audit.events.find((e) => e.action === "approval.decided")!;
    assert.equal(decided.detail.attestedVia, "attested:touch-id");
    assert.equal(decided.detail.decisionSurface, 2);
    r.service.dispose();
  });

  it("a once approval is lifted too, and its once grant carries the origin", T, async () => {
    const r = await withAttester(spy({ ok: true, method: "windows-hello", at: 1 }));
    const { id } = await r.park(SHELL);
    const out = await r.call("approval.decide", { id, decision: "approve", attest: true });
    assert.equal(out.approval.decisionSurface, 2);
    const grants = r.stores.grants.inspect();
    assert.equal(grants.length, 1);
    assert.equal((grants[0]!.grant as any).attestedVia, "attested:windows-hello");
    r.service.dispose();
  });

  it("the confirmation is bound to the concrete approval: another scope or another request is another hash", T, async () => {
    const a = spy();
    const r = await withAttester(a);
    const one = await r.park(SHELL);
    const two = await r.park({ ...SHELL, actionHash: "cd".padEnd(64, "0") });
    await r.call("approval.decide", { id: one.id, decision: "approve", scope: "session", attest: true });
    await r.call("approval.decide", { id: two.id, decision: "approve", scope: "task", attest: true });
    await r.call("approval.decide", { id: (await r.park({ ...SHELL, actionHash: "ef".padEnd(64, "0") })).id, decision: "approve", scope: "task", attest: true });
    const hashes = a.calls.map((c) => c.actionHash);
    assert.equal(new Set(hashes).size, 3);
    r.service.dispose();
  });

  it("what the person confirms is what is decided: delegable is shown and bound, not taken from the stored request", T, async () => {
    const a = spy();
    const r = await withAttester(a);
    const one = await r.park(SHELL);
    const two = await r.park({ ...SHELL, actionHash: "cd".padEnd(64, "0") });
    const three = await r.park({ ...SHELL, actionHash: "cd".padEnd(64, "0") });
    await r.call("approval.decide", { id: one.id, decision: "approve", scope: "task", delegable: true, attest: true });
    assert.match(a.calls[0]!.text, /helpers/);
    assert.match(a.calls[0]!.text, /shell\.run/);
    await r.call("approval.decide", { id: two.id, decision: "approve", scope: "task", attest: true });
    assert.doesNotMatch(a.calls[1]!.text, /helpers/);
    void three;
    r.service.dispose();
  });

  it("a cancelled, timed-out or failed confirmation approves nothing and leaves the request pending", T, async () => {
    for (const reason of ["cancelled", "timeout", "failed", "replay", "mismatch"] as const) {
      const r = await withAttester(spy({ ok: false, reason }));
      const { id } = await r.park(SHELL);
      assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", attest: true })), { error: "E_DENIED", reason: "attestation-failed", detail: reason });
      assert.equal((await r.call("approval.get", { id })).status, "pending");
      assert.equal(r.stores.grants.inspect().length, 0);
      r.service.dispose();
    }
  });

  it("without a usable helper the answer is attestation-unavailable and the T1 limits stand", T, async () => {
    const cases: [Attester | undefined, boolean[]][] = [
      [spy({ ok: false, reason: "unavailable" }, { available: false, reason: "unavailable" }), [false, true]],
      [spy({ ok: false, reason: "unavailable" }), [true]], // the probe looked fine, the dialog could not be shown
    ];
    for (const [a, asks] of cases) {
      const r = await withAttester(a);
      const { id } = await r.park(SHELL);
      for (const attest of asks) {
        assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", attest })), { error: "E_NOT_AVAILABLE", reason: "attestation-unavailable" });
      }
      assert.equal((await r.call("approval.get", { id })).status, "pending");
      // Denying never needs an attestation.
      assert.equal((await r.call("approval.decide", { id, decision: "deny" })).approval.status, "denied");
      r.service.dispose();
    }
  });

  it("with no attester wired in at all, the D109 refusal is unchanged", T, async () => {
    const r = await withAttester(undefined);
    const { id } = await r.park(SHELL);
    for (const attest of [false, true]) assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", attest })), { error: "E_DENIED", reason: "surface-untrusted" });
    r.service.dispose();
  });

  it("an agent principal can never attest: refused before any helper is touched", T, async () => {
    const a = spy();
    const r = await withAttester(a);
    const { id } = await r.park(SHELL);
    r.who = AGENT_PRINCIPAL;
    assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", attest: true })), { error: "E_DENIED", reason: "agent-principal" });
    assert.equal(a.calls.length, 0);
    assert.equal(a.probes(), 0);
    r.service.dispose();
  });

  it("a request that needs T3 is refused without any dialog: attestation lifts to T2 only", T, async () => {
    const a = spy();
    const r = await withAttester(a);
    const { id } = await r.park({ capability: "money.spend", tool: "shop.buy", effect: "money", targets: [] });
    assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", attest: true })), { error: "E_DENIED", reason: "surface-untrusted" });
    assert.equal(a.calls.length, 0);
    r.service.dispose();
  });

  it("a request T1 may decide, and a connection the embedder attested (T3), never reach the helper", T, async () => {
    const a = spy();
    const r = await withAttester(a);
    const low = await r.park();
    assert.equal((await r.call("approval.decide", { id: low.id, decision: "approve", attest: true })).approval.decisionSurface, 1);
    r.attestation = { kind: "desktop-app" };
    const t2 = await r.park({ ...SHELL, actionHash: "cd".padEnd(64, "0") });
    const out = await r.call("approval.decide", { id: t2.id, decision: "approve", attest: true });
    assert.equal(out.approval.decisionSurface, 3);
    assert.equal(out.approval.status, "approved");
    assert.equal(a.calls.length, 0);
    r.service.dispose();
  });

  it("a decision relayed with a nonce (a chat channel) never opens a dialog on the host", T, async () => {
    const a = spy();
    const r = await withAttester(a);
    const { id, nonce } = await r.park(SHELL);
    assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", nonce, attest: true })), { error: "E_DENIED", reason: "surface-untrusted" });
    assert.equal(a.calls.length, 0);
    r.service.dispose();
  });

  it("two decisions racing for one request cannot both open a dialog", T, async () => {
    let release!: () => void;
    const a = spy();
    a.holdUntil(new Promise<void>((res) => { release = res; }));
    const r = await withAttester(a);
    const { id } = await r.park(SHELL);
    const first = r.call("approval.decide", { id, decision: "approve", attest: true });
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", attest: true })), { error: "E_CONFLICT", reason: "attestation-in-progress" });
    release();
    assert.equal((await first).approval.status, "approved");
    assert.equal(a.calls.length, 1);
    r.service.dispose();
  });

  it("audits the attestation requested and its outcome around the decision (real service, fake helper)", T, async () => {
    const sink = memoryAuditSink();
    const attester = createAttestationService({ helper: { path: process.execPath, args: [FAKE, "ok"] }, audit: createPolicyAudit({ sink, clock: { now: () => Date.now() }, host: "h" }) });
    const r = await withAttester(attester);
    const { id, answer } = await r.park(SHELL);
    const out = await r.call("approval.decide", { id, decision: "approve", scope: "session", attest: true });
    assert.equal(out.grant.attestedVia, "attested:fake-biometric");
    assert.equal((await answer).approved, true);
    assert.ok(auditActions(r).includes("approval.decided"));
    assert.deepEqual(sink.events.map((e) => e.action), ["attestation.requested", "attestation.result"]);
    assert.equal(sink.events[1]!.detail.attestationOutcome, "confirmed");
    assert.equal(sink.events[1]!.detail.method, "fake-biometric");
    assert.equal(sink.events[0]!.target, `approval:${id}`);
    assert.ok(!JSON.stringify(sink.events).includes("nonce"));
    r.service.dispose();
  });
});
