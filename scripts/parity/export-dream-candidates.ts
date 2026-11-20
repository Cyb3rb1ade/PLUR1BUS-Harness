import { pathToFileURL } from "node:url";
import { contentHash, evaluate, evaluateFallback, DEFAULT_GATES } from "../../packages/core/src/dreams/candidates.ts";
import { exporterMain } from "./lib.mjs";

export function buildDreamCandidateVectors() {
  const now = 100_000_000;
  const good = { expiresAt: now + 1, recalls: 3, uniqueQueries: 3, score: 0.75 };
  const hashes = ["fixture", "  fixture\r\n", "caf\u00e9", "cafe\u0301\u00a0", "一🙂", "\ufeff", "\u200b"];
  const gates = [
    ["all at threshold", good, DEFAULT_GATES],
    ["null score", { ...good, score: null }, DEFAULT_GATES],
    ["at expiry", { ...good, expiresAt: now }, DEFAULT_GATES],
    ["all failures recorded", { expiresAt: now - 1, recalls: 0, uniqueQueries: 0, score: 0 }, DEFAULT_GATES],
    ["utility is necessary", { ...good, recalls: 0 }, { ...DEFAULT_GATES, minRecallCount: 0 }],
    ["too few distinct queries", { ...good, uniqueQueries: 2 }, DEFAULT_GATES],
    ["below minimum score", { ...good, score: 0.749 }, DEFAULT_GATES],
    ["explicit thresholds", { ...good, recalls: 12, uniqueQueries: 2 }, { minScore: 0.8, minRecallCount: 2, minUniqueQueries: 2 }],
  ] as const;
  const ageBoundary = now - 86_400_000;
  const fallback = [
    ["age and importance", { createdAt: ageBoundary, importance: 0.75 }],
    ["age and repetitions", { createdAt: ageBoundary, repetitions: 2 }],
    ["one millisecond too recent", { createdAt: ageBoundary + 1, importance: 1 }],
    ["negative timestamp", { createdAt: -1, importance: 1 }],
    ["age alone", { createdAt: ageBoundary }],
    ["without age", { importance: 1, repetitions: 3 }],
    ["fractional repeats", { createdAt: ageBoundary, repetitions: 2.5 }],
    ["unsafe integer", { createdAt: ageBoundary, repetitions: Number.MAX_SAFE_INTEGER + 1 }],
    ["maximum safe integer", { createdAt: ageBoundary, repetitions: Number.MAX_SAFE_INTEGER }],
    ["below importance and repeats", { createdAt: ageBoundary, importance: 0.749, repetitions: 1 }],
  ] as const;
  return { candidates: {
    hashes: hashes.map(text => ({ text, hash: contentHash(text) })),
    gates: gates.map(([name, input, config]) => ({ name, input, config, now, result: evaluate(input, now, config) })),
    fallback: fallback.map(([name, input]) => ({ name, input, now, result: evaluateFallback(input, now) })),
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "dreams", build: buildDreamCandidateVectors });
}
