import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireCoreLock } from "../src/lock.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const holder = fileURLToPath(new URL("./helpers/lock-holder.ts", import.meta.url));

describe("core lock", () => {
  it("refuses a second holder in another process and frees on SIGKILL", async () => {
    const path = join(tempDir("p1b-lock-"), "core.lock");
    const child = spawn(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings", holder, path], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    assert.throws(() => acquireCoreLock(path, "second"), (e: any) => e.error === "E_LOCKED" && e.reason === "core-lock-held");
    child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r));
    const lock = acquireCoreLock(path, "second"); lock.release();
  });
  it("release lets the same process re-acquire", () => {
    const path = join(tempDir("p1b-lock-"), "core.lock");
    const a = acquireCoreLock(path, "i1"); a.release();
    const b = acquireCoreLock(path, "i2"); b.release();
  });
  it("a lock that cannot be opened is a plain error, not E_LOCKED (bin.ts exits 1, never the retryable 3)", () => {
    const path = join(tempDir("p1b-lock-"), "core.lock");
    mkdirSync(path); // a directory where the lock file belongs
    assert.throws(() => acquireCoreLock(path, "i1"), (e: unknown) => e instanceof Error && !("error" in e));
  });
});
