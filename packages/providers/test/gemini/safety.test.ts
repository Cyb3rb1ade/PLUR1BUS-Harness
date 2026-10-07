import assert from "node:assert/strict";
import { test } from "node:test";
import { GeminiSafetyBlockError, ProviderError } from "../../src/index.ts";
import { startStub } from "../helpers/stub.ts";
import { T, adapterFor, basic, candidate, collect, json, sse } from "./helpers.ts";

const ratings = [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "HIGH", blocked: true }, { category: "HARM_CATEGORY_HARASSMENT", probability: "LOW" }, { nonsense: 1 }];
const promptBlocked = { promptFeedback: { blockReason: "SAFETY", safetyRatings: ratings }, usageMetadata: { promptTokenCount: 5 } };

function isBlock(e: unknown): e is GeminiSafetyBlockError {
  return e instanceof GeminiSafetyBlockError;
}

test("prompt blocked (non-stream): typed invalid_request error (contentFiltered) with source, reason and ratings; not retryable", T, async () => {
  const stub = await startStub((_q, res) => json(res, promptBlocked));
  try {
    await assert.rejects(adapterFor(stub).adapter.complete(basic), (e: unknown) => {
      assert.ok(isBlock(e));
      assert.ok(e instanceof ProviderError);
      assert.equal(e.kind, "invalid_request");
      assert.equal(e.contentFiltered, true);
      assert.equal(e.source, "prompt");
      assert.equal(e.reason, "SAFETY");
      assert.equal(e.code, "SAFETY");
      assert.equal(e.retryable, false);
      assert.deepEqual(e.ratings, [
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "HIGH", blocked: true },
        { category: "HARM_CATEGORY_HARASSMENT", probability: "LOW" },
      ]);
      return true;
    });
  } finally { await stub.close(); }
});

test("prompt blocked (stream): same error, no events delivered before it", T, async () => {
  const stub = await startStub((_q, res) => sse(res, [promptBlocked]));
  try {
    const seen: string[] = [];
    await assert.rejects((async () => { for await (const e of adapterFor(stub).adapter.stream(basic)) seen.push(e.type); })(), (e: unknown) => isBlock(e) && e.source === "prompt");
    assert.deepEqual(seen, []);
  } finally { await stub.close(); }
});

test("candidate blocked mid-stream: typed error keeps what had been generated in partial", T, async () => {
  const stub = await startStub((_q, res) => sse(res, [
    candidate([{ text: "The recipe starts with " }]),
    candidate([], "SAFETY", { safetyRatings: ratings, finishMessage: "blocked" }),
  ]));
  try {
    await assert.rejects(collect(adapterFor(stub).adapter.stream(basic)), (e: unknown) => {
      assert.ok(isBlock(e));
      assert.equal(e.source, "candidate");
      assert.equal(e.reason, "SAFETY");
      assert.match(e.message, /blocked/);
      assert.equal(e.partial?.text, "The recipe starts with ");
      return true;
    });
  } finally { await stub.close(); }
});

test("every blocking finishReason is a typed block; benign ones are not", T, async () => {
  for (const reason of ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]) {
    const stub = await startStub((_q, res) => json(res, candidate([{ text: "x" }], reason)));
    try { await assert.rejects(adapterFor(stub).adapter.complete(basic), (e: unknown) => isBlock(e) && e.reason === reason && e.kind === "invalid_request" && e.contentFiltered); } finally { await stub.close(); }
  }
  const stub = await startStub((_q, res) => json(res, candidate([{ text: "x" }], "MAX_TOKENS")));
  try { assert.equal((await adapterFor(stub).adapter.complete(basic)).finishReason, "length"); } finally { await stub.close(); }
});

// ---- the full finishReason / blockReason table (see the doc comment in src/gemini/response.ts) ----

type Mode = "complete" | "stream";
async function run(body: unknown, mode: Mode) {
  const stub = await startStub((_q, res) => (mode === "complete" ? json(res, body) : sse(res, [body])));
  try {
    const a = adapterFor(stub).adapter;
    return mode === "complete" ? await a.complete(basic) : await collect(a.stream(basic));
  } finally { await stub.close(); }
}
const MODES: Mode[] = ["complete", "stream"];
const result = (r: Awaited<ReturnType<typeof run>>) => {
  if (!Array.isArray(r)) return r;
  const done = r.at(-1);
  assert.ok(done?.type === "done");
  return done.result;
};

