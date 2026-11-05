/** Bounded AF0 I/O, receipt analysis and process ownership. Importing this module has no side effects. */
import { spawn } from "node:child_process";
import { request } from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import { open, unlink } from "node:fs/promises";

/** Read the system model line; the context-dependent CLI exit remains an observation. */
export function systemAvailability({ stdout, code, signal }) {
  const text = stdout.replace(/\u001b\[[0-9;]*m/g, "");
  const lines = text.split(/\r?\n/).map(line => /^\s*([✓✔✗✘×])\s+system(?:\s|$)/u.exec(line))
    .filter(match => match !== null);
  const state = lines.length !== 1 ? "unknown" : ["✓", "✔"].includes(lines[0][1]) ? "available" : "unavailable";
  return { state, exitCode: code, signal };
}

/** Preserve unfamiliar error formats as measured bytes; they are AF0 unknowns, not inferred contracts. */
export function observeResponse(raw) {
  try {
    return describeResponse(raw);
  } catch (error) {
    return {
      status: raw.status, contentType: raw.contentType, format: "unparsed", done: false,
      eventCount: 0, finishReasons: [], usage: null, error: null, logprobsPresent: false, events: [],
      rawBody: raw.body, analysisError: error.message,
    };
  }
}

/** Refuse live inference without the manual opt-in, including in CI. */
export function requireLiveProbe(env = process.env) {
  if (env.CI || env.GITHUB_ACTIONS) {
    throw new Error("AF0 refuses real fm in CI");
  }
  if (env.PLUR1BUS_APPLE_FM_LIVE !== "1") {
    throw new Error("AF0 requires PLUR1BUS_APPLE_FM_LIVE=1 on the owner's Mac");
  }
}

/** Describe actual JSON or SSE bytes without inventing missing usage or probabilities. */
export function describeResponse({ status, contentType, body }) {
  const format = contentType.split(";", 1)[0].trim().toLowerCase();
  const events = [];
  let done = false;
  if (format === "text/event-stream") {
    for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
      const data = block.split("\n").filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data) {
        continue;
      }
      if (data === "[DONE]") {
        done = true;
      } else {
        events.push(JSON.parse(data));
      }
    }
  } else if (format === "application/json") {
    events.push(JSON.parse(body));
  } else {
    throw new Error(`unexpected response content type: ${format}`);
  }
  const choices = events.flatMap(event => event.choices ?? []);
  return {
    status, contentType, format: format === "text/event-stream" ? "sse" : "json", done,
    eventCount: events.length,
    finishReasons: choices.map(choice => choice.finish_reason).filter(reason => reason != null),
    usage: events.findLast(event => event.usage != null)?.usage ?? null,
    error: events.find(event => event.error != null)?.error ?? null,
    logprobsPresent: choices.some(choice => choice.logprobs != null),
    events,
  };
}

/** Keep first inference separate from the nearest-rank warm latency percentiles. */
export function latencySummary(values) {
  if (!Array.isArray(values) || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error("invalid latency sample");
  }
  const warm = values.slice(1).sort((left, right) => left - right);
  const percentile = fraction => warm[Math.ceil(warm.length * fraction) - 1] ?? null;
  return { firstInferenceMs: values[0] ?? null, warm: { n: warm.length, p50: percentile(0.5), p95: percentile(0.95) } };
}

/** Separate reported server prompt usage from standalone CLI counts; a successful request is not an overflow. */
export function contextEvidence(rows, serverLog = "") {
  const serverPromptEvidence = [];
  const cliCounts = [];
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  for (const row of rows) {
    if (row.response?.status !== 200 || row.response.error || row.response.analysisError || row.failure) continue;
    const tokens = row.response.usage?.prompt_tokens;
    if (validCount(tokens)) serverPromptEvidence.push({ source: "usage", observation: row.id, tokens });
    if (validCount(row.tokenCount?.tokens)) cliCounts.push(row.tokenCount.tokens);
  }
  const plainLog = serverLog.replace(/\u001b\[[0-9;]*m/g, "");
  for (const [index, line] of plainLog.split("\n").entries()) {
    const match = /\b200\s*·\s*system\s*·\s*(\d+)→\d+ tokens\b/u.exec(line);
    if (match) serverPromptEvidence.push({ source: "server-log", line: index + 1, tokens: Number(match[1]) });
  }
  const counts = serverPromptEvidence.map(item => item.tokens);
  const acceptedPromptTokensAtLeast = counts.length ? Math.max(...counts) : null;
  return {
    acceptedPromptTokensAtLeast,
    acceptedCliTokensAtLeast: cliCounts.length ? Math.max(...cliCounts) : null,
    serverPromptEvidence,
    proposed4096Window: acceptedPromptTokensAtLeast > 4096 ? "refuted" : "not-established",
    interpretation: "Server prompt counts and standalone CLI counts are different units. An accepted server prompt "
      + "above 4096 refutes that shared-window claim; the exact window remains unmeasured. The 4096 policy stays conservative.",
  };
}

/** Measured launcher facts; non-TTY streams do not identify an executor or prove a Terminal context. */
export function runtimeContext() {
  return {
    cwd: process.cwd(), pid: process.pid, parentPid: process.ppid,
    stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
  };
}

async function writeAtStart(handle, text) {
  const bytes = Buffer.from(text);
  await handle.truncate(0);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) throw new Error("receipt write made no progress");
    offset += bytesWritten;
  }
}

