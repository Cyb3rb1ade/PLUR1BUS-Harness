// Parity vectors (mode V) for message triage (P4-K K9a, plan P4-42): `packages/core/src/triage/`. A decision is
// recorded as the text `JSON.stringify` gives, so member order, numbers and offsets (UTF-16 code units) are compared
// to the letter; a classifier's answer is given as JSON text, so both sides parse the same bytes.
// `crates/plur1bus-core/src/triage/vectors.rs` replays every case. Recorded, never edited by hand.
//
// A number JSON cannot hold is `{ "$num": "NaN" }` and the like. An error is `{ message, type }`; where TypeScript fails
// with a `TypeError` of the engine (a task without a class distribution) only the type is compared.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-triage.ts [--check]
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLASS_TABLE, MODEL_CLASSES, applyAtBoundary, chooseClass, escalate, loadClassProfiles, resolveClass, ruleClassifier, triage, triageWithClassifier,
  type CostPreference, type ModelClass, type TriageDecision } from "../../packages/core/src/triage/index.ts";
import { evaluateMessages, type MessageEvalCase } from "../../packages/core/src/triage/message-eval.ts";
import { MessageTriage } from "../../packages/core/src/triage/runtime.ts";
import { exporterMain } from "./lib.mjs";

const COSTS: CostPreference[] = ["economy", "balanced", "quality"];
const num = (v: unknown): unknown => (typeof v === "number" && (!Number.isFinite(v) || Object.is(v, -0)) ? { $num: Object.is(v, -0) ? "-0" : String(v) } : v);
const failure = (e: unknown) => ({ error: { message: (e as Error).message, type: (e as Error).constructor.name } });

