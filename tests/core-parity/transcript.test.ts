import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareTranscripts, normalisePlatformValues, normaliseTranscript, parseTranscript, serialiseTranscript, type TranscriptLine } from "./transcript.ts";

const req = (seq: number, conn: number, id: number, method: string, params: unknown = {}): TranscriptLine => ({ seq, conn, dir: "in", msg: { jsonrpc: "2.0", id, method, params } });
const res = (seq: number, conn: number, id: number, result: unknown): TranscriptLine => ({ seq, conn, dir: "out", msg: { jsonrpc: "2.0", id, result } });
const err = (seq: number, conn: number, id: number, code: number, data: unknown): TranscriptLine => ({ seq, conn, dir: "out", msg: { jsonrpc: "2.0", id, error: { code, message: "m", data } } });
const note = (seq: number, conn: number, method: string, params: unknown): TranscriptLine => ({ seq, conn, dir: "out", msg: { jsonrpc: "2.0", method, params } });
const U1 = "16f7393b-f40a-40a5-a4f6-68501d9bb9f0";
const U2 = "8a5f588a-0d16-4df3-8d14-6903253dfcb3";

describe("transcript format", () => {
  it("round-trips and ignores blank lines", () => {
    const lines = [req(1, 0, 1, "core.status"), res(2, 0, 1, { a: 1 })];
    const text = serialiseTranscript(lines);
    assert.ok(text.endsWith("\n"));
    assert.deepEqual(parseTranscript(`\n${text}\n`), lines);
  });

  it("names the line of a malformed transcript", () => {
    assert.throws(() => parseTranscript('{"seq":1,"conn":0,"dir":"in","msg":{}}\nnot json\n'), /line 2/);
    assert.throws(() => parseTranscript('{"seq":1,"conn":0,"dir":"sideways","msg":{}}\n'), /line 1.*dir/);
  });
});

describe("normalisation", () => {
  it("numbers ids by first appearance, so two runs with different uuids look alike, and keeps reuse visible", () => {
    const a = normaliseTranscript([res(1, 0, 1, { subscriptionId: U1 }), req(2, 0, 2, "events.unsubscribe", { subscriptionId: U1 })]);
    const b = normaliseTranscript([res(1, 0, 1, { subscriptionId: U2 }), req(2, 0, 2, "events.unsubscribe", { subscriptionId: U2 })]);
    assert.deepEqual(a, b);
    assert.deepEqual((a[1]!.msg as any).params, { subscriptionId: "<id#1>" });
    const mixed = normaliseTranscript([res(1, 0, 1, { subscriptionId: U1 }), req(2, 0, 2, "events.unsubscribe", { subscriptionId: U2 })]);
    assert.deepEqual((mixed[1]!.msg as any).params, { subscriptionId: "<id#2>" });
  });

  it("numbers a uuid behind an underscore prefix too (`prj_<uuid>`, P4-10), but not one glued to a longer word", () => {
    const [l] = normaliseTranscript([res(1, 0, 1, { id: `prj_${U1}`, same: U1, glued: `x${U2}` })]);
    assert.deepEqual((l!.msg as any).result, { id: "prj_<id#1>", same: "<id#1>", glued: `x${U2}` });
  });

  it("masks times and pids by key, keeps null, and masks ISO strings", () => {
    const [l] = normaliseTranscript([res(1, 0, 1, { pid: 4242, uptimeMs: 59, since: 1, checkedAt: null, observedAt: 7, stamp: "2026-01-01T00:00:00.000Z", count: 3 })]);
    assert.deepEqual((l!.msg as any).result, { pid: "<pid>", uptimeMs: "<time>", since: "<time>", checkedAt: null, observedAt: "<time>", stamp: "<iso>", count: 3 });
  });

  it("masks the wall-clock acceptance time and measured durations by name (P4-10), never a configured limit", () => {
    const [l] = normaliseTranscript([res(1, 0, 1, { acceptedAt: 1767225600061, expiresAt: 1794165200112, durationMs: 4, timing: { totalMs: 22, phases: { elapsedMs: 22, completed: [{ phase: "embed", ms: 3 }] } }, recallTimeoutMs: 10000, budgetMs: 600 })]);
    assert.deepEqual((l!.msg as any).result, { acceptedAt: "<time>", expiresAt: "<time>", durationMs: "<time>", timing: { totalMs: "<time>", phases: { elapsedMs: "<time>", completed: [{ phase: "embed", ms: "<time>" }] } }, recallTimeoutMs: 10000, budgetMs: 600 });
  });
});

