// Parity vectors (mode V) for the decision service (P4-K K9a, plan P4-42): `packages/core/src/decision/`. The call of
// a model is a port on the Rust side, so every file here records which request TypeScript builds (as the text
// `JSON.stringify` gives) and what it makes of scripted answers, broken ones included (no JSON, the wrong shape, cut
// off, late, cancelled). `crates/plur1bus-core/src/decision/vectors.rs` replays every case. Recorded, never edited by
// hand.
//
// `performance.now` is scripted while the vectors are built (the client reads it directly); a request id (a random
// UUID in TypeScript) is recorded as `$id`. The encoding of long and odd values is the one of `export-prompt.ts`. The
// credential of the System One cases is test material built from `{ "parts": [...] }`, never one literal.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-decision.ts [--check]
import { fileURLToPath } from "node:url";
import { DecisionClient } from "../../packages/core/src/decision/client.ts";
import { DecisionBackendError } from "../../packages/core/src/decision/types.ts";
import { ruleSkills, selectDecisionSkills } from "../../packages/core/src/decision/skills.ts";
import { enrichedSkillQuery, fairTaskSkills, isSkillFollowup } from "../../packages/core/src/decision/skill-context.ts";
import { decisionPruningPort } from "../../packages/core/src/decision/pruning.ts";
import { DecisionTreeChooser } from "../../packages/core/src/decision/tree-adapter.ts";
import { createRoleBackend } from "../../packages/core/src/decision/role.ts";
import { createSystemOneBackend } from "../../packages/core/src/decision/system-one.ts";
import { CATEGORY_PREFIX } from "../../packages/core/src/toolcall/categories.ts";
import { WebFailure } from "../../packages/core/src/tools/web/failure.ts";
import { Texts } from "./export-prompt.ts";
import { exporterMain } from "./lib.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const clock = { t: 1000 };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const text = (v: unknown): string => JSON.stringify(v ?? null).replace(UUID, "$id");
const reasonOf = (e: unknown) => (e instanceof DecisionBackendError ? { reason: e.reason } : { other: (e as Error)?.constructor?.name ?? typeof e });
const wellFormed = (v: Any): Any => (typeof v === "string" ? v.toWellFormed() : Array.isArray(v) ? v.map(wellFormed) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wellFormed(x)])) : v);
/** A request as the Rust port builds it: the same text, with U+FFFD where a TypeScript `slice` left half a surrogate pair (K9a-D1). */
const requestText = (input: Any) => { const exact = JSON.stringify(input); const lossy = JSON.stringify(wellFormed(input)); return { request: lossy, ...(exact === lossy ? {} : { divergence: "K9a-D1" }) }; };

/** The fixture writer sorts object keys. Where TypeScript's member order reaches a request (features, the chat request of the turn),
 *  the object is recorded as `{ "$entries": [[key, value], ...] }` in the order of `Object.entries`. */
const entries = (o: Any) => (o && typeof o === "object" && !Array.isArray(o) ? { $entries: Object.entries(o) } : o);
const ordered = (input: Any): Any => {
  if (!input || typeof input !== "object") return input;
  const out = { ...input };
  if ("features" in out) out.features = entries(out.features);
  if (out.context?.chat) out.context = { ...out.context, chat: entries(out.context.chat) };
  return out;
};

// --- the client ---------------------------------------------------------------------------------------------------------------
type Run = { answerJson?: string; advance?: number; throw?: string; throwOther?: boolean; hang?: boolean; abort?: boolean };
interface BackendSpec { local: boolean | null | "throw"; eligible?: boolean | "throw"; onLocal?: "local-only-on"; runs?: Run[]; fit?: boolean }
interface Call { primitive: "noul" | "choice" | "score" | "triage"; input?: Any; message?: string; context?: Any; at?: number; abortedBefore?: boolean }
interface ClientScenario { name: string; config?: Any; backends: Record<string, BackendSpec>; calls: Call[]; typed?: boolean }
const OPTS = [{ id: "a", description: "first" }, { id: "b", description: "second" }, { id: "c", description: "third" }];
const base = (over: Any = {}) => ({ useCase: "routing", state: "the state", question: "Is it?", ...over });
const choice = (over: Any = {}) => base({ options: OPTS, ...over });
const score = (over: Any = {}) => base({ levels: ["low", "mid", "high"], ...over });
const ok = (v: Any, extra: Run = {}): Run => ({ answerJson: JSON.stringify(v), ...extra });
const role = (...runs: Run[]): Record<string, BackendSpec> => ({ role: { local: false, runs } });
const pick = (id: string, p: number[], confidence = 0.9, extra: Any = {}) => ({ id, probabilities: Object.fromEntries(OPTS.map((o, i) => [o.id, p[i]])), confidence, ...extra });
const TRIAGE_MESSAGE = "fix the bug and write the report";
const ttask = (over: Any = {}) => ({ id: "k1", summary: "fix the bug", start: 0, end: 11, categories: { "code.edit": 1 }, modelClass: { small: 0.1, medium: 0.75, large: 0.12, frontier: 0.03 }, chosenClass: "small", effort: "low", dependsOn: [], confidence: 0.9, reason: "r", ...over });
const tdecision = (tasks: Any[], over: Any = {}) => ({ schema: "plur1bus.triage/1", shape: tasks.length > 1 ? "multi" : "single", tasks, ...over });

