/** Owned checkpoint lifecycle: bounded turn retention, archive cleanup and a read-only card-completion sweep. */
import type { AuditSink } from "../rbac/audit.ts";
import type { SessionStore, StoredCheckpoint } from "./store.ts";
import { SessionError } from "./types.ts";

export interface CheckpointRetentionDeps {
  store: SessionStore;
  audit: AuditSink;
  now(): number;
  retentionTurns?: () => number;
  cardEnded?: (projectId: string, cardId: string) => boolean;
  remove(checkpoint: StoredCheckpoint, signal: AbortSignal): Promise<void>;
  onCleanupError?: () => void;
}

export class CheckpointRetention {
  readonly #d: CheckpointRetentionDeps;
  readonly #stop = new AbortController();
  readonly #jobs = new Set<Promise<unknown>>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #active = new Map<string, AbortController>();
  readonly #warned = new Set<string>();
  readonly #unarchive: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sweeping: Promise<void> | undefined;
  #closed = false;

  constructor(deps: CheckpointRetentionDeps) {
    this.#d = deps;
    this.#unarchive = deps.store.onArchived(id => {
      this.#active.get(id)?.abort(new SessionError("conflict", "checkpoint session was archived", "rewind-checkpoint-unavailable"));
      void this.#queue(id, () => this.#prune(id, this.#stop.signal)).catch(() => this.#warn());
    });
    if (deps.store.hasCheckpoints()) void this.sweep().catch(() => this.#warn());
  }

  #key(checkpoint: StoredCheckpoint): string { return `${checkpoint.sessionId}:${checkpoint.turnId}:${checkpoint.commitId}`; }
  #warn(checkpoint?: StoredCheckpoint): void {
    if (this.#closed) return;
    if (checkpoint) {
      const key = this.#key(checkpoint);
      if (this.#warned.has(key)) return;
      this.#warned.add(key);
    }
    try { this.#d.onCleanupError?.(); } catch {}
  }

  #track<T>(job: Promise<T>): Promise<T> {
    this.#jobs.add(job);
    const done = () => { this.#jobs.delete(job); this.#arm(); };
    void job.then(done, done);
    return job;
  }

  #queue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(Error("checkpoint-lifecycle-closed"));
    const before = this.#queues.get(sessionId) ?? Promise.resolve();
    const job = before.catch(() => {}).then(() => { this.#stop.signal.throwIfAborted(); return work(); });
    this.#queues.set(sessionId, job);
    const done = () => { if (this.#queues.get(sessionId) === job) this.#queues.delete(sessionId); };
    void job.then(done, done);
    return this.#track(job);
  }

  /** Capture, restore and cleanup serialize within a session; an approval in one session cannot block another. */
  run<T>(sessionId: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.#queue(sessionId, async () => {
      const local = new AbortController();
      const combined = AbortSignal.any([signal, local.signal, this.#stop.signal]);
      this.#active.set(sessionId, local);
      try { await this.#prune(sessionId, combined); combined.throwIfAborted(); return await work(combined); }
      finally { if (this.#active.get(sessionId) === local) this.#active.delete(sessionId); }
    });
  }

  #ended(checkpoint: StoredCheckpoint): boolean {
    try { return this.#d.cardEnded?.(checkpoint.projectId, checkpoint.cardId) === true; }
    catch { this.#warn(checkpoint); return false; }
  }

  async #prune(sessionId: string, signal: AbortSignal): Promise<void> {
    const session = this.#d.store.getSession(sessionId);
    const requested = this.#d.retentionTurns?.() ?? 50;
    const turns = Number.isSafeInteger(requested) && requested >= 1 && requested <= 500 ? requested : 50;
    const cutoff = this.#d.store.latestTurnSeq(sessionId) - turns;
    const ended = new Map<string, boolean>();
    for (const checkpoint of this.#d.store.checkpoints(sessionId)) {
      signal.throwIfAborted();
      const key = `${checkpoint.projectId}\0${checkpoint.cardId}`;
      const sessionEnded = !session || session.archivedAt !== null;
      if (!sessionEnded && !ended.has(key)) ended.set(key, this.#ended(checkpoint));
      const reason = sessionEnded ? "session-ended" : ended.get(key) ? "card-ended"
        : checkpoint.turnSeq <= cutoff ? "turn-retention" : null;
      if (!reason) continue;
      try {
        this.#d.audit.append({ at: this.#d.now(), actor: { user: "core", host: "core" }, action: "session.checkpoint.pruning",
          target: sessionId, detail: { turnId: checkpoint.turnId, projectId: checkpoint.projectId, cardId: checkpoint.cardId, reason } });
        await this.#d.remove(checkpoint, signal);
        this.#d.store.forgetCheckpoint(checkpoint);
        this.#warned.delete(this.#key(checkpoint));
      } catch (error) { signal.throwIfAborted(); this.#warn(checkpoint); }
    }
  }

  #arm(): void {
    if (this.#closed) return;
    if (!this.#d.store.hasCheckpoints()) { clearTimeout(this.#timer); this.#timer = undefined; return; }
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.sweep().catch(() => this.#warn());
    }, 10_000);
    this.#timer.unref();
  }

  sweep(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#sweeping) return this.#sweeping;
    const job = this.#track((async () => {
      const rows = this.#d.store.checkpoints(), ended = new Map<string, boolean>();
      const endedSessions = new Set<string>();
      for (const checkpoint of rows) {
        const key = `${checkpoint.projectId}\0${checkpoint.cardId}`;
        if (!ended.has(key)) ended.set(key, this.#ended(checkpoint));
        if (ended.get(key)) {
          endedSessions.add(checkpoint.sessionId);
          this.#active.get(checkpoint.sessionId)?.abort(new SessionError("conflict", "checkpoint card has ended", "rewind-checkpoint-unavailable"));
        }
      }
      for (const id of new Set(rows.map(row => row.sessionId))) {
        if (this.#closed) break;
        // A pending approval must not hold the maintenance loop; the next tick still has to detect card completion.
        if (this.#active.has(id) && !endedSessions.has(id)) continue;
        await this.#queue(id, () => this.#prune(id, this.#stop.signal));
      }
    })());
    this.#sweeping = job;
    const done = () => { if (this.#sweeping === job) this.#sweeping = undefined; };
    void job.then(done, done);
    return job;
  }

  async idle(): Promise<void> { while (this.#jobs.size) await Promise.allSettled([...this.#jobs]); }

  async close(): Promise<void> {
    this.#closed = true;
    this.#unarchive(); clearTimeout(this.#timer); this.#stop.abort(Error("checkpoint-lifecycle-closed"));
    await this.idle();
    this.#warned.clear();
  }
}