describe("comparison", () => {
  const base = [req(1, 0, 1, "core.status"), res(2, 0, 1, { n: 1, pid: 10, instanceId: U1 }), req(3, 0, 2, "events.subscribe", {}), res(4, 0, 2, { subscriptionId: U2 }), note(5, 0, "a.one", { x: 1 }), note(6, 0, "a.two", { x: 2 })];

  it("passes when only ids, times and pids differ", () => {
    const other = [req(1, 0, 1, "core.status"), res(2, 0, 1, { n: 1, pid: 99, instanceId: U2 }), req(3, 0, 2, "events.subscribe", {}), res(4, 0, 2, { subscriptionId: U1 }), note(5, 0, "a.one", { x: 1 }), note(6, 0, "a.two", { x: 2 })];
    assert.deepEqual(compareTranscripts(base, other), { ok: true, diffs: [] });
  });

  it("lets notifications arrive in a different order, and between other frames, unless strict", () => {
    const reordered = [base[0]!, base[1]!, base[2]!, note(4, 0, "a.two", { x: 2 }), base[3]!, note(6, 0, "a.one", { x: 1 })];
    assert.equal(compareTranscripts(base, reordered).ok, true);
    const strict = compareTranscripts(base, reordered, { strictOrder: true });
    assert.equal(strict.ok, false);
  });

  it("says where a result differs, with the method it answers", () => {
    const changed = base.map((l) => (l.seq === 2 ? res(2, 0, 1, { n: 2, pid: 10, instanceId: U1 }) : l));
    const r = compareTranscripts(base, changed);
    assert.equal(r.ok, false);
    assert.deepEqual(r.diffs, ["conn 0, response to #1 core.status: $.result.n: expected 1, got 2"]);
  });

  it("reports an error code change, a missing response and an unexpected notification", () => {
    const a = [req(1, 0, 1, "x.y"), err(2, 0, 1, -32000, { error: "E_DENIED" })];
    const b = [req(1, 0, 1, "x.y"), err(2, 0, 1, -32000, { error: "E_INTERNAL", reason: "r" })];
    assert.deepEqual(compareTranscripts(a, b).diffs, ['conn 0, response to #1 x.y: $.error.data.error: expected "E_DENIED", got "E_INTERNAL"', 'conn 0, response to #1 x.y: $.error.data.reason: unexpected, got "r"']);
    const missing = compareTranscripts(a, [req(1, 0, 1, "x.y")]);
    assert.deepEqual(missing.diffs, ["conn 0, response to #1 x.y: expected a response, none received"]);
    const extra = compareTranscripts(a, [...a, note(3, 0, "z.event", { k: 1 })]);
    assert.deepEqual(extra.diffs, ['conn 0: unexpected notification z.event {"k":1}']);
    const lost = compareTranscripts([...a, note(3, 0, "z.event", { k: 1 })], a);
    assert.deepEqual(lost.diffs, ['conn 0: expected notification z.event {"k":1}, none received']);
  });

  it("compares the requests that were sent too", () => {
    const r = compareTranscripts([req(1, 0, 1, "a.b", { q: 1 })], [req(1, 0, 1, "a.b", { q: 2 })]);
    assert.deepEqual(r.diffs, ["conn 0, request #1 a.b: $.params.q: expected 1, got 2"]);
  });
});

