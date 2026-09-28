// Retry on transient Windows file locks (plugin-distribution spec §B.5 last bullet, gap G8): Defender, the Search
// indexer or an editor can hold a fresh file for a moment; rename/copy/rm then fail with EPERM/EBUSY/EACCES. The clock
// and the platform are injected.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renameRetry, retrySync } from "../../src/import/fs-retry.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });
function flaky(failures: string[]) {
  let calls = 0;
  return { fn: () => { const c = failures[calls++]; if (c) throw errno(c); return "done"; }, calls: () => calls };
}
function clock() {
  let t = 0; const sleeps: number[] = [];
  return { now: () => t, sleep: (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
}

describe("retrySync", () => {
  it("retries EPERM, EBUSY and EACCES on Windows with growing waits", () => {
    const f = flaky(["EBUSY", "EPERM", "EACCES"]); const c = clock();
    assert.equal(retrySync(f.fn, { platform: "win32", now: c.now, sleep: c.sleep }), "done");
    assert.equal(f.calls(), 4);
    assert.ok(c.sleeps.length === 3 && c.sleeps[0]! < c.sleeps[1]! && c.sleeps[1]! < c.sleeps[2]!, String(c.sleeps));
  });
  it("gives up after about 10 s with the last error", () => {
    const c = clock();
    assert.throws(() => retrySync(() => { throw errno("EBUSY"); }, { platform: "win32", now: c.now, sleep: c.sleep }), /EBUSY/);
    const total = c.sleeps.reduce((a, b) => a + b, 0);
    assert.ok(total >= 9_000 && total <= 10_000, String(total));
  });
  it("fails at once on POSIX (the codes are not transient there) and for other codes", () => {
    const c = clock();
    const posix = flaky(["EACCES"]);
    assert.throws(() => retrySync(posix.fn, { platform: "linux", now: c.now, sleep: c.sleep }), /EACCES/);
    const other = flaky(["ENOENT"]);
    assert.throws(() => retrySync(other.fn, { platform: "win32", now: c.now, sleep: c.sleep }), /ENOENT/);
    assert.deepEqual([posix.calls(), other.calls(), c.sleeps.length], [1, 1, 0]);
  });
  it("renameRetry renames for real", () => {
    const d = tempDir("p1b-imp-");
    writeFileSync(join(d, "a"), "x");
    renameRetry(join(d, "a"), join(d, "b"));
    assert.deepEqual([existsSync(join(d, "a")), readFileSync(join(d, "b"), "utf8")], [false, "x"]);
  });
});