// --- classes ------------------------------------------------------------------------------------------------------------------
function classVectors() {
  const dists: string[] = [
    '{"small":0.85,"medium":0.1,"large":0.04,"frontier":0.01}', '{"small":0.1,"medium":0.75,"large":0.12,"frontier":0.03}', '{"small":0,"medium":0.1,"large":0.85,"frontier":0.05}',
    '{"small":1,"medium":0,"large":0,"frontier":0}', '{"small":0,"medium":1,"large":0,"frontier":0}', '{"small":0,"medium":0,"large":1,"frontier":0}', '{"small":0,"medium":0,"large":0,"frontier":1}',
    '{"small":0.25,"medium":0.25,"large":0.25,"frontier":0.25}', '{"frontier":0.01,"large":0.04,"medium":0.1,"small":0.85}', '{"small":0.85,"medium":0.1,"large":0.04,"frontier":0.01,"extra":9}',
    // The tail above a class exactly at, just below and just above each threshold (0.35, 0.2, 0.1), and the 1e-10 slack.
    ...[0.35, 0.2, 0.1].flatMap((t) => [t, t - 1e-9, t + 1e-9, t + 1e-10, t + 5e-11, t + 2e-10].flatMap((tail) => [
      `{"small":${1 - tail},"medium":${tail},"large":0,"frontier":0}`, `{"small":${1 - tail},"medium":0,"large":0,"frontier":${tail}}`, `{"small":0,"medium":${1 - tail},"large":${tail / 2},"frontier":${tail / 2}}`])),
    '{"small":0.3,"medium":0.3,"large":0.3,"frontier":0.1}', '{"small":0.5,"medium":0.15,"large":0.25,"frontier":0.1}', '{"small":0.6,"medium":0.05,"large":0.25,"frontier":0.1}',
    // Malformed: the sum off by more and by less than 1e-6, negative, missing, not a number.
    '{"small":0.5,"medium":0.5,"large":0.000001,"frontier":0}', '{"small":0.5,"medium":0.5,"large":0.0000011,"frontier":0}', '{"small":0.5,"medium":0.5,"large":0,"frontier":-0.0000009}', '{"small":0.4999995,"medium":0.5,"large":0,"frontier":0}',
    '{"small":0.4999989,"medium":0.5,"large":0,"frontier":0}', '{"small":1.1,"medium":-0.1,"large":0,"frontier":0}', '{"small":1,"medium":0,"large":0}', '{"small":"1","medium":0,"large":0,"frontier":0}', '{"small":1,"medium":null,"large":0,"frontier":0}',
    '{}', '[]', '"small"', '5', 'true', 'null', '[1,0,0,0]', '{"small":1,"medium":0,"large":0,"frontier":0,"__proto__":{"small":9}}',
  ];
  const confidences: unknown[] = [undefined, 1, 0.5, 0.49999999, 0.4999, 0, 0.99, -0, -0.0001, 1.0001, NaN, Infinity, null, "0.9", true];
  const choose: unknown[] = [];
  for (const distJson of dists) {
    for (const cost of COSTS) {
      for (const confidence of confidences) {
        // Most confidences only matter for a few distributions; the full cross would be 6,000 cases.
        if (confidence !== undefined && confidence !== 0.4999 && confidence !== 0.5 && dists.indexOf(distJson) > 12) continue;
        const args: unknown[] = [JSON.parse(distJson), cost, ...(confidence === undefined ? [] : [confidence])];
        const base = { distJson, cost, ...(confidence === undefined ? {} : { confidence: num(confidence) }) };
        try { choose.push({ ...base, result: (chooseClass as (...a: unknown[]) => ModelClass)(...args) }); } catch (e) { choose.push({ ...base, ...failure(e) }); }
      }
    }
  }
  const escalation = MODEL_CLASSES.flatMap((current) => [false, true].map((flag) => ({ current, flag, result: escalate(current, flag) })));
  const boundary = MODEL_CLASSES.flatMap((current) => MODEL_CLASSES.flatMap((recommended) => [false, true].map((at) => ({ current, recommended, at, result: applyAtBoundary(current, recommended, at) }))));
  const providerLists = [["anthropic"], ["openai", "anthropic"], ["anthropic", "openai"], ["deepseek", "google"], ["unknown", "anthropic"], ["toString", "constructor", "__proto__", "hasOwnProperty"], [], ["local"], ["ollama", "local", "anthropic"], ["Anthropic"]];
  const allowedSets = [[], ["anthropic:haiku"], ["anthropic:sonnet", "openai:general"], ["openai:frontier", "anthropic:frontier"], ["anthropic:opus", "google:pro", "deepseek:reasoner"], ["anthropic: haiku", "Anthropic:haiku", "anthropic:haiku "], ["deepseek:frontier", "google:frontier"],
    ...Object.entries(CLASS_TABLE).map(([family, row]) => Object.values(row).map((profile) => `${family}:${profile}`))];
  const resolve = MODEL_CLASSES.flatMap((modelClass) => providerLists.flatMap((providers) => allowedSets.map((allowed) => ({ modelClass, providers, allowed, result: resolveClass(modelClass, providers, new Set(allowed)) ?? null }))));
  const dir = mkdtempSync(join(tmpdir(), "k9a-classes-"));
  const texts: Array<string | null> = [null, '{"small":"fast"}', '{"large":"opus","small":"haiku","medium":"sonnet","frontier":"best"}', "{}", '{"small":""}', '{"small":"   "}', '{"small":" x "}', `{"small":"${"p".repeat(128)}"}`, `{"small":"${"p".repeat(129)}"}`,
    `{"small":"${"😀".repeat(64)}"}`, `{"small":"${"😀".repeat(65)}"}`, '{"tiny":"x"}', '{"small":5}', '{"small":null}', "[]", "null", '"small"', "5", "not json", "", '{"small":"a","small":"b"}', '{"small":"\\u00a0"}', '{"small":"\\ufeff"}', '{"small":"\\u0085"}'];
  const fallback = { small: "fallback-small" };
  const profiles = texts.map((text, i) => {
    const path = join(dir, `profiles-${i}.json`);
    if (text !== null) writeFileSync(path, text);
    try { return { text, fallback: Object.entries(fallback), result: Object.entries(loadClassProfiles(path, fallback)) }; } catch (e) { return { text, fallback: Object.entries(fallback), ...failure(e) }; }
  });
  rmSync(dir, { recursive: true, force: true });
  return { classes: [...MODEL_CLASSES], table: Object.entries(CLASS_TABLE).map(([family, row]) => [family, Object.entries(row)]), choose, escalation, boundary, resolve, profiles };
}