describe("platform-dependent values (core.status engine.sharedMemory.mode)", () => {
  const status = (mode: string, method = "core.status", result: (m: string) => unknown = (m) => ({ engine: { sharedMemory: { supported: true, mode: m } } })) =>
    [req(1, 0, 1, "core.auth"), res(2, 0, 1, { ok: true }), req(3, 0, 2, method), res(4, 0, 2, result(mode))];

  it("the two platform modes count as equal: a macOS recording (verified-path) replays on Linux (fd-capability)", () => {
    assert.deepEqual(compareTranscripts(status("verified-path"), status("fd-capability")), { ok: true, diffs: [] });
    assert.deepEqual(compareTranscripts(status("fd-capability"), status("verified-path")), { ok: true, diffs: [] });
  });

  it("any other mode is still a difference, also against a normalised recording", () => {
    assert.deepEqual(compareTranscripts(status("verified-path"), status("unavailable")).diffs,
      ['conn 0, response to #2 core.status: $.result.engine.sharedMemory.mode: expected "<shared-memory-mode>", got "unavailable"']);
    assert.equal(compareTranscripts(normalisePlatformValues(status("fd-capability")), status("unavailable")).ok, false);
    assert.equal(compareTranscripts(status("unavailable"), status("unavailable")).ok, true);
  });

  it("is bound to that path of the core.status result: the same values elsewhere are compared as they are", () => {
    assert.equal(compareTranscripts(status("verified-path", "x.status"), status("fd-capability", "x.status")).ok, false);
    const flat = (m: string) => ({ mode: m, engine: { mode: m, sharedMemory: { supported: true, mode: "verified-path" } } });
    assert.equal(compareTranscripts(status("verified-path", "core.status", flat), status("fd-capability", "core.status", flat)).ok, false);
  });

  it("the recording keeps a placeholder for the two platform modes only, and leaves everything else as recorded", () => {
    const recorded = normalisePlatformValues(status("verified-path"));
    assert.deepEqual((recorded[3]!.msg as any).result, { engine: { sharedMemory: { supported: true, mode: "<shared-memory-mode>" } } });
    assert.deepEqual(recorded.slice(0, 3), status("verified-path").slice(0, 3));
    assert.deepEqual(normalisePlatformValues(status("unavailable")), status("unavailable"));
    assert.deepEqual(normalisePlatformValues(recorded), recorded, "idempotent");
  });
});

describe("error texts (controller ruling P4-03, applied by P4-10)", () => {
  const invalid = (seq: number, message: string, data: Record<string, unknown>): TranscriptLine =>
    ({ seq, conn: 0, dir: "out", msg: { jsonrpc: "2.0", id: 1, error: { code: -32602, message, data: { error: "E_INVALID_PARAMS", ...data } } } });
  const base = [req(1, 0, 1, "memory.list", { x: 1 })];
  it("the message and detail of E_INVALID_PARAMS are not compared", () => {
    const ajv = [...base, invalid(2, "invalid params", { detail: "/ must NOT have additional properties" })];
    const rust = [...base, invalid(2, "invalid params", { detail: "/ Additional properties are not allowed ('x' was unexpected)" })];
    assert.deepEqual(compareTranscripts(ajv, rust), { ok: true, diffs: [] });
    assert.deepEqual(compareTranscripts(ajv, [...base, invalid(2, "params refused", { detail: "other" })]).ok, true);
  });
  it("the code, the reason and the presence of a detail still are, and other errors keep their text", () => {
    const want = [...base, invalid(2, "invalid request", { reason: "invalid-request", detail: "a" })];
    assert.equal(compareTranscripts(want, [...base, invalid(2, "invalid request", { reason: "parse-error", detail: "a" })]).ok, false);
    assert.equal(compareTranscripts(want, [...base, invalid(2, "invalid request", { reason: "invalid-request" })]).ok, false);
    const denied = (m: string) => [...base, err(2, 0, 1, -32000, { error: "E_DENIED", reason: "r" })].map((l) => l.dir === "out" ? { ...l, msg: { ...(l.msg as object), error: { code: -32000, message: m, data: { error: "E_DENIED", reason: "r" } } } } : l);
    assert.equal(compareTranscripts(denied("a"), denied("b")).ok, false);
  });
});
