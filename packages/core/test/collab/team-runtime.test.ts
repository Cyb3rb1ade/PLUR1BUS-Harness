import assert from "node:assert/strict";
import { copyFile, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("the team checker resolves both forms of rustup proxy before giving rustc a private home", {
  skip: process.platform === "win32" && "the team checker runs on Unix",
}, async t => {
  const module = new URL("../../../../tests/bench/coding/team/_shared/runtime.mjs", import.meta.url);
  const { languageRuntime, rustChannel } = await import(module.href);
  const root = await realpath(await mkdtemp(join(tmpdir(), "team-rustup-")));
  const previousPath = process.env.PATH;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  });
  for (const kind of ["symlink", "hardlink", "standalone"]) {
    const bin = join(root, kind), home = join(bin, "private"), compiler = join(bin, "compiler");
    await mkdir(home, { recursive: true });
    await writeFile(compiler, '#!/bin/sh\n[ "$1" = --print ] && [ "$2" = sysroot ] && pwd\n', { mode: 0o755 });
    const manager = join(bin, "rustup");
    const query = `[ "$1" = which ] && [ "$2" = --toolchain ] && [ "$3" = '${await rustChannel()}' ] && [ "$4" = rustc ]`;
    const dispatch = '#!/bin/sh\n' + query + ' && echo "${0%/*}/compiler"\n';
    await writeFile(manager, dispatch, { mode: 0o755 });
    if (kind === "symlink") await symlink(manager, join(bin, "rustc"));
    else if (kind === "hardlink") await link(manager, join(bin, "rustc"));
    else await copyFile(compiler, join(bin, "rustc"));
    process.env.PATH = bin;
    const result = await languageRuntime("rust", home, {});
    assert.equal(result.program, kind === "standalone" ? join(bin, "rustc") : compiler, kind);
    assert.equal(result.env.HOME, home, kind);
    assert.deepEqual(result.roots, [home], kind);
  }
});