function clientScenarios(): ClientScenario[] {
  const out: ClientScenario[] = [];
  out.push({ name: "accepted-by-the-role", backends: role(ok({ probability: 0.9, modelRevision: "local/m1" }), ok(pick("b", [0.2, 0.7, 0.1])), ok({ probabilities: [0.1, 0.2, 0.7], confidence: 0.8, modelRevision: "" }), ok({ probability: 0.1 }), ok({ ...tdecision([ttask()]), modelRevision: "p/m" })),
    calls: [{ primitive: "noul", input: base() }, { primitive: "choice", input: choice() }, { primitive: "score", input: score() }, { primitive: "noul", input: base({ features: { n: 1, flag: true, s: "x", 10: "ten", 2: "two" } }), at: 1500.5 }, { primitive: "triage", message: TRIAGE_MESSAGE }] });
  // The confidence floor of each use case, at the boundary.
  for (const [useCase, floor] of [["routing", 0.7], ["pruning", 0.7], ["skills", 0.7], ["placement", 0.7], ["zoom", 0.35], ["compaction", 0.7]] as const) {
    out.push({ name: `floor-${useCase}`, backends: role(ok(pick("a", [0.6, 0.3, 0.1], floor)), ok(pick("a", [0.6, 0.3, 0.1], floor - 1e-9)), ok({ probability: floor }), ok({ probability: 1 - floor }), ok({ probability: floor - 1e-9 }), ok({ probability: 0.5 })),
      calls: [{ primitive: "choice", input: choice({ useCase }) }, { primitive: "choice", input: choice({ useCase }) }, { primitive: "noul", input: base({ useCase }) }, { primitive: "noul", input: base({ useCase }) }, { primitive: "noul", input: base({ useCase }) }, { primitive: "noul", input: base({ useCase }) }] });
  }
  out.push({ name: "floor-and-budget-from-configuration", config: { decision: { confidence: { routing: 0.95, zoom: 0 }, budgets: { routing: 50, triage: 10 }, timeoutMs: 400 } }, backends: role(ok(pick("a", [0.6, 0.3, 0.1], 0.94)), ok(pick("a", [0.6, 0.3, 0.1], 0.95)), ok(pick("a", [0.6, 0.3, 0.1], 0.01)), ok({ probability: 0.9 }, { advance: 50 }), ok({ probability: 0.9 }, { advance: 49.999 }), ok({ probability: 0.9 }, { advance: 399.5 }), ok({ probability: 0.9 }, { advance: 400 }), ok(tdecision([]), { advance: 10 })),
    calls: [{ primitive: "choice", input: choice() }, { primitive: "choice", input: choice() }, { primitive: "choice", input: choice({ useCase: "zoom" }) }, { primitive: "noul", input: base() }, { primitive: "noul", input: base() }, { primitive: "noul", input: base({ useCase: "skills" }) }, { primitive: "noul", input: base({ useCase: "skills" }) }, { primitive: "triage", message: "hi" }] });
  for (const [useCase, budget] of [["triage", 2000], ["routing", 200], ["pruning", 100], ["skills", 2000], ["placement", 200], ["zoom", 150], ["compaction", 200]] as const) {
    out.push({ name: `default-budget-${useCase}`, backends: role(ok({ probability: 0.99 }, { advance: budget - 0.5 }), ok({ probability: 0.99 }, { advance: budget })), calls: [{ primitive: "noul", input: base({ useCase }) }, { primitive: "noul", input: base({ useCase }) }] });
  }
  out.push({ name: "deadlines", config: { decision: { timeoutMs: 100 } }, backends: role(ok({ probability: 0.9 }, { advance: 20 }), ok({ probability: 0.9 }, { advance: 20 }), ok({ probability: 0.9 })),
    calls: [{ primitive: "noul", input: base(), context: { deadline: 1021 } }, { primitive: "noul", input: base(), context: { deadline: 1020 }, at: 1000 }, { primitive: "noul", input: base(), context: { deadline: 1000 }, at: 1000 }, { primitive: "noul", input: base(), context: { deadline: 999 }, at: 1000 }, { primitive: "noul", input: base(), context: { deadline: 5000 }, at: 1000 }] });
  for (const timeoutMs of ["abc", null, "50", true, 0, -5]) out.push({ name: `timeout-setting-${JSON.stringify(timeoutMs)}`, config: { decision: { timeoutMs } }, backends: role(ok({ probability: 0.9 })), calls: [{ primitive: "noul", input: base() }] });
  // Backend order and admission.
  const answering = (local: boolean | null | "throw", extra: Partial<BackendSpec> = {}): BackendSpec => ({ local, runs: Array.from({ length: 4 }, () => ok({ probability: 0.9, confidence: 0.9 })), ...extra });
  for (const backend of ["role", "laya", "kev", "jev", "auto", "unknown", undefined]) {
    for (const cloudEligible of [undefined, true]) {
      out.push({ name: `selected-${String(backend)}-cloud-${String(cloudEligible)}`, config: { decision: { ...(backend ? { backend } : {}) } }, backends: { role: answering(false), laya: answering(true, { eligible: true }), kev: answering(true, { eligible: true }), jev: answering(false, { eligible: true }) },
        calls: [{ primitive: "noul", input: base(), context: { ...(cloudEligible ? { cloudEligible } : {}) } }, { primitive: "noul", input: base(), context: { forceLocal: true, ...(cloudEligible ? { cloudEligible } : {}) } }, { primitive: "triage", message: "hi", context: { cloudEligible: true } }] });
    }
  }
  out.push({ name: "auto-skips-what-is-not-eligible", config: { decision: { backend: "auto" } }, backends: { jev: answering(false, { eligible: false }), kev: answering(true), laya: answering(true, { eligible: "throw" }), role: answering(null) }, calls: [{ primitive: "noul", input: base(), context: { cloudEligible: true } }] });
  out.push({ name: "auto-without-a-role", config: { decision: { backend: "auto" } }, backends: { jev: answering(false, { eligible: true }), kev: answering("throw", { eligible: true }) }, calls: [{ primitive: "noul", input: base() }, { primitive: "noul", input: base(), context: { cloudEligible: true, forceLocal: true } }] });
  out.push({ name: "nothing-installed", backends: {}, calls: [{ primitive: "noul", input: base() }, { primitive: "triage", message: "hi" }] });
  out.push({ name: "selected-kev-falls-back-to-role", config: { decision: { backend: "kev" } }, backends: { kev: { local: true, runs: [{ throw: "unavailable" }, { throw: "invalid" }, { throwOther: true }, { throw: "low-confidence" }, { throw: "privacy" }, { throw: "timeout" }, { throw: "cancelled" }] }, role: answering(false) },
    calls: Array.from({ length: 7 }, () => ({ primitive: "noul" as const, input: base() })) });
  // "Local only" from the live configuration: the installation, an agent's own switch in both directions, and a switch thrown during the decision.
  for (const [name, config] of [["installation", { privacy: { localOnly: true } }], ["agent-on", { agents: { bernd: { privacy: { localOnly: true } } } }], ["agent-off", { privacy: { localOnly: true }, agents: { bernd: { privacy: { localOnly: false } } } }], ["other-agent", { agents: { other: { privacy: { localOnly: true } } } }]] as const) {
    out.push({ name: `local-only-${name}`, config, backends: { role: answering(false) }, calls: [{ primitive: "noul", input: base() }] });
    out.push({ name: `local-only-${name}-auto`, config: { ...config, decision: { backend: "auto" } }, backends: { kev: answering(true, { eligible: true }), role: answering(false) }, calls: [{ primitive: "noul", input: base() }] });
  }
  out.push({ name: "local-only-switched-on-during-the-decision", backends: { role: { local: false, onLocal: "local-only-on", runs: [ok({ probability: 0.9 })] } }, calls: [{ primitive: "noul", input: base() }, { primitive: "noul", input: base() }] });
  // Failures of a backend.
  out.push({ name: "interruptions", config: { decision: { timeoutMs: 30 } }, backends: role({ hang: true }, ok({ probability: 0.9 }, { abort: true }), { throwOther: true, abort: true }, ok({ probability: 0.9 }, { advance: 30 }), { throwOther: true, advance: 31 }, ok({ probability: 0.9 })),
    calls: [{ primitive: "noul", input: base() }, { primitive: "noul", input: base() }, { primitive: "noul", input: base() }, { primitive: "noul", input: base() }, { primitive: "noul", input: base() }, { primitive: "noul", input: base(), abortedBefore: true }] });
  // Answers that are not what was asked for.
  const broken: Array<[Call, Any]> = [
    ...[null, [], "text", 7, true, { probability: 1.0000001 }, { probability: -0.1 }, { probability: "0.5" }, {}, { probability: 0 }, { probability: 1 }, { probability: 0.5, extra: "kept out" }, { probability: 0.9, modelRevision: "m".repeat(257) }, { probability: 0.9, modelRevision: 7 }].map((a): [Call, Any] => [{ primitive: "noul", input: base({ useCase: "triage" }) }, a]),
    [{ primitive: "noul", input: base({ useCase: "triage" }) }, { probability: 0.9, pad: "x".repeat(65_536 - 27) }], [{ primitive: "noul", input: base({ useCase: "triage" }) }, { probability: 0.9, pad: "x".repeat(65_536 - 26) }],
    ...[pick("z", [0.5, 0.3, 0.2]), pick("b", [0.5, 0.3, 0.2]), pick("a", [0.4, 0.4, 0.2]), pick("b", [0.4, 0.4, 0.2]), pick("a", [0.5, 0.3, 0.2000011]), pick("a", [0.5, 0.3, 0.2000009]), pick("a", [0.5, 0.3, 0.2], 1.1), { id: "a", probabilities: { a: 1 }, confidence: 0.9 }, { id: "a", probabilities: { a: 0.5, b: 0.3, c: 0.2, d: 0 }, confidence: 0.9 },
      { id: "a", probabilities: [0.5, 0.3, 0.2], confidence: 0.9 }, { id: 1, probabilities: { a: 0.5, b: 0.3, c: 0.2 }, confidence: 0.9 }, { id: "a", probabilities: { a: 0.5, b: 0.3, c: 0.2 } }, { id: "a", probabilities: { a: "0.5", b: 0.3, c: 0.2 }, confidence: 0.9 }, { id: "a", probabilities: { c: 0.2, b: 0.3, a: 0.5 }, confidence: 0.9 }, pick("a", [1, 0, 0], 0.7), pick("none", [0.5, 0.3, 0.2])]
      .map((a): [Call, Any] => [{ primitive: "choice", input: choice({ useCase: "triage" }) }, a]),
    ...[{ probabilities: [0.2, 0.3, 0.5], confidence: 0.9 }, { probabilities: [0.5, 0.5], confidence: 0.9 }, { probabilities: [0.2, 0.3, 0.5, 0], confidence: 0.9 }, { probabilities: [0.2, 0.3, 0.6], confidence: 0.9 }, { probabilities: { 0: 0.2, 1: 0.3, 2: 0.5 }, confidence: 0.9 }, { probabilities: [0.2, 0.3, 0.5] }, { probabilities: [0.2, "0.3", 0.5], confidence: 0.9 }, { probabilities: [0, 0, 1], confidence: 0 }, { probabilities: [1, 0, 0], confidence: 1, score: 2 }]
      .map((a): [Call, Any] => [{ primitive: "score", input: score({ useCase: "triage" }) }, a]),
    ...[tdecision([ttask()]), tdecision([ttask(), ttask({ id: "k2", start: 16, end: 32, confidence: 0.3 })]), tdecision([], { shape: "chat" }), tdecision([], { shape: "followup" }), tdecision([]), tdecision([ttask()], { shape: "multi" }), tdecision([ttask()], { shape: "chat" }), tdecision([ttask({ end: 99 })]), { shape: "chat", tasks: [] },
      tdecision(Array.from({ length: 32 }, (_, i) => ttask({ id: `t${i}`, start: i, end: i + 1 }))), tdecision(Array.from({ length: 33 }, (_, i) => ttask({ id: `t${i}`, start: i, end: i + 1 }))), tdecision([(({ confidence: _c, ...rest }) => rest)(ttask())]), { ...tdecision([ttask({ confidence: 0.2 })]), modelRevision: "r/1" }]
      .map((a): [Call, Any] => [{ primitive: "triage", message: `${TRIAGE_MESSAGE} ${"x".repeat(20)}` }, a]),
  ];
  out.push({ name: "broken-answers", backends: role(...broken.map(([, a]) => ok(a))), calls: broken.map(([c]) => c) });
  out.push({ name: "answers-that-are-no-json-values", backends: role({ throwOther: true }, { throw: "invalid" }), calls: [{ primitive: "noul", input: base() }, { primitive: "noul", input: base() }] });
  // Inputs out of bounds: nothing is asked of a backend.
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, description: "d" }));
  const inputs: Call[] = [
    { primitive: "noul", input: base({ state: "s".repeat(16_384) }) }, { primitive: "noul", input: base({ state: "s".repeat(16_385) }) }, { primitive: "noul", input: base({ state: "😀".repeat(8192) }) }, { primitive: "noul", input: base({ state: `${"😀".repeat(8192)}x` }) },
    { primitive: "noul", input: base({ question: "q".repeat(2048) }) }, { primitive: "noul", input: base({ question: "q".repeat(2049) }) }, { primitive: "noul", input: base({ features: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`f${i}`, i])) }) },
    { primitive: "noul", input: base({ features: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, i])) }) }, { primitive: "noul", input: base({ features: { t: "t".repeat(1024) } }) }, { primitive: "noul", input: base({ features: { t: "t".repeat(1025) } }) },
    { primitive: "noul", input: base({ features: { n: NaN } }) }, { primitive: "noul", input: base({ features: { n: Infinity } }) }, { primitive: "noul", input: base({ features: {} }) }, { primitive: "noul", input: base({ state: "", question: "" }) }, { primitive: "noul", input: choice() },
    { primitive: "choice", input: base() }, { primitive: "choice", input: choice({ options: many(1) }) }, { primitive: "choice", input: choice({ options: many(2) }) }, { primitive: "choice", input: choice({ options: many(255) }) }, { primitive: "choice", input: choice({ options: many(256) }) },
    { primitive: "choice", input: choice({ options: [{ id: "a", description: "x" }, { id: "a", description: "y" }] }) }, { primitive: "choice", input: choice({ options: [{ id: "", description: "x" }, { id: "b", description: "y" }] }) }, { primitive: "choice", input: choice({ options: [{ id: "i".repeat(128), description: "x" }, { id: "b", description: "d".repeat(1024) }] }) },
    { primitive: "choice", input: choice({ options: [{ id: "i".repeat(129), description: "x" }, { id: "b", description: "y" }] }) }, { primitive: "choice", input: choice({ options: [{ id: "a", description: "d".repeat(1025) }, { id: "b", description: "y" }] }) },
    { primitive: "score", input: base() }, { primitive: "score", input: score({ levels: ["only"] }) }, { primitive: "score", input: score({ levels: Array.from({ length: 10 }, (_, i) => `l${i}`) }) }, { primitive: "score", input: score({ levels: Array.from({ length: 11 }, (_, i) => `l${i}`) }) },
    { primitive: "score", input: score({ levels: ["a", ""] }) }, { primitive: "score", input: score({ levels: ["a", "l".repeat(1025)] }) }, { primitive: "triage", message: "m".repeat(200_000) }, { primitive: "triage", message: "m".repeat(200_001) },
  ];
  // `fit`: the backend answers every request it gets with an answer that fits it, so a refused input shifts nothing.
  out.push({ name: "input-bounds", backends: { role: { local: false, fit: true } }, calls: inputs });
  // What a typed Rust input cannot hold: TypeScript calls all of it invalid.
  out.push({ name: "inputs-a-typed-caller-cannot-build", typed: false, backends: role(), calls: [{ primitive: "noul", input: base({ useCase: "unknown" }) }, { primitive: "noul", input: base({ useCase: "toString" }) }, { primitive: "noul", input: base({ state: 5 }) }, { primitive: "noul", input: base({ question: null }) },
    { primitive: "noul", input: base({ features: { o: {} } }) }, { primitive: "noul", input: base({ features: { o: null } }) }, { primitive: "choice", input: choice({ options: "ab" }) }, { primitive: "choice", input: choice({ options: [{ id: 1, description: "x" }, { id: 2, description: "y" }] }) }, { primitive: "score", input: score({ levels: [1, 2] }) }] });
  return out;
}

