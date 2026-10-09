import type { ZoneName } from '../prompt/types.ts';

export type ZonePolicy = Record<ZoneName, { minShare: number; maxShare: number; maxTokens?: number }>;
export type ZoneBudgets = Record<ZoneName, number>;
const ZONES: readonly ZoneName[] = ['tools', 'system', 'memory', 'conversation', 'volatile'];
/** Frozen memory defaults to the engine's 17,000 character budget, estimated at four characters/token. */
export const DEFAULT_ZONE_POLICY: ZonePolicy = {
  tools: { minShare: 0, maxShare: 0.2 }, system: { minShare: 0, maxShare: 0.2 },
  memory: { minShare: 0, maxShare: 0.25, maxTokens: 4250 },
  conversation: { minShare: 0, maxShare: 0.8 }, volatile: { minShare: 0, maxShare: 0.2 },
};
export type ContextAllocation = { kind: 'allocated'; budgets: ZoneBudgets; unallocated: number } | { kind: 'infeasible'; reason: string };
/** Pure allocation only; it never edits prompt bytes. Output headroom must be subtracted by the caller. */
export function allocateContext(modelWindow: number, policy: ZonePolicy = DEFAULT_ZONE_POLICY): ContextAllocation {
  if (!Number.isSafeInteger(modelWindow) || modelWindow < 0) throw new RangeError('invalid model window');
  const budgets = {} as ZoneBudgets;
  const maxima = {} as ZoneBudgets;
  for (const z of ZONES) {
    const p = policy[z];
    if (!p || !Number.isFinite(p.minShare) || !Number.isFinite(p.maxShare) || p.minShare < 0 || p.maxShare > 1 || p.minShare > p.maxShare || (p.maxTokens !== undefined && (!Number.isSafeInteger(p.maxTokens) || p.maxTokens < 0))) throw new RangeError(`invalid policy for ${z}`);
    budgets[z] = Math.ceil(modelWindow * p.minShare);
    maxima[z] = Math.min(Math.floor(modelWindow * p.maxShare), p.maxTokens ?? modelWindow);
    if (budgets[z] > maxima[z]) return { kind: 'infeasible', reason: `minimum exceeds maximum for ${z}` };
  }
  let remaining = modelWindow - ZONES.reduce((sum, z) => sum + budgets[z], 0);
  if (remaining < 0) return { kind: 'infeasible', reason: 'sum of minima exceeds window' };
  // Allocate minima first, then distribute spare capacity evenly, respecting every maximum.
  while (remaining > 0) {
    const open = ZONES.filter(z => budgets[z] < maxima[z]);
    if (!open.length) break;
    const share = Math.max(1, Math.floor(remaining / open.length));
    for (const z of open) {
      const add = Math.min(remaining, share, maxima[z] - budgets[z]);
      budgets[z] += add; remaining -= add;
    }
  }
  return { kind: 'allocated', budgets, unallocated: remaining };
}
export function checkZones(budgets: ZoneBudgets, used: Partial<ZoneBudgets>): { kind: 'within_budget' } | { kind: 'zone_exceeded'; zones: { zone: ZoneName; limit: number; used: number }[] } {
  const zones = ZONES.flatMap(zone => {
    const n = used[zone] ?? 0;
    if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(budgets[zone]) || budgets[zone] < 0) throw new RangeError('invalid zone counts');
    return n > budgets[zone] ? [{ zone, limit: budgets[zone], used: n }] : [];
  });
  return zones.length ? { kind: 'zone_exceeded', zones } : { kind: 'within_budget' };
}
