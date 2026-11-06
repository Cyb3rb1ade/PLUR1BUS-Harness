// The port between the ACP server and a harness: the server speaks ACP and knows nothing of sessions; a backend turns
// "create a session / run a prompt / cancel it" into `session.*` calls (`CoreSessionBackend`).
import type { CallerIdentity } from "@plur1bus/rpc-schema";
import type { AcpPermissionHandler } from "./permissions.ts";
import { AcpApprovalRelay } from "./core-permissions.ts";
import type { AcpMode } from "./modes.ts";
import { AcpFailure } from "./failure.ts";
import { AcpFileChanges, type AcpFileContent } from "./file-changes.ts";
import { acpText, type AcpLanguage } from "./text.ts";

/** What a turn reports while it runs. Text is the model's output; tool events are relayed, never executed here. */
export type AcpTurnUpdate =
  | { type: "text"; text: string }
  | { type: "notice"; reason: "approval-refused" | "profile-changed"; text: string }
  | { type: "tool.call"; id: string; name: string; args?: unknown }
  | { type: "tool.result"; id: string; output: string; content?: AcpFileContent[] };

export interface AcpTurnOutcome {
  state: "completed" | "failed" | "cancelled";
  /** Never sent to the client or logged (a provider's error text may carry anything). */
  error?: string;
}

export interface AcpBackend {
  readonly features?: { modes?: boolean; steer?: boolean; followUp?: boolean };
  /** One ACP session = one harness session; current Core uses `acp`, older Core's plain-chat fallback uses `direct`. */
  createSession(input?: { cwd: string }): Promise<{ sessionId: string; mode?: AcpMode }>;
  setMode?(sessionId: string, mode: AcpMode): Promise<{ mode: AcpMode; changed: boolean }>;
  deliver?(input: { sessionId: string; text: string; delivery: "steer" | "queue" }): Promise<unknown>;
  /** Runs one turn; `onUpdate` is called in order, before the returned promise settles. */
  prompt(a: { sessionId: string; text: string }, onUpdate: (u: AcpTurnUpdate) => void, requestPermission?: AcpPermissionHandler): Promise<AcpTurnOutcome>;
  /** Stops the session's running turn (a no-op when none runs). */
  cancel(sessionId: string): Promise<void>;
}

export interface RpcCaller {
  readonly hello?: { capabilities?: { methods: Readonly<Record<string, unknown>>; features?: readonly string[] } };
  call<T = unknown>(method: string, params?: object): Promise<T>;
}

export interface CoreSessionBackendOptions {
  client: RpcCaller;
  caller: CallerIdentity;
  agentId: string;
  /** Waits between two `session.events` polls; a test passes an immediate one. Default 40 ms. */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Startup profile; a requested coding profile refuses an older Core rather than pretending it was applied. */
  initialMode?: AcpMode;
  language?: AcpLanguage;
}

interface WireEvent { seq: number; turnId: string | null; type: string; data: Record<string, unknown> }
interface Inflight { cancelRequested: boolean; turnId: string | null }
const MAX_SESSIONS = 1024;

// RULING: the turn is followed by polling `session.events` (the persisted, replayable stream), not by the opt-in
// `session.event` notification: polling needs no subscription state, survives a reconnect and is the same path a
// reader that missed events uses. The price is up to `pollMs` of added latency per update burst.
export class CoreSessionBackend implements AcpBackend {
  readonly features: NonNullable<AcpBackend["features"]>;
  readonly #o: CoreSessionBackendOptions;
  readonly #cursor = new Map<string, number>();
  readonly #bindings = new Map<string, { root: string; mode: AcpMode }>();
  readonly #inflight = new Map<string, Inflight>();
  #creating = 0;
  constructor(o: CoreSessionBackendOptions) {
    this.#o = o;
    const supports = (method: string) => Object.hasOwn(o.client.hello?.capabilities?.methods ?? {}, method);
    const modes = supports("code.session.open") && supports("code.session.mode");
    // Native CLI uses this same queue contract signal. Do not advertise delivery on the older submit-only surface.
    const delivery = supports("session.submit") && supports("session.queue.list");
    this.features = { modes, steer: delivery, followUp: delivery };
  }

