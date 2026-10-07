// Rows: roots and deny-list precedence, and the life cycle of grants (once / task / session / always). Every row runs against the
// real stores, service and dispatcher (see permission-eval-e2e.fixtures.ts).
import path from "node:path";
import { ApprovalChain } from "../../src/approvals/chain.ts";
import { GrantStore } from "../../src/grants/store.ts";
import { KEY } from "../approvals/helpers.ts";
import { DAY, HOUR, MIN, settle, tick, codeOf, type E2ERow, type Handle, type Verdict, type World } from "./permission-eval-e2e.fixtures.ts";

const fromResult = (res: Awaited<ReturnType<World["approvedCall"]>>): Verdict => ({ done: !res.isError, code: codeOf(res) });
const WRITE = { content: "x" };
const grantsOn = (w: World) => w.r.stores.grants;

/** A write outside the roots that is waiting for the person. */
async function parkedWrite(w: World, input = w.f.otherB, extra: Record<string, unknown> = WRITE): Promise<Handle> {
  const h = await w.startPath("fs.write", input, extra);
  await tick(); await tick();
  return h;
}

/** Breaks the chain at `seq` the way a file-level attacker without the key would: the entry's MAC no longer verifies (its payload stays intact, so only the chain position protects). */
function tamper(w: World, seq: number): void {
  w.raw().prepare("UPDATE approval_chain SET mac = ? WHERE seq = ?").run("f".repeat(64), seq);
}

export const ROOT_ROWS: E2ERow[] = [
  {
    id: "roots-outside-read", group: "roots", what: "a read outside every root needs an approval", expect: "pending",
    attack: (w) => w.probe("fs.read", w.f.otherB), benign: (w) => w.probe("fs.read", w.f.wsA),
  },
  {
    id: "roots-outside-write", group: "roots", what: "a write outside every root needs an approval", expect: "pending",
    attack: (w) => w.probe("fs.write", w.f.otherB, WRITE), benign: (w) => w.probe("fs.write", path.join(w.f.ws, "new.txt"), WRITE),
  },
  {
    id: "roots-sibling-prefix", group: "roots", what: "/ws-evil is not inside the root /ws", expect: "pending",
    attack: (w) => w.probe("fs.read", w.f.evilX), benign: (w) => w.probe("fs.read", w.f.wsN),
  },
  {
    id: "roots-dotdot", group: "roots", what: "ws/../other never reaches the policy: '..' is refused by the path layer", expect: "path-refused:dot-dot",
    attack: (w) => w.probe("fs.read", [w.f.ws, "..", "other", "b.txt"].join(path.sep)),
    benign: (w) => w.probe("fs.read", [w.f.ws, ".", "a.txt"].join(path.sep)),
  },
  {
    id: "deny-ssh-beats-root-grant", group: "roots", what: "~/.ssh is refused even under a recursive read grant on the whole root", expect: "denied:deny-list",
    attack: (w) => { w.grant({ dir: w.f.ws, capability: "fs.read", access: "read" }); return w.probe("fs.read", w.f.wsKey); },
    benign: (w) => { w.grant({ dir: w.f.ws, capability: "fs.read", access: "read" }); return w.probe("fs.read", w.f.wsN); },
  },
  {
    id: "deny-dotenv-write-beats-grant", group: "roots", what: "a .env is refused for writing under a write grant on its folder", expect: "denied:deny-list",
    attack: (w) => { w.grant({ dir: w.f.ws }); return w.probe("fs.write", w.f.wsEnv, WRITE); },
    benign: (w) => { w.grant({ dir: w.f.ws }); return w.probe("fs.write", path.join(w.f.ws, "sub", "env.txt"), WRITE); },
  },
  {
    id: "deny-browser-profile-in-root", group: "roots", what: "a browser profile inside a root is refused", expect: "denied:deny-list",
    attack: (w) => w.probe("fs.read", w.f.wsCookies), benign: (w) => w.probe("fs.read", w.f.wsA),
  },
  {
    id: "deny-browser-profile-parent-grant", group: "roots", what: "a grant on the PARENT folder of a browser profile does not beat the deny-list", expect: "denied:deny-list",
    attack: (w) => { w.grant({ dir: path.join(w.f.home, ".config"), capability: "fs.read", access: "read" }); return w.probe("fs.read", w.f.chrome); },
    benign: (w) => { w.grant({ dir: path.join(w.f.home, ".config"), capability: "fs.read", access: "read" }); return w.probe("fs.read", w.f.appJson); },
  },
  {
    id: "deny-profile-write-parent-grant", group: "roots", what: "a write grant on the parent of a browser profile does not beat the deny-list", expect: "denied:deny-list",
    attack: (w) => { w.grant({ dir: w.f.home }); return w.probe("fs.write", w.f.chrome, WRITE); },
    benign: (w) => { w.grant({ dir: w.f.home }); return w.probe("fs.write", path.join(w.f.home, ".config", "app", "new.json"), WRITE); },
  },
  {
    id: "always-grant-narrowed-to-dir", group: "roots", what: "an 'always' decision for one outside file grants its folder, not the subtree", expect: "pending",
    attack: async (w) => {
      assertRan(await w.approvedCall("fs.write", w.f.otherB, { extra: WRITE, scope: "always" }));
      return w.probe("fs.write", w.f.otherC, WRITE); // one level deeper
    },
    benign: async (w) => {
      assertRan(await w.approvedCall("fs.write", w.f.otherB, { extra: WRITE, scope: "always" }));
      return w.probe("fs.write", path.join(w.f.other, "d.txt"), WRITE); // a sibling in the approved folder
    },
  },
  {
    id: "always-outside-needs-T3", group: "roots", what: "an 'always' write grant outside the roots cannot be decided on a T2 surface", expect: "surface-untrusted",
    attack: async (w) => {
      const h = await parkedWrite(w);
      const res = w.decide({ scope: "always", surface: 2 });
      await settle([h]);
      return { done: res.ok, code: res.ok ? "ok" : res.reason };
    },
    benign: async (w) => {
      const h = await parkedWrite(w);
      const res = w.decide({ scope: "always", surface: 3 });
      await settle([h]);
      return { done: res.ok, code: res.ok ? "ok" : res.reason };
    },
  },
];

