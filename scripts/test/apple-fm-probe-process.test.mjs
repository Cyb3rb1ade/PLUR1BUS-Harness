/** AF0 review regressions for owned process groups, real stdin EOF and delayed post-parent-exit observations. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as lib from "../spikes/apple-fm-probe-lib.mjs";
import * as probe from "../spikes/apple-fm-probe.mjs";

const T = { timeout: 15_000 };
const POSIX = { ...T, skip: process.platform === "win32" && "AF0 owned Unix sockets/process groups require POSIX" };
const fixture = new URL("./fixtures/apple-fm-fake.mjs", import.meta.url);
const noTcp = async pid => ({ code: 1, signal: null, stdout: "", stderr: "", checkedPid: pid, source: "offline OS port" });

async function withFake(mode, use) {
  const directory = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "af0f-")));
  const program = join(directory, "fake-fm.mjs");
  try {
    await chmod(directory, 0o700);
    await writeFile(program, `#!${process.execPath}\n${await readFile(fixture, "utf8")}`, { mode: 0o700 });
    await writeFile(join(directory, "fake-mode"), mode);
    return await use({ directory, program, socket: join(directory, "fm.sock") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("owned cleanup records ESRCH for the complete group and every tracked descendant", POSIX, async () => {
  let owned;
  const source = "const {spawn}=require('node:child_process');"
    + "const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});"
    + "c.once('spawn',()=>console.log(c.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)";
  await lib.withOwnedProcess(process.execPath, ["-e", source], { env: {}, graceMs: 30 }, async handle => {
    owned = handle;
    const [bytes] = await once(handle.child.stdout, "data");
    handle.trackPid(Number(bytes.toString().trim()));
  });
  assert.equal(owned.cleanup.directChildReaped, true);
  assert.equal(owned.cleanup.group.code, "ESRCH");
  assert.equal(owned.cleanup.pids.length, 2);
  assert.ok(owned.cleanup.pids.every(item => item.code === "ESRCH"));
});

test("probe signal handling includes repeated HUP/TERM until explicit cleanup disposal", () => {
  const events = new EventEmitter();
  const controller = new AbortController();
  const dispose = lib.installProbeSignals(controller, events);
  events.emit("SIGHUP");
  events.emit("SIGHUP");
  events.emit("SIGTERM");
  assert.equal(controller.signal.aborted, true);
  assert.equal(events.listenerCount("SIGHUP"), 1);
  dispose();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(events.listenerCount(name), 0);
});

test("a transient EPERM during group disappearance is retried and never counted as ESRCH", POSIX, async t => {
  const kill = process.kill.bind(process);
  let owned;
  let denied = false;
  await lib.withOwnedProcess(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"],
    { env: {} }, async handle => {
      owned = handle;
      await once(handle.child.stdout, "data");
      t.mock.method(process, "kill", (pid, signal) => {
        if (!denied && pid === -handle.child.pid && signal === 0) {
          denied = true;
          throw Object.assign(new Error("synthetic transition"), { code: "EPERM" });
        }
        return kill(pid, signal);
      });
    });
  assert.equal(denied, true);
  assert.equal(owned.cleanup.group.code, "ESRCH");
});

test("withFmServer enforces socket argv, the reduced environment and the TCP inspection boundary", POSIX, async () => {
  await withFake("stay", async ({ directory, program, socket }) => {
    const receipt = {};
    const old = process.env.AF0_SYNTHETIC_SECRET;
    process.env.AF0_SYNTHETIC_SECRET = "must-not-reach-fake";
    let checked = 0;
    try {
      await probe.withFmServer(directory, socket, AbortSignal.timeout(5000), receipt, async ({ child }) => {
        const info = receipt.readyHealth.events[0].offline;
        assert.deepEqual(info.argv, ["serve", "--socket", socket]);
        assert.equal(info.cwd, directory);
        assert.equal(info.env.PATH, "/usr/bin:/bin");
        assert.equal(info.env.LANG, "en_US.UTF-8");
        assert.equal(info.env.HOME, process.env.HOME);
        assert.equal(info.env.AF0_SYNTHETIC_SECRET, undefined);
        assert.deepEqual(receipt.serverInvocation.environmentKeys.sort(), ["HOME", "LANG", "PATH"]);
        const runtimeKeys = ["HOME", "LANG", "PATH"];
        // CoreFoundation can synthesize this value after exec; it was not supplied in the spawn environment.
        if (process.platform === "darwin" && "__CF_USER_TEXT_ENCODING" in info.env) {
          runtimeKeys.push("__CF_USER_TEXT_ENCODING");
          assert.equal(receipt.serverInvocation.environmentKeys.includes("__CF_USER_TEXT_ENCODING"), false);
        }
        assert.deepEqual(Object.keys(info.env).sort(), runtimeKeys.sort());
        assert.equal(receipt.tcpListeners.checkedPid, child.pid);
      }, { program, inspectTcp: async pid => { checked++; return noTcp(pid); } });
    } finally {
      if (old === undefined) delete process.env.AF0_SYNTHETIC_SECRET;
      else process.env.AF0_SYNTHETIC_SECRET = old;
    }
    assert.equal(checked, 1);
    assert.equal(receipt.cleanup.group.code, "ESRCH");
    assert.ok(receipt.cleanup.pids.every(item => item.code === "ESRCH"));
  });
});

test("withFmServer rejects a reported TCP listener before protocol I/O and still reaps the fake", POSIX, async () => {
  await withFake("stay", async ({ directory, program, socket }) => {
    const receipt = {};
    let entered = false;
    await assert.rejects(probe.withFmServer(directory, socket, AbortSignal.timeout(5000), receipt, async () => {
      entered = true;
    }, { program, inspectTcp: async () => ({ code: 0, stdout: "synthetic TCP listener", stderr: "" }) }), /TCP listener/);
    assert.equal(entered, false);
    assert.equal(receipt.cleanup.group.code, "ESRCH");
  });
});

test("the real-program helper refuses missing consent before reaching its spawn boundary", POSIX, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af0-refuse-"));
  await rm(directory, { recursive: true });
  const previous = process.env.PLUR1BUS_APPLE_FM_LIVE;
  delete process.env.PLUR1BUS_APPLE_FM_LIVE;
  try {
    // The deliberately missing cwd also prevents execution if this guard regresses.
    await assert.rejects(probe.withFmServer(directory, join(directory, "fm.sock"),
      AbortSignal.timeout(1000), {}, async () => {}), /AF0 (requires PLUR1BUS_APPLE_FM_LIVE|refuses real fm in CI)/);
  } finally {
    if (previous === undefined) delete process.env.PLUR1BUS_APPLE_FM_LIVE;
    else process.env.PLUR1BUS_APPLE_FM_LIVE = previous;
  }
});

test("stdin EOF is delivered to an open pipe after readiness and continuedServing is observed", POSIX, async () => {
  await withFake("stay", async ({ directory, program }) => {
    const result = await probe.stdinEofProbe(directory, AbortSignal.timeout(5000), {
      program, inspectTcp: noTcp, durationMs: 40,
    });
    assert.equal(result.initialStdin, "open pipe");
    assert.equal(result.stdinCloseEvent, "finish");
    assert.equal(result.continuedServing, true);
    assert.equal(result.observations.length, 3);
    assert.ok(result.observations.at(-1).elapsedMs >= 40);
    assert.equal(result.observations.at(-1).response.events[0].offline.stdinEof, true);
    assert.equal(result.cleanup.group.code, "ESRCH");
  });
});

test("stdin EOF is not reported as continued serving when the fake exits on EOF", POSIX, async () => {
  await withFake("exit-on-eof", async ({ directory, program }) => {
    const result = await probe.stdinEofProbe(directory, AbortSignal.timeout(5000), {
      program, inspectTcp: noTcp, durationMs: 80,
    });
    assert.equal(result.continuedServing, false);
    assert.equal(result.observations.length, 3);
    assert.equal(result.cleanup.group.code, "ESRCH");
  });
});

test("interrupted lifecycle work leaves its owned cleanup and PID evidence in the caller's partial receipt", POSIX,
  async () => {
    await withFake("stay", async ({ directory, program }) => {
      const receipt = {};
      const controller = new AbortController();
      await assert.rejects(probe.stdinEofProbe(directory, controller.signal, {
        receipt, program, durationMs: 100,
        inspectTcp: async pid => {
          controller.abort(new Error("synthetic lifecycle interruption"));
          return noTcp(pid);
        },
      }), /synthetic lifecycle interruption|aborted/i);
      assert.ok(receipt.serverPid > 1);
      assert.equal(receipt.cleanup.group.code, "ESRCH");
      assert.ok(receipt.cleanup.pids.every(item => item.code === "ESRCH"));
    });
  });

test("parent death samples health throughout the observation interval and records descendant ESRCH", POSIX, async () => {
  await withFake("stay", async ({ directory, program }) => {
    const result = await probe.parentDeathProbe(directory, AbortSignal.timeout(5000), {
      program, inspectTcp: noTcp, durationMs: 40,
    });
    assert.equal(result.parentExit.signal, "SIGKILL");
    assert.deepEqual(result.spawnManifest.args, ["serve", "--socket", join(directory, "orphan.sock")]);
    assert.deepEqual(result.spawnManifest.environmentKeys.sort(), ["HOME", "LANG", "PATH"]);
    assert.equal(result.continuedServing, true);
    assert.equal(result.observations.length, 3);
    assert.ok(result.observations.at(-1).elapsedMs >= 40);
    assert.equal(result.cleanup.group.code, "ESRCH");
    assert.equal(result.cleanup.pids.find(item => item.pid === result.fmPid).code, "ESRCH");
  });
});

test("a delayed exit after parent death is measured as not continuedServing", POSIX, async () => {
  await withFake("exit-when-orphaned", async ({ directory, program }) => {
    const result = await probe.parentDeathProbe(directory, AbortSignal.timeout(5000), {
      program, inspectTcp: noTcp, durationMs: 100,
    });
    assert.equal(result.continuedServing, false);
    assert.equal(result.observations.length, 3);
    assert.equal(result.cleanup.group.code, "ESRCH");
  });
});
