import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveEmbeddingSettings } from "../src/config.ts";
import { ollamaWire } from "../src/embedding/ollama.ts";
import { AdapterError } from "../src/errors.ts";
import { createEmbeddingAdapter } from "../src/registry.ts";
import { fromFixture } from "./helpers/fixture-fetch.ts";
import { kit } from "./helpers/adapter-kit.ts";

const isBadResponse = (e: unknown) => e instanceof AdapterError && e.kind === "bad_response" && e.provider === "ollama";
const settingsFor = (extra: Record<string, unknown> = {}) =>
  resolveEmbeddingSettings({ provider: "ollama", model: "nomic-embed-text", dimensions: 4, ...extra });

describe("ollama wire: request building", () => {
  it("sends model, input and truncate:false, and no dimensions unless asked", () => {
    const req = ollamaWire.buildRequest({ settings: settingsFor(), texts: ["a", "b"], inputType: "document" }, undefined);
    assert.deepEqual(req.body, { model: "nomic-embed-text", input: ["a", "b"], truncate: false });
    assert.equal("dimensions" in (req.body as object), false);
    assert.deepEqual(req.headers, {}, "no authorization header without a secret");
  });

  it("adds dimensions when sendDimensions is set (matryoshka models)", () => {
    const req = ollamaWire.buildRequest({ settings: settingsFor({ sendDimensions: true }), texts: ["a"], inputType: "query" }, undefined);
    assert.deepEqual(req.body, { model: "nomic-embed-text", input: ["a"], truncate: false, dimensions: 4 });
  });

  it("keeps an explicit false for sendDimensions out of the body", () => {
    const req = ollamaWire.buildRequest({ settings: settingsFor({ sendDimensions: false }), texts: ["a"], inputType: "document" }, undefined);
    assert.equal("dimensions" in (req.body as object), false);
  });

  const urls: Array<[string, string | undefined, string]> = [
    ["default base and path", undefined, "http://127.0.0.1:11434/api/embed"],
    ["trailing slashes on the base are collapsed", "http://ollama.lan:11434///", "http://ollama.lan:11434/api/embed"],
  ];
  for (const [label, baseURL, want] of urls) {
    it(`builds the URL from ${label}`, () => {
      const settings = settingsFor(baseURL === undefined ? {} : { baseURL });
      assert.equal(ollamaWire.buildRequest({ settings, texts: ["a"], inputType: "document" }, undefined).url, want);
    });
  }

  it("uses bearer auth only when a secret is configured", () => {
    const req = ollamaWire.buildRequest({ settings: settingsFor({ secretName: "OLLAMA_TOKEN" }), texts: ["a"], inputType: "document" }, "tok-123");
    assert.deepEqual(req.headers, { authorization: "Bearer tok-123" });
  });
});

describe("ollama wire: response parsing", () => {
  it("returns the embeddings array as given, in input order", () => {
    const list = [[1, 0], [0, 1]];
    assert.equal(ollamaWire.parseResponse({ embeddings: list }, 2, "ollama"), list);
  });

  it("an empty embeddings array is passed through (the pipeline rejects the count mismatch)", () => {
    assert.deepEqual(ollamaWire.parseResponse({ embeddings: [] }, 0, "ollama"), []);
  });

  const malformed: Array<[string, unknown]> = [
    ["null body", null],
    ["undefined body", undefined],
    ["a string", "embeddings"],
    ["a number", 42],
    ["an object without embeddings", { vectors: [[1]] }],
    ["embeddings is an object", { embeddings: { a: [1] } }],
    ["embeddings is a number", { embeddings: 4 }],
    ["embeddings is null", { embeddings: null }],
    ["a root array", [[1, 2]]],
  ];
  for (const [label, body] of malformed) {
    it(`refuses ${label} with bad_response for the ollama provider`, () => {
      assert.throws(() => ollamaWire.parseResponse(body, 1, "ollama"), isBadResponse);
    });
  }
});

describe("ollama adapter end to end", () => {
  it("sends dimensions in the request when configured and returns the vectors", async () => {
    const { deps, requests } = kit(fromFixture("ollama/success.json"));
    const a = createEmbeddingAdapter({ provider: "ollama", model: "nomic-embed-text", dimensions: 4, sendDimensions: true }, deps);
    const out = await a.embed(["a", "b"], { inputType: "document" });
    assert.equal(out.length, 2);
    assert.deepEqual(requests[0]!.body, { model: "nomic-embed-text", input: ["a", "b"], truncate: false, dimensions: 4 });
  });

  it("a response with no embeddings array is bad_response, not a crash", async () => {
    const { deps } = kit({ status: 200, json: { embedding: [1, 2, 3, 4] } });
    const a = createEmbeddingAdapter({ provider: "ollama", model: "nomic-embed-text", dimensions: 4 }, deps);
    await assert.rejects(a.embed(["a"], { inputType: "document" }), isBadResponse);
  });

  it("an empty JSON null body from the server is bad_response", async () => {
    const { deps } = kit({ status: 200, json: null });
    const a = createEmbeddingAdapter({ provider: "ollama", model: "nomic-embed-text", dimensions: 4 }, deps);
    await assert.rejects(a.embed(["a"], { inputType: "document" }), isBadResponse);
  });
});