  async createSession(input?: { cwd: string }): Promise<{ sessionId: string; mode?: AcpMode }> {
    const mode = this.#o.initialMode ?? "chat";
    if (mode === "coding" && !this.features.modes) throw new AcpFailure("coding-unavailable");
    if (this.#cursor.size + this.#creating >= MAX_SESSIONS) throw new AcpFailure("session-limit");
    if (this.features.modes && !input?.cwd) throw new AcpFailure("root-not-granted");
    this.#creating++;
    let r: { session: { id: string } };
    try {
      r = await this.#o.client.call("session.create", { caller: this.#o.caller,
        agentId: this.#o.agentId, kind: this.features.modes ? "acp" : "direct", title: "ACP" });
    } finally {
      this.#creating--;
    }
    this.#cursor.set(r.session.id, 0);
    if (this.features.modes) {
      try {
        const bound = await this.#o.client.call<{ state: string; root: string }>("code.session.open", {
          caller: this.#o.caller, agentId: this.#o.agentId, sessionId: r.session.id,
          root: input!.cwd, interactive: false,
        });
        if (bound.state !== "open") throw new AcpFailure("root-not-granted");
        this.#bindings.set(r.session.id, { root: bound.root, mode: "coding" });
        const selected = await this.setMode(r.session.id, mode);
        return { sessionId: r.session.id, mode: selected.mode };
      } catch (error) {
        this.#cursor.delete(r.session.id);
        this.#bindings.delete(r.session.id);
        // This newly-created empty session belongs to this failed operation, never an existing editor transcript.
        await this.#o.client.call("session.archive", { caller: this.#o.caller, sessionId: r.session.id }).catch(() => {});
        if (error instanceof AcpFailure) throw error;
        if (error && typeof error === "object" && "error" in error && error.error === "E_APPROVAL_REQUIRED") {
          throw new AcpFailure("root-not-granted");
        }
        throw error;
      }
    }
    return { sessionId: r.session.id };
  }

  /** Core validates the person, bound root and audit writer; the editor cannot add a grant through this path. */
  async setMode(sessionId: string, mode: AcpMode): Promise<{ mode: AcpMode; changed: boolean }> {
    if (!this.features.modes) throw new AcpFailure("mode-unavailable");
    const binding = this.#bindings.get(sessionId);
    if (!binding) throw new AcpFailure("unknown-session");
    const result = await this.#o.client.call<{ mode: AcpMode; changed: boolean }>("code.session.mode", {
      caller: this.#o.caller, sessionId, mode,
    });
    binding.mode = result.mode;
    return result;
  }

  /** Only the Core's advertised steering/queue contract enables these optional ACP extensions. */
  async deliver(input: { sessionId: string; text: string; delivery: "steer" | "queue" }): Promise<unknown> {
    if (!this.features.steer || !this.features.followUp) throw new AcpFailure("delivery-unavailable");
    if (!this.#cursor.has(input.sessionId)) throw new AcpFailure("unknown-session");
    return this.#o.client.call("session.submit", { caller: this.#o.caller, sessionId: input.sessionId,
      text: input.text, delivery: input.delivery, wait: false });
  }

  async prompt(a: { sessionId: string; text: string }, onUpdate: (u: AcpTurnUpdate) => void, requestPermission?: AcpPermissionHandler): Promise<AcpTurnOutcome> {
    const { caller } = this.#o;
    const flight: Inflight = { cancelRequested: false, turnId: null };
    const changes = new AcpFileChanges(this.#bindings.get(a.sessionId)?.root, this.#o.language);
    this.#inflight.set(a.sessionId, flight);
    let approvals: AcpApprovalRelay | undefined;
    try {
      const sub = await this.#o.client.call<{ turnId: string }>("session.submit", { caller, sessionId: a.sessionId, text: a.text });
      flight.turnId = sub.turnId;
      if (requestPermission && ["approval.list", "approval.get", "approval.decide", "approval.cancel"].every(method =>
        Object.hasOwn(this.#o.client.hello?.capabilities?.methods ?? {}, method))) {
        approvals = new AcpApprovalRelay({ client: this.#o.client, agentId: this.#o.agentId, sessionId: a.sessionId,
          turnId: sub.turnId, requestPermission, language: this.#o.language ?? "en",
          refused: () => onUpdate({ type: "notice", reason: "approval-refused",
            text: acpText(this.#o.language).approvalRefused }) });
      }
      // A cancel that arrived before the turn existed is applied now.
      // A failing cancel must not abandon a turn that is running: it is still followed to its end.
      if (flight.cancelRequested) await this.#cancelCall(a.sessionId).catch(() => {});
      const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      for (;;) {
        const after = this.#cursor.get(a.sessionId) ?? 0;
        const page = await this.#o.client.call<{ events: WireEvent[]; running: boolean }>("session.events", { caller, sessionId: a.sessionId, afterSeq: after, limit: 500 });
        for (const e of page.events) {
          this.#cursor.set(a.sessionId, e.seq);
          if (e.turnId !== sub.turnId) continue;
          if (e.type === "delta" && typeof e.data.text === "string") onUpdate({ type: "text", text: e.data.text });
          else if (e.type === "tool.call") {
            const id = String(e.data.id), name = String(e.data.name);
            changes.call(id, name, e.data.args);
            onUpdate({ type: "tool.call", id, name, ...(e.data.args !== undefined ? { args: e.data.args } : {}) });
          } else if (e.type === "tool.result") {
            const id = String(e.data.id), output = String(e.data.output ?? "");
            const content = changes.result(id, output);
            onUpdate({ type: "tool.result", id, output, ...(content ? { content } : {}) });
          }
          else if (e.type === "turn.completed") return { state: "completed" };
          else if (e.type === "turn.failed") {
            const error = typeof e.data.error === "string" ? e.data.error : "unknown";
            return error === "cancelled" ? { state: "cancelled" } : { state: "failed", error };
          }
        }
        if (page.events.length === 0 && !page.running) return { state: "failed", error: "turn-ended-without-event" };
        await approvals?.poll();
        if (page.events.length < 500) await sleep(this.#o.pollMs ?? 40);
      }
    } catch (error) {
      if (flight.turnId !== null) await this.#cancelCall(a.sessionId).catch(() => {});
      throw error;
    } finally { approvals?.close(); this.#inflight.delete(a.sessionId); }
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
