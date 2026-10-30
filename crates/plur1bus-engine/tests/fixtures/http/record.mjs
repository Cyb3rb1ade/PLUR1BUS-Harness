import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");
const core = process.argv[2] || join(repo, "packages/core/package.json");
const require = createRequire(core);
const root = dirname(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
const { buildRerankBody } = await import(pathToFileURL(join(root, "lib/providers/reranker-remote.js")));
const { OpenAIEmbeddingProvider } = await import(pathToFileURL(join(root, "lib/providers/embedding-openai.js")));
const openai = Object.create(OpenAIEmbeddingProvider.prototype);
openai.dim = 2;
async function save(path, value) {
  await writeFile(join(here, path), `${JSON.stringify(value, null, 2)}\n`);
}
await save("openai-embeddings/batch.json", {
  request: openai._buildRequest("text-embedding-3-small", ["first", "second"]),
  response: { data: [{ index: 0, embedding: [0.1, 0.2] }, { index: 1, embedding: [0.3, 0.4] }] },
});
for (const protocol of ["cohere", "jina", "voyage", "tei"]) {
  const request = buildRerankBody(protocol, { model: "fixture-model", query: "query", documents: ["first", "second"], topN: 2 });
  const rows = [{ index: 0, relevance_score: 0.4 }, { index: 1, relevance_score: 0.9 }];
  const response = protocol === "tei" ? rows.map(({ index, relevance_score }) => ({ index, score: relevance_score }))
    : protocol === "voyage" ? { data: rows } : { results: rows };
  await save(protocol === "cohere" ? "cohere-rerank/request-response.json" : `remote-rerank/${protocol}.json`, { request, response });
}
