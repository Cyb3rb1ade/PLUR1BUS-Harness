// Adapter from an A2A task onto a turn source. The default wraps the ChatProvider seam (A2A1).
// `createSessionTurnPort` binds a task's contextId to a harness session and drives TurnRunner (this PR).
// Session kind is `direct`: SESSION_KINDS has no `a2a` value (follow-up if a dedicated kind is wanted).
import type { CallerIdentity } from "@plur1bus/rpc-schema";
import { Compactor, defaultCompaction } from "../session/compaction.ts";
import type { TurnMemory } from "../session/memory-port.ts";
import type { ChatProvider } from "../session/provider.ts";
import { SessionStore } from "../session/store.ts";
import { NoProviderError, TurnRunner } from "../session/turn-loop.ts";
import type { SessionRecord } from "../session/types.ts";

export type TurnChunk =
  | { type: "delta"; text: string }
  | { type: "pause"; state: "input-required" | "auth-required"; message: string }
  | { type: "reject"; message: string };

export interface A2aTurnRequest {
  peerId: string;
  agentId: string;
  contextId: string;
  sessionId: string;
  text: string;
  signal: AbortSignal;
}

export interface A2aTurnPort {
  /** Create or reuse the harness session for this A2A context. */
  ensureSession(a: { peerId: string; agentId: string; contextId: string }): { sessionId: string };
  run(req: A2aTurnRequest): AsyncIterable<TurnChunk>;
  /** Abort the session's running turn. Returns whether a turn was running. */
  cancel(sessionId: string): boolean;
  /** False when a turn cannot start (no ChatProvider). Checked before a task is stored. */
  available(): boolean;
}

const PAUSE_INPUT = /INPUT_REQUIRED/;
const PAUSE_AUTH = /AUTH_REQUIRED/;
const REJECT = /\bREJECT\b/;

/** Deterministic ChatProvider wrapper. Special user-text markers drive A2A interrupt/reject states in tests. */
export function createProviderTurnPort(provider: () => ChatProvider | null): A2aTurnPort {
  const sessions = new Map<string, string>();
  return {
    available: () => provider() !== null,
    ensureSession(a) {
      const key = `${a.peerId}:${a.agentId}:${a.contextId}`;
      const existing = sessions.get(key);
      if (existing) return { sessionId: existing };
      sessions.set(key, a.contextId);
      return { sessionId: a.contextId };
    },
    async *run(req) {
      if (PAUSE_INPUT.test(req.text)) { yield { type: "pause", state: "input-required", message: "More information is required." }; return; }
      if (PAUSE_AUTH.test(req.text)) { yield { type: "pause", state: "auth-required", message: "Authentication is required." }; return; }
      if (REJECT.test(req.text)) { yield { type: "reject", message: "The agent rejected the task." }; return; }
      const p = provider();
      if (!p) throw Object.assign(new Error("no chat provider is configured"), { code: "no-provider" });
      const it = p.stream({
        sessionId: req.sessionId, agentId: req.agentId, summaries: [], memory: "",
        messages: [{ role: "user", text: req.text }], signal: req.signal,
      })[Symbol.asyncIterator]();
      try {
        for (;;) {
          req.signal.throwIfAborted();
          const n = await it.next();
          if (n.done) break;
          if (n.value.type === "delta") yield { type: "delta", text: n.value.text };
        }
      } finally { void Promise.resolve(it.return?.()).catch(() => {}); }
    },
    cancel() { return false; },
  };
}

export function a2aCaller(peerId: string): CallerIdentity {
  return { channel: "cli", accountId: `a2a-${peerId}`, userId: peerId };
}

export interface SessionTurnPortOptions {
  store: SessionStore;
  runner: TurnRunner;
  caller?: (peerId: string) => CallerIdentity;
  available?: () => boolean;
}

