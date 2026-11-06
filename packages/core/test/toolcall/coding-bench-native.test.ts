import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openCodingNativeFoundation, stageCodingPrograms } from "../../src/toolcall/coding-bench-live.ts";
import type { CodingRuntimes } from "../../src/toolcall/coding-bench-runtime.ts";

const binary = resolve(process.env.CARGO_TARGET_DIR ?? fileURLToPath(new URL("../../../../target", import.meta.url)),
  "debug", `plur1bus-tools${process.platform === "win32" ? ".exe" : ""}`);

test("B1 stages Go's private compiler tree and executable launcher at distinct paths", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "b1-go-")));
  try {
    const source = join(home, "installed-go");
    await mkdir(join(source, "bin"), { recursive: true });
    await writeFile(join(source, "bin", "go"), "fixture compiler", { mode: 0o700 });
    const runtime: CodingRuntimes = {
      node: process.execPath, python: process.execPath, shell: "unused", rustc: "unused", rustRoot: "unused",
      go: join(source, "bin", "go"), goRoot: source, cache: "unused",
      versions: { node: process.versions.node, python: "unused", rust: "unused", go: "unused" },
      async close() {},
    };
    const worktree = join(home, "worktree");
    const programs = await stageCodingPrograms(runtime, worktree, "go", "unused");
    const wrapper = programs.at(-1)!;
    assert.equal((await stat(wrapper)).isFile(), true);
    const stagedRoot = join(worktree, ".build", "runtime", "go-toolchain");
    assert.equal((await stat(stagedRoot)).isDirectory(), true);
    const launcher = await readFile(wrapper, "utf8");
    assert.ok(launcher.includes(`"GOROOT":${JSON.stringify(stagedRoot)}`));
    assert.ok(launcher.includes(JSON.stringify(join(stagedRoot, "bin", "go"))));
    assert.equal(await readFile(join(stagedRoot, "bin", "go"), "utf8"), "fixture compiler");
    await writeFile(join(stagedRoot, "bin", "go"), "changed private compiler");
    assert.equal(await readFile(join(source, "bin", "go"), "utf8"), "fixture compiler");
  } finally { await rm(home, { recursive: true, force: true }); }
});

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
