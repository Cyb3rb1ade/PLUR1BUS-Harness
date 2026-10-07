// The port between the ACP server and a harness: the server speaks ACP and knows nothing of sessions; a backend turns
// "create a session / run a prompt / cancel it" into `session.*` calls (`CoreSessionBackend`).
import type { CallerIdentity } from "@plur1bus/rpc-schema";

/** What a turn reports while it runs. Text is the model's output; tool events are relayed, never executed here. */
export type AcpTurnUpdate =
  | { type: "text"; text: string }
  | { type: "tool.call"; id: string; name: string; args?: unknown }
  | { type: "tool.result"; id: string; output: string };

export interface AcpTurnOutcome {
  state: "completed" | "failed" | "cancelled";
  /** Never sent to the client or logged (a provider's error text may carry anything). */
  error?: string;
}

export interface AcpBackend {
  /** One ACP session = one harness session (kind `acp`). */
  createSession(): Promise<{ sessionId: string }>;
  /** Runs one turn; `onUpdate` is called in order, before the returned promise settles. */
  prompt(a: { sessionId: string; text: string }, onUpdate: (u: AcpTurnUpdate) => void): Promise<AcpTurnOutcome>;
  /** Stops the session's running turn (a no-op when none runs). */
  cancel(sessionId: string): Promise<void>;
}

export interface RpcCaller { call<T = unknown>(method: string, params?: object): Promise<T> }

export interface CoreSessionBackendOptions {
  client: RpcCaller;
  caller: CallerIdentity;
  agentId: string;
  /** Waits between two `session.events` polls; a test passes an immediate one. Default 40 ms. */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

interface WireEvent { seq: number; turnId: string | null; type: string; data: Record<string, unknown> }
interface Inflight { cancelRequested: boolean; turnId: string | null }

// RULING: the turn is followed by polling `session.events` (the persisted, replayable stream), not by the opt-in
// `session.event` notification: polling needs no subscription state, survives a reconnect and is the same path a
// reader that missed events uses. The price is up to `pollMs` of added latency per update burst.
export class CoreSessionBackend implements AcpBackend {
  readonly #o: CoreSessionBackendOptions;
  readonly #cursor = new Map<string, number>();
  readonly #inflight = new Map<string, Inflight>();
  constructor(o: CoreSessionBackendOptions) { this.#o = o; }

  async createSession(): Promise<{ sessionId: string }> {
    const r = await this.#o.client.call<{ session: { id: string } }>("session.create", { caller: this.#o.caller, agentId: this.#o.agentId, kind: "acp", title: "ACP" });
    this.#cursor.set(r.session.id, 0);
    return { sessionId: r.session.id };
  }

  async prompt(a: { sessionId: string; text: string }, onUpdate: (u: AcpTurnUpdate) => void): Promise<AcpTurnOutcome> {
    const { caller } = this.#o;
    const flight: Inflight = { cancelRequested: false, turnId: null };
    this.#inflight.set(a.sessionId, flight);
    try {
      const sub = await this.#o.client.call<{ turnId: string }>("session.submit", { caller, sessionId: a.sessionId, text: a.text });
      flight.turnId = sub.turnId;
      // A cancel that arrived before the turn existed is applied now.
      if (flight.cancelRequested) await this.#cancelCall(a.sessionId);
      const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      for (;;) {
        const after = this.#cursor.get(a.sessionId) ?? 0;
        const page = await this.#o.client.call<{ events: WireEvent[]; running: boolean }>("session.events", { caller, sessionId: a.sessionId, afterSeq: after, limit: 500 });
        for (const e of page.events) {
          this.#cursor.set(a.sessionId, e.seq);
          if (e.turnId !== sub.turnId) continue;
          if (e.type === "delta" && typeof e.data.text === "string") onUpdate({ type: "text", text: e.data.text });
          else if (e.type === "tool.call") onUpdate({ type: "tool.call", id: String(e.data.id), name: String(e.data.name), ...(e.data.args !== undefined ? { args: e.data.args } : {}) });
          else if (e.type === "tool.result") onUpdate({ type: "tool.result", id: String(e.data.id), output: String(e.data.output ?? "") });
          else if (e.type === "turn.completed") return { state: "completed" };
          else if (e.type === "turn.failed") {
            const error = typeof e.data.error === "string" ? e.data.error : "unknown";
            return error === "cancelled" ? { state: "cancelled" } : { state: "failed", error };
          }
        }
        if (page.events.length === 0 && !page.running) return { state: "failed", error: "turn-ended-without-event" };
        if (page.events.length < 500) await sleep(this.#o.pollMs ?? 40);
      }
    } finally { this.#inflight.delete(a.sessionId); }
  }

  async cancel(sessionId: string): Promise<void> {
    const f = this.#inflight.get(sessionId);
    if (!f) return;
    f.cancelRequested = true;
    if (f.turnId !== null) await this.#cancelCall(sessionId);
  }

  async #cancelCall(sessionId: string): Promise<void> {
    await this.#o.client.call("session.cancel", { caller: this.#o.caller, sessionId });
  }
}
