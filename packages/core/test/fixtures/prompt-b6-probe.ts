// B6 probe (ADR-010 R3): renders the synthetic corpus for two turns, twice each with a fresh builder, and prints the zone
// hashes plus a digest of the full segment bytes as one JSON line. The B6 test and `pnpm bench` run it in separate
// processes and compare the lines byte for byte. Nothing here reads a clock, the environment or the filesystem.
import { createPromptBuilder } from "../../src/prompt/builder.ts";
import { canonicalJson, sha256Hex } from "../../src/prompt/canonical.ts";
import { corpusInput } from "./prompt-corpus.ts";

const out: Record<string, unknown[]> = {};
for (const turns of [2, 3]) {
  out[String(turns)] = [0, 1].map(() => {
    const r = createPromptBuilder().render(corpusInput(turns));
    const { tools, system, memory } = r.zoneHashes;
    return { zones: { tools, system, memory }, prefixHashes: r.prefixHashes, segments: sha256Hex(canonicalJson(r.segments)) };
  });
}
process.stdout.write(`${JSON.stringify(out)}\n`);
