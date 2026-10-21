// Task lifecycle (A2A 0.3): submitted → working → input-required/auth-required → completed|failed|canceled|rejected.
// In-memory store with a live cap, a stored cap (shared fairly between peers), a TTL, and a per-task cap on the reply
// and on the event log (a persistent store is a follow-up).
import { randomUUID } from "node:crypto";
import { artifactUpdate, statusUpdate } from "./events.ts";
import { assignPushId, PushDispatcher, PushError, toTaskPush } from "./push.ts";
import type { A2aTurnPort } from "./turn-port.ts";
import {
  CANCELABLE_STATES, RESUMABLE_STATES, TERMINAL_STATES,
  type A2aMessage, type A2aPart, type A2aPushConfig, type A2aStreamEvent, type A2aTask, type A2aTaskPushConfig, type TaskState,
} from "./types.ts";

export interface Scheduler { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
export const realScheduler: Scheduler = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** Appended to a reply that hit `maxReplyBytes`. */
export const REPLY_TRUNCATED_MARKER = "[reply truncated: size limit]";
/** Event slots kept free for the closing sequence (reply tail, last artifact chunk, final status). */
const FINAL_EVENT_RESERVE = 3;
/** Event slots kept free for status transitions (working, input-required, ...) so reply chunks cannot crowd them out. */
const STATUS_EVENT_RESERVE = 8;

/** The longest prefix of `text` that is at most `maxBytes` UTF-8 bytes and does not end inside a character. */
function clipUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const head = text.length > maxBytes ? text.slice(0, maxBytes) : text; // every UTF-16 unit is at least one byte
  const buf = Buffer.from(head, "utf8");
  if (buf.length <= maxBytes) return head;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // back off a continuation byte to the start of its character
  return buf.subarray(0, end).toString("utf8");
}

export class TaskError extends Error {
  readonly code: "not-found" | "not-cancelable" | "too-many" | "no-provider" | "unsupported" | "invalid";
  constructor(code: TaskError["code"], message: string) { super(message); this.name = "TaskError"; this.code = code; }
}

interface Logged { seq: number; payload: A2aStreamEvent; terminal: boolean }

interface Rec {
  id: string; contextId: string; sessionId: string; peerId: string; agentId: string;
  state: TaskState; updatedAt: number;
  history: A2aMessage[]; parts: A2aPart[]; reply?: string; reason?: "timeout" | "failed" | "canceled" | "rejected";
  controller: AbortController; done: Promise<void>;
  events: Logged[]; waiters: Set<() => void>;
  push: Map<string, A2aPushConfig>;
  artifactId: string;
}

export interface TaskStoreOptions {
  turns: A2aTurnPort;
  clock: () => number; scheduler?: Scheduler;
  maxLivePerPeer: number; maxStored: number; retentionMs: number; replyTimeoutMs: number; maxHistory: number;
  /** Stored tasks a peer may hold when the store is full; a peer above it is the first to lose finished tasks. Default: `maxStored`. */
  maxStoredPerPeer?: number;
  /** UTF-8 bytes of a reply kept in memory (default 256 KiB). */
  maxReplyBytes?: number;
  /** Events one task's log holds (default 1024). */
  maxEventsPerTask?: number;
  maxStreamConnectionsPerPeer?: number;
  onEvent?: (e: { type: "created" | "canceled" | "finished"; taskId: string; peerId: string; agentId: string; state: TaskState }) => void;
  push?: PushDispatcher;
}

export interface StartArgs {
  peerId: string; agentId: string; text: string; parts: A2aPart[]; messageId: string;
  contextId?: string; taskId?: string; push?: A2aPushConfig;
}

const DEFAULT_REPLY_BYTES = 256 * 1024;
const DEFAULT_EVENTS = 1024;

/** Push configs one task may hold; each one is a delivery on every terminal/paused transition. */
const MAX_PUSH_CONFIGS_PER_TASK = 8;

