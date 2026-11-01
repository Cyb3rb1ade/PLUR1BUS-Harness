// Asynchronous module policy loading must finish before an accepted snapshot or listener becomes visible.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { defaults } from "@plur1bus/config-schema";
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
