// Asynchronous module policy loading must finish before an accepted snapshot or listener becomes visible.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { defaults } from "@plur1bus/config-schema";
import { randomUUID } from "node:crypto";
import { openConfigSource } from "../src/config-source.ts";
import { layout } from "../src/paths.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const until = async (done: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!done()) {
    assert.ok(Date.now() < deadline, "configuration preparation timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("a pending privacy preparation retains the accepted snapshot and coalesces later candidates", async () => {
  const l = layout(tempDir("p1b-policy-source-"));
  const config = defaults();
  writeFileSync(l.configPath, JSON.stringify(config));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const prepared: string[] = [];
  const source = await openConfigSource({ layout: l, supervised: false, prepareChange: (_previous, next) => {
    prepared.push(next.core.logLevel);
    return next.core.logLevel === "debug" ? pending : undefined;
  } });
  const heard: string[] = [];
  source.onChange((_previous, next) => heard.push(next.core.logLevel));
  try {
    config.core.logLevel = "debug";
    writeFileSync(l.configPath, JSON.stringify(config));
    assert.equal(source.current().core.logLevel, "info");
    assert.deepEqual(heard, []);
    for (const level of ["warn", "error"] as const) {
      config.core.logLevel = level;
      writeFileSync(l.configPath, JSON.stringify(config));
      assert.equal(source.current().core.logLevel, "info");
    }
    release();
    await until(() => source.current().core.logLevel === "error");
    assert.deepEqual(prepared, ["debug", "error"]);
    assert.deepEqual(heard, ["debug", "error"]);
  } finally { release(); await source.close(); }
});

test("an unavailable privacy policy keeps current values and reports a value-free failure", async () => {
  const l = layout(tempDir("p1b-policy-source-"));
  const config = defaults();
  writeFileSync(l.configPath, JSON.stringify(config));
  const messages: string[] = [];
  const source = await openConfigSource({ layout: l, supervised: false,
    logger: { debug() {}, info() {}, error() {}, warn(message) { messages.push(message); } },
    prepareChange: async () => { throw new Error("metadata unavailable"); },
  });
  try {
    config.core.logLevel = "debug";
    writeFileSync(l.configPath, JSON.stringify(config));
    source.current();
    await until(() => messages.length > 0);
    assert.equal(source.current().core.logLevel, "info");
    assert.ok(messages.some((message) => message.includes("sensitivity metadata")));
  } finally { await source.close(); }
});

test("actual config-source startup and reload log bounded value-free URL and invalid-reference warnings", async () => {
  const l = layout(tempDir("p1b-policy-warnings-"));
  const config = defaults();
  const credential = randomUUID();
  const invalidReference = `invalid reference ${randomUUID()}`;
  config.voice.providers.elevenlabs.baseUrl = `https://operator:${credential}@relay.example.test/public`;
  config.engine.merging = { apiKeyRef: invalidReference };
  writeFileSync(l.configPath, JSON.stringify(config));
  const records: { message: string; fields: Record<string, unknown> | undefined }[] = [];
  const source = await openConfigSource({ layout: l, supervised: false,
    logger: { debug() {}, info() {}, error() {}, warn(message, fields) { records.push({ message, fields }); } },
  });
  try {
    const initial = records.filter(({ message }) => message === "configuration warning");
    assert.ok(initial.some(({ fields }) => fields?.key === "voice.providers.elevenlabs.baseUrl" &&
      String(fields.guidance).includes("userinfo")));
    assert.ok(initial.some(({ fields }) => fields?.key === "engine.merging.apiKeyRef" &&
      String(fields.guidance).includes("reference")));
    assert.ok(initial.length <= 50);
    config.core.logLevel = "debug";
    writeFileSync(l.configPath, JSON.stringify(config));
    source.current();
    await until(() => records.filter(({ message }) => message === "configuration warning").length > initial.length);
    const output = JSON.stringify(records);
    assert.ok(!output.includes(credential));
    assert.ok(!output.includes(invalidReference));
    assert.ok(!output.includes("https://operator:"));
  } finally { await source.close(); }
});

test("actual runtime warnings cap the batch and key size for opaque provider maps", async () => {
  const l = layout(tempDir("p1b-policy-warning-bounds-"));
  const config = defaults();
  const credential = `invalid reference ${randomUUID()}`;
  config.providers = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
    `provider${index}${"a".repeat(300)}`, { apiKeyRef: credential },
  ]));
  writeFileSync(l.configPath, JSON.stringify(config));
  const records: { message: string; fields: Record<string, unknown> | undefined }[] = [];
  const source = await openConfigSource({ layout: l, supervised: false,
    logger: { debug() {}, info() {}, error() {}, warn(message, fields) { records.push({ message, fields }); } },
  });
  try {
    const warnings = records.filter(({ message }) => message === "configuration warning");
    assert.equal(warnings.length, 50);
    assert.ok(warnings.every(({ fields }) => String(fields?.key).length <= 256));
    assert.ok(warnings.every(({ fields }) => String(fields?.guidance).length <= 512));
    assert.ok(!JSON.stringify(records).includes(credential));
  } finally { await source.close(); }
});
