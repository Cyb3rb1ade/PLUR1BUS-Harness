/** Offline checks for AF0 receipts and process ownership; never starts Apple's CLI. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  captureProcess, describeResponse, latencySummary, requireLiveProbe, socketRequest, withOwnedProcess,
  systemAvailability,
  observeResponse,
} from "../spikes/apple-fm-probe-lib.mjs";
import { renderReceipt, runProtocol, waitForSocket } from "../spikes/apple-fm-probe.mjs";

test("the system check accepts the available line with exit 1 outside Terminal", () => {
  const available = systemAvailability({
    code: 1, signal: null,
    stdout: "  Apple Foundation Models\n  ✓ system (AFM 3 Core Advanced)\n  ✗ pcc (unavailable)\n",
  });
  assert.equal(available.state, "available");
  assert.equal(available.exitCode, 1);
});

test("the system check refuses a cross or unreadable output even when the command exits zero", () => {
  for (const [stdout, state] of [
    ["✗ system (disabled)\n✓ pcc", "unavailable"],
    ["✓ pcc", "unknown"],
    ["system: available", "unknown"],
    ["✓ system (ready)\n✗ system (disabled)", "unknown"],
  ]) {
    assert.equal(systemAvailability({ code: 0, stdout, signal: null }).state, state);
  }
});

test("the live probe requires explicit opt-in and refuses CI even with opt-in", () => {
  assert.throws(() => requireLiveProbe({}), /PLUR1BUS_APPLE_FM_LIVE/);
  assert.throws(() => requireLiveProbe({ PLUR1BUS_APPLE_FM_LIVE: "0" }), /PLUR1BUS_APPLE_FM_LIVE/);
  assert.throws(() => requireLiveProbe({ PLUR1BUS_APPLE_FM_LIVE: "1", CI: "true" }), /CI/);
  assert.throws(() => requireLiveProbe({ PLUR1BUS_APPLE_FM_LIVE: "1", GITHUB_ACTIONS: "true" }), /CI/);
  assert.equal(requireLiveProbe({ PLUR1BUS_APPLE_FM_LIVE: "1" }), undefined);
});

test("invoking the real probe CLI without opt-in refuses before starting fm", () => {
  const result = spawnSync(process.execPath, [new URL("../spikes/apple-fm-probe.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PLUR1BUS_APPLE_FM_LIVE/);
});

test("an SSE response to stream false retains usage, finish reason and the DONE observation", () => {
  const body = [
    ": heartbeat",
    'data: {"choices":[{"delta":{"content":"synthetic"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop","logprobs":null}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
    "data: [DONE]",
    "",
  ].join("\r\n\r\n");
  const result = describeResponse({ status: 200, contentType: "text/event-stream; charset=utf-8", body });
  assert.equal(result.format, "sse");
  assert.equal(result.done, true);
  assert.deepEqual(result.finishReasons, ["stop"]);
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  assert.equal(result.logprobsPresent, false);
  assert.equal(result.eventCount, 3);
});

test("a stream without DONE or usage records absence rather than a successful terminator", () => {
  const result = describeResponse({ status: 200, contentType: "text/event-stream", body:
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' });
  assert.equal(result.done, false);
  assert.equal(result.usage, null);
  assert.deepEqual(result.finishReasons, ["tool_calls"]);
});

test("JSON errors preserve the exact server shape and non-null log probabilities are detected", () => {
  const error = { error: { message: "synthetic overflow", type: "invalid_request_error", code: "context_length" } };
  const result = describeResponse({ status: 400, contentType: "application/json", body: JSON.stringify(error) });
  assert.deepEqual(result.error, error.error);
  assert.equal(result.status, 400);
  const probabilities = describeResponse({ status: 200, contentType: "application/json", body:
    '{"choices":[{"finish_reason":"stop","logprobs":{"content":[{"token":"a","logprob":-0.2}]}}]}' });
  assert.equal(probabilities.logprobsPresent, true);
});

test("an unknown server error format is preserved as evidence without claiming a JSON error shape", () => {
  const result = observeResponse({ status: 400, contentType: "text/plain", body: "synthetic unknown model" });
  assert.equal(result.status, 400);
  assert.equal(result.format, "unparsed");
  assert.equal(result.rawBody, "synthetic unknown model");
  assert.equal(result.error, null);
  assert.match(result.analysisError, /content type/);
});

test("malformed or HTML responses fail analysis instead of looking like an empty successful completion", () => {
  assert.throws(() => describeResponse({ status: 200, contentType: "text/event-stream", body: "data: {bad}\n\n" }));
  assert.throws(() => describeResponse({ status: 200, contentType: "text/html", body: "<h1>broken</h1>" }));
});

test("latency receipts separate the first call and use nearest-rank warm p95", () => {
  const result = latencySummary([9000, 80, 20, 60, 40]);
  assert.deepEqual(result, { firstInferenceMs: 9000, warm: { n: 4, p50: 40, p95: 80 } });
  assert.deepEqual(latencySummary([500]), { firstInferenceMs: 500, warm: { n: 0, p50: null, p95: null } });
  assert.throws(() => latencySummary([NaN]), /latency/);
});

test("process ownership reaps a child after the callback throws", { timeout: 10_000 }, async () => {
  let child;
  await assert.rejects(withOwnedProcess(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    { env: {} }, async handle => {
      child = handle.child;
      await once(child.stdout, "data");
      throw new Error("synthetic callback failure");
    }), /synthetic callback failure/);
  assert.ok(child?.pid);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("process ownership escalates when the child ignores TERM and waits for its exit", { timeout: 10_000 }, async () => {
  let child;
  await withOwnedProcess(process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
    { env: {}, graceMs: 20 }, async handle => {
      child = handle.child;
      await once(child.stdout, "data");
    });
  assert.equal(child.signalCode, "SIGKILL");
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("owned process logs include bytes written during graceful shutdown", async () => {
  let handle;
  await withOwnedProcess(process.execPath, ["-e",
    "process.on('SIGTERM',()=>{process.stderr.write('shutdown evidence');process.exit(0)});" +
      "process.stdout.write('ready');setInterval(()=>{},1000)"], { env: {} }, async owned => {
    handle = owned;
    await once(owned.child.stdout, "data");
  });
  assert.equal(handle.logs.stderr, "shutdown evidence");
});

test("socket readiness observes an absolute Unix socket from a real child before teardown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af0-ready-"));
  const socket = join(directory, "fm.sock");
  try {
    await withOwnedProcess(process.execPath, ["-e",
      "require('node:net').createServer().listen(process.argv[1])", socket], { env: {} }, async ({ child }) => {
      await waitForSocket(socket, child, AbortSignal.timeout(5000));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a hung CLI probe is bounded and its child has been reaped before returning", { timeout: 10_000 }, async () => {
  await assert.rejects(captureProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    env: {}, timeoutMs: 20,
  }), /timeout/);
});

test("CLI capture retains a nonzero exit even when stdout looks successful", async () => {
  const result = await captureProcess(process.execPath, ["-e", "console.log('available');process.exitCode=1"], { env: {} });
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "available\n");
});

test("a preflight stop receipt never claims the server or protocol measurements ran", () => {
  const rendered = renderReceipt({
    status: "blocked", observations: [], notMeasured: [], cleanup: { temporaryDirectoryRemoved: true },
    failure: { stage: "preflight", message: "synthetic stop" },
  });
  assert.match(rendered, /No `fm serve` process was started/);
  assert.doesNotMatch(rendered, /The server was invoked/);
});

async function withSocketServer(handler, use) {
  const directory = await mkdtemp(join(tmpdir(), "af0-test-"));
  const socket = join(directory, "fm.sock");
  const server = createServer(handler);
  try {
    server.listen(socket);
    await once(server, "listening");
    await use(socket);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("the probe uses its Unix socket and does not follow a redirect to TCP", async () => {
  let requests = 0;
  await withSocketServer((_request, response) => {
    requests++;
    response.writeHead(302, { location: "http://127.0.0.1:1/forbidden", "content-type": "application/json" });
    response.end('{"error":{"message":"synthetic redirect"}}');
  }, async socket => {
    const response = await socketRequest(socket, { method: "GET", path: "/health" });
    assert.equal(response.status, 302);
    assert.equal(requests, 1);
    assert.equal(describeResponse(response).error.message, "synthetic redirect");
  });
});

test("the probe refuses oversized responses and request surfaces outside the three AF0 endpoints", async () => {
  let requests = 0;
  await withSocketServer((_request, response) => {
    requests++;
    response.end("x".repeat(256));
  }, async socket => {
    await assert.rejects(socketRequest(socket, { method: "GET", path: "/health", maxBytes: 128 }), /response.*limit/);
    await assert.rejects(socketRequest(socket, { method: "GET", path: "/outside" }), /surface/);
    await assert.rejects(socketRequest(socket, { method: "DELETE", path: "/health" }), /surface/);
    assert.equal(requests, 1);
  });
});

test("an aborted probe request closes the connection rather than leaving a hung request", async () => {
  await withSocketServer(() => {}, async socket => {
    const controller = new AbortController();
    const pending = socketRequest(socket, { method: "GET", path: "/health", signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  });
});

test("the protocol probe records synthetic local calls, errors and usage without invoking PCC", async () => {
  const models = new Set();
  await withSocketServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/health"
        ? { status: "ok", models: { system: { available: true }, pcc: { available: false } } }
        : { data: [{ id: "system" }, { id: "pcc" }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    models.add(body.model);
    if (body.model !== "system" || body.messages[0].content.length > 20_000) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":{"message":"synthetic request error","code":"invalid_request"}}');
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"{\\"category\\":\\"reminder\\"}"},"finish_reason":"stop"}],"usage":{"total_tokens":20}}\n\ndata: [DONE]\n\n');
  }, async socket => {
    const observations = [];
    const summary = await runProtocol(socket, row => observations.push(row), { warmSamples: 2 });
    assert.deepEqual([...models].sort(), ["af0-model-does-not-exist", "system"]);
    assert.equal(observations.find(row => row.id === "stream-false").response.format, "sse");
    assert.equal(observations.find(row => row.id === "unknown-model").response.status, 400);
    assert.equal(observations.find(row => row.id === "overflow").response.error.code, "invalid_request");
    assert.equal(observations.find(row => row.id === "usage").response.usage.total_tokens, 20);
    assert.ok(observations.some(row => row.id === "forced-tool"));
    assert.ok(observations.some(row => row.id === "parallel-tools"));
    assert.ok(observations.some(row => row.id === "logprobs"));
    assert.equal(summary.latency.warm.n, 2);
    assert.equal(summary.concurrency.results.length, 2);
  });
});
