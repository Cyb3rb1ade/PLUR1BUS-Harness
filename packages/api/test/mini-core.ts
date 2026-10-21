// A core without the engine, for tests of the REST -> core delegation: the real break-glass registry, the real admin surface
// (breakglass.request|list|revoke|notices), the real RPC guard and the real break-glass memory read, wired the way
// `core.ts` wires them. The API delegates with `callAs`, exactly as it does to the real core, so a grant made over REST
// and one made over RPC land in the one registry a core read consults. Only the engine behind `memory.list` is a fake.
import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import type { ApiPrincipal } from "@plur1bus/module-api";
import { AdminStore } from "../../core/src/identity/admin-store.ts";
import { buildAdminSurface } from "../../core/src/rpc/admin-surface.ts";
import { breakglassMemory } from "../../core/src/rpc/breakglass-memory.ts";
import { guardMethods } from "../../core/src/rbac/guard.ts";
import { createBreakGlass, type BreakGlass, type BreakGlassNotice } from "../../core/src/rbac/break-glass.ts";
import { memoryAuditSink, type AuditSink, type MemoryAuditSink } from "../../core/src/rbac/audit.ts";
import type { Handler } from "../../core/src/rpc/server.ts";
import type { FakeClock } from "../src/clock.ts";
import type { CoreRpc } from "../src/core-rpc.ts";
import type { FakeCore } from "./helpers.ts";

export interface MiniCore extends FakeCore {
  /** Every audit line the core wrote. */
  audit: MemoryAuditSink;
  people: AdminStore;
  breakglass: BreakGlass;
  /** The notices the registry handed to the core's notifier (the durable store is `people`). */
  notified: BreakGlassNotice[];
  /** Makes the person known to the core (a role preset), as `core.ts` knows the people it was told about. */
  addPerson(id: string, role: "owner" | "admin" | "operator" | "member" | "viewer"): void;
  /** What an RPC client of the core does, REST not involved: one call as `principal`. */
  rpc<T = unknown>(principal: ApiPrincipal, method: string, params?: object): Promise<T>;
  close(): void;
}

export interface MiniCoreOptions {
  clock: FakeClock;
  /** Where the core audits break-glass; a sink that throws means no grant. */
  auditSink?: AuditSink;
  /** Called after the notice is stored; a throw means the notice was not delivered, so no grant (`requireNotification`). */
  notify?: (n: BreakGlassNotice) => void;
}

const OWNER_ID = "local-owner";

export function miniCore(o: MiniCoreOptions): MiniCore {
  const audit = memoryAuditSink();
  const sink: AuditSink = { append: (e) => { o.auditSink?.append(e); audit.append(e); } };
  const now = () => o.clock.now();
  const people = new AdminStore({ path: ":memory:", ownerId: OWNER_ID });
  const notified: BreakGlassNotice[] = [];
  const breakglass = createBreakGlass({
    clock: now, audit: sink, requireNotification: true, host: "core",
    notify: (n) => { people.notice(n); notified.push(n); o.notify?.(n); },
  });
  // Only what the break-glass methods read of the identity service: the people it knows.
  const identity = { list: () => ({ humans: people.users().map((u) => ({ id: u.id })) }), resolve: () => undefined } as never;
  const agents = () => ({ main: { displayName: "Main" } });
  const admin = buildAdminSurface({
    people, lifecycle: {} as never, identity, sessions: () => null, breakglass, agents, export: async () => ({}), ownership: (a) => [a.userId], clock: now, audit: sink,
  });
  // The engine is the one fake: a user-scope card of the person whose cards are read, whatever the reader.
  const engine = { memory: { list: async () => ({ agentId: "main", items: [{ id: "c1", scope: "user", text: "a private card", summary: "private", createdAt: 1, origin: "user", epistemicStatus: "asserted" }], truncated: false }) } } as never;
  const memory = breakglassMemory({ methods: { "memory.list": async () => ({ items: [] }), "memory.show": async () => ({}) }, engine, identity, breakglass, workspace: () => tmpdir() });
  const current = new AsyncLocalStorage<ApiPrincipal>();
  const guarded = guardMethods({ ...admin, ...memory }, {
    now, audit: sink, host: "core",
    resolve: () => { const p = current.getStore(); return p ? people.resolve({ kind: p.kind, userId: p.userId, role: p.role }) : null; },
  }) as Record<string, Handler>;
  const ctx = () => ({ requestId: "mini", connectionId: "mini", signal: new AbortController().signal });
  const rpc = async <T>(principal: ApiPrincipal, method: string, params: object = {}): Promise<T> => {
    const handler = guarded[method];
    if (!handler) throw new Error(`mini core has no ${method}`);
    return current.run(principal, async () => await handler(params, ctx()) as T);
  };
  const core: MiniCore = {
    audit, people, breakglass, notified, rpc, calls: [],
    impl: async () => { throw new Error("mini core answers delegated calls only"); },
    // REST handlers without a principal (`call`) are not part of this core; health and the like are not exercised here.
    call: (async (method: string, params?: object) => { core.calls.push({ method, ...(params ? { params } : {}) }); return core.impl(method, params); }) as CoreRpc["call"],
    callAs: (async (method: string, params: object, principal: ApiPrincipal) => { core.calls.push({ method, params }); return rpc(principal, method, params); }) as NonNullable<CoreRpc["callAs"]>,
    subscribeAs: async () => () => {},
    addPerson: (id, role) => people.setRole(id, role, () => {}),
    close: () => people.close(),
  };
  return core;
}

/** Routes the `breakglass.*` calls of another fake core to a mini core (everything else stays with `core`). */
export function withBreakGlass<T extends FakeCore>(core: T, mini: MiniCore): T {
  const other = core.callAs!;
  core.callAs = (async (method: string, params: object, principal: ApiPrincipal, endpoint: "core" | "supervisor", connectionKey?: string) =>
    method.startsWith("breakglass.") ? mini.callAs!(method, params, principal, endpoint, connectionKey) : other(method, params, principal, endpoint, connectionKey)) as NonNullable<CoreRpc["callAs"]>;
  return core;
}
