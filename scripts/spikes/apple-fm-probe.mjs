#!/usr/bin/env node
/** Manual AF0 measurements using synthetic prompts and a private Unix socket, never a TCP listener. */
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as measurementInterval } from "node:timers/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isMainModule } from "../check-toolchain.mjs";
import {
  captureProcess, latencySummary, requireLiveProbe, socketRequest,
  systemAvailability,
  observeResponse,
  contextEvidence, installProbeSignals, reserveReceiptFiles, runtimeContext,
} from "./apple-fm-probe-lib.mjs";
import { parentDeathProbe, socketEdgeProbes, stdinEofProbe, withFmServer } from "./apple-fm-probe-server.mjs";
export { parentDeathProbe, stdinEofProbe, waitForSocket, withFmServer } from "./apple-fm-probe-server.mjs";

const MARKER = "AF0_SYNTHETIC_MARKER";
const PROMPT = `${MARKER}. Reply only OK.`;
/** A 5,000-word synthetic input accepted in the original run, not an overflow fixture. */
export const ACCEPTED_5K_PROMPT = "synthetic ".repeat(5000);

/** Measure accepted tokenizer counts and preserve the first overflow without assuming a fixed window. */
export async function measureWindow(socket, record,
  { counter, signal, acceptedObservations = [], wordCounts = [4096, 8192, 16_384, 32_768, 65_536] }) {
  const rows = [...acceptedObservations];
  let firstError = null;
  let failedContent;
  for (const words of wordCounts) {
    const content = "synthetic ".repeat(words);
    const count = await counter(content);
    const row = { id: `window-${words}`, tokenCount: count, words };
    const body = { model: "system", messages: [{ role: "user", content }], stream: false, max_completion_tokens: 8 };
    const raw = await socketRequest(socket, { method: "POST", path: "/v1/chat/completions", body, signal });
    row.response = observeResponse(raw);
    row.elapsedMs = raw.elapsedMs;
    row.request = { model: "system", stream: false, words, max_completion_tokens: 8 };
    await record(row);
    rows.push(row);
    if (raw.status !== 200 || row.response.error || row.response.analysisError) {
      firstError = row;
      failedContent = content;
      break;
    }
  }
  let streamingAttempt = null;
  if (firstError) {
    const body = {
      model: "system", messages: [{ role: "user", content: failedContent }], stream: true,
      max_completion_tokens: 8, stream_options: { include_usage: true },
    };
    streamingAttempt = { id: `${firstError.id}-stream`, tokenCount: firstError.tokenCount,
      request: { model: "system", stream: true, words: firstError.words, max_completion_tokens: 8 } };
    const started = performance.now();
    try {
      const raw = await socketRequest(socket, { method: "POST", path: "/v1/chat/completions", body, signal });
      streamingAttempt.response = observeResponse(raw);
      streamingAttempt.elapsedMs = raw.elapsedMs;
    } catch (error) {
      signal?.throwIfAborted();
      streamingAttempt.failure = { name: error.name, code: error.code ?? null, message: error.message };
      streamingAttempt.elapsedMs = performance.now() - started;
      streamingAttempt.response = error.partialResponse ? observeResponse(error.partialResponse) : {
        status: null, format: "transport-error", done: false, usage: null, error: null, events: [],
      };
    }
    rows.push(streamingAttempt);
    await record(streamingAttempt);
  }
  return {
    ...contextEvidence(rows), firstError, streamingAttempt, exactWindow: null,
  };
}

