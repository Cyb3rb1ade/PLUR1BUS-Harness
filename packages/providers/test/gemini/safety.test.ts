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
