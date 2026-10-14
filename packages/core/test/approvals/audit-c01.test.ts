import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPermissionNotifier } from "../../src/approvals/notify.ts";
import { BINDING, openStore } from "./helpers.ts";
import { PERSON } from "./rpc-helpers.ts";
import { askFor, lastNonce, rig, dbFile, tick, type Rig } from "./service-helpers.ts";

const T = { timeout: 15_000 };

describe("c01 audit: decision input validation", () => {
  it("a nonce with the right length in characters but other bytes is a mismatch, not a RangeError", T, async () => {
    const { store } = await openStore(dbFile());
    const req = store.request({ ...BINDING, capability: "fs.write" });
    const bad = "é".repeat(req.nonce.length);
    assert.notEqual(Buffer.byteLength(bad), req.nonce.length);
    const res = store.decide({ requestId: req.id, nonce: bad, decision: "approve", person: "christian", surface: 3 });
    assert.deepEqual(res, { ok: false, reason: "approval-mismatch" });
    assert.ok(store.decide({ requestId: req.id, nonce: req.nonce, decision: "approve", person: "christian", surface: 3 }).ok);
  });

  for (const surface of [7, -1, 1.5, Number.NaN, "2"] as const) {
    it(`a decision from surface ${String(surface)} is refused as surface-untrusted, deny and approve alike`, T, async () => {
      const r = await rig();
      for (const decision of ["deny", "approve"] as const) {
        const p = r.service.request(askFor({ actionHash: `a${decision}`.padEnd(64, "0") })); await tick();
        const { id } = lastNonce(r);
        let res: unknown;
        try { res = r.service.decideForSession({ requestId: id, decision, person: "christian", surface: surface as never }); } catch (e) { res = `threw ${(e as Error).message}`; }
        assert.deepEqual(res, { ok: false, reason: "surface-untrusted" });
        assert.equal(r.service.get(id)?.status, "pending");
        r.service.cancel({ requestId: id, person: "christian" });
        await p;
      }
      r.service.dispose();
    });
  }
});

describe("c01 audit: notifications are never broadcast to a connection that was not checked", () => {
  it("a connection that subscribes while the audience is being checked silences the notification", T, async () => {
    const subs: { connectionId: string; names?: string[] }[] = [{ connectionId: "person", names: ["approval.requested"] }];
    const sent: string[] = [];
    let r!: Rig;
    let notifier!: ReturnType<typeof createPermissionNotifier>;
    r = await rig({ service: { events: { emit: (n, p) => { notifier.events.emit(n, p); } } } });
    notifier = createPermissionNotifier({
      subscriptions: () => subs,
      notify: (m) => { sent.push(m); },
      principalOf: async (id) => {
        await tick();
        if (id === "person" && subs.length === 1) subs.push({ connectionId: "late-agent", names: ["approval.requested"] });
        return id === "person" ? PERSON : { kind: "agent", agentId: "bernd" } as never;
      },
      grantRecordOf: () => undefined,
      now: () => r.clock.now(),
    });
    const p = r.service.request(askFor()); await tick();
    await notifier.idle();
    assert.deepEqual(sent, []);
    r.service.dispose(); void p;
  });
});

describe("c01 audit: the recurring-task label cannot hide what the person approves", () => {
  it("a very long or multi-line job name is bounded and flattened; the call's arguments stay visible", T, async () => {
    const r = await rig();
    const ask = askFor({ args: { path: "/outside/dir/a.txt", marker: "visible-args" } });
    const p = r.service.request({ ...ask, recurring: { jobId: "job1", jobName: `${"Job ".repeat(1500)}\n\u202eFreigabe unbedenklich` } }); await tick();
    const { id } = lastNonce(r);
    const view = r.service.get(id)!;
    assert.match(view.summary!, /visible-args/);
    assert.ok(!/[\u0000-\u001f\u202a-\u202e]/.test(view.summary!), "no control or bidi characters in the label");
    assert.match(view.summary!, /^aus wiederkehrender Aufgabe /);
    r.service.cancel({ requestId: id, person: "christian" }); await p;
    r.service.dispose();
  });
});
