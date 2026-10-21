import { it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdioSpawnEnv } from "../../src/mcp/env.ts";
import { BoundedStdioTransport } from "../../src/mcp/stdio.ts";
import { stdioDef, waitDead } from "./helpers/util.ts";

it("stdio frames fragmented UTF-8 and CRLF; stderr is separate", async () => {
  const input = new PassThrough(); const output = new PassThrough(); const stderr = new PassThrough();
  const t = new BoundedStdioTransport({ input, output, stderr }, 256, 50);
  const messages: unknown[] = []; t.onmessage = m => messages.push(m);
  await t.start();
  const wire = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notice", params: { text: "€" } }) + "\r\n");
  for (const byte of wire) output.write(Buffer.from([byte]));
  stderr.write("not JSON\n");
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { params: { text: string } }).params.text, "€");
  await t.close();
});
it("stdio refuses oversized partial frames and malformed JSON without hanging", async () => {
  for (const wire of ["x".repeat(257), "{invalid}\n"]) {
    const input = new PassThrough(); const output = new PassThrough();
    const t = new BoundedStdioTransport({ input, output }, 256, 50);
    const errors: string[] = []; let closed = false;
    t.onerror = e => errors.push(e.message); t.onclose = () => { closed = true; };
    await t.start(); output.write(wire);
    await t.close();
    assert.ok(errors.length); assert.ok(closed);
    assert.ok(!errors.join().includes(wire));
  }
});
it("stdio sends one newline-delimited frame and bounds outgoing messages", async () => {
  const input = new PassThrough(); const output = new PassThrough(); let sent = "";
  input.on("data", b => { sent += String(b); });
  const t = new BoundedStdioTransport({ input, output }, 256, 50); await t.start();
  await t.send({ jsonrpc: "2.0", method: "ping" });
  assert.equal(sent, '{"jsonrpc":"2.0","method":"ping"}\n');
  await assert.rejects(t.send({ jsonrpc: "2.0", method: "x".repeat(300) }), /limit/);
  await t.close();
});
it("stdio inherits only safe allowlisted variables and honors cwd", async () => {
  const def = stdioDef({ transport: { type: "stdio", command: process.execPath,
    args: ["-e", 'process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"env",params:{secret:process.env.AMBIENT_TOKEN,cwd:process.cwd(),allowed:process.env.EXPLICIT}})+"\\n");process.stdin.resume()'],
    cwd: process.cwd(), env: { EXPLICIT: "synthetic" }, fromHost: [] } });
  assert.equal(def.transport.type, "stdio"); if (def.transport.type !== "stdio") return;
  const t = new BoundedStdioTransport(def.transport, 1024, 50, { AMBIENT_TOKEN: "fake-token" });
  const got = new Promise<Record<string, unknown>>(r => { t.onmessage = m => r((m as { params: Record<string, unknown> }).params); });
  await t.start(); const pid = t.pid!;
  try { assert.deepEqual(await got, { cwd: process.cwd(), allowed: "synthetic" }); }
  finally { await t.close(); }
  assert.ok(await waitDead(pid));
});

it("stdio shutdown reaps descendants even when the parent exits on EOF (all OS)", { timeout: 15000 }, async () => {
  const script = 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"child",params:{pid:c.pid}})+"\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));';
  const def = stdioDef({ transport: { type: "stdio", command: process.execPath, args: ["-e", script] } });
  if (def.transport.type !== "stdio") return;
  const t = new BoundedStdioTransport(def.transport, 2048, 100, process.env);
  const child = new Promise<number>(resolve => { t.onmessage = m => resolve((m as unknown as { params: { pid: number } }).params.pid); });
  await t.start(); const pid = await child;
  await t.close(); assert.ok(await waitDead(pid), "descendant survived its parent's graceful exit");
});

it("stdio rejects invalid UTF-8 instead of changing protocol bytes", async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const t = new BoundedStdioTransport({ input, output }, 256, 50); let messages = 0; let errors = 0;
  t.onmessage = () => { messages++; }; t.onerror = () => { errors++; };
  await t.start();
  output.write(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","method":"notice","params":{"text":"'), Buffer.from([0xff]), Buffer.from('"}}\n')]));
  await t.close(); assert.equal(messages, 0); assert.equal(errors, 1);
});

it("stdio assembles a frame delivered in many tiny chunks without quadratic copying", async () => {
  const { PassThrough } = await import("node:stream");
  const { mock } = await import("node:test");
  const { BoundedStdioTransport } = await import("../../src/mcp/stdio.ts");
  const a = new PassThrough(); const b = new PassThrough();
  const t = new BoundedStdioTransport({ input: a, output: b });
  const got: unknown[] = [];
  t.onmessage = (m) => got.push(m);
  await t.start();
  const spy = mock.method(Buffer, "concat");
  try {
    const text = "x".repeat(200_000);
    const wire = Buffer.from(`{"jsonrpc":"2.0","method":"n","params":{"t":"${text}"}}\n`);
    for (let i = 0; i < wire.length; i += 16) { b.write(wire.subarray(i, i + 16)); await new Promise((r) => setImmediate(r)); }
    for (let i = 0; i < 100 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(got.length, 1);
    let copied = 0;
    for (const call of spy.mock.calls) for (const part of call.arguments[0] as Buffer[]) copied += part.length;
    assert.ok(copied < wire.length * 4, `copied ${copied} bytes to assemble ${wire.length}`);
  } finally { spy.mock.restore(); await t.close(); }
});

// Audit mcp #2: a server definition must not steer which program the allowlisted command name resolves to.

it("stdio child env: the harness PATH and PATHEXT win over whatever the definition declares, in any letter case", () => {
  const t = { type: "stdio" as const, command: "node", args: [], fromHost: [], env: { PATH: "/evil", Path: "/evil", pathext: ".evil", PATHEXT: ".evil", KEEP: "1" } };
  const env = stdioSpawnEnv(t, { PATH: "/usr/bin", PATHEXT: ".EXE" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.KEEP, "1");
  for (const [k, v] of Object.entries(env)) if (/^path(ext)?$/i.test(k)) assert.ok(!v.includes("evil"), k);
  assert.deepEqual(Object.keys(env).filter(k => /^path$/i.test(k)), ["PATH"]);
});

it("stdio child env: a declared PATH is not applied even when the config validator was bypassed", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-path-"));
  const marker = join(dir, "hijacked");
  try {
    // A fake `node` planted in a directory the definition tries to put first on PATH.
    writeFileSync(join(dir, "node"), `#!/bin/sh\necho x > '${marker}'\nprintf '%s\\n' '{"jsonrpc":"2.0","method":"hijacked"}'\nexec cat\n`);
    chmodSync(join(dir, "node"), 0o755);
    const t = { type: "stdio" as const, command: "node", fromHost: [], env: { PATH: dir },
      args: ["-e", 'process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"genuine"})+"\\n");process.stdin.resume()'] };
    const tr = new BoundedStdioTransport(t, 1024, 50, { PATH: process.env.PATH ?? "" });
    const first = new Promise<string>(r => { tr.onmessage = m => r((m as unknown as { method: string }).method); });
    await tr.start();
    try { assert.equal(await first, "genuine"); assert.equal(existsSync(marker), false); }
    finally { await tr.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
