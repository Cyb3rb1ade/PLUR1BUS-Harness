/** Checkpoint Git promises own the actual child until close, including cancellation and forced termination. */
import assert from "node:assert/strict";
import { constants, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkpointGitProcess } from "../../src/session/checkpoint-git-process.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cx-git-child-")), bin = join(root, "bin");
  mkdirSync(bin);
  const executable = join(bin, process.platform === "win32" ? "git.exe" : "git");
  try { linkSync(process.execPath, executable); } catch { copyFileSync(process.execPath, executable, constants.COPYFILE_FICLONE); }
  const script = join(root, "slow-git.cjs");
  writeFileSync(script, `const fs=require('node:fs'),path=require('node:path');
const send=name=>{const p=path.join(process.env.CX_GIT_FIXTURE,name);fs.writeFileSync(p+'.tmp',String(process.pid));fs.renameSync(p+'.tmp',p);};
process.on('SIGTERM',()=>send('term'));
send('ready');setInterval(()=>{},60000);
`);
  const cancel = new AbortController();
  let pending: Promise<string> | undefined;
  const watchers: { handle: ReturnType<typeof watch>; closed: Promise<void> }[] = [];
  function marker(name: string) {
    return new Promise<number>((resolve, reject) => {
      const watcher = watch(root, (_event, filename) => {
        if (filename !== name) return;
        try { const value = Number(readFileSync(join(root, name), "utf8")); watcher.close(); resolve(value); }
        catch (error) { reject(error); }
      });
      watcher.on("error", reject);
      watchers.push({ handle: watcher, closed: new Promise(resolve => watcher.once("close", resolve)) });
    });
  }
  const options = { signal: cancel.signal, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, CX_GIT_FIXTURE: root } };
  function startSlowGit() {
    const ready = marker("ready");
    const terminated = process.platform === "win32" ? undefined : marker("term");
    pending = checkpointGitProcess([script], options);
    return { ready, terminated, pending };
  }
  t.after(async () => {
    cancel.abort();
    if (pending) {
      // The two slow-child tests use a mock clock. Release its kill grace even on assertion failure.
      t.mock.timers.tick(1000);
      await pending.catch(() => {});
    }
    for (const watcher of watchers) watcher.handle.close();
    await Promise.all(watchers.map(watcher => watcher.closed));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { script, options, cancel, startSlowGit };
}

test("aborted checkpoint Git waits for its real child to close before rejecting", { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fixture(t);
  let settled = false;
  const { pending, ready, terminated } = r.startSlowGit();
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const pid = await ready;
  r.cancel.abort();
  if (process.platform !== "win32") {
    await terminated;
    assert.equal(settled, false, "SIGTERM acknowledgement is not process completion");
    t.mock.timers.tick(1_000);
  }
  await assert.rejects(pending, { name: "AbortError" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "no child remains when the operation rejects");
});

test("checkpoint Git timeout terminates and reaps a child that resists SIGTERM", { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fixture(t);
  let settled = false;
  const { pending, ready, terminated } = r.startSlowGit();
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const pid = await ready;
  t.mock.timers.tick(30_000);
  if (process.platform !== "win32") {
    await terminated;
    assert.equal(settled, false);
    t.mock.timers.tick(1_000);
  }
  await assert.rejects(pending, { name: "TimeoutError" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("checkpoint Git preserves stdout, handles spawn/nonzero errors and never prints private stderr in errors", { timeout: 10_000 }, async t => {
  const r = fixture(t);
  assert.equal(await checkpointGitProcess(["-e", 'process.stdout.write("result\\n");process.stderr.write("PRIVATE_STDERR")'], r.options), "result\n");
  await assert.rejects(checkpointGitProcess(["-e", 'process.stderr.write("PRIVATE_STDERR");process.exit(7)'], r.options),
    { message: "checkpoint Git failed", code: 7 });
  await assert.rejects(checkpointGitProcess([], { ...r.options, env: { PATH: join(tmpdir(), "nonexistent-cx-git-path") } }), { code: "ENOENT" });
  r.cancel.abort();
  await assert.rejects(checkpointGitProcess([r.script], r.options), { name: "AbortError" });
});

for (const stream of ["stdout", "stderr"] as const) {
  test(`checkpoint Git bounds ${stream} without returning partial output`, { timeout: 10_000 }, async t => {
    const r = fixture(t);
    await assert.rejects(checkpointGitProcess(["-e", `process.${stream}.write(Buffer.alloc(32*1024*1024+1,120))`], r.options),
      { message: "checkpoint Git output limit exceeded" });
  });
}
