// RE-D167 (F1): the A1 gate. The Core uses an A1 surface only behind the engine's advertised flag, never by contract minor.

/** The A1 capability flags of contract 1.18.0; the pinned declaration still lists only `memoryLink`. */
export type A1Capability = "recallStats" | "knowledgePromotion" | "memoryCuration";

/** An absent or non-boolean flag is false, so the Node pin (1.17.0, no A1 flags) keeps every A1 surface off. */
export function hasA1Capability(engine: { readonly capabilities?: object }, flag: A1Capability): boolean {
  return (engine.capabilities as Partial<Record<A1Capability, unknown>> | undefined)?.[flag] === true;
}
