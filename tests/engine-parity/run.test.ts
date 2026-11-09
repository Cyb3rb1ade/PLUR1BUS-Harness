import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forms, MARKERS } from "../system/redaction-fixture.ts";
import { compare, normalizeStep } from "./lib/diff.ts";
import { fixtureLlm, promptHash } from "./lib/fixtures.ts";
import { readGolden } from "./lib/scenario.ts";

test("ignores volatile fields while keeping ordered IDs, block text and counts exact", () => {
  const input = {
    ids: ["a", "b"], count: 2, blocks: [{ name: "memories", text: "same" }],
    timestamp: 1, runId: "node", timing: { totalMs: 10 },
  };
  const expected = normalizeStep(input);
  assert.deepEqual(compare(expected, normalizeStep({
    ...input, timestamp: 2, runId: "rust", timing: { phases: null },
  })), []);
  assert.deepEqual(compare(expected, normalizeStep({ ...input, ids: ["b", "a"] })),
    ["/result/ids/0: value differs", "/result/ids/1: value differs"]);
  assert.deepEqual(compare(expected, normalizeStep({ ...input, count: 2.0000001 })),
    ["/result/count: value differs"]);
  assert.deepEqual(compare(expected, normalizeStep({ ...input, blocks: [{ name: "memories", text: "other" }] })),
    ["/result/blocks/0/text: value differs"]);
});

test("tolerates score roundoff and identifies a mismatching path", () => {
  const expected = normalizeStep({ items: [{ score: 0.5 }] });
  assert.deepEqual(compare(expected, normalizeStep({ items: [{ score: 0.5000009 }] })), []);
  assert.deepEqual(compare(expected, normalizeStep({ items: [{ score: 0.500002 }] })),
    ["/result/items/0/score: exceeds tolerance 0.000001"]);
  assert.deepEqual(compare(expected, normalizeStep({ items: [{ score: 0.500002 }] }), { scores: 0.001 }), []);
});

test("trace comparison checks the shape and the named numeric paths", () => {
  const expected = normalizeStep({ blocks: [], trace: { candidateCount: 2, scores: [0.5], label: "node" } });
  const actual = normalizeStep({ blocks: [], trace: { candidateCount: 1, scores: [0.5000001], label: "rust" } });
  assert.deepEqual(compare(expected, actual), []);
  assert.deepEqual(compare(expected, actual, {}, ["/candidateCount", "/scores/0"]),
    ["/trace/candidateCount: value differs"]);
  assert.deepEqual(compare(expected, normalizeStep({ blocks: [], trace: { candidateCount: 2, scores: [0.5] } })),
    ["/trace/label: missing field"]);
  assert.deepEqual(compare(expected, actual, {}, ["/typo"]), ["/trace/typo: numeric trace field required"]);
});

test("a missing golden names the command that records it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "parity-golden-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => readGolden(join(root, "missing.json"), "recall/plain"),
    /pnpm parity --record tests\/engine-parity\/scenarios\/recall\/plain\.json/);
});

test("offline completions use the prompt hash and missing answers name the first 80 characters", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "parity-llm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const messages = [{ role: "user", content: "synthetic prompt ".repeat(8) }];
  const hash = promptHash(messages);
  const file = join(root, "answers.json");
  writeFileSync(file, JSON.stringify({ [hash]: { text: "recorded" } }));
  const llm = fixtureLlm(file);
  assert.deepEqual(await llm.complete({ messages }), { text: "recorded" });
  const changed = [{ role: "user", content: `changed ${messages[0]!.content}` }];
  await assert.rejects(() => llm.complete({ messages: changed }), (error: Error) => {
    assert.ok(error.message.includes(promptHash(changed)));
    assert.ok(error.message.includes(changed[0]!.content.slice(0, 80)));
    assert.ok(!error.message.includes(changed[0]!.content));
    return true;
  });
});

test("rejects secret probes before omitting even ignored fields, without printing the probe", () => {
  for (const marker of MARKERS) for (const form of forms(marker)) {
    assert.throws(() => normalizeStep({ timing: { text: form } }),
      (error: Error) => error.message.includes("secret marker") && !error.message.includes(form));
  }
});
