// Optional live smoke for rerank adapters, and the producer of the frozen mapping table (ADR-006 Action 3):
// every target that runs prints the response structure it actually returned, then the Markdown table is printed once.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createRerankAdapter } from "../../src/registry.ts";
import { renderRerankMappingTable } from "../../src/rerank/shapes.ts";
import type { RerankProviderId } from "../../src/config.ts";
import { LIVE, RERANK_TARGETS, liveGetSecret, recordingFetch, skipReason } from "./helpers.ts";

const observed: Partial<Record<RerankProviderId, string>> = {};
const DOCS = ["A cat sat on the mat.", "Quarterly invoices must be reconciled before the ledger closes.", "The kitten rested on the rug."];

for (const t of RERANK_TARGETS) {
  const skip = skipReason(...t.needs);
  test(`live rerank/${t.name}`, { skip, timeout: 60_000 }, async () => {
    const { fetch, signatures } = recordingFetch();
    const adapter = createRerankAdapter(t.config(), { getSecret: liveGetSecret, fetch });
    try {
      const out = await adapter.rerank("Where did the cat sit?", DOCS, { topN: 3 });
      assert.equal(out.length, 3);
      assert.notEqual(out[0]!.index, 1, "the unrelated document must not rank first");
      observed[t.name] = `ok: ${signatures.at(-1) ?? "no response"}`;
    } catch (e) {
      observed[t.name] = `MISMATCH: ${(e as Error).message.slice(0, 120)}${signatures.length > 0 ? ` (server returned ${signatures.at(-1)})` : ""}`;
      throw e;
    }
  });
}

after(() => {
  if (!LIVE) return;
  console.log("\nRerank mapping table (live run):\n\n" + renderRerankMappingTable(observed) + "\n");
});
