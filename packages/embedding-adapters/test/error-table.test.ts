// Step 6, adapter error table: the SAME simulated responses through EVERY registered embedding adapter, one row per
// (adapter, response) cell. Each cell pins the error kind, whether it is retryable, how often the request was sent, the
// wait that went through the injected `sleep` seam, and that no secret reaches the error text.
//
// Where the adapters come from: `EMBEDDING_PROVIDERS` (src/config.ts, re-exported by src/index.ts). `EMBEDDING_WIRES` in
// src/registry.ts is `Record<EmbeddingProviderId, EmbeddingWire>` over that same list, so the compiler keeps the two in step;
// the registry tests below also compare the wire files in src/embedding with what registry.ts imports and uses.
//
// Expected values come from docs/embedding-adapters.md ("Error classes", "Behaviour that holds for every adapter"). docs/errors.md has
// no embedding-adapter section (its provider section is the voice package, with other code names). A cell the doc does not
// state is marked `documented: false` ("undokumentiert") and pins the current behaviour instead.
//
// No network and no real waiting: fixtureFetch plays the server, `sleep` is injected, and the one deadline cell fires
// the adapter's own deadline timer with node:test mock timers. Print the observed table with PLUR1BUS_PRINT_ERROR_TABLE=1.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AdapterError, createEmbeddingAdapter, EMBEDDING_PROVIDERS, resolveEmbeddingSettings,
  type AdapterErrorKind, type EmbeddingConfig, type EmbeddingProviderId,
} from "../src/index.ts";
import type { Step, StepSource } from "./helpers/fixture-fetch.ts";
import { kit } from "./helpers/adapter-kit.ts";

// The adapter's API key. Every adapter below is configured with a secretName, also the local ones where it is optional,
// so the "no secret in the error" check means something for all of them. A marker, not a credential shape.
const SECRET = "MARKER_SECRET_ONE";
const DEFAULT_ATTEMPTS = 3; // docs/embedding-adapters.md, Configuration: "embed timeout 15 s, 3 attempts"

// ---- test-owned tables ---------------------------------------------------------------------------------------------

type Shape = "openai" | "google" | "cohere" | "ollama" | "tei";
const SHAPE_OF: Record<EmbeddingProviderId, Shape> = {
  openai: "openai", "openai-compatible": "openai", vllm: "openai", llamacpp: "openai", omlx: "openai", openrouter: "openai",
  mtplx: "openai", jina: "openai", voyage: "openai",
  google: "google", cohere: "cohere", ollama: "ollama", tei: "tei",
};

/** A well-formed success body for the provider's wire (two texts go through Google's batch endpoint). */
function okBody(provider: string, vectors: number[][]): unknown {
  const shape = (SHAPE_OF as Record<string, Shape | undefined>)[provider];
  switch (shape) {
    case "openai": return { data: vectors.map((embedding, index) => ({ index, embedding })) };
    case "google": return { embeddings: vectors.map((values) => ({ values })) };
    case "cohere": return { embeddings: { float: vectors } };
    case "ollama": return { embeddings: vectors };
    case "tei": return vectors;
    default: throw new Error(`error-table.test.ts has no response shape for provider "${provider}": add it to SHAPE_OF`);
  }
}

function configFor(provider: EmbeddingProviderId): EmbeddingConfig {
  return {
    provider, model: "model-under-test", dimensions: 4, secretName: "adapter-key", baseURL: "http://127.0.0.1:8000",
    ...(provider === "openrouter" ? { pinnedUpstream: "upstream-under-test" } : {}),
  };
}

const VECTORS = [[3, 4, 0, 0], [0, 0, 5, 12]];
const TEXTS = ["first text", "second text"];

// A hostile or sloppy server quotes the credential it was sent.
const leak = `credential Bearer ${SECRET} was rejected (key ${SECRET})`;
const httpError = (status: number, headers?: Record<string, string>): Step => ({ status, ...(headers ? { headers } : {}), json: { error: { message: `HTTP ${status}: ${leak}` } } });

// ---- the cells -----------------------------------------------------------------------------------------------------

