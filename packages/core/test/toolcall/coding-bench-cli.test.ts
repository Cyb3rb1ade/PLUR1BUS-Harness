/** CLI refusals must precede provider construction and never echo an inherited runtime credential. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

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