// --- the rule classifier ------------------------------------------------------------------------------------------------------
const KEYWORDS = ["search", "research", "review", "reviews", "find online", "suche", "recherch", "bewertungen", "browser", "browse", "scroll", "navigate", "website", "webseite", "scrolle", "navigiere", "report", "pdf", "document", "bericht",
  "dokument", "write", "schreibe", "erstelle", "debug", "code", "implement", "fix", "test", "fehler", "programmiere", "audit", "prüfe", "file", "files", "datei", "ordner", "move", "verschiebe", "system", "disk", "process", "install", "speicher",
  "prozess", "data", "analyse", "analyze", "daten", "email", "mail", "message", "nachricht", "image", "photo", "bild", "foto", "memory", "remember", "recall", "erinnere", "gedächtnis", "architecture", "architect", "security", "proof",
  "distributed", "sicherheit", "architektur", "beweis"];
function ruleMessages(): string[] {
  const out: string[] = [];
  for (const k of KEYWORDS) out.push(`please ${k} this`, `${k.toUpperCase()}`, `x${k} un${k}`, `${k}ing_1 now`, `(${k})`);
  out.push("", "   ", "\n\t", "hi", "Hi!", "HELLO . !", "hallo\n", "  danke!!  ", "thanks...", "hi there", "hithere", "thanks a lot", "hi !", "hı", "ok", "yes", "weiter",
    "PRÜFE das", "prüfe: jetzt", "prufe das", "prüfe das", "Gedächtnis leeren", "GEDÄCHTNIS", "ſearch the web", "Kode", "codeK", "re​view this", "a review.", "reviewed it", "an audit", "auditing", "audit_x", "prüfen",
    "review the image code", "debug the photo", "search and review the report", "write a report and email it", "aäfile b", "üfile", "fileü", "the files-manager", "my-file", "file's", "9file", "_file", "file_",
    "what time is it", "tell me a joke about cats", "42", "😀", "😀 code 😀", "日本語のコード", "design the security architecture", "Beweis der Sicherheit", "architects love proofs", "distributed data analysis",
    "fix the bug; then write the report", "fix the bug;then write the report", "fix the bug ; danach bericht", "a;b", "a ; b", "a;;b", ";", ";;;", "; then", "then; then", "a; then\tb", "a; then b", "a; then\nb", "a; thenb", "a; anschließend b",
    "a; ANSCHLIEßEND b", "a; ANSCHLIESSEND b", "a; Danach b", "a;  \t danach   b", "first\nsecond", "first\n\nsecond", "first\n- second\n* third", "first\n1. second\n2) third\n33.fourth", "first\n1 second", "first\n-second", "first\n -second", "first\n1.\tsecond",
    "\n- only", "- only", "1. only", "a\n\n\n", "\n\n\n", "a\r\nb", "a\rb", "a b", "do x and then do y", "do x AND THEN do y", "do x und danach y", "do x then y", "do x, then y", "then do x", "do x then", "do x then ", "x then\ny", "x\nthen y", "x\tthen\ty",
    "x then y", "x　danach　y", "x thenceforth y", "x  then  y  then  z", "x and y", "x und y", "x and  then y", "x andthen y", "x and then", "athen b", "x danach", "😀 then 😀; 🎉\n- 日本 then code", "  leading and trailing  ", " a ; b ",
    "search; then review\n- image and then prüfe", "do a; do b; do c; do d", "write code then test code then review code", "k1 then k2", "A;B;C;D;E;F;G;H;I;J;K;L;M;N;O;P;Q;R;S;T;U;V;W;X;Y;Z;a;b;c;d;e;f;g;h", "implement oauth\tand then\taudit it");
  return out;
}
function ruleVectors() {
  const cases = ruleMessages().flatMap((message) => COSTS.map((cost) => ({ message, cost, json: JSON.stringify(ruleClassifier({ message, cost })) })));
  return { cases };
}