/** Measure the documented wire features, retaining exact response and error shapes. */
export async function runProtocol(socket, record, { signal, warmSamples = 12, accepted5kTokenCount } = {}) {
  const get = async (id, path) => {
    const raw = await socketRequest(socket, { method: "GET", path, signal });
    const response = observeResponse(raw);
    await record({ id, elapsedMs: raw.elapsedMs, response });
    return response;
  };
  await get("health", "/health");
  await get("models", "/v1/models");

  const chat = async (id, extra = {}, { mustWork = false, tokenCount } = {}) => {
    const body = { model: "system", messages: [{ role: "user", content: PROMPT }], max_tokens: 32, ...extra };
    const raw = await socketRequest(socket, { method: "POST", path: "/v1/chat/completions", body, signal });
    const response = observeResponse(raw);
    const request = { ...body, messages: body.messages.map(message => ({
      role: message.role, utf16Units: message.content.length,
    })) };
    await record({ id, request, ...(tokenCount === undefined ? {} : { tokenCount }), elapsedMs: raw.elapsedMs, response });
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
  const longAnswer = [{ role: "user", content: "Count from one to one hundred in English words." }];
  await chat("max-tokens-one", { messages: longAnswer, max_tokens: 1, stream: false });
  await chat("max-completion-tokens-one", {
    messages: longAnswer, max_tokens: undefined, max_completion_tokens: 1, stream: false,
  });
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
  await chat("accepted-5k", {
    messages: [{ role: "user", content: ACCEPTED_5K_PROMPT }], max_tokens: undefined, max_completion_tokens: 8,
    stream: true, stream_options: { include_usage: true },
  }, { tokenCount: accepted5kTokenCount });
  return { latency: latencySummary(latencies), concurrency };
}

async function countTokens(text, env) {
  const result = await captureProcess("/usr/bin/fm", ["count-tokens", "--quiet"], { env, input: text });
  const tokens = /^\d+\s*$/.test(result.stdout) ? Number(result.stdout.trim()) : null;
  return { utf16Units: text.length, tokens, heuristicBound: Math.ceil(text.length / 3), ...result };
}

/** State what this run did not measure; never turn an omitted phase into a successful observation. */
export function remainingMeasurements(receipt) {
  const items = [
    "Unavailable-system HTTP error and downloading/region/disabled variants were not induced by changing settings.",
    "Licence-unagreed state was not induced; no licence command runs in this collector.",
    "Exact shared context window remains unmeasured; accepted server prompt counts can refute 4096 without fixing its size.",
    "Long idle unloading, a forced unloaded-model cold start and system model-service RSS remain unmeasured.",
  ];
  if (receipt.scope === "follow-up") items.push("Full protocol, warm latency, CLI RSS and socket-edge probes were not repeated in this focused run.");
  if (!receipt.window?.streamingAttempt) items.push("Streaming overflow was not attempted in this run.");
  for (const [name, row] of [["Parent death", receipt.parentDeath], ["Post-start stdin-pipe EOF", receipt.stdinEof]]) {
    items.push(row?.observationComplete
      ? `${name}: behavior beyond the observed ${(row.observedForMs / 1000).toFixed(2)}-second interval is unmeasured.`
      : `${name}: the multi-sample observation did not complete in this run.`);
  }
  return items;
}

/** Render measured facts and optional predecessor links; no executor, stopped-run or availability story is invented. */
export function renderReceipt(receipt) {
  const lines = ["# AF0 Apple Foundation Models live probe", "", `Status: **${receipt.status}**.`, "",
    "Input policy: synthetic inputs and model `system`; any unknown-model request uses an invented identifier.",
    receipt.serverPid
      ? "The server was invoked with `serve --socket` in an owned 0700 temporary directory."
      : "No `fm serve` process was started; no protocol measurements were made.",
    "The probe never runs licence commands or changes Apple Intelligence settings.", "",
    `Platform: macOS ${receipt.host?.version ?? "unknown"}, build ${receipt.host?.build ?? "unknown"}; ${receipt.host?.arch ?? "architecture not recorded"}.`,
    `Node: ${receipt.cliInvocation?.nodeVersion ?? "not recorded"}. Collector commit: ${receipt.sourceHead ?? "unknown"}; `
      + `source tree dirty before receipt creation: ${receipt.sourceDirtyBeforeReceipt ?? "unknown"}.`,
    "Source-file SHA-256 values and measured cwd/TTY facts are in the JSON; TTY facts alone do not identify an executor.", ""];
  for (const name of receipt.priorReceipts ?? []) {
    lines.push(`Prior evidence: [${name}](./${name}) ([report](./${name.replace(/\.json$/, ".md")})).`);
  }
  lines.push("", "| Observation | HTTP | Format | DONE | Usage | Log probabilities | ms |",
    "| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of receipt.observations) {
    lines.push(`| ${row.id} | ${row.response.status ?? "no headers"} | ${row.response.format} | ${row.response.done} | `
      + `${row.response.usage != null} | ${row.response.logprobsPresent ?? false} | ${row.elapsedMs.toFixed(1)} |`);
  }
  if (receipt.window) {
    lines.push("", "## Context measurements", "",
      `Accepted server prompt tokens: at least ${receipt.window.acceptedPromptTokensAtLeast ?? "not recorded"}. `
      + `Accepted standalone CLI tokens: ${receipt.window.acceptedCliTokensAtLeast ?? "not recorded"}.`,
      `The 4,096-token shared-window proposal is **${receipt.window.proposed4096Window}**. `
      + "The 4096 catalog/guard policy remains conservative; the exact window is not inferred.");
    const attempt = receipt.window.streamingAttempt;
    if (attempt) lines.push(`Streaming attempt at ${attempt.tokenCount?.tokens ?? "unknown"} CLI tokens: `
      + `HTTP ${attempt.response.status ?? "no headers"}, ${attempt.response.format}, `
      + `error ${JSON.stringify(attempt.response.error)}, transport failure ${JSON.stringify(attempt.failure ?? null)}.`);
  }
  for (const [name, row] of [["Parent death", receipt.parentDeath], ["Post-start stdin EOF", receipt.stdinEof]]) {
    if (row) lines.push("", `## ${name}`, "",
      `${row.observations?.length ?? 0} health/PID samples over ${((row.observedForMs ?? 0) / 1000).toFixed(2)} seconds; `
      + `continuedServing=${row.continuedServing ?? "not measured"}; observationComplete=${row.observationComplete ?? false}.`,
      "Only this finite observation interval is established. Per-sample responses and PID visibility are in the JSON.");
  }
  if (receipt.failure) lines.push("", `Stopped at **${receipt.failure.stage}**: ${receipt.failure.message}`);
  if (receipt.summary) {
    const warm = receipt.summary.latency.warm;
    lines.push("", `First inference: ${receipt.summary.latency.firstInferenceMs.toFixed(1)} ms; nearest-rank warm p95: `
      + `${warm.p95?.toFixed(1) ?? "not measured"} ms (n=${warm.n}; `
      + `${warm.n > 0 && Math.ceil(0.95 * warm.n) === warm.n ? "equals the sample maximum" : "not a tail-confidence bound"}).`,
      "The short synthetic workload and first process request do not establish cold-model latency or AF5 eligibility.");
  }
  if (receipt.unavailableTransport) lines.push("", `After teardown the transport returned ${receipt.unavailableTransport.code}; `
    + "this is not a native unavailable-system-model HTTP error.");
  if (receipt.socketEdges?.stale?.health?.status === 200) lines.push("", "The stale-socket experiment started successfully: `fm` replaced the owned stale socket and answered health.");
  lines.push("", "Remaining measurements:", "", ...(receipt.notMeasured ?? []).map(value => `- ${value}`), "",
    "## Cleanup", "", `Recorded automatic cleanup evidence: ${JSON.stringify(receipt.cleanup)}.`, "",
    "SIGKILL (`kill -9`) of the collector cannot be intercepted and can leave its detached server groups and temporary tree. "
      + "HUP/INT/TERM remain intercepted through group teardown and receipt writes.", "");
  return lines.join("\n");
}

async function sourceMetadata(env, signal) {
  signal.throwIfAborted();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const head = await captureProcess("/usr/bin/git", ["rev-parse", "HEAD"], { env, cwd: root, signal });
  const dirty = await captureProcess("/usr/bin/git", ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=normal"], { env, cwd: root, signal });
  if (head.code !== 0 || dirty.code !== 0) throw new Error("cannot record collector source state");
  const sourceFiles = {};
  for (const name of ["apple-fm-probe.mjs", "apple-fm-probe-lib.mjs", "apple-fm-probe-server.mjs"]) {
    sourceFiles[name] = createHash("sha256").update(await readFile(new URL(name, import.meta.url))).digest("hex");
  }
  return { sourceHead: head.stdout.trim(), sourceDirtyBeforeReceipt: dirty.stdout.length > 0, sourceFiles };
}

function cleanupEvidence(receipt) {
  const servers = [];
  const add = (name, row, pid) => {
    if (pid) servers.push({ name, pid, ...row.cleanup });
  };
  add("main", receipt, receipt.serverPid);
  add("stdin-eof", receipt.stdinEof ?? {}, receipt.stdinEof?.serverPid);
  add("parent-death", receipt.parentDeath ?? {}, receipt.parentDeath?.fmPid);
  for (const [name, row] of Object.entries(receipt.socketEdges ?? {})) add(name, row, row.serverPid);
  return {
    servers,
    allGroupsGone: servers.length > 0 && servers.every(row => row.group?.code === "ESRCH"),
    allPidsGone: servers.length > 0 && servers.every(row => row.pids?.length > 0
      && row.pids.every(item => item.code === "ESRCH")),
  };
}

/** Collect live evidence on the owner's Mac, with an optional focused review run and explicit predecessor files. */
async function collectLiveProbe(output, { scope = "full", priorReceipts = [] } = {}, signal) {
  requireLiveProbe();
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("AF0 requires the owner's Apple Silicon Mac");
  if (!["full", "follow-up"].includes(scope)) throw new Error("AF0 scope must be full or follow-up");
  if (priorReceipts.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name))) {
    throw new Error("prior receipt must name a JSON sibling in the output directory");
  }
  const info = await lstat("/usr/bin/fm");
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("AF0 refuses an untrusted /usr/bin/fm");
  const env = { HOME: process.env.HOME, LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" };
  const source = await sourceMetadata(env, signal);
  await mkdir(dirname(output), { recursive: true });
  const writer = await reserveReceiptFiles(output);
  const receipt = {
    schema: "plur1bus.apple-fm-probe/1", measuredAt: new Date().toISOString(), status: "running", scope,
    observations: [], receiptFile: basename(output), priorReceipts, ...source, runtimeContext: runtimeContext(),
  };
  let directory;
  let stage = "preflight";
  const scrub = text => {
    if (directory) text = text.replaceAll(directory, "<probe-directory>");
    if (process.env.HOME) text = text.replaceAll(process.env.HOME, "$HOME");
    return text;
  };
  const checkpoint = () => {
    receipt.notMeasured = remainingMeasurements(receipt);
    return writer.writeJson(`${scrub(JSON.stringify(receipt, null, 2))}\n`);
  };
  const record = async row => {
    receipt.observations.push(row);
    console.error(`AF0: ${row.id} HTTP ${row.response.status ?? "no headers"} (${row.elapsedMs.toFixed(1)} ms)`);
    await checkpoint();
  };
  try {
    directory = await mkdtemp(join(tmpdir(), "af0-"));
    await chmod(directory, 0o700);
    const socket = join(directory, "fm.sock");
    if (Buffer.byteLength(socket) > 103) throw new Error("AF0 socket path exceeds 103 bytes; choose a shorter TMPDIR");
    const version = await captureProcess("/usr/bin/sw_vers", ["-productVersion"], { env });
    const build = await captureProcess("/usr/bin/sw_vers", ["-buildVersion"], { env });
    receipt.host = { version: version.stdout.trim(), build: build.stdout.trim(), arch: process.arch };
    if (Number(receipt.host.version.split(".")[0]) < 27) throw new Error("AF0 requires macOS 27 or newer");
    receipt.cliInvocation = {
      program: "/usr/bin/fm", args: ["models"], stdin: "closed", cwd: process.cwd(),
      environment: { HOME: "$HOME", LANG: env.LANG, PATH: env.PATH }, nodeVersion: process.version,
      context: runtimeContext(),
    };
    receipt.cliModels = await captureProcess("/usr/bin/fm", ["models"], { env });
    receipt.systemAvailability = systemAvailability(receipt.cliModels);
    if (receipt.systemAvailability.state !== "available") {
      throw new Error(`fm models system line is ${receipt.systemAvailability.state}; stop before serving`);
    }
    if (scope === "full") {
      stage = "token-counts";
      receipt.tokenCounts = {};
      for (const [locale, text] of Object.entries({
        de: "Synthetischer Test: Erinnere mich morgen um neun Uhr an den Termin in Berlin.",
        en: "Synthetic test: remind me tomorrow at nine about the appointment in Berlin.",
        accepted5k: ACCEPTED_5K_PROMPT,
      })) receipt.tokenCounts[locale] = await countTokens(text, env);
    }
    stage = "serve-and-window";
    const started = performance.now();
    await withFmServer(directory, socket, signal, receipt, async ({ child }) => {
      receipt.socketReadyMs = performance.now() - started;
      receipt.socketMode = ((await lstat(socket)).mode & 0o777).toString(8);
      receipt.directoryMode = ((await lstat(directory)).mode & 0o777).toString(8);
      if (receipt.socketMode !== "755") throw new Error(`spec-contradiction: socket mode ${receipt.socketMode}, expected F8's 755`);
      if (scope === "full") {
        receipt.idleCliRss = await captureProcess("/bin/ps", ["-p", String(child.pid), "-o", "rss="], { env });
        receipt.summary = await runProtocol(socket, record, { signal, accepted5kTokenCount: receipt.tokenCounts.accepted5k });
      }
      stage = "window-measurements";
      receipt.window = await measureWindow(socket, record, {
        signal, counter: text => countTokens(text, env), acceptedObservations: receipt.observations,
        ...(scope === "follow-up" ? { wordCounts: [5000, 8192, 16_384] } : {}),
      });
      if (scope === "full") {
        stage = "idle-measurements";
        receipt.idleAfterInference = [];
        const idleStarted = performance.now();
        for (const atMs of [0, 30_000]) {
          await measurementInterval(Math.max(0, atMs - (performance.now() - idleStarted)), undefined, { signal });
          const rss = await captureProcess("/bin/ps", ["-p", String(child.pid), "-o", "rss="], { env });
          receipt.idleAfterInference.push({ elapsedMs: performance.now() - idleStarted, unit: "KiB (CLI only)", ...rss });
        }
      }
    });
    if (receipt.window) Object.assign(receipt.window, contextEvidence(receipt.observations, receipt.serverLogs.stdout));
    stage = "unavailable-transport";
    try {
      await socketRequest(socket, { method: "GET", path: "/health", signal });
      throw new Error("server still answers after process-group cleanup");
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
      receipt.unavailableTransport = { code: error.code, serverErrorShape: null };
    }
    if (scope === "full") {
      stage = "socket-edge-cases";
      receipt.socketEdges = await socketEdgeProbes(directory, signal, env);
    }
    stage = "stdin-eof";
    receipt.stdinEof = {};
    await stdinEofProbe(directory, signal, { receipt: receipt.stdinEof });
    await checkpoint();
    stage = "parent-death";
    receipt.parentDeath = {};
    await parentDeathProbe(directory, signal, { receipt: receipt.parentDeath });
    receipt.status = "observed";
  } catch (error) {
    receipt.status = "blocked";
    receipt.failure = { stage, name: error.name, message: error.message };
  } finally {
    try {
      receipt.cleanup = cleanupEvidence(receipt);
      if (directory) {
        await rm(directory, { recursive: true, force: true });
        receipt.cleanup.temporaryDirectoryRemoved = true;
      }
      await checkpoint();
      await writer.writeMarkdown(scrub(renderReceipt(receipt)));
    } finally {
      await writer.close();
    }
  }
  return receipt;
}

/** Guard manual inference and retain HUP/INT/TERM interception from metadata collection through final writes. */
export async function runLiveProbe(output, options = {}) {
  requireLiveProbe();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(240_000)]);
  const dispose = installProbeSignals(controller);
  try {
    return await collectLiveProbe(output, options, signal);
  } finally {
    dispose();
  }
}

/** Parse only explicit manual probe options; predecessor names are never fixed in the collector. */
export function parseProbeArgs(args) {
  let output;
  let scope = "full";
  const priorReceipts = [];
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = args.slice(index, index + 2);
    if (value === undefined) throw new Error("AF0 option is missing its value");
    if (flag === "--out" && output === undefined) output = value;
    else if (flag === "--scope") scope = value;
    else if (flag === "--prior-receipt") priorReceipts.push(value);
    else throw new Error(`unknown or duplicate AF0 option: ${flag}`);
  }
  if (!output?.endsWith(".json")) throw new Error("usage: --out FILE.json [--scope full|follow-up] [--prior-receipt SIBLING.json]");
  return { output: resolve(output), scope, priorReceipts };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try {
    requireLiveProbe();
    const { output, ...options } = parseProbeArgs(process.argv.slice(2));
    const receipt = await runLiveProbe(output, options);
    console.error(`AF0: ${receipt.status}; receipt ${output}`);
    process.exitCode = receipt.status === "blocked" ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