function assertRan(res: Awaited<ReturnType<World["approvedCall"]>>): void {
  if (res.isError) throw new Error(`setup call did not run: ${codeOf(res)}`);
}

export const LIFECYCLE_ROWS: E2ERow[] = [
  {
    id: "once-exactly-once", group: "lifecycle", what: "a once approval runs the call once; the identical call asks again", expect: "pending",
    attack: async (w) => { assertRan(await w.approvedCall("fs.write", w.f.otherB, { extra: WRITE })); return w.probe("fs.write", w.f.otherB, WRITE); },
    benign: async (w) => fromResult(await w.approvedCall("fs.write", w.f.otherB, { extra: WRITE })),
  },
  {
    id: "once-other-arguments", group: "lifecycle", what: "a once approval does not cover the same path with other content", expect: "pending",
    attack: async (w) => { assertRan(await w.approvedCall("fs.write", w.f.otherB, { extra: { content: "A" } })); return w.probe("fs.write", w.f.otherB, { content: "B" }); },
    benign: async (w) => fromResult(await w.approvedCall("fs.write", w.f.otherB, { extra: { content: "A" } })),
  },
  {
    id: "once-parallel-dispatch", group: "lifecycle", what: "six parallel identical calls on one once grant: exactly one runs", expect: "runs=1",
    attack: async (w) => {
      const args = { path: w.f.otherB, content: "x" };
      await w.prep("fs.write", w.f.otherB);
      grantsOn(w).create({ capability: "fs.write", person: "christian", agent: "bernd", scope: "once", match: { kind: "action" }, actionHash: w.hashOf("fs.write", args, [w.f.otherB]), createdBy: "christian", surface: 3 });
      const hs = Array.from({ length: 6 }, () => w.start("fs.write", args));
      await tick(); await tick(); await tick();
      await settle(hs);
      return { done: w.runs.length > 1, code: `runs=${w.runs.length}` };
    },
    benign: async (w) => {
      const args = { path: w.f.otherB, content: "x" };
      await w.prep("fs.write", w.f.otherB);
      grantsOn(w).create({ capability: "fs.write", person: "christian", agent: "bernd", scope: "once", match: { kind: "action" }, actionHash: w.hashOf("fs.write", args, [w.f.otherB]), createdBy: "christian", surface: 3 });
      const res = await w.start("fs.write", args).promise;
      return { done: !res.isError, code: codeOf(res) };
    },
  },
  {
    id: "once-two-connections", group: "lifecycle", what: "two connections to the same file race to consume one once grant: one wins", expect: "wins=1",
    attack: async (w) => {
      const db2 = w.raw();
      const other = new GrantStore({ db: db2, chain: new ApprovalChain(db2, KEY, w.r.clock), clock: w.r.clock });
      const g = grantsOn(w).create({ capability: "fs.write", person: "christian", agent: "bernd", scope: "once", match: { kind: "action" }, actionHash: "h".repeat(64), createdBy: "christian", surface: 3 });
      const b = { person: "christian", agent: "bernd", actionHash: "h".repeat(64) };
      const wins = [other.consumeOnce(g.id, b), grantsOn(w).consumeOnce(g.id, b), other.consumeOnce(g.id, b), grantsOn(w).consumeOnce(g.id, b)].filter(Boolean).length;
      return { done: wins > 1, code: `wins=${wins}` };
    },
    benign: async (w) => {
      const g = grantsOn(w).create({ capability: "fs.write", person: "christian", agent: "bernd", scope: "once", match: { kind: "action" }, actionHash: "h".repeat(64), createdBy: "christian", surface: 3 });
      const ok = grantsOn(w).consumeOnce(g.id, { person: "christian", agent: "bernd", actionHash: "h".repeat(64) });
      return { done: ok, code: ok ? "wins=1" : "wins=0" };
    },
  },
  {
    id: "once-unused-10-minutes", group: "lifecycle", what: "an approved-while-parked once grant is dead after 10 minutes unused", expect: "pending",
    attack: async (w) => { await parkThenApprove(w); w.r.clock.advance(10 * MIN + 1); return w.probe("fs.write", w.f.otherB, WRITE); },
    benign: async (w) => { await parkThenApprove(w); w.r.clock.advance(9 * MIN); return w.probe("fs.write", w.f.otherB, WRITE); },
  },
  {
    id: "task-grant-ends-with-task", group: "lifecycle", what: "a task grant is gone once the task ends", expect: "pending",
    attack: async (w) => {
      assertRan(await w.approvedCall("fs.write", w.f.otherB, { extra: WRITE, scope: "task" }));
      if (grantsOn(w).endTask("t1") < 1) throw new Error("endTask ended nothing");
      return w.probe("fs.write", path.join(w.f.other, "d.txt"), WRITE);
    },
    benign: async (w) => {
      assertRan(await w.approvedCall("fs.write", w.f.otherB, { extra: WRITE, scope: "task" }));
      return w.probe("fs.write", path.join(w.f.other, "d.txt"), WRITE);
    },
  },
  {
    id: "session-grant-ends-with-session", group: "lifecycle", what: "a session grant is gone once the session ends", expect: "pending",
    attack: async (w) => {
      assertRan(await w.approvedCall("fs.write", w.f.otherB, { extra: WRITE, scope: "session" }));
      if (grantsOn(w).endSession("s1") < 1) throw new Error("endSession ended nothing");
      return w.probe("fs.write", path.join(w.f.other, "d.txt"), WRITE);
    },
    benign: async (w) => {
      assertRan(await w.approvedCall("fs.write", w.f.otherB, { extra: WRITE, scope: "session" }));
      return w.probe("fs.write", path.join(w.f.other, "d.txt"), WRITE);
    },
  },
  {
    id: "task-grant-24h", group: "lifecycle", what: "a task grant that outlives its 24 h is dead", expect: "pending",
    attack: async (w) => { w.grant({ dir: w.f.other, scope: "task" }); w.r.clock.advance(24 * HOUR); return w.probe("fs.write", w.f.otherB, WRITE); },
    benign: async (w) => { w.grant({ dir: w.f.other, scope: "task" }); w.r.clock.advance(23 * HOUR); return w.probe("fs.write", w.f.otherB, WRITE); },
  },
  {
    id: "always-grant-90-days-unused", group: "lifecycle", what: "an always grant unused for 90 days is dead; use resets the clock", expect: "pending",
    attack: async (w) => { w.grant({ dir: w.f.other }); w.r.clock.advance(90 * DAY + MIN); return w.probe("fs.write", w.f.otherB, WRITE); },
    benign: async (w) => {
      w.grant({ dir: w.f.other });
      w.r.clock.advance(80 * DAY);
      const first = await w.probe("fs.write", w.f.otherB, WRITE);
      if (!first.done) return first;
      w.r.clock.advance(80 * DAY); // 160 days after creation, 80 after the last use
      return w.probe("fs.write", w.f.otherB, WRITE);
    },
  },
  {
    id: "revoke-bites-next-call", group: "lifecycle", what: "a revoked always grant is refused on the very next call", expect: "pending",
    attack: async (w) => {
      const g = w.grant({ dir: w.f.other });
      const first = await w.probe("fs.write", w.f.otherB, WRITE);
      if (!first.done) throw new Error(`setup call did not run: ${first.code}`);
      if (!grantsOn(w).revoke(g.id, "christian")) throw new Error("revoke returned false");
      return w.probe("fs.write", w.f.otherB, WRITE);
    },
    benign: async (w) => { w.grant({ dir: w.f.other }); return w.probe("fs.write", w.f.otherB, WRITE); },
  },
  {
    id: "chain-break-suspends-later-grants", group: "lifecycle", what: "a grant at or after the first broken chain position is suspended", expect: "store-unavailable",
    world: { servicePolicy: false },
    attack: async (w) => {
      const earlier = w.grant({ dir: path.join(w.f.home, ".config", "app") });
      const later = w.grant({ dir: w.f.other });
      tamper(w, 2); // the entry of `later`
      const states = Object.fromEntries(grantsOn(w).inspect().map((v) => [v.grant.id, v.state]));
      if (states[earlier.id] !== "active" || states[later.id] !== "suspended") throw new Error(`unexpected grant states ${JSON.stringify(states)}`);
      return w.probe("fs.write", w.f.otherB, WRITE);
    },
    benign: async (w) => { w.grant({ dir: path.join(w.f.home, ".config", "app") }); w.grant({ dir: w.f.other }); return w.probe("fs.write", w.f.otherB, WRITE); },
  },
  {
    id: "chain-break-refuses-everything", group: "lifecycle", what: "after a chain break even an inside-root call is refused (fail closed)", expect: "denied:context-unavailable",
    attack: async (w) => { w.grant({ dir: w.f.other }); tamper(w, 1); return w.probe("fs.read", w.f.wsA); },
    benign: async (w) => { w.grant({ dir: w.f.other }); return w.probe("fs.read", w.f.wsA); },
  },
];

/** The foreground wait ends (10 min: parked), then the person approves the open request once; no call is waiting any more. */
async function parkThenApprove(w: World): Promise<void> {
  const h = await parkedWrite(w);
  w.r.timers.advance(10 * MIN);
  const parked = await h.promise;
  if (codeOf(parked) !== "parked") throw new Error(`expected parked, got ${codeOf(parked)}`);
  const res = w.decide();
  if (!res.ok) throw new Error(`late decision refused: ${res.reason}`);
}
