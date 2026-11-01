/** ACP line client against real Core/router/D109/filesystem; only model and embeddings are deterministic fixtures. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { defaults } from "@plur1bus/config-schema";
import { silentLogger, type CoreClient } from "@plur1bus/module-api";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { LOCAL_OWNER } from "../../src/rbac/guard.ts";
import { CoreSessionBackend } from "../../src/acp/backend.ts";
import { AcpServer } from "../../src/acp/server.ts";
import type { AcpFileContent } from "../../src/acp/file-changes.ts";
import { connect } from "../helpers/connect.ts";
import { realTempDir } from "../helpers/real-temp-dir.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { scriptedAdapter } from "../composition/helpers.ts";

interface Message {
  id?: number | string;
  method?: string;
  params?: {
    options?: Array<{ optionId: string }>;
    update?: { sessionUpdate: string; content?: AcpFileContent[] };
  };
  result?: { sessionId?: string; stopReason?: string; modes?: { currentModeId: string } };
  error?: object;
}

test("real Core retains an active coding turn across a mode switch and produces an exact new-file diff", {
  timeout: 60_000,
}, async t => {
  const directory = await realTempDir("acp-real-coding-");
  const home = join(directory, "home");
  const root = join(directory, "repo");
  mkdirSync(home);
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  const config = defaults();
  config.agents.worker = {};
  config.engine = {
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
    reranker: { enabled: false }, duplicateThreshold: 1.01,
  };
  config.tools.sandbox.required = false;
  writeFileSync(layout(home).configPath, JSON.stringify(config));
  const content = "\ufeffexport const fresh = '🧩';\r\n";
  const wire = scriptedAdapter([
    { calls: [{ id: "create-fresh", name: "file.write", args: { path: "fresh.ts", content } }] },
    { text: "Created the file." },
    { text: "Continuing in chat mode." },
  ]);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let first = true;
  const core = createCore({
    home, logger: silentLogger(), testInternals: flatTestInternals(),
    discovery: { scheduler: false }, dreams: { scheduler: false },
    rbac: { resolve: () => LOCAL_OWNER },
    composition: {
      providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: {
        async *stream(request) {
          if (first) {
            first = false;
            entered();
            await gate;
          }
          yield* wire.adapter.stream(request);
        },
      } }] } },
      tools: { roots: [{ id: "fixture", path: root }] },
    },
  });
  let client: CoreClient | undefined;
  const input = new PassThrough();
  const output = new PassThrough();
  let served: Promise<void> | undefined;
  t.after(async () => {
    release();
    input.end();
    await served;
    await client?.close();
    await core.stop({ budgetMs: 5000 });
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await core.start();
  client = await connect({ address: core.address, token: core.token });
  const backend = new CoreSessionBackend({ client, initialMode: "coding", agentId: "worker",
    caller: { channel: "cli", accountId: "fixture", userId: "owner" } });
  const messages: Message[] = [];
  const pending = new Map<number, (message: Message) => void>();
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(buffered.slice(0, newline)) as Message;
      buffered = buffered.slice(newline + 1);
      messages.push(message);
      if (message.method === "session/request_permission") {
        assert.ok(message.params?.options?.some(option => option.optionId === "allow-once"));
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id,
          result: { outcome: { outcome: "selected", optionId: "allow-once" } } })}\n`);
      }
      if (typeof message.id === "number") {
        const finish = pending.get(message.id);
        pending.delete(message.id);
        finish?.(message);
      }
    }
  });
  const request = (id: number, method: string, params: object): Promise<Message> => new Promise(resolve => {
    pending.set(id, resolve);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  served = new AcpServer({ backend, input, output }).run();
  await request(1, "initialize", { protocolVersion: 1 });
  const session = (await request(2, "session/new", { cwd: root })).result;
  assert.ok(session?.sessionId);
  assert.equal(session.modes?.currentModeId, "coding");
  const stored = await client.call<{ session: { kind: string } }>("session.get", {
    caller: { channel: "cli", accountId: "fixture", userId: "owner" }, sessionId: session.sessionId,
  });
  assert.equal(stored.session.kind, "acp", "the current Core keeps the explicit ACP session kind");
  const prompt = request(3, "session/prompt", { sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Create the requested file." }] });
  await Promise.race([started, prompt.then(() => {
    throw new Error("the turn ended before entering the model fixture");
  })]);
  assert.deepEqual((await request(4, "session/set_mode", { sessionId: session.sessionId, modeId: "chat" })).result, {});
  release();
  assert.equal((await prompt).result?.stopReason, "end_turn");
  assert.equal(readFileSync(join(root, "fresh.ts"), "utf8"), content);
  const result = messages.find(message => message.params?.update?.sessionUpdate === "tool_call_update")?.params?.update;
  assert.ok(result);
  assert.deepEqual(result.content, [{ type: "diff", path: join(root, "fresh.ts"), oldText: null, newText: content }]);
  const operatingSection = "Coding mode. Work in the bound worktree";
  assert.ok(JSON.stringify(wire.requests[0]).includes(operatingSection));
  assert.ok(JSON.stringify(wire.requests[1]).includes(operatingSection), "continuation retains its admitted profile");
  assert.equal((await request(5, "session/prompt", { sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Continue the conversation." }] })).result?.stopReason, "end_turn");
  assert.equal(JSON.stringify(wire.requests.at(-1)).includes(operatingSection), false);
  const audit = readFileSync(join(home, "logs", "audit.log"), "utf8");
  assert.match(audit, /"action":"code.session.mode"/);
});
