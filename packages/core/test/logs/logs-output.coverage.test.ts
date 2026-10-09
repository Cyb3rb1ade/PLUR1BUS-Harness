import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "@plur1bus/log-schema";
import { OutputLines, sanitise, signalLevel, wrapOutput } from "../../src/logs/output.ts";
import type { LogWriter } from "../../src/logs/writer.ts";

interface Call { event: string; attrs: Record<string, any>; fields: Record<string, any> }
function fakeWriter() {
  const calls: Call[] = [];
  const writer = { write: (event: string, attrs: Record<string, any> = {}, fields: Record<string, any> = {}) => { calls.push({ event, attrs, fields }); } } as unknown as LogWriter;
  return { writer, calls, lines: () => calls.filter(c => c.event === "process.output.line"), suppressed: () => calls.filter(c => c.event === "process.output.suppressed") };
}
function clock(start = 1_000_000) { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; }
const buf = (s: string) => Buffer.from(s, "utf8");

describe("sanitise", () => {
  const cases: Array<[string, string, string]> = [
    ["plain text", "hello world", "hello world"],
    ["empty", "", ""],
    ["keeps tab", "a\tb", "a\tb"],
    ["strips CSI colour", "\x1b[31mred\x1b[0m", "red"],
    ["strips CSI with intermediate bytes", "a\x1b[?25l\x1b[1;2 qb", "ab"],
    ["strips OSC terminated by BEL", "a\x1b]0;title\x07b", "ab"],
    ["strips OSC terminated by ST", "a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b", "alinkb"],
    ["strips an unterminated OSC up to the end", "keep\x1b]0;never ends", "keep"],
    ["strips C0 controls (NUL, BEL, BS, CR, LF, ESC)", "a\x00b\x07c\x08d\re\nf\x1bg", "abcdefg"],
    ["strips DEL and C1 range", "a\x7fb\x80c\x9fd", "abcd"],
    ["keeps U+00A0 and above", "a bĀc", "a bĀc"],
    ["keeps unicode and emoji", "grüße 日本語 😀", "grüße 日本語 😀"],
    ["lone ESC is removed as control", "x\x1by", "xy"],
  ];
  for (const [label, input, expected] of cases) it(label, () => { assert.equal(sanitise(input), expected); });
});

describe("signalLevel", () => {
  const cases: Array<[string, Parameters<typeof signalLevel>[0], string]> = [
    ["empty signal", {}, "info"],
    ["exit code 0", { exitCode: 0 }, "info"],
    ["exit code 1", { exitCode: 1 }, "error"],
    ["negative exit code", { exitCode: -1 }, "error"],
    ["killed by signal", { signal: "SIGKILL" }, "error"],
    ["signal with exit code 0", { signal: "SIGTERM", exitCode: 0 }, "error"],
    ["protocol error", { protocolError: true }, "error"],
    ["protocolError false", { protocolError: false }, "info"],
    ["http 200", { httpStatus: 200 }, "info"],
    ["http 399", { httpStatus: 399 }, "info"],
    ["http 400 not retrying", { httpStatus: 400 }, "error"],
    ["http 429 not retrying", { httpStatus: 429 }, "error"],
    ["http 429 retrying", { httpStatus: 429, retrying: true }, "warn"],
    ["http 503 retrying", { httpStatus: 503, retrying: true }, "warn"],
    ["http 503 retrying false", { httpStatus: 503, retrying: false }, "error"],
    ["http 500 retrying", { httpStatus: 500, retrying: true }, "error"],
    ["http 404 retrying", { httpStatus: 404, retrying: true }, "error"],
    ["retrying without status", { retrying: true }, "info"],
    ["http 200 retrying", { httpStatus: 200, retrying: true }, "info"],
    ["exit 0 with http 500", { exitCode: 0, httpStatus: 500 }, "error"],
    ["signal beats retrying", { signal: "SIGINT", httpStatus: 429, retrying: true }, "error"],
  ];
  for (const [label, input, expected] of cases) it(label, () => { assert.equal(signalLevel(input), expected); });
});

