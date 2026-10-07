import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { FakeChatProvider, type ChatProvider, type FakeProviderOptions } from "../../src/session/provider.ts";
import { BodyTooLarge, createA2aHandler, type A2aHandler, type A2aHandlerOptions, type A2aHttpResponse } from "../../src/a2a/handler.ts";
import { hashKey } from "../../src/a2a/policy.ts";
import type { A2aAgentInfo, A2aPeerConfig } from "../../src/a2a/types.ts";
import type { Scheduler } from "../../src/a2a/tasks.ts";

export const KEY_A = "peer-a-key-0123456789abcdef0123456789abcdef";
export const KEY_B = "peer-b-key-0123456789abcdef0123456789abcdef";
export const BASE = "http://127.0.0.1:4100";

export class TestClock { t = 1_700_000_000_000; now(): number { return this.t; } advance(ms: number): void { this.t += ms; } }

/** A scheduler a test fires by hand (no sleeps). */
export class ManualScheduler implements Scheduler {
  readonly #timers = new Map<number, () => void>(); #n = 0;
  set(fn: () => void): unknown { const id = ++this.#n; this.#timers.set(id, fn); return id; }
  clear(h: unknown): void { this.#timers.delete(h as number); }
  fireAll(): void { for (const [id, fn] of [...this.#timers]) { this.#timers.delete(id); fn(); } }
  get pending(): number { return this.#timers.size; }
}

export const peers = (): A2aPeerConfig[] => [
  { id: "peer-a", keySha256: hashKey(KEY_A), grants: { bernd: ["card.read", "task.send", "task.read", "task.cancel"] } },
  { id: "peer-b", keySha256: hashKey(KEY_B), grants: { bernd: ["card.read"], anna: ["card.read", "task.send", "task.read", "task.cancel"] } },
];
export const AGENTS: Record<string, A2aAgentInfo> = {
  bernd: { optIn: true, displayName: "Bernd", description: "Helpful assistant", skills: [{ id: "chat", name: "Chat", description: "Talk", tags: ["general"] }] },
  anna: { optIn: true },
  hidden: { optIn: false },
};

export interface Rig { h: A2aHandler; clock: TestClock; sched: ManualScheduler; audit: ReturnType<typeof memoryAuditSink>; provider: ChatProvider | null }
export function rig(o: { provider?: ChatProvider | null; fake?: FakeProviderOptions; opts?: Partial<A2aHandlerOptions> } = {}): Rig {
  const clock = new TestClock(); const sched = new ManualScheduler(); const audit = memoryAuditSink();
  const provider = o.provider === undefined ? new FakeChatProvider(o.fake) : o.provider;
  const h = createA2aHandler({
    peers: peers(), agents: (id) => (Object.hasOwn(AGENTS, id) ? AGENTS[id] : undefined), advertisedBaseUrl: BASE,
    provider: () => provider, clock, scheduler: sched, audit, ...o.opts,
  });
  return { h, clock, sched, audit, provider };
}

export interface Call { method?: string; path: string; key?: string | null; headers?: Record<string, string>; body?: unknown; raw?: Buffer; remote?: string }
export async function http(h: A2aHandler, c: Call): Promise<A2aHttpResponse> {
  const body = c.raw ?? (c.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(c.body)));
  const headers: Record<string, string | undefined> = { ...(c.key === null ? {} : { authorization: `Bearer ${c.key ?? KEY_A}` }), ...c.headers };
  if (c.method !== "GET" && c.body !== undefined && headers["content-type"] === undefined) headers["content-type"] = "application/json";
  return h.handle({
    method: c.method ?? "POST", path: c.path, headers, remote: c.remote ?? "127.0.0.1",
    readBody: async (limit) => { if (body.length > limit) throw new BodyTooLarge(); return body; },
  });
}
let n = 0;
export const rpc = (h: A2aHandler, method: string, params: unknown, c: Partial<Call> = {}): Promise<{ status: number; json: any }> =>
  http(h, { path: "/a2a/bernd/", body: { jsonrpc: "2.0", id: ++n, method, params }, ...c }).then((r) => ({ status: r.status, json: JSON.parse(r.body) }));
export const sendMsg = (text: string, extra: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}) =>
  ({ message: { role: "user", messageId: `m-${++n}`, parts: [{ kind: "text", text }], ...extra }, ...(Object.keys(cfg).length ? { configuration: cfg } : {}) });
