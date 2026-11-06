/** The Node ACP entry accepts the CLI-selected profile without leaking rejected argv or protocol payloads to stderr. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import type { CoreClient } from "@plur1bus/module-api";
import { runAcpMain } from "../../src/acp/main.ts";

const args = ["--home", "/unused", "--agent", "worker", "--account", "host", "--user", "owner"];

function streams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", chunk => {
    out += chunk;
  });
  stderr.on("data", chunk => {
    err += chunk;
  });
  return { stdin, stdout, stderr, out: () => out, err: () => err };
}

test("--profile coding reaches the actual Core backend before the editor receives its session", async () => {
  const io = streams();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    hello: { capabilities: { methods: { "code.session.open": {}, "code.session.mode": {} } } },
    close: async () => {},
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "session.create") return { session: { id: "s" } };
      if (method === "code.session.open") return { state: "open", root: "/canonical/work" };
      if (method === "code.session.mode") return { mode: params.mode, changed: false };
      throw new Error("unexpected call");
    },
  } as unknown as CoreClient;
  const done = runAcpMain([...args, "--profile", "coding"], io as never, async () => client);
  io.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1,
    method: "initialize", params: { protocolVersion: 1 } })}\n`);
  io.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2,
    method: "session/new", params: { cwd: "/editor/work" } })}\n`);
  io.stdin.end();
  assert.equal(await done, 0);
  assert.deepEqual(calls.at(-1), { method: "code.session.mode", params: {
    caller: { channel: "cli", accountId: "host", userId: "owner" }, sessionId: "s", mode: "coding",
  } });
  const response = io.out().trim().split("\n").map(line => JSON.parse(line)).find(message => message.id === 2);
  assert.equal(response.result.modes.currentModeId, "coding");
  assert.doesNotMatch(io.err(), /editor\/work|canonical\/work/);
});

test("an invalid profile is rejected before connection and its value is absent from diagnostics", async () => {
  const io = streams();
  let connected = false;
  const result = await runAcpMain([...args, "--profile", "private-profile-token"], io as never, async () => {
    connected = true;
    throw new Error("must not connect");
  });
  assert.equal(result, 2);
  assert.equal(connected, false);
  assert.equal(io.out(), "");
  assert.match(io.err(), /--profile must be chat or coding/);
  assert.doesNotMatch(io.err(), /private-profile-token/);
});
