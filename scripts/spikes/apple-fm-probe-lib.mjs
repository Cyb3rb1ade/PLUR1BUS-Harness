/** Bounded AF0 I/O, receipt analysis and process ownership. Importing this module has no side effects. */
import { spawn } from "node:child_process";
import { request } from "node:http";

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

/** Own one process group and reap the direct child on every callback exit. */
export async function withOwnedProcess(program, args, { graceMs = 2000, ...options }, use) {
  const child = spawn(program, args, { ...options, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return await use({ child, closed });
  } finally {
    if (child.pid) {
      signalOwnedGroup(child, "SIGTERM");
      let timer;
      const finished = await Promise.race([
        closed.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), graceMs); }),
      ]);
      clearTimeout(timer);
      // Kill remaining descendants too; a reaped leader alone does not establish group teardown.
      signalOwnedGroup(child, "SIGKILL");
      if (!finished) {
        await closed;
      }
    } else {
      await closed;
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
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
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
    const req = request({
      socketPath: socket, host: "apple-fm.invalid", method, path, agent: false, signal,
      headers: bytes ? { "content-type": "application/json", "content-length": bytes.length } : {},
    });
    const connectTimer = setTimeout(() => req.destroy(new Error("socket connect timeout")), 2000);
    const totalTimer = setTimeout(() => req.destroy(new Error("request timeout")), 30_000);
    req.once("socket", peer => peer.once("connect", () => clearTimeout(connectTimer)));
    req.once("error", reject);
    req.once("close", () => {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
    });
    req.once("response", response => {
      const chunks = [];
      let size = 0;
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
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode, contentType: response.headers["content-type"] ?? "",
        body: Buffer.concat(chunks).toString("utf8"), elapsedMs: performance.now() - started,
      }));
    });
    req.end(bytes);
  });
}

/** Run a fixed probe argv with bounded output and duration; reap before returning or rejecting. */
export async function captureProcess(program, args, { timeoutMs = 5000, ...options } = {}) {
  return withOwnedProcess(program, args, options, async ({ child, closed }) => {
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
