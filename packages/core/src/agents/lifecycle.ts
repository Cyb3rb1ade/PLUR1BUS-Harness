// Lifecycle is separate from engine open/close: a paused agent retains its store, persona and sessions.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { platformCapabilities } from "../platform.ts";
import { RpcError } from "../rpc/errors.ts";
export interface LifecycleState { paused: boolean; archived: boolean; deleted: boolean }
export class AgentLifecycle {
  readonly db: DatabaseSync;
  constructor(o: { path: string }) {
    if (o.path !== ":memory:") { mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 }); closeSync(openSync(o.path, "a", 0o600)); platformCapabilities.securePath(o.path); }
    this.db = new DatabaseSync(o.path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agent_lifecycle (id TEXT PRIMARY KEY,paused INTEGER NOT NULL,archived INTEGER NOT NULL,deleted INTEGER NOT NULL) STRICT;
      CREATE TEMP TABLE export_offers (id TEXT PRIMARY KEY,agent TEXT NOT NULL,person TEXT NOT NULL,expires INTEGER NOT NULL) STRICT;`);
  }
  close() { this.db.close(); }
  state(id: string): LifecycleState { const r = this.db.prepare("SELECT * FROM agent_lifecycle WHERE id=?").get(id) as any; return { paused: r?.paused === 1, archived: r?.archived === 1, deleted: r?.deleted === 1 }; }
  usable(id: string): boolean { const s = this.state(id); return !s.paused && !s.archived && !s.deleted; }
  set(id: string, patch: Partial<LifecycleState>): LifecycleState {
    const s = { ...this.state(id), ...patch };
    this.db.prepare("INSERT INTO agent_lifecycle VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET paused=excluded.paused,archived=excluded.archived,deleted=excluded.deleted").run(id, +s.paused, +s.archived, +s.deleted);
    return s;
  }
  offer(agent: string, person: string, now: number) { const id = randomUUID(), expiresAt = now + 600_000; this.db.prepare("DELETE FROM export_offers WHERE expires<=?").run(now); this.db.prepare("INSERT INTO export_offers VALUES (?,?,?,?)").run(id, agent, person, expiresAt); return { offerId: id, expiresAt }; }
  requireOffer(id: string, agent: string, person: string, now: number) {
    if (!this.db.prepare("SELECT id FROM export_offers WHERE id=? AND agent=? AND person=? AND expires>?").get(id, agent, person, now))
      throw new RpcError("E_CONFLICT", "offer an export before deletion", { reason: "export-offer-required" });
  }
}
