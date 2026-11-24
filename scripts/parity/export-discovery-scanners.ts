import { fileURLToPath } from "node:url";
import { SCANNERS } from "../../packages/core/src/discovery/scanners/index.ts";
import { ScanError } from "../../packages/core/src/discovery/http.ts";
import { exporterMain } from "./lib.mjs";

export async function recordDiscoveryScanners() {
  const cases = [
    { scanner: "openai-models", responses: [{ data: [
      { id: "vendor/example", name: "Example", created: 7, context_length: 1024,
        supported_parameters: ["tools", "structured_outputs", "reasoning"], architecture: { modality: "image+text->text" } },
      { id: "vendor/example", name: "Duplicate", context_length: 256 },
      { id: "plain", name: null, created: null, context_length: null, supported_parameters: [] },
    ] }] },
    { scanner: "openai-models", apple: true, responses: [{ data: [
      { id: "optional" }, { id: "system", created: 12, name: "Discarded", context_length: 8192 },
    ] }] },
    { scanner: "anthropic-models", responses: [
      { has_more: true, last_id: "model-a", data: [{ id: "model-a", display_name: "A",
        max_input_tokens: 2048, created_at: "2026-11-22T09:10:11Z" }] },
      { has_more: false, data: [{ id: "model-b", display_name: null, created_at: "unknown" }] },
    ] },
    { scanner: "anthropic-models", responses: [
      { has_more: true, last_id: "same", data: [] },
      { has_more: true, last_id: "same", data: [] },
    ] },
    { scanner: "google-models", responses: [
      { models: [{ name: "models/sample-embed", displayName: "Embed", inputTokenLimit: 4096,
        supportedGenerationMethods: ["embedContent"], thinking: false }], nextPageToken: "second" },
      { models: [{ name: "models/sample", supportedGenerationMethods: ["embedContent", "generateContent"], thinking: true }] },
    ] },
    { scanner: "ollama-tags", responses: [{ models: [
      { name: "model:tag", modified_at: "2026-11-22T12:00:00+02:00", details: { family: "fixture" }, capabilities: ["thinking"] },
      { name: "model:small", modified_at: null, capabilities: ["completion"] },
    ] }] },
    { scanner: "ollama-tags", responses: [{ models: [{ name: "test", details: { family: 17 } }] }] },
    { scanner: "openai-models", responses: [{ error: { status: 429 } }] },
    { scanner: "google-models", responses: [{ models: [{ name: "models/" }] }] },
    { scanner: "ollama-tags", responses: [{ models: [{ name: "example", details: { family: "alpha\nbeta" } }] }] },
    { scanner: "ollama-tags", responses: [{ models: [{ name: "example", details: { family: "a".repeat(513) } }] }] },
    { scanner: "openai-models", responses: [{ data: [{ id: "two words" }] }] },
  ] as const;
  const vectors = [];
  for (const item of cases) {
    const requests: unknown[] = [];
    let expected;
    try {
      expected = await SCANNERS[item.scanner]({ id: "apple" in item ? "apple-fm" : "fixture" } as never, {
        async get(request, headers) {
          const reply = item.responses[requests.length];
          requests.push({ ...request, headers });
          if (reply && "error" in reply) throw new ScanError("failed:server", "rate_limited", { httpStatus: reply.error.status });
          if (!reply) throw new Error("fixture has no further response");
          return reply;
        },
        get pages() { return requests.length; },
      });
    } catch (error) {
      if (!(error instanceof ScanError)) throw error;
      expected = { result: error.result, reason: error.reason, httpStatus: error.httpStatus };
    }
    vectors.push({ ...item, requests, expected });
  }
  return { scanners: { source: "packages/core/src/discovery/scanners", cases: vectors } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "discovery", build: recordDiscoveryScanners });
}
