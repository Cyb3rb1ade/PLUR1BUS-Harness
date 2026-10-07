// Rows: replay and store integrity (nonce, binding, expiry, a tampered / deleted / reordered / truncated / forged chain, T0), the
// timeouts (10 min foreground, 24 h, abort) and the audit trail. Real stores, service and dispatcher; the chain attacks go through
// a second SQLite connection to the same file, which is what an attacker with write access to the file would hold.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createApprovalStore } from "../../src/approvals/store.ts";
import { staticKeySource } from "../../src/approvals/keys.ts";
import { ACTIVE_NAME } from "../../src/audit/chain.ts";
import type { ServiceDecideResult } from "../../src/approvals/service.ts";
import { OTHER_KEY } from "../approvals/helpers.ts";
import { askFor, lastNonce } from "../approvals/service-helpers.ts";
import { DAY, HOUR, MIN, codeOf, settle, tick, type E2ERow, type Handle, type Verdict, type World } from "./permission-eval-e2e.fixtures.ts";

const WRITE = { content: "x" };
const verdictOf = (res: ServiceDecideResult): Verdict => ({ done: res.ok, code: res.ok ? "ok" : res.reason });
const refusalReason = (w: World): string => String([...w.audit].reverse().find((e) => e.action === "approval.refused")?.detail.reason ?? "none");
const chainCode = (w: World): string => { const v = w.r.service.verify(); return v.ok ? "chain-ok" : `chain:${v.brokenAt}:${v.reason}`; };

async function parkedWrite(w: World, input = w.f.otherB, extra: Record<string, unknown> = WRITE): Promise<Handle> {
  const h = await w.startPath("fs.write", input, extra);
  await tick(); await tick();
  return h;
}

type AskOpts = Parameters<typeof askFor>[0];
/** A request parked in the service (what a surface would see), with the nonce a channel relay holds. */
async function park(w: World, o: AskOpts = {}) {
  const ask = askFor(o);
  const answer = w.r.service.request(ask);
  await tick();
  return { ask, answer, ...lastNonce(w.r) };
}
const decideNow = (w: World, p: { id: string; nonce: string }, o: { person?: string; surface?: 0 | 1 | 2 | 3; decision?: "approve" | "deny" } = {}): ServiceDecideResult =>
  w.r.service.decide({ requestId: p.id, nonce: p.nonce, decision: o.decision ?? "approve", person: o.person ?? "christian", surface: o.surface ?? 3 });

/** Approve a parked request, then try to start execution with an ask that differs in one binding element. */
async function beginWith(w: World, variant: AskOpts): Promise<Verdict> {
  const p = await park(w);
  const dec = decideNow(w, p);
  if (!dec.ok) throw new Error(`setup decision refused: ${dec.reason}`);
  const answer = await p.answer;
  const ok = w.r.service.begin(answer, askFor(variant));
  return { done: ok, code: ok ? "begun" : refusalReason(w) };
}
const beginSame = async (w: World): Promise<Verdict> => beginWith(w, {});
const beginRow = (id: string, what: string, variant: AskOpts): E2ERow => ({
  id, group: "replay-store", what, expect: "approval-mismatch", attack: (w) => beginWith(w, variant), benign: beginSame,
});

const raw = (w: World) => w.raw();
const hexOf = (n: string): string => n.padEnd(64, "0");

