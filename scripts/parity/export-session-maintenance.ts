// Parity vectors (mode V) for the session upkeep services (P4-K K5b, plan P4-40): context fit, compaction, pruning and the
// summarizer of `packages/core/src/session/`. The real `Compactor`, `ToolPruner` and `createLlmSummarizer` run over a real
// `sessions.sqlite` with a scripted clock, scripted ids, a scripted `performance.now` and scripted ports (summary model,
// pre-swap checkpoint, Laya decider, provider stream); every op's answer, every call a port received, every event and error
// the services reported, and the stored rows after it are recorded. `crates/plur1bus-core/src/sessions/maintenance_vectors.rs`
// replays every scenario and must give the same answers. Recorded, never edited by hand.
//
// A scenario is `{ name, ops }`. Base ops (`create`, `begin`, `complete`, `append`, ...) are those of `export-sessions.ts`;
// `during` lists base ops a port runs while it "awaits" (another task writing), which is how the stale-revision checks are hit.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-session-maintenance.ts [--check]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";
import { SessionStore } from "../../packages/core/src/session/store.ts";
import { SessionError } from "../../packages/core/src/session/types.ts";
import { Compactor, defaultCompaction, digest, estimateTokens, fitTail, truncateWithPointer } from "../../packages/core/src/session/compaction.ts";
import { ToolPruner, defaultPrune, hiddenToolOutputs, DEFAULT_PRUNE_CONFIDENCE } from "../../packages/core/src/session/pruning.ts";
import { createLlmSummarizer } from "../../packages/core/src/session/summarizer.ts";
import { APPLE_FM_CONTEXT_WINDOW, MIN_CONTEXT_AGENT_ROLE, assertContextFit, assertRoleContext, contextCost } from "../../packages/core/src/session/context-fit.ts";

type Op = Record<string, any>;
const errOf = (e: unknown) => e instanceof SessionError
  ? { code: e.code, ...(e.reason !== undefined ? { reason: e.reason } : {}), message: e.message }
  : (e as any)?.message === "invalid compaction config" || (e as any)?.message === "invalid prune config"
    ? { name: "Error", message: (e as any).message }
    : { name: String((e as any)?.name ?? "Error") };