/** An answer that fits whatever was asked: all probability on the first option or level. */
function fitting(request: Any) {
  if (request.primitive === "triage-compat") return { schema: "plur1bus.triage/1", shape: "chat", tasks: [] };
  if (request.primitive === "choice") return { id: request.options[0].id, probabilities: Object.fromEntries(request.options.map((o: Any, i: number) => [o.id, i === 0 ? 1 : 0])), confidence: 0.9 };
  if (request.primitive === "score") return { probabilities: request.levels.map((_: Any, i: number) => (i === 0 ? 1 : 0)), confidence: 0.9 };
  return { probability: 0.9 };
}

async function runClientScenario(t: Texts, s: ClientScenario) {
  const config: Any = structuredClone({ decision: {}, ...(s.config ?? {}) });
  const events: string[] = [];
  const requests: Any[] = [];
  let current: AbortController | undefined;
  const backends: Any = {};
  for (const [name, spec] of Object.entries(s.backends)) {
    const runs = [...(spec.runs ?? [])];
    backends[name] = {
      local() { if (spec.onLocal === "local-only-on") config.privacy = { localOnly: true }; if (spec.local === "throw") throw new Error("local"); return spec.local === null ? undefined : spec.local; },
      ...(spec.eligible !== undefined ? { eligible() { if (spec.eligible === "throw") throw new Error("eligible"); return spec.eligible; } } : {}),
      run(request: Any, signal: AbortSignal) {
        const run: Run = spec.fit ? { answerJson: JSON.stringify(fitting(request)) } : runs.shift() ?? { throw: "unavailable" };
        requests.push({ backend: name, primitive: request.primitive, deadline: request.deadline, useCase: request.useCase, forceLocal: request.context.forceLocal === true, hasOptions: request.options !== undefined, hasLevels: request.levels !== undefined });
        clock.t += run.advance ?? 0;
        if (run.abort) current!.abort();
        if (run.hang) return new Promise(() => { signal.addEventListener("abort", () => { clock.t = request.deadline; }); });
        if (run.throw) throw new DecisionBackendError(run.throw as never);
        if (run.throwOther) throw new SyntaxError("not json");
        return JSON.parse(run.answerJson!);
      },
    };
  }
  const client = new DecisionClient({ config: () => config, backends, emit: (_context, event) => { events.push(text(event)); } });
  const calls = [];
  for (const call of s.calls) {
    clock.t = call.at ?? 1000;
    current = new AbortController();
    if (call.abortedBefore) current.abort();
    events.length = 0;
    requests.length = 0;
    const context = { agentId: "bernd", signal: current.signal, ...(call.context ?? {}) };
    const result = call.primitive === "triage" ? await client.triage(call.message!, context) : await (client as Any)[call.primitive](call.input, context);
    calls.push({ call: t.enc({ ...call, ...(call.input ? { input: ordered(call.input) } : {}) }), json: text(result), events: [...events], requests: structuredClone(requests) });
  }
  return { name: s.name, typed: s.typed !== false, config: s.config ?? {}, backends: s.backends, calls, status: text(client.status()) };
}