/** Reserve JSON and Markdown with wx before starting anything; checkpoints retain the owned file descriptors. */
export async function reserveReceiptFiles(output) {
  if (!output.endsWith(".json")) throw new Error("receipt path must end with .json");
  const json = await open(output, "wx", 0o600);
  let markdown;
  try {
    markdown = await open(output.replace(/\.json$/, ".md"), "wx", 0o600);
  } catch (error) {
    await json.close();
    await unlink(output);
    throw error;
  }
  let pending = Promise.resolve();
  return {
    writeJson(text) {
      pending = pending.then(() => writeAtStart(json, text));
      return pending;
    },
    writeMarkdown: text => writeAtStart(markdown, text),
    async close() {
      await Promise.all([json.close(), markdown.close()]);
    },
  };
}

/** Record actual PID visibility; ESRCH is evidence of disappearance, not an inferred cleanup success. */
export function processVisibility(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid owned process id");
  try {
    process.kill(pid, 0);
    return { pid, exists: true, code: null };
  } catch (error) {
    if (error.code === "EPERM") return { pid, exists: true, code: "EPERM" };
    if (error.code !== "ESRCH") throw error;
    return { pid, exists: false, code: "ESRCH" };
  }
}

function groupVisibility(pid) {
  if (process.platform === "win32") return processVisibility(pid);
  try {
    process.kill(-pid, 0);
    return { groupId: pid, exists: true, code: null };
  } catch (error) {
    // EPERM proves neither disappearance nor permission to signal; keep checking without claiming ESRCH.
    if (error.code === "EPERM") return { groupId: pid, exists: true, code: "EPERM" };
    if (error.code !== "ESRCH") throw error;
    return { groupId: pid, exists: false, code: "ESRCH" };
  }
}

async function waitForGroup(pid, timeoutMs) {
  const started = performance.now();
  for (;;) {
    const state = groupVisibility(pid);
    if (!state.exists || performance.now() - started >= timeoutMs) {
      return { ...state, waitedMs: performance.now() - started };
    }
    await pause(Math.min(20, Math.max(1, timeoutMs - (performance.now() - started))));
  }
}