// --- triage(): validation of a classifier's decision --------------------------------------------------------------------------
const MESSAGE = "fix the bug 😀 and then write the report";
const task = (over: Record<string, unknown> = {}) => ({ id: "k1", summary: "fix the bug", start: 0, end: 11, categories: { "code.edit": 1 }, modelClass: { small: 0.1, medium: 0.75, large: 0.12, frontier: 0.03 }, chosenClass: "small", effort: "low", dependsOn: [], confidence: 0.9, reason: "test", ...over });
const second = (over: Record<string, unknown> = {}) => task({ id: "k2", summary: "write the report", start: 24, end: 40, categories: { "docs.create": 0.6, "comm.email": 0.4 }, dependsOn: ["k1"], ...over });
const decision = (tasks: unknown[], over: Record<string, unknown> = {}) => ({ schema: "plur1bus.triage/1", shape: tasks.length > 1 ? "multi" : "single", tasks, ...over });
function without(o: Record<string, unknown>, key: string) { const { [key]: _drop, ...rest } = o; return rest; }
function triageVectors() {
  const answers: Array<[string, unknown]> = [
    ["valid-single", decision([task()])], ["valid-multi", decision([task(), second()])], ["chat", decision([], { shape: "chat" })], ["followup", decision([], { shape: "followup" })], ["single-without-tasks", decision([])],
    ["unknown-members-survive", decision([task({ extra: { nested: [1, 2] }, zeta: null })], { note: "kept", alpha: 1 })], ["chosen-class-is-recomputed", decision([task({ chosenClass: "frontier" })])], ["chosen-class-is-added", decision([without(task(), "chosenClass")])],
    ["low-confidence-raises", decision([task({ confidence: 0.49 })])], ["confidence-missing-is-one", decision([without(task(), "confidence")])], ["confidence-null", decision([task({ confidence: null })])], ["confidence-string", decision([task({ confidence: "0.9" })])],
    ["confidence-above-one", decision([task({ confidence: 1.01 })])], ["model-class-missing", decision([without(task(), "modelClass")])], ["model-class-null", decision([task({ modelClass: null })])], ["model-class-string", decision([task({ modelClass: "large" })])],
    ["model-class-array", decision([task({ modelClass: [0.1, 0.75, 0.12, 0.03] })])], ["model-class-sum", decision([task({ modelClass: { small: 0.5, medium: 0.5, large: 0.1, frontier: 0 } })])],
    ["wrong-schema", decision([task()], { schema: "plur1bus.triage/2" })], ["no-schema", without(decision([task()]), "schema")], ["unknown-shape", decision([task()], { shape: "batch" })], ["shape-number", decision([task()], { shape: 1 })],
    ["tasks-missing", without(decision([task()]), "tasks")], ["tasks-object", decision([task()], { tasks: { 0: task() } })], ["tasks-null", decision([], { tasks: null })], ["answer-null", null], ["answer-array", [decision([task()])]], ["answer-string", "chat"], ["answer-number", 7],
    ["task-null", decision([null])], ["task-number", decision([5])], ["task-string", decision(["k1"])], ["task-array", decision([[task()]])],
    ["start-fraction", decision([task({ start: 0.5 })])], ["end-fraction", decision([task({ end: 10.5 })])], ["start-string", decision([task({ start: "0" })])], ["start-negative", decision([task({ start: -1, end: 5 })])], ["start-missing", decision([without(task(), "start")])],
    ["end-at-length", decision([task({ end: MESSAGE.length })])], ["end-past-length", decision([task({ end: MESSAGE.length + 1 })])], ["end-equals-start", decision([task({ start: 4, end: 4 })])], ["end-before-start", decision([task({ start: 5, end: 4 })])],
    ["end-unsafe", decision([task({ end: 2 ** 53 })])], ["overlap", decision([task(), second({ start: 10 })])], ["touching", decision([task(), second({ start: 11 })])], ["out-of-order", decision([second({ dependsOn: [] }), task()])],
    ["id-empty", decision([task({ id: "" })])], ["id-number", decision([task({ id: 1 })])], ["id-duplicate", decision([task(), second({ id: "k1", dependsOn: [] })])], ["effort-unknown", decision([task({ effort: "max" })])], ["effort-missing", decision([without(task(), "effort")])],
    ["reason-missing", decision([without(task(), "reason")])], ["reason-empty", decision([task({ reason: "" })])], ["reason-number", decision([task({ reason: 1 })])], ["summary-empty", decision([task({ summary: "" })])], ["summary-missing", decision([without(task(), "summary")])],
    ["summary-number", decision([task({ summary: 7 })])], ["summary-zero", decision([task({ summary: 0 })])], ["depends-missing", decision([without(task(), "dependsOn")])], ["depends-string", decision([task({ dependsOn: "k0" })])], ["depends-unknown", decision([task({ dependsOn: ["k9"] })])],
    ["depends-self", decision([task({ dependsOn: ["k1"] })])], ["depends-later", decision([task({ dependsOn: ["k2"] }), second()])], ["depends-number", decision([task(), second({ dependsOn: [1] })])], ["depends-twice", decision([task(), second({ dependsOn: ["k1", "k1"] })])],
    ["categories-missing", decision([without(task(), "categories")])], ["categories-null", decision([task({ categories: null })])], ["categories-array", decision([task({ categories: ["code.edit"] })])], ["categories-string", decision([task({ categories: "code.edit" })])],
    ["categories-empty", decision([task({ categories: {} })])], ["categories-three", decision([task({ categories: { "a.b": 0.5, "c.d": 0.25, "e-f.g-h": 0.25 } })])], ["categories-four", decision([task({ categories: { "a.b": 0.25, "c.d": 0.25, "e.f": 0.25, "g.h": 0.25 } })])],
    ["category-sum-within", decision([task({ categories: { "a.b": 0.5, "c.d": 0.4999995 } })])], ["category-sum-outside", decision([task({ categories: { "a.b": 0.5, "c.d": 0.4999985 } })])], ["category-negative", decision([task({ categories: { "a.b": 1.5, "c.d": -0.5 } })])],
    ["category-string-value", decision([task({ categories: { "a.b": "1" } })])], ...["Code.edit", "code", "code.", ".edit", "code.edit.x", "1code.edit", "code.1edit", "code_x.edit", "code.édit", "code.edit ", "c0-d.e1-f", "a.b"].map((id): [string, unknown] => [`category-id-${JSON.stringify(id)}`, decision([task({ categories: { [id]: 1 } })])]),
    ["thirty-three-tasks", decision(Array.from({ length: 33 }, (_, i) => task({ id: `t${i}`, start: i, end: i + 1 })))],
  ];
  const cases: unknown[] = [];
  for (const [name, answer] of answers) {
    for (const cost of [undefined, "economy", "quality"] as const) {
      const classifiedJson = JSON.stringify(answer);
      const base = { name, message: MESSAGE, classifiedJson, ...(cost ? { cost } : {}) };
      try { cases.push({ ...base, json: JSON.stringify(triage(MESSAGE, { classifier: () => JSON.parse(classifiedJson) as TriageDecision, ...(cost ? { cost } : {}) })) }); } catch (e) { cases.push({ ...base, ...failure(e) }); }
    }
  }
  // Follow-ups: only with an active task, only the closed set of words; and the rule classifier through triage().
  for (const message of ["yes", "Yes!", "  ok. ", "ja", "weiter!!", "genau", "continue", "no", "nein\n", "yes please", "okay", "ok then", "", "ja !", "YES . ! .", "fix the bug", "hi", "code; then test"]) {
    for (const activeTask of [undefined, "k1", ""]) {
      for (const classified of [undefined, decision([task({ end: Math.max(1, Math.min(11, message.length)) })])]) {
        const classifiedJson = classified === undefined ? undefined : JSON.stringify(classified);
        const base = { name: "followup", message, ...(activeTask !== undefined ? { activeTask } : {}), ...(classifiedJson ? { classifiedJson } : {}) };
        try { cases.push({ ...base, json: JSON.stringify(triage(message, { ...(classifiedJson ? { classifier: () => JSON.parse(classifiedJson) as TriageDecision } : {}), ...(activeTask !== undefined ? { activeTask } : {}) })) }); } catch (e) { cases.push({ ...base, ...failure(e) }); }
      }
    }
  }
  return { cases };
}

