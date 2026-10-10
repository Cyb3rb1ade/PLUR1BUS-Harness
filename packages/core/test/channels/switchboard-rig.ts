// A small real core for switchboard tests: the real identity service, session store and turn runner (scripted provider),
// a fake configuration source and secret store, a fake clock, and fake channel adapters. No network, no timers of its own.
import { join } from "node:path";
import { defaults, restartPlan, validate, type HarnessConfig } from "@plur1bus/config-schema";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import type { TurnMemory } from "../../src/session/memory-port.ts";
import type { ChatChunk, ChatProvider, ChatRequest } from "../../src/session/provider.ts";
import { SessionStore } from "../../src/session/store.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import { createIdentityService, type Actor, type IdentityService } from "../../src/identity/service.ts";
import type { ApprovalView, ServiceDecideInput, ServiceDecideResult } from "../../src/approvals/service.ts";
import {
  createSwitchboard, type ChannelBinding, type HostedChannel, type Switchboard, type SwitchboardOptions,
} from "../../src/channels/switchboard.ts";
import type { Channel, ChannelHealth, ChannelHost, OutboundMessage } from "../../src/channels/index.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { FakeClock, silentLog } from "./helpers.ts";

export { FakeClock, flush, silentLog } from "./helpers.ts";

export const OWNER: Actor = { user: "owner", host: "test", kind: "person", role: "admin" };

