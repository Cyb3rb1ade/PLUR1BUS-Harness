#!/usr/bin/env node
/** Manual AF0 measurements using synthetic prompts and a private Unix socket, never a TCP listener. */
import { watch } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as measurementInterval } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isMainModule } from "../check-toolchain.mjs";
import {
  captureProcess, describeResponse, latencySummary, requireLiveProbe, socketRequest, withOwnedProcess,
  systemAvailability,
  observeResponse,
} from "./apple-fm-probe-lib.mjs";

const MARKER = "AF0_SYNTHETIC_MARKER";
const PROMPT = `${MARKER}. Reply only OK.`;
/** Synthetic input deliberately larger than the proposed 4096-token window. */
export const OVERFLOW_PROMPT = "synthetic ".repeat(5000);

/** Measure the documented wire features, retaining exact response and error shapes. */
export async function runProtocol(socket, record, { signal, warmSamples = 12 } = {}) {
  const get = async (id, path) => {
    const raw = await socketRequest(socket, { method: "GET", path, signal });
    const response = observeResponse(raw);
    await record({ id, elapsedMs: raw.elapsedMs, response });
    return response;
  };
  await get("health", "/health");
  await get("models", "/v1/models");

  const chat = async (id, extra = {}, { mustWork = false } = {}) => {
    const body = { model: "system", messages: [{ role: "user", content: PROMPT }], max_tokens: 32, ...extra };
    const raw = await socketRequest(socket, { method: "POST", path: "/v1/chat/completions", body, signal });
    const response = observeResponse(raw);
    const request = { ...body, messages: body.messages.map(message => ({
      role: message.role, utf16Units: message.content.length,
    })) };
    await record({ id, request, elapsedMs: raw.elapsedMs, response });
    if (mustWork && (raw.status !== 200 || response.error || response.analysisError)) {
      throw new Error(`spec-contradiction: previously demonstrated ${id} failed; stop before AF1`);
    }
    return { elapsedMs: raw.elapsedMs, response };
  };
  const first = await chat("stream-omitted", {}, { mustWork: true });
  await chat("stream-false", { stream: false }, { mustWork: true });
  await chat("usage", { stream: true, stream_options: { include_usage: true } });
  await chat("usage-disabled", { stream: true, stream_options: { include_usage: false } });
  await chat("completion-token-field", { max_tokens: undefined, max_completion_tokens: 32 });
  const latencies = [first.elapsedMs];
  for (let index = 0; index < warmSamples; index++) {
    const result = await chat(`latency-${index + 1}`, { stream: false }, { mustWork: true });
    latencies.push(result.elapsedMs);
  }
  const parallelStarted = performance.now();
  const concurrent = await Promise.all([chat("concurrency-1"), chat("concurrency-2")]);
  const concurrency = {
    elapsedMs: performance.now() - parallelStarted,
    results: concurrent.map(result => ({ elapsedMs: result.elapsedMs, status: result.response.status })),
    interpretation: "Two overlapping requests; elapsed times alone do not prove parallel model execution.",
  };
  await chat("json-schema", {
    messages: [{ role: "user", content: "Classify: remind me tomorrow. Return category reminder or other." }],
    response_format: { type: "json_schema", json_schema: {
      name: "af0_classification", strict: true, schema: {
        type: "object", properties: { category: { type: "string", enum: ["reminder", "other"] } },
        required: ["category"], additionalProperties: false,
      },
    } },
  }, { mustWork: true });
  const tools = [{ type: "function", function: {
    name: "af0_weather", description: "Get the synthetic weather for a city.", parameters: {
      type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false,
    },
  } }];
  const toolMessages = [{ role: "user", content: "Use af0_weather to get the weather in Berlin." }];
  await chat("tools", { tools, messages: toolMessages }, { mustWork: true });
  await chat("forced-tool", {
    tools, messages: toolMessages, tool_choice: { type: "function", function: { name: "af0_weather" } },
  });
  await chat("parallel-tools", {
    tools, parallel_tool_calls: true,
    messages: [{ role: "user", content: "Use af0_weather for Berlin and Warsaw." }],
  });
  await chat("logprobs", { logprobs: true, top_logprobs: 2 });
  await chat("unknown-model", { model: "af0-model-does-not-exist" });
  await chat("overflow", { messages: [{ role: "user", content: OVERFLOW_PROMPT }], max_tokens: 8 });
  return { latency: latencySummary(latencies), concurrency };
}

