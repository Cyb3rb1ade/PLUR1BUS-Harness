/** Owned fixture commands must reap their process group on normal exit, cancellation and output overflow. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCodingCommand, codingEnvironment } from "../../src/toolcall/coding-bench-process.ts";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

test("fixture environments never inherit provider credentials or loader injection", () => {
  const value = randomBytes(24).toString("hex");
  const env = codingEnvironment({
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/private-eval",
    CI: "1",
    ANTHROPIC_API_KEY: value,
    NODE_OPTIONS: value,
    LD_PRELOAD: value,
  });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "PATH"]);
  assert.ok(!JSON.stringify(env).includes(value));
});

test("characterization: a leader exit kills descendants retaining its output pipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-command-descendant-"));
  const marker = join(root, "survived");
  const descendant =
    "process.send('ready'); setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'bad'), 1000)";
  const leader =
    "const {spawn}=require('node:child_process');" +
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(marker)}],` +
    "{stdio:['ignore',1,2,'ipc']});child.once('message',()=>process.exit(0));";
  try {
    const result = await runCodingCommand(process.execPath, ["-e", leader], {
      root,
      env: {},
      timeoutMs: 2500,
      signal: new AbortController().signal,
    });
    if (process.platform === "win32") assert.equal(result.reason, "platform-unavailable");
    else {
      assert.equal(result.code, 0);
      assert.equal(result.reason, undefined);
      await assert.rejects(access(marker));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned commands capture separate streams and return only after reaping", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-command-test-"));
  try {
    const result = await runCodingCommand(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      { root, env: { PATH: process.env.PATH }, timeoutMs: 2000, signal: new AbortController().signal },
    );
    if (process.platform === "win32") {
      assert.equal(result.reason, "platform-unavailable");
      return;
    }
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(result.reason, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an abort and an output flood end the owned command instead of leaving it alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "p1b-command-stop-"));
  try {
    const abort = new AbortController();
    const pending = runCodingCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      root,
      env: {},
      timeoutMs: 2000,
      signal: abort.signal,
    });
    abort.abort();
    assert.equal((await pending).reason, process.platform === "win32" ? "platform-unavailable" : "aborted");
    const flood = await runCodingCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"],
      { root, env: {}, timeoutMs: 2000, maxOutputBytes: 1024, signal: new AbortController().signal },
    );
    assert.equal(flood.reason, process.platform === "win32" ? "platform-unavailable" : "output-limit");
    assert.ok(flood.stdout.length <= 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
