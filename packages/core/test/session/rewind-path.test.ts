/** D120 H4: hidden transcript ranges are a reversible view and have an unambiguous audit digest. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { activePath, activeSummaries, hiddenDigest, type RewindRange } from "../../src/session/rewind-path.ts";

const range = (from: number, to: number, undoneAt: number | null = null): RewindRange => ({
  hiddenFromSeq: from,
  hiddenToSeq: to,
  undoneAt,
});

describe("D120 rewind path", () => {
  it("hides inclusive ranges while preserving the original prefix and message bytes", () => {
    const messages = Array.from({ length: 8 }, (_, i) => Object.freeze({ seq: i + 1, text: `message ${i + 1}` }));
    const before = JSON.stringify(messages);
    const view = activePath(messages, [range(3, 5)]);
    assert.deepEqual(view.map(message => message.seq), [1, 2, 6, 7, 8]);
    assert.equal(view[0], messages[0]);
    assert.equal(view[1], messages[1]);
    assert.equal(JSON.stringify(messages), before);
  });

  it("restores an undone range while keeping other active rewinds hidden", () => {
    const messages = [1, 2, 3, 4, 5, 6, 7].map(seq => ({ seq }));
    assert.deepEqual(activePath(messages, [range(2, 3, 0), range(3, 5)]).map(message => message.seq), [1, 2, 6, 7]);
    assert.deepEqual(activePath(messages, [range(2, 3, 0), range(3, 5, 7)]), messages);
  });

  it("handles disjoint and overlapping rewinds independently of their input order", () => {
    const messages = [1, 2, 3, 4, 5, 6, 7, 8].map(seq => ({ seq }));
    const rewinds = [range(6, 7), range(2, 3), range(3, 4)];
    assert.deepEqual(activePath(messages, rewinds).map(message => message.seq), [1, 5, 8]);
    assert.deepEqual(activePath(messages, rewinds.toReversed()).map(message => message.seq), [1, 5, 8]);
  });

  it("drops every summary touching a hidden range without modifying stored summaries", () => {
    const summaries = [
      { id: "before", fromSeq: 1, toSeq: 2 },
      { id: "left-edge", fromSeq: 2, toSeq: 3 },
      { id: "inside", fromSeq: 4, toSeq: 4 },
      { id: "right-edge", fromSeq: 5, toSeq: 6 },
      { id: "spanning", fromSeq: 1, toSeq: 8 },
      { id: "after", fromSeq: 6, toSeq: 8 },
    ];
    const before = JSON.stringify(summaries);
    assert.deepEqual(activeSummaries(summaries, [range(3, 5)]).map(summary => summary.id), ["before", "after"]);
    assert.equal(JSON.stringify(summaries), before);
    assert.deepEqual(activeSummaries(summaries, [range(3, 5, 0)]), summaries);
  });
});

describe("D120 hidden digest", () => {
  it("hashes an ordered, length-delimited UTF-8 encoding of message ids and exact texts", () => {
    const messages = [{ id: "a", text: "hello\n世界" }, { id: "b", text: "two" }];
    const encoded = '[["a","hello\\n世界"],["b","two"]]';
    const expected = createHash("sha256").update(encoded, "utf8").digest("hex");
    assert.equal(hiddenDigest(messages), expected);
    assert.notEqual(hiddenDigest(messages.toReversed()), expected);
    assert.notEqual(hiddenDigest([{ id: "a", text: "hello\n世界 " }, messages[1]!]), expected);
  });

  it("cannot collide through ambiguous concatenation of adjacent ids and texts", () => {
    assert.notEqual(hiddenDigest([{ id: "ab", text: "c" }]), hiddenDigest([{ id: "a", text: "bc" }]));
    assert.notEqual(hiddenDigest([{ id: "a", text: "b" }, { id: "c", text: "d" }]),
      hiddenDigest([{ id: "a", text: "bc" }, { id: "d", text: "" }]));
  });
});