function waitForSocket(socket, child, signal) {
  return new Promise((resolveReady, reject) => {
    const watcher = watch(dirname(socket), () => { void inspect(); });
    const finish = error => {
      watcher.close();
      clearTimeout(timer);
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolveReady();
      }
    };
    const onExit = (code, childSignal) => finish(new Error(`fm exited before socket readiness: ${code}/${childSignal}`));
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("fm socket readiness timeout")), 10_000);
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
    async function inspect() {
      try {
        const info = await lstat(socket);
        if (!info.isSocket()) {
          finish(new Error("fm socket path is not a socket"));
        } else {
          finish();
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          finish(error);
        }
      }
    }
    if (signal.aborted) {
      onAbort();
    } else if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    } else {
      void inspect();
    }
  });
}

async function withFmServer(directory, socket, signal, receipt, use) {
  const env = { HOME: process.env.HOME, LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" };
  let owned;
  try {
    return await withOwnedProcess("/usr/bin/fm", ["serve", "--socket", socket], { env, cwd: directory }, async handle => {
      owned = handle;
      receipt.serverInvocation = {
        program: "/usr/bin/fm", args: ["serve", "--socket", socket],
        environmentKeys: Object.keys(env), LANG: env.LANG, PATH: env.PATH, stdin: "closed (/dev/null)",
      };
      let stdout = "";
      let stderr = "";
      handle.child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-65_536); });
      handle.child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-65_536); });
      try {
        await waitForSocket(resolve(directory, socket), handle.child, signal);
        return await use(handle);
      } finally {
        receipt.serverLogs = {
          stdout, stderr, capturedTailCharacters: 65_536,
          syntheticPromptMarkerPresent: stdout.includes(MARKER) || stderr.includes(MARKER),
        };
        receipt.serverPid = handle.child.pid;
      }
    });
  } finally {
    if (owned) {
      receipt.serverExit = await owned.closed;
      receipt.cleanup = { directServerReaped: true };
    }
  }
}

async function socketEdgeProbes(directory, signal, env) {
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
        { env }, async ({ child }) => { await once(child.stdout, "data"); });
        row.staleSocketCreated = (await lstat(absoluteSocket)).isSocket();
      }
      await withFmServer(working, passedSocket, signal, row, async () => {
        row.health = describeResponse(await socketRequest(absoluteSocket, { method: "GET", path: "/health", signal }));
      });
    } catch (error) {
      row.failure = { code: error.code ?? null, message: error.message };
    }
    signal.throwIfAborted();
  }
  return results;
}

async function parentDeathProbe(directory, signal, env) {
  const socket = join(directory, "orphan.sock");
  // The parent and fm share our owned process group, so teardown still works after killing just the parent.
  const parentSource = "const {spawn}=require('node:child_process');" +
    "const child=spawn('/usr/bin/fm',['serve','--socket',process.argv[1]],{stdio:'ignore',env:process.env});" +
    "child.once('spawn',()=>process.stdout.write(String(child.pid)+'\\n'));setInterval(()=>{},1000);";
  const result = {};
  await withOwnedProcess(process.execPath, ["-e", parentSource, socket], { env }, async ({ child, closed }) => {
    const [bytes] = await once(child.stdout, "data");
    result.fmPid = Number(bytes.toString().trim());
    await waitForSocket(socket, child, signal);
    result.before = describeResponse(await socketRequest(socket, { method: "GET", path: "/health", signal }));
    child.kill("SIGKILL");
    result.parentExit = await closed;
    try {
      result.after = describeResponse(await socketRequest(socket, { method: "GET", path: "/health", signal }));
      result.observed = "answered health after the direct parent was killed and reaped";
    } catch (error) {
      result.after = { code: error.code ?? null, message: error.message };
      result.observed = "did not answer the one post-parent-exit health request";
    }
  });
  result.cleanup = "Remaining members of the probe-owned process group received SIGKILL.";
  return result;
}

async function countTokens(text, env) {
  const result = await captureProcess("/usr/bin/fm", ["count-tokens", "--quiet", text], { env });
  const tokens = /^\d+\s*$/.test(result.stdout) ? Number(result.stdout.trim()) : null;
  return { utf16Units: text.length, tokens, heuristicBound: Math.ceil(text.length / 3), ...result };
}

