import { readFileSync } from "node:fs";
import { resolve } from "node:path";
/** AF2's actual filesystem guard: the adapter's private-directory trust port is fail-closed. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layout } from "../src/paths.ts";
import { createAppleFmSocketGuard } from "../src/apple-fm/socket.ts";

const POSIX = { timeout: 10_000, skip: process.platform === "win32" && "AF2: actual Unix sockets require POSIX" };

async function home(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "p1af2-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = layout(root);
  await mkdir(paths.run, { mode: 0o700 });
  await mkdir(paths.appleFmDir, { mode: 0o700 });
  return paths;
}

async function socket(t: TestContext, path: string) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await chmod(path, 0o755);
}

test("the 0755 owned socket inside the real 0700 Layout directory is trusted", POSIX, async t => {
  const paths = await home(t);
  await socket(t, paths.appleFmSocket);
  const descriptor = { id: "apple-fm" as const, path: paths.appleFmSocket };
  assert.deepEqual(await createAppleFmSocketGuard(paths.home).verify(descriptor), { ok: true });
});

for (const mode of [0o755, 0o770]) {
  test(`guard refuses directory mode ${mode.toString(8)} and never repairs it`, POSIX, async t => {
    const paths = await home(t);
    await socket(t, paths.appleFmSocket);
    await chmod(paths.appleFmDir, mode);
    const descriptor = { id: "apple-fm" as const, path: paths.appleFmSocket };
    assert.deepEqual(await createAppleFmSocketGuard(paths.home).verify(descriptor), {
      ok: false, reason: "socket-untrusted",
    });
    assert.equal((await lstat(paths.appleFmDir)).mode & 0o777, mode);
  });
}

test("guard refuses a symlinked parent instead of following it", POSIX, async t => {
  const paths = await home(t);
  await rm(paths.appleFmDir, { recursive: true });
  const outside = join(paths.home, "outside");
  await mkdir(outside, { mode: 0o700 });
  await socket(t, join(outside, "fm.sock"));
  await symlink(outside, paths.appleFmDir);
  assert.deepEqual(await createAppleFmSocketGuard(paths.home).verify({ id: "apple-fm", path: paths.appleFmSocket }), {
    ok: false, reason: "socket-untrusted",
  });
});

test("guard refuses a regular file and a symlink in place of its socket", POSIX, async t => {
  const paths = await home(t);
  const descriptor = { id: "apple-fm" as const, path: paths.appleFmSocket };
  const guard = createAppleFmSocketGuard(paths.home);
  await writeFile(paths.appleFmSocket, "synthetic");
  assert.deepEqual(await guard.verify(descriptor), { ok: false, reason: "socket-untrusted" });
  await rm(paths.appleFmSocket);
  const other = join(paths.appleFmDir, "other.sock");
  await socket(t, other);
  await symlink(other, paths.appleFmSocket);
  assert.deepEqual(await guard.verify(descriptor), { ok: false, reason: "socket-untrusted" });
});

test("foreign socket uid is refused using injected identity without chown or privileges", POSIX, async t => {
  const paths = await home(t);
  await socket(t, paths.appleFmSocket);
  const uid = process.geteuid!();
  const guard = createAppleFmSocketGuard(paths.home, {
    readSocketInfo: () => ({ uid: uid + 1, isSocket: () => true, isSymbolicLink: () => false }),
  });
  assert.deepEqual(await guard.verify({ id: "apple-fm", path: paths.appleFmSocket }), {
    ok: false, reason: "socket-untrusted",
  });
});

test("Windows refusal happens without consulting the filesystem", () => {
  const guard = createAppleFmSocketGuard("/synthetic", { platform: "win32", readSocketInfo: () => {
    throw new Error("filesystem must not be consulted");
  } });
  assert.deepEqual(guard.verify({ id: "apple-fm", path: "/synthetic/run/apple-fm/fm.sock" }), {
    ok: false, reason: "platform",
  });
});


test("Apple socket Layout matches the shared Rust/TypeScript vectors", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../../tests/fixtures/apple-fm-paths.json", import.meta.url), "utf8")) as { home: string; directory: string; socket: string }[];
  for (const vector of vectors) {
    assert.equal(layout(vector.home).appleFmDir, resolve(vector.directory));
    assert.equal(layout(vector.home).appleFmSocket, resolve(vector.socket));
  }
});
