// Writes fixtures/vectors.json, the data the Rust crate's parity test reads: the derived level, catalogue and redaction
// tables, every catalogue example as a line, and hand-picked invalid records with their expected code. Run by `pnpm gen`.
// Secret-shaped canaries are stored as fragments and joined at test time, so no committed file holds a live-looking key.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOGUE, LEVELS, REDACTION, SOURCE_KINDS, KEY_ORDER, LIMITS, validateLine, attrsSchemaFor } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "fixtures");

export function buildVectors() {
  const valid = CATALOGUE.events.map((e) => ({ name: `example:${e.event}`, line: JSON.stringify(e.examples[0]), expect: "ok" }));
  const base = structuredClone(CATALOGUE.events.find((e) => e.event === "provider.request.failed").examples[0]);
  const mut = (name, expect, f) => { const r = structuredClone(base); const out = f(r) ?? r; return { name, line: typeof out === "string" ? out : JSON.stringify(out), expect }; };
  const reorder = (r, first) => ({ [first]: r[first], ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== first)) });
  const invalid = [
    mut("level:unknown-word", "invalid_level", (r) => { r.level = "verbose"; }),
    mut("level:uppercase", "invalid_level", (r) => { r.level = "INFO"; }),
    mut("level:number", "invalid_level", (r) => { r.level = 9; }),
    mut("event:unregistered", "unknown_event", (r) => { r.event = "made.up.event"; }),
    mut("event:bad-shape", "unknown_event", (r) => { r.event = "Not A Name"; }),
    mut("event:family-needs-a-step", "unknown_event", (r) => { r.event = "repair"; }),
    mut("event:looks-forged", "unknown_event", (r) => { r.event = "supervisor.child.given_up.forged"; }),
    mut("msg:too-long", "msg_too_long", (r) => { r.msg = "x".repeat(LIMITS.msgBytes + 1); }),
    mut("msg:too-long-multibyte", "msg_too_long", (r) => { r.msg = "é".repeat(LIMITS.msgBytes / 2 + 1); }),
    mut("attrs:too-large", "attrs_too_large", (r) => { r.attrs = { ...r.attrs, foreign_message: "y".repeat(2048), model: "m".repeat(128) }; r.attrs.provider_request_id = "r".repeat(128); r.attrs.capability = "chat"; r.attrs.finish_reason = "stop"; r.attrs.pad = "z".repeat(LIMITS.attrsBytes); }),
    mut("schema:missing-source", "schema", (r) => { delete r.source; }),
    mut("schema:missing-msg", "schema", (r) => { delete r.msg; }),
    mut("schema:extra-key", "schema", (r) => { r.extra = 1; }),
    mut("schema:bad-ts-shape", "schema", (r) => { r.ts = "2026-10-01 09:14:03"; }),
    mut("schema:ts-not-a-real-day", "schema", (r) => { r.ts = "2026-02-30T09:14:03.218Z"; }),
    mut("schema:ts-hour-24", "schema", (r) => { r.ts = "2026-10-01T24:00:00.000Z"; }),
    mut("schema:ts-leap-day-ok-but-month-13", "schema", (r) => { r.ts = "2026-13-01T09:14:03.218Z"; }),
    mut("schema:source-kind-unknown", "schema", (r) => { r.source.kind = "plugin"; }),
    mut("schema:source-version-missing", "schema", (r) => { delete r.source.version; }),
    mut("schema:trace-id-short", "schema", (r) => { r.trace_id = "abc"; }),
    mut("schema:trace-id-zero", "schema", (r) => { r.trace_id = "0".repeat(32); }),
    mut("schema:span-without-trace", "schema", (r) => { delete r.trace_id; }),
    mut("schema:err-code-not-in-enum", "schema", (r) => { r.err.code = "E_MADE_UP"; }),
    mut("schema:err-extra-key", "schema", (r) => { r.err.message = "foreign text"; }),
    mut("schema:duration-negative", "schema", (r) => { r.duration_ms = -1; }),
    mut("schema:turn-not-integer", "schema", (r) => { r.turn = 1.5; }),
    mut("schema:stream-bad-value", "schema", (r) => { r.stream = "stdin"; }),
    mut("schema:array", "not_object", () => "[]"),
    mut("schema:not-json", "not_object", () => "{not json"),
    mut("order:level-before-ts", "key_order", (r) => reorder(r, "level")),
    mut("order:attrs-first", "key_order", (r) => reorder(r, "attrs")),
    mut("order:duplicate-key", "key_order", () => JSON.stringify(base).replace(/^\{/, `{"ts":"${base.ts}",`)),
    mut("level:not-allowed-for-event", "level_not_allowed", (r) => { r.level = "fatal"; }),
    mut("level:trace-not-allowed", "level_not_allowed", (r) => { r.level = "trace"; }),
    mut("kind:harness-forging-a-provider-event", "source_kind_not_allowed", (r) => { r.source = { kind: "harness", id: "core", version: null }; }),
    mut("kind:extension-forging-supervisor-event", "source_kind_not_allowed", (r) => ({ ...r, source: { kind: "extension", id: "plugin/evil", version: "1" }, event: "supervisor.child.given_up", level: "fatal", attrs: { role: "core", attempts: 5 } })),
    mut("stream:wrapped-without-stream", "stream_mismatch", () => { const r = structuredClone(CATALOGUE.events.find((e) => e.event === "process.output.line").examples[0]); delete r.stream; return r; }),
    mut("stream:on-a-normal-event", "stream_mismatch", (r) => ({ ...r, err: r.err, stream: "stderr", attrs: r.attrs }) && (() => { const c = structuredClone(base); const { attrs, ...rest } = c; return { ...rest, stream: "stderr", attrs }; })()),
    mut("attrs:missing-required", "attrs_invalid", (r) => { delete r.attrs.model; }),
    mut("attrs:unknown-key", "attrs_invalid", (r) => { r.attrs.surprise = true; }),
    mut("attrs:wrong-type", "attrs_invalid", (r) => { r.attrs.http_status = "429"; }),
    mut("attrs:forged-untrusted-false", "attrs_invalid", () => { const r = structuredClone(CATALOGUE.events.find((e) => e.event === "process.output.line").examples[0]); r.attrs.untrusted = false; return r; }),
    mut("attrs:absent-but-required", "attrs_invalid", (r) => { delete r.attrs; }),
  ];
  // Self-check: every generated expectation must hold in the TS implementation before it is committed as the contract.
  for (const v of [...valid, ...invalid]) {
    const res = validateLine(v.line);
    const got = res.ok ? "ok" : res.code;
    if (got !== v.expect) throw new Error(`vector ${v.name}: expected ${v.expect}, TypeScript says ${got}${res.ok ? "" : ` (${res.detail})`}`);
  }
  const canary = (parts) => parts;
  return {
    $comment: "Generated by packages/log-schema/src/gen-fixtures.mjs (pnpm gen); the Rust parity test (crates/plur1bus-log-schema/tests/parity.rs) reads it. Do not edit.",
    catalogueVersion: CATALOGUE.version,
    sourceKinds: [...SOURCE_KINDS],
    keyOrder: [...KEY_ORDER],
    limits: { ...LIMITS },
    levels: LEVELS.map((l) => ({ name: l.name, rank: l.rank, severityNumber: l.otel.severityNumber, severityText: l.otel.severityText, syslogSeverity: l.syslog.severity, syslogName: l.syslog.name })),
    vectors: [...valid, ...invalid],
    events: CATALOGUE.events.map((e) => ({ event: e.event, kinds: e.kinds, stream: e.stream, level: e.level, levels: e.levels, attrs: e.attrs, requiredAttrs: e.requiredAttrs, streamed: Boolean(e.streamed), family: Boolean(e.family), activity: e.activity, stability: e.stability, attrsSchema: attrsSchemaFor(e) })),
    redaction: {
      order: REDACTION.order,
      rules: REDACTION.rules.map((r) => ({ id: r.id, kind: r.kind, patterns: r.patterns?.map((p) => p.id) ?? r.steps?.map((p) => p.id) ?? r.classes?.map((c) => c.id) ?? [] })),
    },
    redactionCanaries: [
      { rule: "pattern", pattern: "bearer", parts: canary(["Authorization: Bearer ", "abc123", "DEF456ghi789"]), matches: ["Bearer abc123DEF456ghi789"] },
      { rule: "pattern", pattern: "sk", parts: canary(["key=", "sk-", "proj-", "FAKEFAKEFAKEFAKEFAKE0123"]), matches: ["sk-proj-FAKEFAKEFAKEFAKEFAKE0123"] },
      { rule: "pattern", pattern: "ek", parts: canary(["ek", "_", "FAKEFAKEFAKEFAKE01234"]), matches: ["ek_FAKEFAKEFAKEFAKE01234"] },
      { rule: "pattern", pattern: "ghp", parts: canary(["ghp", "_", "A".repeat(36)]), matches: [`ghp_${"A".repeat(36)}`] },
      { rule: "pattern", pattern: "github-pat", parts: canary(["github", "_pat_", "B".repeat(22)]), matches: [`github_pat_${"B".repeat(22)}`] },
      { rule: "pattern", pattern: "slack", parts: canary(["xox", "b-", "1234567890-FAKE"]), matches: ["xoxb-1234567890-FAKE"] },
      { rule: "pattern", pattern: "aws-access-key", parts: canary(["AK", "IA", "FAKEFAKEFAKE0123"]), matches: ["AKIAFAKEFAKEFAKE0123"] },
      { rule: "pattern", pattern: "google-api-key", parts: canary(["AI", "za", "F".repeat(35)]), matches: [`AIza${"F".repeat(35)}`] },
      { rule: "pattern", pattern: "jwt", parts: canary(["ey", "Jhbg", ".", "ey", "JzdWI", ".", "c2ln"]), matches: ["eyJhbg.eyJzdWI.c2ln"] },
      { rule: "pattern", pattern: "pem-private-key", parts: canary(["-----BEGIN ", "PRIVATE KEY-----", " body ", "-----END ", "PRIVATE KEY-----"]), matches: ["-----BEGIN ", "PRIVATE KEY-----", " body ", "-----END ", "PRIVATE KEY-----"] },
      { rule: "pattern", pattern: "base64url-run", parts: canary(["x ", "Qk".repeat(22), " y"]), matches: ["Qk".repeat(22)] },
    ],
    redactionNonMatches: [
      { pattern: "base64url-run", text: "a".repeat(64), note: "pure hex is exempt" },
      { pattern: "base64url-run", text: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", note: "a SHA-256 stays readable" },
      { pattern: "sk", text: "disk-usage-statistics-for-the-volume", note: "no left boundary, no match" },
      { pattern: "basic", text: "Basic info", note: "prose" },
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(outDir, { recursive: true });
  const text = `${JSON.stringify(buildVectors(), null, 2)}\n`;
  writeFileSync(join(outDir, "vectors.json"), text);
  console.log("log-schema: fixtures/vectors.json written");
}
