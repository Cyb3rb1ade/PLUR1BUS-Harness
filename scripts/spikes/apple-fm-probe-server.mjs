/** AF0 server ownership and lifecycle measurements, shared by the real Mac probe and offline fake executable. */
import { lstat, mkdir } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as measurementInterval } from "node:timers/promises";
import { join, resolve } from "node:path";
import {
  captureProcess, describeResponse, observeResponse, processVisibility, requireLiveProbe, socketRequest, withOwnedProcess,
} from "./apple-fm-probe-lib.mjs";

const MARKER = "AF0_SYNTHETIC_MARKER";

/** Wait for the actual socket within the AF0 cold-start measurement budget. */
export async function waitForSocket(socket, child, signal) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`fm exited before socket readiness: ${child.exitCode}/${child.signalCode}`);
    }
    try {
      const info = await lstat(socket);
      if (!info.isSocket()) {
        throw new Error("fm socket path is not a socket");
      }
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    // The real-child regression showed fs.watch missing Unix-socket creation on this Mac.
    await measurementInterval(25, undefined, { signal });
  }
  throw new Error("fm socket readiness measurement timeout (120 s)");
}

/** Socket presence precedes listen(); retry only the transient bind/listen errors within the readiness budget. */
async function waitForHealth(socket, child, signal) {
  await waitForSocket(socket, child, signal);
  const deadline = performance.now() + 120_000;
  while (true) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null || performance.now() >= deadline) {
      throw new Error("fm exited or exhausted the HTTP readiness measurement budget");
    }
    try {
      return await socketRequest(socket, { method: "GET", path: "/health", signal });
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
      await measurementInterval(25, undefined, { signal });
    }
  }
}