type Wait = "none" | "retry-after" | "backoff";
interface Cell {
  id: string;
  /** What the fake server answers. Absent for the deadline cell, where the server never answers. */
  source?: (provider: string) => StepSource;
  deadline?: true;
  kind: AdapterErrorKind;
  retryable: boolean;
  retryAfterMs?: number;
  /** Requests sent: 1, or the default policy's attempts when the error is retried. */
  attempts: number;
  /** none: no sleep. retry-after: the server's value, once per retry. backoff: equal-jitter backoff, in range. */
  wait: Wait;
  documented: boolean;
  /** Where the expectation comes from, or what was pinned instead. */
  basis: string;
}

const CELLS: readonly Cell[] = [
  { id: "401", source: () => httpError(401), kind: "auth", retryable: false, attempts: 1, wait: "none", documented: true, basis: 'Error classes: auth = "401/403"' },
  { id: "403", source: () => httpError(403), kind: "auth", retryable: false, attempts: 1, wait: "none", documented: true, basis: 'Error classes: auth = "401/403"' },
  { id: "404", source: () => httpError(404), kind: "invalid_request", retryable: false, attempts: 1, wait: "none", documented: true, basis: 'Error classes: invalid_request = "a 4xx the server rejected" (404 is not named)' },
  { id: "408", source: () => httpError(408), kind: "timeout", retryable: true, attempts: DEFAULT_ATTEMPTS, wait: "backoff", documented: false, basis: 'undokumentiert: the doc names only the "per-attempt deadline" for timeout; HTTP 408 is pinned as timeout, retried' },
  { id: "deadline", deadline: true, kind: "timeout", retryable: true, attempts: DEFAULT_ATTEMPTS, wait: "backoff", documented: true, basis: 'Error classes: timeout = "per-attempt deadline", retried' },
  { id: "413", source: () => httpError(413), kind: "too_large", retryable: false, attempts: 1, wait: "none", documented: true, basis: 'Error classes: too_large = "413"' },
  { id: "429+RA", source: () => httpError(429, { "retry-after": "2" }), kind: "rate_limit", retryable: true, retryAfterMs: 2000, attempts: DEFAULT_ATTEMPTS, wait: "retry-after", documented: true, basis: "Error classes + Behaviour: Retry-After honoured, retryAfterMs set" },
  { id: "429", source: () => httpError(429), kind: "rate_limit", retryable: true, attempts: DEFAULT_ATTEMPTS, wait: "backoff", documented: true, basis: "Error classes: rate_limit retried; Behaviour: equal-jitter exponential backoff" },
  { id: "500", source: () => httpError(500), kind: "overloaded", retryable: true, attempts: DEFAULT_ATTEMPTS, wait: "backoff", documented: true, basis: 'Error classes: overloaded = "5xx / 529", retried' },
  { id: "503", source: () => httpError(503), kind: "overloaded", retryable: true, attempts: DEFAULT_ATTEMPTS, wait: "backoff", documented: true, basis: 'Error classes: overloaded = "5xx / 529", retried' },
  // A valid body cut off half way (any proper prefix of a JSON document is invalid).
  { id: "truncated", source: (p) => { const full = JSON.stringify(okBody(p, VECTORS)); return { status: 200, text: full.slice(0, Math.floor(full.length / 2)) }; }, kind: "bad_response", retryable: false, attempts: 1, wait: "none", documented: true, basis: 'Error classes: bad_response = "unparseable"' },
  { id: "invalid", source: () => ({ status: 200, text: `<html><body>proxy login ${SECRET}</body></html>` }), kind: "bad_response", retryable: false, attempts: 1, wait: "none", documented: true, basis: 'Error classes: bad_response = "unparseable"' },
  { id: "count-short", source: (p) => ({ status: 200, json: okBody(p, VECTORS.slice(0, 1)) }), kind: "bad_response", retryable: false, attempts: 1, wait: "none", documented: true, basis: "Behaviour: response validation, count equals inputs" },
  { id: "count-long", source: (p) => ({ status: 200, json: okBody(p, [...VECTORS, [1, 0, 0, 0]]) }), kind: "bad_response", retryable: false, attempts: 1, wait: "none", documented: true, basis: "Behaviour: response validation, count equals inputs" },
  { id: "dimension", source: (p) => ({ status: 200, json: okBody(p, [[1, 0, 0], [0, 1, 0]]) }), kind: "bad_response", retryable: false, attempts: 1, wait: "none", documented: true, basis: "Behaviour: response validation, every vector has the configured dimension" },
];

