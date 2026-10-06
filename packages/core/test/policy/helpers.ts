import type { Call, CallFlags, Clock, Context, Decision, Deps, Grant, GrantMatch, GrantScope, GrantSource } from "../../src/policy/index.ts";
import { decide } from "../../src/policy/index.ts";

export const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export class FakeClock implements Clock {
  t: number;
  constructor(t: number = NOW) { this.t = t; }
  now(): number { return this.t; }
  advance(ms: number): void { this.t += ms; }
}

export class MemoryGrants implements GrantSource {
  grants: Grant[];
  constructor(grants: Grant[] = []) { this.grants = grants; }
  list(q: { person: string; agent: string; capability: string }): readonly Grant[] {
    return this.grants.filter((g) => g.person === q.person && g.agent === q.agent && g.capability === q.capability);
  }
  get(id: string): Grant | undefined { return this.grants.find((g) => g.id === id); }
}

export function flags(f: Partial<CallFlags> = {}): CallFlags {
  return { outsideRoots: false, denyListHit: false, ...f };
}

/** Default call: a read of one file inside the workspace. */
export function call(o: Partial<Omit<Call, "flags">> & { flags?: Partial<CallFlags> } = {}): Call {
  const { flags: f, ...rest } = o;
  return { capability: "fs.read", tool: o.capability ?? "fs.read", flags: flags(f), targets: ["/work/proj/a.txt"], access: "read", actionHash: "h1", ...rest };
}

/** Default context: Christian's agent Bernd on a T3 surface, session s1, task t1. */
export function ctx(o: Partial<Context> = {}): Context {
  return { principal: { person: "christian" }, subject: { kind: "agent", agentId: "bernd" }, surface: 3, sessionId: "s1", taskId: "t1", ...o };
}

let seq = 0;
export function grant(capability: string, scope: GrantScope, match: GrantMatch = { kind: "capability" }, o: Partial<Grant> = {}): Grant {
  const base: Grant = { id: `g${++seq}`, capability, person: "christian", agent: "bernd", scope, match, createdAt: NOW - HOUR, surface: 3 };
  if (scope === "task") base.taskId = "t1";
  if (scope === "session") base.sessionId = "s1";
  if (scope === "once") { base.actionHash = "h1"; base.match = { kind: "action" }; base.createdAt = NOW - MIN; }
  return { ...base, ...o };
}

export function run(c: Call, x: Context, grants: Grant[] = [], clock: Clock = new FakeClock()): Decision {
  const deps: Deps = { grants: new MemoryGrants(grants), clock };
  return decide(c, x, deps);
}
