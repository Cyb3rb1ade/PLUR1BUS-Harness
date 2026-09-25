export type ActivityState = "idle" | "recalling" | "capturing" | "checkpointing" | "dreaming" | "consolidating" | "maintenance";
export interface Activity { state: ActivityState; since: number; phase?: "light" | "rem" | "deep"; job?: string }
type Handler = (agentId: string, activity: Activity) => void;

/** Per-agent activity state (spec §6.7). Every transition is emitted once; re-setting the current state is a no-op. */
export class ActivityTracker {
  #now: () => number; #map = new Map<string, Activity>(); #handlers = new Set<Handler>();
  constructor(now: () => number = Date.now) { this.#now = now; }
  get(agentId: string): Activity { return this.#map.get(agentId) ?? { state: "idle", since: this.#now() }; }
  set(agentId: string, next: Omit<Activity, "since">): void {
    const cur = this.#map.get(agentId);
    if (cur && cur.state === next.state && cur.phase === next.phase && cur.job === next.job) return;
    const a: Activity = { state: next.state, ...(next.phase !== undefined ? { phase: next.phase } : {}), ...(next.job !== undefined ? { job: next.job } : {}), since: this.#now() };
    this.#map.set(agentId, a);
    for (const h of this.#handlers) {
      try { h(agentId, a); } catch { /* a listener never breaks the transition */ }
    }
  }
  idle(agentId: string): void { this.set(agentId, { state: "idle" }); }
  onChange(h: Handler): () => void { this.#handlers.add(h); return () => { this.#handlers.delete(h); }; }
}
