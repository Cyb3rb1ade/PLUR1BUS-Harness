import { it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
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
