import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CATALOGUE, KEY_ORDER, LEVELS, LIMITS, RECORD_SCHEMA, SOURCE_KINDS, attrsSchemaFor, compareLevels, isLevel, isSourceKey, levelAtLeast, levelInfo,
  lookupEvent, severityNumber, severityText, syslogSeverity, validateLine, validateRecord,
} from "../src/index.ts";

const rec = (event: string) => structuredClone(CATALOGUE.events.find((e) => e.event === event)!.examples[0]!);

test("the schema validates every catalogue example", () => {
  assert.ok(CATALOGUE.events.length >= 120, "the initial catalogue of spec §3.2");
  for (const entry of CATALOGUE.events) {
    assert.ok(entry.examples.length >= 1, `${entry.event} has an example`);
    for (const example of entry.examples) {
      const r = validateRecord(example);
      assert.ok(r.ok, `${entry.event}: ${r.ok ? "" : `${r.code} ${r.detail}`}`);
      assert.equal(lookupEvent((example as { event: string }).event), entry, `${entry.event}: the example's event resolves to its own entry`);
      assert.equal(validateLine(JSON.stringify(example)).ok, true);
    }
  }
});

test("an unknown event is rejected", () => {
  for (const name of ["made.up.event", "supervisor.child.given_up.forged", "repair", "Not A Name", "", "a", "x.y.z.w.v"]) {
    const r = { ...rec("provider.request.failed"), event: name };
    const v = validateRecord(r);
    assert.ok(!v.ok && v.code === "unknown_event", `${JSON.stringify(name)} → ${JSON.stringify(v)}`);
  }
  // A forged record that borrows another source's event name is not unknown, but its kind is not allowed.
  const forged = { ...rec("supervisor.child.given_up"), source: { kind: "extension", id: "plugin/evil", version: "1" } };
  const v = validateRecord(forged);
  assert.ok(!v.ok && v.code === "source_kind_not_allowed");
});

test("an invalid level is rejected", () => {
  for (const level of ["verbose", "INFO", "Warn", "", "notice", "critical", 9, null, undefined, true]) {
    const v = validateRecord({ ...rec("provider.request.failed"), level });
    assert.ok(!v.ok && v.code === "invalid_level", `${String(level)} → ${JSON.stringify(v)}`);
  }
  // A real level that the event does not allow is a different failure.
  const v = validateRecord({ ...rec("provider.request.failed"), level: "fatal" });
  assert.ok(!v.ok && v.code === "level_not_allowed");
});

test("the level mapping table is fully tested (§2.6)", () => {
  const expected = [
    ["trace", 0, 1, "TRACE", 7],
    ["debug", 1, 5, "DEBUG", 7],
    ["info", 2, 9, "INFO", 6],
    ["warn", 3, 13, "WARN", 4],
    ["error", 4, 17, "ERROR", 3],
    ["fatal", 5, 21, "FATAL", 2],
  ] as const;
  assert.deepEqual(LEVELS.map((l) => l.name), expected.map((x) => x[0]), "six levels, in rank order");
  assert.deepEqual(RECORD_SCHEMA.$defs.Level.enum, expected.map((x) => x[0]), "the record schema's enum is the level table");
  assert.deepEqual(LEVELS.map((l) => l.syslog.name), ["debug", "debug", "informational", "warning", "error", "critical"]);
  {
    const m = { compareLevels, isLevel, levelAtLeast, levelInfo, severityNumber, severityText, syslogSeverity };
    for (const [name, rank, sev, text, syslog] of expected) {
      assert.equal(m.severityNumber(name), sev, `${name} severity number`);
      assert.equal(m.severityText(name), text, `${name} severity text`);
      assert.equal(m.syslogSeverity(name), syslog, `${name} syslog severity`);
      assert.equal(m.levelInfo(name).rank, rank, `${name} rank`);
      assert.ok(m.isLevel(name));
    }
    // OTel reserves four numbers per level; the table uses the first of each range, strictly increasing.
    const nums = LEVELS.map((l) => l.otel.severityNumber);
    assert.deepEqual(nums, [1, 5, 9, 13, 17, 21]);
    // Syslog severities never increase as the level rises (a higher level is at least as urgent).
    const sys = LEVELS.map((l) => l.syslog.severity);
    for (let i = 1; i < sys.length; i++) assert.ok(sys[i]! <= sys[i - 1]!, "syslog severity is non-increasing");
    // Comparison and filtering over every ordered pair.
    for (const a of expected) for (const b of expected) {
      assert.equal(Math.sign(m.compareLevels(a[0], b[0])), Math.sign(a[1] - b[1]), `${a[0]} vs ${b[0]}`);
      assert.equal(m.levelAtLeast(a[0], b[0]), a[1] >= b[1], `${a[0]} >= ${b[0]}`);
    }
    // Anything outside the table throws instead of mapping silently.
    for (const bad of ["verbose", "INFO", "", "notice"]) {
      assert.throws(() => m.levelInfo(bad), RangeError, bad);
      assert.equal(m.isLevel(bad), false);
    }
  }
});

