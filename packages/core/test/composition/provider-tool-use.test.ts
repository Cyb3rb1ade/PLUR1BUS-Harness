/** N-E4/E5/E6: force tools at the real candidate boundary, with provider and delivery exceptions. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { collect, readTool, scriptedAdapter, turnFixture, turnRequest, useTempDirs } from "./helpers.ts";
import type { ProviderFamily } from "../../src/toolcall/quirks.ts";
import { ProviderError } from "../../../providers/src/index.ts";

const tmp = useTempDirs("n-provider-choice-");

for (const family of ["openai-chat", "openai-responses", "anthropic", "gemini"] as ProviderFamily[]) {
  it(`${family} forces a needed first round and restores auto after the model calls a tool`, async () => {
    const wire = scriptedAdapter([
      { calls: [{ id: "read", name: "file.read", args: { path: "x" } }] }, { text: "done" },
    ]);
    const f = turnFixture(wire.adapter, { family: { fixture: family } }, tmp.make());
    f.registry.register(readTool("file.read", async () => "contents"));
    try {
      const chunks = await collect(f.provider, turnRequest({ messages: [{ role: "user", text: "Read ./x" }] }));
      assert.equal(wire.requests[0]?.toolChoice, "required");
      assert.equal(wire.requests[1]?.toolChoice, "auto");
      const final = chunks.at(-1);
      assert.equal(final?.type === "telemetry" && final.telemetry.toolChoice.forced, true);
    } finally { f.close(); }
  });
}

it("plain chat and an explicit auto override keep automatic choice", async () => {
  const wire = scriptedAdapter([{ text: "hello" }]);
  const f = turnFixture(wire.adapter, {}, tmp.make());
  f.registry.register(readTool("file.read", async () => "unused"));
  try {
    await collect(f.provider, turnRequest({ messages: [{ role: "user", text: "Hello!" }] }));
    await collect(f.provider, turnRequest({ toolUseMode: "auto", messages: [{ role: "user", text: "Read ./x" }] }));
    assert.deepEqual(wire.requests.map(r => r.toolChoice), ["auto", "auto"]);
  } finally { f.close(); }
});

it("retries a buffered answer without tool evidence once and exposes only the verified answer", async () => {
  const wire = scriptedAdapter([
    { text: "UNVERIFIED PRELIMINARY" },
    { calls: [{ id: "read", name: "file.read", args: { path: "x" } }] },
    { text: "VERIFIED FINAL" },
  ]);
  const f = turnFixture(wire.adapter, {}, tmp.make());
  f.registry.register(readTool("file.read", async () => "contents"));
  try {
    const chunks = await collect(f.provider, turnRequest({ buffered: true,
      messages: [{ role: "user", text: "Read ./x" }] }));
    assert.equal(wire.requests.length, 3);
    assert.deepEqual(wire.requests.map(r => r.toolChoice), ["required", "required", "auto"]);
    assert.equal(chunks.filter(c => c.type === "delta").map(c => c.text).join(""), "VERIFIED FINAL");
    assert.equal(chunks.filter(c => c.type === "tool.call").length, 1);
    const last = chunks.at(-1);
    assert.equal(last?.type === "telemetry" && last.telemetry.rounds, 3);
  } finally { f.close(); }
});

it("does not retract or retry a streamed answer after it has been delivered", async () => {
  const wire = scriptedAdapter([{ text: "STREAMED ANSWER" }]);
  const f = turnFixture(wire.adapter, {}, tmp.make());
  f.registry.register(readTool("file.read", async () => "unused"));
  try {
    const chunks = await collect(f.provider, turnRequest({ messages: [{ role: "user", text: "Read ./x" }] }));
    assert.equal(wire.requests.length, 1);
    assert.equal(chunks.filter(c => c.type === "delta").map(c => c.text).join(""), "STREAMED ANSWER");
    const last = chunks.at(-1);
    assert.equal(last?.type === "telemetry" && last.telemetry.toolCalls, 0);
    assert.equal(last?.type === "telemetry" && last.telemetry.toolNeed.detected, true);
  } finally { f.close(); }
});

it("bounds buffered retries even when both required-choice answers contain no call", async () => {
  const wire = scriptedAdapter([{ text: "NO EVIDENCE" }]);
  const f = turnFixture(wire.adapter, {}, tmp.make());
  f.registry.register(readTool("file.read", async () => "unused"));
  try {
    const chunks = await collect(f.provider, turnRequest({ buffered: true,
      messages: [{ role: "user", text: "Read ./x" }] }));
    assert.equal(wire.requests.length, 2);
    assert.equal(chunks.filter(c => c.type === "delta").map(c => c.text).join(""), "NO EVIDENCE");
  } finally { f.close(); }
});

it("counts unsupported forcing for Anthropic Extended Thinking without sending a forced choice", async () => {
  const wire = scriptedAdapter([{ text: "thinking answer" }]);
  const f = turnFixture(wire.adapter, {
    family: { fixture: "anthropic" },
    reasoningFor: () => ({ kind: "budget", levels: ["high"], source: "table",
      vendorParam: "thinking.budget_tokens", budget: { min: 1024, max: 2048, default: 1024 } }),
  }, tmp.make());
  f.registry.register(readTool("file.read", async () => "unused"));
  try {
    const chunks = await collect(f.provider, turnRequest({ reasoning: "high",
      messages: [{ role: "user", text: "Read ./x" }] }));
    assert.equal(wire.requests[0]?.toolChoice, "auto");
    assert.equal(wire.requests[0]?.reasoning?.vendorParam, "thinking.budget_tokens");
    const last = chunks.at(-1);
    assert.equal(last?.type === "telemetry" && last.telemetry.toolChoice.status, "unsupported");
  } finally { f.close(); }
});

it("keeps an unverified local OpenAI-compatible server on automatic choice", async () => {
  const wire = scriptedAdapter([{ text: "local answer" }]);
  const f = turnFixture(wire.adapter, { isLocalProvider: () => true }, tmp.make());
  f.registry.register(readTool("file.read", async () => "unused"));
  try {
    const chunks = await collect(f.provider, turnRequest({ messages: [{ role: "user", text: "Read ./x" }] }));
    assert.equal(wire.requests[0]?.toolChoice, "auto");
    const last = chunks.at(-1);
    assert.equal(last?.type === "telemetry" && last.telemetry.toolChoice.status, "unsupported");
  } finally { f.close(); }
});

it("re-evaluates forcing for the actual fallback provider and its reasoning mode", async () => {
  let firstChoice: unknown;
  const fallback = scriptedAdapter([{ text: "fallback answer" }]);
  const primary = { async *stream(request: import("../../../providers/src/index.ts").ChatRequest) {
    firstChoice = request.toolChoice;
    throw new ProviderError("overloaded", "synthetic failure", { retryable: true });
  } };
  const f = turnFixture(primary, {
    profiles: { default: [
      { provider: "openai", model: "gpt-4.1", adapter: primary },
      { provider: "anthropic", model: "claude-sonnet-4", adapter: fallback.adapter },
    ] },
    family: { openai: "openai-chat", anthropic: "anthropic" },
    router: { retry: { maxRetries: 0 } },
    reasoningFor: provider => provider === "anthropic"
      ? { kind: "budget", levels: ["high"], source: "table", vendorParam: "thinking.budget_tokens",
        budget: { min: 1024, max: 2048, default: 1024 } }
      : { kind: "none", levels: [], source: "unknown" },
  }, tmp.make());
  f.registry.register(readTool("file.read", async () => "unused"));
  try {
    await collect(f.provider, turnRequest({ reasoning: "high", messages: [{ role: "user", text: "Read ./x" }] }));
    assert.equal(firstChoice, "required");
    assert.equal(fallback.requests.length, 1);
    assert.equal(fallback.requests[0]?.toolChoice, "auto");
  } finally { f.close(); }
});