describe("OutputLines", () => {
  it("emits complete lines with stream metadata and bypassRate", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stderr", { now: clock().now });
    o.push(buf("one\ntwo\n"));
    assert.deepEqual(f.calls, [
      { event: "process.output.line", attrs: { text: "one", untrusted: true }, fields: { stream: "stderr", bypassRate: true } },
      { event: "process.output.line", attrs: { text: "two", untrusted: true }, fields: { stream: "stderr", bypassRate: true } },
    ]);
  });
  it("uses Date.now when no clock is given", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout");
    o.push(buf("x\n")); assert.equal(f.lines().length, 1);
  });
  it("joins a line split across chunks and holds back the unterminated tail", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout", { now: clock().now });
    o.push(buf("hel")); o.push(buf("lo\nwor")); assert.deepEqual(f.lines().map(c => c.attrs.text), ["hello"]);
    o.push(buf("ld\n")); assert.deepEqual(f.lines().map(c => c.attrs.text), ["hello", "world"]);
  });
  it("emits an empty text for an empty line and sanitises content", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout", { now: clock().now });
    o.push(buf("\n\x1b[1mbold\x1b[0m\r\n"));
    assert.deepEqual(f.lines().map(c => c.attrs.text), ["", "bold"]);
  });
  it("pushing an empty buffer does nothing", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout", { now: clock().now });
    o.push(Buffer.alloc(0)); o.close(); assert.deepEqual(f.calls, []);
  });
  it("decodes a multi-byte character split across chunks", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout", { now: clock().now });
    const bytes = buf("€😀\n");
    o.push(bytes.subarray(0, 2)); o.push(bytes.subarray(2, 5)); o.push(bytes.subarray(5));
    assert.deepEqual(f.lines().map(c => c.attrs.text), ["€😀"]);
  });
  it("lines longer than 4096 bytes are marked truncated with their byte count; exactly 4096 is not", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout", { now: clock().now });
    o.push(buf("a".repeat(4096) + "\n")); o.push(buf("b".repeat(4097) + "\n"));
    const [a, b] = f.lines();
    assert.equal("truncated" in a!.attrs, false);
    assert.equal(b!.attrs.truncated, true); assert.equal(b!.attrs.bytes, 4097); assert.equal(b!.attrs.text.length, 4097);
  });
  it("a line over 64 KiB is replaced wholesale by a marker; 64 KiB exactly is kept", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout", { now: clock().now });
    o.push(buf("c".repeat(65536) + "\n"));
    o.push(buf("SECRET=" + "d".repeat(70000) + "\n"));
    const [kept, replaced] = f.lines();
    assert.equal(kept!.attrs.text.length, 65536); assert.equal(kept!.attrs.bytes, 65536);
    assert.equal(replaced!.attrs.text, "[TRUNCATED:oversized-line]"); assert.equal(replaced!.attrs.bytes, 70007); assert.equal(replaced!.attrs.truncated, true);
  });
  it("an oversized line delivered over several chunks is still replaced and the next line is clean", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout", { now: clock().now });
    for (let i = 0; i < 5; i++) o.push(buf("e".repeat(20000)));
    o.push(buf("\nnext\n"));
    assert.deepEqual(f.lines().map(c => c.attrs.text), ["[TRUNCATED:oversized-line]", "next"]);
  });
  it("rate limits after the burst, drops the rest and reports a summary on tick after one second", () => {
    const f = fakeWriter(); const c = clock(); const o = new OutputLines(f.writer, "stdout", { now: c.now });
    const total = LIMITS.rateBurst + 10;
    for (let i = 0; i < total; i++) o.push(buf(`l${i}\n`));
    assert.equal(f.lines().length, LIMITS.rateBurst);
    o.tick(); assert.equal(f.suppressed().length, 0); // < 1000 ms
    c.advance(1000); o.tick();
    assert.deepEqual(f.suppressed().map(s => s.attrs), [{ dropped: 10, window_ms: 1000 }]);
    assert.deepEqual(f.suppressed()[0]!.fields, { stream: "stdout", bypassRate: true });
    c.advance(5000); o.tick(); assert.equal(f.suppressed().length, 1); // dropped reset
  });
  it("tokens refill over time so lines pass again", () => {
    const f = fakeWriter(); const c = clock(); const o = new OutputLines(f.writer, "stdout", { now: c.now });
    for (let i = 0; i < LIMITS.rateBurst + 5; i++) o.push(buf("x\n"));
    c.advance(60_000); o.push(buf("after\n"));
    assert.equal(f.lines().at(-1)!.attrs.text, "after");
  });
  it("a backwards clock does not add tokens", () => {
    const f = fakeWriter(); const c = clock(); const o = new OutputLines(f.writer, "stdout", { now: c.now });
    for (let i = 0; i < LIMITS.rateBurst; i++) o.push(buf("x\n"));
    c.advance(-10_000); o.push(buf("y\n"));
    assert.equal(f.lines().length, LIMITS.rateBurst);
  });
  it("tick flushes a partial line that has been idle for one second, not earlier", () => {
    const f = fakeWriter(); const c = clock(); const o = new OutputLines(f.writer, "stdout", { now: c.now });
    o.tick(); assert.deepEqual(f.calls, []); // nothing buffered
    o.push(buf("partial")); c.advance(999); o.tick(); assert.equal(f.lines().length, 0);
    c.advance(1); o.tick(); assert.deepEqual(f.lines().map(x => x.attrs.text), ["partial"]);
    o.push(buf("-more\n")); assert.deepEqual(f.lines().map(x => x.attrs.text), ["partial", "-more"]);
  });
  it("tick flushes a pending partial multi-byte character without crashing", () => {
    const f = fakeWriter(); const c = clock(); const o = new OutputLines(f.writer, "stdout", { now: c.now });
    o.push(Buffer.concat([buf("ab"), buf("€").subarray(0, 2)]));
    c.advance(2000); o.tick();
    assert.equal(f.lines().length, 1); assert.ok(f.lines()[0]!.attrs.text.startsWith("ab"));
  });
  it("close emits a trailing partial line and a final summary, then rejects further pushes; close is idempotent", () => {
    const f = fakeWriter(); const c = clock(); const o = new OutputLines(f.writer, "stdout", { now: c.now });
    for (let i = 0; i < LIMITS.rateBurst + 3; i++) o.push(buf("x\n"));
    o.push(buf("tail")); c.advance(10);
    o.close();
    assert.equal(f.lines().at(-1)!.attrs.text, "tail");
    assert.deepEqual(f.suppressed().map(s => s.attrs.dropped), [3]);
    const n = f.calls.length;
    o.close(); assert.equal(f.calls.length, n);
    assert.throws(() => o.push(buf("x")), /output wrapper closed/);
  });
  it("close with nothing buffered and nothing dropped writes nothing", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout", { now: clock().now });
    o.push(buf("done\n")); o.close(); assert.equal(f.calls.length, 1);
  });
});