test("record key order, limits and source keys are the spec's", () => {
  assert.deepEqual(KEY_ORDER, ["ts", "level", "source", "event", "msg", "trace_id", "span_id", "agent", "session", "turn", "task", "principal", "duration_ms", "err", "stream", "attrs"]);
  assert.deepEqual(Object.keys(RECORD_SCHEMA.properties), [...KEY_ORDER], "the schema lists its properties in the written order");
  assert.deepEqual(SOURCE_KINDS, ["harness", "extension", "provider", "model", "cli", "channel", "host", "desktop", "os"]);
  assert.deepEqual({ ...LIMITS }, { msgBytes: 2048, attrsBytes: 8192, lineBytes: 4096, dedupWindowMs: 60000, rateSustainedPerSecond: 100, rateBurst: 500 });
  for (const ok of ["harness", "provider:openai", "extension:mcp-server", "extension:mcp-server/files", "model:ollama/llama3", "channel:telegram/bernd-bot", "harness:module/fixture"]) assert.ok(isSourceKey(ok), ok);
  for (const bad of ["", "plugin", "harness:", "Harness", "harness:UPPER", "provider:ope nai", "harness:" + "a".repeat(129), ":core", "os:", 5]) assert.ok(!isSourceKey(bad), String(bad));
});

test("the record rules: order, timestamps, limits, wrapped output, attrs", () => {
  const base = rec("provider.request.failed");
  const code = (v: ReturnType<typeof validateRecord>) => (v.ok ? "ok" : v.code);
  assert.equal(code(validateRecord({ level: base.level, ...base })), "key_order");
  assert.equal(code(validateLine(JSON.stringify(base).replace("{", `{"ts":"x",`))), "key_order", "duplicate keys are refused");
  assert.equal(code(validateRecord({ ...base, ts: "2026-02-30T09:14:03.218Z" })), "schema");
  assert.equal(code(validateRecord({ ...base, ts: "2024-02-29T09:14:03.218Z" })), "ok", "a real leap day");
  assert.equal(code(validateRecord({ ...base, msg: "x".repeat(2048) })), "ok");
  assert.equal(code(validateRecord({ ...base, msg: "x".repeat(2049) })), "msg_too_long");
  assert.equal(code(validateRecord({ ...base, msg: "é".repeat(1025) })), "msg_too_long", "bytes, not characters");
  assert.equal(code(validateRecord({ ...base, attrs: { ...(base as any).attrs, foreign_message: "z".repeat(2048), extra: "z".repeat(8200) } })), "attrs_too_large");
  const line = rec("process.output.line");
  assert.equal(code(validateRecord(line)), "ok");
  const { stream, ...noStream } = line as any;
  assert.equal(code(validateRecord(noStream)), "stream_mismatch");
  const { attrs: baseAttrs, ...baseHead } = base as any;
  assert.equal(code(validateRecord({ ...baseHead, stream: "stderr", attrs: baseAttrs })), "stream_mismatch", "a normal event must not carry a stream");
  assert.equal(code(validateRecord({ ...(line as any), attrs: { ...(line as any).attrs, untrusted: false } })), "attrs_invalid", "wrapped output is always marked untrusted");
  assert.equal(code(validateRecord({ ...base, attrs: { ...(base as any).attrs, surprise: 1 } })), "attrs_invalid");
  assert.equal(code(validateRecord("a string")), "not_object");
  assert.equal(code(validateLine("{broken")), "not_object");
  // `repair.<step>` is a family: any step name under the prefix is registered.
  assert.equal(code(validateRecord({ ...rec("repair.*"), event: "repair.service.renew" })), "ok");
});

