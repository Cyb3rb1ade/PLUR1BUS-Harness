// Parity vectors (mode V) for the prompt builder (P4-K K9a, plan P4-42): `packages/core/src/prompt/` and the harness join
// (`packages/core/src/join.ts`). The provider's prompt cache keys on the rendered bytes, so every case records the whole
// rendered prompt as a digest (sha256 of `JSON.stringify(result)`, member order included) next to its readable parts.
// `crates/plur1bus-core/src/prompt/vectors.rs` replays every case. Recorded, never edited by hand.
//
// Encoding: a string that is not well-formed UTF-16 is `{ "$u16": [units] }`; a string of 160 units or more is
// `{ "$rep": [unit, count] }` when it repeats a short unit, else `{ "$t": index }` into the file's `texts`; an array or object
// of 300 characters or more is `{ "$v": index }` into the file's `values` (shared contexts, R-K-10); a number JSON cannot
// hold (`NaN`, the infinities, `-0`) is `{ "$num": "..." }`.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-prompt.ts [--check]
import { fileURLToPath } from "node:url";
import { createPromptBuilder } from "../../packages/core/src/prompt/builder.ts";
import { createPromptSession } from "../../packages/core/src/prompt/session.ts";
import { canonicalJson, normalizeText, sha256Hex } from "../../packages/core/src/prompt/canonical.ts";
import { lookupCacheProfile, normalizeModelId } from "../../packages/core/src/prompt/model-table.ts";
import { chooseCacheTtl } from "../../packages/core/src/prompt/ttl.ts";
import { renderAvailableSkills, skillDescription } from "../../packages/core/src/prompt/skills.ts";
import { createCacheTelemetry, stickySessionId } from "../../packages/core/src/prompt/telemetry.ts";
import { TOOL_USE_INSTRUCTIONS } from "../../packages/core/src/prompt/instructions.ts";
import { joinBlocks } from "../../packages/core/src/join.ts";
import type { ConversationItem, RenderInput, RenderedPrompt, ToolDef } from "../../packages/core/src/prompt/types.ts";
import { exporterMain } from "./lib.mjs";

// --- encoding ---------------------------------------------------------------------------------------------------------------
export class Texts {
  readonly list: string[] = [];
  readonly values: unknown[] = [];
  readonly #index = new Map<string, number>();
  readonly #valueIndex = new Map<string, number>();
  ref(s: string): unknown {
    let i = this.#index.get(s);
    if (i === undefined) { i = this.list.length; this.list.push(s); this.#index.set(s, i); }
    return { $t: i };
  }
  /** A structure of 300 characters or more is stored once in `values` and referred to as `{ "$v": index }`. */
  #share(v: unknown): unknown {
    const key = JSON.stringify(v);
    if (key.length < 300) return v;
    let i = this.#valueIndex.get(key);
    if (i === undefined) { i = this.values.length; this.values.push(v); this.#valueIndex.set(key, i); }
    return { $v: i };
  }
  enc(v: unknown): unknown {
    if (typeof v === "string") {
      if (!v.isWellFormed()) return { $u16: Array.from({ length: v.length }, (_, i) => v.charCodeAt(i)) };
      if (v.length < 160) return v;
      for (let n = 1; n <= 8; n += 1) if (v.length % n === 0 && v === v.slice(0, n).repeat(v.length / n)) return { $rep: [v.slice(0, n), v.length / n] };
      return this.ref(v);
    }
    if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0) ? v : { $num: Object.is(v, -0) ? "-0" : String(v) };
    if (Array.isArray(v)) return this.#share(v.map((x) => this.enc(x)));
    if (v && typeof v === "object") return this.#share(Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, this.enc(x)])));
    return v;
  }
  tables() { return { texts: this.list, values: this.values }; }
}
const u = (...units: number[]): string => String.fromCharCode(...units);
const failure = (e: unknown) => ({ error: (e as Error).message, errorType: (e as Error).constructor.name });

