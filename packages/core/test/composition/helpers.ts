// Shared helpers for the composition tests (new file, composition tests only).
import { afterEach } from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineRecord } from "../../src/composition/trace.ts";

/** Seeded PRNG (mulberry32): the only source of randomness in these tests. The seed is part of every failure message. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Registers an afterEach hook in the calling scope; every directory made through `make()` is removed after each test. */
export function useTempDirs(prefix = "p1b-composition-") {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { make(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); made.push(dir); return dir; } };
}

export function recordingLog() {
  const records: PipelineRecord[] = [];
  return { records, log: (r: PipelineRecord) => { records.push({ ...r }); } };
}

/** The exact title of a documented-behaviour deviation: used as test name and as the `todo` reason. */
export function gap(fn: string, expected: string, actual: string): string {
  return `KNOWN GAP: core/composition ${fn}: erwartet ${expected}, tatsächlich ${actual}`;
}

/** A recording stand-in for the audited secret service (only the calls the composition layer makes). */
export function fakeSecretService(values: Record<string, string> = {}) {
  const leases: { principal: unknown; ref: string; options: unknown }[] = [];
  const revoked: string[] = [];
  let n = 0;
  const service = {
    async lease(principal: unknown, ref: string, options: unknown) {
      leases.push({ principal, ref, options });
      if (!(ref in values)) throw Object.assign(new Error("no such secret"), { code: "not-found" });
      return { leaseId: `lease-${++n}`, value: values[ref]! };
    },
    revokeLease(_principal: unknown, id: string) { revoked.push(id); },
    async set() { throw new Error("not used"); },
    async delete() { throw new Error("not used"); },
  };
  return { service: service as never, leases, revoked };
}

/** An egress stand-in that records the URLs it was asked about and answers from a fixed rule. */
export function fakeEgress(allow: (url: string) => boolean = () => true) {
  const asked: string[] = [];
  const egress = {
    async decide(url: string) {
      asked.push(url);
      return allow(url) ? { allowed: true as const, host: new URL(url).hostname, port: 443, address: "192.0.2.10", family: 4 as const } : { allowed: false as const, reason: "host-not-allowed", message: "no" };
    },
    async request() { throw new Error("not used"); },
    status() { throw new Error("not used"); },
  };
  return { egress: egress as never, asked };
}

// ---- turn provider fixture -------------------------------------------------------------------------------------------
import { join as joinPath } from "node:path";
import { createCallBudget, type CallBudget } from "../../src/budget/index.ts";
import { ToolRegistry, type ToolDef } from "../../src/tools/registry.ts";
import { createTurnProvider, type TurnProviderOptions } from "../../src/composition/provider.ts";
import type { StreamingAdapter, ChatRequest as WireRequest, ChatResult } from "../../../providers/src/index.ts";
import type { ChatChunk, ChatRequest } from "../../src/session/provider.ts";

export type ScriptedCall = { id: string; name: string; args: Record<string, unknown>; raw?: string };
export type ScriptedRound = { text?: string; streamed?: string[]; calls?: ScriptedCall[]; usage?: { inputTokens: number; outputTokens: number }; reasoning?: string };

/** An adapter that answers round N with `rounds[N]` (the last round repeats) and records every wire request it was given. */
export function scriptedAdapter(rounds: ScriptedRound[]) {
  const requests: WireRequest[] = [];
  const adapter: StreamingAdapter = {
    async *stream(request) {
      const round = rounds[Math.min(requests.length, rounds.length - 1)]!;
      requests.push(request);
      for (const piece of round.streamed ?? (round.text ? [round.text] : [])) yield { type: "text_delta", text: piece };
      const calls = round.calls ?? [];
      const result = { text: round.text ?? "", ...(round.reasoning ? { reasoning: round.reasoning } : {}), toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args, argumentsRaw: c.raw ?? JSON.stringify(c.args) })), finishReason: calls.length ? "tool_calls" : "stop", rawFinishReason: "stop", usage: round.usage ?? { inputTokens: 10, outputTokens: 2 }, meta: {} } as unknown as ChatResult;
      yield { type: "done", result };
    },
  };
  return { adapter, requests };
}

export const readTool = (name: string, execute: (args: unknown) => Promise<unknown>, over: Partial<ToolDef> = {}): ToolDef => ({
  name, description: `Tool ${name}`, inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] },
  capability: "fs.read", effect: "read", risk: "low", classify: () => ({ flags: { outsideRoots: false, denyListHit: false } }), execute: async (args) => execute(args), ...over,
});

export const TURN_PRINCIPAL = "user:v2:" + "a".repeat(64);
export const turnRequest = (over: Partial<ChatRequest> = {}): ChatRequest => ({ sessionId: "s1", turnId: "t1", agentId: "a1", principal: TURN_PRINCIPAL, summaries: [], memory: "recalled fact", messages: [{ role: "user", text: "please read the file" }], signal: new AbortController().signal, ...over });

export function turnFixture(adapter: StreamingAdapter, extra: Partial<TurnProviderOptions> = {}, dir?: string) {
  const home = dir ?? (() => { throw new Error("pass a temp dir"); })();
  const budget: CallBudget = createCallBudget({ path: joinPath(home, "budget.sqlite"), clock: { now: () => Date.UTC(2026, 9, 12) }, emitter: { emit() { /* ignored */ } } });
  const registry = new ToolRegistry();
  const logs: Record<string, unknown>[] = [];
  const stored: unknown[] = [];
  const provider = createTurnProvider({
    registry, budget, profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter }] },
    approval: { request: async () => ({ approved: false }) }, grants: { get: () => undefined, list: () => [] },
    log: (r) => logs.push({ ...r }), resultStore: { put: async (v) => { stored.push(v); return `result:${stored.length}`; } }, ...extra,
  });
  return { provider, registry, budget, logs, stored, close: () => budget.close() };
}

export async function collect(provider: { stream(r: ChatRequest): AsyncIterable<ChatChunk> }, request: ChatRequest = turnRequest()): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of provider.stream(request)) out.push(c);
  return out;
}
