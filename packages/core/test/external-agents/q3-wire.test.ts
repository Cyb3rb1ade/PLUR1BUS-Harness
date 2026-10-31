/** Handwritten ACP v1 messages, independent of the integration stub's assumptions. */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AcpClient } from "../../src/external-agents/acp-client.ts";
import { MAX_LINE_BYTES } from "../../src/acp/framing.ts";
import { tick } from "../approvals/service-helpers.ts";

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.on("data", chunk => lines.push(String(chunk)));
  let writes = 0;
  const client = new AcpClient({ input, output, handlers: {
    readText: async () => "", writeText: async () => { writes++; },
    permission: async () => ({ outcome: { outcome: "cancelled" } }), terminal: async () => ({}), onUpdate() {},
  } });
  return { input, client, lines, writes: () => writes };
}

test("late write requests after an overlong line never dispatch", async () => {
  const f = setup();
  const pending = assert.rejects(f.client.initialize(), /line-too-long/);
  f.input.write("x".repeat(MAX_LINE_BYTES + 1) + "\n");
  f.input.write('{"jsonrpc":"2.0","id":"late","method":"fs/write_text_file","params":{"path":"x","content":"bad"}}\n');
  await pending;
  await tick();
  assert.equal(f.writes(), 0);
  assert.equal(f.lines.length, 1);
});

test("a prompt accepts more than 200 small updates within the byte budget", async () => {
  const f = setup();
  const prompt = f.client.prompt("s", "work");
  for (let i = 0; i < 250; i++) f.input.write('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}}\n');
  f.input.write('{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}\n');
  assert.deepEqual(await prompt, { stopReason: "end_turn" });
  f.client.close();
});

test("prompt requests survive the generic 15 second request deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = setup();
  const prompt = f.client.prompt("s", "work");
  t.mock.timers.tick(15_001);
  f.input.write('{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}\n');
  assert.deepEqual(await prompt, { stopReason: "end_turn" });
  f.client.close();
});

test("updates refresh idle timeout without extending the run deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const input = new PassThrough();
  const client = new AcpClient({ input, output: new PassThrough(), runTimeoutMs: 1000, idleTimeoutMs: 400,
    handlers: { readText: async () => "", writeText: async () => {}, permission: async () => ({}), terminal: async () => ({}), onUpdate() {} } });
  const pending = assert.rejects(client.prompt("s", "work"), /request-timeout/);
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(300);
    input.write('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}}\n');
  }
  t.mock.timers.tick(100);
  await pending;
  client.close();
});

test("a broken agent transport closes pending requests without an uncaught stream error", async () => {
  const f = setup();
  const pending = assert.rejects(f.client.initialize(), /transport-error/);
  f.input.destroy(new Error("private transport detail"));
  await pending;
});
