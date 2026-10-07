// Task lifecycle (ADR-008 table): submitted -> working -> completed | failed | canceled, per peer, bounded.
// RULING: the runner drives the existing `ChatProvider` seam directly with an empty memory block. A2A1 gives an external peer
// no memory access at all (no recall, no capture); binding a task to a replayable harness session is the follow-up
// behind `TaskStoreOptions.provider`.
import { randomUUID } from "node:crypto";
import type { ChatProvider } from "../session/provider.ts";
import { TERMINAL_STATES, type A2aMessage, type A2aTask, type TaskState } from "./types.ts";

export interface Scheduler { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
export const realScheduler: Scheduler = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export class TaskError extends Error {
  readonly code: "not-found" | "not-cancelable" | "too-many" | "no-provider";
  constructor(code: TaskError["code"], message: string) { super(message); this.name = "TaskError"; this.code = code; }
}

interface Rec {
  id: string; contextId: string; peerId: string; agentId: string; state: TaskState; updatedAt: number;
  history: A2aMessage[]; reply?: string; reason?: "timeout" | "failed" | "canceled";
  controller: AbortController; done: Promise<void>;
}

export interface TaskStoreOptions {
  provider: () => ChatProvider | null; clock: () => number; scheduler?: Scheduler;
  maxLivePerPeer: number; maxStored: number; retentionMs: number; replyTimeoutMs: number; maxHistory: number;
  onEvent?: (e: { type: "created" | "canceled" | "finished"; taskId: string; peerId: string; agentId: string; state: TaskState }) => void;
}

export class TaskStore {
  readonly #o: TaskStoreOptions; readonly #sched: Scheduler;
  readonly #tasks = new Map<string, Rec>();
  constructor(o: TaskStoreOptions) { this.#o = o; this.#sched = o.scheduler ?? realScheduler; }

  get size(): number { return this.#tasks.size; }

  #prune(): void {
    const now = this.#o.clock();
    for (const [id, r] of this.#tasks) if (TERMINAL_STATES.has(r.state) && now - r.updatedAt >= this.#o.retentionMs) this.#tasks.delete(id);
  }

  start(a: { peerId: string; agentId: string; text: string; contextId?: string; messageId: string }): A2aTask {
    this.#prune();
    const provider = this.#o.provider();
    if (!provider) throw new TaskError("no-provider", "no chat provider is configured");
    let live = 0; for (const r of this.#tasks.values()) if (r.peerId === a.peerId && !TERMINAL_STATES.has(r.state)) live++;
    if (live >= this.#o.maxLivePerPeer) throw new TaskError("too-many", "too many running tasks for this peer");
    if (this.#tasks.size >= this.#o.maxStored) throw new TaskError("too-many", "the task store is full");
    const id = randomUUID(); const contextId = a.contextId ?? randomUUID();
    const rec: Rec = {
      id, contextId, peerId: a.peerId, agentId: a.agentId, state: "submitted", updatedAt: this.#o.clock(),
      history: [{ kind: "message", role: "user", messageId: a.messageId, parts: [{ kind: "text", text: a.text }], contextId, taskId: id }],
      controller: new AbortController(), done: Promise.resolve(),
    };
    this.#tasks.set(id, rec);
    this.#o.onEvent?.({ type: "created", taskId: id, peerId: a.peerId, agentId: a.agentId, state: "submitted" });
    rec.done = this.#run(rec, provider, a.text);
    return this.#view(rec, this.#o.maxHistory);
  }

  async #run(rec: Rec, provider: ChatProvider, text: string): Promise<void> {
    this.#set(rec, "working");
    const timer = this.#sched.set(() => { rec.reason = "timeout"; rec.controller.abort(new Error("timeout")); }, this.#o.replyTimeoutMs);
    try {
      let reply = "";
      // The stream is raced against the abort signal: a provider that ignores it cannot keep a canceled or timed-out task alive.
      const signal = rec.controller.signal;
      const aborted = new Promise<never>((_, rej) => { signal.addEventListener("abort", () => rej(signal.reason), { once: true }); });
      aborted.catch(() => {});
      const it = provider.stream({
        sessionId: rec.id, agentId: rec.agentId, summaries: [], memory: "",
        messages: [{ role: "user", text }], signal,
      })[Symbol.asyncIterator]();
      try {
        for (;;) {
          signal.throwIfAborted();
          const n = await Promise.race([it.next(), aborted]);
          if (n.done) break;
          // RULING: tool.call/tool.result/usage chunks are not relayed to a peer; only the text of the answer leaves.
          if (n.value.type === "delta") reply += n.value.text;
        }
      } finally { void Promise.resolve(it.return?.()).catch(() => {}); }
      rec.controller.signal.throwIfAborted();
      if (rec.state !== "working") return; // canceled meanwhile: that outcome stands
      rec.reply = reply;
      rec.history.push({ kind: "message", role: "agent", messageId: randomUUID(), parts: [{ kind: "text", text: reply }], contextId: rec.contextId, taskId: rec.id });
      this.#finish(rec, "completed");
    } catch {
      if (rec.state !== "working") return;
      rec.reason ??= "failed";
      this.#finish(rec, "failed");
    } finally { this.#sched.clear(timer); }
  }

  #set(rec: Rec, s: TaskState): void { rec.state = s; rec.updatedAt = this.#o.clock(); }
  #finish(rec: Rec, s: TaskState): void { this.#set(rec, s); this.#o.onEvent?.({ type: "finished", taskId: rec.id, peerId: rec.peerId, agentId: rec.agentId, state: s }); }

  #owned(id: string, peerId: string, agentId: string): Rec {
    this.#prune();
    const r = this.#tasks.get(id);
    // Another peer's (or another agent's) task is indistinguishable from none: no existence oracle.
    if (!r || r.peerId !== peerId || r.agentId !== agentId) throw new TaskError("not-found", "task not found");
    return r;
  }

  get(id: string, peerId: string, agentId: string, historyLength?: number): A2aTask {
    return this.#view(this.#owned(id, peerId, agentId), Math.min(historyLength ?? this.#o.maxHistory, this.#o.maxHistory));
  }

  cancel(id: string, peerId: string, agentId: string): A2aTask {
    const r = this.#owned(id, peerId, agentId);
    // RULING: no silent success: a terminal task answers TaskNotCancelable.
    if (TERMINAL_STATES.has(r.state)) throw new TaskError("not-cancelable", `task is already ${r.state}`);
    r.reason = "canceled"; r.controller.abort(new Error("canceled"));
    this.#finish(r, "canceled");
    this.#o.onEvent?.({ type: "canceled", taskId: r.id, peerId: r.peerId, agentId: r.agentId, state: "canceled" });
    return this.#view(r, this.#o.maxHistory);
  }

  /** Resolves when the task is terminal (a test and `blocking` sends wait on it). */
  async settled(id: string): Promise<void> { await this.#tasks.get(id)?.done; }

  #view(r: Rec, historyLength: number): A2aTask {
    const status: A2aTask["status"] = { state: r.state, timestamp: new Date(r.updatedAt).toISOString() };
    // RULING: a failure tells the peer only that it failed (or timed out), never the provider's error text.
    if (r.state === "failed") status.message = { kind: "message", role: "agent", messageId: `${r.id}-status`, parts: [{ kind: "text", text: r.reason === "timeout" ? "The agent did not answer in time." : "The agent could not complete the task." }], contextId: r.contextId, taskId: r.id };
    const t: A2aTask = { kind: "task", id: r.id, contextId: r.contextId, status };
    if (r.state === "completed" && r.reply !== undefined) t.artifacts = [{ artifactId: `${r.id}-reply`, name: "reply", parts: [{ kind: "text", text: r.reply }] }];
    if (historyLength > 0) t.history = structuredClone(r.history.slice(-historyLength));
    return t;
  }
}
