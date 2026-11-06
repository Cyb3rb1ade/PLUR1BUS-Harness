/** Actual backend -> ACP stream integration for exact new files and honest unified-patch fallback. */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PassThrough } from "node:stream";
import { CoreSessionBackend, type RpcCaller } from "../../src/acp/backend.ts";
import { AcpServer } from "../../src/acp/server.ts";
import type { AcpFileContent } from "../../src/acp/file-changes.ts";
import { MAX_LINE_BYTES } from "../../src/acp/framing.ts";

interface FileUpdate { sessionUpdate: string; content: AcpFileContent[]; rawInput?: unknown; _meta?: object }
interface Message { id?: number; result?: { stopReason?: string }; params?: { update?: FileUpdate } }

async function run(t: TestContext, options: { created: boolean; truncated?: boolean; large?: boolean }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Message[] = [];
  const lineBytes: number[] = [];
  const content = options.large ? "x".repeat(MAX_LINE_BYTES) : "new\n";
  let buffered = "";
  let reply: (() => void) | undefined;
  output.on("data", (chunk: Buffer) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(buffered.slice(0, newline)) as Message;
      lineBytes.push(Buffer.byteLength(buffered.slice(0, newline)) + 1);
      buffered = buffered.slice(newline + 1);
      messages.push(message);
      reply?.();
    }
  });
  const client: RpcCaller = {
    hello: { capabilities: { methods: Object.fromEntries(
      ["code.session.open", "code.session.mode"].map(method => [method, {}])) } },
    call: (async (method: string) => {
      if (method === "session.create") return { session: { id: "s" } };
      if (method === "code.session.open") return { state: "open", root: "/canonical/work" };
      if (method === "code.session.mode") return { mode: "coding", changed: false };
      if (method === "session.submit") return { turnId: "t" };
      if (method === "session.events") return { running: false, events: [
        { seq: 1, turnId: "t", type: "tool.call", data: {
          id: "c", name: "file.write", args: { path: "file.ts", content },
        } },
        { seq: 2, turnId: "t", type: "tool.result", data: { id: "c", output: JSON.stringify({
          callId: "c", tool: "file.write", isError: false,
          value: { rootId: "coding-worktree", path: "file.ts", created: options.created,
            bytesWritten: Buffer.byteLength(content),
            diff: "@@ -1 +1 @@\n-old\n+new\n", ...(options.truncated ? { truncated: true } : {}) },
        }) } },
        { seq: 3, turnId: "t", type: "turn.completed", data: {} },
      ] };
      throw new Error("unexpected method");
    }) as RpcCaller["call"],
  };
  const backend = new CoreSessionBackend({ client, agentId: "worker", initialMode: "coding",
    caller: { channel: "cli", accountId: "host", userId: "owner" } });
  const server = new AcpServer({ backend, input, output });
  const done = server.run();
  t.after(async () => {
    input.end();
    await done;
  });
  const request = async (id: number, method: string, params: object) => {
    const result = new Promise<Message>(resolve => {
      reply = () => {
        const response = messages.find(message => message.id === id);
        if (response) resolve(response);
      };
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  };
  await request(1, "initialize", { protocolVersion: 1 });
  await request(2, "session/new", { cwd: "/editor/work" });
  const response = await request(3, "session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "edit" }] });
  assert.equal(response.result?.stopReason, "end_turn");
  const update = messages.find(message => message.params?.update?.sessionUpdate === "tool_call_update")?.params?.update;
  assert.ok(update && Array.isArray(update.content));
  return { update, messages, lineBytes };
}

test("a proved full new file reaches the editor as standard ACP diff content", { timeout: 10_000 }, async t => {
  const { update } = await run(t, { created: true });
  assert.deepEqual(update.content, [{ type: "diff", path: "/canonical/work/file.ts",
    oldText: null, newText: "new\n" }]);
});

test("an existing file reaches the editor as an explicitly labelled text patch", { timeout: 10_000 }, async t => {
  const { update } = await run(t, { created: false });
  const part = update.content[0];
  assert.ok(part?.type === "content");
  assert.match(part.content.text, /Unified text patch/);
  assert.equal(JSON.stringify(update).includes('"oldText"'), false);
});

test("a truncated patch is labelled in the actual ACP stream", { timeout: 10_000 }, async t => {
  const { update } = await run(t, { created: false, truncated: true });
  const part = update.content[0];
  assert.ok(part?.type === "content");
  assert.match(part.content.text, /Unified text patch \(truncated/);
});

test("large file inputs stay under the ACP line cap and explicitly mark omitted raw input", { timeout: 10_000 }, async t => {
  const result = await run(t, { created: true, large: true });
  assert.ok(result.lineBytes.every(bytes => bytes <= MAX_LINE_BYTES), String(Math.max(...result.lineBytes)));
  const call = result.messages.find(message => message.params?.update?.sessionUpdate === "tool_call")?.params?.update;
  assert.ok(call);
  assert.equal("rawInput" in call, false);
  assert.match(JSON.stringify(call._meta), /size-limit/);
  const part = result.update.content[0];
  assert.ok(part?.type === "content");
  assert.match(part.content.text, /size limit/);
});