/** One scenario over a fresh file, with the services on top. */
async function run(name: string, ops: Op[]) {
  const dir = mkdtempSync(join(tmpdir(), "p4k-maintenance-"));
  const path = join(dir, "sessions.sqlite");
  let now = 1_000_000, n = 0, lastTurn = "", lastSession = "";
  const store = new SessionStore({ path, clock: () => now, newId: (p) => `${p}_${++n}` });
  const log: unknown[] = [];
  const mono = { v: 0 };
  let compactor: Compactor | null = null, pruner: ToolPruner | null = null, abort: AbortController | null = null;
  const realPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance")!;
  Object.defineProperty(globalThis, "performance", { value: { now: () => mono.v }, configurable: true, writable: true });
  const steps: unknown[] = [];

  /** The base ops: what `export-sessions.ts` records for them, with the same answer shapes. */
  const base = (op: Op): any => {
    const s = store;
    switch (op.op) {
      case "create": { const r = s.createSession(op.input); lastSession = r.id; return r; }
      case "begin": { const b = s.beginTurn(op.sessionId, op.text, op.tokens, op.options ?? {}); lastTurn = b.turn.id; return b; }
      case "complete": return s.completeTurn(op.turnId, op.input);
      case "fail": return s.failTurn(op.turnId, op.error, op.data);
      case "append": return s.appendEvent(op.turnId, op.type, op.data);
      case "advance": now += op.ms; return now;
      case "addSummary": return s.addSummary(op.summary);
      case "setVisibility": return s.setToolVisibility(op.sessionId, op.ref, op.hidden, op.reason, op.detail) ?? null;
      case "setVisibilities": return s.setToolVisibilities(op.sessionId, op.changes) ?? null;
      case "recordUsage": return s.recordMessageUsage(op.id, op.model, op.tokens) ?? null;
      case "setTokenFactor": return s.setTokenFactor(op.model, op.factor) ?? null;
      case "tokenFactor": return s.tokenFactor(op.model);
      case "rewind": return s.rewindPath(op.sessionId, { toSeq: op.to, lesson: op.lesson, actor: op.actor, trigger: op.trigger });
      case "messages": return s.listMessages(op.sessionId, op.query ?? {});
      case "summaries": return s.listSummaries(op.sessionId, op.state);
      case "visibility": return s.toolVisibility(op.sessionId);
      case "events": return s.listEvents(op.sessionId, op.after, op.limit);
      case "pruneExplanation": return s.pruneExplanation(op.sessionId);
      case "pruneMetrics": return s.pruneMetrics(op.sessionId);
      case "refetch": return s.recordToolRefetch(op.sessionId, op.ref) ?? null;
      case "lastEventSeq": return s.lastEventSeq(op.sessionId);
      default: throw new Error(`unknown base op ${op.op}`);
    }
  };
  const during = (ops: Op[] | undefined) => { for (const o of ops ?? []) { try { base(scripted(o)); } catch (e) { log.push({ duringError: errOf(e) }); } } };
  const scripted = (o: Op): Op => {
    if (o.turnId === "$turn") o = { ...o, turnId: lastTurn };
    if (o.sessionId === "$ses") o = { ...o, sessionId: lastSession };
    return o;
  };

  const decideOf = (spec: Op) => async (batch: any[], task: string, signal: AbortSignal) => {
    log.push({ decide: { refs: batch.map((p) => p.ref), task } });
    during(spec.during);
    if (spec.bump) mono.v += spec.bump;
    if (spec.abort) abort!.abort();
    switch (spec.kind) {
      case "throw": throw new Error("decider down");
      case "null": return null;
      case "timeout": await new Promise((r) => signal.addEventListener("abort", () => r(undefined), { once: true })); return [];
      case "verdicts": {
        const entries: Op[] = spec.entries;
        let out: any[] = batch.map((p, i) => ({ ref: p.ref, ...entries[Math.min(i, entries.length - 1)] }));
        switch (spec.shape ?? "ok") {
          case "short": out = out.slice(0, -1); break;
          case "dup": if (out.length > 1) out[1] = { ...out[1], ref: out[0].ref }; break;
          case "null-element": out[0] = null; break;
          case "not-array": return { not: "an array" } as any;
          case "unknown-ref": out[0] = { ...out[0], ref: "event:nope" }; break;
          case "numeric-ref": out[0] = { ...out[0], ref: 7 }; break;
          case "primitive": out[0] = "text"; break;
          default: break;
        }
        return out;
      }
      default: throw new Error(`unknown decider ${spec.kind}`);
    }
  };

  const pruneHooks = (spec: Op) => ({
    ...(spec.decide ? { decide: decideOf(spec.decide) } : {}),
    ...(spec.minConfidence !== undefined ? { minConfidence: () => spec.minConfidence } : {}),
    ...(spec.abortable ? { signal: (abort = new AbortController()).signal } : {}),
    emit: (type: string, attrs: Record<string, unknown>) => { log.push({ emit: type, attrs }); },
  });

  const build = (op: Op) => {
    const cfg = { ...defaultCompaction(op.cfg.windowTokens), ...op.cfg };
    const hooks: Record<string, unknown> = {
      emit: (type: string, attrs: Record<string, unknown>) => { log.push({ emit: type, attrs }); },
      onError: (what: string, err: any) => { log.push({ error: what, message: String(err?.message ?? err) }); },
    };
    const h = op.hooks ?? {};
    if (h.summarizer) hooks.summarizer = async (messages: any[], maxTokens: number, sessionId?: string, caller?: unknown) => {
      log.push({ summarize: { messages: messages.map((m) => ({ role: m.role, text: m.text, seq: m.seq })), maxTokens, sessionId, caller } });
      during(h.summarizer.during);
      if (h.summarizer.kind === "throw") throw new Error(h.summarizer.message);
      return h.summarizer.text;
    };
    if (h.beforeSwap) hooks.beforeSwap = async (info: unknown) => {
      log.push({ beforeSwap: info });
      during(h.beforeSwap.during);
      if (h.beforeSwap.kind === "throw") throw new Error("engine down");
      return h.beforeSwap.kind === "skipped" ? "skipped" as const : undefined;
    };
    pruner = null;
    if (h.pruner) {
      pruner = new ToolPruner(store, { ...defaultPrune(), ...(h.pruner.cfg ?? {}) }, pruneHooks(h.pruner) as any);
      hooks.pruner = pruner;
    }
    compactor = new Compactor(store, cfg, hooks as any);
  };

  const step = async (op: Op): Promise<unknown> => {
    switch (op.op) {
      case "compactor": build(op); return null;
      case "pruner": pruner = new ToolPruner(store, { ...defaultPrune(), ...(op.cfg ?? {}) }, pruneHooks(op) as any); return null;
      case "mono": mono.v = op.ms; return mono.v;
      case "configureModel": compactor!.configureModel(op.sessionId, op.model, op.window); return null;
      case "view": return compactor!.view(op.sessionId);
      case "prepare": return await compactor!.prepare(op.sessionId);
      case "afterTurn": return await compactor!.afterTurn(op.sessionId, op.caller);
      case "explain": return compactor!.explain(op.sessionId);
      case "restore": return compactor!.restoreToolRef(op.sessionId, op.ref);
      case "stop": compactor!.stop(); return null;
      case "prune": return await pruner!.run(op.sessionId);
      case "pruneView": return pruner!.view(op.sessionId).map((p) => ({ ref: p.ref, turnId: p.turnId, text: p.text, hidden: p.hidden, restored: p.restored, ...(p.reason !== undefined ? { reason: p.reason } : {}) }));
      case "hiddenOutputs": return hiddenToolOutputs(store, op.sessionId);
      case "limits": return { hard: compactor!.hardLimit, soft: compactor!.softLimit, cfgFor: compactor!.configFor(op.sessionId) };
      case "dump": {
        const sid = op.sessionId;
        return { messages: store.listMessages(sid), summaries: store.listSummaries(sid), visibility: store.toolVisibility(sid), explanation: store.pruneExplanation(sid), metrics: store.pruneMetrics(sid), events: store.listEvents(sid, 0, 1000).filter((e) => e.type === "compaction.prune") };
      }
      default: return base(op);
    }
  };

  try {
    for (const raw of ops) {
      const op = scripted(raw);
      let out: Op;
      try { out = { ok: await step(op) }; } catch (e) { out = { err: errOf(e) }; }
      steps.push({ op: raw, ...out, log: log.splice(0) });
    }
  } finally {
    Object.defineProperty(globalThis, "performance", realPerformance);
    try { store.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
  return { name, ops: steps };
}

// ---- builders --------------------------------------------------------------------------------------------------------

const direct = (over: Op = {}) => ({ op: "create", input: { kind: "direct", agentId: "bernd", owner: "user:v1:alice", ...over } });
const tokensOf = (t: string) => Math.ceil(t.length / 4);
/** One completed turn: the user text, optional tool pairs, the assistant text. */
function turn(user: string, assistant: string, tools: { id: string; name: string; args?: unknown; output: string; isError?: boolean }[] = [], sid = "ses_1"): Op[] {
  return [
    { op: "begin", sessionId: sid, text: user, tokens: tokensOf(user) },
    ...tools.flatMap((t) => [
      { op: "append", turnId: "$turn", type: "tool.call", data: { id: t.id, name: t.name, ...(t.args !== undefined ? { args: t.args } : {}) } },
      { op: "append", turnId: "$turn", type: "tool.result", data: { id: t.id, output: t.output, ...(t.isError !== undefined ? { isError: t.isError } : {}) } },
    ]),
    { op: "complete", turnId: "$turn", input: { text: assistant, tokens: tokensOf(assistant) } },
  ];
}
const fill = (turns: number, chars: (i: number) => number, sid = "ses_1"): Op[] =>
  Array.from({ length: turns }, (_, i) => turn(`q${i} ` + "x".repeat(chars(i)), `a${i} ` + "y".repeat(chars(i)), [], sid)).flat();
/** A text of exactly `tokens` estimated tokens (4 units each). */
const sized = (tokens: number, c = "x") => c.repeat(tokens * 4);
const cfgOf = (windowTokens: number, over: Op = {}) => ({ windowTokens, maxMessageTokens: 100_000, ...over });
const compactor = (windowTokens: number, over: Op = {}, hooks: Op = {}) => ({ op: "compactor", cfg: cfgOf(windowTokens, over), hooks });
const dump = (sid = "ses_1") => ({ op: "dump", sessionId: sid });
const sid = "ses_1";

// ---- compaction ------------------------------------------------------------------------------------------------------

async function compactionScenarios() {
  const out: unknown[] = [];
  out.push(await run("view-basic", [
    direct(), compactor(8192), ...fill(3, () => 40),
    { op: "view", sessionId: sid }, { op: "limits", sessionId: sid }, { op: "afterTurn", sessionId: sid }, { op: "explain", sessionId: sid },
    ...turn("go on", "ok"), { op: "begin", sessionId: sid, text: "newest", tokens: 2 }, { op: "prepare", sessionId: sid }, dump(),
  ]));
  out.push(await run("config-validation", [
    compactor(1000), { op: "limits", sessionId: "x" },
    compactor(0), compactor(-5), compactor(1000, { softRatio: 0.9, hardRatio: 0.8 }), compactor(1000, { softRatio: 0.8, hardRatio: 0.8 }),
    compactor(1000, { softRatio: 0, hardRatio: 0.5 }), compactor(1000, { hardRatio: 1 }), compactor(1000, { hardRatio: 0.99 }),
    compactor(1000, { softRatio: 0.0001 }), compactor(1000, { maxMessageTokens: -1 }), compactor(1000, { maxMessageTokens: 0 }),
    compactor(1000, { summaryMaxTokens: -1 }), compactor(1000, { summaryMaxTokens: 0 }), compactor(999), { op: "limits", sessionId: "x" },
    compactor(7, { softRatio: 0.65, hardRatio: 0.88 }), { op: "limits", sessionId: "x" }, compactor(3), { op: "limits", sessionId: "x" },
  ]));
  // The clip bound of one message: exactly at the bound, one unit over, at a surrogate pair, and a bound of zero.
  out.push(await run("clip-boundary", [
    direct(), compactor(100_000, { maxMessageTokens: 10 }),
    ...turn("x".repeat(40), "y".repeat(41)), ...turn("\u{1F600}".repeat(21), "z".repeat(39) + "\u{1F600}"), ...turn("ü".repeat(160), "ü".repeat(161)),
    { op: "view", sessionId: sid },
    compactor(100_000, { maxMessageTokens: 0 }), { op: "view", sessionId: sid },
    compactor(100_000, { maxMessageTokens: 1 }), { op: "view", sessionId: sid },
    compactor(100_000, { maxMessageTokens: 3 }), { op: "view", sessionId: sid },
  ]));
  // The hard limit: window 1000 gives 880. Exactly at it nothing happens; one over, with one turn only, clips the newest.
  for (const delta of [-1, 0, 1]) {
    out.push(await run(`hard-boundary-${delta}`, [
      direct(), compactor(1000, {}, { beforeSwap: { kind: "done" } }),
      { op: "begin", sessionId: sid, text: sized(880 + delta), tokens: 880 + delta }, { op: "prepare", sessionId: sid }, dump(),
    ]));
  }
  // Two completed turns and a new message: the swap happens one token over the limit, not at it.
  for (const delta of [0, 1]) {
    out.push(await run(`hard-swap-boundary-${delta}`, [
      direct(), compactor(1000, {}, { beforeSwap: { kind: "done" } }),
      ...turn(sized(300), sized(300, "y")), { op: "begin", sessionId: sid, text: sized(280 + delta, "u"), tokens: 280 + delta },
      { op: "prepare", sessionId: sid }, { op: "afterTurn", sessionId: sid }, dump(),
    ]));
  }
  // The soft limit (650) and the segment target (325): the cut stops as soon as the rest fits the target, not one turn later.
  for (const [total, first] of [[650, 326], [651, 326], [651, 325], [651, 327], [700, 100], [1500, 10]]) {
    const rest = total - first, second = Math.floor(rest / 2);
    out.push(await run(`soft-boundary-${total}-${first}`, [
      direct(), compactor(1000, {}),
      ...turn(sized(first / 2 | 0), sized(first - (first / 2 | 0), "y")),
      ...turn(sized(second >> 1), sized(second - (second >> 1), "y")),
      ...turn(sized((rest - second) >> 1), sized((rest - second) - ((rest - second) >> 1), "y")),
      { op: "view", sessionId: sid }, { op: "afterTurn", sessionId: sid }, { op: "summaries", sessionId: sid }, { op: "afterTurn", sessionId: sid },
    ]));
  }
  // Swaps: checkpoint answers, a prepared summary reused, the tier merge, the stale checks.
  out.push(await run("swap-and-tiers", [
    direct(), compactor(600, {}, { beforeSwap: { kind: "done" } }),
    ...fill(12, () => 300), { op: "begin", sessionId: sid, text: "newest question", tokens: 4 },
    { op: "prepare", sessionId: sid }, { op: "summaries", sessionId: sid },
    { op: "complete", turnId: "$turn", input: { text: "reply", tokens: 2 } },
    ...fill(12, () => 300), { op: "begin", sessionId: sid, text: "another question", tokens: 4 },
    { op: "prepare", sessionId: sid }, { op: "summaries", sessionId: sid },
    { op: "complete", turnId: "$turn", input: { text: "reply", tokens: 2 } },
    ...fill(12, () => 250), { op: "begin", sessionId: sid, text: "third", tokens: 2 }, { op: "prepare", sessionId: sid }, { op: "summaries", sessionId: sid },
  ]));
  for (const [label, kind] of [["skipped", "skipped"], ["throws", "throw"]] as const) {
    out.push(await run(`checkpoint-${label}`, [
      direct(), compactor(600, {}, { beforeSwap: { kind } }), ...fill(12, () => 300), { op: "begin", sessionId: sid, text: "q", tokens: 1 },
      { op: "prepare", sessionId: sid }, { op: "summaries", sessionId: sid },
    ]));
  }
  out.push(await run("swap-stale-during-checkpoint", [
    direct(), compactor(600, {}, { beforeSwap: { kind: "done", during: [{ op: "append", turnId: "$turn", type: "delta", data: { text: "late" } }] } }),
    ...fill(12, () => 300), { op: "begin", sessionId: sid, text: "q", tokens: 1 }, { op: "prepare", sessionId: sid }, { op: "summaries", sessionId: sid },
  ]));
  out.push(await run("no-hooks-no-checkpoint", [
    direct(), compactor(600), ...fill(12, () => 300), { op: "begin", sessionId: sid, text: "q", tokens: 1 }, { op: "prepare", sessionId: sid },
  ]));
  out.push(await run("prepared-then-swap", [
    direct(), compactor(1000, {}, { beforeSwap: { kind: "done" } }), ...fill(6, () => 400),
    { op: "view", sessionId: sid }, { op: "afterTurn", sessionId: sid }, { op: "summaries", sessionId: sid, state: "prepared" }, { op: "afterTurn", sessionId: sid },
    { op: "begin", sessionId: sid, text: "go", tokens: 1 }, { op: "prepare", sessionId: sid }, { op: "summaries", sessionId: sid }, dump(),
  ]));
  // The summary model: its text, an error, "digest" mode, an empty or oversize answer, a stale revision, a caller.
  const summaryHook = (over: Op) => ({ summarizer: { kind: "fixed", text: "LLM SUMMARY\nline two", ...over } });
  for (const [label, hooks, cfg] of [
    ["fixed", summaryHook({}), {}], ["throws", summaryHook({ kind: "throw", message: "model down" }), {}], ["digest-mode", summaryHook({}), { summarizer: "digest" }],
    ["empty", summaryHook({ text: "" }), {}], ["oversize", summaryHook({ text: Array.from({ length: 80 }, (_, i) => `line ${i} ${"z".repeat(30)}`).join("\n") }), {}],
    ["stale", summaryHook({ during: [{ op: "begin", sessionId: sid, text: "late user", tokens: 2 }] }), {}],
    ["llm-mode", summaryHook({}), { summarizer: "llm" }],
  ] as const) {
    out.push(await run(`summary-${label}`, [
      direct(), compactor(1000, cfg as Op, hooks as Op), ...fill(6, () => 400),
      { op: "afterTurn", sessionId: sid, caller: { kind: "cli", uid: 501 } }, { op: "summaries", sessionId: sid }, { op: "afterTurn", sessionId: sid },
    ]));
  }
  out.push(await run("summary-tier-input", [
    direct(), compactor(1000, {}, { ...summaryHook({ text: "TIER SUMMARY" }), beforeSwap: { kind: "done" } }), ...fill(6, () => 400),
    { op: "afterTurn", sessionId: sid }, { op: "begin", sessionId: sid, text: "go", tokens: 1 }, { op: "prepare", sessionId: sid },
    { op: "complete", turnId: "$turn", input: { text: "ok", tokens: 1 } }, ...fill(6, () => 400), { op: "afterTurn", sessionId: sid }, { op: "summaries", sessionId: sid },
  ]));
  // Measurement against estimate, calibration, per-model windows.
  out.push(await run("measured-usage", [
    direct(), compactor(1000, {}, { beforeSwap: { kind: "done" } }), { op: "configureModel", sessionId: sid, model: "m1" },
    ...turn("short", "short"), { op: "view", sessionId: sid },
    { op: "recordUsage", id: "msg_3", model: "m1", tokens: 700 }, { op: "recordUsage", id: "msg_4", model: "other", tokens: 900 }, { op: "view", sessionId: sid },
    { op: "begin", sessionId: sid, text: "newest", tokens: 2 }, { op: "prepare", sessionId: sid }, dump(),
  ]));
  for (const factor of [0.5, 2, 3.3]) {
    out.push(await run(`factor-${factor}`, [
      direct(), compactor(1000, {}, { ...summaryHook({ text: "S" }) }), { op: "configureModel", sessionId: sid, model: "m1" },
      { op: "setTokenFactor", model: "m1", factor }, ...fill(6, () => 400), { op: "view", sessionId: sid }, { op: "afterTurn", sessionId: sid },
      { op: "begin", sessionId: sid, text: sized(700), tokens: 700 }, { op: "prepare", sessionId: sid }, { op: "summaries", sessionId: sid },
    ]));
  }
  out.push(await run("configure-model", [
    direct(), compactor(8192, {}, {}), { op: "limits", sessionId: sid },
    { op: "configureModel", sessionId: sid, model: "small", window: 1000 }, { op: "limits", sessionId: sid },
    { op: "configureModel", sessionId: sid, model: "big", window: 100_000 }, { op: "limits", sessionId: sid },
    { op: "configureModel", sessionId: sid, model: "zero", window: 0 }, { op: "limits", sessionId: sid },
    { op: "configureModel", sessionId: sid, model: "none" }, { op: "limits", sessionId: sid }, { op: "limits", sessionId: "other" },
    { op: "configureModel", sessionId: sid, model: "odd", window: 999 }, { op: "limits", sessionId: sid },
  ]));
  // L14 whatever the content: a hostile giant message, a summary config larger than the window, one message in a one-turn view.
  out.push(await run("hostile-giant", [
    direct(), compactor(1000, { maxMessageTokens: 50_000 }, {}), { op: "begin", sessionId: sid, text: "w".repeat(8_000), tokens: 2_000 },
    { op: "prepare", sessionId: sid }, { op: "view", sessionId: sid },
  ]));
  out.push(await run("hostile-summary-config", [
    direct(), compactor(1000, { summaryMaxTokens: 5000, maxMessageTokens: 100 }, { beforeSwap: { kind: "done" } }), ...fill(12, () => 400),
    { op: "begin", sessionId: sid, text: "q", tokens: 1 }, { op: "prepare", sessionId: sid }, { op: "summaries", sessionId: sid },
  ]));
  out.push(await run("hostile-lines", [
    direct(), compactor(1000, { maxMessageTokens: 50_000 }, {}), { op: "begin", sessionId: sid, text: Array.from({ length: 900 }, (_, i) => `row ${i}`).join("\n"), tokens: 900 },
    { op: "prepare", sessionId: sid },
  ]));
  out.push(await run("guards", [
    direct(), compactor(1000, {}, summaryHook({})), { op: "begin", sessionId: sid, text: "running", tokens: 1 }, { op: "afterTurn", sessionId: sid },
    { op: "complete", turnId: "$turn", input: { text: "done", tokens: 1 } }, { op: "afterTurn", sessionId: sid },
    ...fill(6, () => 400), { op: "stop" }, { op: "afterTurn", sessionId: sid }, { op: "summaries", sessionId: sid },
  ]));
  out.push(await run("one-turn-no-segment", [
    direct(), compactor(1000, {}, summaryHook({})), ...turn(sized(400), sized(400, "y")), { op: "afterTurn", sessionId: sid }, { op: "summaries", sessionId: sid },
  ]));
  // Tool pairs in the view: whole skill pair, error pair, pending call, hidden pair (stub), restored pair; a long one clipped.
  const tools = [
    { id: "c1", name: "skill.load", args: { name: "review" }, output: "SKILL TEXT ".repeat(400) }, { id: "c2", name: "file.read", args: { path: "src/a.ts" }, output: "o".repeat(3000) },
    { id: "c3", name: "skill.load", args: { name: "bad" }, output: "E".repeat(900), isError: true }, { id: "c4", name: "exec.run", args: { argv: ["ls"] }, output: "ok" },
  ];
  out.push(await run("tool-view", [
    direct(), compactor(8192, { maxMessageTokens: 300 }, { pruner: { cfg: { decider: "heuristic" } } }),
    ...turn("first", "one", tools), ...turn("second", "two"), ...turn("third", "three"), ...turn("fourth", "four"), ...turn("fifth", "five"),
    { op: "begin", sessionId: sid, text: "sixth", tokens: 2 },
    { op: "append", turnId: "$turn", type: "tool.call", data: { id: "p1", name: "web.fetch", args: { url: "https://example.org/x" } } },
    { op: "view", sessionId: sid }, { op: "pruneView", sessionId: sid },
    { op: "setVisibility", sessionId: sid, ref: "event:4", hidden: true, reason: "stale", detail: { mode: "truncate", confidence: 0.9, tokensSaved: 10 } },
    { op: "setVisibility", sessionId: sid, ref: "event:8", hidden: true, reason: "gone" }, { op: "view", sessionId: sid }, { op: "pruneView", sessionId: sid },
    { op: "restore", sessionId: sid, ref: "event:4" }, { op: "restore", sessionId: sid, ref: "event:4" }, { op: "restore", sessionId: sid, ref: "event:99" },
    { op: "view", sessionId: sid }, { op: "explain", sessionId: sid }, { op: "hiddenOutputs", sessionId: sid }, dump(),
  ]));
  // Summaries and rewinds: the covered prefix, gaps, a nested summary, a rewound range, the lesson of a rewind.
  out.push(await run("summaries-and-rewinds", [
    direct(), compactor(8192, {}, {}), ...fill(5, () => 20),
    { op: "addSummary", summary: { sessionId: sid, fromSeq: 1, toSeq: 4, text: "[summary; originals messages 1-4 in transcript]\nS14", tokens: 10, tier: 1, state: "applied" } },
    { op: "addSummary", summary: { sessionId: sid, fromSeq: 1, toSeq: 2, text: "inner", tokens: 3, tier: 1, state: "applied" } },
    { op: "addSummary", summary: { sessionId: sid, fromSeq: 9, toSeq: 10, text: "gap", tokens: 3, tier: 1, state: "applied" } },
    { op: "addSummary", summary: { sessionId: sid, fromSeq: 5, toSeq: 6, text: "prep", tokens: 3, tier: 1, state: "prepared" } },
    { op: "view", sessionId: sid },
    { op: "rewind", sessionId: sid, to: 6, lesson: "try again", actor: "user:v1:alice", trigger: "user" }, { op: "view", sessionId: sid }, { op: "explain", sessionId: sid }, dump(),
  ]));
  out.push(await run("rewind-hides-summary", [
    direct(), compactor(1000, {}, summaryHook({})), ...fill(8, () => 250),
    { op: "rewind", sessionId: sid, to: 8, lesson: "retry", actor: "user:v1:alice", trigger: "user" },
    { op: "view", sessionId: sid }, { op: "afterTurn", sessionId: sid }, { op: "summaries", sessionId: sid },
    { op: "addSummary", summary: { sessionId: sid, fromSeq: 1, toSeq: 12, text: "wide", tokens: 5, tier: 1, state: "applied" } }, { op: "view", sessionId: sid },
  ]));
  out.push(await run("explain-window", [
    direct(), compactor(1000, {}, {}),
    ...Array.from({ length: 52 }, (_, i) => ({ op: "setVisibility", sessionId: sid, ref: `event:${100 + i}`, hidden: true, reason: "r", detail: { mode: i % 2 ? "truncate" : "drop", confidence: 0.75, tokensSaved: i } })),
    { op: "explain", sessionId: sid },
    ...Array.from({ length: 2 }, (_, i) => ({ op: "refetch", sessionId: sid, ref: `event:${100 + i}` })),
    { op: "explain", sessionId: sid },
  ].slice(0, 56)));
  return out;
}

// ---- pruning ---------------------------------------------------------------------------------------------------------

/** A tool pair whose JSON (`{"call":..,"result":..}`) is exactly `length` units long. */
function pairOfLength(id: string, name: string, args: unknown, length: number) {
  const empty = JSON.stringify({ call: { id, name, ...(args !== undefined ? { args } : {}) }, result: { id, output: "", isError: false } }).length;
  return { id, name, args, output: "o".repeat(length - empty), isError: false };
}
const big = (id: string, path = `f/${id}.txt`) => ({ id, name: "file.read", args: { path }, output: "b".repeat(1100), isError: false });
const small = (id: string) => ({ id, name: "file.read", args: { path: `s/${id}.txt` }, output: "s", isError: false });
const prune = (cfg: Op = {}, hook: Op = {}) => ({ op: "compactor", cfg: cfgOf(100_000), hooks: { pruner: { cfg: { decider: "heuristic", ...cfg }, ...hook } } });
/** Six completed turns, so with `keepLastTurns` 3 the first three are old enough. */
const aged = (first: ReturnType<typeof big>[][], assistants: string[] = []): Op[] => [
  ...first.flatMap((tools, i) => turn(`user ${i}`, assistants[i] ?? `assistant ${i}`, tools)),
  ...Array.from({ length: 6 - first.length }, (_, i) => turn(`later ${i}`, assistants[first.length + i] ?? `done ${i}`)).flat(),
];

async function pruningScenarios() {
  const out: unknown[] = [];
  out.push(await run("heuristic-sizes", [
    direct(), prune(),
    ...aged([[pairOfLength("a1", "file.read", { path: "p/one" }, 1023)], [pairOfLength("b1", "file.read", { path: "p/two" }, 1024)], [pairOfLength("c1", "file.read", { path: "p/three" }, 1025), small("c2"), big("c3")]]),
    { op: "prune", sessionId: sid }, { op: "pruneView", sessionId: sid }, dump(), { op: "prune", sessionId: sid },
  ]));
  out.push(await run("keep-last-turns", [
    direct(), prune({ keepLastTurns: 1 }), ...aged([[big("a1")], [big("b1")], [big("c1")], [big("d1")], [big("e1")], [big("f1")]]),
    { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
    prune({ keepLastTurns: 5 }), { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
    prune({ keepLastTurns: 6 }), { op: "prune", sessionId: sid },
  ]));
  out.push(await run("prune-config-validation", [
    prune({ batchSize: 0 }), prune({ keepLastTurns: 0 }), prune({ maxMs: 0 }), prune({ maxMs: -1 }), prune({ keepLastTurns: 1, batchSize: 1, maxMs: 0.5 }),
  ]));
  // Protection: an assistant that names the path, an approval word, a pending call of the same turn, a loaded skill, an argument
  // the newest call repeats, a restored result.
  out.push(await run("protection", [
    direct(), prune(),
    ...turn("t1", "I looked at src/keep.ts and it is fine", [big("k1", "src/keep.ts"), big("k2", "src/other.ts")]),
    ...turn("t2", "plain", [{ id: "g1", name: "grant.list", args: {}, output: "g".repeat(2000) }, { id: "g2", name: "file.read", args: { path: "x/Audit.txt" }, output: "z".repeat(2000) }]),
    ...turn("t3", "plain", [{ id: "s1", name: "skill.load", args: { name: "n" }, output: "k".repeat(2000) }, { id: "m1", name: "file.read", args: { path: "q/word-POLICY.md" }, output: "k".repeat(2000) }]),
    ...turn("t4", "plain", [big("r1", "src/repeat.ts")]), ...turn("t5", "plain"), ...turn("t6", "plain"),
    { op: "begin", sessionId: sid, text: "again", tokens: 1 },
    { op: "complete", turnId: "$turn", input: { text: "I will read src/keep.ts then do exec", tokens: 5 } },
    { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid }, { op: "pruneView", sessionId: sid },
  ]));
  out.push(await run("protection-pending-and-refs", [
    direct(), prune(),
    ...turn("t1", "one", [big("a1", "doc/alpha.md"), { id: "j1", name: "web.fetch", args: { url: "https://example.org/data" }, output: JSON.stringify({ items: [{ id: "item-12345", path: "out/report.txt" }], other: "zzzz" }) + " ".repeat(1200), isError: false }]),
    ...turn("t2", "two"), ...turn("t3", "three"), ...turn("t4", "four"), ...turn("t5", "five"), ...turn("t6", "see out/report.txt"),
    { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
  ]));
  out.push(await run("pending-call-of-newer-turn", [
    direct(), prune(),
    ...turn("t1", "one", [big("a1", "doc/alpha.md"), big("a2", "doc/beta.md")]), ...aged([]).slice(0, 0), ...turn("t2", "two"), ...turn("t3", "three"), ...turn("t4", "four"), ...turn("t5", "five"),
    { op: "begin", sessionId: sid, text: "running", tokens: 1 },
    { op: "append", turnId: "$turn", type: "tool.call", data: { id: "x1", name: "file.read", args: { path: "doc/alpha.md" } } },
    { op: "prune", sessionId: sid }, { op: "complete", turnId: "$turn", input: { text: "ok", tokens: 1 } }, { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
  ]));
  // The Laya decider: verdicts and the confidence floor.
  const laya = (decide: Op, extra: Op = {}) => prune({ decider: "laya" }, { decide, ...extra });
  const old3 = aged([[big("a1")], [big("b1")], [big("c1")]]);
  for (const [label, entries, extra] of [
    ["drop-at-floor", [{ relevant: false, reason: "stale", verdict: "drop", confidence: 0.7 }], {}],
    ["below-floor", [{ relevant: false, reason: "stale", verdict: "drop", confidence: 0.6999999 }], {}],
    ["truncate-high", [{ relevant: false, reason: "stale", verdict: "truncate", confidence: 0.95 }], {}],
    ["configured-floor", [{ relevant: false, reason: "stale", verdict: "drop", confidence: 0.85 }], { minConfidence: 0.9 }],
    ["configured-floor-met", [{ relevant: false, reason: "stale", verdict: "drop", confidence: 0.9 }], { minConfidence: 0.9 }],
    ["floor-one", [{ relevant: false, reason: "stale", verdict: "drop", confidence: 1 }], { minConfidence: 1 }],
    ["over-one", [{ relevant: false, reason: "stale", verdict: "drop", confidence: 1.0000001 }], {}],
    ["keep-verdict", [{ relevant: false, reason: "stale", verdict: "keep", confidence: 0.99 }], {}],
    ["unknown-verdict", [{ relevant: false, reason: "stale", verdict: "erase", confidence: 0.99 }], {}],
    ["null-verdict", [{ relevant: false, reason: "stale", verdict: null, confidence: 0.99 }], {}],
    ["string-confidence", [{ relevant: false, reason: "stale", verdict: "drop", confidence: "0.99" }], {}],
    ["no-confidence", [{ relevant: false, reason: "stale", verdict: "drop" }], {}],
    ["confidence-without-verdict", [{ relevant: false, reason: "stale", confidence: 0.99 }], {}],
    ["relevant", [{ relevant: true, reason: "needed" }], {}],
    ["mixed", [{ relevant: false, reason: "stale", verdict: "drop", confidence: 0.8 }, { relevant: true, reason: "needed" }, { relevant: false, reason: "old", verdict: "truncate", confidence: 0.7 }], {}],
    ["reason-256", [{ relevant: false, reason: "r".repeat(256) }], {}],
    ["reason-257", [{ relevant: false, reason: "r".repeat(257) }], {}],
    ["reason-blank", [{ relevant: false, reason: " \t\n ﻿" }], {}],
    ["reason-missing", [{ relevant: false }], {}],
    ["reason-number", [{ relevant: false, reason: 5 }], {}],
    ["relevant-string", [{ relevant: "no", reason: "stale" }], {}],
    ["relevant-missing", [{ reason: "stale" }], {}],
  ] as const) {
    out.push(await run(`laya-${label}`, [direct(), laya({ kind: "verdicts", entries }, extra), ...old3, { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid }, dump()]));
  }
  for (const shape of ["short", "dup", "null-element", "not-array", "unknown-ref", "numeric-ref", "primitive"]) {
    out.push(await run(`laya-shape-${shape}`, [
      direct(), laya({ kind: "verdicts", shape, entries: [{ relevant: false, reason: "stale" }] }), ...old3,
      { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
      { op: "compactor", cfg: cfgOf(1000), hooks: { pruner: { cfg: { decider: "laya" }, decide: { kind: "verdicts", shape, entries: [{ relevant: false, reason: "stale" }] } } } },
      { op: "afterTurn", sessionId: sid },
    ]));
  }
  for (const [label, decide, extra] of [
    ["null-heuristic", { kind: "null" }, {}], ["throws", { kind: "throw" }, {}], ["timeout", { kind: "timeout" }, {}], ["abort-after-answer", { kind: "verdicts", abort: true, entries: [{ relevant: false, reason: "stale" }] }, { abortable: true }],
    ["abort-not-wired", { kind: "verdicts", entries: [{ relevant: false, reason: "stale" }] }, { abortable: true }],
    ["new-event-during", { kind: "verdicts", during: [{ op: "begin", sessionId: sid, text: "new user", tokens: 1 }], entries: [{ relevant: false, reason: "stale" }] }, {}],
    ["new-reference-during", { kind: "verdicts", entries: [{ relevant: false, reason: "stale" }], during: [{ op: "setVisibility", sessionId: sid, ref: "event:2", hidden: false, reason: "pinned" }] }, {}],
  ] as const) {
    const ops: Op[] = [direct(), laya(decide as Op, extra as Op), ...old3, { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid }, dump()];
    out.push(await run(`laya-${label}`, label === "timeout" ? [direct(), prune({ decider: "laya", maxMs: 30 }, { decide }), ...old3, { op: "prune", sessionId: sid }, dump()] : ops));
  }
  // Time budget and batches: the second batch runs out of time, so nothing of the first is committed.
  out.push(await run("batches-budget", [
    direct(), prune({ decider: "laya", batchSize: 2, maxMs: 100 }, { decide: { kind: "verdicts", bump: 60, entries: [{ relevant: false, reason: "stale" }] } }),
    ...aged([[big("a1")], [big("b1")], [big("c1")]]), { op: "mono", ms: 10 },
    { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
    prune({ decider: "laya", batchSize: 2, maxMs: 100 }, { decide: { kind: "verdicts", bump: 30, entries: [{ relevant: false, reason: "stale" }] } }),
    { op: "mono", ms: 0 }, { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
    prune({ decider: "laya", batchSize: 1, maxMs: 100 }, { decide: { kind: "verdicts", bump: 100, entries: [{ relevant: false, reason: "stale" }] } }),
    { op: "mono", ms: 0 }, { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
    prune({ decider: "laya", batchSize: 1, maxMs: 100 }, { decide: { kind: "verdicts", bump: 99.5, entries: [{ relevant: false, reason: "stale" }] } }),
    { op: "mono", ms: 0 }, { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
  ]));
  out.push(await run("decider-modes", [
    direct(), prune({ decider: "laya" }), ...old3, { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
    prune({ decider: "off" }), { op: "prune", sessionId: sid }, prune({ enabled: false }), { op: "prune", sessionId: sid },
    prune({ decider: "heuristic" }, { decide: { kind: "throw" } }), { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
  ]));
  out.push(await run("run-guards", [
    direct(), prune({ decider: "heuristic" }), ...old3, { op: "begin", sessionId: sid, text: "running", tokens: 1 }, { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
    { op: "complete", turnId: "$turn", input: { text: "done", tokens: 1 } }, { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid },
  ]));
  out.push(await run("restore-and-outputs", [
    direct(), prune(), ...old3, { op: "hiddenOutputs", sessionId: sid }, { op: "prune", sessionId: sid }, { op: "hiddenOutputs", sessionId: sid },
    { op: "restore", sessionId: sid, ref: "event:2" }, { op: "restore", sessionId: sid, ref: "event:2" }, { op: "restore", sessionId: sid, ref: "event:nope" },
    { op: "pruneView", sessionId: sid }, { op: "prune", sessionId: sid }, { op: "visibility", sessionId: sid }, { op: "pruneMetrics", sessionId: sid }, { op: "hiddenOutputs", sessionId: sid },
  ]));
  // The saving a verdict records: a truncate that saves nothing is zero, never negative.
  out.push(await run("tokens-saved", [
    direct(), laya({ kind: "verdicts", entries: [{ relevant: false, reason: "s", verdict: "truncate", confidence: 0.9 }, { relevant: false, reason: "d", verdict: "drop", confidence: 0.9 }] }),
    ...aged([[pairOfLength("a1", "file.read", { path: "p/one" }, 700), pairOfLength("a2", "x".repeat(150), { path: "p/two" }, 400)], [big("b1")], [pairOfLength("c1", "file.read", { path: "p/c1" }, 3000)]]),
    { op: "prune", sessionId: sid }, { op: "pruneView", sessionId: sid }, { op: "explain", sessionId: sid }, dump(),
  ]));
  out.push(await run("stub-text", [
    direct(), prune({ decider: "heuristic" }),
    ...aged([[{ id: "n1", name: "ab" + "x\u{1F600}".repeat(60), args: { a: [1, 2, { z: null }], b: 1 }, output: "x" + "\u{1F600}".repeat(400) + "t", isError: true }, { id: "n2", name: "file.read", output: "p".repeat(2000) }, { id: "n3", name: "file.read", args: null as any, output: "q".repeat(2000), isError: false }]]),
    { op: "setVisibility", sessionId: sid, ref: "event:2", hidden: true, reason: "t", detail: { mode: "truncate", confidence: 0.9, tokensSaved: 1 } },
    { op: "setVisibility", sessionId: sid, ref: "event:4", hidden: true, reason: "d" }, { op: "setVisibility", sessionId: sid, ref: "event:6", hidden: true, reason: "d", detail: { mode: "truncate", confidence: 0.9, tokensSaved: 1 } },
    { op: "pruneView", sessionId: sid }, { op: "view", sessionId: sid },
  ]));
  return out;
}

// ---- summarizer ------------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The real `createLlmSummarizer` over a scripted provider; records every request it builds and what it makes of the answers. */
async function summarizeCase(name: string, spec: Op) {
  const requests: unknown[] = [], usages: unknown[] = [];
  const responses: Op[] = spec.responses ?? [{ items: [{ delta: "SUMMARY" }] }];
  let calls = 0;
  const provider: any = {
    id: "scripted",
    async *stream(req: any) {
      const { signal: _signal, turnId, ...rest } = req;
      if (!UUID.test(turnId)) throw new Error(`turnId is not a v4 uuid: ${turnId}`);
      requests.push({ ...rest, turnId: "$uuid" });
      const r = responses[Math.min(calls++, responses.length - 1)]!;
      const user = req.messages[1].text as string;
      for (const item of r.items ?? [{ delta: `S${calls}:${user.slice(0, 12)}` }]) {
        if ("delta" in item) yield { type: "delta", text: item.delta };
        else if ("echo" in item) yield { type: "delta", text: `S${calls}:${user.slice(0, item.echo)}` };
        else if ("fill" in item) yield { type: "delta", text: item.fill.repeat(item.times) };
        else if ("usage" in item) yield { type: "usage", ...item.usage };
        else if ("tool" in item) yield item.tool === "call" ? { type: "tool.call", id: "t", name: "x" } : { type: "tool.result", id: "t", output: "o" };
        else if ("throw" in item) throw new Error(item.throw);
      }
    },
  };
  if (spec.roleModels !== undefined && spec.roleModels !== "absent") provider.roleModels = () => spec.roleModels;
  const context = { sessionId: "ses_1", agentId: "bernd", principal: "user:v1:alice", signal: new AbortController().signal, caller: { kind: "cli", uid: 501 } };
  const summarize = createLlmSummarizer(provider, context as any, spec.inputMaxTokens, (u) => { usages.push(u); }, spec.purpose);
  let result: Op;
  try { result = { ok: await summarize(spec.messages, spec.maxTokens) }; } catch (e: any) { result = { err: String(e?.message) }; }
  return { name, spec, ...result, calls, requests, usages };
}

function summarizerCases() {
  const msgs = (n: number, chars: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", seq: i + 1, text: `m${i} ` + "t".repeat(chars) }));
  const e = (o: Op = {}) => ({ messages: msgs(2, 20), maxTokens: 100, ...o });
  return Promise.all([
    summarizeCase("single-block", e({})),
    summarizeCase("lesson-purpose", e({ purpose: "lesson" })),
    summarizeCase("block-boundary-exact", e({ inputMaxTokens: 10, messages: [{ role: "user", seq: 1, text: "u".repeat(40 - "user#1: ".length) }] })),
    summarizeCase("block-boundary-over", e({ inputMaxTokens: 10, messages: [{ role: "user", seq: 1, text: "u".repeat(41 - "user#1: ".length) }] })),
    summarizeCase("many-blocks-merge", e({ inputMaxTokens: 30, messages: msgs(6, 120), responses: [{ items: [{ echo: 20 }] }] })),
    summarizeCase("many-blocks-merge-big", e({ inputMaxTokens: 20, messages: msgs(8, 150), responses: [{ items: [{ fill: "m", times: 60 }] }], maxTokens: 15 })),
    summarizeCase("pairwise-merge", e({ inputMaxTokens: 5, messages: msgs(5, 60), responses: [{ items: [{ fill: "q", times: 40 }] }, { items: [{ delta: "tiny" }] }], maxTokens: 6 })),
    summarizeCase("tier-limit", e({ inputMaxTokens: 5, messages: msgs(9, 200), responses: [{ items: [{ fill: "q", times: 400 }] }], maxTokens: 400 })),
    summarizeCase("surrogate-split", e({ inputMaxTokens: 10, messages: [{ role: "user", seq: 1, text: "\u{1F600}".repeat(60) }], responses: [{ items: [{ echo: 15 }] }] })),
    summarizeCase("apple-fm-whole", e({ inputMaxTokens: 10, messages: msgs(6, 120), roleModels: [{ provider: "apple-fm", model: "system" }] })),
    summarizeCase("apple-fm-mixed", e({ inputMaxTokens: 10, messages: msgs(6, 120), roleModels: [{ provider: "p", model: "m" }, { provider: "apple-fm", model: "system" }] })),
    summarizeCase("empty-role-table", e({ inputMaxTokens: 10, messages: msgs(6, 120), roleModels: [] })),
    summarizeCase("other-role-table", e({ inputMaxTokens: 10, messages: msgs(3, 60), roleModels: [{ provider: "p", model: "m" }] })),
    summarizeCase("no-role-method", e({ inputMaxTokens: 10, messages: msgs(3, 60), roleModels: "absent" })),
    summarizeCase("empty-answer", e({ responses: [{ items: [] }] })),
    summarizeCase("blank-answer", e({ responses: [{ items: [{ delta: " \n\t ﻿ " }] }] })),
    summarizeCase("chunks-concatenate", e({ responses: [{ items: [{ delta: "A" }, { usage: { inputTokens: 5, outputTokens: 2, model: "p/m" } }, { delta: "B" }, { usage: { inputTokens: 7, outputTokens: 3 } }] }] })),
    summarizeCase("answer-too-long", e({ maxTokens: 6, responses: [{ items: [{ delta: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") }] }] })),
    summarizeCase("answer-single-long-line", e({ maxTokens: 3, responses: [{ items: [{ delta: "z".repeat(500) }] }] })),
    summarizeCase("tool-call", e({ responses: [{ items: [{ delta: "partial" }, { tool: "call" }] }] })),
    summarizeCase("tool-result", e({ responses: [{ items: [{ tool: "result" }] }] })),
    summarizeCase("throws-before", e({ responses: [{ items: [{ throw: "provider down" }] }] })),
    summarizeCase("throws-midway", e({ responses: [{ items: [{ delta: "half" }, { throw: "stream cut" }] }] })),
    summarizeCase("second-call-fails", e({ inputMaxTokens: 10, messages: msgs(4, 80), responses: [{ items: [{ delta: "ok" }] }, { items: [{ throw: "second failed" }] }] })),
    summarizeCase("zero-max-tokens", e({ maxTokens: 0 })),
    summarizeCase("no-messages", e({ messages: [] })),
    summarizeCase("default-input-bound", { messages: msgs(1, 9000), maxTokens: 50, responses: [{ items: [{ echo: 10 }] }] }),
  ]);
}

// ---- context fit -----------------------------------------------------------------------------------------------------

function fitError(e: any) {
  return { name: String(e?.constructor?.name), message: e?.message, ...(e?.kind !== undefined ? { kind: e.kind } : {}), ...(e?.code !== undefined ? { code: e.code } : {}),
    ...(e?.retryable !== undefined ? { retryable: e.retryable } : {}), ...(e?.error !== undefined ? { error: e.error } : {}), ...(e?.reason !== undefined ? { reason: e.reason } : {}) };
}
const attempt = (f: () => unknown) => { try { return { ok: f() ?? null }; } catch (e) { return { err: fitError(e) }; } };

function contextFitCases() {
  const msg = (content: string) => ({ role: "user", content });
  const requests: Op[] = [
    { messages: [] }, { messages: [msg("hi")] }, { messages: [msg("hi")], tools: [] }, { messages: [msg("hi")], maxTokens: 512 }, { messages: [msg("hi")], maxTokens: 1 },
    { messages: [msg("hi")], maxTokens: 0 }, { messages: [msg("hi")], maxTokens: -1 }, { messages: [msg("hi")], maxTokens: 1.5 }, { messages: [msg("hi")], maxTokens: 9007199254740991 }, { messages: [msg("hi")], maxTokens: 9007199254740992 },
    { messages: [msg("hi")], maxTokens: null }, { messages: [msg("ü".repeat(10_700))], maxTokens: 512 }, { messages: [msg("x".repeat(10_700))], maxTokens: 512 },
    { messages: [msg("\u{1F600}".repeat(100))], maxTokens: 64 }, { messages: [msg("a\"b\\c\n\u0001 ")], tools: [{ name: "t", parameters: { type: "object", description: "d".repeat(100) } }] },
    { messages: [msg("x".repeat(2998))], maxTokens: 10 }, { messages: [msg("x".repeat(2999))], maxTokens: 10 }, { messages: [msg("x".repeat(3000))], maxTokens: 10 },
    { messages: [{ role: "user", content: "z", extra: { b: 1, a: [null, true, 1.5e-7, 1e21] } }], tools: null },
  ];
  const windows: (number | undefined)[] = [undefined, 4096, 100, 1, 0, -5, 0.5, 4096.5, 9007199254740992, 1e300];
  const cases = requests.map((request) => ({
    request, cost: attempt(() => contextCost(request as any)),
    fit: windows.map((window) => ({ window: window ?? null, ...attempt(() => assertContextFit(request as any, window)) })),
  }));
  // Windows exactly at, and one below, the cost of the request.
  const exact = requests.flatMap((request) => {
    const cost = attempt(() => contextCost(request as any)) as any;
    if (!cost.ok) return [];
    const total = cost.ok.prompt + cost.ok.reserve;
    return [total - 1, total, total + 1].map((window) => ({ request, window, ...attempt(() => assertContextFit(request as any, window)) }));
  });
  const roles = ["chat", "reasoning", "dream", "capture", "engine", "decision", "summarize", "", "Chat", "unknown"].flatMap((role) =>
    [undefined, 0, 4096, 16_383, 16_384, 16_385, 1e9, 0.5, -1].map((window) => ({ role, window: window ?? null, ...attempt(() => assertRoleContext(role, window)) })));
  return { constants: { MIN_CONTEXT_AGENT_ROLE, APPLE_FM_CONTEXT_WINDOW }, cases, exact, roles };
}

// ---- pure helpers ----------------------------------------------------------------------------------------------------

function pureCases() {
  const texts = ["", "a", "abcd", "abcde", "x".repeat(40), "x".repeat(41), "x".repeat(400), "line\nline\nline", "a\n\n b   c\t d", "\u{1F600}".repeat(30), "x\u{1F600}".repeat(30), "ü".repeat(77), "\n\n\n", " lead and trail ", "﻿ x　"];
  const tokensList = [0, 1, 2, 3, 5, 10, 11, 100];
  return {
    estimate: texts.map((text) => ({ text, tokens: estimateTokens(text) })),
    truncate: texts.flatMap((text) => tokensList.map((max) => ({ text, max, pointer: "see message m1", result: truncateWithPointer(text, max, "see message m1") }))),
    truncateNegative: [-1, -100].map((max) => ({ text: "hello world, a longer text than room", max, result: truncateWithPointer("hello world, a longer text than room", max, "p") })),
    fitTail: [...texts, Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), Array.from({ length: 12 }, () => "").join("\n"), "x".repeat(10) + "\n" + "y".repeat(200), Array.from({ length: 300 }, (_, i) => `r${i}`).join("\n")]
      .flatMap((text) => [0, 1, 2, 3, 5, 8, 10, 12, 13, 14, 20, 40, 60, 100, 1000].map((max) => ({ text, max, result: fitTail(text, max) }))),
    digest: [[], [{ role: "user", seq: 1, text: "a\n\n b   c" }, { role: "assistant", seq: 2, text: "z".repeat(1000) }], [{ role: "system", seq: 9, text: "\u{1F600}".repeat(100) }], [{ role: "tool", seq: 3, text: "x".repeat(159) + "\u{1F600}" }],
      [{ role: "user", seq: 4, text: "x".repeat(160) }, { role: "user", seq: 5, text: "x".repeat(161) }, { role: "user", seq: 6, text: "  \n\t " }]].map((messages) => ({ messages, digest: digest(messages as any) })),
    defaults: [1, 7, 100, 999, 1000, 8192, 100_000].map((w) => ({ window: w, cfg: defaultCompaction(w) })),
    pruneDefaults: { confidence: DEFAULT_PRUNE_CONFIDENCE, prune: defaultPrune() },
  };
}

// ---- main ------------------------------------------------------------------------------------------------------------

/** Runs of one repeated code unit this long are written as `{ "$rep": [unit, count] }` inside `{ "$cat": [parts] }`, which keeps the
 *  files small; the replay expands them. A string with a lone surrogate becomes `{ "$u16": [units] }` (JSON cannot hold it). */
const RUN = 32;
function compress(v: string): unknown {
  if (!v.isWellFormed()) return { $u16: Array.from({ length: v.length }, (_, i) => v.charCodeAt(i)) };
  const parts: unknown[] = []; let from = 0, i = 0;
  while (i < v.length) {
    let j = i; while (j < v.length && v[j] === v[i]) j++;
    const unit = v.charCodeAt(i);
    if (j - i >= RUN && !(unit >= 0xd800 && unit <= 0xdfff)) { if (from < i) parts.push(v.slice(from, i)); parts.push({ $rep: [v[i], j - i] }); from = j; }
    i = j;
  }
  if (parts.length === 0) return v;
  if (from < v.length) parts.push(v.slice(from));
  return { $cat: parts };
}
function encodeLone(v: unknown): unknown {
  if (typeof v === "string") return compress(v);
  if (Array.isArray(v)) return v.map(encodeLone);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeLone(x)]));
  return v;
}

/** Scenarios in files of at most `size` each (a vector file stays under 1 MiB): `<name>-1`, `<name>-2`, ... */
function parts(name: string, scenarios: unknown[], size: number): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (let i = 0; i * size < scenarios.length; i++) out[`${name}-${i + 1}`] = scenarios.slice(i * size, (i + 1) * size);
  return out;
}

export async function buildMaintenanceVectors() {
  return encodeLone({
    pure: pureCases(),
    "context-fit": contextFitCases(),
    ...parts("compaction", await compactionScenarios(), 15),
    ...parts("pruning", await pruningScenarios(), 12),
    summarizer: await summarizerCases(),
  }) as any;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "session-maintenance", build: buildMaintenanceVectors });
}