describe("wrapOutput", () => {
  async function* chunks(...parts: Array<string | Error>): AsyncGenerator<Buffer> {
    for (const p of parts) { if (p instanceof Error) throw p; yield buf(p); }
  }
  it("resolves immediately when no streams are given or entries are undefined", async () => {
    const f = fakeWriter();
    await wrapOutput(f.writer, {});
    await wrapOutput(f.writer, {});
    assert.deepEqual(f.calls, []);
  });
  it("writes stderr lines only when stdout is omitted (MCP protocol stream)", async () => {
    const f = fakeWriter();
    await wrapOutput(f.writer, { stderr: chunks("err1\nerr", "2\n") });
    assert.deepEqual(f.calls.map(c => [c.attrs.text, c.fields.stream]), [["err1", "stderr"], ["err2", "stderr"]]);
  });
  it("handles both streams and flushes the unterminated tail at the end", async () => {
    const f = fakeWriter();
    await wrapOutput(f.writer, { stdout: chunks("out\n", "tail"), stderr: chunks("e\n") });
    const byStream = (s: string) => f.lines().filter(c => c.fields.stream === s).map(c => c.attrs.text);
    assert.deepEqual(byStream("stdout"), ["out", "tail"]); assert.deepEqual(byStream("stderr"), ["e"]);
  });
  it("closes the wrapper (flushing the tail) and rejects when the stream errors", async () => {
    const f = fakeWriter();
    await assert.rejects(wrapOutput(f.writer, { stdout: chunks("ok\n", "half", new Error("pipe broke")) }), /pipe broke/);
    assert.deepEqual(f.lines().map(c => c.attrs.text), ["ok", "half"]);
  });
  it("runs the idle-tick timer: a partial line stays buffered until the stream ends under fake timers", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    const f = fakeWriter();
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    async function* slow(): AsyncGenerator<Buffer> { yield buf("idle"); await gate; }
    const done = wrapOutput(f.writer, { stdout: slow() });
    await new Promise<void>(r => setImmediate(r));
    t.mock.timers.tick(2000);
    assert.deepEqual(f.lines().map(c => c.attrs.text), ["idle"]);
    release(); await done;
    assert.equal(f.lines().length, 1);
  });
});
