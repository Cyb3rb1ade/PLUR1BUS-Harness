/** D122 AF1: health and models are both checked through the managed transport, never through egress/TCP. */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as providers from "../../src/index.ts";
import { startFakeFmServe } from "../fixtures/fake-fm-serve.ts";

const T = { timeout: 15_000 };
const POSIX = { ...T, skip: process.platform === "win32" && "D122: native Unix socket tests require POSIX" };
const trusted = { verify: () => ({ ok: true as const }) };

test("Unix probe requires an available system model and never offers pcc or custom models", POSIX, async () => {
  const fm = await startFakeFmServe({ models: { data: [{ id: "system" }, { id: "pcc" }, { id: "custom" }] } });
  try {
    const result = await providers.probeUnixEndpoint(fm.socket, { guard: trusted });
    assert.deepEqual(result, {
      state: "ok", baseUrl: "http://apple-fm.invalid/v1", socket: "managed:apple-fm", models: [{ id: "system" }],
    });
    assert.deepEqual(fm.requests.map((request) => request.path), ["/health", "/v1/models"]);
    assert.equal(fm.requests.every((request) => request.headers.authorization === undefined), true);
  } finally {
    await fm.close();
  }
});

test("Unix probe reports system unavailable with a bounded reason and does not query models", POSIX, async () => {
  const fm = await startFakeFmServe({ health: {
    status: "fm serve is running", models: [
      { name: "system", available: false, reason: "synthetic downloading ".repeat(30) },
      { name: "pcc", available: true },
    ],
  } });
  try {
    const result = await providers.probeUnixEndpoint(fm.socket, { guard: trusted });
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, "model-unavailable");
    assert.equal(result.detail?.length, 200);
    assert.deepEqual(result.models, []);
    assert.deepEqual(fm.requests.map((request) => request.path), ["/health"]);
  } finally {
    await fm.close();
  }
});

test("Unix probe refuses malformed health, duplicate system entries and missing system", POSIX, async () => {
  for (const health of [
    {}, { models: [] }, { models: [{ name: "pcc", available: true }] },
    { models: [{ name: "system", available: "true" }] },
    { models: [{ name: "system", available: true }, { name: "system", available: false }] },
  ]) {
    const fm = await startFakeFmServe({ health });
    try {
      const result = await providers.probeUnixEndpoint(fm.socket, { guard: trusted });
      assert.equal(result.state, "unavailable");
      assert.equal(result.reason, "protocol");
      assert.deepEqual(result.models, []);
    } finally {
      await fm.close();
    }
  }
});

test("Unix probe refuses malformed models or a list without system even when health is ready", POSIX, async () => {
  for (const models of [{}, { data: [] }, { data: [{ id: "pcc" }] }]) {
    const fm = await startFakeFmServe({ models });
    try {
      const result = await providers.probeUnixEndpoint(fm.socket, { guard: trusted });
      assert.equal(result.state, "unavailable");
      assert.deepEqual(result.models, []);
    } finally {
      await fm.close();
    }
  }
});

test("Unix probe applies one deadline to guard, health and model-list requests", POSIX, async () => {
  const fm = await startFakeFmServe({ handler: () => undefined });
  try {
    const result = await providers.probeUnixEndpoint(fm.socket, { guard: trusted, timeoutMs: 50 });
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, "timeout");
    await fm.waitForDisconnect();
  } finally {
    await fm.close();
  }
});

test("Unix probe preserves caller cancellation instead of caching an unavailable observation", POSIX, async () => {
  const fm = await startFakeFmServe({ handler: () => undefined });
  const controller = new AbortController();
  try {
    const cancelled = assert.rejects(
      providers.probeUnixEndpoint(fm.socket, { guard: trusted, signal: controller.signal }),
      (error: unknown) => error === controller.signal.reason,
    );
    await fm.waitForRequests(1);
    controller.abort();
    await cancelled;
    await fm.waitForDisconnect();
  } finally {
    controller.abort();
    await fm.close();
  }
});

test("Unix probe reports platform refusal with zero guard calls on Windows", T, async () => {
  let verifies = 0;
  const result = await providers.probeUnixEndpoint({ id: "apple-fm", path: "/nonexistent/fm.sock" }, {
    platform: "win32", guard: { verify: () => {
      verifies++;
      return { ok: true };
    } },
  });
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "platform");
  assert.equal(verifies, 0);
});
