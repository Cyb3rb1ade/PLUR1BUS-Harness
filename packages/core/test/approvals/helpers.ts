import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempDir } from "../helpers/temp-dir.ts";
import { openApprovalsDb } from "../../src/approvals/db.ts";
import { ApprovalChain } from "../../src/approvals/chain.ts";
import { staticKeySource } from "../../src/approvals/keys.ts";
import { createApprovalStore, type ApprovalBinding, type ApprovalStore } from "../../src/approvals/store.ts";

export const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export class FakeClock {
  t: number;
  constructor(t: number = NOW) { this.t = t; }
  now(): number { return this.t; }
  advance(ms: number): void { this.t += ms; }
}

export const KEY = Buffer.alloc(32, 7);
export const OTHER_KEY = Buffer.alloc(32, 9);

export function dbFile(): string {
  return join(tempDir("p1b-apr-"), "state", "approvals.sqlite");
}

/** A second, raw connection: what an attacker with write access to the file would use. */
export function raw(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

export function openChain(path: string, o: { key?: Uint8Array; clock?: FakeClock } = {}): { db: DatabaseSync; chain: ApprovalChain; clock: FakeClock } {
  const clock = o.clock ?? new FakeClock();
  const db = openApprovalsDb({ path });
  return { db, chain: new ApprovalChain(db, o.key ?? KEY, clock), clock };
}

export async function openStore(path: string, o: { key?: Uint8Array; clock?: FakeClock; ttlMs?: number } = {}): Promise<{ store: ApprovalStore; db: DatabaseSync; clock: FakeClock }> {
  const clock = o.clock ?? new FakeClock();
  const db = openApprovalsDb({ path });
  const store = await createApprovalStore({ db, keys: staticKeySource(o.key ?? KEY), clock, ...(o.ttlMs !== undefined ? { requestTtlMs: o.ttlMs } : {}) });
  return { store, db, clock };
}

export const BINDING: Omit<ApprovalBinding, "requestId"> = {
  actionHash: "h1",
  principal: "christian",
  subject: { kind: "agent", id: "bernd" },
  turnId: "turn1",
  taskId: "t1",
  sessionId: "s1",
};
