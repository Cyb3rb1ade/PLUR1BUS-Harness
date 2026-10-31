// Content-free, persistent reservations for outbound A2A traffic. Kept in the budget
// database so a reconnect/restart cannot reset a turn's peer limits.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openBudgetDb, transaction } from "./store.ts";

export interface PeerBudgetIdentity { person: string; agent: string; session: string; turn: string; peer: string }
export interface PeerBudgetLimits { peerCalls: number; turnCalls: number; peerTokens: number; turnTokens: number }
export type PeerBudgetDecision = { kind: "allow"; id: string } | { kind: "refuse" };
const invalid = (): never => { throw new Error("invalid peer budget input"); };
const count = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

export class PeerCallBudget {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  constructor(o: { path: string; now: () => number }) {
    this.#db = openBudgetDb(o);
    this.#now = o.now;
    // An additive extension table, like budget_call, rather than a
    // change to usage_event or its producer-compatible schema version.
    this.#db.exec(`CREATE TABLE IF NOT EXISTS a2a_peer_call (
      id TEXT PRIMARY KEY, person TEXT NOT NULL, agent TEXT NOT NULL,
      session TEXT NOT NULL, turn TEXT NOT NULL, peer TEXT NOT NULL,
      tokens INTEGER NOT NULL CHECK(tokens >= 0), capacity INTEGER NOT NULL CHECK(capacity >= tokens),
      state TEXT NOT NULL CHECK(state IN ('reserved','spent','cancelled')), ts INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS a2a_peer_call_turn ON a2a_peer_call(person,session,turn);`);
  }
  reserve(who: PeerBudgetIdentity, tokens: number, limits: PeerBudgetLimits): PeerBudgetDecision {
    if (Object.values(who).length !== 5 || Object.values(who).some(v => typeof v !== "string" || !v || v.length > 512) || !count(tokens) || [limits.peerCalls, limits.turnCalls, limits.peerTokens, limits.turnTokens].some(v => !count(v))) return invalid();
    return transaction(this.#db, () => {
      const rows = this.#db.prepare(`SELECT peer, COUNT(*) AS calls, SUM(tokens) AS tokens FROM a2a_peer_call
        WHERE person=? AND session=? AND turn=? AND state<>'cancelled' GROUP BY peer`)
        .all(who.person, who.session, who.turn) as Array<{ peer: string; calls: number; tokens: number }>;
      const peer = rows.find(r => r.peer === who.peer);
      if ((peer?.calls ?? 0) >= limits.peerCalls || rows.reduce((n, r) => n + r.calls, 0) >= limits.turnCalls ||
        (peer?.tokens ?? 0) + tokens > limits.peerTokens || rows.reduce((n, r) => n + r.tokens, 0) + tokens > limits.turnTokens) return { kind: "refuse" };
      const id = randomUUID();
      this.#db.prepare("INSERT INTO a2a_peer_call VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(id, who.person, who.agent, who.session, who.turn, who.peer, tokens, tokens, "reserved", this.#now());
      return { kind: "allow", id };
    });
  }
  finish(id: string, tokens: number): void {
    if (!count(tokens)) return invalid();
    transaction(this.#db, () => {
      const row = this.#db.prepare("SELECT capacity,tokens,state FROM a2a_peer_call WHERE id=?").get(id) as { capacity: number; tokens: number; state: string } | undefined;
      if (!row || tokens > row.capacity || row.state === "cancelled" || (row.state === "spent" && tokens !== row.tokens)) return invalid();
      this.#db.prepare("UPDATE a2a_peer_call SET tokens=?,state='spent' WHERE id=? AND state='reserved'").run(tokens, id);
    });
  }
  /** Only for a request proved not to have reached the wire. */
  cancel(id: string): void {
    transaction(this.#db, () => { this.#db.prepare("UPDATE a2a_peer_call SET state='cancelled' WHERE id=? AND state='reserved'").run(id); });
  }
  close(): void { this.#db.close(); }
}