async function boundedClose(closed, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("owned child did not close after group teardown")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keep HUP/INT/TERM intercepted throughout cleanup, including repeated signals; SIGKILL cannot be intercepted. */
export function installProbeSignals(controller, target = process) {
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map(name => {
    const handler = () => controller.abort(new Error(`probe interrupted (${name})`));
    target.on(name, handler);
    return [name, handler];
  });
  return () => {
    for (const [name, handler] of handlers) target.off(name, handler);
  };
}

/** Own and terminate a complete process group; wait for its disappearance and retain automatic PID/ESRCH evidence. */
export async function withOwnedProcess(program, args,
  { graceMs = 2000, cleanupTimeoutMs = 5000, stdin = "ignore", ...options }, use) {
  const child = spawn(program, args, { ...options, detached: process.platform !== "win32", stdio: [stdin, "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const cleanup = { directChildReaped: false, signals: [], pids: [] };
  const tracked = new Set(child.pid ? [child.pid] : []);
  const trackPid = pid => {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid owned descendant id");
    tracked.add(pid);
  };
  const logs = { stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, capturedTailCharacters: 65_536 };
  for (const stream of ["stdout", "stderr"]) {
    child[stream].on("data", chunk => {
      logs[`${stream}Bytes`] += chunk.length;
      logs[stream] = (logs[stream] + chunk.toString("utf8")).slice(-65_536);
    });
  }
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return await use({ child, closed, logs, cleanup, trackPid });
  } finally {
    if (child.pid) {
      cleanup.signals.push(signalOwnedGroup(child, "SIGTERM"));
      cleanup.group = await waitForGroup(child.pid, graceMs);
      if (cleanup.group.exists) cleanup.signals.push(signalOwnedGroup(child, "SIGKILL"));
      cleanup.exit = await boundedClose(closed, cleanupTimeoutMs);
      cleanup.directChildReaped = true;
      cleanup.group = await waitForGroup(child.pid, cleanupTimeoutMs);
      cleanup.pids = [...tracked].map(processVisibility);
      if (cleanup.group.exists || cleanup.pids.some(item => item.exists)) {
        throw new Error("owned process-group cleanup did not reach ESRCH");
      }
    } else {
      await closed;
      cleanup.directChildReaped = true;
    }
  }
}

function signalOwnedGroup(child, signal) {
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
    return { signal, code: "sent" };
  } catch (error) {
    // A group can deny a signal while its last member exits. Only the subsequent
    // visibility checks establish disappearance, including after a denied SIGKILL.
    if (error.code === "ESRCH" || (process.platform !== "win32" && error.code === "EPERM")) {
      return { signal, code: error.code };
    }
    throw error;
  }
}

/** Bounded HTTP request to a fixed local socket; never follows redirects. */
export async function socketRequest(socket, { method, path, body, signal, maxBytes = 1_048_576 }) {
  if (!["GET", "POST"].includes(method) || !["/health", "/v1/models", "/v1/chat/completions"].includes(path)) {
    throw new Error("request outside AF0 surface");
  }
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  if (bytes?.length > 1_048_576) {
    throw new Error("request body limit exceeded");
  }
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let partial;
    const failed = error => {
      if (partial) error.partialResponse = partial();
      reject(error);
    };
    const req = request({
      socketPath: socket, host: "apple-fm.invalid", method, path, agent: false, signal,
      headers: bytes ? { "content-type": "application/json", "content-length": bytes.length } : {},
    });
    const connectTimer = setTimeout(() => req.destroy(new Error("socket connect timeout")), 2000);
    const totalTimer = setTimeout(() => req.destroy(new Error("request timeout")), 30_000);
    req.once("socket", peer => peer.once("connect", () => clearTimeout(connectTimer)));
    req.once("error", failed);
    req.once("close", () => {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
    });
    req.once("response", response => {
      const chunks = [];
      let size = 0;
      partial = () => ({
        status: response.statusCode, contentType: response.headers["content-type"] ?? "",
        body: Buffer.concat(chunks).toString("utf8"), elapsedMs: performance.now() - started,
      });
      response.on("data", chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          const error = new Error("response body limit exceeded");
          reject(error);
          req.destroy(error);
        } else {
          chunks.push(chunk);
        }
      });
      response.once("error", failed);
      response.once("end", () => resolve({
        status: response.statusCode, contentType: response.headers["content-type"] ?? "",
        body: Buffer.concat(chunks).toString("utf8"), elapsedMs: performance.now() - started,
      }));
    });
    req.end(bytes);
  });
}

/** Run a fixed probe argv with bounded output and duration; reap before returning or rejecting. */
export async function captureProcess(program, args, { timeoutMs = 5000, input, ...options } = {}) {
  if (input !== undefined && (typeof input !== "string" || Buffer.byteLength(input) > 1_048_576)) {
    throw new Error("invalid CLI input or input limit exceeded");
  }
  return withOwnedProcess(program, args, { ...options, stdin: input === undefined ? "ignore" : "pipe" },
  async ({ child, closed }) => {
    let stdout = "";
    let stderr = "";
    let timer;
    const failed = new Promise((_, reject) => {
      const append = (stream, chunk) => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 65_536) {
          reject(new Error("CLI output limit exceeded"));
        } else if (stream === "stdout") {
          stdout += chunk.toString("utf8");
        } else {
          stderr += chunk.toString("utf8");
        }
      };
      child.stdout.on("data", chunk => append("stdout", chunk));
      child.stderr.on("data", chunk => append("stderr", chunk));
      if (input !== undefined) {
        child.stdin.once("error", reject);
        child.stdin.end(input);
      }
      timer = setTimeout(() => reject(new Error("CLI timeout")), timeoutMs);
    });
    try {
      const result = await Promise.race([closed, failed]);
      return { ...result, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  });
}
