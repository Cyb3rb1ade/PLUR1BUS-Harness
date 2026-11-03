/** Checkpoint Git promises own the actual child until close, including cancellation and forced termination. */
import assert from "node:assert/strict";
import { constants, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
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
  let pid: number | undefined;
  const watchers: ReturnType<typeof watch>[] = [];
  function marker(name: string) {
    return new Promise<number>((resolve, reject) => {
      const watcher = watch(root, (_event, filename) => {
        if (filename !== name) return;
        try { const value = Number(readFileSync(join(root, name), "utf8")); watcher.close(); resolve(value); }
        catch (error) { reject(error); }
      });
      watcher.on("error", reject); watchers.push(watcher);
    });
  }
  const ready = marker("ready"), terminated = marker("term");
  const options = { signal: cancel.signal, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, CX_GIT_FIXTURE: root } };
  t.after(() => {
    cancel.abort();
    if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch {} }
    for (const watcher of watchers) watcher.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { script, options, cancel, terminated, ready: async () => { pid = await ready; return pid; } };
}

test("aborted checkpoint Git waits for its real child to close before rejecting", { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = fixture(t);
  let settled = false;
  const pending = checkpointGitProcess([r.script], r.options);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const pid = await r.ready();
  r.cancel.abort();
  if (process.platform !== "win32") {
    await r.terminated;
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
  const pending = checkpointGitProcess([r.script], r.options);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const pid = await r.ready();
  t.mock.timers.tick(30_000);
  if (process.platform !== "win32") {
    await r.terminated;
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