export const REPLAY_ROWS: E2ERow[] = [
  {
    id: "replay-nonce-twice", group: "replay-store", what: "the same decision (same nonce) is accepted once", expect: "approval-used",
    attack: async (w) => { const p = await park(w); decideNow(w, p); return verdictOf(decideNow(w, p)); },
    benign: async (w) => verdictOf(decideNow(w, await park(w))),
  },
  {
    id: "replay-foreign-nonce", group: "replay-store", what: "a decision with another request's nonce is refused", expect: "approval-mismatch",
    attack: async (w) => { const a = await park(w, { actionHash: hexOf("a1") }); const b = await park(w, { actionHash: hexOf("b2") }); return verdictOf(decideNow(w, { id: a.id, nonce: b.nonce })); },
    benign: async (w) => { await park(w, { actionHash: hexOf("a1") }); return verdictOf(decideNow(w, await park(w, { actionHash: hexOf("b2") }))); },
  },
  {
    id: "replay-other-person", group: "replay-store", what: "another person cannot decide christian's request (nonce or session path)", expect: "approval-mismatch",
    attack: async (w) => {
      const p = await park(w);
      const viaNonce = decideNow(w, p, { person: "anna" });
      const viaSession = w.r.service.decideForSession({ requestId: p.id, decision: "approve", person: "anna", surface: 3 });
      return { done: viaNonce.ok || viaSession.ok, code: viaNonce.ok ? "ok" : viaNonce.reason };
    },
    benign: async (w) => verdictOf(decideNow(w, await park(w))),
  },
  beginRow("replay-begin-other-args", "an approval is not usable for a call with other arguments (other action hash)", { actionHash: hexOf("h2") }),
  beginRow("replay-begin-other-agent", "an approval is not usable by another agent", { agentId: "mallory" }),
  beginRow("replay-begin-other-session", "an approval is not usable in another session", { sessionId: "s9" }),
  beginRow("replay-begin-other-task", "an approval is not usable in another task", { taskId: "t9" }),
  beginRow("replay-begin-other-turn", "an approval is not usable in another turn", { turnId: "turn9" }),
  beginRow("replay-begin-other-principal", "an approval is not usable for another person's call", { principal: "anna" }),
  {
    id: "replay-begin-twice", group: "replay-store", what: "a consumed approval cannot start a second execution", expect: "approval-used",
    attack: async (w) => {
      const p = await park(w); decideNow(w, p);
      const answer = await p.answer;
      if (!w.r.service.begin(answer, p.ask)) throw new Error("setup begin refused");
      const again = w.r.service.begin(answer, p.ask);
      return { done: again, code: again ? "begun" : refusalReason(w) };
    },
    benign: beginSame,
  },
  {
    id: "replay-decide-after-expiry", group: "replay-store", what: "a request older than 24 h cannot be approved", expect: "approval-expired",
    attack: async (w) => { const p = await park(w); w.r.timers.advance(DAY); return verdictOf(decideNow(w, p)); },
    benign: async (w) => { const p = await park(w); w.r.timers.advance(DAY - MIN); return verdictOf(decideNow(w, p)); },
  },
  {
    id: "replay-begin-after-expiry", group: "replay-store", what: "an approval that sat unused for 24 h cannot start an execution", expect: "approval-expired",
    attack: async (w) => {
      const p = await park(w); decideNow(w, p);
      const answer = await p.answer;
      w.r.clock.advance(DAY + 1);
      const ok = w.r.service.begin(answer, p.ask);
      return { done: ok, code: ok ? "begun" : refusalReason(w) };
    },
    benign: beginSame,
  },
  {
    id: "decide-from-T0", group: "replay-store", what: "a decision from a T0 surface (an agent's, a peer's) is refused on both decision paths", expect: "surface-untrusted",
    attack: async (w) => {
      const p = await park(w);
      const a = decideNow(w, p, { surface: 0 });
      const b = w.r.service.decideForSession({ requestId: p.id, decision: "approve", person: "christian", surface: 0 });
      const c = decideNow(w, p, { surface: 0, decision: "deny" });
      return { done: a.ok || b.ok || c.ok, code: a.ok ? "ok" : a.reason };
    },
    benign: async (w) => verdictOf(decideNow(w, await park(w), { surface: 2 })),
  },
  {
    id: "decide-T1-medium-risk", group: "replay-store", what: "an editor surface (T1) cannot approve a medium-risk shell command", expect: "surface-untrusted",
    attack: async (w) => verdictOf(decideNow(w, await park(w, { capability: "shell.exec", tool: "shell.run", effect: "local-write" }), { surface: 1 })),
    benign: async (w) => verdictOf(decideNow(w, await park(w, { capability: "shell.exec", tool: "shell.run", effect: "local-write" }), { surface: 2 })),
  },
  {
    id: "decide-cancelled-request", group: "replay-store", what: "a request the person withdrew can no longer be approved", expect: "approval-expired",
    attack: async (w) => {
      const p = await park(w);
      if (!w.r.service.cancel({ requestId: p.id, person: "christian" }).ok) throw new Error("cancel refused");
      return verdictOf(decideNow(w, p));
    },
    benign: async (w) => verdictOf(decideNow(w, await park(w))),
  },
  {
    id: "chain-tampered-entry", group: "replay-store", what: "a modified chain entry is reported at its position and nothing is decided any more", expect: "chain:2:mac-mismatch",
    attack: async (w) => {
      await park(w, { actionHash: hexOf("a1") });
      const b = await park(w, { actionHash: hexOf("b2") });
      raw(w).prepare("UPDATE approval_chain SET payload = replace(payload, 'bernd', 'mallory') WHERE seq = 2").run();
      let accepted = false;
      try { accepted = decideNow(w, b).ok; } catch { /* a broken chain throws */ }
      return { done: accepted, code: chainCode(w) };
    },
    benign: async (w) => { await park(w, { actionHash: hexOf("a1") }); const b = await park(w, { actionHash: hexOf("b2") }); return { done: decideNow(w, b).ok && chainCode(w) === "chain-ok", code: chainCode(w) }; },
  },
  {
    id: "chain-deleted-entry", group: "replay-store", what: "a deleted chain entry is reported at its position; the approval cannot start", expect: "chain:2:seq-gap",
    attack: async (w) => {
      const a = await park(w, { actionHash: hexOf("a1") });
      await park(w, { actionHash: hexOf("b2") });
      decideNow(w, a); // seq 3
      const answer = await a.answer;
      raw(w).prepare("DELETE FROM approval_chain WHERE seq = 2").run();
      return { done: w.r.service.begin(answer, a.ask), code: chainCode(w) };
    },
    benign: async (w) => { const a = await park(w); decideNow(w, a); return { done: w.r.service.begin(await a.answer, a.ask), code: chainCode(w) }; },
  },
  {
    id: "chain-reordered-entries", group: "replay-store", what: "two swapped chain entries are reported at the first wrong position", expect: "chain:2:prev-mismatch",
    attack: async (w) => {
      const a = await park(w, { actionHash: hexOf("a1") });
      await park(w, { actionHash: hexOf("b2") });
      decideNow(w, a); // seq 3
      const answer = await a.answer;
      const db = raw(w);
      db.exec("UPDATE approval_chain SET seq = -1 WHERE seq = 2; UPDATE approval_chain SET seq = 2 WHERE seq = 3; UPDATE approval_chain SET seq = 3 WHERE seq = -1;");
      return { done: w.r.service.begin(answer, a.ask), code: chainCode(w) };
    },
  },
  {
    id: "chain-truncated-tail", group: "replay-store", what: "cutting the newest entries (a recorded denial) is caught by the keyed head and blocks a re-decision", expect: "chain:2:truncated",
    attack: async (w) => {
      const p = await park(w);
      decideNow(w, p, { decision: "deny" }); // seq 2
      raw(w).prepare("DELETE FROM approval_chain WHERE seq = 2").run();
      let accepted = false;
      try { accepted = w.r.service.decideForSession({ requestId: p.id, decision: "approve", person: "christian", surface: 3 }).ok; } catch { /* broken chain */ }
      return { done: accepted, code: chainCode(w) };
    },
  },
  {
    id: "chain-foreign-key", group: "replay-store", what: "a chain written under another key fails at its first entry and decides nothing", expect: "chain:1:mac-mismatch",
    attack: async (w) => {
      const p = await park(w);
      const store = await createApprovalStore({ db: raw(w), keys: staticKeySource(OTHER_KEY), clock: w.r.clock });
      let accepted = false;
      try { accepted = store.decide({ requestId: p.id, nonce: p.nonce, decision: "approve", person: "christian", surface: 3 }).ok; } catch { /* broken chain */ }
      const v = store.verify();
      return { done: accepted, code: v.ok ? "chain-ok" : `chain:${v.brokenAt}:${v.reason}` };
    },
  },
  {
    id: "chain-forged-decision-row", group: "replay-store", what: "an unsigned 'approved' row appended to the chain starts nothing", expect: "chain:2:mac-mismatch",
    attack: async (w) => {
      const p = await park(w);
      const db = raw(w);
      const last = db.prepare("SELECT mac FROM approval_chain WHERE seq = 1").get() as { mac: string };
      const bound = JSON.stringify({ decision: "approve", person: "christian", surface: 3, delegable: false });
      db.prepare("INSERT INTO approval_chain (seq, ts, kind, ref_id, nonce, payload, prev_mac, mac) VALUES (2, ?, 'approval.decided', ?, ?, ?, ?, ?)").run(w.r.clock.now(), p.id, p.nonce, bound, last.mac, "e".repeat(64));
      const ok = w.r.service.begin({ approved: true, requestId: p.id, scope: "once", grantIds: [] }, p.ask);
      return { done: ok, code: chainCode(w) };
    },
  },
  {
    id: "projection-forged-status", group: "replay-store", what: "the approvals table is a projection: setting status='approved' there starts nothing", expect: "approval-mismatch",
    attack: async (w) => {
      const p = await park(w);
      raw(w).prepare("UPDATE approvals SET status = 'approved', decided_by = 'christian' WHERE id = ?").run(p.id);
      const ok = w.r.service.begin({ approved: true, requestId: p.id, scope: "once", grantIds: [] }, p.ask);
      return { done: ok, code: ok ? "begun" : refusalReason(w) };
    },
    benign: beginSame,
  },
  {
    id: "repeat-denied-without-asking", group: "replay-store", what: "re-asking a call the person denied is refused without a new prompt", expect: "denied:fatigue:repeat-denied",
    attack: async (w) => {
      const h = await parkedWrite(w);
      w.decide({ decision: "deny" });
      if (codeOf(await h.promise) !== "denied-by-person") throw new Error("setup: expected a denial");
      const before = w.r.stores.approvals.list().length;
      const v = await w.probe("fs.write", w.f.otherB, WRITE);
      return w.r.stores.approvals.list().length === before ? v : { done: true, code: "asked-again" };
    },
  },
  {
    id: "prompt-cap-per-task-hour", group: "replay-store", what: "the 11th prompt of a task within an hour is refused, not queued", expect: "denied:fatigue:prompt-cap",
    attack: async (w) => {
      const hs: Handle[] = [];
      for (let i = 0; i < 10; i++) hs.push(await parkedWrite(w, w.f.otherB, { content: `c${i}` }));
      const v = await w.probe("fs.write", w.f.otherB, { content: "c10" });
      await settle(hs);
      return v;
    },
  },
];