// --- skills -------------------------------------------------------------------------------------------------------------------
function scriptedChooser(script: Any[], seen: Any[], advance = 0) {
  return { choice(input: Any, context: Any) {
    const next = script.shift() ?? { ok: false, reason: "unavailable" };
    seen.push({ ...requestText(input), deadline: context.deadline ?? null, forceLocal: context.forceLocal === true, agentId: context.agentId });
    clock.t += next.advance ?? advance;
    if (next.abort) next.abort.abort();
    return Promise.resolve(next.ok === false ? { ok: false, requestId: "r", elapsedMs: 1, reason: next.reason, attempted: [] } : { ok: true, requestId: "r", backend: "role", elapsedMs: 1, value: next.value, confidence: next.confidence ?? 0.8, confidenceSource: "uncalibrated", reasonCode: "accepted" });
  } } as Any;
}
async function skillVectors() {
  const t = new Texts();
  const cand = (id: string, confidence?: number, over: Any = {}) => ({ id, name: `name-${id}`, description: `does ${id}`, ...(confidence !== undefined ? { confidence } : {}), ...over });
  const pool = Array.from({ length: 15 }, (_, i) => cand(`s${i}`, 0.9 - i * 0.05));
  const inputs: Array<[string, Any]> = [
    ["empty", { query: "q", candidates: [] }], ["floor", { query: "q", candidates: [cand("a", 0.2), cand("b", 0.1999999), cand("c", 0.21), cand("d", 0.9), cand("e", 0.95)] }], ["no-relevance", { query: "q", candidates: [cand("a"), cand("b", NaN), cand("c", Infinity), cand("d", -1)] }],
    ["pins-first", { query: "q", candidates: pool, pinned: ["name-s9", "name-s3", "missing"] }], ["four-pins", { query: "q", candidates: pool, pinned: ["name-s1", "name-s2", "name-s3", "name-s4"] }], ["blocks-win-over-pins", { query: "q", candidates: pool, pinned: ["name-s1"], blocked: ["name-s1", "name-s0"] }],
    ["duplicates-keep-first-place-last-value", { query: "q", candidates: [cand("a", 0.1), cand("b", 0.5), cand("a", 0.9, { name: "second-a" })] }], ["none-and-bounds", { query: "q", candidates: [cand("none", 0.9), cand("i".repeat(128), 0.9), cand("i".repeat(129), 0.9), cand("long", 0.9, { description: "d".repeat(1025) }), cand("fits", 0.9, { description: "d".repeat(1024) })] }],
    ["many", { query: "q", candidates: pool }],
  ];
  const rule = inputs.map(([name, input]) => ({ name, input: t.enc(input), picks: t.enc(ruleSkills(input)) }));
  const win = (id: string, probabilities: Record<string, number>, confidence = 0.8) => ({ value: { id, probabilities }, confidence });
  const spread = (ids: string[], p: number[]) => Object.fromEntries([...ids.map((id, i) => [id, p[i] ?? 0]), ["none", 0]]);
  const ids12 = pool.slice(0, 12).map((c) => c.id);
  const emoji = "😀";
  const selections: Array<{ name: string; input: Any; script: Any[]; context?: Any; aborted?: "before" | "during" }> = [
    { name: "winner-and-secondaries", input: { query: "do the thing", candidates: pool }, script: [win("s4", spread(ids12, [0.2, 0.1999, 0.05, 0.3, 0.35]))] },
    { name: "ties-keep-the-callers-order", input: { query: "q", candidates: pool }, script: [win("s7", spread(ids12, [0, 0.25, 0, 0.25, 0, 0.25, 0, 0.25]))] },
    { name: "room-after-pins", input: { query: "q", candidates: pool, pinned: ["name-s0", "name-s1"] }, script: [win("s5", spread(pool.slice(2, 14).map((c) => c.id), [0.3, 0.3, 0.1, 0.3]))] },
    { name: "no-room", input: { query: "q", candidates: pool, pinned: ["name-s0", "name-s1", "name-s2"] }, script: [] }, { name: "nothing-to-refine", input: { query: "q", candidates: [], pinned: [] }, script: [] },
    { name: "none-keeps-pins", input: { query: "q", candidates: pool, pinned: ["name-s3"] }, script: [win("none", spread(ids12, []))] }, { name: "low-confidence-keeps-pins", input: { query: "q", candidates: pool, pinned: ["name-s3"] }, script: [{ ok: false, reason: "low-confidence" }] },
    ...["unavailable", "timeout", "invalid", "privacy", "cancelled"].map((reason) => ({ name: `failure-${reason}-keeps-the-rule-shortlist`, input: { query: "q", candidates: pool, pinned: ["name-s3"] }, script: [{ ok: false, reason }] })),
    ...[0, -1, NaN, Infinity].map((maxMs) => ({ name: `max-ms-${String(maxMs)}`, input: { query: "q", candidates: pool, maxMs }, script: [win("s1", spread(ids12, [0, 1]))] })),
    { name: "deadline-is-the-earlier-one", input: { query: "q", candidates: pool, maxMs: 500 }, script: [win("s1", spread(ids12, [0, 1]))], context: { deadline: 1200 } }, { name: "deadline-from-max-ms", input: { query: "q", candidates: pool, maxMs: 500 }, script: [win("s1", spread(ids12, [0, 1]))], context: { deadline: 9000 } },
    { name: "query-and-description-are-cut", input: { query: "q".repeat(4097), candidates: [cand("a", 0.9, { description: "d".repeat(1024) }), cand("b", 0.9)] }, script: [win("a", { a: 1, b: 0, none: 0 })] },
    { name: "query-at-the-limit", input: { query: "q".repeat(4096), candidates: [cand("a", 0.9), cand("b", 0.9)] }, script: [win("b", { a: 0, b: 1, none: 0 })] },
    { name: "a-cut-inside-a-surrogate-pair", input: { query: `${"q".repeat(4095)}${emoji}`, candidates: [cand("a", 0.9, { name: "n", description: `${"d".repeat(1020)}${emoji}` }), cand("b", 0.9)] }, script: [win("a", { a: 1, b: 0, none: 0 })] },
    { name: "aborted-before", input: { query: "q", candidates: pool }, script: [], aborted: "before" }, { name: "aborted-during", input: { query: "q", candidates: pool }, script: [win("s1", spread(ids12, [0, 1]))], aborted: "during" },
    { name: "single-candidate", input: { query: "q", candidates: [cand("only", 0.05)] }, script: [win("only", { only: 0.6, none: 0.4 }, 0.71)] },
  ];
  const select = [];
  for (const s of selections) {
    clock.t = 1000;
    const controller = new AbortController();
    if (s.aborted === "before") controller.abort();
    const seen: Any[] = [];
    const script = s.script.map((x) => (s.aborted === "during" ? { ...x, abort: controller } : x));
    try { const picks = await selectDecisionSkills(scriptedChooser(script, seen), s.input, { agentId: "bernd", signal: controller.signal, ...(s.context ?? {}) }); select.push({ name: s.name, input: t.enc(s.input), script: s.script, context: s.context ?? {}, ...(s.aborted ? { aborted: s.aborted } : {}), requests: t.enc(seen), picks: t.enc(picks) }); }
    catch (e) { select.push({ name: s.name, input: t.enc(s.input), script: s.script, context: s.context ?? {}, ...(s.aborted ? { aborted: s.aborted } : {}), requests: t.enc(seen), error: (e as Error).name }); }
  }
  const followups = ["yes", "Yes!", "  ok.  ", "OKAY", "Ja, bitte weiter!", "yes, please continue...", "go   ahead", "mach\tdas", "weiter so…", "yes: continue", "ok;weiter", "yes please do", "continue the report", "", "…", "ja weiter", "JA\nBITTE", "yes?!", "y", "okay continue.", "İ", "ΟΚ", "do it now", "weiter so!", "Mach Weiter", "ok weiter", "ok﻿weiter", "no", "nein!", "genau."]
    .map((input) => ({ input, result: isSkillFollowup(input) }));
  const queries = [{ current: "fix it" }, { current: "  fix it  ", previousUser: "fix it", tasks: [{ summary: "fix it" }, { summary: " other " }] }, { current: "", previousUser: "", tasks: [] }, { current: "a", previousUser: "b", tasks: [{ summary: "c" }, { summary: "a" }, { summary: "" }, { summary: " d " }] }, { current: "a\nb", previousUser: "a" }]
    .map((input) => ({ input, result: enrichedSkillQuery(input) }));
  const p = (id: string, source: "pinned" | "rule" | "decision" = "rule") => ({ id, name: id, description: "", source });
  const fair = [{ tasks: [[p("a"), p("b")], [p("c"), p("d")], [p("e")]], pinned: [] }, { tasks: [[p("a"), p("b"), p("c"), p("d")]], pinned: [] }, { tasks: [[p("a")], [p("a"), p("b")], [p("a"), p("b"), p("c")]], pinned: [] }, { tasks: [[p("x", "pinned"), p("a")], [p("b")]], pinned: [p("z", "pinned")] },
    { tasks: [[p("a")], [p("b")]], pinned: [p("p1", "pinned"), p("p2", "pinned"), p("p3", "pinned"), p("p4", "pinned")] }, { tasks: [], pinned: [] }, { tasks: [[], [p("a")], []], pinned: [p("a", "pinned")] }, { tasks: [[p("a"), p("b")], [p("b"), p("a")]], pinned: [] }]
    .map((input) => ({ input, result: fairTaskSkills(input.tasks, input.pinned) }));
  return { ...t.tables(), rule, select, followups, queries, fair };
}

