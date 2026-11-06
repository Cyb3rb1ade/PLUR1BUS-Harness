import { turnContext } from "../src/composition/context.ts";
import type { ChatRequest } from "../src/session/provider.ts";
/** AF2: one keyless adapter per managed provider, with live admission, fit refusal and content-free counters. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { ProviderError } from "../../providers/src/index.ts";
import { startFakeFmServe } from "../../providers/test/fixtures/fake-fm-serve.ts";
import { layout } from "../src/paths.ts";
import { createAppleFmRuntime } from "../src/composition/apple-fm.ts";

const POSIX = { timeout: 15_000, skip: process.platform === "win32" && "AF2: native Unix sockets require POSIX" };
const REQUEST = { model: "system", messages: [{ role: "user" as const, content: "synthetic" }] };

test("disabled, missing-slot and non-Mac admission fail before any filesystem work", async () => {
  const config = defaults();
  const runtime = createAppleFmRuntime({ home: "/synthetic", config: () => config, platform: "darwin" });
  assert.equal(runtime.present(), false);
  await assert.rejects(turnContext.run({ role: "decision" } as ChatRequest, () => runtime.adapter.complete(REQUEST)), (error: unknown) => error instanceof ProviderError
    && error.code === "unavailable");
  config.appleFm.enabled = true;
  assert.equal(runtime.present(), false);
  const other = createAppleFmRuntime({
    home: "/synthetic", config: () => config, platform: "linux", slot: () => ({ state: "ready" }),
  });
  await assert.rejects(turnContext.run({ role: "decision" } as ChatRequest, () => other.adapter.complete(REQUEST)), (error: unknown) => error instanceof ProviderError
    && error.code === "platform");
});

test("live enablement uses Layout, keyless JSON, one stable adapter and fit refusal with zero extra bytes", POSIX, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "p1runtime-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = layout(root);
  await mkdir(paths.run, { mode: 0o700 });
  await mkdir(paths.appleFmDir, { mode: 0o700 });
  const fm = await startFakeFmServe({ directory: paths.appleFmDir });
  t.after(() => fm.close());
  const config = defaults();
  let state = "starting";
  const runtime = createAppleFmRuntime({ home: root, config: () => config, platform: "darwin", slot: () => ({ state }) });
  const original = runtime.adapter;
  const adapter = { complete: (...args: Parameters<typeof original.complete>) => turnContext.run(
    { role: "decision" } as ChatRequest, () => original.complete(...args)),
  };
  config.appleFm.enabled = true;
  assert.equal(runtime.present(), true);
  await assert.rejects(adapter.complete(REQUEST), (error: unknown) => error instanceof ProviderError
    && error.code === "unavailable");
  state = "ready";
  await assert.rejects(runtime.adapter.complete(REQUEST), (error: unknown) => error instanceof ProviderError
    && error.code === "context-too-small");
  assert.equal(fm.requests.length, 0, "agent-role refusal precedes socket I/O");
  assert.equal((await adapter.complete(REQUEST)).text, "Hallo");
  assert.equal(runtime.adapter, original);
  assert.equal(fm.requests.length, 1);
  assert.equal(fm.requests[0]?.headers.authorization, undefined);
  await assert.rejects(adapter.complete({ ...REQUEST, messages: [{ role: "user", content: "x".repeat(13_000) }] }),
    (error: unknown) => error instanceof ProviderError && error.code === "context_overflow");
  await assert.rejects(adapter.complete({ ...REQUEST, model: "pcc" }), (error: unknown) =>
    error instanceof ProviderError && error.code === "model_not_allowed");
  assert.equal(fm.requests.length, 1);
  config.appleFm.enabled = false;
  await assert.rejects(adapter.complete(REQUEST), (error: unknown) => error instanceof ProviderError
    && error.code === "unavailable");
  assert.equal(runtime.metrics().transport.unix.ok, 1);
  assert.doesNotMatch(JSON.stringify(runtime.metrics()), /p1runtime|synthetic|Bearer/);
});
