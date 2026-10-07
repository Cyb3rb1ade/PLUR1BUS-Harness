// Typed failures for the M5 collab library. Guardrail refusals are `code: "guardrail"` plus a `guardrail` reason.

export const COLLAB_ERROR_CODES = [
  "unauthorized", "not-found", "conflict", "invalid", "archived", "guardrail", "no-scope", "aborted", "storage",
] as const;
export type CollabErrorCode = (typeof COLLAB_ERROR_CODES)[number];

export const GUARDRAIL_REASONS = [
  "depth", "cycle", "self-call", "fanout", "pair-limit", "timeout", "token-budget", "cost-budget",
  "repeat", "project-boundary", "agent-inactive",
] as const;
export type GuardrailReason = (typeof GUARDRAIL_REASONS)[number];

export class CollabError extends Error {
  readonly code: CollabErrorCode;
  readonly reason: string | undefined;
  readonly guardrail: GuardrailReason | undefined;
  constructor(code: CollabErrorCode, message: string, extra: { reason?: string; guardrail?: GuardrailReason } = {}) {
    super(message);
    this.name = "CollabError";
    this.code = code;
    this.reason = extra.reason;
    this.guardrail = extra.guardrail;
  }
}

export function isCollabError(e: unknown): e is CollabError {
  return e instanceof CollabError;
}