// --- the runtime --------------------------------------------------------------------------------------------------------------
type Answer = { json: string } | "fail" | "hang" | "abort-before" | "abort-during";
interface Decide { message: string; scope: string; answer: Answer; cost?: CostPreference; task?: { id: string; atBoundary: boolean }; timeoutMs?: number }
const single = (message: string, over: Record<string, unknown> = {}) => JSON.stringify(decision([task({ summary: message, end: message.length, ...over })]));
const large = { small: 0, medium: 0.1, large: 0.85, frontier: 0.05 };
async function runtimeVectors() {
  const valid = single("do it");
  const scripts: Array<{ name: string; steps: Array<Decide | { fill: number; answer: string }> }> = [
    { name: "class-and-effort-stay-until-a-boundary", steps: [
      { message: "do it", scope: "a", answer: { json: single("do it", { modelClass: large, effort: "high" }) }, task: { id: "t1", atBoundary: true } },
      { message: "do it", scope: "a", answer: { json: valid }, task: { id: "t1", atBoundary: false } }, { message: "do it", scope: "a", answer: { json: valid }, task: { id: "t2", atBoundary: true } },
      { message: "do it", scope: "a", answer: { json: single("do it", { modelClass: large, effort: "high" }) } }, { message: "do it", scope: "b", answer: { json: valid }, task: { id: "t9", atBoundary: false } },
      { message: "ok", scope: "a", answer: { json: JSON.stringify(decision([], { shape: "followup" })) } }, { message: "ok", scope: "never", answer: { json: JSON.stringify(decision([], { shape: "followup" })) } },
      { message: "hi", scope: "a", answer: { json: JSON.stringify(decision([], { shape: "chat" })) } }, { message: "ok", scope: "a", answer: "fail" }, { message: "fix it", scope: "a", answer: "fail", task: { id: "", atBoundary: true } }, { message: "ok", scope: "a", answer: "fail" }] },
    { name: "highest-class-wins-earlier-among-equals", steps: [
      { message: MESSAGE, scope: "m", answer: { json: JSON.stringify(decision([task({ effort: "low" }), second({ modelClass: large, effort: "high" })])) } },
      { message: MESSAGE, scope: "n", answer: { json: JSON.stringify(decision([task({ effort: "medium" }), second({ effort: "high" })])) } }, { message: MESSAGE, scope: "n", answer: { json: JSON.stringify(decision([task(), second()])) }, cost: "quality" },
      { message: MESSAGE, scope: "n", answer: { json: JSON.stringify(decision([task(), second()])) }, cost: "economy" }] },
    { name: "fallbacks", steps: [
      { message: "debug the code; then write a report", scope: "f", answer: "fail" }, { message: "debug the code", scope: "f", answer: "hang", timeoutMs: 5 }, { message: "debug the code", scope: "f", answer: { json: "{}" } }, { message: "debug the code", scope: "f", answer: { json: "null" } },
      { message: "do it", scope: "f", answer: { json: JSON.stringify(decision([task()], { shape: "multi" })) } }, { message: MESSAGE, scope: "f", answer: { json: JSON.stringify(decision([task(), second()], { shape: "single" })) } },
      { message: "do it", scope: "f", answer: { json: JSON.stringify(decision([task({ end: 5 })], { shape: "chat" })) } }, { message: "do it", scope: "f", answer: { json: JSON.stringify(decision([task({ end: 5 })], { shape: "followup" })) } },
      { message: "do it", scope: "f", answer: { json: JSON.stringify(decision([], { shape: "single" })) } }, { message: "do it", scope: "f2", answer: { json: JSON.stringify(decision([], { shape: "multi" })) } },
      { message: "x".repeat(40), scope: "f", answer: { json: JSON.stringify(decision(Array.from({ length: 32 }, (_, i) => task({ id: `t${i}`, start: i, end: i + 1 })))) } },
      { message: "x".repeat(40), scope: "f", answer: { json: JSON.stringify(decision(Array.from({ length: 33 }, (_, i) => task({ id: `t${i}`, start: i, end: i + 1 })))) } }, { message: ";", scope: "f3", answer: "fail" }, { message: "", scope: "f3", answer: "fail" },
      { message: "hi", scope: "f3", answer: "fail", cost: "quality" }, { message: "what is this", scope: "f3", answer: "fail", cost: "economy" }] },
    { name: "cancellation", steps: [{ message: "do it", scope: "c", answer: "abort-before" }, { message: "do it", scope: "c", answer: "abort-during" }, { message: "do it", scope: "c", answer: { json: valid } }] },
    { name: "the-oldest-scope-is-forgotten", steps: [{ fill: 1025, answer: single("do it", { modelClass: large, effort: "high" }) }, { message: "ok", scope: "s0", answer: { json: JSON.stringify(decision([], { shape: "followup" })) } },
      { message: "ok", scope: "s1", answer: { json: JSON.stringify(decision([], { shape: "followup" })) } }, { message: "ok", scope: "s1024", answer: "fail" }, { message: "ok", scope: "s2", answer: "fail" }] },
  ];
  const scenarios = [];
  for (const script of scripts) {
    const runtime = new MessageTriage();
    const steps = [];
    for (const step of script.steps) {
      if ("fill" in step) {
        const lines: string[] = [];
        for (let i = 0; i < step.fill; i += 1) lines.push(JSON.stringify(await runtime.decide("do it", `s${i}`, async () => JSON.parse(step.answer) as TriageDecision, { signal: new AbortController().signal })));
        steps.push({ ...step, digest: createHash("sha256").update(lines.join("\n")).digest("hex") });
        continue;
      }
      const controller = new AbortController();
      if (step.answer === "abort-before") controller.abort();
      let fallbacks = 0;
      const classify = async (): Promise<TriageDecision> => {
        if (step.answer === "fail") throw new Error("classifier down");
        if (step.answer === "hang") return new Promise<TriageDecision>(() => {});
        if (step.answer === "abort-during") { controller.abort(); return JSON.parse(valid) as TriageDecision; }
        return JSON.parse((step.answer as { json: string }).json) as TriageDecision;
      };
      try {
        const r = await runtime.decide(step.message, step.scope, classify, { signal: controller.signal, onFallback: () => { fallbacks += 1; }, ...(step.cost ? { cost: step.cost } : {}), ...(step.task ? { task: step.task } : {}), ...(step.timeoutMs ? { timeoutMs: step.timeoutMs } : {}) });
        const { decision: d, ...rest } = r;
        steps.push({ ...step, result: { ...rest, decisionJson: JSON.stringify(d) }, json: JSON.stringify(r), fallbacks });
      } catch (e) { steps.push({ ...step, aborted: (e as Error).name === "AbortError", fallbacks }); }
    }
    scenarios.push({ name: script.name, steps });
  }
  return { scenarios };
}

