/** Exercises rank validation and byte-level BPE conversion without network or a bundled vocabulary. */
import assert from "node:assert/strict";
import { test } from "node:test";

const converter = new URL("./tiktoken-to-json.mjs", import.meta.url);
const bytes = () => Array.from({ length: 256 }, (_, byte) => `${Buffer.from([byte]).toString("base64")} ${byte}`);
const ranks = (...extra) => [
  ...bytes(), ...extra.map(([text, rank]) => `${Buffer.from(text).toString("base64")} ${rank}`),
].join("\n") + "\n";
async function convert(input) {
  const { convertTiktokenToJson } = await import(converter);
  return convertTiktokenToJson(input);
}

test("all 256 bytes keep their token IDs and byte-level whitespace characters", async () => {
  const output = JSON.parse(await convert(ranks()));
  assert.equal(output.model.type, "BPE");
  assert.equal(output.model.vocab["!"], 33);
  assert.equal(output.model.vocab["Ġ"], 32);
  assert.equal(output.model.vocab["Ċ"], 10);
  assert.equal(Object.keys(output.model.vocab).length, 256);
  assert.deepEqual(output.added_tokens, [], "literal user markers must not become special tokens");
  assert.equal(output.model.ignore_merges, true, "tiktoken first checks a whole regex piece in its vocabulary");
  assert.equal(output.pre_tokenizer.pretokenizers[1].add_prefix_space, false);
  assert.equal(output.pre_tokenizer.pretokenizers[1].use_regex, false);
});

test("all valid token splits follow result rank and then child rank", async () => {
  const output = JSON.parse(await convert(ranks(["ab", 256], ["bc", 257], ["abc", 258])));
  assert.deepEqual(output.model.merges, [["a", "b"], ["b", "c"], ["a", "bc"], ["ab", "c"]]);
  assert.equal(output.model.vocab.abc, 258);
});

test("conversion is byte stable regardless of input line order", async () => {
  const input = ranks(["ab", 256], ["bc", 257]);
  const output = await convert(input);
  assert.equal(output, await convert(input.trimEnd().split("\n").reverse().join("\n") + "\n"));
  assert.ok(output.endsWith("\n"));
});

test("missing byte tokens, duplicate IDs and duplicate byte strings fail closed", async () => {
  await assert.rejects(() => convert(bytes().slice(1).join("\n")), /byte|contiguous/i);
  await assert.rejects(() => convert(ranks() + "YWI= 255\n"), /duplicate.*rank/i);
  await assert.rejects(() => convert(ranks() + "YQ== 256\n"), /duplicate.*token/i);
});

test("malformed ranks, gaps and noncanonical base64 are refused", async () => {
  await assert.rejects(() => convert(ranks() + "YWI= -1\n"), /rank|line/i);
  await assert.rejects(() => convert(ranks(["ab", 257])), /contiguous/i);
  await assert.rejects(() => convert(ranks() + "YQ 256\n"), /base64/i);
  await assert.rejects(() => convert(ranks() + "%% 256\n"), /base64|line/i);
});
