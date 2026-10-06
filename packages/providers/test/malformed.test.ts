// Acceptance: a malformed SSE stream yields a protocol error and does not hang; the connection is released.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatCompletionsAdapter, ProviderError } from "../src/index.ts";
import { basicRequest, credentials, hold, sseHeaders, startStub, until } from "./helpers/stub.ts";

const T = { timeout: 15_000 };
const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-synthetic-2", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

interface Case { name: string; wire: (string | Uint8Array)[]; headers?: Record<string, string>; keepOpen?: boolean; adapter?: object }
const cases: Case[] = [
  { name: "data is not JSON", wire: ["data: {\"choices\": [\n\n"], keepOpen: true },
  { name: "data is JSON but not an object", wire: ["data: 42\n\n"], keepOpen: true },
  { name: "chunk with neither choices nor usage", wire: ["data: {\"id\":\"x\"}\n\n"], keepOpen: true },
  { name: "invalid UTF-8 bytes", wire: [new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28, 0x0a, 0x0a])], keepOpen: true },
  { name: "stream ends without [DONE] after a finish_reason", wire: [chunk({ content: "a" }), chunk({}, "stop")] },
  { name: "stream ends mid-event", wire: [chunk({ content: "a" }), "data: {\"choices\":[{\"index\":0,\"delta\":{\"cont"] },
  { name: "[DONE] without any finish_reason", wire: [chunk({ content: "a" }), DONE] },
  { name: "empty body", wire: [] },
  { name: "unexpected content type", wire: ["{}"], headers: { "content-type": "application/json" } },
  { name: "tool call without an index", wire: [chunk({ tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] })], keepOpen: true },
  { name: "tool call changes its id", wire: [chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "f" } }] }), chunk({ tool_calls: [{ index: 0, id: "c2" }] })], keepOpen: true },
  { name: "tool call never gets a name", wire: [chunk({ tool_calls: [{ index: 0, id: "c1", function: { arguments: "{}" } }] }), chunk({}, "tool_calls"), DONE] },
  { name: "two tool calls share an id", wire: [chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }, { index: 1, id: "c1", function: { name: "g", arguments: "{}" } }] }), chunk({}, "tool_calls"), DONE] },
  { name: "content after finish_reason", wire: [chunk({ content: "a" }, "stop"), chunk({ content: "b" })], keepOpen: true },
  { name: "second choice index", wire: ["data: {\"choices\":[{\"index\":1,\"delta\":{\"content\":\"x\"}}]}\n\n"], keepOpen: true },
  { name: "usage with a negative count", wire: ["data: {\"choices\":[],\"usage\":{\"prompt_tokens\":-1,\"completion_tokens\":2}}\n\n"], keepOpen: true },
  { name: "content is a number", wire: [chunk({ content: 5 })], keepOpen: true },
  { name: "oversized event", wire: ["data: " + "x".repeat(5000) + "\n\n"], keepOpen: true, adapter: { limits: { maxEventBytes: 1024 } } },
  { name: "oversized tool arguments", wire: [chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "y".repeat(500) } }] })], keepOpen: true, adapter: { limits: { maxToolArgumentBytes: 100 } } },
];

for (const c of cases) {
  test(`malformed: ${c.name} → protocol error, no hang, connection released`, T, async () => {
    const stub = await startStub(async (_q, res) => {
      if (c.headers) res.writeHead(200, c.headers); else sseHeaders(res);
      for (const w of c.wire) res.write(w);
      if (c.keepOpen) await hold(res); // a server that never closes: the adapter must not wait for it
      else res.end();
    });
    try {
      const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), timeouts: { idleMs: 5000, totalMs: 10_000 }, ...c.adapter });
      const t0 = Date.now();
      await assert.rejects(async () => { for await (const _ of a.stream(basicRequest)) { /* drain */ } }, (e) => {
        assert.ok(e instanceof ProviderError, String(e));
        assert.equal(e.kind, "protocol", e.message);
        assert.equal(e.retryable, false);
        return true;
      });
      assert.ok(Date.now() - t0 < 3000, "failed fast, not by a timeout");
      if (c.keepOpen) assert.ok(await until(() => stub.openSockets() === 0), "the adapter closed the connection after the error");
    } finally { await stub.close(); }
  });
}

test("a stream that ends without [DONE] is accepted only with allowMissingDone and a finish_reason", T, async () => {
  const stub = await startStub((_q, res) => { sseHeaders(res); res.write(chunk({ content: "a" })); res.write(chunk({}, "stop")); res.end(); });
  try {
    const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), allowMissingDone: true });
    let last;
    for await (const e of a.stream(basicRequest)) last = e;
    assert.equal(last?.type === "done" && last.result.text, "a");
  } finally { await stub.close(); }
});

test("non-stream: a body that is not JSON, or has the wrong shape, is a protocol error", T, async () => {
  const bodies = ["<html>", "[]", "{}", "{\"choices\":[]}", "{\"choices\":[{\"message\":{}}]}",
    "{\"choices\":[{\"message\":{\"content\":\"x\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":\"7\"}}",
    "{\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"c\",\"function\":{\"name\":\"f\"}}]},\"finish_reason\":\"tool_calls\"}]}"];
  for (const body of bodies) {
    const stub = await startStub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); });
    try {
      await assert.rejects(createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials() }).complete(basicRequest), (e) => e instanceof ProviderError && e.kind === "protocol", body);
    } finally { await stub.close(); }
  }
});

test("non-stream: an oversized body is refused", T, async () => {
  const stub = await startStub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("x".repeat(5000)); });
  try {
    const a = createChatCompletionsAdapter({ baseUrl: stub.baseUrl, credentials: credentials(), limits: { maxBodyBytes: 1000 } });
    await assert.rejects(a.complete(basicRequest), (e) => e instanceof ProviderError && e.kind === "protocol");
  } finally { await stub.close(); }
});