/** Binds A2A contextId → harness session and drives `TurnRunner.submit` / `cancel`. */
export function createSessionTurnPort(o: SessionTurnPortOptions): A2aTurnPort {
  const callerOf = o.caller ?? a2aCaller;
  const map = new Map<string, string>(); // peer:agent:contextId → sessionId
  const ownerOf = (peerId: string): string => `a2a-peer:${peerId}`;
  return {
    available: o.available ?? (() => true),
    ensureSession(a) {
      const key = `${a.peerId}:${a.agentId}:${a.contextId}`;
      const existing = map.get(key);
      if (existing) {
        const s = o.store.getSession(existing);
        if (s) return { sessionId: s.id };
      }
      const session: SessionRecord = o.store.createSession({
        kind: "direct", agentId: a.agentId, owner: ownerOf(a.peerId), title: "A2A",
      });
      map.set(key, session.id);
      return { sessionId: session.id };
    },
    async *run(req) {
      if (PAUSE_INPUT.test(req.text)) { yield { type: "pause", state: "input-required", message: "More information is required." }; return; }
      if (PAUSE_AUTH.test(req.text)) { yield { type: "pause", state: "auth-required", message: "Authentication is required." }; return; }
      if (REJECT.test(req.text)) { yield { type: "reject", message: "The agent rejected the task." }; return; }
      const session = o.store.getSession(req.sessionId);
      if (!session) throw Object.assign(new Error("session missing"), { code: "no-provider" });
      const caller = callerOf(req.peerId);
      let cursor = o.store.listEvents(req.sessionId).at(-1)?.seq ?? 0;
      let handle: ReturnType<TurnRunner["submit"]>;
      try { handle = o.runner.submit({ session, caller, text: req.text }); }
      catch (e) {
        if (e instanceof NoProviderError) throw Object.assign(new Error("no chat provider is configured"), { code: "no-provider" });
        throw e;
      }
      const abort = (): void => { o.runner.cancel(req.sessionId); };
      if (req.signal.aborted) abort();
      else req.signal.addEventListener("abort", abort, { once: true });
      let outcome: Awaited<typeof handle.done> | undefined;
      const finished = handle.done.then((x) => { outcome = x; });
      const drain = function* (): Generator<TurnChunk> {
        const evs = o.store.listEvents(req.sessionId);
        for (const e of evs) {
          if (e.seq <= cursor) continue;
          cursor = e.seq;
          if (e.type === "delta" && typeof e.data.text === "string") yield { type: "delta", text: e.data.text };
        }
      };
      try {
        while (outcome === undefined) {
          yield* drain();
          await Promise.race([finished, new Promise<void>((r) => setImmediate(r))]);
        }
        yield* drain();
        if (outcome.state === "failed" && (outcome.error === "cancelled" || outcome.error === "aborted")) return;
        if (outcome.state === "failed") throw Object.assign(new Error(outcome.error ?? "failed"), { code: "failed" });
      } finally {
        req.signal.removeEventListener("abort", abort);
      }
    },
    cancel(sessionId) { return o.runner.cancel(sessionId) !== null; },
  };
}

const silentMemory: TurnMemory = {
  async recall() { return { text: "", degraded: null }; },
  async capture() {},
  async checkpoint() {},
};

export interface A2aSessionBackend {
  port: A2aTurnPort;
  store: SessionStore;
  runner: TurnRunner;
  close(): void;
}

/** Self-contained in-memory session backend for tests and hosts that do not already own a TurnRunner. */
export function openA2aSessionBackend(o: { provider: () => ChatProvider | null; clock?: () => number }): A2aSessionBackend {
  const store = new SessionStore({ path: ":memory:", ...(o.clock ? { clock: o.clock } : {}) });
  const compactor = new Compactor(store, defaultCompaction(8192), { beforeSwap: async () => {} });
  const runner = new TurnRunner({ store, compactor, memory: silentMemory, provider: o.provider });
  return {
    port: createSessionTurnPort({ store, runner, available: () => o.provider() !== null }),
    store, runner,
    close() { store.close(); },
  };
}
