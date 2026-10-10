import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createWriter } from "../../src/logs/writer.ts";
import { createSink } from "../../src/logs/sink.ts";
import { logsDir } from "./helpers.ts";

it("legacy info stays immediately readable without a disk sync per replay diagnostic; explicit flush syncs once", (t) => {
  const original = fs.fsyncSync;
  const sync = t.mock.method(fs, "fsyncSync", original);
  syncBuiltinESMExports();
  const dir = logsDir();
  const w = createWriter({ dir, role: "core", source: { kind: "harness", id: "core", version: null }, timers: false });
  try {
    for (let i = 0; i < 50; i++) w.writeLegacy("info", "journal: replayed", { id: String(i) });
    const rows = fs.readFileSync(path.join(dir, "core.log"), "utf8").trim().split("\n").map(s => JSON.parse(s));
    assert.deepEqual(rows.map(r => r.id), Array.from({ length: 50 }, (_, i) => String(i)));
    assert.equal(sync.mock.callCount(), 0, "hot-path diagnostics must not block replay on disk flushes");
    w.flush();
    assert.equal(sync.mock.callCount(), 1, "one sync for the dirty diagnostic file");
    w.flush();
    assert.equal(sync.mock.callCount(), 1, "an idle flush does not sync again");
    w.writeLegacy("warn", "capture refused");
    assert.equal(sync.mock.callCount(), 2, "warnings are durable before returning");
    w.writeLegacy("info", "last replay");
    w.close();
    assert.equal(sync.mock.callCount(), 3, "close syncs the remaining info records");
  } finally { w.close(); sync.mock.restore(); syncBuiltinESMExports(); }
});

it("rotation syncs the old diagnostic file before renaming it", (t) => {
  const sync = t.mock.method(fs, "fsyncSync", fs.fsyncSync);
  syncBuiltinESMExports();
  const dir = logsDir();
  const w = createWriter({ dir, role: "core", source: { kind: "harness", id: "core", version: null }, timers: false, maxBytes: 1 });
  try {
    w.writeLegacy("info", "first");
    assert.equal(sync.mock.callCount(), 0);
    w.writeLegacy("info", "second");
    assert.equal(sync.mock.callCount(), 1, "rotation flushes the previous file");
    assert.match(fs.readFileSync(path.join(dir, "core.log.1"), "utf8"), /first/);
    assert.match(fs.readFileSync(path.join(dir, "core.log"), "utf8"), /second/);
    w.close();
    assert.equal(sync.mock.callCount(), 2);
  } finally { w.close(); sync.mock.restore(); syncBuiltinESMExports(); }
});

it("the one-second timer syncs legacy records even with an empty writer queue", (t) => {
  const sync = t.mock.method(fs, "fsyncSync", fs.fsyncSync);
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const w = createWriter({ dir: logsDir(), role: "core", source: { kind: "harness", id: "core", version: null } });
  try {
    w.writeLegacy("info", "replay");
    t.mock.timers.tick(999);
    assert.equal(sync.mock.callCount(), 0);
    t.mock.timers.tick(1);
    assert.equal(sync.mock.callCount(), 1);
    t.mock.timers.tick(1000);
    assert.equal(sync.mock.callCount(), 1);
  } finally { w.close(); sync.mock.restore(); syncBuiltinESMExports(); }
});

it("a failed disk sync is retried without appending already visible records twice", (t) => {
  const original = fs.fsyncSync;
  let fail = true;
  const sync = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (fail) throw new Error("fixture disk sync failure");
    original(fd);
  });
  syncBuiltinESMExports();
  const dir = logsDir();
  const w = createWriter({ dir, role: "core", source: { kind: "harness", id: "core", version: null }, timers: false });
  try {
    w.writeLegacy("info", "replayed once");
    assert.throws(() => w.flush(), /fixture disk sync failure/);
    fail = false;
    w.flush();
    assert.equal(fs.readFileSync(path.join(dir, "core.log"), "utf8").trim().split("\n").length, 1);
    assert.equal(sync.mock.callCount(), 2);
  } finally { fail = false; w.close(); sync.mock.restore(); syncBuiltinESMExports(); }
});

it("a second writer syncs the first writer's unsynced file before rotating it", (t) => {
  const sync = t.mock.method(fs, "fsyncSync", fs.fsyncSync);
  syncBuiltinESMExports();
  const dir = logsDir();
  try {
    const first = createSink({ dir, role: "core", now: Date.now });
    const second = createSink({ dir, role: "core", now: Date.now, maxBytes: 1 });
    first.append("first\n", false);
    second.append("second\n", false);
    assert.equal(sync.mock.callCount(), 1, "rotation must sync even when this writer is clean");
    assert.equal(fs.readFileSync(path.join(dir, "core.log.1"), "utf8"), "first\n");
    second.sync(); first.sync();
  } finally { sync.mock.restore(); syncBuiltinESMExports(); }
});
