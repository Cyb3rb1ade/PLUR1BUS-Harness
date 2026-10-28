/** Pure provenance and idempotency identifiers; callers supply the destination and import run owned by M. */
import { createHash } from "node:crypto";
import { MEMORY_CATEGORIES, normalizeMemoryText, type MemoryCategory, type MemorySource } from "./model.ts";

/** Fields for the prompt source reference; entry indices are one-based. */
export interface PromptSourceRefInput {
  provider: string;
  category: MemoryCategory;
  index: number;
  originalDate: string;
  source: MemorySource;
  runId: string;
}

/** Stable destination identity is supplied by the caller, without allocating a run or choosing a scope. */
export interface PromptIdempotencyInput {
  provider: string;
  category: MemoryCategory;
  target: string;
  text: string;
}

/** Bounded provenance keeps the complete rollback selector; invalid metadata throws a content-free RangeError. */
export function createPromptSourceRef(input: PromptSourceRefInput): string {
  if (!Number.isSafeInteger(input.index) || input.index < 1
      || !MEMORY_CATEGORIES.includes(input.category)
      || (input.source !== "memory" && input.source !== "chat")
      || !/^[A-Za-z0-9._-]+$/u.test(input.runId)
      || !input.provider || !input.provider.isWellFormed() || !input.originalDate.isWellFormed()) {
    throw new RangeError("Invalid prompt source metadata");
  }
  const suffix = `:${input.category}#${input.index};date=${encodeURIComponent(input.originalDate)}`
    + `;src=${input.source};run=${input.runId}`;
  const budget = 500 - "prompt:".length - suffix.length;
  if (budget < 1) {
    throw new RangeError("Prompt source metadata exceeds 500 characters");
  }
  let provider = "";
  for (const character of input.provider) {
    const encoded = encodeURIComponent(character);
    if (provider.length + encoded.length > budget) break;
    provider += encoded;
  }
  if (!provider) {
    throw new RangeError("Prompt source metadata exceeds 500 characters");
  }
  // The Engine truncates sourceRef at 500 characters (contract 1.11.0); reserve the entire run selector first.
  return `prompt:${provider}${suffix}`;
}

/** SHA-256 of provider, category, destination, and canonical text; dates and run IDs do not participate. */
export function createPromptIdempotencyKey(input: PromptIdempotencyInput): string {
  const tuple = [input.provider, input.category, input.target, normalizeMemoryText(input.text)];
  return createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
}