/** Render only measurements that actually ran, including stops before server startup. */
export function renderReceipt(receipt) {
  const lines = ["# AF0 Apple Foundation Models live probe", "", `Status: **${receipt.status}**.`, "",
    "Input policy: synthetic inputs and model `system`; the unknown-model test uses an invented identifier.",
    receipt.serverPid
      ? "The server was invoked with `serve --socket` in an owned 0700 temporary directory."
      : "No `fm serve` process was started; no protocol measurements were made.",
    "The probe never runs licence commands or changes Apple Intelligence settings.", "",
    receipt.priorReceipt
      ? `Evidence: [this run](./${receipt.receiptFile}) and the unchanged [stopped run](./2026-11-01-probe.md) ` +
        "([original JSON](./2026-11-01-probe.json)). The controller corrected its exit-code interpretation."
      : "",
    `Platform: macOS ${receipt.host?.version ?? "unknown"}, build ${receipt.host?.build ?? "unknown"}; ${process.arch}.`,
    `Node: ${process.version}. Source base: ${receipt.sourceHead ?? "unknown"}.`, "",
    "| Observation | HTTP | Format | DONE | Usage | Log probabilities | ms |",
    "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of receipt.observations) {
    lines.push(`| ${row.id} | ${row.response.status} | ${row.response.format} | ${row.response.done} | ` +
      `${row.response.usage !== null} | ${row.response.logprobsPresent} | ${row.elapsedMs.toFixed(1)} |`);
  }
  lines.push("", "Exact response events, error objects, CLI output and measurement limits are in the adjacent JSON.");
  if (receipt.failure) {
    lines.push("", `Stopped at **${receipt.failure.stage}**: ${receipt.failure.message}`);
  }
  if (receipt.summary) {
    lines.push("", `First inference: ${receipt.summary.latency.firstInferenceMs.toFixed(1)} ms; warm p95: ` +
      `${receipt.summary.latency.warm.p95.toFixed(1)} ms (${receipt.summary.latency.warm.n} observations).`,
    "This first request is not evidence of a cold OS cache or an unloaded system model.");
  }
  lines.push("", "Remaining measurements:", "", ...receipt.notMeasured.map(value => `- ${value}`), "",
    `Cleanup: ${JSON.stringify(receipt.cleanup)}.`, "");
  return lines.join("\n");
}