/** The configuration source the host listens to: `set` validates against the real schema and announces the change. */
export class FakeConfig {
  #cfg: HarnessConfig = defaults();
  #listeners = new Set<(prev: HarnessConfig, next: HarnessConfig, plan: ReturnType<typeof restartPlan>) => void>();
  current = (): HarnessConfig => this.#cfg;
  onChange = (fn: (prev: HarnessConfig, next: HarnessConfig, plan: ReturnType<typeof restartPlan>) => void): (() => void) => {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  };
  /** Merges `patch` into `channels.<id>` and notifies the listeners like the supervisor's `config.changed`. */
  set(id: string, patch: Record<string, unknown>): void {
    const next = structuredClone(this.#cfg) as unknown as { channels: Record<string, Record<string, unknown>> };
    next.channels[id] = { ...next.channels[id], ...patch };
    const checked = validate(next);
    if (!checked.ok) throw new Error(`test config invalid: ${checked.errors.join("; ")}`);
    const prev = this.#cfg;
    this.#cfg = checked.config;
    const plan = restartPlan(prev, this.#cfg);
    for (const fn of [...this.#listeners]) fn(prev, this.#cfg, plan);
  }
  listeners(): number { return this.#listeners.size; }
}

export class FakeSecrets {
  values = new Map<string, string>();
  reads: string[] = [];
  put(name: string, value: string): void { this.values.set(name, value); }
  async has(name: string): Promise<boolean> { return this.values.has(name); }
  async read(name: string): Promise<string | null> { this.reads.push(name); return this.values.get(name) ?? null; }
}

export interface DecideCall extends ServiceDecideInput {}
export class FakeApprovals {
  decisions: DecideCall[] = [];
  result: ServiceDecideResult = { ok: true, status: "approved", grantIds: [] };
  decide(input: ServiceDecideInput): ServiceDecideResult { this.decisions.push(input); return this.result; }
}

/** An adapter double. `plan` scripts start outcomes; everything it is asked to do is recorded. */
export class FakeAdapter implements HostedChannel {
  readonly name: string;
  cfg: Record<string, unknown>;
  deps: Record<string, unknown>;
  starts = 0; stops = 0;
  host?: ChannelHost;
  sent: OutboundMessage[] = [];
  turns: unknown[] = [];
  prompts: { chatId: string; text: string; choices: readonly { id: string; label: string }[]; approverIds: readonly string[]; ttlMs?: number }[] = [];
  healthAnswer: ChannelHealth = { ok: true };
  startPlan: ("ok" | "throw")[] = [];
  startError = "start failed";
  ownerTarget: ((who: { userId: string; accountId?: string }) => Promise<string>) | undefined;
  #decisions = new Set<(d: { promptId: string; chatId: string; senderId: string; choiceId: string; at: number }) => void | Promise<void>>();
  constructor(name: string, cfg: Record<string, unknown>, deps: Record<string, unknown>) { this.name = name; this.cfg = cfg; this.deps = deps; }
  async start(host: ChannelHost): Promise<void> {
    this.starts++; this.host = host;
    if ((this.startPlan.shift() ?? "ok") === "throw") throw new Error(this.startError);
  }
  async stop(): Promise<void> { this.stops++; }
  async health(): Promise<ChannelHealth> { return this.healthAnswer; }
  async send(msg: OutboundMessage): Promise<void> { this.sent.push(msg); }
  async sendTurn(turn: unknown): Promise<unknown[]> { this.turns.push(turn); return []; }
  async prompt(req: FakeAdapter["prompts"][number]): Promise<{ promptId: string; refs: unknown[] }> {
    this.prompts.push(req);
    return { promptId: `prompt-${this.prompts.length}`, refs: [] };
  }
  onDecision(h: (d: { promptId: string; chatId: string; senderId: string; choiceId: string; at: number }) => void | Promise<void>): () => void {
    this.#decisions.add(h);
    return () => void this.#decisions.delete(h);
  }
  resolveOwnerTarget(who: { userId: string; accountId?: string }): Promise<string> {
    return this.ownerTarget ? this.ownerTarget(who) : Promise.resolve(who.userId);
  }
  /** A button press / reply code arriving from the platform. */
  async decide(d: { promptId: string; chatId: string; senderId: string; choiceId: string }): Promise<void> {
    for (const h of [...this.#decisions]) await h({ ...d, at: 0 });
  }
  inbound(o: Partial<{ chatId: string; chatKind: "direct" | "group"; senderId: string; text: string; messageId: string; accountId: string }> = {}): Promise<void> {
    return this.host!.receive({ channel: this.name, chatId: "chat-1", chatKind: "direct", senderId: "sender-1", text: "hello", ...o });
  }
}

export const MANIFEST = (id: string, o: Record<string, unknown> = {}) => ({
  name: id, version: "0.1.0", kind: "channel", apiVersion: "1", displayName: id, chatKinds: ["direct", "group"], startDelayMs: 0, maxRestarts: 3, ...o,
});

/** A binding whose adapters are `FakeAdapter`s; `made` lists every instance the host asked for. */
export function fakeBinding(id: string, made: FakeAdapter[], o: { constructorThrows?: () => Error | undefined; onMake?: (a: FakeAdapter) => void; manifest?: Record<string, unknown> } = {}): ChannelBinding {
  return {
    id,
    manifest: MANIFEST(id, o.manifest),
    async load() {
      return (cfg, deps) => {
        const err = o.constructorThrows?.();
        if (err) throw err;
        const a = new FakeAdapter(id, cfg, deps);
        o.onMake?.(a);
        made.push(a);
        return a;
      };
    },
  };
}

export class ScriptedProvider implements ChatProvider {
  readonly id = "scripted";
  requests: ChatRequest[] = [];
  script: (req: ChatRequest) => ChatChunk[] = (req) => [{ type: "delta", text: `echo:${req.messages.at(-1)?.text ?? ""}` }];
  async *stream(req: ChatRequest): AsyncGenerator<ChatChunk> { this.requests.push(req); for (const c of this.script(req)) yield c; }
}

const memory: TurnMemory = { async recall() { return { text: "", degraded: null }; }, async capture() {}, async checkpoint() {} };

export interface Rig {
  clock: FakeClock; config: FakeConfig; secrets: FakeSecrets; approvals: FakeApprovals;
  identity: IdentityService; store: SessionStore; runner: TurnRunner; provider: ScriptedProvider;
  logs: { level: string; msg: string; fields?: Record<string, unknown> }[];
  switchboard: Switchboard; made: FakeAdapter[];
  /** A human with an active link on `channel` (the identity service's own pairing flow, so the rig exercises the real thing). */
  link(channel: string, accountId: string, userId: string, displayName?: string): { humanId: string };
  adapter(id?: string): FakeAdapter;
  close(): void;
}

export function makeRig(o: { ids?: string[]; switchboard?: Partial<SwitchboardOptions>; binding?: (id: string, made: FakeAdapter[]) => ChannelBinding } = {}): Rig {
  const clock = new FakeClock();
  const config = new FakeConfig();
  const secrets = new FakeSecrets();
  const approvals = new FakeApprovals();
  const dir = tempDir("switchboard-");
  const identity = createIdentityService({ dbPath: join(dir, "identity.sqlite"), clock: () => clock.now() + 1_800_000_000_000, audit: () => {} });
  const store = new SessionStore({ path: ":memory:" });
  const provider = new ScriptedProvider();
  const compactor = new Compactor(store, defaultCompaction(8192), { beforeSwap: async () => {} });
  const runner = new TurnRunner({ store, compactor, memory, provider: () => provider });
  const logs: Rig["logs"] = [];
  const made: FakeAdapter[] = [];
  const ids = o.ids ?? ["discord"];
  const bindings = ids.map((id) => (o.binding ? o.binding(id, made) : fakeBinding(id, made)));
  const switchboard = createSwitchboard({
    config, secrets, identity: () => identity, approvals: () => approvals,
    turns: () => ({ store, runner, agentId: () => "main" }),
    clock, log: { info: (msg, fields) => logs.push({ level: "info", msg, ...(fields ? { fields } : {}) }), warn: (msg, fields) => logs.push({ level: "warn", msg, ...(fields ? { fields } : {}) }), error: (msg, fields) => logs.push({ level: "error", msg, ...(fields ? { fields } : {}) }) },
    bindings, stateDir: join(dir, "channels"),
    registry: { backoff: { baseMs: 1000, maxMs: 8000 } },
    ...o.switchboard,
  });
  const rig: Rig = {
    clock, config, secrets, approvals, identity, store, runner, provider, logs, switchboard, made,
    link(channel, accountId, userId, displayName) {
      const human = identity.createHuman({ displayName: displayName ?? "Pat" }, OWNER);
      const self: Actor = { user: human.id, host: "test", kind: "person", role: "member" };
      const p = identity.startPairing({ humanId: human.id, channel }, self);
      const claimed = identity.claim({ code: p.code, identity: { channel, accountId, userId } });
      identity.confirm({ pairingId: claimed.pairingId, approve: true }, self);
      return { humanId: human.id };
    },
    adapter(id = ids[0]!) { const a = made.filter((m) => m.name === id).at(-1); if (!a) throw new Error(`no adapter made for ${id}`); return a; },
    close() { void switchboard.stop(); identity.close(); store.close?.(); },
  };
  return rig;
}

export { silentLog as quietLog };
export type { ApprovalView, Channel };
