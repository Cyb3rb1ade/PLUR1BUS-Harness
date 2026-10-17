// Candidate producer (ADR-009 C1): maps a memory port onto CandidateInput[]. The pinned engine has no
// recall/query stats API, so tests drive a fake; production never invents those fields.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCandidateSource, itemsFromEngineList, type CandidateMemoryItem } from "../../src/dreams/producer.ts";

describe("dreams candidate producer", () => {
  it("Producer yields candidates against a fake engine.", async () => {
    const items: CandidateMemoryItem[] = [
      { content: "a recalled fact about Berlin", partition: "agent-private", recalls: 4, uniqueQueries: 3, score: 0.81 },
      { content: "another capture", recalls: 1 },
    ];
    const source = createCandidateSource({ list: async (agentId) => {
      assert.equal(agentId, "alpha");
      return items;
    } });
    const pulled = await source.pull("alpha");
    assert.equal(pulled.length, 2);
    assert.deepEqual(pulled[0], { content: "a recalled fact about Berlin", partition: "agent-private", recalls: 4, uniqueQueries: 3, score: 0.81 });
    assert.equal(pulled[1]!.content, "another capture");
    assert.equal(pulled[1]!.recalls, 1);
    assert.equal(pulled[1]!.uniqueQueries, undefined);
    assert.equal(pulled[1]!.score, undefined);
  });

  it("does not invent recall or query stats the engine did not report", async () => {
    const source = createCandidateSource({
      list: () => [{ content: "content only", score: 0.9 }],
    });
    const [c] = await source.pull("alpha");
    assert.equal(c!.content, "content only");
    assert.equal(c!.score, 0.9);
    assert.equal("recalls" in c!, false);
    assert.equal("uniqueQueries" in c!, false);
    assert.equal("partition" in c!, false);
  });

  it("an empty list from the memory port is an empty shortlist, not a fabricated candidate", async () => {
    const source = createCandidateSource({ list: async () => [] });
    assert.deepEqual(await source.pull("alpha"), []);
  });

  it("a workspace/user card is not ingested as agent-private", async () => {
    const mapped = itemsFromEngineList({
      truncated: false,
      items: [
        { text: "same text", scope: "workspace" },
        { text: "same text", scope: "user" },
        { text: "same text", scope: "agent-private" },
      ],
    });
    assert.deepEqual(mapped, [{ content: "same text", partition: "agent-private" }]);
    const source = createCandidateSource({
      list: () => [
        { content: "workspace fact", partition: "workspace" },
        { content: "user fact", partition: "user" },
        { content: "private fact", partition: "agent-private" },
      ],
    });
    assert.deepEqual(await source.pull("alpha"), [{ content: "private fact", partition: "agent-private" }]);
  });

  it("a truncated engine listing throws instead of dropping the rest of the private corpus", () => {
    assert.throws(
      () => itemsFromEngineList({ truncated: true, items: [{ text: "kept", scope: "agent-private" }] }),
      (e: unknown) => e instanceof Error && /truncated/.test(e.message),
    );
  });
});
