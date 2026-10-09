// Versioned price tables (L8). Data only: no live call, no network. Tables are append-only; an event is priced once,
// at record time, from the table in force at the event's own time, and keeps that cost and version forever.

/** USD per million tokens. A missing cache price means the model has none declared (cache tokens then make the call unpriced). */
export interface ModelPrice { input: number; output: number; cacheRead?: number; cacheWrite?: number; media?: MediaPrices }
export interface PriceTable { version: string; effectiveFrom: number; models: Record<string, ModelPrice> }
export interface TokenCounts { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

export class PriceBook {
  private readonly tables: readonly PriceTable[];
  constructor(tables: readonly PriceTable[]) {
    if (tables.length === 0) throw new RangeError("a price book needs at least one table");
    const seen = new Set<string>();
    for (const t of tables) {
      if (seen.has(t.version)) throw new RangeError(`duplicate price table version ${t.version}`);
      seen.add(t.version);
    }
    const copied = structuredClone(tables);
    for (const table of copied) {
      if (!table.version || !Number.isSafeInteger(table.effectiveFrom) || table.effectiveFrom < 0) throw new RangeError("invalid price table");
      for (const price of Object.values(table.models)) {
        for (const rate of [price.input, price.output, price.cacheRead ?? 0, price.cacheWrite ?? 0]) {
          if (!Number.isFinite(rate) || rate < 0) throw new RangeError("invalid token price");
        }
        for (const units of Object.values(price.media ?? {})) {
          for (const rate of Object.values(units) as number[]) if (!Number.isSafeInteger(rate) || rate < 0) throw new RangeError("invalid media price");
          Object.freeze(units);
        }
        if (price.media) Object.freeze(price.media);
        Object.freeze(price);
      }
      Object.freeze(table.models); Object.freeze(table);
    }
    this.tables = Object.freeze([...copied].sort((a, b) => b.effectiveFrom - a.effectiveFrom));
  }
  /** The newest table effective at `ts`, or null before the first one. */
  at(ts: number): PriceTable | null { return this.tables.find((t) => t.effectiveFrom <= ts) ?? null; }
  latest(): PriceTable { return this.tables[0]!; }
}

export function lookupPrice(table: PriceTable, model: string, provider?: string): ModelPrice | null {
  return (provider !== undefined ? table.models[`${provider}/${model}`] : undefined) ?? table.models[model] ?? null;
}

/** Cost in integer micro-USD (USD per million tokens x tokens = micro-USD), or null when the call cannot be priced. */
export function costMicros(table: PriceTable, model: string, provider: string | undefined, u: TokenCounts): number | null {
  const p = lookupPrice(table, model, provider);
  if (!p) return null;
  if ((u.cacheReadTokens > 0 && p.cacheRead === undefined) || (u.cacheWriteTokens > 0 && p.cacheWrite === undefined)) return null;
  return Math.round(u.inputTokens * p.input) + Math.round(u.outputTokens * p.output)
    + Math.round(u.cacheReadTokens * (p.cacheRead ?? 0)) + Math.round(u.cacheWriteTokens * (p.cacheWrite ?? 0));
}

/** The shipped table. Verify against the vendors' published prices before relying on cost limits; unknown models are unpriced and a hard cost limit refuses them. */
export const SHIPPED_PRICE_TABLES: readonly PriceTable[] = [
  {
    version: "2026-10-06",
    effectiveFrom: Date.UTC(2026, 9, 6),
    models: {
      "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    },
  },
];

/** Integer micro-USD per image or video second, keyed by an explicit resolution tier. ADR-017 adapter follows separately. */
export interface MediaPrices { image?: Record<string, number>; videoSecond?: Record<string, number> }
export interface MediaUnits { kind: "image" | "videoSecond"; resolution: string; quantity: number }
export function mediaCostMicros(table: PriceTable, model: string, provider: string | undefined, units: readonly MediaUnits[]): number | null {
  let total = 0;
  let unpriced = false;
  for (const u of units) {
    if (!["image", "videoSecond"].includes(u.kind) || !Number.isFinite(u.quantity) || u.quantity < 0 || (u.kind === "image" && !Number.isSafeInteger(u.quantity))) throw new RangeError("invalid media units");
    if (u.quantity === 0) continue;
    const price = lookupPrice(table, model, provider)?.media?.[u.kind]?.[u.resolution];
    if (price === undefined) { unpriced = true; continue; }
    if (!Number.isSafeInteger(price) || price < 0) throw new RangeError("invalid media price");
    total += Math.ceil(price * u.quantity);
    if (!Number.isSafeInteger(total)) throw new RangeError("media cost overflow");
  }
  return unpriced ? null : total;
}
