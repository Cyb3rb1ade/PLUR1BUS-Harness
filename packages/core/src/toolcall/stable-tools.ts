// Stable tool offers (N-F1–F3): scoped core tools first, then retained session offers and newly relevant tools.
/** The fixed discovery/read core has priority over the session's accumulated relevant tools. */
export const CORE_TOOL_NAMES: readonly string[] = Object.freeze([
  "capabilities.search", "skill.load", "skill.read", "file.read", "file.list", "file.stat",
  "web.search", "web.fetch",
]);
/** Already-admitted tool names and the effective model-family tool cap at the current turn boundary. */
export interface StableToolOfferInput {
  /** Already filtered by current registration, agent scope and policy. Revocations always win over retention. */
  available: readonly string[];
  previous?: readonly string[];
  relevant?: readonly string[];
  maxTools: number;
}
/** Sorted offered names, omitted names and evidence that the fixed core exceeds the model's own limit. */
export interface StableToolOffer {
  names: string[];
  dropped: string[];
  coreOverflow: boolean;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Called at turn boundaries only. The caller owns persisted session state and mid-turn discovery queues. */
export function stableToolOffer(input: StableToolOfferInput): StableToolOffer {
  if (!Number.isSafeInteger(input.maxTools) || input.maxTools < 0) throw Error("invalid model tool limit");
  const available = new Set(input.available);
  const core = [
    ...CORE_TOOL_NAMES.filter(name => available.has(name)),
    ...[...available].filter(name => name.startsWith("memory.")).sort(compare),
  ];
  const admitted = new Set<string>();
  const priority = [...core, ...[...new Set(input.previous ?? [])].sort(compare), ...(input.relevant ?? [])];
  for (const name of priority) {
    if (admitted.size >= input.maxTools) break;
    if (available.has(name)) admitted.add(name);
  }
  return {
    names: [...admitted].sort(compare),
    dropped: [...available].filter(name => !admitted.has(name)).sort(compare),
    coreOverflow: core.length > input.maxTools,
  };
}