export const TIMEOUT_ROWS: E2ERow[] = [
  {
    id: "timeout-foreground-10min-parks", group: "timeouts", what: "after 10 min the call is parked, not approved; a later decision does not revive it", expect: "parked",
    attack: async (w) => {
      const h = await parkedWrite(w);
      w.r.timers.advance(10 * MIN);
      const res = await h.promise;
      const decided = w.decide(); // the person answers late
      await tick(); await tick();
      return { done: w.runs.length > 0 || !decided.ok, code: codeOf(res) };
    },
    benign: async (w) => { const h = await parkedWrite(w); w.r.timers.advance(9 * MIN); w.decide(); const res = await h.promise; return { done: !res.isError, code: codeOf(res) }; },
  },
  {
    id: "timeout-24h-expires-denied", group: "timeouts", what: "a request nobody answers for 24 h expires = denied; it cannot be approved afterwards", expect: "expired",
    world: { foregroundWaitMs: 48 * HOUR },
    attack: async (w) => {
      const h = await parkedWrite(w);
      const id = w.pendingIds()[0]!;
      w.r.timers.advance(DAY);
      const res = await h.promise;
      const late = w.decide({ id });
      const status = w.r.stores.approvals.get(id)!.status;
      if (status !== "expired") throw new Error(`status ${status}`);
      return { done: w.runs.length > 0 || late.ok, code: codeOf(res) };
    },
    benign: async (w) => { const h = await parkedWrite(w); w.r.timers.advance(23 * HOUR); w.decide(); const res = await h.promise; return { done: !res.isError, code: codeOf(res) }; },
  },
  {
    id: "timeout-abort-while-waiting", group: "timeouts", what: "aborting a waiting call cancels its request; it can no longer be approved", expect: "aborted",
    attack: async (w) => {
      const h = await parkedWrite(w);
      const id = w.pendingIds()[0]!;
      h.ac.abort();
      const res = await h.promise;
      const late = w.decide({ id });
      if (w.r.stores.approvals.get(id)!.status !== "cancelled") throw new Error("request not cancelled");
      return { done: w.runs.length > 0 || late.ok, code: codeOf(res) };
    },
  },
  {
    id: "timeout-shutdown-approves-nothing", group: "timeouts", what: "shutting the service down ends every waiting call as not approved", expect: "shutdown",
    attack: async (w) => {
      const hs = [await parkedWrite(w, w.f.otherB, { content: "1" }), await parkedWrite(w, w.f.otherB, { content: "2" })];
      w.r.service.dispose();
      const codes = new Set((await Promise.all(hs.map((h) => h.promise))).map(codeOf));
      return { done: w.runs.length > 0, code: [...codes].join(",") };
    },
  },
  {
    id: "timeout-nothing-auto-approved", group: "timeouts", what: "after 100 days of silence nothing was approved and nothing ran", expect: "none-approved",
    attack: async (w) => {
      const hs = [await parkedWrite(w, w.f.otherB, { content: "1" }), await parkedWrite(w, w.f.otherB, { content: "2" })];
      w.r.timers.advance(100 * DAY);
      await Promise.all(hs.map((h) => h.promise));
      const approved = w.r.stores.approvals.list().filter((r) => r.status === "approved" || r.status === "used").length;
      return { done: w.runs.length > 0 || approved > 0, code: approved === 0 ? "none-approved" : "approved" };
    },
  },
];

