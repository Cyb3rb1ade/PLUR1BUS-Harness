// The harness's metric set (D3). Everything here is a number or a member of a closed enumeration: no agent name,
// user, path, host, model or error text is ever a label (see registry.ts for how that is enforced).
import { METHODS_BY_SERVER } from "@plur1bus/rpc-schema";
import { createRegistry } from "./registry.ts";

/** Result classes of an RPC call: `ok` or the error code folded into a stable class. */
const RESULT_BY_CODE: Readonly<Record<string, string>> = {
  ok: "ok",
  E_INVALID_PARAMS: "invalid_params",
  E_UNAUTHORIZED: "unauthorized", E_DENIED: "unauthorized", E_APPROVAL_REQUIRED: "unauthorized",
  E_NOT_FOUND: "not_found", E_AGENT_UNKNOWN: "not_found", E_MODULE_UNKNOWN: "not_found",
  E_NOT_AVAILABLE: "unavailable", E_CORE_UNAVAILABLE: "unavailable", E_LOCKED: "unavailable",
  E_INTERNAL: "internal", E_STORAGE: "internal", E_CONFIG_INVALID: "internal",
};
const RESULTS = [...new Set(Object.values(RESULT_BY_CODE))];
/** Series bound of plur1bus_rpc_calls_total: every core method plus the `other` fold, times every result class plus `other`.
 *  Derived from the schema, so adding RPC methods never trips the per-metric cap in registry.ts. */
export const RPC_CALLS_MAX_SERIES = (METHODS_BY_SERVER.core.length + 1) * (RESULTS.length + 1);
/** The most series one process can expose: a regression guard for the label enumerations (RPC bound plus 1000 for everything else). */
export const MAX_TOTAL_SERIES = RPC_CALLS_MAX_SERIES + 1000;
/** Provider and failure-kind enumerations. A new provider adapter adds its id here, nowhere else. */
export const PROVIDERS = ["openai", "anthropic", "google", "openrouter", "ollama", "openai_compatible"] as const;
export const PROVIDER_ERROR_KINDS = ["auth", "rate_limit", "timeout", "server", "invalid_request", "network"] as const;
export const TURN_OUTCOMES = ["ok", "error", "aborted"] as const;
const TURN_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120] as const;

export interface HealthSnapshot { ready: boolean; journalBacklog: number; agents: number; uptimeSeconds: number }
export interface MetricsOptions {
  /** Open RPC connections now. */
  connections: () => number;
  /** Process memory (default `process.memoryUsage`); a seam for tests. */
  memoryUsage?: () => { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
  /** Core readiness and a few counts, read at scrape time (default: not ready, zeros). */
  health?: () => HealthSnapshot;
}

export interface Metrics {
  /** One finished RPC call: `result` is `ok` or the RPC error code; both are folded into enumerations. */
  rpcCall(method: string, result: string): void;
  /** One finished chat turn, `seconds` long. */
  turn(seconds: number, outcome: string): void;
  /** One failed provider call. */
  providerError(provider: string, kind: string): void;
  render(): string;
}

export function createMetrics(o: MetricsOptions): Metrics {
  const r = createRegistry();
  const mem = o.memoryUsage ?? (() => process.memoryUsage());
  const health = o.health ?? (() => ({ ready: false, journalBacklog: 0, agents: 0, uptimeSeconds: 0 }));

  const rpc = r.counter("plur1bus_rpc_calls_total", "RPC calls handled by the core, by method and result class.", { method: METHODS_BY_SERVER.core, result: RESULTS }, { maxSeries: RPC_CALLS_MAX_SERIES });
  const turns = r.histogram("plur1bus_turn_duration_seconds", "Duration of chat turns, by outcome.", { outcome: TURN_OUTCOMES }, TURN_BUCKETS);
  const provErrors = r.counter("plur1bus_provider_errors_total", "Failed provider calls, by provider and failure kind.", { provider: PROVIDERS, kind: PROVIDER_ERROR_KINDS });
  turns.initAll(); provErrors.initAll();

  r.gaugeFn("plur1bus_process_resident_memory_bytes", "Resident set size of the core process.", () => mem().rss);
  r.gaugeFn("plur1bus_process_heap_used_bytes", "V8 heap in use.", () => mem().heapUsed);
  r.gaugeFn("plur1bus_process_heap_total_bytes", "V8 heap reserved.", () => mem().heapTotal);
  r.gaugeFn("plur1bus_process_external_memory_bytes", "Memory of C++ objects bound to JavaScript objects.", () => mem().external);
  r.gaugeFn("plur1bus_process_array_buffers_bytes", "Memory of ArrayBuffers and Buffers.", () => mem().arrayBuffers);
  r.gaugeFn("plur1bus_rpc_connections_open", "Open RPC connections.", () => o.connections());
  r.gaugeFn("plur1bus_engine_ready", "1 when the core is ready and the memory engine reports no degradation, else 0.", () => (health().ready ? 1 : 0));
  r.gaugeFn("plur1bus_journal_backlog_entries", "Capture journal entries not yet stored.", () => health().journalBacklog);
  r.gaugeFn("plur1bus_agents", "Number of configured agents (a count, never names).", () => health().agents);
  r.gaugeFn("plur1bus_core_uptime_seconds", "Seconds since the core started.", () => health().uptimeSeconds);

  return {
    rpcCall(method, result) { rpc.inc({ method, result: RESULT_BY_CODE[result] ?? "other" }); },
    turn(seconds, outcome) { turns.observe({ outcome: (TURN_OUTCOMES as readonly string[]).includes(outcome) ? outcome : "error" }, seconds); },
    providerError(provider, kind) { provErrors.inc({ provider, kind }); },
    render: () => r.render(),
  };
}
