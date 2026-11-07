/** B1's subject must perform real dispatched writes, retain normalized usage and refuse paths outside its task. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatResult, StreamingAdapter } from "../../../providers/src/index.ts";
import { realTempDir } from "../helpers/real-temp-dir.ts";
import { singleCodingArm } from "../../src/toolcall/coding-bench-subject.ts";

function adapterFor(path: string, usage = 100): StreamingAdapter {
  let calls = 0;
  return {
    async *stream() {
      const first = calls++ === 0;
      const result: ChatResult = {
        text: first ? "" : "Finished.",
        toolCalls: first
          ? [
              {
                id: "write",
                name: "file.write",
                argumentsRaw: "{}",
                arguments: { path, content: "measured write", overwrite: true },
              },
            ]
          : [],
        finishReason: first ? "tool_calls" : "stop",
        rawFinishReason: "stop",
        meta: {},
        usage: {
          inputTokens: first ? usage : 200,
          outputTokens: first ? 10 : 20,
          cachedInputTokens: first ? 40 : 100,
          cacheWriteTokens: first ? 10 : 20,
        },
      };
      yield { type: "done", result };
    },
  };
}

async function fixture(outside: boolean, inputUsage = 100, rounds = 5) {
  const home = await realTempDir("p1b-coding-subject-");
  try {
    const root = join(home, "task");
    const worktree = join(root, "worktree");
    await mkdir(worktree, { recursive: true, mode: 0o700 });
    const target = join(outside ? home : worktree, "solution.ts");
    await writeFile(target, "starter");
    const arm = singleCodingArm({
      model: {
        provider: "fixture",
        model: "gpt-4.1",
        baseUrl: "http://127.0.0.1:1",
        wireFormat: "chat_completions",
        local: true,
      },
      adapter: adapterFor(target, inputUsage),
      home,
      programs: [],
      secrets: () => [],
    });
    const result = await arm.run({
      root,
      worktree,
      instruction: `Repair ${join(worktree, "solution.ts")}`,
      taskId: "easy-ts-tags",
      seed: 11,
      budgets: { tokens: 10_000, rounds, wallMs: 10_000 },
      signal: new AbortController().signal,
    });
    return { result, content: await readFile(target, "utf8") };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("single uses actual dispatched file.write and counts each request's cache buckets exactly once", async () => {
  const { result, content } = await fixture(false);
  assert.equal(content, "measured write");
  assert.equal(result.outcome, "completed");
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.metrics.toolErrors, 0);
  assert.equal(result.metrics.totalInput, 300);
  assert.equal(result.metrics.input, 130);
  assert.equal(result.metrics.output, 30);
  assert.equal(result.metrics.cacheRead, 140);
  assert.equal(result.metrics.cacheCreated, 30);
  assert.equal(result.metrics.cacheShare, 140 / 300);
  assert.equal(result.metrics.offloads, null);
});

test("the real dispatcher refuses a write outside the task grant", async () => {
  const { result, content } = await fixture(true);
  assert.equal(content, "starter");
  assert.ok(result.metrics.toolErrors > 0);
});

test("actual settled usage stops the subject when it exceeds the task's token budget", async () => {
  const { result, content } = await fixture(false, 11_000);
  assert.equal(result.outcome, "budget");
  assert.equal(content, "starter");
});

test("exhausting rounds is a measured budget outcome rather than a provider infrastructure error", async () => {
  const { result } = await fixture(false, 100, 1);
  assert.equal(result.outcome, "budget");
  assert.equal(result.metrics.rounds, 1);
  assert.equal(result.metrics.totalInput, 100);
});
