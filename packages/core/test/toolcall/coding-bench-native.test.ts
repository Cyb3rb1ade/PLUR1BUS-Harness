import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openCodingNativeFoundation } from "../../src/toolcall/coding-bench-live.ts";

const binary = resolve(process.env.CARGO_TARGET_DIR ?? fileURLToPath(new URL("../../../../target", import.meta.url)),
  "debug", `plur1bus-tools${process.platform === "win32" ? ".exe" : ""}`);

test("B1 prepares the real native service identity and reaps its private home", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "b1-n-")));
  try {
    await writeFile(join(home, "keep"), "owner marker");
    const native = await openCodingNativeFoundation(home, binary);
    const pid = native.health.pid;
    try {
      assert.equal(native.health.process.state, "ready");
      const directories = (await readdir(home)).filter(name => name !== "keep");
      assert.equal(directories.length, 1);
      const identity = join(home, directories[0]!, "run", "core.pid");
      assert.match(await readFile(identity, "utf8"), new RegExp(`^${process.pid} [a-f0-9-]{36}\\n$`, "u"));
      if (process.platform !== "win32") assert.equal((await stat(identity)).mode & 0o077, 0);
    } finally { await native.close(); }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(await readdir(home), ["keep"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("B1 removes its native home when the real service cannot start", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "b1-n-")));
  try {
    await assert.rejects(openCodingNativeFoundation(home, join(home, "missing-tools")));
    assert.deepEqual(await readdir(home), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
