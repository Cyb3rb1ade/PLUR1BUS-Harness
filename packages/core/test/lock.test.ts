import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireCoreLock } from "../src/lock.ts";

const holder = fileURLToPath(new URL("./helpers/lock-holder.ts", import.meta.url));

describe("core lock", () => {
  it("refuses a second holder in another process and frees on SIGKILL", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "p1b-lock-")), "core.lock");
    const child = spawn(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings", holder, path], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    assert.throws(() => acquireCoreLock(path, "second"), (e: any) => e.error === "E_LOCKED" && e.reason === "core-lock-held");
    child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r));
    const lock = acquireCoreLock(path, "second"); lock.release();
  });
  it("release lets the same process re-acquire", () => {
    const path = join(mkdtempSync(join(tmpdir(), "p1b-lock-")), "core.lock");
    const a = acquireCoreLock(path, "i1"); a.release();
    const b = acquireCoreLock(path, "i2"); b.release();
  });
});
