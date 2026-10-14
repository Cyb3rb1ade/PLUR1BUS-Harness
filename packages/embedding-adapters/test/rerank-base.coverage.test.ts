import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AdapterError } from "../src/errors.ts";
import { createRerankAdapter } from "../src/registry.ts";
import { FAKE_SECRET, kit } from "./helpers/adapter-kit.ts";

const docs = ["alpha", "beta", "gamma"];
const isKind = (kind: AdapterError["kind"]) => (e: unknown) => e instanceof AdapterError && e.kind === kind;
const TEI = { provider: "tei" as const, baseURL: "http://nas:8080" };

describe("rerank pipeline: ordering", () => {
  it("equal scores keep document order, so the result is deterministic", async () => {
    const { deps } = kit({ status: 200, json: [{ index: 2, score: 0.5 }, { index: 0, score: 0.5 }, { index: 1, score: 0.9 }] });
    const out = await createRerankAdapter(TEI, deps).rerank("q", docs);
    assert.deepEqual(out, [{ index: 1, score: 0.9 }, { index: 0, score: 0.5 }, { index: 2, score: 0.5 }]);
  });

  it("with topN, the equal-score tie-break decides which documents survive the cut", async () => {
    const { deps } = kit({ status: 200, json: [{ index: 2, score: 0.5 }, { index: 1, score: 0.5 }, { index: 0, score: 0.5 }] });
    const out = await createRerankAdapter(TEI, deps).rerank("q", docs, { topN: 2 });
    assert.deepEqual(out, [{ index: 0, score: 0.5 }, { index: 1, score: 0.5 }]);
  });

  it("an empty docs array returns [] without a request", async () => {
    const { deps, requests } = kit({ status: 200, json: [] });
    assert.deepEqual(await createRerankAdapter(TEI, deps).rerank("q", []), []);
    assert.equal(requests.length, 0);
  });
});

describe("rerank pipeline: shape failures are always AdapterError", () => {
  it("a server body that breaks the parse with a non-adapter error becomes bad_response", async () => {
    // A JSON body cannot carry a throwing getter, so the trap is an accessor on Object.prototype for "index". It fires only
    // for the one sentinel object below. It is removed in finally. The parser reads "index" on each result item, so the
    // throw reaches the non-AdapterError branch of the parse catch.
    const SENTINEL = 0.123456;
    const desc = Object.getOwnPropertyDescriptor(Object.prototype, "index");
    assert.equal(desc, undefined, "Object.prototype must not already define an index accessor");
    Object.defineProperty(Object.prototype, "index", {
      configurable: true,
      enumerable: false,
      get(this: unknown) {
        if (typeof this === "object" && this !== null && Object.prototype.hasOwnProperty.call(this, "score") && (this as { score: unknown }).score === SENTINEL) {
          throw new Error("trap: parser exploded");
        }
        return undefined;
      },
      set(this: object, v: unknown) {
        Object.defineProperty(this, "index", { value: v, writable: true, enumerable: true, configurable: true });
      },
    });
    try {
      const { deps } = kit({ status: 200, json: [{ score: SENTINEL }] });
      await assert.rejects(createRerankAdapter(TEI, deps).rerank("q", ["only"]), (e: unknown) =>
        e instanceof AdapterError && e.kind === "bad_response" && e.provider === "tei" && !/trap/.test(e.message));
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)["index"];
    }
    assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, "index"), undefined, "the trap is removed");
  });

  it("an internal failure during retry (the injected sleep throws) becomes bad_response with no detail leaked", async () => {
    const { deps } = kit(
      { status: 503, json: { error: "busy" } },
      { sleep: async () => { throw new Error("sleep exploded: secret-in-message"); } },
    );
    const a = createRerankAdapter({ ...TEI, retry: { maxAttempts: 3 } }, deps);
    await assert.rejects(a.rerank("q", docs), (e: unknown) =>
      e instanceof AdapterError && e.kind === "bad_response" && e.message === "unexpected internal failure while reranking" && e.provider === "tei");
  });

  it("a retried request carries the same auth header as the first attempt", async () => {
    const { deps, requests } = kit((_req, n) => (n === 1
      ? { status: 503, json: {} }
      : { status: 200, json: { results: [{ index: 0, relevance_score: 1 }, { index: 1, relevance_score: 0.5 }, { index: 2, relevance_score: 0.1 }] } }));
    const cohereLike = { provider: "cohere" as const, model: "rerank-v3.5", secretName: "k" };
    const out = await createRerankAdapter(cohereLike, deps).rerank("q", docs);
    assert.deepEqual(out.map((r) => r.index), [0, 1, 2]);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.headers["authorization"], `Bearer ${FAKE_SECRET}`);
  });
});

// Options that are null or not an object are a caller error: invalid_request, nothing is sent (same class the embedding
// pipeline uses for a bad inputType).
for (const [label, bad] of [["null", null], ["a string", "topN"], ["a number", 3]] as const) {
  it(`${label} options are invalid_request and send no request`, async () => {
    const { deps, requests } = kit({ status: 200, json: [] });
    await assert.rejects(createRerankAdapter(TEI, deps).rerank("q", docs, bad as never), (e: unknown) =>
      e instanceof AdapterError && e.kind === "invalid_request" && e.retryable === false && e.provider === "tei");
    assert.equal(requests.length, 0);
  });
}
