// The candidate guards of ADR-009: dedupe (the table's UNIQUE), expiry, and the utility gate with a gate-by-gate
// decision record. Pure: no clock, no store. The engine decides what to promote; this records why a candidate may not be.
import { createHash } from "node:crypto";
import type { CandidateRow } from "./types.ts";

export interface GateConfig { minScore: number; minRecallCount: number; minUniqueQueries: number }
/** The calibrated defaults ADR-009 takes from its reference model: minScore 0.75, 3 recalls, 3 distinct queries. */
export const DEFAULT_GATES: GateConfig = { minScore: 0.75, minRecallCount: 3, minUniqueQueries: 3 };

export interface GateResult { gate: "expiry" | "utility" | "recall-count" | "unique-queries" | "score"; passed: boolean; detail?: string }
export interface Decision { promote: boolean; rejectedBy: GateResult["gate"] | null; gates: GateResult[]; at: number }

export const contentHash = (content: string): string => createHash("sha256").update(content.normalize("NFC").trim()).digest("hex");

/** Every gate is evaluated (no short-circuit) so the audit record shows all failures; `rejectedBy` is the first. */
export function evaluate(c: Pick<CandidateRow, "expiresAt" | "recalls" | "uniqueQueries" | "score">, now: number, g: GateConfig = DEFAULT_GATES): Decision {
  const gates: GateResult[] = [
    { gate: "expiry", passed: c.expiresAt > now, ...(c.expiresAt > now ? {} : { detail: `expired at ${c.expiresAt}` }) },
    // #142393's inverted incentive: a candidate nobody ever recalled is never promoted, whatever its raw score.
    { gate: "utility", passed: c.recalls > 0, ...(c.recalls > 0 ? {} : { detail: "recalls = 0" }) },
    { gate: "recall-count", passed: c.recalls >= g.minRecallCount, ...(c.recalls >= g.minRecallCount ? {} : { detail: `${c.recalls} < ${g.minRecallCount}` }) },
    { gate: "unique-queries", passed: c.uniqueQueries >= g.minUniqueQueries, ...(c.uniqueQueries >= g.minUniqueQueries ? {} : { detail: `${c.uniqueQueries} < ${g.minUniqueQueries}` }) },
    { gate: "score", passed: c.score === null || c.score >= g.minScore, ...(c.score === null || c.score >= g.minScore ? {} : { detail: `${c.score} < ${g.minScore}` }) },
  ];
  const failed = gates.find((x) => !x.passed);
  return { promote: failed === undefined, rejectedBy: failed?.gate ?? null, gates, at: now };
}
