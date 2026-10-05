// N1 lock audit: `<home>/imports/.lock` follows the ownership protocol of the plugin's registry lock. Release removes
// only a lock that still holds our nonce, a live foreign holder is never reaped, a dead one is, and a takeover is
// re-verified on a moved-aside name. Races are made deterministic by patching node:fs (syncBuiltinESMExports).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { acquireLock, LOCK_UNREADABLE_GRACE_MS } from "../../src/import/skills-registry.ts";
import type { ImportError } from "../../src/import/types.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const LIVE_PID = process.ppid; // the test runner: another live process
function deadPid(): number {
  for (let pid = 4_000_000; pid > 100_000; pid -= 7919) {
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return pid; }
  }
  throw new Error("no dead pid found");
}
const home = () => { const h = tempDir("n1-imports-lock-"); mkdirSync(join(h, "imports"), { recursive: true }); return h; };
const lockOf = (h: string) => join(h, "imports", ".lock");
const age = (p: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(p, t, t); };
const leftovers = (h: string) => readdirSync(join(h, "imports")).filter((n) => n.startsWith(".lock."));
const code = (f: () => unknown) => { try { f(); return "ok"; } catch (e) { return `${(e as ImportError).code}/${(e as ImportError).reason}`; } };
const holder = (pid: number, nonce = "foreign") => JSON.stringify({ pid, at: "2026-10-05T00:00:00.000Z", nonce });

describe("imports/.lock ownership (N1)", () => {
  it("writes a nonce; release removes our own lock and leaves no leftovers", () => {
    const h = home();
    const release = acquireLock(h);
    const body = JSON.parse(readFileSync(lockOf(h), "utf8")) as { pid: number; nonce: string };
    assert.equal(body.pid, process.pid);
    assert.match(body.nonce, /^[0-9a-f-]{36}$/);
    release();
    assert.equal(existsSync(lockOf(h)), false);
    assert.deepEqual(leftovers(h), []);
  });

  it("release leaves a lock that was taken over meanwhile", () => {
    const h = home();
    const release = acquireLock(h);
    writeFileSync(lockOf(h), holder(LIVE_PID));
    release();
    assert.equal(readFileSync(lockOf(h), "utf8"), holder(LIVE_PID));
    release(); // idempotent
    assert.equal(readFileSync(lockOf(h), "utf8"), holder(LIVE_PID));
    assert.deepEqual(leftovers(h), []);
  });

  it("never reaps a live foreign holder, however old", () => {
    const h = home();
    writeFileSync(lockOf(h), holder(LIVE_PID));
    age(lockOf(h), 24 * 3600_000);
    assert.equal(code(() => acquireLock(h)), "E_LOCKED/skills-locked");
    assert.equal(readFileSync(lockOf(h), "utf8"), holder(LIVE_PID));
  });

  it("reaps a dead holder (with or without a nonce)", () => {
    for (const text of [holder(deadPid()), JSON.stringify({ pid: deadPid() })]) {
      const h = home();
      writeFileSync(lockOf(h), text);
      const release = acquireLock(h);
      assert.equal((JSON.parse(readFileSync(lockOf(h), "utf8")) as { pid: number }).pid, process.pid);
      release();
      assert.equal(existsSync(lockOf(h)), false);
      assert.deepEqual(leftovers(h), []);
    }
  });

  it("an unreadable lock is a holder mid-create within the grace, a leftover after it", () => {
    const h = home();
    writeFileSync(lockOf(h), "");
    assert.equal(code(() => acquireLock(h)), "E_LOCKED/skills-locked");
    assert.equal(readFileSync(lockOf(h), "utf8"), "");
    age(lockOf(h), LOCK_UNREADABLE_GRACE_MS + 5_000);
    acquireLock(h)();
    assert.equal(existsSync(lockOf(h)), false);
  });

  it("a takeover does not delete a fresh lock that replaced the judged one", () => {
    const h = home();
    writeFileSync(lockOf(h), holder(deadPid(), "dead"));
    const fresh = holder(LIVE_PID, "fresh");
    const real = fs.renameSync;
    let swapped = false;
    fs.renameSync = ((src: fs.PathLike, dst: fs.PathLike) => {
      if (!swapped && String(src) === lockOf(h) && String(dst).includes(".lock.break-")) {
        swapped = true; // another taker removed the dead lock and created its own
        rmSync(lockOf(h));
        writeFileSync(lockOf(h), fresh);
      }
      return real(src, dst);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try {
      assert.equal(code(() => acquireLock(h)), "E_LOCKED/skills-locked");
    } finally {
      fs.renameSync = real;
      syncBuiltinESMExports();
    }
    assert.equal(swapped, true);
    assert.equal(readFileSync(lockOf(h), "utf8"), fresh);
    assert.deepEqual(leftovers(h), []);
  });

  it("sweeps a dead holder's leftover from a crashed release, keeps a live one's", () => {
    const h = home();
    writeFileSync(join(h, "imports", ".lock.rel-dead"), holder(deadPid()));
    writeFileSync(join(h, "imports", ".lock.break-live"), holder(LIVE_PID));
    acquireLock(h)();
    assert.deepEqual(leftovers(h), [".lock.break-live"]);
  });
});