/** KNOWN GAPs, keyed `<provider>|<cell id>`: text for node:test's `todo`. Empty while every adapter meets its documented mapping. */
const KNOWN_GAPS: Readonly<Record<string, string>> = {};

// ---- running one cell ----------------------------------------------------------------------------------------------

interface Outcome { error: AdapterError; requests: number; sleeps: number[]; sentAuth: boolean }

const abortError = () => new DOMException("The operation was aborted", "AbortError");

async function expectError(promise: Promise<unknown>): Promise<AdapterError> {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof AdapterError, `expected an AdapterError, got ${String(e)}`);
    return e;
  }
  return assert.fail("expected the call to reject");
}

const carriesSecret = (headers: Record<string, string>) => Object.values(headers).some((v) => v.includes(SECRET));
const headerRecord = (h: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  new Headers(h).forEach((value, name) => { out[name] = value; });
  return out;
};

async function runCell(provider: EmbeddingProviderId, cell: Cell): Promise<Outcome> {
  const cfg = configFor(provider);
  const seam = { getSecret: () => SECRET };
  if (cell.deadline) {
    const sleeps: number[] = [];
    let requests = 0;
    let sentAuth = false;
    const deadlineMs = resolveEmbeddingSettings(cfg).timeoutMs;
    const silentServer = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests++;
      sentAuth ||= carriesSecret(headerRecord(init?.headers));
      // postJson armed its deadline timer before calling fetch: fire it now instead of waiting for it.
      mock.timers.tick(deadlineMs);
      if (!init?.signal?.aborted) throw new Error("the deadline timer did not fire");
      throw abortError();
    }) as typeof fetch;
    const { deps } = kit({ status: 200 }, { ...seam, fetch: silentServer, sleep: async (ms) => { sleeps.push(ms); } });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const error = await expectError(createEmbeddingAdapter(cfg, deps).embed(TEXTS, { inputType: "document" }));
      return { error, requests, sleeps, sentAuth };
    } finally {
      mock.timers.reset();
    }
  }
  const { deps, requests, sleeps } = kit((cell.source as NonNullable<Cell["source"]>)(provider), seam);
  const error = await expectError(createEmbeddingAdapter(cfg, deps).embed(TEXTS, { inputType: "document" }));
  return { error, requests: requests.length, sleeps, sentAuth: requests.some((r) => carriesSecret(r.headers)) };
}

/** Equal jitter (docs: "equal-jitter exponential backoff"): attempt n sleeps between half and all of min(4000, 250 * 2^(n-1)) ms. */
function assertBackoff(sleeps: number[], retries: number): void {
  assert.equal(sleeps.length, retries, `sleeps: ${JSON.stringify(sleeps)}`);
  sleeps.forEach((ms, i) => {
    const ceiling = Math.min(4000, 250 * 2 ** i);
    assert.ok(ms >= ceiling / 2 && ms <= ceiling, `sleep ${i + 1} = ${ms} ms, expected ${ceiling / 2}..${ceiling}`);
  });
}

const observed = new Map<string, Outcome>();

function assertNoSecret(e: AdapterError): void {
  const texts = [e.message, e.stack ?? "", JSON.stringify(e), JSON.stringify(e.toJSON()), String(e)];
  for (const text of texts) assert.equal(text.includes(SECRET), false, `secret in error text: ${text.slice(0, 200)}`);
  assert.equal((e as { cause?: unknown }).cause, undefined, "a raw cause is never kept");
}

// ---- the adapter list and the registry -----------------------------------------------------------------------------

const EMBEDDING_DIR = fileURLToPath(new URL("../src/embedding/", import.meta.url));
const REGISTRY_FILE = fileURLToPath(new URL("../src/registry.ts", import.meta.url));

test("registry: the adapter list is EMBEDDING_PROVIDERS and the response-shape table covers exactly that list", () => {
  assert.ok(EMBEDDING_PROVIDERS.length > 0);
  assert.deepEqual([...Object.keys(SHAPE_OF)].sort(), [...EMBEDDING_PROVIDERS].sort(), "SHAPE_OF must list every registered provider and no other");
  for (const provider of EMBEDDING_PROVIDERS) {
    assert.doesNotThrow(() => resolveEmbeddingSettings(configFor(provider)), provider);
    assert.equal(createEmbeddingAdapter(configFor(provider), { getSecret: () => SECRET }).identity().provider, provider);
  }
});

