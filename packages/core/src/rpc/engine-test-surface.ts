import { AsyncLocalStorage } from "node:async_hooks";
import type { EmbeddingService } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { Handler } from "./server.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { RpcError } from "./errors.ts";

export type EngineTestRole = "embedder" | "reranker" | "captioner";
type ErrorClass = "egress" | "key" | "download" | "provider" | "timeout" | "unsupported";
const classes = new Set<ErrorClass>(["egress", "key", "download", "provider"]);
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
// Never forward exception messages, URLs, provider payloads or secret-store details to the caller.
function failureClass(error: unknown): ErrorClass {
  let e = error;
  for (let depth = 0; depth < 5 && e; depth++) {
    const item = record(e);
    if (classes.has(item.errorClass as ErrorClass)) return item.errorClass as ErrorClass;
    if (item.error === "E_EGRESS_DENIED") return "egress";
    if (["E_SECRET_NOT_FOUND", "E_SECRET_LOCKED", "E_SECRET_DENIED"].includes(String(item.error))) return "key";
    e = item.cause;
  }
  return "provider";
}
function modelName(v: unknown): string | undefined {
  // Identifiers only. A misconfigured URL/query/credential must not become diagnostic output.
  return typeof v === "string" && /^[\w./:@+ -]{1,256}$/.test(v) && !v.includes("://") ? v : undefined;
}
function rerankerModel(config: Record<string, unknown>): string | undefined {
  const rer = record(config.reranker), provider = String(rer.provider ?? "local-transformers");
  return modelName(record(rer[provider === "local-transformers" ? "local" : provider]).model ?? rer.model);
}

/** Fixed small inputs, current Engine role configuration, no memory/session writes. */
export function buildEngineTestSurface(d: {
  embedding: Pick<EmbeddingService, "identities" | "embed" | "rerank">;
  config(): Record<string, unknown>;
  /** Internal test injection only; never a client-controlled deadline. */
  timeoutMs?: number;
  diagnostics?: ReturnType<typeof createEngineTestDiagnostics>;
}): Record<string, Handler> {
  return { "admin.engine.test": async (p, ctx) => {
    const who = authenticatedPrincipal(ctx);
    if (who.kind !== "person" || !["owner", "admin"].includes(who.role)) throw new RpcError("E_DENIED", "engine test requires Owner/Admin");
    const role = p.role as EngineTestRole;
    const start = performance.now();
    const duration = () => Math.max(0, Math.round(performance.now() - start));
    if (role === "captioner" || (role === "reranker" && record(d.config().reranker).enabled === false)) return { role, ok: false, durationMs: duration(), errorClass: "unsupported" };
    const deadline = new AbortController();
    const signal = AbortSignal.any([ctx.signal, deadline.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let model: string | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      timer = setTimeout(() => deadline.abort(new Error("engine test deadline")), Math.min(10_000, Math.max(1, d.timeoutMs ?? 10_000)));
      const run = async () => {
        signal.throwIfAborted();
        if (role === "embedder") {
          const identity = d.embedding.identities()[0];
          if (!identity) throw new Error("embedding identity unavailable");
          model = modelName(identity.model);
          const vectors = await d.embedding.embed([`PLUR1BUS engine test ${crypto.randomUUID()}`], { kind: "query", identity, signal });
          const v = vectors[0];
          if (vectors.length !== 1 || !v || v.length !== identity.dimensions || !v.length || !Array.from(v).every(Number.isFinite)) throw new Error("invalid embedding");
          return { role, ok: true, durationMs: duration(), ...(model ? { model } : {}), dimensions: v.length };
        }
        model = rerankerModel(d.config());
        const hits = await d.embedding.rerank("A small model test", ["A small model test", "An unrelated document"], { topN: 1, signal });
        // Engine 1.15 runtime emits relevance_score; its public declaration still names score.
        if (!hits.length || hits.length > 1 || !hits.every(h => Number.isInteger(h.index) && h.index >= 0 && h.index < 2 && Number.isFinite(h.score ?? record(h).relevance_score))) throw new Error("invalid rerank result");
        return { role, ok: true, durationMs: duration(), ...(model ? { model } : {}) };
      };
      return await Promise.race([d.diagnostics ? d.diagnostics.run(run) : run(), aborted]);
    } catch (e) {
      return { role, ok: false, durationMs: duration(), ...(model ? { model } : {}), errorClass: signal.aborted ? "timeout" : failureClass(e) };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  } };
}

/** Carry host-port failures through providers that replace exception causes, isolated from other engine work. */
export function createEngineTestDiagnostics() {
  const context = new AsyncLocalStorage<{ failure?: ErrorClass }>();
  return {
    observe(failure: { errorClass: string }): void {
      const current = context.getStore();
      if (current && classes.has(failure.errorClass as ErrorClass)) current.failure = failure.errorClass as ErrorClass;
    },
    run<T>(operation: () => Promise<T>): Promise<T> {
      return context.run({}, async () => {
        try { return await operation(); }
        catch (error) {
          const failure = context.getStore()?.failure;
          if (failure) throw Object.assign(new Error("engine port failure"), { errorClass: failure });
          throw error;
        }
      });
    },
  };
}
