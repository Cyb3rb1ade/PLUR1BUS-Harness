// The submit/event turn loop (ADR-010 L2): `submit` records the user's message and a running turn atomically and returns
// at once; the turn then runs in the background, every step persisted as an ordered per-session event and relayed to
// subscribers. recall once before, capture once after (acceptance 4); no memory loop of its own.
import type { CallerIdentity } from "@plur1bus/rpc-schema";
import type { Compactor } from "./compaction.ts";
import { estimateTokens } from "./compaction.ts";
import type { TurnMemory } from "./memory-port.ts";
import type { ChatProvider } from "./provider.ts";
import type { SessionStore } from "./store.ts";
import { SessionError, type EventRecord, type SessionRecord } from "./types.ts";

export interface TurnLoopLogger { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void }

export interface TurnRunnerDeps {
  store: SessionStore; compactor: Compactor; memory: TurnMemory;
  /** null: no provider is configured (`submit` then fails with `no-provider` before anything is written). */
  provider: () => ChatProvider | null;
  /** Every persisted event, as it is persisted, with its session (the core relays it as `session.event`). */
  notify?: (e: EventRecord, session: SessionRecord) => void;
  logger?: TurnLoopLogger;
  /** The core's shutdown signal: aborts running turns, which then end `failed` (reason `aborted`). */
  signal?: AbortSignal;
}

export interface TurnHandle { turnId: string; sessionId: string; messageId: string; done: Promise<TurnOutcome> }
export interface TurnOutcome { state: "completed" | "failed"; error?: string; assistantMessageId?: string; reply?: string }

export class NoProviderError extends SessionError {
  constructor() { super("conflict", "no chat provider is configured", "no-provider"); }
}

export class TurnRunner {
  readonly #d: TurnRunnerDeps;
  readonly #inflight = new Set<Promise<unknown>>();
  constructor(d: TurnRunnerDeps) { this.#d = d; }

  /** The caller has authorised `session` (owner check) already. */
  submit(a: { session: SessionRecord; caller: CallerIdentity; text: string }): TurnHandle {
    const provider = this.#d.provider();
    if (!provider) throw new NoProviderError();
    if (a.text.length === 0) throw new SessionError("invalid", "message text is empty", "text-empty");
    const { turn, message, event } = this.#d.store.beginTurn(a.session.id, a.text, estimateTokens(a.text));
    this.#emit(event, a.session);
    const run = this.#run(a.session, a.caller, a.text, turn.id, turn.incognito, provider);
    this.#inflight.add(run); void run.finally(() => this.#inflight.delete(run));
    return { turnId: turn.id, sessionId: a.session.id, messageId: message.id, done: run };
  }

  /** Resolves once every turn that was running when it was called has fully finished (events, capture, compaction). */
  async idle(): Promise<void> { while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]); }

  #emit(e: EventRecord, session: SessionRecord): void {
    try { this.#d.notify?.(e, session); } catch (err) { this.#d.logger?.warn("session event relay failed", { sessionId: session.id, seq: e.seq, err }); }
  }
  #event(turnId: string, type: Parameters<SessionStore["appendEvent"]>[1], data: Record<string, unknown>, session: SessionRecord): void {
    this.#emit(this.#d.store.appendEvent(turnId, type, data), session);
  }

  async #run(session: SessionRecord, caller: CallerIdentity, text: string, turnId: string, incognito: boolean, provider: ChatProvider): Promise<TurnOutcome> {
    const { store, memory, compactor } = this.#d;
    const signal = this.#d.signal ?? new AbortController().signal;
    try {
      // 1. recall: exactly one call. A recall that fails or degrades never fails the turn.
      let recalled: { text: string; degraded: unknown } = { text: "", degraded: null };
      try { recalled = await memory.recall({ agentId: session.agentId, caller, query: text, signal }); }
      catch (e) { recalled = { text: "", degraded: { reason: "recall-error", detail: e instanceof Error ? e.message : String(e) } }; this.#d.logger?.warn("session recall failed", { sessionId: session.id, turnId, err: e }); }
      signal.throwIfAborted();

      // 2. context within the L14 bound (a swap is preceded by the `compaction` checkpoint, never for an incognito session).
      const view = await compactor.prepare(session.id);

      // 3. the provider stream, persisted event by event.
      let reply = ""; let usage: { inputTokens: number; outputTokens: number } | null = null; let index = 0;
      for await (const chunk of provider.stream({
        sessionId: session.id, agentId: session.agentId, summaries: view.summaries.map((s) => s.text), memory: recalled.text,
        messages: view.messages.map((m) => ({ role: m.role, text: m.text })), signal,
      })) {
        signal.throwIfAborted();
        if (chunk.type === "delta") { reply += chunk.text; this.#event(turnId, "delta", { index: index++, text: chunk.text }, session); }
        else if (chunk.type === "tool.call") this.#event(turnId, "tool.call", { id: chunk.id, name: chunk.name, ...(chunk.args !== undefined ? { args: chunk.args } : {}) }, session);
        else if (chunk.type === "tool.result") this.#event(turnId, "tool.result", { id: chunk.id, output: chunk.output }, session);
        else usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
      }

      // 4. complete, then capture (once) and keep the context small. The turn is complete for the client at this point.
      const done = store.completeTurn(turnId, {
        text: reply, tokens: usage?.outputTokens ?? estimateTokens(reply),
        data: { provider: provider.id, ...(usage ? { usage } : {}), recall: { degraded: recalled.degraded }, ...(view.compaction.swapped || view.clipped ? { compaction: view.compaction, clipped: view.clipped } : {}) },
      });
      if (!done) return { state: "failed", error: "turn-not-running" };
      this.#emit(done.event, session);
      await this.#after(session, caller, turnId, text, reply, incognito);
      return { state: "completed", assistantMessageId: done.message.id, reply };
    } catch (e) {
      const error = signal.aborted ? "aborted" : e instanceof Error ? e.message : String(e);
      try { const ev = store.failTurn(turnId, error); if (ev) this.#emit(ev, session); }
      catch (e2) { this.#d.logger?.warn("session turn could not be marked failed; recovery will at the next start", { sessionId: session.id, turnId, err: e2 }); }
      this.#d.logger?.warn("session turn failed", { sessionId: session.id, turnId, error });
      return { state: "failed", error };
    }
  }

  async #after(session: SessionRecord, caller: CallerIdentity, turnId: string, user: string, assistant: string, incognito: boolean): Promise<void> {
    if (!incognito) {
      // RULING: incognito (D92 §3.3) means no capture call at all, not a capture flagged incognito; the flag is still passed, derived here from the session.
      try { await this.#d.memory.capture({ agentId: session.agentId, caller, sessionId: session.id, turnId, messages: [{ role: "user", content: user }, { role: "assistant", content: assistant }], incognito }); }
      catch (e) { this.#d.logger?.warn("session capture failed", { sessionId: session.id, turnId, err: e }); }
    }
    try { await this.#d.compactor.afterTurn(session.id); } catch (e) { this.#d.logger?.warn("session compaction prepare failed", { sessionId: session.id, err: e }); }
  }
}