async function inspectTcpListeners(pid, env) {
  return captureProcess("/usr/sbin/lsof",
    ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"], { env });
}

async function verifyNoTcp(pid, env, inspectTcp) {
  const result = await inspectTcp(pid, env);
  if (result.stdout?.trim()) throw new Error("spec-contradiction: fm serve --socket owns a TCP listener");
  if (![0, 1].includes(result.code) || result.signal || result.stderr?.trim()) {
    throw new Error("TCP listener inspection did not complete cleanly");
  }
  return { ...result, checkedPid: pid };
}

/** The live path and its fake executable share exact argv, environment, TCP inspection and owned teardown. */
export async function withFmServer(directory, socket, signal, receipt, use,
  { program = "/usr/bin/fm", stdin = "ignore", inspectTcp = inspectTcpListeners } = {}) {
  if (program === "/usr/bin/fm") requireLiveProbe();
  signal.throwIfAborted();
  const env = { HOME: process.env.HOME, LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" };
  let owned;
  try {
    return await withOwnedProcess(program, ["serve", "--socket", socket], { env, cwd: directory, stdin }, async handle => {
      owned = handle;
      receipt.serverInvocation = {
        program, args: ["serve", "--socket", socket],
        environmentKeys: Object.keys(env), LANG: env.LANG, PATH: env.PATH,
        stdin: stdin === "pipe" ? "open pipe" : "closed (/dev/null)",
      };
      receipt.serverPid = handle.child.pid;
      receipt.readyHealth = observeResponse(await waitForHealth(resolve(directory, socket), handle.child, signal));
      receipt.tcpListeners = await verifyNoTcp(handle.child.pid, env, inspectTcp);
      return await use(handle);
    });
  } finally {
    if (owned) {
      receipt.serverExit = owned.cleanup.exit ?? null;
      receipt.serverLogs = {
        ...owned.logs,
        syntheticPromptMarkerPresentInTail: owned.logs.stdout.includes(MARKER) || owned.logs.stderr.includes(MARKER),
      };
      receipt.cleanup = { ...owned.cleanup, directServerReaped: owned.cleanup.directChildReaped };
    }
  }
}

export async function socketEdgeProbes(directory, signal, env) {
  const results = {};
  for (const variant of ["relative", "stale", "path-103", "path-104"]) {
    const working = join(directory, variant);
    await mkdir(working, { mode: 0o700 });
    const nameLength = Number(variant.slice(5));
    const name = variant.startsWith("path-") ? "s".repeat(nameLength - Buffer.byteLength(working) - 1) : "fm.sock";
    const absoluteSocket = join(working, name);
    const passedSocket = variant === "relative" ? name : absoluteSocket;
    const row = { pathBytes: Buffer.byteLength(absoluteSocket) };
    results[variant] = row;
    try {
      if (variant === "stale") {
        await withOwnedProcess(process.execPath, ["-e",
          "require('node:net').createServer().listen(process.argv[1],()=>process.stdout.write('ready'))", absoluteSocket],
        { env }, async ({ child }) => { await once(child.stdout, "data", { signal }); });
        row.staleSocketCreated = (await lstat(absoluteSocket)).isSocket();
      }
      await withFmServer(working, passedSocket, signal, row, async () => {
        row.health = describeResponse(await socketRequest(absoluteSocket, { method: "GET", path: "/health", signal }));
      });
    } catch (error) {
      row.failure = { code: error.code ?? null, message: error.message };
      if (error.message.startsWith("spec-contradiction:")) throw error;
    }
    signal.throwIfAborted();
  }
  return results;
}

/** Observe at least three health/PID samples across the interval, including after a delayed self-exit. */
async function observeServing(socket, pid, signal, durationMs, result) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("invalid lifecycle observation interval");
  const started = performance.now();
  result.observations = [];
  result.observationComplete = false;
  result.continuedServing = null;
  try {
    for (const atMs of [0, durationMs / 2, durationMs]) {
      while (performance.now() - started < atMs) {
        await measurementInterval(Math.max(1, atMs - (performance.now() - started)), undefined, { signal });
      }
      const row = { elapsedMs: performance.now() - started, process: processVisibility(pid) };
      try {
        row.response = observeResponse(await socketRequest(socket, {
          method: "GET", path: "/health", signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
        }));
      } catch (error) {
        signal.throwIfAborted();
        row.failure = { code: error.code ?? null, name: error.name, message: error.message };
      }
      result.observations.push(row);
    }
    result.observationComplete = true;
    result.continuedServing = result.observations.every(row => row.process.exists && row.response?.status === 200
      && row.response.events.some(event => Array.isArray(event.models)
        && event.models.some(model => model.name === "system" && typeof model.available === "boolean")));
  } finally {
    result.observedForMs = performance.now() - started;
  }
}

/** Open stdin during startup, close the pipe only after health, then measure subsequent serving. */
export async function stdinEofProbe(directory, signal,
  { durationMs = 10_000, receipt: result = {}, ...options } = {}) {
  result.initialStdin = "open pipe";
  const socket = join(directory, "stdin-eof.sock");
  await withFmServer(directory, socket, signal, result, async ({ child }) => {
    result.before = result.readyHealth;
    result.pipeOpenAfterReady = child.stdin.writable && !child.stdin.destroyed;
    child.stdin.on("error", error => {
      result.stdinError = { code: error.code ?? null, message: error.message };
    });
    const finished = once(child.stdin, "finish", { signal });
    child.stdin.end();
    await finished;
    result.stdinCloseEvent = "finish";
    await observeServing(socket, child.pid, signal, durationMs, result);
  }, { ...options, stdin: "pipe" });
  return result;
}

/** Kill and reap only the direct parent, then measure the orphan over the full interval before group teardown. */
export async function parentDeathProbe(directory, signal,
  { program = "/usr/bin/fm", inspectTcp = inspectTcpListeners, durationMs = 10_000, receipt: result = {} } = {}) {
  if (program === "/usr/bin/fm") requireLiveProbe();
  signal.throwIfAborted();
  const env = { HOME: process.env.HOME, LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" };
  const socket = join(directory, "orphan.sock");
  // The parent and fm share our owned process group, so teardown still works after killing just the parent.
  // Do not forward variables the parent runtime synthesized after exec (for example CoreFoundation's encoding key).
  const parentSource = `
    const {spawn}=require("node:child_process");
    const env={HOME:process.env.HOME,LANG:process.env.LANG,PATH:process.env.PATH};
    const args=["serve","--socket",process.argv[2]];
    const child=spawn(process.argv[1],args,{stdio:"ignore",env});
    child.once("spawn",()=>console.log(JSON.stringify({
      pid:child.pid,program:process.argv[1],args,environmentKeys:Object.keys(env)
    })));
    setInterval(()=>{},1000);
  `;
  let owned;
  try {
    await withOwnedProcess(process.execPath, ["-e", parentSource, program, socket], { env, cwd: directory }, async handle => {
      owned = handle;
      const { child, closed } = handle;
      result.parentPid = child.pid;
      const [bytes] = await Promise.race([
        once(child.stdout, "data", { signal }),
        closed.then(() => { throw new Error("probe parent exited before reporting its fm child"); }),
      ]);
      result.spawnManifest = JSON.parse(bytes.toString());
      result.fmPid = result.spawnManifest.pid;
      handle.trackPid(result.fmPid);
      result.serverInvocation = {
        program: result.spawnManifest.program, args: result.spawnManifest.args,
        environmentKeys: result.spawnManifest.environmentKeys,
        LANG: env.LANG, PATH: env.PATH, stdin: "closed (/dev/null)",
      };
      result.before = describeResponse(await waitForHealth(socket, child, signal));
      result.tcpListeners = await verifyNoTcp(result.fmPid, env, inspectTcp);
      child.kill("SIGKILL");
      result.parentExit = await closed;
      await observeServing(socket, result.fmPid, signal, durationMs, result);
    });
  } finally {
    if (owned) result.cleanup = owned.cleanup;
  }
  return result;
}
