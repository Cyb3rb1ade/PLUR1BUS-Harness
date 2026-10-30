// The harness's metric set (D3). Everything here is a number or a member of a closed enumeration: no agent name,
// user, path, host, model or error text is ever a label (see registry.ts for how that is enforced).
import { METHODS_BY_SERVER } from "@plur1bus/rpc-schema";
import { createRegistry } from "./registry.ts";
import { INBOX_KINDS } from "../inbox/store.ts";
import {
  createTurnTelemetryAggregate, TOOL_CHOICE_STATUSES, TOOL_NEED_REASONS, TURN_END_REASONS,
  type TurnTelemetry, type TurnTelemetrySummary,
} from "../session/turn-telemetry.ts";

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
  /** One inbox entry created; `kind` is the closed InboxKind set and the only label. */
  inboxPublished(kind: string): void;
  /** One finished chat turn, `seconds` long. */
  turn(seconds: number, outcome: string): void;
  /** One final per-turn tool/skill observation, without agent, tool, skill or error-text labels. */
  turnTelemetry(telemetry: TurnTelemetry): void;
  /** Lifetime tool-use counters and bounded recent triage p50/p95, suitable for the doctor report. */
  turnTelemetrySummary(): TurnTelemetrySummary;
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
  const inbox = r.counter("plur1bus_inbox_entries_total", "Inbox entries created, by kind.", { kind: INBOX_KINDS });
  const aggregate = createTurnTelemetryAggregate();
  const rounds = r.counter("plur1bus_turn_rounds_total", "Model rounds in finished turns.", {});
  const toolCalls = r.counter("plur1bus_turn_tool_calls_total", "Real and meta tool calls in finished turns.", {
    kind: ["real", "search", "skill_load", "skill_read"],
  });
  const skills = r.counter("plur1bus_turn_skills_total", "Injected and loaded skills in finished turns.", {
    kind: ["injected", "loaded"],
  });
  const toolChoice = r.counter("plur1bus_turn_tool_choice_total", "Tool-choice status observed in finished turns.", {
    status: TOOL_CHOICE_STATUSES,
  });
  const forced = r.counter("plur1bus_turn_tool_choice_forced_total", "Turns that forced tool choice.", {});
  const toolNeed = r.counter("plur1bus_turn_tool_need_total", "Recognized tool need, by bounded reason.", {
    reason: [...TOOL_NEED_REASONS, "none"],
  });
  const unused = r.counter("plur1bus_turn_needed_tool_unused_total", "Turns needing a tool without a real tool call.", {});
  const toolErrors = r.counter("plur1bus_turn_tool_errors_returned_total", "Tool errors returned to the model.", {});
  const end = r.counter("plur1bus_turn_end_total", "Finished turns by termination reason.", {
    reason: TURN_END_REASONS,
  });
  const triage = r.histogram("plur1bus_turn_triage_duration_seconds", "Triage duration in finished turns.", {},
    [0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2.5, 5]);
  turns.initAll(); provErrors.initAll(); inbox.initAll();
  for (const metric of [rounds, toolCalls, skills, toolChoice, forced, toolNeed, unused, toolErrors, end, triage]) {
    metric.initAll();
  }

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
    inboxPublished(kind) { if ((INBOX_KINDS as readonly string[]).includes(kind)) inbox.inc({ kind }); },
    rpcCall(method, result) { rpc.inc({ method, result: RESULT_BY_CODE[result] ?? "other" }); },
    turn(seconds, outcome) { turns.observe({ outcome: (TURN_OUTCOMES as readonly string[]).includes(outcome) ? outcome : "error" }, seconds); },
    turnTelemetry(t) {
      aggregate.observe(t);
      rounds.inc({}, t.rounds);
      toolCalls.inc({ kind: "real" }, t.toolCalls);
      toolCalls.inc({ kind: "search" }, t.metaCalls.search);
      toolCalls.inc({ kind: "skill_load" }, t.metaCalls.skillLoad);
      toolCalls.inc({ kind: "skill_read" }, t.metaCalls.skillRead);
      skills.inc({ kind: "injected" }, t.skills.injected);
      skills.inc({ kind: "loaded" }, t.skills.loaded);
      toolChoice.inc({ status: t.toolChoice.status });
      if (t.toolChoice.forced) forced.inc();
      if (t.toolNeed.detected) {
        const reasons = [...new Set(t.toolNeed.reasons)];
        for (const reason of reasons.length ? reasons : ["other"]) toolNeed.inc({ reason });
        if (t.toolCalls === 0) unused.inc();
      } else toolNeed.inc({ reason: "none" });
      toolErrors.inc({}, t.errorsReturned);
      end.inc({ reason: t.endReason });
      if (t.triageDurationMs !== null) triage.observe({}, t.triageDurationMs / 1000);
    },
    turnTelemetrySummary: () => aggregate.snapshot(),
    providerError(provider, kind) { provErrors.inc({ provider, kind }); },
    render: () => r.render(),
  };
}