test("registry: every wire file in src/embedding is a provider id and registry.ts imports it and uses its wire", () => {
  const wireFiles = readdirSync(EMBEDDING_DIR).filter((f) => f.endsWith(".ts") && f !== "base.ts").map((f) => f.slice(0, -3));
  assert.ok(wireFiles.length > 0);
  const registry = readFileSync(REGISTRY_FILE, "utf8");
  for (const name of wireFiles) {
    assert.ok((EMBEDDING_PROVIDERS as readonly string[]).includes(name), `src/embedding/${name}.ts is not a registered provider id`);
    assert.ok(registry.includes(`from "./embedding/${name}.ts"`), `src/registry.ts does not import src/embedding/${name}.ts`);
    const exported = [...readFileSync(`${EMBEDDING_DIR}${name}.ts`, "utf8").matchAll(/export const (\w+Wire)\b/g)].map((m) => m[1] as string);
    assert.ok(exported.length > 0, `src/embedding/${name}.ts exports no wire`);
    for (const id of exported) {
      assert.ok(registry.split(id).length - 1 >= 2, `${id} is imported by src/registry.ts but no provider uses it`);
    }
  }
});

// ---- the table -----------------------------------------------------------------------------------------------------

for (const provider of EMBEDDING_PROVIDERS) {
  test(`${provider} | success control: the response shape of this table is the one the wire reads`, async () => {
    const { deps, requests } = kit({ status: 200, json: okBody(provider, VECTORS) }, { getSecret: () => SECRET });
    const out = await createEmbeddingAdapter(configFor(provider), deps).embed(TEXTS, { inputType: "document" });
    assert.equal(out.length, 2);
    assert.ok(out.every((v) => v.length === 4));
    assert.equal(requests.length, 1);
    assert.ok(carriesSecret(requests[0]!.headers), "the request carries the secret, so a leak check on the error is meaningful");
  });

  for (const cell of CELLS) {
    const gap = KNOWN_GAPS[`${provider}|${cell.id}`];
    test(`${provider} | ${cell.id} -> ${cell.kind}, ${cell.retryable ? "retryable" : "not retryable"}${cell.documented ? "" : " (undokumentiert)"}`, gap ? { todo: gap } : {}, async () => {
      const outcome = await runCell(provider, cell);
      observed.set(`${provider}|${cell.id}`, outcome);
      const { error, requests, sleeps, sentAuth } = outcome;
      assert.ok(sentAuth, "the request carries the secret, so a leak check on the error is meaningful");
      assert.equal(error.kind, cell.kind);
      assert.equal(error.retryable, cell.retryable);
      assert.equal(error.retryAfterMs, cell.retryAfterMs);
      assert.equal(error.provider, provider);
      assert.equal(requests, cell.attempts, "requests sent");
      switch (cell.wait) {
        case "none": assert.deepEqual(sleeps, []); break;
        case "retry-after": assert.deepEqual(sleeps, Array.from({ length: cell.attempts - 1 }, () => cell.retryAfterMs)); break;
        case "backoff": assertBackoff(sleeps, cell.attempts - 1); break;
      }
      assertNoSecret(error);
    });
  }
}

test("table: every cell was run for every adapter (a skipped cell cannot hide)", () => {
  assert.equal(observed.size, EMBEDDING_PROVIDERS.length * CELLS.length, `${observed.size} cells ran`);
  if (process.env["PLUR1BUS_PRINT_ERROR_TABLE"] !== "1") return;
  const mark = (b: boolean) => (b ? "yes" : "no");
  const lines = [
    `| Adapter | ${CELLS.map((c) => c.id).join(" | ")} |`,
    `| --- | ${CELLS.map(() => "---").join(" | ")} |`,
    ...EMBEDDING_PROVIDERS.map((p) => `| ${p} | ${CELLS.map((c) => {
      const o = observed.get(`${p}|${c.id}`);
      return o ? `${o.error.kind} / ${mark(o.error.retryable)} / ${mark(c.documented)}` : "n/a";
    }).join(" | ")} |`),
  ];
  console.log(`\n${lines.join("\n")}\n`);
});