// --- the corpus of the TypeScript tests (packages/core/test/fixtures/prompt-corpus.ts), repeated so the exporter has no test import
const lines = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${String(i).padStart(4, "0")}: the quick brown fox jumps over the lazy dog, éè 日本語.`).join("\n");
const tools: ToolDef[] = [
  { name: "memory_recall", description: "Recall memories.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } } } },
  { name: "file_read", description: "Read a file.", inputSchema: { properties: { path: { type: "string" } }, type: "object", required: ["path"] } },
  { name: "shell", description: "Run a command.", inputSchema: { type: "object", properties: { cmd: { type: "string" }, timeoutMs: { type: "number" } } } },
];
const system: string[] = [`You are bernd.\n${lines("Rule", 60)}`, "Safety preamble. Operating instructions."];
const memory: string = lines("Fact", 120);
function conversation(turns: number): ConversationItem[] {
  const out: ConversationItem[] = [];
  for (let i = 0; i < turns; i += 1) { out.push({ role: "user", text: `Question ${i}?` }); out.push({ role: "assistant", text: `Answer ${i}.` }); }
  return out;
}
const corpus = (turns: number, over: Partial<RenderInput> = {}): RenderInput =>
  ({ agentId: "bernd", model: "claude-sonnet-5-5", tools, system, memory, conversation: conversation(turns), ...over });
const tiny = (over: Partial<RenderInput> = {}): RenderInput => ({ agentId: "a", model: "claude-sonnet-5-5", tools: [], system: ["s"], memory: "", conversation: [], ...over });
const block = (name: string, text: string, droppable = true) => ({ name, text, droppable, chars: text.length }) as never;

// --- canonical ----------------------------------------------------------------------------------------------------------------
function canonicalVectors() {
  const t = new Texts();
  const texts = ["", "plain", "é\r\nx\ry", "a\r\n\r\nb\r", "\r", "Å Å ﬁ", "ẛ̣", "한글 한", u(0x61, 0xd83d, 0x62), u(0xdc00, 0x41, 0xd800),
    u(0xd83d, 0xde00), "tab\there", "  ", "q̣̇", "̈́", "café café", "﻿bom", " nbsp　"];
  const normalize = texts.map((s) => { const out = normalizeText(s); return { input: t.enc(s), output: t.enc(out), utf16Length: out.length, utf8Length: Buffer.byteLength(out), sha256: sha256Hex(out) }; });
  const jsons = [
    '{"b":1,"a":{"d":[3,{"y":1,"x":2}],"c":"z"}}', '{"😀":1,"～":2}', '{"é":"å"}', '[-0,1.5,1e21,1e-7,123456789012345680000,0.1,5e-324,1.7976931348623157e308,100,1e5,123456.789,-1e-7,0.000001,9007199254740993,1e300]',
    '{"a":null,"b":true,"c":false,"d":"","e":[],"f":{}}', '"line\\r\\nend"', '{"\\u00e9":1,"e\\u0301":2}', '{"k":"\\"quoted\\" \\\\ \\u0001 \\u007f \\u2028 </script>"}', '{"10":1,"9":2,"a":3,"B":4,"_":5,"":6}',
    '{"\\u00e9":1,"f":2,"e\\u0301x":3,"z":{"\\uff5e":1,"\\ud83d\\ude00":2,"\\ud7ff":3,"\\ue000":4}}', '[[[[]]],{"a":[{"b":[{}]}]}]', '1', '"x"', 'null', '{"n":-0.0,"m":0.0,"i":-5,"j":2e0,"k":10e-1}',
    '{"a\\r\\nb":"c\\rd"}', '{"dup":1,"dup":2}', '[1e21,1e22,-1e21,999999999999999900000,0.00001,0.0000001234]',
  ];
  const json = jsons.map((inputJson) => {
    try { const output = canonicalJson(JSON.parse(inputJson)); return { inputJson, output, sha256: sha256Hex(output) }; } catch (e) { return { inputJson, ...failure(e) }; }
  });
  const sha = ["", "abc", "é", "😀", "a\nb"].map((s) => ({ input: s, sha256: sha256Hex(s) }));
  const sticky = [["bernd", undefined], ["bernd", "default"], ["bernd", "s1"], ["Bernd", "s1"], ["é", "x"], ["é", "x"], ["a", ""]]
    .map(([agentId, sessionId]) => ({ agentId, ...(sessionId !== undefined ? { sessionId } : {}), id: stickySessionId(agentId as string, sessionId) }));
  return { ...t.tables(), normalize, json, sha, sticky, instructions: { text: t.enc(TOOL_USE_INSTRUCTIONS), sha256: sha256Hex(TOOL_USE_INSTRUCTIONS), utf16Length: TOOL_USE_INSTRUCTIONS.length } };
}

// --- model table and TTL choice ---------------------------------------------------------------------------------------------
const MODELS = ["claude-sonnet-5-5", "claude-opus-4-5", "claude-opus-4-7", "claude-haiku-4-5-20251001", "claude-fable-5-1", "claude-mythos-preview", "Anthropic/Claude-Opus-4.5", "  CLAUDE-OPUS-4.5  ",
  "us.anthropic.claude-opus-4-7-v1:0", "claude-opus-4-1@20250805", "gpt-5.6", "gpt-6", "gpt-5.5", "openai/gpt-5.6:free", "gemini-2.5-pro", "gemini-3-5-flash", "google/gemini-3-pro-preview", "grok-4", "kimi-k2",
  "deepseek-chat", "qwen-max", "glm-4.6", "mistral-large-latest", "vendor/unknown", "", "llama3.2", "claude", "x/y/z"];
const ROUTES = [undefined, {}, { platform: "bedrock" }, { platform: "bedrock-legacy" }, { platform: "vertex" }, { platform: "google-managed" }, { platform: "chatgpt-plan" }, { local: true }, { gateway: "openrouter" },
  { local: false, platform: "first-party" }, { vendor: "anthropic" }];
function modelVectors() {
  const lookups = MODELS.flatMap((model) => ROUTES.map((route) => ({ model, ...(route ? { route } : {}), profile: lookupCacheProfile(model, route as never), id: normalizeModelId(model) })));
  const ttl: unknown[] = [];
  const t = new Texts();
  for (const model of ["claude-sonnet-5-5", "gpt-5.6", "gpt-5.5", "vendor/unknown", "gemini-2.5-pro", "claude-opus-4-7"]) {
    for (const projectedReads of [0, 1, 2, 2.999, 3, 3.0000001, 10, -1, NaN, Infinity, -Infinity]) {
      for (const policy of [undefined, "auto", "never"] as const) {
        for (const route of [undefined, { platform: "bedrock" }, { local: true }]) {
          ttl.push({ model, projectedReads: t.enc(projectedReads), ...(policy ? { policy } : {}), ...(route ? { route } : {}), ttl: chooseCacheTtl({ model, projectedReads, ...(policy ? { policy } : {}), ...(route ? { route: route as never } : {}) }) });
        }
      }
    }
  }
  return { lookups, ttl };
}

// --- joinBlocks ---------------------------------------------------------------------------------------------------------------
function joinVectors() {
  const t = new Texts();
  const emoji = "😀";
  const sets: Array<{ name: string; blocks: Array<[string, string, boolean]> }> = [
    { name: "three-droppable", blocks: [["a", "aaaaaaaaaa", true], ["b", "bbbbbbbbbb", true], ["c", "cccccccccc", true]] },
    { name: "pinned-middle", blocks: [["a", "aaaaaaaaaa", true], ["b", "bbbbbbbbbb", false], ["c", "cccccccccc", true]] },
    { name: "none-droppable", blocks: [["a", "aaaaaaaaaa", false], ["b", "bbbbbbbbbb", false]] },
    { name: "empties", blocks: [["a", "", true], ["b", "bbbb", true], ["c", "", false], ["d", "dd", true]] },
    { name: "emoji-tail", blocks: [["a", "head", false], ["b", `xx${emoji}${emoji}${emoji}`, true]] },
    { name: "emoji-only", blocks: [["a", emoji, true], ["b", emoji, true]] },
    { name: "single", blocks: [["a", "0123456789", true]] },
    { name: "nothing", blocks: [] },
  ];
  const caps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 20, 21, 22, 23, 24, 33, 34, 35, 100, 2.5, 9.99, -1, -0.5, NaN, Infinity, -Infinity];
  const cases = sets.flatMap((s) => caps.map((cap) => {
    const r = joinBlocks(s.blocks.map(([name, text, droppable]) => block(name, text, droppable)), cap);
    return { name: `${s.name}@${String(cap)}`, blocks: s.blocks.map(([name, text, droppable]) => ({ name, text, droppable })), cap: t.enc(cap), text: t.enc(r.text), utf16Length: r.text.length, deferrals: r.deferrals };
  }));
  return { cases };
}

// --- render -----------------------------------------------------------------------------------------------------------------
interface Step { at?: number; input: RenderInput }
interface Scenario { name: string; options?: { cacheTtlMs?: Record<string, number | null> }; steps: Step[] }
const marked = (r: RenderedPrompt) => r.segments.flatMap((s, i) => (s.cache ? [[i, s.cache.ttl]] : []));
function recordRender(t: Texts, r: RenderedPrompt) {
  const { segments, ...rest } = r;
  const { breakpoints, events, cache, prefix, zoneHashes, prefixHashes, stableTokensEstimate } = rest;
  return { digest: sha256Hex(JSON.stringify(r)), segmentsDigest: sha256Hex(canonicalJson(segments)), segmentCount: segments.length, marked: marked(r),
    summary: t.enc({ breakpoints, events, cache, prefix, zoneHashes, prefixHashes, stableTokensEstimate, zones: rest.zones.map((z) => [z.byteOffset, z.tokenEstimate]) }),
    ...(segments.length <= 16 ? { segments: t.enc(segments) } : {}) };
}
function runScenario(t: Texts, s: Scenario) {
  const clock = { t: 0 };
  const emitted: unknown[] = [];
  let builder;
  try { builder = createPromptBuilder({ now: () => clock.t, emit: (e) => emitted.push(e), ...(s.options?.cacheTtlMs ? { cacheTtlMs: s.options.cacheTtlMs as never } : {}) }); }
  catch (e) { return { name: s.name, options: t.enc(s.options ?? {}), ...failure(e), steps: [] }; }
  const steps = s.steps.map((step) => {
    clock.t = step.at ?? clock.t;
    emitted.length = 0;
    const base = { at: t.enc(clock.t), input: t.enc(step.input) };
    try { return { ...base, ...recordRender(t, builder.render(step.input)) }; } catch (e) { return { ...base, ...failure(e), emitted: t.enc([...emitted]) }; }
  });
  return { name: s.name, options: t.enc(s.options ?? {}), steps };
}
const big = (chars: number) => ["x".repeat(chars)];
function renderScenarios(): Scenario[] {
  const out: Scenario[] = [];
  const one = (name: string, input: RenderInput, options?: Scenario["options"]) => out.push({ name, steps: [{ input }], ...(options ? { options } : {}) });
  for (const turns of [0, 2, 3, 40]) one(`b6-corpus-${turns}`, corpus(turns));
  const shuffled = [...tools].reverse().map((x) => Object.fromEntries(Object.entries(x).reverse())) as ToolDef[];
  out.push({ name: "prefix-stability", steps: [corpus(3), corpus(4), corpus(4, { volatile: { blocks: [block("memories", "- new fact")] } }), corpus(1), corpus(1, { memory: `${memory}\nFact new` }),
    corpus(1, { system: [...system, "one more rule"] }), corpus(1, { tools: [...tools, { name: "extra" }] }), corpus(1),
    corpus(1, { tools: shuffled, system: system.map((x) => x.replace(/\n/g, "\r\n")), memory: memory.normalize("NFD") }),
    corpus(1, { model: "claude-opus-4-5" }), corpus(1), corpus(2), corpus(1, { agentId: "other" }), corpus(1, { model: "Anthropic/Claude-Sonnet-5.5" })].map((input) => ({ input })) });
  one("duplicate-tool", corpus(1, { tools: [{ name: "a" }, { name: "a" }] }));
  one("duplicate-tool-after-nfc", corpus(1, { tools: [{ name: "café" }, { name: "café" }] }));
  one("tool-names-nfd", corpus(1, { tools: [{ name: "café", description: "x" }, { name: "Ångstrom" }, { name: "～" }, { name: "😀" }, { name: "Zeta" }, { name: "alpha" }, { name: "_" }] }));
  one("tool-names-nfc", corpus(1, { tools: [{ name: "café", description: "x" }, { name: "Ångstrom" }, { name: "～" }, { name: "😀" }, { name: "Zeta" }, { name: "alpha" }, { name: "_" }] }));
  one("tool-key-collides-after-nfc", tiny({ tools: [{ name: "t", "café": 1, "café": 2 }] }));
  one("tool-numbers", tiny({ tools: [{ name: "n", a: -0, b: 1e21, c: 0.1, d: [1.5, 2, 1e-7], e: 5e-324, f: 123456789012345680000 }] }));
  const vol = { volatile: { blocks: [block("memories", "- m")] } };
  one("zone-order-with-volatile", corpus(2, vol));
  one("empty-zones-system-only", corpus(0, { tools: [], system: big(4096), memory: "" }));
  for (const model of ["gemini-2.5-pro", "gpt-5.5", "vendor/unknown", "gpt-6", "claude-mythos-preview", "claude-opus-4-7", "grok-4", "llama3.2"]) one(`model-${model}`, corpus(2, { model }));
  one("route-local", corpus(2, { route: { local: true } as never }));
  one("route-bedrock", corpus(2, { model: "claude-opus-4-7", route: { platform: "bedrock" } as never }));
  one("route-bedrock-id", corpus(2, { model: "us.anthropic.claude-opus-4-7-v1:0" }));
  one("gpt-5.6-asks-1h", corpus(1, { model: "gpt-5.6", cacheTtl: "1h" }));
  for (const ttl of ["5m", "30m", "1h", "12h"] as const) one(`sonnet-ttl-${ttl}`, corpus(2, { cacheTtl: ttl }));
  for (const turns of [1, 10, 100]) one(`max-breakpoints-${turns}`, corpus(turns));
  for (const hint of ["auto", "none", "prefer"] as const) one(`cache-hint-${hint}`, corpus(2, { cacheHint: hint }));
  out.push({ name: "interior-free-slots", steps: [corpus(60, { tools: [], system: big(4096), memory: "" }), corpus(5, { tools: [], system: big(4096), memory: "" })].map((input) => ({ input })) });
  one("interior-all-zones", corpus(60));
  // Three stable zones that each reach the minimum, a trailing and an interior breakpoint: one zone too many, and tools go first.
  one("interior-drops-tools-first", corpus(60, { tools: [...tools, { name: "manual", description: big(8192)[0] }] }));
  // The interior breakpoint appears when the last position passes 15: positions 15, 16 and 17 around the boundary, and 20/21 around the lookback.
  for (const items of [15, 16, 17, 20, 21, 22, 36]) one(`positions-${items}`, corpus(0, { conversation: conversation(items).slice(0, items), tools: [], system: big(4096), memory: "" }));
  for (const items of [20, 21, 22]) one(`lookback-no-free-slot-${items}`, corpus(0, { conversation: conversation(items).slice(0, items) }));
  const run: ConversationItem[] = [{ role: "user", text: "q" }];
  for (let i = 0; i < 30; i += 1) run.push({ role: "assistant", kind: "tool_use", id: `t${i}`, text: "{}" });
  for (let i = 0; i < 30; i += 1) run.push({ role: "user", kind: "tool_result", id: `t${i}`, text: "ok" });
  run.push({ role: "assistant", text: "done" });
  one("tool-runs-collapse", corpus(0, { conversation: run }));
  const mixed: ConversationItem[] = [];
  for (let i = 0; i < 12; i += 1) mixed.push({ role: "user", text: `q${i}` }, { role: "assistant", kind: "tool_use", id: `a${i}`, text: "{}" }, { role: "assistant", kind: "tool_use", id: `b${i}`, text: "{}" },
    { role: "user", kind: "tool_result", id: `a${i}`, text: "ok" }, { role: "user", kind: "tool_result", id: `b${i}`, text: "ok" }, { role: "user", kind: "context", text: "ctx" });
  one("interior-inside-tool-runs", corpus(0, { conversation: mixed }));
  one("below-minimum-haiku", corpus(1, { model: "claude-haiku-4-5-20251001", tools: [], system: ["tiny"], memory: "" }));
  one("fable-2400", corpus(1, { model: "claude-fable-5-1", system: big(2400) }));
  one("unknown-short-memory", corpus(1, { model: "vendor/unknown", memory: memory.slice(0, 10) }));
  one("large-transcript-below-floor", corpus(40, { tools: [], system: ["tiny"], memory: "" }));
  one("empty-prefix", tiny({ system: [], conversation: conversation(1) }));
  one("empty-system-parts", tiny({ system: ["", "\r", "a", "", "\r\n"] }));
  for (const model of ["claude-sonnet-5-5", "claude-opus-4-5", "gpt-5.6", "gemini-2.5-pro", "gpt-5.5"]) {
    const m = lookupCacheProfile(model).minTokens;
    for (const chars of [4 * (m - 1), 4 * (m - 1) + 1, 4 * m]) one(`minimum-boundary-${model}-${chars}`, tiny({ model, system: big(chars), conversation: conversation(1) }));
  }
  const min = lookupCacheProfile("claude-sonnet-5-5").minTokens;
  one("sub-minimum-early-zone", tiny({ tools: [{ name: "t" }], system: big(4 * min), memory: "m", conversation: conversation(1) }));
  one("astral-offsets", tiny({ tools: [{ name: "😀", d: "日本語" }], system: ["é😀".repeat(3000)], memory: "日本語\n".repeat(900), conversation: [{ role: "user", text: "😀" }], volatile: { blocks: [block("memories", "é")] } }));
  // TTL warmth against the request clock.
  const five = 300_000;
  out.push({ name: "ttl-warmth-5m", steps: [{ at: 1000, input: corpus(1) }, { at: 1000 + five - 1, input: corpus(2) }, { at: 1000 + 2 * five - 1, input: corpus(3) }, { at: 1000 + 3 * five - 1, input: corpus(3) },
    { at: 1000 + 3 * five - 1, input: corpus(3) }, { at: 0, input: corpus(3) }, { at: 0.5, input: corpus(3) }, { at: 1, input: corpus(3, { memory: `${memory}!` }) }, { at: 2, input: corpus(3, { memory: `${memory}!` }) }] });
  out.push({ name: "ttl-warmth-1h", steps: [{ at: 0, input: corpus(1, { cacheTtl: "1h" }) }, { at: 3_599_999, input: corpus(1, { cacheTtl: "1h" }) }, { at: 7_199_999, input: corpus(1) }, { at: 7_499_998, input: corpus(1) }, { at: 7_799_998, input: corpus(1) }] });
  out.push({ name: "ttl-warmth-openai", steps: [{ at: 0, input: corpus(1, { model: "gpt-5.6" }) }, { at: 1_799_999, input: corpus(1, { model: "gpt-5.6" }) }, { at: 3_599_999, input: corpus(1, { model: "gpt-5.6" }) }] });
  out.push({ name: "ttl-warmth-implicit-and-unknown", steps: [{ at: 0, input: corpus(1, { model: "gemini-2.5-pro" }) }, { at: 1, input: corpus(1, { model: "gemini-2.5-pro" }) }, { at: 2, input: corpus(1, { model: "vendor/unknown" }) }, { at: 3, input: corpus(1, { model: "vendor/unknown" }) },
    { at: 4, input: corpus(1, { model: "gpt-5.5" }) }, { at: 5, input: corpus(1, { model: "gpt-5.5" }) }] });
  for (const [name, cacheTtlMs] of [["override-1000", { anthropic: 1000 }], ["override-null", { anthropic: null }], ["override-zero", { anthropic: 0 }], ["override-other-provider", { openai: 5 }], ["override-unknown", { unknown: 50 }], ["override-fraction", { anthropic: 0.5 }]] as const) {
    out.push({ name: `ttl-${name}`, options: { cacheTtlMs }, steps: [{ at: 0, input: corpus(1) }, { at: 0.25, input: corpus(1) }, { at: 999.25, input: corpus(1) }, { at: 1999.25, input: corpus(1, { cacheTtl: "1h" }) }, { at: 2000, input: corpus(1, { model: "vendor/unknown" }) }, { at: 2049, input: corpus(1, { model: "vendor/unknown" }) }] });
  }
  for (const [name, value] of [["nan", NaN], ["negative", -1], ["infinite", Infinity]] as const) out.push({ name: `ttl-override-invalid-${name}`, options: { cacheTtlMs: { anthropic: value } }, steps: [] });
  for (const at of [NaN, Infinity, -Infinity]) out.push({ name: `clock-${String(at)}`, steps: [{ at, input: tiny() }] });
  out.push({ name: "sessions-and-model-switches", steps: [corpus(1, { sessionId: "s1" }), corpus(1, { sessionId: "s2" }), corpus(1, { sessionId: "s1", model: "claude-opus-4-5" }), corpus(1, { sessionId: "s1", model: "Anthropic/Claude-Opus-4.5" }),
    corpus(1, { sessionId: "s1" }), corpus(1, { sessionId: "default" }), corpus(1), corpus(1, { agentId: "other", sessionId: "s1" }), corpus(2, { sessionId: "s1", invalidationReason: "memory-refresh", memory: `${memory}\nnew` }),
    corpus(2, { sessionId: "s1", invalidationReason: "memory-refresh", memory: `${memory}\nnew` }), corpus(2, { sessionId: "x".repeat(400) })].map((input, i) => ({ at: i * 10, input })) });
  // Clipping (L3).
  const record = (n: number) => Array.from({ length: n }, (_, i) => `record ${i} ${"y".repeat(20)}`).join("\n");
  for (const cap of [0, 1, 10, 10.5, 29, 30, 31, 58, 59, 60, 61, 62, 100, 1000, 3000, Infinity, NaN, -1, -0]) one(`memory-cap-${String(cap)}`, tiny({ memory: record(40), zoneCaps: { memory: cap } }));
  one("memory-default-cap-at", tiny({ memory: "z".repeat(17_000) }));
  one("memory-default-cap-over", tiny({ memory: "z".repeat(17_001) }));
  one("memory-default-cap-lines", tiny({ memory: record(900) }));
  one("memory-cap-empty-zone-caps", tiny({ memory: record(3), zoneCaps: {} }));
  for (const cap of [3, 4, 5, 6, 7, 8]) one(`memory-cap-surrogate-${cap}`, tiny({ memory: "ab😀😀😀cd", zoneCaps: { memory: cap } }));
  for (const cap of [6, 7, 8, 9, 10, 11]) one(`memory-cap-trim-${cap}`, tiny({ memory: "abc  \t\n\n 　def ghi", zoneCaps: { memory: cap } }));
  for (const cap of [4, 5, 6, 7, 8]) one(`memory-cap-newline-at-cut-${cap}`, tiny({ memory: "abcd\nefgh\nijkl", zoneCaps: { memory: cap } }));
  one("memory-crlf-counts-after-normalising", tiny({ memory: "ab\r\ncd\r\nef", zoneCaps: { memory: 7 } }));
  const blocks = [block("soul", "S".repeat(30), false), block("memories", "M".repeat(40)), block("episodes", "E".repeat(40)), block("empty", "")];
  for (const capChars of [undefined, 200, 114, 113, 100, 75, 74, 40, 33, 32, 30, 0, 12.7, Infinity, NaN, -1]) one(`volatile-cap-${String(capChars)}`, tiny({ volatile: { blocks, ...(capChars !== undefined ? { capChars } : {}) } }));
  one("volatile-default-cap", tiny({ volatile: { blocks: [block("memories", "v".repeat(17_010)), block("soul", "p", false)] } }));
  one("volatile-tool-result", tiny({ conversation: conversation(1), volatile: { blocks: [block("memories", "- m")], delivery: "tool_result", toolUseId: "tu_1" } }));
  one("volatile-tool-result-without-id", tiny({ volatile: { blocks: [block("memories", "- m")], delivery: "tool_result" } }));
  one("volatile-tool-result-empty-id", tiny({ volatile: { blocks: [block("memories", "- m")], delivery: "tool_result", toolUseId: "" } }));
  one("volatile-context-with-id", tiny({ volatile: { blocks: [block("memories", "- m")], delivery: "context", toolUseId: "ignored" } }));
  one("volatile-all-empty", tiny({ volatile: { blocks: [block("a", ""), block("b", "", false)] } }));
  one("volatile-normalises-before-counting", tiny({ volatile: { blocks: [block("a", "é\r\né"), block("b", u(0x78, 0xd83d))], capChars: 5 } }));
  one("volatile-clips-then-throws", tiny({ model: "vendor/unknown", volatile: { blocks: [block("a", "aaaaaaaaaa")], capChars: 4, delivery: "tool_result" } }));
  // Conversation shapes and the trust boundary of roles (b09).
  const conv = (items: ConversationItem[]) => tiny({ conversation: items });
  one("conversation-kinds", conv([{ role: "user", text: "q" }, { role: "assistant", kind: "tool_use", id: "t1", text: "{\"a\":1}" }, { role: "user", kind: "tool_result", id: "t1", text: "out\r\nput" }, { role: "user", kind: "context", text: "recalled" },
    { role: "assistant", kind: "text", text: "done", id: "kept" }, { role: "user", text: "empty id", id: "" }, { role: "assistant", text: u(0x61, 0xd83d) }]));
  const bad: Array<[string, ConversationItem]> = [["tool-use-no-id", { role: "assistant", kind: "tool_use", text: "{}" }], ["tool-use-empty-id", { role: "assistant", kind: "tool_use", id: "", text: "{}" }], ["tool-result-no-id", { role: "user", kind: "tool_result", text: "x" }],
    ["tool-use-user", { role: "user", kind: "tool_use", id: "t", text: "{}" }], ["tool-result-assistant", { role: "assistant", kind: "tool_result", id: "t", text: "x" }], ["context-assistant", { role: "assistant", kind: "context", text: "x" }],
    ["tool-result-assistant-no-id", { role: "assistant", kind: "tool_result", text: "x" }]];
  for (const [name, item] of bad) one(`conversation-refused-${name}`, conv([{ role: "user", text: "ok" }, item]));
  one("unknown-model-then-bad-item", tiny({ model: "vendor/unknown", memory: "mmmmmmmmmm", zoneCaps: { memory: 4 }, conversation: [{ role: "assistant", kind: "context", text: "x" }] }));
  return out;
}
function renderVectors() {
  const t = new Texts();
  const scenarios = renderScenarios().map((s) => runScenario(t, s));
  return { ...t.tables(), scenarios };
}

// --- sessions ---------------------------------------------------------------------------------------------------------------
type SessionOp = { append: ConversationItem } | { recall: { blocks: unknown[]; capChars?: number }; delivery?: "tool_result" | "context"; toolUseId?: string } | { refresh: string } | { setModel: string } | { render: true; at?: number };
function sessionVectors() {
  const t = new Texts();
  const open = { agentId: "bernd", model: "claude-sonnet-5-5", tools, system, memorySnapshot: memory };
  const q = (i: number): SessionOp => ({ append: { role: "user", text: `q${i}` } });
  const a = (i: number): SessionOp => ({ append: { role: "assistant", text: `a${i}` } });
  const rec = (text: string, extra: Record<string, unknown> = {}): SessionOp => ({ recall: { blocks: [block("memories", text)] }, ...extra }) as SessionOp;
  const long: SessionOp[] = [{ render: true }];
  for (let i = 0; i < 40; i += 1) { long.push(q(i)); if (i % 10 === 0) long.push(rec(`- fact ${i}`)); long.push(a(i)); if (i % 13 === 0) long.push({ render: true, at: i * 1000 }); }
  long.push({ render: true, at: 50_000 });
  const scripts: Array<{ name: string; open: Record<string, unknown>; ops: SessionOp[] }> = [
    { name: "recall-rides-volatile-then-folds", open, ops: [q(0), { render: true }, rec("- the user likes tea"), { render: true }, a(0), { render: true }, q(1), rec("- second"), { render: true }, a(1), q(2), { render: true }] },
    { name: "tool-invoked-recall", open, ops: [q(0), { append: { role: "assistant", kind: "tool_use", id: "tu_1", text: "{}" } }, rec("- by tool", { delivery: "tool_result", toolUseId: "tu_1" }), { render: true }, a(0), { render: true }] },
    { name: "latest-recall-wins-at-an-anchor", open, ops: [q(0), rec("- first"), rec("- second"), { render: true }, a(0), { render: true }, rec("- third"), rec(""), { render: true }] },
    { name: "clip-reported-once", open, ops: [q(0), { recall: { blocks: [block("memories", "M".repeat(50)), block("soul", "S".repeat(10), false)], capChars: 30 } }, { render: true }, { render: true }, a(0), { render: true }] },
    { name: "refused-items-and-recalls", open, ops: [{ append: { role: "assistant", kind: "tool_result", id: "x", text: "t" } }, { append: { role: "user", kind: "tool_use", id: "x", text: "t" } }, { append: { role: "assistant", kind: "tool_use", text: "t" } },
      rec("- x", { delivery: "tool_result" }), { recall: { blocks: [block("a", "x")], capChars: NaN } }, { recall: { blocks: [block("a", "x")], capChars: -1 } }, { recall: { blocks: [block("a", "x")], capChars: Infinity } }, q(0), { render: true }] },
    { name: "refresh-and-model-change", open: { ...open, sessionId: "s1", cacheTtl: "1h", zoneCaps: { memory: 9000 } }, ops: [q(0), { render: true, at: 0 }, { refresh: memory }, { render: true, at: 10 }, { refresh: `${memory}\nFact new` }, { render: true, at: 20 }, { render: true, at: 30 },
      { setModel: "claude-opus-4-5" }, { render: true, at: 40 }, { setModel: "claude-sonnet-5-5" }, { render: true, at: 50 }, { refresh: "short" }, { refresh: `${memory}\nFact new` }, { render: true, at: 60 }] },
    { name: "long-session-snapshot-frozen", open, ops: long },
    { name: "empty-session", open: { agentId: "a", model: "vendor/unknown", tools: [], system: [], memorySnapshot: "" }, ops: [{ render: true }, rec("- only recall"), { render: true }, { render: true }] },
  ];
  const scenarios = scripts.map((s) => {
    const clock = { t: 0 };
    const emitted: unknown[] = [];
    const session = createPromptSession({ builder: createPromptBuilder({ now: () => clock.t }), emit: (e) => emitted.push(e), ...(s.open as never) });
    const ops = s.ops.map((op) => {
      emitted.length = 0;
      try {
        if ("append" in op) { session.append(op.append); return { op: t.enc(op) }; }
        if ("recall" in op) {
          const events = session.recall(op.recall as never, { ...(op.delivery ? { delivery: op.delivery } : {}), ...(op.toolUseId ? { toolUseId: op.toolUseId } : {}) });
          return { op: t.enc(op), events: t.enc(events), emitted: t.enc([...emitted]) };
        }
        if ("refresh" in op) { session.refreshMemorySnapshot(op.refresh); return { op: t.enc(op), snapshotSha256: sha256Hex(session.memorySnapshot) }; }
        if ("setModel" in op) { session.setModel(op.setModel); return { op: t.enc(op), model: session.model }; }
        clock.t = op.at ?? clock.t;
        return { op: t.enc(op), ...recordRender(t, session.render()) };
      } catch (e) { return { op: t.enc(op), ...failure(e), emitted: t.enc([...emitted]) }; }
    });
    return { name: s.name, open: t.enc(s.open), ops };
  });
  return { ...t.tables(), scenarios };
}

// --- the skill catalogue ------------------------------------------------------------------------------------------------------
function skillVectors() {
  const t = new Texts();
  const descriptions = ["", "plain", "  padded  ", "line\nbreak\r\nand\ttab", "\u0000\u001f\u007f  x", " nbsp ", "a".repeat(1024), "a".repeat(1025), `${"a".repeat(1023)}😀`, `${"a".repeat(1022)}😀b`,
    `  ${"b".repeat(1030)}  `, `${"c".repeat(1020)}    tail`, "\n\n\n", "\u0085next-line ​zero-width", u(0xd83d, 0x61)];
  const describe = descriptions.map((input) => { const output = skillDescription(input); return { input: t.enc(input), output: t.enc(output), utf16Length: output.length }; });
  const sk = (name: string, description: string, authored?: string) => ({ entry: { name, description }, ...(authored !== undefined ? { authoredDescription: authored } : {}) });
  const many = (n: number, size: number) => Array.from({ length: n }, (_, i) => sk(`skill-${String(i).padStart(3, "0")}`, "d".repeat(size)));
  const catalogues: Array<{ name: string; skills: ReturnType<typeof sk>[]; budget?: number }> = [
    { name: "empty", skills: [] }, { name: "empty-with-bad-budget", skills: [], budget: 1 },
    { name: "two-authored", skills: [sk("zebra", "ranking only", "Read the zebra workflow."), sk("alpha", "ranking only", "Read the alpha workflow.")] },
    { name: "authored-empty-wins-over-entry", skills: [sk("a", "entry text", "")] },
    { name: "utf16-name-order", skills: [sk("～", "bmp"), sk("😀", "astral"), sk("Z", "upper"), sk("a", "lower"), sk("_", "underscore"), sk("a", "duplicate keeps input order"), sk("é", "latin")] },
    { name: "multi-line-description", skills: [sk("m", "first\nsecond third   ")] },
    ...[31, 32, 33, 40, 64, 100, 4000, 32.5, 0, -1, NaN, Infinity, 2 ** 53].map((budget) => ({ name: `budget-${String(budget)}`, skills: many(12, 20), budget })),
    ...[127, 128, 129, 130, 131, 132, 133, 134, 135, 136].map((size) => ({ name: `overflow-boundary-${size}`, skills: many(3, size), budget: 100 })),
    { name: "overflow-default-budget", skills: many(40, 1024) },
    { name: "single-too-large", skills: many(1, 1024), budget: 32 },
  ];
  const render = catalogues.map((c) => {
    const base = { name: c.name, skills: t.enc(c.skills), ...(c.budget !== undefined ? { budget: t.enc(c.budget) } : {}) };
    try { const output = c.budget !== undefined ? renderAvailableSkills(c.skills, c.budget) : renderAvailableSkills(c.skills); return { ...base, output: t.enc(output), utf16Length: output.length, sha256: sha256Hex(output) }; }
    catch (e) { return { ...base, ...failure(e) }; }
  });
  return { ...t.tables(), describe, render };
}

// --- cache telemetry ----------------------------------------------------------------------------------------------------------
type Usage = { cache_read: number; cache_creation: number; input: number };
type TelemetryOp = { render: RenderInput; at?: number } | { record: Usage; patch?: Record<string, unknown> } | { summary: [string, string, string?] } | { sessionModels: [string, string] } | { sessions: number };
function patched(prompt: RenderedPrompt, patch: Record<string, unknown> | undefined): RenderedPrompt {
  if (!patch) return prompt;
  const p = structuredClone(prompt);
  if (patch.stableTokensEstimate !== undefined) p.stableTokensEstimate = patch.stableTokensEstimate as number;
  if (patch.clearBreakpoints) p.breakpoints = [];
  if (patch.mechanism !== undefined) p.cache.mechanism = patch.mechanism as never;
  if (patch.reason !== undefined) p.cache.reason = patch.reason as never;
  if ("ageMs" in patch) p.cache.ageMs = patch.ageMs as number | null;
  if ("ttlMs" in patch) p.cache.ttlMs = patch.ttlMs as number | null;
  if (patch.toolTexts !== undefined) p.segments = [...(patch.toolTexts as string[]).map((text) => ({ zone: "tools", kind: "tool_def", text }) as never), ...p.segments.filter((s) => s.zone !== "tools")];
  return p;
}
function telemetryVectors() {
  const t = new Texts();
  const hit = (r: number, c = 0, i = 10): TelemetryOp => ({ record: { cache_read: r, cache_creation: c, input: i } });
  const stable = Math.ceil((tools.map((x) => canonicalJson(x)).join("").length + system.join("").length + memory.length) / 4);
  const twenty: TelemetryOp[] = [];
  for (let i = 0; i < 20; i += 1) { twenty.push({ render: corpus(i + 1, { sessionId: "s" }), at: i * 1000 }); twenty.push(i === 0 ? hit(0, stable, 12) : hit(stable + i * 8, 8, 12)); }
  twenty.push({ summary: ["bernd", "claude-sonnet-5-5"] }, { summary: ["bernd", "claude-sonnet-5-5", "s"] }, { summary: ["bernd", "Anthropic/Claude-Sonnet-5.5", "s"] }, { summary: ["bernd", "claude-opus-4-5"] }, { summary: ["other", "claude-sonnet-5-5"] }, { sessionModels: ["bernd", "s"] }, { sessionModels: ["bernd", "none"] });
  const scripts: Array<{ name: string; ops: TelemetryOp[] }> = [
    { name: "twenty-turns", ops: twenty },
    { name: "miss-attribution", ops: [{ render: corpus(1, { sessionId: "m" }), at: 0 }, hit(0, stable), { render: corpus(2, { sessionId: "m" }), at: 10 }, hit(stable), hit(stable - 1), hit(stable + 1),
      { render: corpus(2, { sessionId: "m", tools: [...tools, { name: "extra" }, { name: "more" }] }), at: 20 }, hit(0), { render: corpus(2, { sessionId: "m", tools: [tools[0]!, { name: "other" }] }), at: 30 }, hit(0),
      { render: corpus(2, { sessionId: "m", tools: [{ ...tools[0]!, description: "changed" }, { name: "other" }] }), at: 40 }, hit(0), { render: corpus(2, { sessionId: "m", tools: [tools[0]!, { name: "other" }], system: [...system, "more"] }), at: 50 }, hit(0),
      { render: corpus(2, { sessionId: "m", tools: [tools[0]!, { name: "other" }], system: [...system, "more"], memory: `${memory}!` }), at: 60 }, hit(0),
      { render: corpus(2, { sessionId: "m", model: "claude-opus-4-5", tools: [], system: ["changed"], memory: `${memory}?` }), at: 70 }, hit(0),
      { render: corpus(2, { sessionId: "m", model: "claude-opus-4-5", tools: [{ name: "x" }], system: ["changed again"], memory: `${memory}?` }), at: 80 }, hit(0),
      { render: corpus(2, { sessionId: "m", model: "claude-opus-4-5", tools: [{ name: "x" }], system: ["and again"], memory: `${memory}??` }), at: 90 }, hit(0),
      { sessionModels: ["bernd", "m"] }, { summary: ["bernd", "claude-opus-4-5", "m"] }, { summary: ["bernd", "claude-sonnet-5-5", "m"] }] },
    { name: "ttl-expired-or-provider", ops: [{ render: corpus(1), at: 0 }, hit(0, stable), { render: corpus(1), at: 299_999 }, hit(0), { render: corpus(1), at: 599_999 }, hit(0), { render: corpus(1), at: 600_000 }, hit(0),
      { record: { cache_read: 0, cache_creation: 0, input: 1 }, patch: { ageMs: 5, ttlMs: 5 } }, { record: { cache_read: 0, cache_creation: 0, input: 1 }, patch: { ageMs: 4.999, ttlMs: 5 } }, { record: { cache_read: 0, cache_creation: 0, input: 1 }, patch: { ageMs: null, ttlMs: 5 } },
      { record: { cache_read: 0, cache_creation: 0, input: 1 }, patch: { ageMs: 9, ttlMs: null } }] },
    { name: "not-cacheable", ops: [{ render: tiny({ conversation: conversation(1) }) }, hit(0), { render: tiny({ system: [], conversation: conversation(1) }) }, hit(5), { render: corpus(1, { model: "vendor/unknown" }) }, hit(99999),
      { render: corpus(1, { cacheHint: "none" }) }, hit(99999), { record: { cache_read: 1, cache_creation: 1, input: 1 }, patch: { mechanism: "none", reason: "eligible" } }, { record: { cache_read: 1, cache_creation: 1, input: 1 }, patch: { clearBreakpoints: true, mechanism: "implicit" } },
      { summary: ["a", "claude-sonnet-5-5"] }, { summary: ["bernd", "claude-sonnet-5-5"] }, { summary: ["bernd", "vendor/unknown"] }] },
    { name: "implicit-tolerance", ops: [{ render: corpus(1, { model: "gemini-2.5-pro" }) }, hit(0), ...[stable - 129, stable - 128, stable - 127, stable].map((n) => hit(n)), { render: corpus(1) }, hit(stable - 1), hit(stable),
      { record: { cache_read: 100, cache_creation: 0, input: 0 }, patch: { stableTokensEstimate: 100 } }, { record: { cache_read: 99, cache_creation: 0, input: 0 }, patch: { stableTokensEstimate: 100 } }] },
    { name: "invalid-usage-is-atomic", ops: [{ render: corpus(1, { sessionId: "v" }) }, hit(1, 2, 3), ...[[-1, 0, 0], [0, 1.5, 0], [0, 0, NaN], [Infinity, 0, 0], [2 ** 53, 0, 0], [2 ** 53 - 1, 1, 0], [0, -0, 0]].map(([r, c, i]) => hit(r!, c, i)),
      { summary: ["bernd", "claude-sonnet-5-5", "v"] }, hit(2 ** 53 - 7, 0, 0), hit(1, 0, 0), hit(0, 0, 0), { summary: ["bernd", "claude-sonnet-5-5", "v"] }, { summary: ["bernd", "claude-sonnet-5-5"] },
      { render: corpus(2, { sessionId: "v", system: ["changed"] }) }, hit(0, 0, 0), { sessionModels: ["bernd", "v"] }] },
    { name: "zero-usage-and-weights", ops: [{ render: corpus(1, { sessionId: "w1" }) }, hit(0, 0, 0), { summary: ["bernd", "claude-sonnet-5-5", "w1"] }, hit(900, 0, 100), { render: corpus(1, { sessionId: "w2" }) }, hit(1, 0, 9999), hit(3, 3, 3),
      { summary: ["bernd", "claude-sonnet-5-5", "w1"] }, { summary: ["bernd", "claude-sonnet-5-5", "w2"] }, { summary: ["bernd", "claude-sonnet-5-5"] }, { summary: ["bernd", "claude-sonnet-5-5", "default"] }] },
    { name: "tool-names-from-segment-text", ops: [{ render: corpus(1, { sessionId: "t" }) }, hit(0), { record: { cache_read: 0, cache_creation: 0, input: 1 }, patch: { toolTexts: ["{\"name\":\"a\"}", "not json", "null", "{\"name\":5}", "[1]", "{\"name\":\"b\"}", "{\"name\":\"a\"}"] } },
      { render: corpus(1, { sessionId: "t", tools: [{ name: "a" }, { name: "c" }] }) }, hit(0)] },
    { name: "session-models-sorted", ops: [...["gpt-5.6", "claude-sonnet-5-5", "Anthropic/Claude-Opus-4.5", "vendor/unknown", "gemini-2.5-pro", "claude-opus-4-5"].flatMap((model): TelemetryOp[] => [{ render: corpus(1, { sessionId: "sm", model }) }, hit(1, 1, 1)]),
      { sessionModels: ["bernd", "sm"] }, { sessionModels: ["other", "sm"] }] },
    { name: "state-limit-1024", ops: [{ sessions: 1025 }, { render: tiny({ agentId: "a", sessionId: "n0", system: big(8000) }) }, hit(0), { sessionModels: ["a", "n0"] }, { sessionModels: ["a", "n1"] }, { sessionModels: ["a", "n1024"] },
      { render: tiny({ agentId: "a", sessionId: "n1", system: big(8000) }) }, hit(0), { render: tiny({ agentId: "a", sessionId: "n3", system: big(8000) }) }, hit(0)] },
  ];
  const scenarios = scripts.map((s) => {
    const clock = { t: 0 };
    const builder = createPromptBuilder({ now: () => clock.t });
    const telemetry = createCacheTelemetry();
    let prompt: RenderedPrompt | undefined;
    const ops = s.ops.map((op) => {
      try {
        if ("render" in op) { clock.t = op.at ?? clock.t; prompt = builder.render(op.render); return { op: { render: t.enc(op.render), at: clock.t }, digest: sha256Hex(JSON.stringify(prompt)) }; }
        if ("record" in op) { const r = telemetry.record(patched(prompt!, op.patch), op.record); return { op: t.enc(op), result: t.enc(r), json: sha256Hex(JSON.stringify(r)) }; }
        if ("summary" in op) { const r = telemetry.summary(...op.summary); return { op, result: r === undefined ? null : t.enc(r), json: sha256Hex(JSON.stringify(r ?? null)) }; }
        if ("sessions" in op) {
          // One record per session: the retained state is bounded, and the oldest session's state goes first.
          const digests: string[] = [];
          for (let i = 0; i < op.sessions; i += 1) { prompt = builder.render(tiny({ agentId: "a", sessionId: `n${i}`, system: big(8000) })); digests.push(JSON.stringify(telemetry.record(prompt, { cache_read: 0, cache_creation: 1, input: 1 }))); }
          return { op, json: sha256Hex(digests.join("\n")) };
        }
        const r = telemetry.sessionModels(...op.sessionModels);
        return { op, result: t.enc(r), json: sha256Hex(JSON.stringify(r)) };
      } catch (e) { return { op: t.enc(op), ...failure(e) }; }
    });
    return { name: s.name, ops };
  });
  return { ...t.tables(), scenarios };
}

export async function buildPromptVectors() {
  return { canonical: canonicalVectors(), "model-table": modelVectors(), join: joinVectors(), render: renderVectors(), session: sessionVectors(), skills: skillVectors(), telemetry: telemetryVectors() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await exporterMain({ area: "prompt", build: buildPromptVectors }));
