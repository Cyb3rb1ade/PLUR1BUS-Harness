/** D122 review: real Unix adapter failures must preserve the router's health and retry policy. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatCompletionsAdapter, createLocalChatAdapter, ProviderError } from "../../src/index.ts";
import { ProviderRouter } from "../../src/router/router.ts";
import { classifyFailure } from "../../src/router/classify.ts";
import { FakeClock, cand, collector } from "../router/helpers.ts";
import { startFakeFmServe } from "../fixtures/fake-fm-serve.ts";
import type { FakeFmOptions, FakeFmServe } from "../fixtures/fake-fm-serve.ts";

const POSIX = { timeout: 15_000, skip: process.platform === "win32" && "D122: native Unix sockets require POSIX" };
const REQUEST = { model: "system", messages: [{ role: "user" as const, content: "synthetic request" }] };

function setup(fm: FakeFmServe) {
  const local = createLocalChatAdapter({
    state: "ok", baseUrl: "http://apple-fm.invalid/v1", socket: "managed:apple-fm",
  }, createChatCompletionsAdapter, undefined, { unix: { socket: fm.socket, guard: { verify: () => ({ ok: true }) } } });
  const { events, sink } = collector();
  const apple = { provider: "apple-fm", model: "system", adapter: local };
  const router = new ProviderRouter({
    profiles: { only: [apple], fallback: [apple, cand("fallback", "synthetic", [{ text: "fallback" }])] },
    clock: new FakeClock(), onEvent: sink,
  });
  return { local, router, events };
}

test("busy permits fallback without retrying or penalizing provider health", () => {
  assert.deepEqual(classifyFailure(new ProviderError("network", "busy", { code: "busy", retryable: false })), {
    kind: "network", retryable: false, fallback: true, breaker: false,
  });
});

test("a burst of busy refusals and cancellation leaves the real Apple adapter's breaker closed", POSIX, async () => {
  const options: FakeFmOptions = { mode: "hang-headers" };
  const fm = await startFakeFmServe(options);
  const controller = new AbortController();
  let cancelled: Promise<void> | undefined;
  try {
    const { router, events } = setup(fm);
    cancelled = assert.rejects(router.complete("only", REQUEST, { signal: controller.signal }),
      (error: unknown) => error instanceof ProviderError && error.kind === "aborted");
    await fm.waitForRequests(1);
    await Promise.all(Array.from({ length: 3 }, () => assert.rejects(router.complete("only", REQUEST),
      (error: unknown) => error instanceof ProviderError && error.code === "busy")));
    assert.equal(router.breakerState("apple-fm", "system"), "closed");
    assert.equal((await router.complete("fallback", REQUEST)).served.provider, "fallback");
    controller.abort();
    await cancelled;
    options.mode = "text";
    assert.equal((await router.complete("only", REQUEST)).result.text, "Hallo");
    assert.equal(router.breakerState("apple-fm", "system"), "closed");
    assert.equal(events.some(event => event.type === "provider.breaker" && event.to === "open"), false);
    assert.equal(fm.requests.length, 2);
  } finally {
    controller.abort();
    await cancelled;
    await fm.close();
  }
});

for (const variant of ["json-500", "sse-500", "sse-200"] as const) {
  test(`normalized transcript overflow in ${variant} sends one request and keeps the breaker closed`, POSIX, async () => {
    const error = {
      type: "server_error", code: "500", message: "THE SESSION'S TRANSCRIPT EXCEEDED THE MODEL'S CONTEXT SIZE",
    };
    const fm = await startFakeFmServe({ handler: (_request, response) => {
      const sse = variant !== "json-500";
      response.writeHead(variant === "sse-200" ? 200 : 500, {
        "content-type": sse ? "text/event-stream" : "application/json",
      });
      if (sse) {
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`);
        response.end(`data: ${JSON.stringify({ error })}\n\n`);
      } else response.end(JSON.stringify({ error }));
    } });
    try {
      const { router, events } = setup(fm);
      await assert.rejects(router.complete("only", REQUEST), (error: unknown) => error instanceof ProviderError
        && error.kind === "invalid_request" && error.code === "context_overflow" && !error.retryable);
      assert.equal(fm.requests.length, 1);
      assert.equal(router.breakerState("apple-fm", "system"), "closed");
      assert.equal(events.some(event => event.type === "provider.retry" || event.type === "provider.breaker"), false);
    } finally {
      await fm.close();
    }
  });
}
