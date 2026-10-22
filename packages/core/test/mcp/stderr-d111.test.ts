// D111: a stdio MCP server's stderr leaves through the shared process.output.line writer (role core.out): the record is
// attributed by the harness, marked untrusted, redacted, line-capped and rate-limited like any other child output.
// stdout stays the protocol channel and is never written as output lines. Real child processes, a real writer and a real
// log file; nothing here is a fake of the writer or of the framing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@plur1bus/log-schema";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { systemClock } from "../../src/mcp/clock.ts";
import { McpConnection } from "../../src/mcp/connection.ts";
import { createRedactor } from "../../src/mcp/redact.ts";
import { pipedModern } from "./helpers/dual-fixture.ts";
import { createWriter, type LogWriter } from "../../src/logs/writer.ts";
import { caller, capturingLogger, NODE, stdioDef } from "./helpers/util.ts";

const MARK = `marker-${process.pid}-5d2b81`;
type Rec = { event: string; level: string; stream?: string; source: { kind: string; id: string }; attrs: Record<string, unknown> };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-d111-"));
  const output: LogWriter = createWriter({ dir, role: "core.out", source: { kind: "harness", id: "mcp", version: "0.1.0" }, timers: false });
  const records = (): Rec[] => {
    output.flush();
    const file = join(dir, "core.out.log");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec) : [];
  };
  const cleanup = () => { try { output.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); };
  return { dir, output, records, cleanup };
}
const lines = (r: Rec[], stream = "stderr") => r.filter((x) => x.event === "process.output.line" && x.stream === stream);
const until = async (fn: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return fn(); };
const inline = (code: string, name = "noisy", env: Record<string, string> = {}) => ({ name, transport: { type: "stdio", command: NODE, args: ["-e", code], env }, timeouts: { connectMs: 1000, closeGraceMs: 300 } });