// --- pruning and the tree chooser ----------------------------------------------------------------------------------------------
async function adapterVectors() {
  const t = new Texts();
  const keep = (id: string, confidence = 0.8) => ({ value: { id, probabilities: { keep: 0, truncate: 0, drop: 0, [id]: 1 } }, confidence });
  const batch = [{ ref: "r1", text: "tool output one" }, { ref: "r2", text: "x".repeat(300) }, { ref: "r3", text: "" }, { ref: "r4", text: "four" }, { ref: "r5", text: "five" }, { ref: "r6", text: "six" }, { ref: "r7", text: "seven" }, { ref: "r8", text: "eight" }];
  const pruning = [];
  for (const [name, task, script] of [["three-way", "the current task", [keep("keep"), keep("truncate", 0.75), keep("drop", 0.99), { ok: false, reason: "low-confidence" }, { ok: false, reason: "unavailable" }, { ok: false, reason: "timeout" }, { ok: false, reason: "privacy" }, { ok: false, reason: "cancelled" }]],
    ["long-task", "t".repeat(1025), [keep("drop")]], ["task-cut-inside-a-pair", `${"t".repeat(1023)}😀`, [keep("keep")]], ["empty-batch", "task", []]] as Array<[string, string, Any[]]>) {
    const seen: Any[] = [];
    const pairs = name === "empty-batch" ? [] : batch.slice(0, script.length);
    const port = decisionPruningPort(scriptedChooser([...script], seen), (pair: Any) => ({ agentId: `agent-of-${pair.ref}`, forceLocal: false, cloudEligible: true, signal: new AbortController().signal }) as Any);
    const output = await port(pairs as Any, task, new AbortController().signal);
    pruning.push({ name, task: t.enc(task), batch: t.enc(pairs), script, requests: t.enc(seen), output });
  }
  const node = (id: string, over: Any = {}) => ({ id, name: `Name ${id}`, summary: `Summary of ${id}`, ...over });
  const three = [node("a"), node("b"), node("c")];
  const tp = (id: string, probabilities: Record<string, number>, extra: Any = {}) => ({ value: { id, probabilities }, confidence: 0.5, ...extra });
  const trees: Array<{ name: string; query: Any; candidates: Any[]; script: Any[]; context?: Any; aborted?: "before" | "during"; at?: number }> = [
    { name: "winner-and-runner-up", query: "where", candidates: three, script: [tp("b", { a: 0.3, b: 0.6, c: 0.1, none: 0 })] }, { name: "at-the-threshold", query: "where", candidates: three, script: [tp("a", { a: 0.35, b: 0.33, c: 0.32, none: 0 })] },
    { name: "below-the-threshold", query: "where", candidates: three, script: [tp("a", { a: 0.3499999, b: 0.33, c: 0.3200001, none: 0 })] }, { name: "ties-keep-order", query: "where", candidates: three, script: [tp("c", { a: 0.4, b: 0.2, c: 0.4, none: 0 })] },
    { name: "none", query: "where", candidates: three, script: [tp("none", { a: 0.1, b: 0.1, c: 0.1, none: 0.7 })] }, ...["low-confidence", "unavailable", "timeout"].map((reason) => ({ name: `failure-${reason}`, query: "where", candidates: three, script: [{ ok: false, reason }] })),
    { name: "one-candidate", query: "where", candidates: [node("a")], script: [tp("a", { a: 1, none: 0 })] }, { name: "no-candidates", query: "where", candidates: [], script: [] }, { name: "query-at-the-limit", query: "q".repeat(4096), candidates: three, script: [tp("a", { a: 1, b: 0, c: 0, none: 0 })] },
    { name: "query-too-long", query: "q".repeat(4097), candidates: three, script: [] }, { name: "twenty-five-candidates", query: "where", candidates: Array.from({ length: 25 }, (_, i) => node(`n${i}`)), script: [tp("n3", Object.fromEntries([...Array.from({ length: 24 }, (_, i) => [`n${i}`, i === 3 ? 0.5 : i === 20 ? 0.5 : 0]), ["none", 0]]))] },
    { name: "name-and-summary-are-cut", query: "where", candidates: [node("a", { name: "n".repeat(81), summary: "s".repeat(161) }), node("b", { name: `${"n".repeat(79)}😀`, summary: `${"s".repeat(159)}😀` })], script: [tp("a", { a: 1, b: 0, none: 0 })] },
    ...[["empty-id", [node("")]], ["id-none", [node("a"), node("none")]], ["id-too-long", [node("i".repeat(129))]], ["id-at-the-limit", [node("i".repeat(128))]], ["duplicate-ids", [node("a"), node("a")]], ["bad-id-beyond-the-shortlist", [...Array.from({ length: 24 }, (_, i) => node(`n${i}`)), node("none")]]]
      .map(([name, candidates]) => ({ name: name as string, query: "where", candidates: candidates as Any[], script: [tp((candidates as Any[])[0].id, Object.fromEntries([...(candidates as Any[]).slice(0, 24).map((c: Any, i: number) => [c.id, i === 0 ? 1 : 0]), ["none", 0]]))] })),
    { name: "a-decision-does-not-ask-a-decision", query: "where", candidates: three, script: [tp("a", { a: 1, b: 0, c: 0, none: 0 })], context: { chat: { role: "decision" } } }, { name: "other-roles-may", query: "where", candidates: three, script: [tp("a", { a: 1, b: 0, c: 0, none: 0 })], context: { chat: { role: "chat" } } },
    { name: "deadline-passed", query: "where", candidates: three, script: [tp("a", { a: 1, b: 0, c: 0, none: 0 })], context: { deadline: 1000 } }, { name: "deadline-tightened-to-150", query: "where", candidates: three, script: [tp("a", { a: 1, b: 0, c: 0, none: 0 })], context: { deadline: 9000 } },
    { name: "deadline-earlier-than-150", query: "where", candidates: three, script: [tp("a", { a: 1, b: 0, c: 0, none: 0 })], context: { deadline: 1100 } }, { name: "answer-at-the-deadline", query: "where", candidates: three, script: [tp("a", { a: 1, b: 0, c: 0, none: 0 }, { advance: 150 })] },
    { name: "answer-just-before-the-deadline", query: "where", candidates: three, script: [tp("a", { a: 1, b: 0, c: 0, none: 0 }, { advance: 149.5 })] }, { name: "aborted-before", query: "where", candidates: three, script: [], aborted: "before" }, { name: "aborted-during", query: "where", candidates: three, script: [tp("a", { a: 1, b: 0, c: 0, none: 0 })], aborted: "during" },
  ];
  const tree = [];
  for (const s of trees) {
    clock.t = s.at ?? 1000;
    const controller = new AbortController();
    if (s.aborted === "before") controller.abort();
    const seen: Any[] = [];
    const script = s.script.map((x) => (s.aborted === "during" ? { ...x, abort: controller } : x));
    const chooser = new DecisionTreeChooser(scriptedChooser(script, seen), () => ({ agentId: "bernd", ...(s.context ?? {}) }) as Any);
    const picks = await chooser.choose(s.query, s.candidates, controller.signal);
    tree.push({ name: s.name, query: t.enc(s.query), candidates: t.enc(s.candidates), script: s.script, context: s.context ?? {}, ...(s.aborted ? { aborted: s.aborted } : {}), requests: t.enc(seen), picks });
  }
  return { ...t.tables(), pruning, tree };
}

