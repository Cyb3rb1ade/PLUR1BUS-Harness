// Child logger context and Errors stay redacted even when credentials become known after child creation.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { HarnessLogger } from "@plur1bus/module-api";
import { withRedaction } from "../../src/logs/with-redaction.ts";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";

test("injected logger children consult the live registry and retain diagnostic Error fields", async () => {
  const registry = createSecretRedaction();
  const secret = randomUUID();
  const rows: { message: string; fields?: Record<string, unknown> }[] = [];
  const calls: unknown[] = [];
  const write = (message: string, fields?: Record<string, unknown>): void => {
    rows.push({ message, ...(fields ? { fields } : {}) });
  };
  const target: HarnessLogger = {
    debug: write, info: write, warn: write, error: write,
    child() { throw new Error("raw child context must never escape the wrapper"); },
    setLevel(level) { calls.push(level); },
    setRotation(options) { calls.push(options); },
    async close() { calls.push("closed"); },
  };
  const logger = withRedaction(target, registry.redactor());
  const child = logger.child({ ordinary: secret, public: 4096 });
  registry.register(secret);
  child.warn(`upstream ${secret}`, { err: new Error(`rejected ${secret}`) });
  assert.ok(!JSON.stringify(rows).includes(secret));
  assert.equal(rows[0]?.fields?.public, 4096);
  const error = rows[0]?.fields?.err as { name: string; message: string; stack: string };
  assert.equal(error.name, "Error");
  assert.ok(error.message.includes("rejected") && error.stack.includes("Error"));
  logger.setLevel("warn");
  logger.setRotation({ maxBytes: 4096, keep: 2 });
  await logger.close();
  assert.deepEqual(calls, ["warn", { maxBytes: 4096, keep: 2 }, "closed"]);
});
