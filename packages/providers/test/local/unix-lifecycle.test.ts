/** Managed inference lifetime stays bounded even when a consumer pauses or abandons its generator. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createChatCompletionsAdapter, createLocalChatAdapter, ProviderError } from "../../src/index.ts";
import type { CallOptions, ChatStreamEvent } from "../../src/index.ts";
import { startFakeFmServe } from "../fixtures/fake-fm-serve.ts";
import type { FakeFmOptions } from "../fixtures/fake-fm-serve.ts";

const POSIX = { timeout: 15_000, skip: process.platform === "win32" && "D122: native Unix sockets require POSIX" };
const REQUEST = { model: "system", messages: [{ role: "user" as const, content: "synthetic request" }] };

async function fixture(t: TestContext, options: FakeFmOptions) {
  const fm = await startFakeFmServe(options);
  const controller = new AbortController();
  const iterators = new Set<AsyncGenerator<ChatStreamEvent, void, void>>();
  t.after(async () => {
    controller.abort();
    await Promise.allSettled([...iterators].map(iterator => iterator.return()));
    await fm.close();
  });
  const local = createLocalChatAdapter({
    state: "ok", baseUrl: "http://apple-fm.invalid/v1", socket: "managed:apple-fm",
  }, createChatCompletionsAdapter, undefined, { unix: { socket: fm.socket, guard: { verify: () => ({ ok: true }) } } });
  const stream = (options?: CallOptions) => {
    const iterator = local.stream(REQUEST, { ...options, signal: controller.signal });
    iterators.add(iterator);
    return iterator;
  };
  return { fm, local, controller, stream };
}

test("a paused stream expires and its later return cannot release the next call", POSIX, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const options: FakeFmOptions = { mode: "hang" };
  const { fm, local, controller, stream } = await fixture(t, options);
  const old = stream({ timeouts: { totalMs: 5000 } });
  await old.next();
  t.mock.timers.tick(5000);
  await fm.waitForDisconnect();
  const next = stream();
  assert.equal((await next.next()).done, false);
  await old.return();
  await assert.rejects(local.complete(REQUEST), (error: unknown) =>
    error instanceof ProviderError && error.code === "busy");
  controller.abort();
  await next.return();
  options.mode = "text";
  assert.equal((await local.complete(REQUEST)).text, "Hallo");
});

test("caller abort releases a paused stream without requiring another iterator step", POSIX, async t => {
  const options: FakeFmOptions = { mode: "hang" };
  const { fm, local, controller, stream } = await fixture(t, options);
  await stream().next();
  controller.abort();
  await fm.waitForDisconnect();
  options.mode = "text";
  assert.equal((await local.complete(REQUEST)).text, "Hallo");
});

test("managed complete without timeout overrides expires headers at 30 seconds", POSIX, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { fm, local, controller } = await fixture(t, { mode: "hang-headers" });
  const outcome: { value: unknown } = { value: "pending" };
  const pending = local.complete(REQUEST, { signal: controller.signal }).then(
    () => {
      outcome.value = "unexpected success";
    },
    error => {
      outcome.value = error;
    },
  );
  await fm.waitForRequests(1);
  t.mock.timers.tick(29_999);
  await nextTurn();
  assert.equal(outcome.value, "pending");
  t.mock.timers.tick(1);
  await nextTurn();
  const error: unknown = outcome.value as unknown;
  assert.ok(error instanceof ProviderError);
  assert.equal(error.kind, "timeout");
  assert.equal(error.timeoutPhase, "headers");
  await pending;
});

test("managed stream without timeout overrides releases a paused call at 120 seconds", POSIX, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const options: FakeFmOptions = { mode: "hang" };
  const { local, stream } = await fixture(t, options);
  await stream().next();
  t.mock.timers.tick(119_999);
  await assert.rejects(local.complete(REQUEST), (error: unknown) =>
    error instanceof ProviderError && error.code === "busy");
  t.mock.timers.tick(1);
  await nextTurn();
  options.mode = "text";
  assert.equal((await local.complete(REQUEST)).text, "Hallo");
});

test("managed idle defaults expire at 30 seconds while consuming a silent stream", POSIX, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream } = await fixture(t, { mode: "hang" });
  const iterator = stream();
  assert.deepEqual((await iterator.next()).value, { type: "text_delta", text: "Hallo" });
  const outcome: { value: unknown } = { value: "pending" };
  const pending = iterator.next().then(
    () => {
      outcome.value = "unexpected success";
    },
    error => {
      outcome.value = error;
    },
  );
  await nextTurn();
  t.mock.timers.tick(29_999);
  await nextTurn();
  assert.equal(outcome.value, "pending");
  t.mock.timers.tick(1);
  await nextTurn();
  const error: unknown = outcome.value as unknown;
  assert.ok(error instanceof ProviderError);
  assert.equal(error.kind, "timeout");
  assert.equal(error.timeoutPhase, "idle");
  await pending;
});

test("managed lifetime preserves received partial text when the caller aborts", POSIX, async t => {
  const { controller, stream } = await fixture(t, { mode: "hang" });
  const iterator = stream();
  assert.deepEqual((await iterator.next()).value, { type: "text_delta", text: "Hallo" });
  const pending = assert.rejects(iterator.next(), (error: unknown) => error instanceof ProviderError
    && error.kind === "aborted" && error.partial?.text === "Hallo");
  controller.abort();
  await pending;
});
