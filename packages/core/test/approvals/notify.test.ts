import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateNotification } from "@plur1bus/rpc-schema";
import { createPermissionNotifier, type PermissionNotifier } from "../../src/approvals/notify.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { AGENT_PRINCIPAL, OTHER_PERSON, PERSON } from "./rpc-helpers.ts";
import { askFor, lastNonce, rig, tick, type Rig } from "./service-helpers.ts";

const T = { timeout: 20_000 };
type Sub = { connectionId: string; names?: string[] };
const OPT_IN = ["approval.requested", "approval.resolved", "grant.changed"];

async function setup(subs: Sub[], who: Record<string, Principal | null | "throw">) {
  const sent: { method: string; params: any; opts: unknown }[] = [];
  let notifier!: PermissionNotifier;
  let r!: Rig;
  r = await rig({ service: { events: { emit: (n, p) => { r.events.push({ name: n, payload: p }); notifier.events.emit(n, p); } } } });
  notifier = createPermissionNotifier({
    subscriptions: () => subs,
    notify: (method, params, opts) => { sent.push({ method, params, opts }); },
    principalOf: async (connectionId) => { const p = who[connectionId]; if (p === "throw") throw new Error("resolver down"); return p; },
    grantRecordOf: (id, person) => { const v = r.stores.grants.inspect({ person }).find((x) => x.grant.id === id); return v ? { grant: v.grant, state: v.state } : undefined; },
    now: () => r.clock.now(),
  });
  return { r, sent, notifier };
}
const request = async (r: Rig) => { const p = r.service.request(askFor({ actionHash: "ab".padEnd(64, "0") })); await tick(); return { ...lastNonce(r), answer: p }; };

describe("permission notifications (D109 §5)", () => {
  it("approval.requested goes to an opted-in person connection of the request's person, without the nonce", T, async () => {
    const { r, sent, notifier } = await setup([{ connectionId: "c1", names: OPT_IN }], { c1: PERSON });
    const { id, nonce } = await request(r);
    await notifier.idle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.method, "approval.requested");
    assert.deepEqual(sent[0]!.opts, { optIn: true });
    assert.equal(sent[0]!.params.approval.id, id);
    assert.ok(validateNotification("approval.requested", sent[0]!.params).ok, JSON.stringify(validateNotification("approval.requested", sent[0]!.params)));
    assert.ok(!JSON.stringify(sent[0]).includes(nonce));
    assert.deepEqual(Object.keys(sent[0]!.params), ["approval"]);
    r.service.dispose();
  });

  it("approval.resolved and grant.changed follow a decision, in order, and validate against the schema", T, async () => {
    const { r, sent, notifier } = await setup([{ connectionId: "c1", names: OPT_IN }], { c1: PERSON });
    const { id } = await request(r);
    r.service.decideForSession({ requestId: id, decision: "approve", person: "christian", surface: 3, scope: "task" });
    await notifier.idle();
    assert.deepEqual(sent.map((s) => s.method), ["approval.requested", "approval.resolved", "grant.changed"]);
    for (const s of sent) assert.ok(validateNotification(s.method, s.params).ok, `${s.method}: ${JSON.stringify(validateNotification(s.method, s.params))}`);
    assert.equal(sent[1]!.params.approval.status, "approved");
    assert.equal(sent[2]!.params.change, "created");
    assert.equal(sent[2]!.params.grant.scope, "task");
  });

  it("nobody opted in: nothing is sent; a subscription without names is not an opt-in", T, async () => {
    const { r, sent, notifier } = await setup([{ connectionId: "c1" }, { connectionId: "c2", names: ["core.state"] }], { c1: PERSON, c2: PERSON });
    await request(r);
    await notifier.idle();
    assert.deepEqual(sent, []);
    r.service.dispose();
  });

  it("an agent, a kind-less principal, another person, a role without approval.read, a failing resolver: the notification is withheld from everyone", T, async () => {
    const bad: [string, Principal | null | "throw"][] = [
      ["agent", AGENT_PRINCIPAL], ["no kind", { userId: "christian", role: "owner" }], ["other person", OTHER_PERSON],
      ["viewer", { userId: "christian", kind: "person", role: "viewer" }], ["no principal", null], ["resolver throws", "throw"],
    ];
    for (const [label, p] of bad) {
      const { r, sent, notifier } = await setup([{ connectionId: "good", names: OPT_IN }, { connectionId: "bad", names: OPT_IN }], { good: PERSON, bad: p });
      await request(r);
      await notifier.idle();
      assert.deepEqual(sent, [], label);
      r.service.dispose();
    }
  });

  it("grant.changed needs grant.read; an operator has approval.read but not grant.read", T, async () => {
    const operator: Principal = { userId: "christian", kind: "person", role: "operator" };
    const { r, sent, notifier } = await setup([{ connectionId: "c1", names: OPT_IN }], { c1: operator });
    const { id } = await request(r);
    r.service.decideForSession({ requestId: id, decision: "approve", person: "christian", surface: 3, scope: "task" });
    await notifier.idle();
    assert.deepEqual(sent.map((s) => s.method), ["approval.requested", "approval.resolved"]);
  });

  it("approval.parked is not a wire notification; close() stops delivery", T, async () => {
    const { r, sent, notifier } = await setup([{ connectionId: "c1", names: OPT_IN }], { c1: PERSON });
    await request(r);
    r.timers.advance(11 * 60_000);
    await notifier.idle();
    assert.deepEqual(sent.map((s) => s.method), ["approval.requested"]);
    notifier.close();
    r.service.dispose();
    await notifier.idle();
    assert.equal(sent.length, 1);
  });
});