const CANDIDATE_BLOCKED = ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"];
const PROMPT_BLOCKED = ["SAFETY", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY", "SOME_FUTURE_REASON"];

test("candidate finishReason table: every blocking value is a typed, non-retryable block (stream and non-stream)", T, async () => {
  for (const mode of MODES) for (const reason of CANDIDATE_BLOCKED) {
    await assert.rejects(run(candidate([{ text: "x" }], reason), mode), (e: unknown) =>
      isBlock(e) && e.source === "candidate" && e.reason === reason && e.kind === "invalid_request" && e.contentFiltered && !e.retryable, `${mode} ${reason}`);
  }
});

test("prompt blockReason table: every value but BLOCK_REASON_UNSPECIFIED is a typed block (stream and non-stream)", T, async () => {
  for (const mode of MODES) for (const reason of PROMPT_BLOCKED) {
    await assert.rejects(run({ promptFeedback: { blockReason: reason } }, mode), (e: unknown) =>
      isBlock(e) && e.source === "prompt" && e.reason === reason && e.kind === "invalid_request" && e.contentFiltered && !e.retryable, `${mode} ${reason}`);
  }
});

test("prompt BLOCK_REASON_UNSPECIFIED is no verdict: the candidate decides; a non-string reason is a protocol error", T, async () => {
  for (const mode of MODES) {
    const r = result(await run({ ...candidate([{ text: "fine" }], "STOP"), promptFeedback: { blockReason: "BLOCK_REASON_UNSPECIFIED" } }, mode));
    assert.equal(r.text, "fine");
    assert.equal(r.finishReason, "stop");
    await assert.rejects(run({ promptFeedback: { blockReason: "BLOCK_REASON_UNSPECIFIED" } }, mode), (e: unknown) => e instanceof ProviderError && e.kind === "unknown" && e.code === "protocol");
    await assert.rejects(run({ promptFeedback: { blockReason: 3 } }, mode), (e: unknown) => e instanceof ProviderError && e.kind === "unknown" && !isBlock(e));
  }
});

test("candidate finishReason table: benign values become results", T, async () => {
  const cases: [string, string][] = [
    ["STOP", "stop"], ["MAX_TOKENS", "length"],
    ["LANGUAGE", "other"], ["OTHER", "other"], ["IMAGE_OTHER", "other"], ["NO_IMAGE", "other"], ["SOME_FUTURE_REASON", "other"],
  ];
  for (const mode of MODES) for (const [raw, want] of cases) {
    const r = result(await run(candidate([{ text: "partial answer" }], raw), mode));
    assert.equal(r.finishReason, want, `${mode} ${raw}`);
    assert.equal(r.rawFinishReason, raw);
    assert.equal(r.text, "partial answer");
  }
  for (const mode of MODES) {
    const r = result(await run(candidate([{ functionCall: { name: "f", args: {} } }], "STOP"), mode));
    assert.equal(r.finishReason, "tool_calls");
  }
});

test("candidate finishReason table: unusable tool output is a protocol error (retryable except TOO_MANY_TOOL_CALLS)", T, async () => {
  const cases: [string, boolean][] = [["MALFORMED_FUNCTION_CALL", true], ["UNEXPECTED_TOOL_CALL", true], ["TOO_MANY_TOOL_CALLS", false]];
  for (const mode of MODES) for (const [raw, retryable] of cases) {
    await assert.rejects(run(candidate([], raw), mode), (e: unknown) =>
      e instanceof ProviderError && !isBlock(e) && e.kind === "unknown" && e.code === "protocol" && e.retryable === retryable && !e.contentFiltered, `${mode} ${raw}`);
  }
});

test("FINISH_REASON_UNSPECIFIED is no verdict: without a real finishReason the response is a protocol error", T, async () => {
  for (const mode of MODES) {
    await assert.rejects(run(candidate([{ text: "x" }], "FINISH_REASON_UNSPECIFIED"), mode), (e: unknown) => e instanceof ProviderError && e.kind === "unknown" && e.code === "protocol");
  }
});

test("a non-string finishReason is a protocol error, not a crash", T, async () => {
  for (const mode of MODES) {
    await assert.rejects(run(candidate([{ text: "x" }], 7 as unknown as string), mode), (e: unknown) => e instanceof ProviderError && e.kind === "unknown");
  }
});
