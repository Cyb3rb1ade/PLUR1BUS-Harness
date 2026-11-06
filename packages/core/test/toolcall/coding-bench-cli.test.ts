/** CLI refusals must precede provider construction and never echo an inherited runtime credential. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { realTempDir } from "../helpers/real-temp-dir.ts";

const script = fileURLToPath(new URL("../../../../scripts/eval/coding-bench.ts", import.meta.url));
async function invoke(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", script, ...args],
      { env, timeout: 10_000, maxBuffer: 16_384 },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          output: String(stdout) + String(stderr),
        }),
    );
  });
}

test("a failed capture log can be scanned without a report while secret-bearing logs still refuse", async () => {
  const root = await realTempDir("p1b-coding-scan-");
  const key = randomBytes(32).toString("base64url");
  const env = {
    PLUR1BUS_CODING_BENCH_HOME: join(root, "eval"),
    PLUR1BUS_TURN_EVAL_MODELS: JSON.stringify([{
      provider: "anthropic", model: "fixture", baseUrl: "https://api.anthropic.com/v1", wireFormat: "anthropic_messages",
    }]),
  };
  const log = join(root, "run.log");
  try {
    assert.equal((await invoke(["--setup"], { ...env, ANTHROPIC_API_KEY: key })).code, 0);
    await writeFile(log, '{"status":"failed","phase":"smoke-runtimes"}\n');
    assert.equal((await invoke(["--scan", "--log", log], env)).code, 0);
    await writeFile(log, key);
    const refused = await invoke(["--scan", "--log", log], env);
    assert.equal(refused.code, 1);
    assert.equal(refused.output.includes(key), false);
    assert.equal((await invoke(["--scan"], env)).code, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown, duplicate, mixed or valueless arguments refuse before starting a fixture or model", async () => {
  for (const args of [
    ["--fixture", "--live"],
    ["--fixture", "--out"],
    ["--fixture", "--unknown"],
    ["--fixture", "--fixture"],
    ["--setup", "--candidate", "unused"],
  ]) {
    const result = await invoke(args);
    assert.equal(result.code, 1);
    assert.match(result.output, /"status":"failed"/u);
  }
});

test("live refuses vendor credential variables without printing their raw or encoded runtime values", async () => {
  const value = randomBytes(32).toString("base64url");
  const result = await invoke(["--live", "--out", "unused"], { ANTHROPIC_API_KEY: value });
  assert.equal(result.code, 1);
  assert.match(result.output, /"phase":"configuration"/u);
  for (const form of [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex")]) {
    assert.equal(result.output.includes(form), false, "public failure output must not contain a credential form");
  }
});

test("live requires its output option before any setup, preflight or model configuration", async () => {
  const result = await invoke(["--live"]);
  assert.equal(result.code, 1);
  assert.match(result.output, /"phase":"arguments"/u);
});


test("smoke refuses credentials before setup and requires a separate output", async () => {
  const value = randomBytes(32).toString("base64url");
  const result = await invoke(["--smoke", "--out", "unused"], { ANTHROPIC_API_KEY: value });
  assert.equal(result.code, 1);
  assert.match(result.output, /"phase":"configuration"/u);
  assert.equal(result.output.includes(value), false);
  const missing = await invoke(["--smoke"]);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /"phase":"arguments"/u);
});