// --- the role backend -------------------------------------------------------------------------------------------------------------
async function roleVectors() {
  const t = new Texts();
  const c = (provider: string, model: string) => ({ provider, model });
  const profilesOf = (spec: Record<string, Array<{ provider: string; model: string }>>, events: Any[][]) => Object.fromEntries(Object.entries(spec).map(([name, list]) => [name, list.map((cand, i) => ({ ...cand, adapter: { async *stream() { for (const e of events[i] ?? []) { if (e.throw) throw Object.assign(new Error("adapter"), e.throw); yield e; } } } }))]));
  const std = { fast: [c("local", "m-small"), c("cloud", "m-big")], smart: [c("cloud", "m-big"), c("cloud", "m-other")], 7: [c("num", "seven")] };
  const resolve = [];
  for (const roleName of [undefined, "", "fast", "smart", "cloud/m-big", "cloud/m-other", "local/m-small", "num/seven", "7", "missing", "cloud/missing", "empty"]) {
    const profiles: Any = { ...std, empty: [] };
    const backend = createRoleBackend((() => { throw new Error("unused"); }) as Any, { profiles: profilesOf(profiles, []), isLocalProvider: (p: string) => p === "local" } as Any, () => ({ modelRoles: { decision: roleName } }) as Any);
    resolve.push({ role: roleName ?? null, profiles: Object.entries(profiles), local: backend.local({} as Any) ?? null });
  }
  interface RoleCase { name: string; role?: string; request: Any; events: Any[][]; use?: number; chunks?: Any[]; windows?: Record<string, number>; localOnlyOption?: boolean; isLocal?: boolean }
  const reqOf = (primitive: string, over: Any = {}, context: Any = {}) => ({ requestId: "0b0c1d2e-0000-4000-8000-000000000001", primitive, deadline: 3000, useCase: "routing", state: "the state", question: "Is it?", context: { agentId: "bernd", signal: new AbortController().signal, ...context }, ...over });
  const answer = (v: Any) => [[{ type: "delta", text: JSON.stringify(v).slice(0, 5) }, { type: "delta", text: JSON.stringify(v).slice(5) }, { type: "done" }]];
  const chat = { sessionId: "turn-session", agentId: "other", principal: "human:chat", projectId: "p1", role: "chat", modelProfile: "big", reasoning: { effort: "high" }, turnProfile: "x", messages: [{ role: "user", text: "ignored" }], extra: { kept: true }, maxOutputTokens: 9, 2: "index-key" };
  const cases: RoleCase[] = [
    { name: "noul", request: reqOf("noul"), events: answer({ probability: 0.9 }) }, { name: "choice", request: reqOf("choice", { options: [{ id: "a", description: "first" }, { id: "b", description: "second \"quoted\"" }], features: { b: 1, a: "x", 3: true } }), events: answer({ id: "a", probabilities: { a: 1, b: 0 }, confidence: 1 }) },
    { name: "score", request: reqOf("score", { levels: ["low", "high"] }), events: answer({ probabilities: [0.5, 0.5], confidence: 0.5 }) }, { name: "triage-compat", request: reqOf("triage-compat", { useCase: "triage", state: "hi 😀\n\"there\"", question: "Classify the message using plur1bus.triage/1." }), events: answer({ schema: "plur1bus.triage/1", shape: "chat", tasks: [] }) },
    { name: "context-members", request: reqOf("noul", {}, { sessionId: "s1", turnId: "t1", principal: "human:1", forceLocal: true, chat }), events: answer({ probability: 0.5 }) }, { name: "principal-from-the-chat", request: reqOf("noul", {}, { chat }), events: answer({ probability: 0.5 }) },
    { name: "empty-principal-and-turn", request: reqOf("noul", {}, { principal: "", turnId: "", sessionId: "" }), events: answer({ probability: 0.5 }) }, { name: "role-names-a-model", role: "cloud/m-other", request: reqOf("noul"), events: [[], [{ type: "delta", text: "{\"probability\":0.25}" }, { type: "done" }]] },
    { name: "second-candidate-finishes", request: reqOf("noul"), events: [[], [{ type: "delta", text: "{\"probability\":0.75}" }, { type: "done" }]], use: 1 }, { name: "no-done-event-and-a-claimed-revision", request: reqOf("noul"), events: [[{ type: "delta", text: "{\"probability\":0.75,\"modelRevision\":\"claimed\"}" }]] },
    { name: "small-context-window", request: reqOf("noul"), events: answer({ probability: 0.5 }), windows: { "cloud/m-big": 4096 } }, { name: "window-just-above", request: reqOf("noul"), events: answer({ probability: 0.5 }), windows: { "cloud/m-big": 4097, "local/m-small": 8192 } },
    { name: "tool-call", request: reqOf("noul"), events: [[]], chunks: [{ type: "delta", text: "{" }, { type: "tool.call", name: "shell" }, { type: "delta", text: "}" }] }, { name: "tool-result", request: reqOf("noul"), events: [[]], chunks: [{ type: "tool.result" }] },
    { name: "output-at-the-cap", request: reqOf("noul"), events: [[{ type: "delta", text: `{"probability":0.5,"p":"${"x".repeat(65_536 - 26)}"}` }, { type: "done" }]] }, { name: "output-over-the-cap", request: reqOf("noul"), events: [[{ type: "delta", text: `{"probability":0.5,"p":"${"x".repeat(65_536 - 25)}"}` }, { type: "done" }]] },
    { name: "not-json", request: reqOf("noul"), events: [[{ type: "delta", text: "Sure! The probability is 0.9" }, { type: "done" }]] }, { name: "cut-off", request: reqOf("noul"), events: [[{ type: "delta", text: "{\"probability\":0." }, { type: "done" }]] }, { name: "empty-output", request: reqOf("noul"), events: [[{ type: "done" }]] },
    ...["[1,2]", "\"text\"", "7", "null", "true"].map((raw) => ({ name: `json-${raw}`, request: reqOf("noul"), events: [[{ type: "delta", text: raw }, { type: "done" }]] })),
    { name: "router-refuses-local-only", request: reqOf("noul"), events: [[{ throw: { code: "local-only" } }]] }, { name: "router-fails", request: reqOf("noul"), events: [[{ throw: { code: "E_INTERNAL" } }]] }, { name: "unconfigured", role: "missing", request: reqOf("noul"), events: [[]] },
    { name: "agent-is-local-only-by-option", request: reqOf("noul"), events: answer({ probability: 0.5 }), localOnlyOption: true },
  ];
  const runs = [];
  for (const k of cases) {
    const created: Any[] = [];
    const requests: Any[] = [];
    const roleName = k.role ?? "smart";
    const options: Any = { profiles: profilesOf(std, k.events), isLocalProvider: (p: string) => p === "local", contextWindow: (p: string, m: string) => k.windows?.[`${p}/${m}`], localOnly: () => k.localOnlyOption === true, classifyMessage: () => "dropped", capabilities: "dropped", skillsForAgent: "dropped", kept: "passes through" };
    const create = (o: Any) => {
      created.push({ profile: o.profile, system: o.system, maxTokens: o.maxTokens, maxRounds: o.maxRounds, requireTriage: o.requireTriage, candidates: o.profiles[o.profile].map((x: Any) => ({ provider: x.provider, model: x.model })), kept: o.kept, dropped: ["classifyMessage", "capabilities", "skillsForAgent"].filter((key) => key in o),
        profileForAgent: o.profileForAgent("bernd") ?? null, profileForClass: o.profileForClass("large") });
      return { async *stream(req: Any) {
        const { signal: _signal, ...rest } = req;
        requests.push({ json: JSON.stringify(rest), localOnly: o.localOnly("bernd") });
        if (k.chunks) { for (const chunk of k.chunks) yield chunk; return; }
        for await (const e of o.profiles[o.profile][k.use ?? 0].adapter.stream(req, {})) if (e.type === "delta") yield e;
      } };
    };
    const backend = createRoleBackend(create as Any, options, () => ({ modelRoles: { decision: roleName } }) as Any);
    const { context: { signal: _s, ...context }, ...request } = k.request;
    const base = { name: k.name, role: roleName, request: t.enc(ordered({ ...request, context })), events: t.enc(k.events), ...(k.use !== undefined ? { use: k.use } : {}), ...(k.chunks ? { chunks: k.chunks } : {}), windows: k.windows ?? {}, local: backend.local(k.request.context) ?? null };
    try { const value = await backend.run(k.request, new AbortController().signal); runs.push({ ...base, created, requests: t.enc(requests), value: t.enc(value), json: JSON.stringify(value) }); }
    catch (e) { runs.push({ ...base, created, requests: t.enc(requests), error: reasonOf(e) }); }
  }
  return { ...t.tables(), categoryPrefix: CATEGORY_PREFIX, profiles: Object.entries(std), resolve, runs };
}

