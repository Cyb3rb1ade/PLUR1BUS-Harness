// The initial diagnostic record and later manual registrations share the startup redaction boundary.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createCoreLog } from "../../src/logs/bootstrap.ts";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("the default logger masks constructor records with its initial live redactor and keeps manual registrations", async () => {
  const dir = tempDir("p1b-startup-writer-");
  const registry = createSecretRedaction();
  const initial = randomUUID(), later = randomUUID(), manual = randomUUID();
  registry.replaceGroup(Symbol("startup"), [initial]);
  const log = createCoreLog({ dir, role: "core", timers: false, redactor: registry.redactor(),
    source: { kind: "harness", id: "core", version: initial } });
  registry.register(later, "later");
  log.registerSecret(manual, { pinned: true });
  log.warn(`${initial} ${later} ${manual}`, { ordinary: [initial, later, manual], public: "public log detail" });
  await log.close();
  const text = readdirSync(dir).filter(name => name.endsWith(".log"))
    .map(name => readFileSync(join(dir, name), "utf8")).join("\n");
  for (const value of [initial, later, manual]) assert.equal(text.includes(value), false);
  assert.ok(text.includes("core.process.started"));
  assert.ok(text.includes("public log detail"));
});
