// The import's single-writer lock against a legacy core that outlives its front door (P4-10 security review M3): the
// front door's state/core.lock is free once it died, but the TypeScript core behind it may still be stopping and writing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireCoreLock } from "../../src/lock.ts";
import { withTargetLock } from "../../src/import/single-writer.ts";
import { layout } from "../../src/paths.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const holder = fileURLToPath(new URL("../helpers/lock-holder.ts", import.meta.url));

describe("withTargetLock behind a stopped front door", () => {
  it("refuses target-running while run/core-legacy.lock is held, and holds both locks while it runs", async () => {
    const l = layout(tempDir("p1b-single-writer-"));
    mkdirSync(l.run, { recursive: true, mode: 0o700 });
    const legacy = join(l.run, "core-legacy.lock");
    const child = spawn(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings", holder, legacy], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    let ran = false;
    try {
      await assert.rejects(withTargetLock(l, () => { ran = true; }), (e: any) => e.reason === "target-running" && /core-legacy\.lock/.test(e.message));
      assert.equal(ran, false);
      acquireCoreLock(l.coreLock, "after").release(); // the refusal left state/core.lock free
    } finally { child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r)); }
    await withTargetLock(l, () => {
      ran = true;
      assert.throws(() => acquireCoreLock(l.coreLock, "x"), (e: any) => e.error === "E_LOCKED");
      assert.throws(() => acquireCoreLock(legacy, "x"), (e: any) => e.error === "E_LOCKED", "a legacy core cannot start meanwhile");
    });
    assert.equal(ran, true);
    acquireCoreLock(l.coreLock, "x", { legacy }).release(); // both are free again
  });

  it("refuses target-running while run/core-legacy.pid names a live process", async () => {
    const l = layout(tempDir("p1b-single-writer-"));
    mkdirSync(l.run, { recursive: true, mode: 0o700 });
    // The legacy core's own record; run/core.pid (the dead front door's) is gone or stale.
    writeFileSync(join(l.run, "core-legacy.pid"), `${process.pid} 7a3a4b2c-0d1e-4f50-9a6b-1c2d3e4f5a6b\n`);
    await assert.rejects(withTargetLock(l, () => {}), (e: any) => e.reason === "target-running" && new RegExp(`pid ${process.pid}`).test(e.message));
    writeFileSync(join(l.run, "core-legacy.pid"), "2147483646 7a3a4b2c-0d1e-4f50-9a6b-1c2d3e4f5a6b\n"); // stale: no such process
    await withTargetLock(l, () => {});
  });
});
