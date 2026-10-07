import type { Principal } from "../../src/rbac/types.ts";
import { FakeChatProvider, type ChatProvider } from "../../src/session/provider.ts";
import { CollabError } from "../../src/collab/errors.ts";
import { createCollab, type Collab, type CollabOptions } from "../../src/collab/service.ts";
import type { CollabEvent, CollabSettings, Project } from "../../src/collab/types.ts";
import type { AgentDirectoryPort, BudgetPort, RedactionPort } from "../../src/collab/ports.ts";

export class Clock { t: number; constructor(t: number) { this.t = t; } now() { return this.t; } advance(ms: number) { this.t += ms; } }

export function owner(over: Partial<Principal> = {}): Principal {
  return { userId: "u-owner", kind: "person", role: "owner", ...over };
}
export function member(over: Partial<Principal> = {}): Principal {
  return { userId: "u-member", kind: "person", role: "member", ...over };
}
export function viewer(over: Partial<Principal> = {}): Principal {
  return { userId: "u-viewer", kind: "person", role: "viewer", ...over };
}

export const isCode = (c: string, g?: string) => (e: unknown) =>
  e instanceof CollabError && e.code === c && (g === undefined || e.guardrail === g);

export function memoryBudget(limit?: { tokens?: number; cost?: number }): BudgetPort & { used: number } {
  const port = {
    used: 0,
    check(est: { tokens: number; cost: number }) {
      if (limit?.tokens !== undefined && port.used + est.tokens > limit.tokens) return { allowed: false as const, reason: "token-budget" as const };
      if (limit?.cost !== undefined && port.used + est.cost > limit.cost) return { allowed: false as const, reason: "cost-budget" as const };
      return { allowed: true as const };
    },
    record(u: { tokens: number }) { port.used += u.tokens; },
  };
  return port;
}

export function secretRedactor(needle = "SECRETVALUE"): RedactionPort {
  const text = (s: string) => s.split(needle).join("[redacted]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
  const value = <T>(v: T): T => JSON.parse(text(JSON.stringify(v))) as T;
  return { text, value };
}

export interface Harness {
  collab: Collab;
  events: CollabEvent[];
  clock: Clock;
  provider: FakeChatProvider;
  seen: import("../../src/session/provider.ts").ChatRequest[];
}

export function open(over: Partial<CollabOptions> & { settings?: Partial<CollabSettings>; directory?: AgentDirectoryPort } = {}): Harness {
  const clock = over.clock ? undefined : new Clock(1_000_000);
  const events: CollabEvent[] = [];
  const seen: import("../../src/session/provider.ts").ChatRequest[] = [];
  const provider = (over.provider as FakeChatProvider | undefined) ?? new FakeChatProvider({ onRequest: (r) => seen.push(r) });
  const collab = createCollab({
    path: ":memory:",
    clock: over.clock ?? (() => clock!.now()),
    emit: { emit: (e) => events.push(e) },
    provider,
    redact: over.redact ?? secretRedactor(),
    ...(over.authorize ? { authorize: over.authorize } : {}),
    ...(over.budget ? { budget: over.budget } : {}),
    ...(over.directory ? { directory: over.directory } : {}),
    ...(over.scope ? { scope: over.scope } : {}),
    ...(over.runner ? { runner: over.runner } : {}),
    ...(over.artifacts ? { artifacts: over.artifacts } : {}),
    ...(over.newId ? { newId: over.newId } : {}),
  });
  return { collab, events, clock: clock ?? new Clock(0), provider, seen };
}

export async function projectWithAgents(
  h: Harness,
  agents = ["lead", "worker", "spec"],
  settings?: Partial<CollabSettings>,
): Promise<Project> {
  const p = h.collab.createProject(owner(), { name: "alpha", ...(settings ? { settings } : {}) });
  for (const a of agents) h.collab.addAgent(owner(), p.id, a);
  return h.collab.getProject(owner(), p.id);
}

export function wait(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { ChatProvider };