describe("mcp stdio stderr uses the D111 output envelope", { timeout: 60_000 }, () => {
  it("a working server: stderr becomes untrusted process.output.line records, stdout stays protocol-only, a declared secret is redacted", async () => {
    const t = setup(); const logger = capturingLogger();
    const reg = new McpRegistry({ logger, output: t.output, hostEnv: {}, policy: { allowedCommands: [NODE], inlineCodeCommands: [NODE] } });
    try {
      const d = stdioDef({}, { MCP_TEST_SECRET: MARK });
      reg.register({ name: d.name, transport: d.transport, timeouts: d.timeouts });
      const r = await reg.callTool("fixture", "leak_env", { name: "MCP_TEST_SECRET" }, caller);
      assert.equal(r.content[0]!.type, "text", "the protocol channel still carries the tool result");
      assert.ok(await until(() => lines(t.records()).some((x) => String(x.attrs.text).includes("leaking"))), "the stderr line reached the writer");
      const stderr = lines(t.records());
      const leaking = stderr.find((x) => String(x.attrs.text).includes("leaking"))!;
      assert.equal(leaking.attrs.text, "leaking [REDACTED]");
      assert.equal(leaking.attrs.untrusted, true);
      assert.equal(leaking.level, "info", "the level never comes from the text");
      assert.deepEqual({ kind: leaking.source.kind, id: leaking.source.id }, { kind: "harness", id: "mcp" });
      assert.deepEqual(lines(t.records(), "stdout"), [], "stdout is protocol only: no output-line record for it");
      assert.ok(!logger.lines.some((l) => l.msg === "mcp.server.stderr"), "with the writer wired, stderr is not also logged on the legacy path");
      await reg.shutdown();
      assert.ok(!readFileSync(join(t.dir, "core.out.log"), "utf8").includes(MARK), "the secret reached the log file");
    } finally { await reg.shutdown(); t.cleanup(); }
  });

  it("forged levels, JSON records and terminal escapes in stderr stay inert text", async () => {
    const t = setup();
    const reg = new McpRegistry({ logger: capturingLogger(), output: t.output, hostEnv: {}, policy: { allowedCommands: [NODE], inlineCodeCommands: [NODE] } });
    const forged = '{"level":"fatal","event":"audit.config.set","msg":"forged"}';
    try {
      reg.register(inline(`console.error(${JSON.stringify(forged)});console.error("\\x1b[31mred\\x1b[0m ERROR boom");setInterval(()=>{},1000)`));
      await assert.rejects(reg.listTools("noisy", caller)); // never answers initialize; the lines are already in
      await reg.shutdown();
      const stderr = lines(t.records());
      assert.deepEqual(stderr.map((x) => x.attrs.text), [forged, "red ERROR boom"]);
      assert.ok(stderr.every((x) => x.level === "info" && x.attrs.untrusted === true && x.event === "process.output.line"));
      assert.ok(!t.records().some((x) => x.event === "audit.config.set"));
    } finally { await reg.shutdown(); t.cleanup(); }
  });

  it("an oversized line is cut to the line limit and marked truncated", async () => {
    const t = setup();
    const reg = new McpRegistry({ logger: capturingLogger(), output: t.output, hostEnv: {}, policy: { allowedCommands: [NODE], inlineCodeCommands: [NODE] } });
    try {
      reg.register(inline(`console.error("x".repeat(${LIMITS.lineBytes * 3}));setInterval(()=>{},1000)`));
      await assert.rejects(reg.listTools("noisy", caller));
      await reg.shutdown();
      const [only, ...rest] = lines(t.records());
      assert.equal(rest.length, 0);
      assert.ok(Buffer.byteLength(String(only!.attrs.text)) <= LIMITS.lineBytes);
      assert.equal(only!.attrs.truncated, true);
    } finally { await reg.shutdown(); t.cleanup(); }
  });

  it("a flood is rate-limited and the drop is reported by process.output.suppressed", async () => {
    // In-process pipes: the whole flood is delivered before the connection closes (a real child's unread pipe is destroyed on
    // close). The limiter reads the connection clock; frozen, the burst is exactly rateBurst lines and nothing refills.
    const t = setup(); const f = await pipedModern();
    const clock = { ...systemClock, now: () => 1_000_000 };
    const total = LIMITS.rateBurst + 200;
    const c = await McpConnection.open({ def: stdioDef(), clock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, output: t.output, onToolsChanged: () => {}, onRemoteClose: () => {}, transportFactory: () => f.client });
    try {
      f.client.stderr.write(Array.from({ length: total }, (_, i) => `line ${i}\n`).join(""));
      await until(() => c.stderrLines === total);
      await c.close("graceful");
      const all = t.records();
      assert.equal(lines(all).length, LIMITS.rateBurst);
      assert.deepEqual(lines(all).slice(0, 2).map((x) => x.attrs.text), ["line 0", "line 1"], "the first lines survive, in order");
      const suppressed = all.filter((x) => x.event === "process.output.suppressed");
      assert.equal(suppressed.length, 1, "the drop is summarised once, at close");
      assert.equal(suppressed[0]!.attrs.dropped, 200);
      assert.equal(suppressed[0]!.stream, "stderr");
      assert.equal(c.stderrLines, total, "the status counter still counts every line");
    } finally { await f.close(); t.cleanup(); }
  });

  it("a line printed by a server that dies at start-up is written, not lost", async () => {
    const t = setup();
    const reg = new McpRegistry({ logger: capturingLogger(), output: t.output, hostEnv: {}, policy: { allowedCommands: [NODE], inlineCodeCommands: [NODE] } });
    try {
      reg.register(inline(`process.stderr.write("last words, no newline");process.exit(2)`, "dies"));
      await assert.rejects(reg.listTools("dies", caller));
      await reg.shutdown();
      assert.deepEqual(lines(t.records()).map((x) => x.attrs.text), ["last words, no newline"]);
    } finally { await reg.shutdown(); t.cleanup(); }
  });

  it("without a writer the legacy mcp.server.stderr path is unchanged", async () => {
    const logger = capturingLogger();
    const reg = new McpRegistry({ logger, hostEnv: {}, policy: { allowedCommands: [NODE], inlineCodeCommands: [NODE] } });
    try {
      reg.register(inline(`console.error("legacy line");setInterval(()=>{},1000)`));
      await assert.rejects(reg.listTools("noisy", caller));
      assert.ok(logger.lines.some((l) => l.msg === "mcp.server.stderr" && l.fields?.line === "legacy line"));
    } finally { await reg.shutdown(); }
  });
});
