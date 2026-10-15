import { createHash, randomUUID } from "node:crypto";
import { RpcError } from "./rpc/errors.ts";
export type ActivityState = "idle" | "recalling" | "capturing" | "checkpointing" | "dreaming" | "consolidating" | "maintenance";
export interface Activity { state: ActivityState; since: number; phase?: "light" | "rem" | "deep"; job?: string }
export interface ActivityQuery { agentId?: string; since?: string; until?: string; kinds?: ActivityState[]; cursor?: string; limit?: number }
export interface ActivityItem { id: string; agentId: string; activity: Activity }
const DEFAULT_CAPACITY = 1000;
type Handler = (agentId: string, activity: Activity) => void;

/** Per-agent activity state (spec §6.7). Every transition is emitted once; re-setting the current state is a no-op. */
export class ActivityTracker {
  #now: () => number; #map = new Map<string, Activity>(); #handlers = new Set<Handler>();
  #history: (ActivityItem & { seq: number })[] = []; #seq = 0; #epoch = randomUUID();
  #capacity: () => number;
  constructor(now: () => number = Date.now, capacity: () => number = () => 1000) { this.#now = now; this.#capacity = capacity; }
  /** Bounded transition history; cursors are tied to this process, caller visibility and filters. */
  list(p: ActivityQuery, visible: readonly string[]): { items: ActivityItem[]; nextCursor?: string } {
    // Defence in depth behind the RPC schema: a malformed filter is the caller's error (E_INVALID_PARAMS), never a raw TypeError.
    const bad = (what: string) => new RpcError("E_INVALID_PARAMS", `invalid activity filter: ${what}`);
    if (p.agentId !== undefined && typeof p.agentId !== "string") throw bad("agentId");
    if (p.since !== undefined && typeof p.since !== "string") throw bad("since");
    if (p.until !== undefined && typeof p.until !== "string") throw bad("until");
    if (p.cursor !== undefined && typeof p.cursor !== "string") throw bad("cursor");
    if (p.kinds !== undefined && (!Array.isArray(p.kinds) || p.kinds.some(k => typeof k !== "string"))) throw bad("kinds");
    const limit = p.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RpcError("E_INVALID_PARAMS", "limit must be between 1 and 200");
    const since = p.since === undefined ? -Infinity : Date.parse(p.since);
    const until = p.until === undefined ? Infinity : Date.parse(p.until);
    if (Number.isNaN(since) || Number.isNaN(until) || since > until) throw new RpcError("E_INVALID_PARAMS", "invalid activity time range");
    const allowed = new Set(visible);
    const filter = createHash("sha256").update(JSON.stringify([p.agentId ?? null, p.since ?? null, p.until ?? null, [...(p.kinds ?? [])].sort(), [...allowed].sort()])).digest("hex");
    let before = Infinity;
    if (p.cursor !== undefined) {
      try {
        if (p.cursor.length > 8192) throw new Error();
        const c = JSON.parse(Buffer.from(p.cursor, "base64url").toString("utf8"));
        if (c.epoch !== this.#epoch || c.filter !== filter || !Number.isSafeInteger(c.seq) || !this.#history.some(i => i.seq === c.seq)) throw new Error();
        before = c.seq;
      } catch { throw new RpcError("E_INVALID_PARAMS", "activity cursor is invalid or expired", { reason: "bad-cursor", detail: "cursor" }); }
    }
    const matching = this.#history.filter(i => i.seq < before && allowed.has(i.agentId) && (p.agentId === undefined || p.agentId === i.agentId) && i.activity.since >= since && i.activity.since <= until && (p.kinds === undefined || p.kinds.includes(i.activity.state))).reverse();
    const selected = matching.slice(0, limit);
    const last = selected.at(-1);
    return { items: selected.map(({ seq: _seq, ...i }) => ({ ...i, activity: { ...i.activity } })), ...(last && matching.length > limit ? { nextCursor: Buffer.from(JSON.stringify({ epoch: this.#epoch, filter, seq: last.seq })).toString("base64url") } : {}) };
  }
  /** The history bound: a non-finite or negative capacity never means "unbounded" (NaN would make every splice a no-op). */
  #bound(): number { const c = this.#capacity(); return Number.isFinite(c) ? Math.max(0, Math.floor(c)) : DEFAULT_CAPACITY; }
  get(agentId: string): Activity { return { ...(this.#map.get(agentId) ?? { state: "idle", since: this.#now() }) }; }
  set(agentId: string, next: Omit<Activity, "since">): void {
    const cur = this.#map.get(agentId);
    if (cur && cur.state === next.state && cur.phase === next.phase && cur.job === next.job) return;
    const a: Activity = { state: next.state, ...(next.phase !== undefined ? { phase: next.phase } : {}), ...(next.job !== undefined ? { job: next.job } : {}), since: this.#now() };
    this.#map.set(agentId, a);
    const seq = ++this.#seq;
    this.#history.push({ id: `${this.#epoch}:${seq}`, seq, agentId, activity: { ...a } });
    this.#history.splice(0, Math.max(0, this.#history.length - this.#bound()));
    // Per-agent state is keyed by whatever id a caller used: idle entries beyond the bound are dropped, oldest first
    // (get() answers a fresh idle for them). An agent that is doing something is never dropped.
    if (a.state === "idle" && this.#map.size > this.#bound()) {
      for (const [id, cur] of this.#map) { if (this.#map.size <= this.#bound()) break; if (cur.state === "idle") this.#map.delete(id); }
    }
    for (const h of this.#handlers) {
      try { h(agentId, { ...a }); } catch { /* a listener never breaks the transition */ }
    }
  }
  idle(agentId: string): void { this.set(agentId, { state: "idle" }); }
  onChange(h: Handler): () => void { this.#handlers.add(h); return () => { this.#handlers.delete(h); }; }
}