// --- evaluation against gold ----------------------------------------------------------------------------------------------------
async function evalVectors() {
  const message = "aaa bbb";
  const gold = (minimumClass: ModelClass, category = "general.chat") => [{ start: 0, end: 3, category, minimumClass }];
  const good = JSON.stringify(decision([task({ summary: "aaa", end: 3, categories: { "general.chat": 1 }, modelClass: { small: 0.85, medium: 0.1, large: 0.04, frontier: 0.01 } })]));
  const extra = JSON.stringify(decision([task({ summary: "aaa", end: 3, categories: { "general.chat": 1 }, modelClass: { small: 0.85, medium: 0.1, large: 0.04, frontier: 0.01 } }), task({ id: "k2", summary: "bbb", start: 4, end: 7 })]));
  const shifted = JSON.stringify(decision([task({ summary: "aa", end: 2, categories: { "general.chat": 1 } })]));
  const invalid = JSON.stringify(decision([task({ end: 99 })]));
  const sets: Array<{ name: string; n: number; answer: (i: number) => string | null; need?: (i: number) => ModelClass; category?: string }> = [
    { name: "all-good-60", n: 60, answer: () => good }, { name: "all-good-59", n: 59, answer: () => good }, { name: "none", n: 0, answer: () => good },
    { name: "extra-13-of-60", n: 60, answer: (i) => (i < 13 ? extra : good) }, { name: "extra-14-of-60", n: 60, answer: (i) => (i < 14 ? extra : good) },
    { name: "under-3-of-60", n: 60, answer: () => good, need: (i) => (i < 3 ? "medium" : "small") }, { name: "under-4-of-60", n: 60, answer: () => good, need: (i) => (i < 4 ? "frontier" : "small") },
    { name: "one-rejects", n: 60, answer: (i) => (i === 7 ? null : good) }, { name: "one-invalid", n: 60, answer: (i) => (i === 7 ? invalid : good) }, { name: "shifted-spans", n: 60, answer: (i) => (i < 5 ? shifted : good) },
    { name: "wrong-category", n: 60, answer: () => good, category: "code.edit" }, { name: "all-reject", n: 61, answer: () => null }, { name: "prototype-category", n: 60, answer: () => good, category: "toString" },
  ];
  const out = [];
  for (const set of sets) {
    const cases: MessageEvalCase[] = Array.from({ length: set.n }, (_, i) => ({ id: `m${i}`, message, gold: gold(set.need?.(i) ?? "small", set.category) }));
    const answers = cases.map((_, i) => set.answer(i));
    const result = await evaluateMessages(cases, async (row) => { const a = answers[Number(row.id.slice(1))]; if (a === null || a === undefined) throw new Error("rejected"); return JSON.parse(a) as TriageDecision; });
    out.push({ name: set.name, message, golds: cases.map((c) => c.gold), answers, result, json: JSON.stringify(result) });
  }
  // The rule classifier itself over a small gold set, and the async wrapper.
  const wrapper = [];
  for (const [msg, activeTask] of [["yes", "k1"], ["yes", undefined], ["fix the bug", "k1"], ["fix the bug", undefined]] as const) {
    let calls = 0;
    const r = await triageWithClassifier(msg, async (input) => { calls += 1; return ruleClassifier(input); }, { cost: "quality", ...(activeTask ? { activeTask } : {}) });
    wrapper.push({ message: msg, ...(activeTask ? { activeTask } : {}), calls, json: JSON.stringify(r) });
  }
  return { sets: out, wrapper };
}

export async function buildTriageVectors() {
  return { classes: classVectors(), rules: ruleVectors(), triage: triageVectors(), runtime: await runtimeVectors(), "message-eval": await evalVectors() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await exporterMain({ area: "triage", build: buildTriageVectors }));
