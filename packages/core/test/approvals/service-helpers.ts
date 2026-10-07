import { createApprovalService, type ApprovalService, type ApprovalServiceOptions } from "../../src/approvals/service.ts";
import { staticKeySource } from "../../src/approvals/keys.ts";
import { openPermissionStores, type PermissionStores } from "../../src/grants/open.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { decide, type Call, type CallFlags, type Context, type Grant } from "../../src/policy/index.ts";
import { memoryAuditSink, type MemoryAuditSink } from "../../src/rbac/audit.ts";
import type { ApprovalAsk } from "../../src/tools/approval.ts";
import { FakeClock, KEY, dbFile } from "./helpers.ts";

export { DAY, HOUR, MIN, NOW, FakeClock, KEY, dbFile, raw } from "./helpers.ts";

/** Fake timers on the fake clock: `advance` moves the clock and fires what falls due, in order. */
export class FakeTimers {
  readonly clock: FakeClock;
  #q: { at: number; fn: () => void; id: number }[] = [];
  #n = 0;
  constructor(clock: FakeClock) { this.clock = clock; }
  set = (fn: () => void, ms: number): (() => void) => {
    const id = ++this.#n;
    this.#q.push({ at: this.clock.t + ms, fn, id });
    return () => { this.#q = this.#q.filter((t) => t.id !== id); };
  };
  get pending(): number { return this.#q.length; }
  advance(ms: number): void {
    const end = this.clock.t + ms;
    for (;;) {
      const next = this.#q.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.#q = this.#q.filter((t) => t.id !== next.id);
      this.clock.t = Math.max(this.clock.t, next.at);
      next.fn();
    }
    this.clock.t = end;
  }
}

export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

export interface Rig {
  stores: PermissionStores;
  service: ApprovalService;
  clock: FakeClock;
  timers: FakeTimers;
  audit: MemoryAuditSink;
  events: { name: string; payload: any }[];
  path: string;
}

export async function rig(o: { path?: string; ttlMs?: number; foregroundWaitMs?: number; service?: Partial<ApprovalServiceOptions>; clock?: FakeClock } = {}): Promise<Rig> {
  const clock = o.clock ?? new FakeClock();
  const timers = new FakeTimers(clock);
  const mem = memoryAuditSink();
  const audit = createPolicyAudit({ sink: mem, clock, host: "h" });
  const path = o.path ?? dbFile();
  const stores = await openPermissionStores({ path, keys: staticKeySource(KEY), clock, audit, ...(o.ttlMs !== undefined ? { requestTtlMs: o.ttlMs } : {}) });
  const events: Rig["events"] = [];
  const service = createApprovalService({
    stores, clock, timers, audit, events: { emit: (name, payload) => { events.push({ name, payload }); } },
    ...(o.foregroundWaitMs !== undefined ? { foregroundWaitMs: o.foregroundWaitMs } : {}), ...o.service,
  });
  return { stores, service, clock, timers, audit: mem, events, path };
}

export const NO_GRANTS = { list: (): readonly Grant[] => [], get: (): Grant | undefined => undefined };

const flagsOf = (f: Partial<CallFlags> = {}): CallFlags => ({ outsideRoots: true, denyListHit: false, ...f });

/** A genuine `ask` decision from the evaluator, turned into the ApprovalAsk the dispatcher would hand to the port. */
export function askFor(o: {
  capability?: string; tool?: string; effect?: Call["effect"]; flags?: Partial<CallFlags>; targets?: string[]; access?: "read" | "write";
  actionHash?: string; principal?: string; agentId?: string; sessionId?: string | null; taskId?: string | null; turnId?: string; callId?: string;
  args?: unknown; ctx?: Partial<Context>; signal?: AbortSignal;
} = {}): ApprovalAsk {
  const capability = o.capability ?? "fs.read";
  const call: Call = {
    capability, tool: o.tool ?? capability, ...(o.effect ? { effect: o.effect } : {}), flags: flagsOf(o.flags),
    targets: o.targets ?? ["/outside/dir/a.txt"], access: o.access ?? "read", actionHash: o.actionHash ?? "h1".padEnd(64, "0"),
  };
  const principal = o.principal ?? "christian";
  const agentId = o.agentId ?? "bernd";
  const ctx: Context = {
    principal: { person: principal }, subject: { kind: "agent", agentId }, surface: 3,
    ...(o.sessionId === null ? {} : { sessionId: o.sessionId ?? "s1" }), ...(o.taskId === null ? {} : { taskId: o.taskId ?? "t1" }), ...o.ctx,
  };
  const d = decide(call, ctx, { grants: NO_GRANTS, clock: { now: () => 0 } });
  if (d.kind !== "ask") throw new Error(`expected an ask decision, got ${d.kind}`);
  return {
    request: d.request, callId: o.callId ?? "call1", tool: call.tool, args: o.args ?? { path: call.targets![0] }, agentId, principal,
    ...(o.sessionId === null ? {} : { sessionId: o.sessionId ?? "s1" }), ...(o.taskId === null ? {} : { taskId: o.taskId ?? "t1" }),
    turnId: o.turnId ?? "turn1", park: d.park, signal: o.signal ?? new AbortController().signal,
    ...(call.targets ? { targets: call.targets } : {}), ...(call.access ? { access: call.access } : {}),
  };
}

/** The pending request the rig's service created last, with its nonce read from the projection (what a channel relay would hold). */
export function lastNonce(r: Rig): { id: string; nonce: string } {
  const e = [...r.events].reverse().find((x) => x.name === "approval.requested");
  if (!e) throw new Error("no approval.requested event");
  return { id: e.payload.approval.id as string, nonce: e.payload.nonce as string };
}