export class TaskStore {
  readonly #o: TaskStoreOptions; readonly #sched: Scheduler;
  readonly #tasks = new Map<string, Rec>();
  readonly #byMessage = new Map<string, string>(); // peer:agent:messageId → taskId
  readonly #streams = new Map<string, number>(); // peerId → live stream count
  constructor(o: TaskStoreOptions) { this.#o = o; this.#sched = o.scheduler ?? realScheduler; }

  get size(): number { return this.#tasks.size; }
  get push(): PushDispatcher | undefined { return this.#o.push; }

  #msgKey(peerId: string, agentId: string, messageId: string): string { return `${peerId}:${agentId}:${messageId}`; }

  #prune(): void {
    const now = this.#o.clock();
    for (const [id, r] of this.#tasks) {
      // A peer that never answers input-required/auth-required would hold a live slot (and any stream) forever.
      if (RESUMABLE_STATES.has(r.state) && now - r.updatedAt >= this.#o.retentionMs) { r.reason = "canceled"; this.#finish(r, "canceled"); }
      if (TERMINAL_STATES.has(r.state) && now - r.updatedAt >= this.#o.retentionMs) {
        this.#drop(r);
      }
    }
  }

  #drop(r: Rec): void {
    this.#tasks.delete(r.id);
    for (const [k, v] of this.#byMessage) if (v === r.id) this.#byMessage.delete(k);
  }

  /**
   * Room for one more stored task. While the store has free slots anyone may take them (a peer can borrow beyond its fair
   * share). When it is full, a peer at or above its share is refused; a peer below it reclaims a slot from the peer furthest
   * above its own share by dropping that peer's oldest finished task. Running and paused tasks are never dropped, and nobody
   * is pushed below their share, so one peer cannot lock the others out.
   */
  #admitStored(peerId: string): void {
    if (this.#tasks.size < this.#o.maxStored) return;
    const share = Math.max(1, this.#o.maxStoredPerPeer ?? this.#o.maxStored);
    const count = new Map<string, number>(); const oldest = new Map<string, Rec>();
    for (const r of this.#tasks.values()) {
      count.set(r.peerId, (count.get(r.peerId) ?? 0) + 1);
      if (TERMINAL_STATES.has(r.state)) { const o = oldest.get(r.peerId); if (!o || r.updatedAt < o.updatedAt) oldest.set(r.peerId, r); }
    }
    if ((count.get(peerId) ?? 0) >= share) throw new TaskError("too-many", "the task store is full");
    let victim: Rec | undefined; let worst = 0;
    for (const [p, c] of count) {
      const over = c - share; const cand = oldest.get(p);
      if (p !== peerId && cand && over > worst) { worst = over; victim = cand; }
    }
    if (!victim) throw new TaskError("too-many", "the task store is full");
    this.#drop(victim);
  }

  #owned(id: string, peerId: string, agentId: string): Rec {
    this.#prune();
    const r = this.#tasks.get(id);
    if (!r || r.peerId !== peerId || r.agentId !== agentId) throw new TaskError("not-found", "task not found");
    return r;
  }

  start(a: StartArgs): A2aTask {
    this.#prune();
    const seen = this.#byMessage.get(this.#msgKey(a.peerId, a.agentId, a.messageId));
    if (seen) {
      const existing = this.#tasks.get(seen);
      if (existing && existing.peerId === a.peerId && existing.agentId === a.agentId) return this.#view(existing, this.#o.maxHistory);
    }
    if (a.taskId) return this.#resume(a);
    if (!this.#o.turns.available()) throw new TaskError("no-provider", "the agent is not available");

    let live = 0; for (const r of this.#tasks.values()) if (r.peerId === a.peerId && !TERMINAL_STATES.has(r.state)) live++;
    if (live >= this.#o.maxLivePerPeer) throw new TaskError("too-many", "too many running tasks for this peer");
    this.#admitStored(a.peerId);

    const id = randomUUID();
    const contextId = a.contextId ?? randomUUID();
    const { sessionId } = this.#o.turns.ensureSession({ peerId: a.peerId, agentId: a.agentId, contextId });
    const rec: Rec = {
      id, contextId, sessionId, peerId: a.peerId, agentId: a.agentId, state: "submitted", updatedAt: this.#o.clock(),
      history: [{ kind: "message", role: "user", messageId: a.messageId, parts: a.parts, contextId, taskId: id }],
      parts: a.parts, controller: new AbortController(), done: Promise.resolve(),
      events: [], waiters: new Set(), push: new Map(), artifactId: `${id}-reply`,
    };
    if (a.push) { const cfg = assignPushId(a.push); rec.push.set(cfg.id!, cfg); }
    this.#tasks.set(id, rec);
    this.#byMessage.set(this.#msgKey(a.peerId, a.agentId, a.messageId), id);
    this.#o.onEvent?.({ type: "created", taskId: id, peerId: a.peerId, agentId: a.agentId, state: "submitted" });
    this.#emit(rec, this.#view(rec, this.#o.maxHistory), false);
    this.#set(rec, "working");
    this.#emit(rec, statusUpdate(this.#view(rec, 0), "working", false, new Date(rec.updatedAt).toISOString()), false);
    rec.done = this.#run(rec, a.text);
    return this.#view(rec, this.#o.maxHistory);
  }

  #resume(a: StartArgs): A2aTask {
    const rec = this.#owned(a.taskId!, a.peerId, a.agentId);
    if (TERMINAL_STATES.has(rec.state)) throw new TaskError("unsupported", `task is already ${rec.state}`);
    if (!RESUMABLE_STATES.has(rec.state)) throw new TaskError("unsupported", "task follow-ups are only accepted in input-required or auth-required");
    rec.history.push({ kind: "message", role: "user", messageId: a.messageId, parts: a.parts, contextId: rec.contextId, taskId: rec.id });
    this.#byMessage.set(this.#msgKey(a.peerId, a.agentId, a.messageId), rec.id);
    rec.controller = new AbortController();
    rec.done = this.#run(rec, a.text);
    return this.#view(rec, this.#o.maxHistory);
  }

  async #run(rec: Rec, text: string): Promise<void> {
    if (rec.state !== "working") {
      this.#set(rec, "working");
      this.#emit(rec, statusUpdate(this.#view(rec, 0), "working", false, new Date(rec.updatedAt).toISOString()), false);
    }
    const timer = this.#sched.set(() => { rec.reason = "timeout"; rec.controller.abort(new Error("timeout")); }, this.#o.replyTimeoutMs);
    try {
      let reply = "";
      let replyBytes = 0;
      let tail = ""; // reply text that found no room in the event log; flushed as one event
      let sent = false; // an artifact chunk has gone out (decides `append`)
      const maxReply = this.#o.maxReplyBytes ?? DEFAULT_REPLY_BYTES;
      const flush = (last: boolean): void => {
        if (tail === "" && !last) return;
        this.#emit(rec, artifactUpdate(this.#view(rec, 0), rec.artifactId, tail, sent, last), false, last);
        tail = ""; sent = true;
      };
      const push = (text: string): void => {
        if (text === "") return;
        reply += text; replyBytes += Buffer.byteLength(text);
        rec.reply = reply;
        if (tail === "" && this.#deltaRoom(rec)) {
          this.#emit(rec, artifactUpdate(this.#view(rec, 0), rec.artifactId, text, sent, false), false);
          sent = true;
        } else tail += text;
      };
      const signal = rec.controller.signal;
      const aborted = new Promise<never>((_, rej) => { signal.addEventListener("abort", () => rej(signal.reason), { once: true }); });
      aborted.catch(() => {});
      const it = this.#o.turns.run({
        peerId: rec.peerId, agentId: rec.agentId, contextId: rec.contextId, sessionId: rec.sessionId, text, signal,
      })[Symbol.asyncIterator]();
      try {
        for (;;) {
          signal.throwIfAborted();
          const n = await Promise.race([it.next(), aborted]);
          if (n.done) break;
          const chunk = n.value;
          if (chunk.type === "delta") {
            const room = maxReply - replyBytes;
            if (Buffer.byteLength(chunk.text) > room) {
              // Cut, mark, and stop: the rest of the turn would only be thrown away, so end it instead of draining it.
              push(clipUtf8(chunk.text, room)); push(REPLY_TRUNCATED_MARKER);
              this.#o.turns.cancel(rec.sessionId);
              break;
            }
            push(chunk.text);
          } else if (chunk.type === "pause") {
            flush(false);
            rec.history.push({
              kind: "message", role: "agent", messageId: randomUUID(),
              parts: [{ kind: "text", text: chunk.message }], contextId: rec.contextId, taskId: rec.id,
            });
            this.#set(rec, chunk.state);
            this.#emit(rec, statusUpdate(this.#view(rec, 0), chunk.state, false, new Date(rec.updatedAt).toISOString()), false);
            this.#push(rec);
            return;
          } else if (chunk.type === "reject") {
            rec.reason = "rejected";
            rec.history.push({
              kind: "message", role: "agent", messageId: randomUUID(),
              parts: [{ kind: "text", text: chunk.message }], contextId: rec.contextId, taskId: rec.id,
            });
            this.#finish(rec, "rejected");
            return;
          }
        }
      } finally { void Promise.resolve(it.return?.()).catch(() => {}); }
      rec.controller.signal.throwIfAborted();
      if (rec.state !== "working") return;
      rec.reply = reply;
      if (sent || tail !== "") flush(true);
      rec.history.push({ kind: "message", role: "agent", messageId: randomUUID(), parts: [{ kind: "text", text: reply }], contextId: rec.contextId, taskId: rec.id });
      this.#finish(rec, "completed");
    } catch (e) {
      if (TERMINAL_STATES.has(rec.state) && rec.state !== "working") return;
      if (rec.state !== "working" && rec.state !== "submitted") return;
      const noProvider = (e as { code?: string })?.code === "no-provider" || (e as { reason?: string })?.reason === "no-provider";
      if (rec.reason == null && !noProvider) {
        rec.reason = rec.controller.signal.aborted ? "canceled" : "failed";
      }
      if (noProvider) {
        this.#tasks.delete(rec.id);
        for (const [k, v] of this.#byMessage) if (v === rec.id) this.#byMessage.delete(k);
        throw e instanceof TaskError ? e : new TaskError("no-provider", "the agent is not available");
      }
      this.#finish(rec, rec.reason === "canceled" ? "canceled" : "failed");
    } finally { this.#sched.clear(timer); }
  }

  #set(rec: Rec, s: TaskState): void { rec.state = s; rec.updatedAt = this.#o.clock(); }

  #finish(rec: Rec, s: TaskState): void {
    this.#set(rec, s);
    this.#o.onEvent?.({ type: "finished", taskId: rec.id, peerId: rec.peerId, agentId: rec.agentId, state: s });
    const view = this.#view(rec, this.#o.maxHistory);
    this.#emit(rec, statusUpdate(view, s, true, new Date(rec.updatedAt).toISOString()), true);
    this.#push(rec);
  }

  #push(rec: Rec): void {
    if (!this.#o.push || rec.push.size === 0) return;
    const view = this.#view(rec, 0);
    for (const cfg of rec.push.values()) this.#o.push.deliver(cfg, view);
  }

  /** Whether the log has a slot for one more reply chunk (status transitions and the closing events keep their own). */
  #deltaRoom(rec: Rec): boolean {
    return rec.events.length < (this.#o.maxEventsPerTask ?? DEFAULT_EVENTS) - FINAL_EVENT_RESERVE - STATUS_EVENT_RESERVE;
  }

  /** `closing` events (terminal status, the last artifact chunk and the tail before it) may use the reserve; others are dropped when only the reserve is left. */
  #emit(rec: Rec, payload: A2aStreamEvent, terminal: boolean, closing = terminal): void {
    if (!closing && rec.events.length >= (this.#o.maxEventsPerTask ?? DEFAULT_EVENTS) - FINAL_EVENT_RESERVE) return;
    rec.events.push({ seq: rec.events.length, payload, terminal });
    for (const w of rec.waiters) w();
  }

  get(id: string, peerId: string, agentId: string, historyLength?: number): A2aTask {
    return this.#view(this.#owned(id, peerId, agentId), Math.min(historyLength ?? this.#o.maxHistory, this.#o.maxHistory));
  }

  cancel(id: string, peerId: string, agentId: string): A2aTask {
    const r = this.#owned(id, peerId, agentId);
    if (!CANCELABLE_STATES.has(r.state)) throw new TaskError("not-cancelable", `task is already ${r.state}`);
    r.reason = "canceled";
    r.controller.abort(new Error("canceled"));
    this.#o.turns.cancel(r.sessionId);
    this.#finish(r, "canceled");
    this.#o.onEvent?.({ type: "canceled", taskId: r.id, peerId: r.peerId, agentId: r.agentId, state: "canceled" });
    return this.#view(r, this.#o.maxHistory);
  }

  async settled(id: string): Promise<void> { await this.#tasks.get(id)?.done; }

  async *subscribe(id: string, peerId: string, agentId: string, fromSeq = 0, signal?: AbortSignal): AsyncIterable<A2aStreamEvent> {
    const rec = this.#owned(id, peerId, agentId);
    if (signal?.aborted) return;
    const cap = this.#o.maxStreamConnectionsPerPeer ?? 8;
    const n = this.#streams.get(peerId) ?? 0;
    if (n >= cap) throw new TaskError("too-many", "too many open streams for this peer");
    this.#streams.set(peerId, n + 1);
    let seq = fromSeq;
    try {
      for (;;) {
        while (seq < rec.events.length) {
          const e = rec.events[seq++]!;
          yield e.payload;
          if (e.terminal) return;
        }
        if (TERMINAL_STATES.has(rec.state)) {
          yield statusUpdate(this.#view(rec, 0), rec.state, true, new Date(rec.updatedAt).toISOString());
          return;
        }
        await new Promise<void>((resolve) => {
          const w = (): void => { rec.waiters.delete(w); signal?.removeEventListener("abort", w); resolve(); };
          rec.waiters.add(w);
          signal?.addEventListener("abort", w, { once: true });
        });
        if (signal?.aborted) return;
      }
    } finally {
      const left = (this.#streams.get(peerId) ?? 1) - 1;
      if (left <= 0) this.#streams.delete(peerId); else this.#streams.set(peerId, left);
    }
  }

  /** Resume a stream at the current snapshot (no replay of prior artifact chunks). */
  async *resubscribe(id: string, peerId: string, agentId: string, signal?: AbortSignal): AsyncIterable<A2aStreamEvent> {
    const rec = this.#owned(id, peerId, agentId);
    const from = rec.events.length;
    const snap = statusUpdate(this.#view(rec, 0), rec.state, TERMINAL_STATES.has(rec.state), new Date(rec.updatedAt).toISOString());
    yield snap;
    if (TERMINAL_STATES.has(rec.state)) return;
    yield* this.subscribe(id, peerId, agentId, from, signal);
  }

  async admitPush(url: string): Promise<void> {
    if (!this.#o.push) throw new PushError("not-supported", "push notifications are not configured");
    await this.#o.push.admit(url);
  }

  setPush(id: string, peerId: string, agentId: string, cfg: A2aPushConfig): A2aTaskPushConfig {
    if (!this.#o.push) throw new PushError("not-supported", "push notifications are not configured");
    const rec = this.#owned(id, peerId, agentId);
    const stored = assignPushId(cfg);
    if (!rec.push.has(stored.id!) && rec.push.size >= MAX_PUSH_CONFIGS_PER_TASK) throw new TaskError("too-many", "too many push notification configs for this task");
    rec.push.set(stored.id!, stored);
    return toTaskPush(rec.id, stored);
  }
  getPush(id: string, peerId: string, agentId: string, configId?: string): A2aTaskPushConfig {
    if (!this.#o.push) throw new PushError("not-supported", "push notifications are not configured");
    const rec = this.#owned(id, peerId, agentId);
    if (configId) {
      const cfg = rec.push.get(configId);
      if (!cfg) throw new TaskError("not-found", "push notification config not found");
      return toTaskPush(rec.id, cfg);
    }
    const first = rec.push.values().next();
    if (first.done) throw new TaskError("not-found", "push notification config not found");
    return toTaskPush(rec.id, first.value);
  }
  listPush(id: string, peerId: string, agentId: string): A2aTaskPushConfig[] {
    if (!this.#o.push) throw new PushError("not-supported", "push notifications are not configured");
    const rec = this.#owned(id, peerId, agentId);
    return [...rec.push.values()].map((c) => toTaskPush(rec.id, c));
  }
  deletePush(id: string, peerId: string, agentId: string, configId: string): null {
    if (!this.#o.push) throw new PushError("not-supported", "push notifications are not configured");
    const rec = this.#owned(id, peerId, agentId);
    if (!rec.push.delete(configId)) throw new TaskError("not-found", "push notification config not found");
    return null;
  }

  #view(r: Rec, historyLength: number): A2aTask {
    const status: A2aTask["status"] = { state: r.state, timestamp: new Date(r.updatedAt).toISOString() };
    if (r.state === "failed") {
      status.message = {
        kind: "message", role: "agent", messageId: `${r.id}-status`,
        parts: [{ kind: "text", text: r.reason === "timeout" ? "The agent did not answer in time." : "The agent could not complete the task." }],
        contextId: r.contextId, taskId: r.id,
      };
    }
    if ((r.state === "input-required" || r.state === "auth-required" || r.state === "rejected") && r.history.length > 0) {
      const last = [...r.history].reverse().find((m) => m.role === "agent");
      if (last) status.message = last;
    }
    const t: A2aTask = { kind: "task", id: r.id, contextId: r.contextId, status };
    if (r.reply !== undefined && (r.state === "completed" || r.state === "working")) {
      t.artifacts = [{ artifactId: r.artifactId, name: "reply", parts: [{ kind: "text", text: r.reply }] }];
    }
    if (r.state === "completed" && r.reply !== undefined) {
      t.artifacts = [{ artifactId: r.artifactId, name: "reply", parts: [{ kind: "text", text: r.reply }] }];
    }
    if (historyLength > 0) t.history = structuredClone(r.history.slice(-historyLength));
    return t;
  }
}
