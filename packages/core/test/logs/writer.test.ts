import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import path from "node:path";
import { validateRecord, LEVELS } from "@plur1bus/log-schema";
import { createWriter } from "../../src/logs/writer.ts";
import { LevelPolicy } from "../../src/logs/levels.ts";
import { parseTraceparent, newTrace, withTrace, fromRpcMeta } from "../../src/logs/trace.ts";
import { OutputLines, signalLevel } from "../../src/logs/output.ts";
import { createLogsMethods } from "../../src/logs/methods.ts";
import { logsDir } from "./helpers.ts";
const source = { kind: "harness" as const, id: "core", version: null };
const clock = () => { let t = Date.UTC(2026, 9, 7); return { now: () => t, advance: (ms: number) => { t += ms; } }; };
const records = (dir: string, file = "core.log") => readFileSync(path.join(dir, file), "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s));
it("schema, catalogue, key order, private file, buffered shutdown and query/tail integration", async () => {
  const dir = logsDir(); const w = createWriter({ dir, role: "core", source, timers: false });
  await Promise.all(Array.from({ length: 100 }, async (_, pid) => w.write("core.process.started", { pid })));
  w.close(); const rs = records(dir); assert.equal(rs.length, 100);
  for (const r of rs) assert.equal(validateRecord(r).ok, true, JSON.stringify(validateRecord(r)));
  const h = createLogsMethods({ dir }); const ctx = { requestId: "r", connectionId: "c", signal: new AbortController().signal };
  assert.equal(((await h["logs.query"]!({}, ctx)) as any).records.length, 100);
  assert.equal(((await h["logs.tail"]!({}, ctx)) as any).records.length, 100);
  assert.throws(() => w.write("core.process.ready", { pid: 1 }), /closed/);
});
it("unknown events throw in strict mode; release fallback and redaction failure stay schema-valid", () => {
  const dir = logsDir(); const w = createWriter({ dir, role: "core", source, timers: false, strict: true });
  assert.throws(() => w.write("made.up", {}), /unregistered/); w.close();
  const r = createWriter({ dir, role: "core", source, timers: false }); r.write("made.up", {});
  const circular: any = {}; circular.self = circular; r.write("core.process.started", circular); r.close();
  assert.deepEqual(records(dir).map(r => r.event), ["log.unregistered", "log.redaction.failed"]);
  for (const row of records(dir)) assert.equal(validateRecord(row).ok, true);
});
it("live precedence, trace admission and one expiry without config mutation", () => {
  const c = clock(); const expired: string[] = []; const p = new LevelPolicy({ now: c.now, expired: k => expired.push(k) });
  p.update({ defaultLevel: "warn", levels: { extension: "error", "extension:mcp-server": "debug", "extension:mcp-server/a": "info" } });
  assert.equal(p.resolve({ kind: "extension", id: "mcp-server/a", version: null }), "info");
  assert.equal(p.resolve({ kind: "extension", id: "mcp-server/b", version: null }), "debug");
  assert.equal(p.resolve({ kind: "extension", id: "mcp-serverx", version: null }), "error");
  assert.throws(() => p.update({ defaultLevel: "trace" }));
  assert.throws(() => p.update({ defaultLevel: "trace", traceUntil: c.now() + 86400001 }));
  p.update({ defaultLevel: "trace", traceUntil: c.now() + 1000 }); c.advance(1001);
  assert.equal(p.resolve(source), "debug"); p.resolve(source); assert.deepEqual(expired, ["harness:core"]);
  p.update({ defaultLevel: "info" }); assert.equal(p.resolve(source), "info");
  assert.deepEqual(LEVELS.map(l => l.otel.severityNumber), [1, 5, 9, 13, 17, 21]);
});
it("redaction before byte truncation, secret encodings and SHA preservation", () => {
  const dir = logsDir(); const w = createWriter({ dir, role: "core", source, timers: false, redactPii: true });
  const canary = "fixture canary secret"; w.registerSecret(canary);
  const values = [canary, Buffer.from(canary).toString("base64"), encodeURIComponent(canary), "ek_" + "Q".repeat(20), "sk-proj-" + "Q".repeat(24), "ghp_" + "Q".repeat(36), "github_pat_" + "Q".repeat(24), "xoxb-" + "Q".repeat(15), "AKIA" + "Q".repeat(16), "AIza" + "Q".repeat(35), "eyJabc.eyJabc.abcdef", "PLUR1BUS_TEST=fixture-env", "-----BEGIN " + "PRIVATE KEY-----fixture-pem-----END " + "PRIVATE KEY-----", "Bearer fixture-bearer", "Basic Zml4dHVyZTpwYXNz", "Authorization: fixture-header", "password=fixture-pass", "https://fixture:pass@example.test/?code=fixture-code#fixture-fragment", "/fixture/.ssh/id_ed25519", "/fixture/Library/Application Support/Google/Chrome/Default/Cookies", "/fixture/Library/Group Containers/2BUA8C4S2C.com.1password/data", "person@example.test"];
  for (const text of values) w.write("process.output.line", { text, untrusted: true }, { stream: "stdout" });
  w.write("process.output.line", { text: "a".repeat(64), untrusted: true }, { stream: "stdout" });
  w.write("process.output.line", { text: "😀".repeat(5000) + canary, untrusted: true }, { stream: "stdout" }); w.close();
  const text = readFileSync(path.join(dir, "core.log"), "utf8");
  for (const secret of [canary, ...values.slice(1, 10), "fixture-header", "fixture-pass", "fixture-code", "fixture-fragment", "fixture-pem", "fixture-env", "Application Support/Google/Chrome", "Group Containers/2BUA8C4S2C.com.1password", "person@example.test"]) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes("a".repeat(64)));
  for (const r of records(dir)) { assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 4096); assert.equal(validateRecord(r).ok, true, JSON.stringify(validateRecord(r))); }
});
it("340 repeats collapse to first plus summary; source rate limit counts dropped lines", () => {
  const dir = logsDir(); const c = clock(); const w = createWriter({ dir, role: "core", source, now: c.now, timers: false });
  for (let i = 0; i < 340; i++) w.write("core.process.started", { pid: 1 });
  c.advance(60000); w.tick(); w.flush();
  assert.deepEqual(records(dir).map(r => r.attrs.repeat), [undefined, 340]);
  for (let i = 0; i < 1000; i++) w.write("core.process.started", { pid: i + 2 });
  c.advance(1000); w.tick(); w.close();
  assert.equal(records(dir).find(r => r.event === "log.suppressed").attrs.dropped, 500);
});
it("rotation by size/day and age pruning preserve current and audit files", () => {
  const dir = logsDir(); const c = clock();
  for (const name of ["core.log.4", "core.log", "audit.log.1"]) { writeFileSync(path.join(dir, name), ""); utimesSync(path.join(dir, name), new Date(0), new Date(0)); }
  const w = createWriter({ dir, role: "core", source, now: c.now, timers: false, maxBytes: 800, keep: 20 });
  assert.ok(!existsSync(path.join(dir, "core.log.4"))); assert.ok(existsSync(path.join(dir, "audit.log.1")));
  w.write("core.process.started", { pid: 1 }); w.flush(); c.advance(86400000); w.write("core.process.ready", { pid: 1 }); w.close();
  assert.ok(existsSync(path.join(dir, "core.log.1"))); assert.equal(records(dir).at(-1).event, "core.process.ready");
});
it("ALS isolation and authenticated RPC trace adoption", async () => {
  const a = newTrace(); const b = newTrace(); assert.equal(parseTraceparent(a.traceparent)?.trace_id, a.trace_id);
  assert.equal(parseTraceparent("00-" + "0".repeat(32) + "-" + "1".repeat(16) + "-01"), null);
  assert.notEqual(fromRpcMeta({ traceparent: a.traceparent }, false).trace_id, a.trace_id);
  assert.equal(fromRpcMeta({ traceparent: a.traceparent }, true).trace_id, a.trace_id);
  const dir = logsDir(); const w = createWriter({ dir, role: "core", source, timers: false });
  await Promise.all([a, b].map(t => withTrace(t, async () => { await Promise.resolve(); w.write("core.process.started", { pid: t === a ? 1 : 2 }); }))); w.close();
  assert.deepEqual(new Set(records(dir).map(r => r.trace_id)), new Set([a.trace_id, b.trace_id]));
});
it("foreign chunks, forged levels, ANSI/OSC, oversized secret and flood are safely wrapped", () => {
  const dir = logsDir(); const c = clock(); const w = createWriter({ dir, role: "core.out", source, now: c.now, timers: false });
  w.registerSecret("fixture-split-canary"); const lines = new OutputLines(w, "stderr", { now: c.now });
  lines.push(Buffer.from('ERROR: {"level":"fatal"}\n\x1b]0;bad\x07\x1b[31mred\x1b[0m\n'));
  lines.push(Buffer.from("x".repeat(8188) + "fixture-spl")); lines.push(Buffer.from("it-canary" + "x".repeat(1024 * 1024) + "\n"));
  for (let i = 0; i < 10000; i++) lines.push(Buffer.from(`line ${i}\n`));
  c.advance(1000); lines.tick(); lines.close(); w.close();
  const rs = records(dir, "core.out.log"); assert.ok(rs.every(r => r.level !== "fatal"));
  assert.ok(rs.filter(r => r.event === "process.output.line").every(r => r.level === "info" && r.attrs.untrusted));
  assert.equal(rs.filter(r => r.event === "process.output.suppressed").length, 1);
  assert.ok(!JSON.stringify(rs).includes("fixture-split-canary")); assert.ok(!JSON.stringify(rs).includes("\\u001b"));
  for (const r of rs) assert.equal(validateRecord(r).ok, true, JSON.stringify(validateRecord(r)));
  assert.deepEqual([signalLevel({ exitCode: 0 }), signalLevel({ exitCode: 1 }), signalLevel({ signal: "SIGTERM" }), signalLevel({ httpStatus: 429, retrying: true }), signalLevel({ httpStatus: 500 }), signalLevel({ protocolError: true })], ["info", "error", "error", "warn", "error", "error"]);
});
it("fatal records are never deduplicated, expiry emits once and live changes need no restart", () => {
  const c = clock(); const dir = logsDir(); const w = createWriter({ dir, role: "core", source, now: c.now, timers: false });
  w.updateLevels({ defaultLevel: "trace", traceUntil: c.now() + 100 });
  c.advance(101); w.tick(); w.tick();
  for (let i = 0; i < 5; i++) w.write("supervisor.child.exited", { role: "core", planned: false }, { level: "fatal" });
  w.updateLevels({ defaultLevel: "error" }); w.write("core.process.started", { pid: 1 });
  w.updateLevels({ defaultLevel: "info" }); w.write("core.process.started", { pid: 2 }); w.close();
  const rs = records(dir); assert.equal(rs.filter(r => r.event === "log.level.expired").length, 1);
  assert.equal(rs.filter(r => r.level === "fatal").length, 5); assert.ok(!rs.some(r => r.attrs.pid === 1)); assert.ok(rs.some(r => r.attrs.pid === 2));
});
it("idle writer stays quiet; telemetry/network imports cannot enter writer code", () => {
  const dir = logsDir(); const c = clock(); const w = createWriter({ dir, role: "core", source, now: c.now, timers: false });
  w.write("core.process.started", { pid: 1 });
  for (let i = 0; i < 120; i++) { c.advance(1000); w.tick(); } w.close(); assert.equal(records(dir).length, 1);
  for (const name of ["writer", "sink", "trace", "levels", "output", "bootstrap", "redact"]) {
    const src = readFileSync(new URL(`../../src/logs/${name}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(|node:(?:http|https|net|tls|dgram)|https?:\/\//);
  }
});
it("retention runs daily, private mode and prefix symlinks cannot bypass the sink", async () => {
  const { statSync, symlinkSync } = await import("node:fs");
  const dir = logsDir(); const c = clock(); const w = createWriter({ dir, role: "core", source, now: c.now, timers: false });
  w.write("core.process.started", { pid: 1 }); w.flush();
  if (process.platform !== "win32") assert.equal(statSync(path.join(dir, "core.log")).mode & 0o777, 0o600);
  writeFileSync(path.join(dir, "core.log.9"), "old"); utimesSync(path.join(dir, "core.log.9"), new Date(0), new Date(0));
  c.advance(86400000); w.tick(); w.close(); assert.ok(!existsSync(path.join(dir, "core.log.9")));
  assert.ok(records(dir).some(r => r.event === "log.retention.pruned"));
  if (process.platform !== "win32") { const other = logsDir(); const target = path.join(other, "target"); writeFileSync(target, "keep"); symlinkSync(target, path.join(other, "core.log")); const bad = createWriter({ dir: other, role: "core", source, timers: false }); bad.write("core.process.started", { pid: 1 }); assert.throws(() => bad.flush(), /regular/); assert.equal(readFileSync(target, "utf8"), "keep"); }
});
it("wrapper assembles UTF-8 and secret chunks before redaction and flushes idle partial lines", () => {
  const dir = logsDir(); const c = clock(); const w = createWriter({ dir, role: "core.out", source, now: c.now, timers: false });
  w.registerSecret("fixture-boundary-secret"); const lines = new OutputLines(w, "stdout", { now: c.now });
  const buf = Buffer.from("prefix 😀 fixture-boundary-secret\n");
  for (const byte of buf) lines.push(Buffer.from([byte])); lines.push(Buffer.from("partial")); c.advance(1000); lines.tick(); lines.close(); w.close();
  const rs = records(dir, "core.out.log"); assert.ok(rs.some(r => r.attrs.text === "prefix 😀 [REDACTED:secret]")); assert.ok(rs.some(r => r.attrs.text === "partial"));
});
it("independent processes append complete lines under one role lock", async () => {
  const { spawn } = await import("node:child_process"); const { fileURLToPath } = await import("node:url"); const dir = logsDir();
  await Promise.all([0, 100, 200].map(base => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--conditions=source", fileURLToPath(new URL("./writer-worker.ts", import.meta.url)), dir, String(base)], { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; child.stderr.on("data", chunk => { err += String(chunk); }); child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(err)));
  })));
  const rs = records(dir); assert.equal(rs.length, 90); assert.equal(new Set(rs.map(r => r.attrs.pid)).size, 90);
  for (const row of rs) assert.equal(validateRecord(row).ok, true);
});
it("live level updates report changes and truncate large required arrays", () => {
  const dir = logsDir(); const w = createWriter({ dir, role: "core", source, timers: false });
  w.updateLevels({ defaultLevel: "debug", levels: { "provider:fake": "debug" } });
  w.updateLevels({ defaultLevel: "debug", levels: { "provider:fake": "debug" } });
  w.write("core.config.applied", { keys: Array.from({ length: 10000 }, (_, i) => `key${i}`) }); w.close();
  const rs = records(dir); assert.equal(rs.filter(r => r.event === "log.level.changed").length, 2);
  assert.ok(rs.at(-1).attrs.truncated); assert.ok(Buffer.byteLength(JSON.stringify(rs.at(-1))) <= 4096);
});
it("writer redacts whole Authorization/Cookie headers before shortening text", () => {
  const dir = logsDir(); const w = createWriter({ dir, role: "core", source, timers: false });
  for (const text of ["Authorization: Bearer fixture-short-auth", "Cookie: session=fixture-cookie-one; other=fixture-cookie-two", "request authorization=Bearer fixture-inline-auth", "request authorization=bearer fixture-lower-auth", "header Cookie: sid=fixture-inline-cookie-one; other=fixture-inline-cookie-two"]) w.write("process.output.line", { text, untrusted: true }, { stream: "stderr" });
  w.close(); const written = readFileSync(path.join(dir, "core.log"), "utf8");
  for (const s of ["fixture-short-auth", "fixture-cookie-one", "fixture-cookie-two", "fixture-inline-auth", "fixture-lower-auth", "fixture-inline-cookie-one", "fixture-inline-cookie-two"]) assert.ok(!written.includes(s));
});