/** Collect live evidence on the owner's Mac; retain partial receipts on a stop. */
export async function runLiveProbe(output) {
  requireLiveProbe();
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("AF0 requires the owner's Apple Silicon Mac");
  }
  const info = await lstat("/usr/bin/fm");
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw new Error("AF0 refuses an untrusted /usr/bin/fm");
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, "{}\n", { flag: "wx" });
  const directory = await mkdtemp(join(tmpdir(), "af0-"));
  const socket = join(directory, "fm.sock");
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(240_000)]);
  const onSignal = () => controller.abort(new Error("probe interrupted"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const receipt = {
    schema: "plur1bus.apple-fm-probe/1", measuredAt: new Date().toISOString(), status: "running", observations: [],
    receiptFile: output.split(/[\\/]/).at(-1), priorReceipt: "2026-11-01-probe.json",
    notMeasured: [
      "Model-unavailable error: Apple Intelligence is available; its settings are not changed for a probe.",
      "Licence-unagreed state: no licence command is run and the accepted licence is not altered.",
      "Exact 4096-token boundary: overflow supplies a lower bound, not an exact window proof.",
      "Delayed idle unloading and system model-service RSS; ps measures the CLI process only.",
    ],
  };
  let stage = "preflight";
  const env = { HOME: process.env.HOME, LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" };
  const checkpoint = async () => {
    const json = JSON.stringify(receipt, null, 2).replaceAll(directory, "<probe-directory>");
    await writeFile(output, `${json}\n`);
  };
  try {
    await chmod(directory, 0o700);
    if (Buffer.byteLength(socket) > 103) {
      throw new Error("AF0 socket path exceeds 103 bytes; choose a shorter TMPDIR");
    }
    const version = await captureProcess("/usr/bin/sw_vers", ["-productVersion"], { env });
    const build = await captureProcess("/usr/bin/sw_vers", ["-buildVersion"], { env });
    receipt.host = { version: version.stdout.trim(), build: build.stdout.trim() };
    if (Number(receipt.host.version.split(".")[0]) < 27) {
      throw new Error("AF0 requires macOS 27 or newer");
    }
    receipt.sourceHead = (await captureProcess("/usr/bin/git", ["rev-parse", "HEAD"], { env })).stdout.trim();
    receipt.cliInvocation = {
      program: "/usr/bin/fm", args: ["models"], stdin: "closed", cwd: "isolated worktree",
      environment: { HOME: "<owner-home>", LANG: env.LANG, PATH: env.PATH }, nodeVersion: process.version,
      context: {
        executor: "Codex desktop command tool, outside the Terminal app",
        stdinIsTTY: !!process.stdin.isTTY, stdoutIsTTY: !!process.stdout.isTTY, stderrIsTTY: !!process.stderr.isTTY,
      },
    };
    receipt.cliModels = await captureProcess("/usr/bin/fm", ["models"], { env });
    receipt.systemAvailability = systemAvailability(receipt.cliModels);
    if (receipt.systemAvailability.state !== "available") {
      throw new Error(`fm models system line is ${receipt.systemAvailability.state}; stop before serving`);
    }
    stage = "token-counts";
    receipt.tokenCounts = {};
    for (const [locale, text] of Object.entries({
      de: "Synthetischer Test: Erinnere mich morgen um neun Uhr an den Termin in Berlin.",
      en: "Synthetic test: remind me tomorrow at nine about the appointment in Berlin.",
      overflow: OVERFLOW_PROMPT,
    })) {
      receipt.tokenCounts[locale] = await countTokens(text, env);
    }
    stage = "serve-and-protocol";
    const started = performance.now();
    await withFmServer(directory, socket, signal, receipt, async ({ child }) => {
      receipt.socketReadyMs = performance.now() - started;
      const socketInfo = await lstat(socket);
      receipt.socketMode = (socketInfo.mode & 0o777).toString(8);
      receipt.directoryMode = ((await lstat(directory)).mode & 0o777).toString(8);
      if (receipt.socketMode !== "755") {
        throw new Error(`spec-contradiction: socket mode ${receipt.socketMode}, expected F8's 755`);
      }
      receipt.idleCliRss = await captureProcess("/bin/ps", ["-p", String(child.pid), "-o", "rss="], { env });
      receipt.tcpListeners = await captureProcess("/usr/sbin/lsof",
        ["-nP", "-a", "-p", String(child.pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"], { env });
      if (receipt.tcpListeners.stdout.trim()) {
        throw new Error("spec-contradiction: fm serve --socket owns a TCP listener");
      }
      receipt.summary = await runProtocol(socket, async row => {
        receipt.observations.push(row);
        console.error(`AF0: ${row.id} HTTP ${row.response.status} (${row.elapsedMs.toFixed(1)} ms)`);
        await checkpoint();
      }, { signal });
      receipt.idleAfterInference = [];
      const idleStarted = performance.now();
      for (const atMs of [0, 30_000]) {
        // A measured idle interval, not a readiness barrier or a claim that model services unload.
        await measurementInterval(Math.max(0, atMs - (performance.now() - idleStarted)), undefined, { signal });
        const rss = await captureProcess("/bin/ps", ["-p", String(child.pid), "-o", "rss="], { env });
        receipt.idleAfterInference.push({ elapsedMs: performance.now() - idleStarted, unit: "KiB (CLI only)", ...rss });
      }
    });
    receipt.cleanup = { directServerReaped: true };
    stage = "unavailable-transport";
    try {
      await socketRequest(socket, { method: "GET", path: "/health", signal });
      throw new Error("server still answers after process-group cleanup");
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) {
        throw error;
      }
      receipt.unavailableTransport = { code: error.code, serverErrorShape: null };
    }
    receipt.stdinEof = { initialStdin: "closed (/dev/null)", continuedServing: true };
    stage = "socket-edge-cases";
    receipt.socketEdges = await socketEdgeProbes(directory, signal, env);
    stage = "parent-death";
    receipt.parentDeath = await parentDeathProbe(directory, signal, env);
    receipt.status = "observed";
  } catch (error) {
    receipt.status = "blocked";
    receipt.failure = { stage, name: error.name, message: error.message };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await rm(directory, { recursive: true, force: true });
    receipt.cleanup = { ...receipt.cleanup, temporaryDirectoryRemoved: true };
    await checkpoint();
    await writeFile(output.replace(/\.json$/, ".md"), renderReceipt(receipt));
  }
  return receipt;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try {
    requireLiveProbe();
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--out" || !args[1].endsWith(".json")) {
      throw new Error("usage: PLUR1BUS_APPLE_FM_LIVE=1 node scripts/spikes/apple-fm-probe.mjs --out FILE.json");
    }
    const receipt = await runLiveProbe(resolve(args[1]));
    console.error(`AF0: ${receipt.status}; receipt ${args[1]}`);
    process.exitCode = receipt.status === "blocked" ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
