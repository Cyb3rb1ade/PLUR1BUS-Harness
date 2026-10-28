import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createSink } from "../../src/logs/sink.ts";
import { logsDir } from "./helpers.ts";
it("secures each new file identity once, including after rotation", () => {
  const dir = logsDir(); const calls: string[] = [];
  const sink = createSink({ dir, role: "core", now: Date.now, securePath: p => { calls.push(p); return { applied: true }; } });
  sink.append("x\n"); sink.append("y\n");
  assert.equal(calls.filter(p => p === sink.file).length, 1);
  sink.setRotation({ maxBytes: 3, keep: 2 }); sink.append("z\n");
  assert.equal(calls.filter(p => p === sink.file).length, 2);
});

it("keeps a secured identity when setting earlier timestamps also lowers its birth time", (t) => {
  const now = Date.UTC(2026, 9, 7); let birthtimeMs = now + 0.5;
  const stat = fs.fstatSync; const utimes = fs.utimesSync; const futimes = fs.futimesSync;
  // APFS also lowers birthtime when utimes sets earlier timestamps, including sub-millisecond rounding.
  t.mock.method(fs, "fstatSync", (fd: number) => Object.assign(stat(fd), { birthtimeMs }));
  const touched = (mtime: fs.TimeLike) => { birthtimeMs = Math.min(birthtimeMs, mtime instanceof Date ? mtime.getTime() : Number(mtime) * 1000); };
  t.mock.method(fs, "utimesSync", (file: fs.PathLike, atime: fs.TimeLike, mtime: fs.TimeLike) => { utimes(file, atime, mtime); touched(mtime); });
  t.mock.method(fs, "futimesSync", (fd: number, atime: fs.TimeLike, mtime: fs.TimeLike) => { futimes(fd, atime, mtime); touched(mtime); });
  syncBuiltinESMExports();
  try {
    const calls: string[] = [];
    const sink = createSink({ dir: logsDir(), role: "core", now: () => now, securePath: p => { calls.push(p); return { applied: true }; } });
    sink.append("x\n"); sink.append("y\n");
    assert.equal(birthtimeMs, now, "the filesystem moved the birth time");
    assert.equal(calls.filter(p => p === sink.file).length, 1);
    sink.setRotation({ maxBytes: 3, keep: 2 }); sink.append("z\n");
    assert.equal(calls.filter(p => p === sink.file).length, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
