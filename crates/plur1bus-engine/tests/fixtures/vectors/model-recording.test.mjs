import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { buildSentences, f32Decimal, stringifyRecording, assertJinaConsent, assertOutputDirectory,
  metadataOnlyProfile, encodeThenCut, recordModels, assertBgeLicence, readBgeLicence } from "./model-recording.mjs";
import * as recording from "./model-recording.mjs";

test("the corpus contains 25 literal German and 25 literal English inputs plus three distinct extras", () => {
  const cases = buildSentences();
  assert.equal(cases.length, 53);
  assert.equal(cases.slice(0, 50).filter(row => row.language === "de").length, 25);
  assert.equal(cases.slice(0, 50).filter(row => row.language === "en").length, 25);
  assert.ok(cases.slice(0, 50).some(row => row.text === ""));
  assert.ok(cases.slice(0, 50).some(row => /🧠|🌍/u.test(row.text)));
  assert.deepEqual(cases.slice(50).map(row => row.kind), ["over-cap", "nfd", "compound"]);
  assert.equal(cases[51].text, cases[51].text.normalize("NFD"));
  assert.notEqual(cases[51].text, cases[51].text.normalize("NFC"));
  assert.ok(cases[50].text.split(/\s+/u).length > 8192);
});

test("vector serialization uses short decimals that round trip every finite float32", () => {
  const bits = new Uint32Array(1), value = new Float32Array(bits.buffer);
  for (let i = 0; i < 2000; i++) {
    bits[0] = Math.imul(i + 1, 2654435761) >>> 0;
    if (!Number.isFinite(value[0])) continue;
    const decimal = f32Decimal(value[0]);
    assert.ok(Object.is(Math.fround(Number(decimal)), value[0]), decimal);
    assert.ok(decimal.length <= String(value[0]).length);
  }
  assert.equal(f32Decimal(Math.fround(0.1)), "0.1");
  assert.equal(f32Decimal(Math.fround(0.0001234568)), "1.234568e-4");
  assert.equal(f32Decimal(-0), "-0");
  assert.throws(() => f32Decimal(Infinity), /finite/);
  const text = stringifyRecording({ query: new Float32Array([0.1, 1.2345678]) });
  assert.equal(text.trim(), '{"query":[0.1,1.2345678]}');
});

test("NC consent requires both explicit flags and an external temporary output directory", () => {
  assert.throws(() => assertJinaConsent({}), /PLUR1BUS_ALLOW_TEST_INTERNALS/);
  assert.throws(() => assertJinaConsent({ PLUR1BUS_ALLOW_TEST_INTERNALS: "1" }), /PLUR1BUS_TEST_ACCEPT_NC_MODELS/);
  assert.doesNotThrow(() => assertJinaConsent({ PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_ACCEPT_NC_MODELS: "1" }));
  assert.throws(() => assertOutputDirectory({ mode: "--jina", repositoryRoot: "/repository", outputDir: "/repository/temp", explicit: true }), /outside/);
  assert.throws(() => assertOutputDirectory({ mode: "--jina", repositoryRoot: "/repository", outputDir: join(tmpdir(), "jina"), explicit: false }), /explicit/);
  assert.doesNotThrow(() => assertOutputDirectory({ mode: "--jina", repositoryRoot: "/repository", outputDir: join(tmpdir(), "jina"), explicit: true }));
});

