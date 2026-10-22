// D13 gap: `harness_logs_tail` must not hand raw container output to the page. The native side redacts with the
// shared formatter (secret registry, credential paths, PII) before returning; the UI mask in models/redact.ts is the second layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(`../../src-tauri/src/${path}`, import.meta.url), "utf8");
/** The text of one function: from its signature to the closing brace at the same indentation. */
function body(text: string, signature: string): string {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const indent = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", start) + 1))![0];
  const end = text.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > start, `unterminated ${signature}`);
  return text.slice(start, end);
}

test("the harness_logs_tail command only returns what the controller redacted", async () => {
  const command = body(await source("runtime_commands.rs"), "pub async fn harness_logs_tail(");
  assert.match(command, /\.logs_tail\(200\)/);
  assert.doesNotMatch(command, /\.runtime\b|runtime\.logs_tail/, "the command must not read the container runtime itself");
});

test("Controller::logs_tail redacts the runtime output with the shared formatter before it returns", async () => {
  const tail = body(await source("controller/mod.rs"), "pub async fn logs_tail(");
  const raw = tail.indexOf("self.runtime.logs_tail(");
  const redact = tail.indexOf("redact_text(&raw)");
  assert.ok(raw >= 0 && redact > raw, "the runtime tail is redacted after it is read");
  assert.match(tail, /SecretRegistry::process\(\)/, "the process-wide secret registry is the one in use");
  assert.match(tail, /Formatter::new\([\s\S]*,\s*true,?\s*\)/, "PII redaction stays on");
  assert.doesNotMatch(tail, /Ok\(raw\)|return Ok\(\s*raw/, "the raw tail is never returned");
  assert.match(tail, /redact_text\(&raw\)\.map_err\(/, "a redaction failure is an error, not raw text");
});