// --- System One ---------------------------------------------------------------------------------------------------------------------
const SECRET_PARTS = ["s1", "-test-", "credential", "-0001"];
interface S1Step { name: string; kind: "jev" | "kev"; request?: Any; settings?: Any; config?: Any; response?: Any; ports?: Any; testOrigin?: string | null; kevEligible?: boolean | null; noBudget?: boolean }
function systemOneCases(): S1Step[] {
  const out: S1Step[] = [];
  const reply = (decision: Any, over: Any = {}) => ({ status: 200, json: { model: "jev-1.13.0", answers: { decision }, usage: { input_tokens: 120, output_tokens: 8 }, ...over } });
  const kreply = (decision: Any, over: Any = {}) => ({ status: 200, json: { model: "kev-local/1.0", answers: { decision }, usage: { input_tokens: 120, output_tokens: 8 }, latency_ms: 12.5, ...over } });
  const choiceReq = { primitive: "choice", options: [{ id: "a", description: "first" }, { id: "b", description: "second" }, { id: "10", description: "ten" }, { id: "2", description: "two" }], features: { n: 1, s: "x" } };
  const scoreReq = { primitive: "score", levels: ["low", "mid", "high"] };
  const good = { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.7, b: 0.2, 10: 0.05, 2: 0.05 } };
  out.push({ name: "jev-noul", kind: "jev", response: reply({ type: "noul", noul: 0.8 }) }, { name: "jev-choice", kind: "jev", request: choiceReq, response: reply(good) }, { name: "jev-score", kind: "jev", request: scoreReq, response: reply({ type: "score", score: 1.5, legend: { 0: "low", 1: "mid", 2: "high" }, confidence: 0.6, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } }) },
    { name: "kev-noul", kind: "kev", response: kreply({ type: "noul", noul: 0.25 }) }, { name: "kev-choice-rounded", kind: "kev", request: choiceReq, response: kreply({ ...good, probabilities: { a: 0.7001, b: 0.2, 10: 0.05, 2: 0.05 } }) },
    { name: "kev-choice-beyond-rounding", kind: "kev", request: choiceReq, response: kreply({ ...good, probabilities: { a: 0.7003, b: 0.2, 10: 0.05, 2: 0.05 } }) }, { name: "jev-choice-sum-off", kind: "jev", request: choiceReq, response: reply({ ...good, probabilities: { a: 0.7001, b: 0.2, 10: 0.05, 2: 0.05 } }) },
    { name: "kev-score-rounded", kind: "kev", request: scoreReq, response: kreply({ type: "score", score: 1.5004, legend: { 0: "low", 1: "mid", 2: "high" }, confidence: 0.6, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } }) },
    { name: "kev-score-beyond-rounding", kind: "kev", request: scoreReq, response: kreply({ type: "score", score: 1.5006, legend: { 0: "low", 1: "mid", 2: "high" }, confidence: 0.6, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } }) });
  // Closed answers: anything unexpected is invalid.
  const bad: Array<[string, Any, Any?]> = [["extra-top-member", reply({ type: "noul", noul: 0.8 }, { note: "x" })], ["latency-on-jev", reply({ type: "noul", noul: 0.8 }, { latency_ms: 1 })], ["other-model", reply({ type: "noul", noul: 0.8 }, { model: "jev-2" })], ["usage-missing", { status: 200, json: { model: "jev-1.13.0", answers: { decision: { type: "noul", noul: 0.8 } } } }],
    ["usage-extra", reply({ type: "noul", noul: 0.8 }, { usage: { input_tokens: 1, output_tokens: 1, total: 2 } })], ["usage-fraction", reply({ type: "noul", noul: 0.8 }, { usage: { input_tokens: 1.5, output_tokens: 1 } })], ["usage-negative", reply({ type: "noul", noul: 0.8 }, { usage: { input_tokens: -1, output_tokens: 1 } })],
    ["two-answers", { status: 200, json: { model: "jev-1.13.0", answers: { decision: { type: "noul", noul: 0.8 }, other: {} }, usage: { input_tokens: 1, output_tokens: 1 } } }], ["wrong-type", reply({ type: "choice", noul: 0.8 })], ["noul-out-of-range", reply({ type: "noul", noul: 1.2 })], ["noul-extra", reply({ type: "noul", noul: 0.8, confidence: 1 })],
    ["answer-null", reply(null)], ["body-array", { status: 200, json: [] }], ["body-not-json", { status: 200, text: "<html>" }], ["body-cut-off", { status: 200, text: "{\"model\":\"jev-1.13.0\",\"answers\":{\"decision\":{\"type\":\"noul\",\"noul\":0." }], ["status-500", { status: 500, json: { error: "x" } }], ["status-204", { status: 204, text: "" }],
    ["body-over-the-cap", { status: 200, text: `{"model":"jev-1.13.0","pad":"${"x".repeat(65_536)}"}` }], ["choice-unknown", reply({ ...good, choice: "z" }), choiceReq], ["choice-not-the-maximum", reply({ ...good, choice: "b" }), choiceReq], ["choice-missing-key", reply({ ...good, probabilities: { a: 0.8, b: 0.2 } }), choiceReq],
    ["choice-extra-key", reply({ ...good, probabilities: { a: 0.7, b: 0.2, 10: 0.05, 2: 0.05, z: 0 } }), choiceReq], ["choice-zero-sum", reply({ ...good, probabilities: { a: 0, b: 0, 10: 0, 2: 0 } }), choiceReq], ["choice-confidence-missing", reply({ type: "choice", choice: "a", probabilities: good.probabilities }), choiceReq],
    ["score-legend-wrong", reply({ type: "score", score: 1.5, legend: { 0: "low", 1: "high", 2: "mid" }, confidence: 0.6, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } }), scoreReq], ["score-legend-short", reply({ type: "score", score: 1.5, legend: { 0: "low", 1: "mid" }, confidence: 0.6, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } }), scoreReq],
    ["score-not-the-expectation", reply({ type: "score", score: 1.6, legend: { 0: "low", 1: "mid", 2: "high" }, confidence: 0.6, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } }), scoreReq], ["score-above-the-levels", reply({ type: "score", score: 2.5, legend: { 0: "low", 1: "mid", 2: "high" }, confidence: 0.6, probabilities: { 0: 0, 1: 0, 2: 1 } }), scoreReq],
    ["score-as-array", reply({ type: "score", score: 1.5, legend: ["low", "mid", "high"], confidence: 0.6, probabilities: [0.1, 0.3, 0.6] }), scoreReq]];
  for (const [name, response, request] of bad) out.push({ name: `broken-${name}`, kind: "jev", ...(request ? { request } : {}), response });
  // Admission, privacy, identity.
  out.push({ name: "jev-not-cloud-eligible", kind: "jev", request: { context: { cloudEligible: false } } }, { name: "jev-force-local", kind: "jev", request: { context: { forceLocal: true } } }, { name: "jev-installation-local-only", kind: "jev", config: { privacy: { localOnly: true } } },
    { name: "jev-agent-lifts-local-only", kind: "jev", config: { privacy: { localOnly: true }, agents: { bernd: { privacy: { localOnly: false } } } }, response: reply({ type: "noul", noul: 0.8 }) }, { name: "kev-ignores-cloud-admission", kind: "kev", request: { context: { cloudEligible: false, forceLocal: true } }, config: { privacy: { localOnly: true } }, response: kreply({ type: "noul", noul: 0.25 }) },
    { name: "no-principal", kind: "jev", request: { context: { principal: undefined } } }, { name: "empty-principal", kind: "jev", request: { context: { principal: "" } } }, { name: "principal-from-chat", kind: "jev", request: { context: { principal: undefined, chat: { principal: "human:chat", projectId: "proj-1" } } }, response: reply({ type: "noul", noul: 0.8 }) },
    { name: "session-and-turn", kind: "jev", request: { context: { sessionId: "s1", turnId: "t1" } }, response: reply({ type: "noul", noul: 0.8 }) }, { name: "triage-compat", kind: "jev", request: { primitive: "triage-compat" } }, { name: "disabled", kind: "jev", settings: { enabled: false } }, { name: "enabled-not-true", kind: "jev", settings: { enabled: "true" } },
    { name: "jev-other-model", kind: "jev", settings: { model: "jev-1.14.0" } }, { name: "jev-no-secret", kind: "jev", settings: { secretRef: "" } }, { name: "no-budget", kind: "jev", noBudget: true }, { name: "kev-not-eligible", kind: "kev", kevEligible: false }, { name: "kev-no-eligibility-port", kind: "kev", kevEligible: null },
    ...["http://127.0.0.1:8080/v1/systemone", "https://127.9.9.9/v1/systemone", "http://[::1]:1/v1/systemone", "http://127.0.0.1:8080", "http://127.0.0.1:8080/", "http://127.0.0.1:8080/v1/systemone/", "http://localhost:8080/v1/systemone", "http://127.0.0.1.evil.test/v1/systemone", "http://128.0.0.1/v1/systemone",
      "http://127.0.0.1:99999/v1/systemone", "http://127.0.0.256/v1/systemone", "http://127.0.0.1:8080/v1/systemone?x=1", "http://user@127.0.0.1/v1/systemone", "HTTP://127.0.0.1/v1/systemone", "ftp://127.0.0.1/v1/systemone", "http://127.1/v1/systemone", "http://127.0.0.01/v1/systemone", "http://127.0.0.1:/v1/systemone", "http://127.0.0.0001/v1/systemone", " http://127.0.0.1/v1/systemone"]
      .map((endpoint): S1Step => ({ name: `kev-endpoint-${endpoint}`, kind: "kev", settings: { endpoint }, response: kreply({ type: "noul", noul: 0.25 }) })),
    ...["a", "A.b_c/d@e-1", "m".repeat(128), "m".repeat(129), "", "has space", "ümlaut", "semi;colon"].map((model): S1Step => ({ name: `kev-model-${model.length}-${model.slice(0, 12)}`, kind: "kev", settings: { model }, response: { status: 200, json: { model, answers: { decision: { type: "noul", noul: 0.25 } }, usage: { input_tokens: 1, output_tokens: 1 } } } })),
    ...[null, "http://127.0.0.1:9", "http://[::1]:9", "http://127.0.0.1:9/", "https://example.test", "http://127.0.0.1:9/v1/systemone"].map((testOrigin): S1Step => ({ name: `test-origin-${String(testOrigin)}`, kind: "jev", testOrigin, response: reply({ type: "noul", noul: 0.8 }) })));
  // The ports around the call: budget, lease, the live configuration, the request, cleanup.
  out.push({ name: "budget-refuses", kind: "jev", ports: { budget: "refuse" } }, { name: "body-at-the-cap", kind: "jev", request: { state: "s".repeat(16_384), question: "q".repeat(2048), features: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`f${i}`, "t".repeat(1024)])) }, response: reply({ type: "noul", noul: 0.8 }) },
    { name: "body-over-the-cap", kind: "jev", request: { state: "😀".repeat(8192), question: "q".repeat(2048), features: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`f${i}`, "😀".repeat(512)])) }, response: reply({ type: "noul", noul: 0.8 }) },
    { name: "lease-fails", kind: "jev", ports: { lease: "throw" } }, { name: "lease-wrong-purpose", kind: "jev", ports: { leasePurpose: "chat" } }, { name: "lease-wrong-profile", kind: "jev", ports: { leaseProfile: "someone-else" } }, { name: "lease-empty-value", kind: "jev", ports: { leaseValue: [] } },
    { name: "lease-value-with-a-line-break", kind: "jev", ports: { leaseValue: ["abc", "\r\n", "x-injected: 1"] } }, { name: "lease-value-with-nul", kind: "jev", ports: { leaseValue: ["abc", "\u0000"] } }, { name: "lease-value-too-long", kind: "jev", ports: { leaseValue: ["v".repeat(4097)] } }, { name: "lease-value-at-the-limit", kind: "jev", ports: { leaseValue: ["v".repeat(4096)] }, response: reply({ type: "noul", noul: 0.8 }) },
    { name: "read-lease-fails", kind: "jev", ports: { readLease: "throw" } }, { name: "revoke-fails-after-success", kind: "jev", ports: { revoke: "throw" }, response: reply({ type: "noul", noul: 0.8 }) }, { name: "settle-fails-after-success", kind: "jev", ports: { settle: "throw" }, response: reply({ type: "noul", noul: 0.8 }) },
    { name: "release-fails", kind: "jev", ports: { lease: "throw", release: "throw" } }, { name: "settle-and-revoke-fail", kind: "jev", ports: { settle: "throw", revoke: "throw" }, response: reply({ type: "noul", noul: 0.8 }) },
    { name: "configuration-withdrawn-during-the-lease", kind: "jev", ports: { duringLease: { enabled: false } } }, { name: "secret-changed-during-the-lease", kind: "jev", ports: { duringLease: { secretRef: "other" } } }, { name: "local-only-switched-on-during-the-lease", kind: "jev", ports: { duringLease: { localOnly: true } } },
    { name: "deadline-passes-during-the-lease", kind: "jev", ports: { leaseAdvance: 500 } }, { name: "cancelled-during-the-lease", kind: "jev", ports: { leaseAbort: true } }, { name: "lease-ttl-is-the-rest-of-the-deadline", kind: "jev", request: { deadline: 1250.25 }, response: reply({ type: "noul", noul: 0.8 }) },
    { name: "lease-ttl-is-capped", kind: "jev", request: { deadline: 1000 + 120_000 }, response: reply({ type: "noul", noul: 0.8 }) }, { name: "deadline-already-passed", kind: "jev", request: { deadline: 1000 } }, { name: "cancelled-before", kind: "jev", ports: { abortedBefore: true } },
    { name: "http-times-out", kind: "jev", ports: { http: "timeout" } }, { name: "http-fails", kind: "jev", ports: { http: "throw" } }, { name: "http-fails-after-the-deadline", kind: "jev", ports: { http: "throw", httpAdvance: 500 } }, { name: "cancelled-during-http", kind: "jev", ports: { http: "throw", httpAbort: true } },
    { name: "answer-after-the-deadline", kind: "jev", ports: { httpAdvance: 500 }, response: reply({ type: "noul", noul: 0.8 }) }, { name: "kev-http-times-out", kind: "kev", ports: { http: "timeout" } }, { name: "usage-reported-on-an-invalid-answer", kind: "jev", response: reply({ type: "noul", noul: 7 }, { usage: { input_tokens: 33, output_tokens: 4 } }) });
  return out;
}
async function systemOneVectors() {
  const t = new Texts();
  const cases = [];
  for (const k of systemOneCases()) {
    clock.t = 1000;
    const controller = new AbortController();
    if (k.ports?.abortedBefore) controller.abort();
    const calls: Any[] = [];
    const base: Any = k.kind === "jev" ? { enabled: true, model: "jev-1.13.0", secretRef: "decision-key" } : { enabled: true, model: "kev-local/1.0", endpoint: "http://127.0.0.1:8080/v1/systemone" };
    const config: Any = { decision: { systemOne: { [k.kind]: { ...base, ...(k.settings ?? {}) } } }, ...(k.config ?? {}) };
    const during = () => { const d = k.ports?.duringLease; if (!d) return; if (d.localOnly) config.privacy = { localOnly: true }; else Object.assign(config.decision.systemOne[k.kind], d); };
    const value = (k.ports?.leaseValue ?? SECRET_PARTS).join("");
    const secrets = {
      async lease(_p: Any, name: string, o: Any) { calls.push(["secrets.lease", name, o]); clock.t += k.ports?.leaseAdvance ?? 0; if (k.ports?.leaseAbort) controller.abort(); during(); if (k.ports?.lease === "throw") throw new Error("no lease"); return { leaseId: "lease-1" }; },
      readLease(_p: Any, id: string) { calls.push(["secrets.readLease", id]); if (k.ports?.readLease === "throw") throw new Error("gone"); return { purpose: k.ports?.leasePurpose ?? "decision", profileId: k.ports?.leaseProfile ?? "decision-service", value }; },
      revokeLease(_p: Any, id: string) { calls.push(["secrets.revokeLease", id]); if (k.ports?.revoke === "throw") throw new Error("revoke"); return true; },
    };
    const budget = k.noBudget ? null : {
      checkBeforeCall(call: Any) { calls.push(["budget.checkBeforeCall", call]); return k.ports?.budget === "refuse" ? { kind: "refuse" } : { kind: "allow", reservationId: "res-1" }; },
      settle(id: string, usage: Any) { calls.push(["budget.settle", id, usage]); if (k.ports?.settle === "throw") throw new Error("settle"); },
      releaseUnused(id: string) { calls.push(["budget.releaseUnused", id]); if (k.ports?.release === "throw") throw new Error("release"); },
    };
    const egress = { async request(url: string, o: Any) {
      const { signal: _signal, acceptType, headers, body, ...rest } = o;
      const authorization = headers.authorization as string | undefined;
      calls.push(["egress.request", { url, ...rest, body, bytes: Buffer.byteLength(body), headers: { ...headers, ...(authorization ? { authorization: { parts: authorization === `Bearer ${value}` ? ["Bearer ", ...(k.ports?.leaseValue ?? SECRET_PARTS)] : ["?"] } } : {}) },
        accepts: ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON \t;", "application/jsonp", "text/json", "application/json+x", undefined, "", " application/json"].map((type) => [type ?? null, acceptType(type)]) }]);
      clock.t += k.ports?.httpAdvance ?? 0;
      if (k.ports?.httpAbort) controller.abort();
      if (k.ports?.http === "timeout") throw new WebFailure("timeout" as never, "timed out");
      if (k.ports?.http === "throw") throw new Error("connection refused");
      const r = k.response ?? { status: 200, json: {} };
      return { status: r.status, body: Buffer.from(r.text ?? JSON.stringify(r.json)) };
    } };
    const { context: contextOver, ...requestOver } = k.request ?? {};
    const context = { agentId: "bernd", principal: "human:1", cloudEligible: true, signal: controller.signal, ...(contextOver ?? {}) };
    const request = { requestId: "id-1", primitive: "noul", deadline: 1200, useCase: "routing", state: "the state", question: "Is it?", ...requestOver, context };
    const { signal: _s, ...plainContext } = context;
    const record: Any = { name: k.name, kind: k.kind, config: t.enc(structuredClone(config)), request: t.enc(ordered({ ...request, context: plainContext })), ports: k.ports ?? {}, ...(k.response ? { response: t.enc(k.response) } : {}), testOrigin: k.testOrigin ?? null, kevEligible: k.kevEligible === undefined ? true : k.kevEligible, noBudget: k.noBudget === true };
    try {
      const backend = createSystemOneBackend(k.kind, { config: () => config, egress: egress as Any, secrets: secrets as Any, budget: budget as Any, ...(k.testOrigin ? { testOrigin: k.testOrigin } : {}), ...(k.kevEligible === null ? {} : { kevEligible: () => k.kevEligible !== false }) });
      record.local = backend.local(context as Any) ?? null;
      record.eligible = backend.eligible!(context as Any);
      try { const v = await backend.run(request as Any, controller.signal); record.json = JSON.stringify(v); } catch (e) { record.error = reasonOf(e); }
    } catch (e) { record.constructError = reasonOf(e); }
    record.calls = t.enc(calls);
    cases.push(record);
  }
  return { ...t.tables(), secret: { parts: SECRET_PARTS }, cases };
}

export async function buildDecisionVectors() {
  const realNow = performance.now;
  performance.now = () => clock.t;
  try {
    const t = new Texts();
    const scenarios = [];
    for (const s of clientScenarios()) scenarios.push(await runClientScenario(t, s));
    return { client: { ...t.tables(), scenarios }, skills: await skillVectors(), adapters: await adapterVectors(), role: await roleVectors(), "system-one": await systemOneVectors() };
  } finally { performance.now = realNow; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await exporterMain({ area: "decision", build: buildDecisionVectors }));