test("the catalogue is well-formed and self-consistent", () => {
  const names = new Set<string>();
  const nameRe = new RegExp(CATALOGUE.nameRule);
  for (const e of CATALOGUE.events) {
    const probe = e.family ? `${e.event.slice(0, -2)}.step` : e.event;
    assert.ok(nameRe.test(probe), `${e.event}: name rule`);
    assert.ok(!names.has(e.event), `${e.event}: unique`);
    names.add(e.event);
    assert.ok(CATALOGUE.streams.includes(e.stream), `${e.event}: stream`);
    assert.ok(e.levels.includes(e.level), `${e.event}: default level is allowed`);
    for (const l of e.levels) assert.ok(LEVELS.some((x) => x.name === l), `${e.event}: level ${l}`);
    for (const k of e.kinds) assert.ok(SOURCE_KINDS.includes(k), `${e.event}: kind ${k}`);
    assert.ok(e.msg.length > 0 && e.msg.length <= LIMITS.msgBytes, `${e.event}: msg`);
    assert.ok(!/[{}$]/.test(e.msg), `${e.event}: msg is a constant, not a template with placeholders`);
    const group = CATALOGUE.attrGroups[e.attrs];
    assert.ok(group, `${e.event}: attrs group ${e.attrs}`);
    const known = { ...CATALOGUE.commonAttrs, ...group.properties };
    for (const k of e.requiredAttrs) assert.ok(k in known, `${e.event}: required attr ${k} is declared`);
    assert.equal(e.since, "D111");
    assert.ok(e.stability === "stable" || e.stability === "experimental");
    if (e.stream === "audit") assert.deepEqual(e.kinds, ["harness"], `${e.event}: audit is emitted by the harness`);
    if (e.event.startsWith("process.")) assert.deepEqual(e.kinds, [...SOURCE_KINDS], `${e.event}: process.* is allowed for every kind`);
    if (e.event.startsWith("log.") && e.stream !== "audit") assert.deepEqual(e.kinds, [...SOURCE_KINDS], `${e.event}: log.* is written by any writer`);
    assert.ok(attrsSchemaFor(e), `${e.event}: attrs schema builds`);
  }
  for (const [name, g] of Object.entries(CATALOGUE.attrGroups)) assert.ok(CATALOGUE.events.some((e) => e.attrs === name), `attrs group ${name} is used`);
  // Spot-check the spec's named rules.
  assert.deepEqual(lookupEvent("supervisor.child.exited")!.levels, ["info", "error", "fatal"]);
  assert.equal(lookupEvent("supervisor.child.given_up")!.level, "fatal");
  assert.equal(lookupEvent("scheduler.run.skipped")!.level, "info", "ADR-009: a skip is never below info");
  assert.ok(!lookupEvent("scheduler.run.skipped")!.levels.includes("debug"));
  assert.deepEqual(lookupEvent("process.output.line")!.levels, ["info"], "foreign text never raises a level");
  assert.deepEqual(lookupEvent("process.output.suppressed")!.levels, ["warn"]);
  assert.equal(lookupEvent("engine.acl.denied")!.stream, "diagnostic", "R11");
  assert.equal(lookupEvent("licence.accept-nc")!.stream, "audit");
  assert.equal(lookupEvent("repair.run.permissions.fix")!.event, "repair.*");
  for (const a of ["install", "enable", "disable", "uninstall", "purge", "restore"]) assert.equal(lookupEvent(`ext.${a}`)!.stream, "audit");
});

test("err.code is the RPC error enum plus the provider classes", () => {
  const rpc = JSON.parse(readFileSync(new URL("../../rpc-schema/schema/rpc.schema.json", import.meta.url), "utf8")) as { $defs: { ErrorCode: { enum: string[] } } };
  const ours = RECORD_SCHEMA.$defs.ErrCode.enum as string[];
  assert.deepEqual(ours.filter((c) => c.startsWith("E_")).sort(), [...rpc.$defs.ErrorCode.enum].sort(), "every RPC error code, nothing more");
  assert.deepEqual(ours.filter((c) => !c.startsWith("E_")), ["rate-limited", "overloaded", "auth", "invalid-request", "server", "timeout", "network"]);
});