test("tokenizer-only preparation cannot include an ONNX payload", () => {
  const profile = metadataOnlyProfile({ artifacts: ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"].map(path => ({ path })) });
  assert.deepEqual(profile.artifacts.map(row => row.path), ["config.json", "tokenizer.json", "tokenizer_config.json"]);
});

test("token ids are fully encoded with special tokens before the finished arrays are cut", async () => {
  const tokenizer = async (_text, options) => {
    assert.equal(options.add_special_tokens, true);
    assert.equal(options.truncation, false);
    assert.equal(options.return_tensor, false);
    return { input_ids: [0, 10, 11, 12, 2], attention_mask: [1, 1, 1, 1, 1] };
  };
  const row = await encodeThenCut(tokenizer, "example", 3);
  assert.deepEqual(row.input_ids, [0, 10, 11]);
  assert.deepEqual(row.attention_mask, [1, 1, 1]);
  assert.equal(row.fullLength, 5);
  assert.equal(row.fullLastTokenId, 2);
  assert.equal(row.closingTokenLost, true);
});

test("the Jina recorder refuses before importing or fetching any NC model", async () => {
  let imported = false;
  await assert.rejects(recordModels({ environment: {}, repositoryRoot: "/repository", fixtureDir: "/repository/fixtures",
    importEngine: () => { imported = true; throw new Error("must never access a model"); } }, "--jina"), /PLUR1BUS_ALLOW_TEST_INTERNALS/u);
  assert.equal(imported, false);
});

test("BGE cannot produce goldens from an unverified repository licence or a claimed approval flag", () => {
  const profile = { model: "woxpas-ai/bge-reranker-v2-m3-onnx", revision: "c44ebc43de724ae8816668bb44d2e728e17faa18", artifacts: [] };
  assert.throws(() => assertBgeLicence(profile), /verified pinned LICENSE/u);
  assert.throws(() => assertBgeLicence({ ...profile, approved: true, license: "MIT" }), /verified pinned LICENSE/u);
  assert.throws(() => assertBgeLicence({ ...profile, license: "unresolved", artifacts: [{ path: "LICENSE", sha256: "a".repeat(64) }] }), /verified pinned LICENSE/u);
});

test("BGE goldens need exactly the committed receipt of the original's Apache-2.0 licence", async () => {
  const profile = { model: "woxpas-ai/bge-reranker-v2-m3-onnx", revision: "c44ebc43de724ae8816668bb44d2e728e17faa18", artifacts: [] };
  const licence = await readBgeLicence(fileURLToPath(new URL(".", import.meta.url)));
  assert.doesNotThrow(() => assertBgeLicence(profile, licence));
  const refused = [
    [{ ...profile, revision: "0".repeat(40) }, licence],
    [profile, { ...licence, text: Buffer.concat([licence.text, Buffer.from(" ")]) }],
    [profile, { ...licence, receipt: { ...licence.receipt, license: "MIT" } }],
    [profile, { ...licence, receipt: { ...licence.receipt, upstream: { ...licence.receipt.upstream, revision: "main" } } }],
    [profile, { ...licence, receipt: { ...licence.receipt, extra: true } }],
    [profile, { ...licence, receipt: { ...licence.receipt, decision: undefined } }],
  ];
  for (const [candidate, given] of refused) assert.throws(() => assertBgeLicence(candidate, given), /verified pinned LICENSE/u);
});

test("reranker ranking cases record one query against five normal documents and preserve provider hits", async () => {
  assert.equal(typeof recording.recordRerankerRankingCases, "function");
  const sentences = buildSentences(), calls = [];
  const provider = { rerank: async (query, documents, topN) => {
    calls.push({ query, documents, topN });
    return [{ index: 4, relevance_score: 0.9 }, { index: 1, score: 0.7 }, { index: 3, score: 0.4 }];
  } };
  const cases = await recording.recordRerankerRankingCases(provider, sentences);
  assert.equal(cases.length, 2);
  for (const [index, row] of cases.entries()) {
    assert.equal(row.topN, 3);
    assert.equal(row.docIds.length, 5);
    assert.equal(new Set(row.docIds).size, 5);
    assert.ok(row.docIds.every(id => sentences.find(sentence => sentence.id === id)?.kind === "normal"));
    assert.equal(calls[index].query, sentences.find(sentence => sentence.id === row.queryId).text);
    assert.deepEqual(calls[index].documents, row.docIds.map(id => sentences.find(sentence => sentence.id === id).text.trim().split(/\s+/u).filter(Boolean).slice(0, 150).join(" ")));
    assert.equal(calls[index].topN, 3);
    assert.deepEqual(row.hits, [{ index: 4, score: 0.9 }, { index: 1, score: 0.7 }, { index: 3, score: 0.4 }]);
  }
});

test("reranker ranking recordings reject invalid provider indices and scores", async () => {
  assert.equal(typeof recording.recordRerankerRankingCases, "function");
  for (const hits of [
    [{ index: 5, score: 0.9 }, { index: 1, score: 0.7 }, { index: 3, score: 0.4 }],
    [{ index: 0, score: Infinity }, { index: 1, score: 0.7 }, { index: 3, score: 0.4 }],
    [{ index: 1, score: 0.9 }, { index: 1, score: 0.7 }, { index: 3, score: 0.4 }],
  ]) await assert.rejects(recording.recordRerankerRankingCases({ rerank: async () => hits }, buildSentences()), /reranker/u);
});

test("encodeThenCut uses the actual pinned Transformers.js public tokenizer API", async () => {
  const require = createRequire(new URL("../../../../../packages/core/package.json", import.meta.url));
  const engineRoot = dirname(require.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
  const engineRequire = createRequire(join(engineRoot, "package.json"));
  const entry = engineRequire.resolve("@huggingface/transformers");
  assert.equal(JSON.parse(await readFile(join(dirname(entry), "../package.json"), "utf8")).version, "4.3.1");
  const { importTransformersBehindSharpProbe } = await import(pathToFileURL(join(engineRoot, "lib/native/sharp-unavailable.js")).href);
  const mod = await importTransformersBehindSharpProbe({});
  // This tiny hand-authored vocabulary is independent of every model and licence.
  const tokenizer = new mod.PreTrainedTokenizer({ version: "1.0", truncation: null, padding: null,
    added_tokens: [], normalizer: null, pre_tokenizer: { type: "Whitespace" },
    post_processor: { type: "BertProcessing", sep: ["[SEP]", 2], cls: ["[CLS]", 1] }, decoder: null,
    model: { type: "WordLevel", vocab: { "[UNK]": 0, "[CLS]": 1, "[SEP]": 2, one: 3, two: 4, three: 5 }, unk_token: "[UNK]" } },
  { unk_token: "[UNK]", cls_token: "[CLS]", sep_token: "[SEP]", model_max_length: 3 });
  assert.deepEqual(await encodeThenCut(tokenizer, "one two three", 3), {
    input_ids: [1, 3, 4], attention_mask: [1, 1, 1], fullLength: 5, fullLastTokenId: 2,
    truncated: true, closingTokenLost: true,
  });
});
