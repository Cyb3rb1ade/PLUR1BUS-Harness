import assert from "node:assert/strict";
import { copyFile, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

test("the Rust checker selects the pinned compiler behind a packaged launcher before entering the private home", {
  skip: process.platform === "win32" && "the team checker runs on Unix",
}, async t => {
  const module = new URL("../../../../tests/bench/coding/team/_shared/runtime.mjs", import.meta.url);
  const { languageRuntime, rustChannel } = await import(module.href);
  const root = await realpath(await mkdtemp(join(tmpdir(), "team-rust-launcher-")));
  const bin = join(root, "bin"), home = join(root, "private"), sysroot = join(root, "toolchain");
  const compiler = join(sysroot, "bin", "rustc");
  const previousPath = process.env.PATH;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(bin);
  await mkdir(home);
  await mkdir(join(sysroot, "bin"), { recursive: true });
  const channel = await rustChannel();
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  // Packaged rustc and rustup entrypoints are separate scripts. Only the installed compiler works in a private home.
  await writeFile(join(bin, "rustc"), [
    "#!/bin/sh", `[ "$HOME" = ${quote(homedir())} ] && [ "$RUSTUP_TOOLCHAIN" = ${quote(channel)} ] || exit 8`,
    '[ "$1" = --print ] && [ "$2" = sysroot ] || exit 9', `echo ${quote(sysroot)}`, "",
  ].join("\n"), { mode: 0o755 });
  await writeFile(join(bin, "rustup"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(compiler, [
    "#!/bin/sh", `[ "$HOME" = ${quote(home)} ] || exit 10`,
    '[ "$1" = --print ] && [ "$2" = sysroot ] || exit 11', `echo ${quote(sysroot)}`, "",
  ].join("\n"), { mode: 0o755 });
  process.env.PATH = bin;
  const runtime = await languageRuntime("rust", home, {});
  assert.equal(runtime.program, compiler);
  assert.equal(runtime.env.HOME, home);
  assert.deepEqual(runtime.roots, [sysroot]);
});

test("the installed macOS Rust toolchain compiles and runs the authored preflight in its private home", {
  skip: process.platform !== "darwin" && "macOS runner toolchain",
}, async t => {
  const base = new URL("../../../../tests/bench/coding/team/_shared/", import.meta.url);
  const { languageRuntime, preflight } = await import(new URL("runtime.mjs", base).href);
  const { runOwnedCommand } = await import(new URL("process.mjs", base).href);
  const root = await realpath(await mkdtemp(join(tmpdir(), "team-rust-preflight-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await languageRuntime("rust", root, {});
  t.diagnostic("pinned compiler selected and private sysroot query completed");
  await preflight("rust", runtime, root, async (request: { program: string }) => {
    const result = await runOwnedCommand({ ...request, timeoutMs: 10000 });
    const stage = request.program === runtime.program ? "compile" : "run";
    t.diagnostic(`authored preflight ${stage}: exit=${result.code}, reason=${result.reason ?? "none"}`);
    return result;
  });
});