export const AUDIT_ROWS: E2ERow[] = [
  {
    id: "audit-down-nothing-runs", group: "audit", what: "when the audit trail cannot record, even an allowed call does not run", expect: "tool-denied",
    attack: async (w) => { w.auditDown = true; return w.probe("fs.read", w.f.wsA); },
    benign: (w) => w.probe("fs.read", w.f.wsA),
  },
  {
    id: "audit-every-decision", group: "audit", what: "every decision (allow, deny-list, never, approval) leaves a policy.decision line; the approval path leaves its whole trail", expect: "complete",
    attack: async (w) => {
      await w.probe("fs.read", w.f.wsA);
      await w.probe("fs.read", w.f.wsKey);
      await w.probeCall("grant.create", { capability: "fs.write" });
      await w.approvedCall("fs.write", w.f.otherB, { extra: WRITE });
      const missing: string[] = [];
      const decisions = w.audit.filter((e) => e.action === "policy.decision").map((e) => `${String(e.detail.tool)}:${String(e.detail.outcome)}`);
      const want = ["fs.read:allowed", "fs.read:never", "grant.create:never", "fs.write:approval"];
      if (JSON.stringify(decisions) !== JSON.stringify(want)) missing.push(`decisions ${JSON.stringify(decisions)}`);
      for (const a of ["approval.requested", "approval.decided", "grant.created", "approval.consumed", "grant.consumed", "policy.outcome"]) if (!w.actions().includes(a)) missing.push(a);
      if (missing.length > 0) console.error(missing);
      return { done: missing.length > 0, code: missing.length > 0 ? `missing:${missing.join("|")}` : "complete" };
    },
  },
  {
    id: "audit-secrets-never-stored", group: "audit", what: "secret-shaped values in the arguments reach neither the audit lines, the approval views nor the stored chain", expect: "clean",
    attack: async (w) => {
      const secrets = {
        ghp: `ghp_${"A1b2".repeat(9)}`, anthropic: `sk-ant-api03-${"Zz9".repeat(12)}`, aws: "AKIAIOSFODNN7EXAMPLE",
        bearer: "Bearer q8Xr2LmN0pVt7yKd4HsW1aZc", url: "https://user:hunter2hunter2@host.example/x",
      };
      const content = `Authorization: ${secrets.bearer}\nkey=${secrets.ghp}\n${secrets.anthropic} ${secrets.aws} ${secrets.url}`;
      const res = await w.approvedCall("fs.write", w.f.otherB, { extra: { content } });
      if (res.isError) throw new Error(`setup call failed: ${codeOf(res)}`);
      await w.probe("fs.read", path.join(w.f.other, secrets.ghp, "f.txt")); // a token-shaped path segment lands in the request and decision lines
      const db = raw(w);
      const hay = JSON.stringify([
        w.audit, w.r.service.list(),
        db.prepare("SELECT payload FROM approval_chain").all(), db.prepare("SELECT * FROM approvals").all(), db.prepare("SELECT * FROM grants").all(),
      ]);
      const leaked = Object.entries({ ghp: secrets.ghp, anthropic: secrets.anthropic, aws: secrets.aws, bearer: secrets.bearer.slice(7), url: "hunter2hunter2" }).filter(([, v]) => hay.includes(v)).map(([k]) => k);
      return { done: leaked.length > 0, code: leaked.length > 0 ? `leak:${leaked.join(",")}` : "clean" };
    },
  },
  {
    id: "audit-carries-no-argument-text", group: "audit", what: "file content in the arguments and results never appears in an audit line (only hash and size)", expect: "clean",
    attack: async (w) => {
      const body = "PLAIN-CONFIDENTIAL-BODY-4711";
      await w.approvedCall("fs.write", w.f.otherB, { extra: { content: body } });
      await w.probe("fs.write", path.join(w.f.ws, "own.txt"), { content: body });
      const hay = JSON.stringify(w.audit);
      return { done: hay.includes(body), code: hay.includes(body) ? "leak" : "clean" };
    },
  },
  {
    id: "audit-chain-detects-tampering", group: "audit", what: "the hash-chained audit file verifies, and an edited line is detected", expect: "detected",
    world: { auditChain: true },
    attack: async (w) => {
      await w.probe("fs.read", w.f.wsA);
      await w.approvedCall("fs.write", w.f.otherB, { extra: WRITE });
      if (!w.chain!.verify().ok) throw new Error("untampered chain does not verify");
      const file = path.join(w.chain!.dir, ACTIVE_NAME);
      writeFileSync(file, readFileSync(file, "utf8").replace('"outcome":"allowed"', '"outcome":"approved"'));
      const v = w.chain!.verify();
      return { done: v.ok, code: v.ok ? "undetected" : "detected" };
    },
    benign: async (w) => { await w.probe("fs.read", w.f.wsA); return { done: w.chain!.verify().ok, code: "verified" }; },
  },
];
