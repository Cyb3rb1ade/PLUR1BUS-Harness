import type { ProbeResult } from "./types.ts";

export type UnavailableReason = "unreachable" | "timeout" | "refused" | "protocol" | "no_models";

/** What the rest of the system needs to know about a local provider: can it serve a chat right now, and if not, why. */
export interface ProviderAvailability {
  status: "available" | "unavailable";
  reason?: UnavailableReason;
  /** Short and credential-free (comes from the probe). */
  detail?: string;
  models: readonly string[];
}

/**
 * RULING: a pure mapping, no I/O. `ok` is available; `empty` is unavailable/`no_models` (nothing to chat with); every
 * other probe state is unavailable and carries that state as its reason.
 */
export function availabilityOf(result: Pick<ProbeResult, "state" | "models" | "detail">): ProviderAvailability {
  const models = result.models.map((m) => m.id);
  const detail = result.detail === undefined ? {} : { detail: result.detail };
  if (result.state === "ok") return { status: "available", models, ...detail };
  const reason: UnavailableReason = result.state === "empty" ? "no_models" : result.state;
  return { status: "unavailable", reason, models, ...detail };
}
