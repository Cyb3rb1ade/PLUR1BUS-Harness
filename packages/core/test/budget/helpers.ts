import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { PriceBook, type PriceTable } from "../../src/budget/prices.ts";
import { createBudgetService, type BudgetEvent, type BudgetService } from "../../src/budget/service.ts";

export class Clock { t: number; constructor(t: number) { this.t = t; } now() { return this.t; } advance(ms: number) { this.t += ms; } set(t: number) { this.t = t; } }

export const PRICES_V1: PriceTable = { version: "v1", effectiveFrom: Date.UTC(2026, 0, 1), models: { "m-small": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, "m-large": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } } };
export const PRICES_V2: PriceTable = { version: "v2", effectiveFrom: Date.UTC(2026, 9, 10), models: { "m-small": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } } };

export function open(opts: { clock?: Clock; tables?: PriceTable[]; tz?: string; dir?: string } = {}) {
  const dir = opts.dir ?? tempDir("p1b-budget-");
  const clock = opts.clock ?? new Clock(Date.UTC(2026, 9, 6, 12));
  const events: BudgetEvent[] = [];
  const path = join(dir, "state", "budget.sqlite");
  const svc: BudgetService = createBudgetService({ path, clock, prices: new PriceBook(opts.tables ?? [PRICES_V1]), events: (e) => events.push(e), ...(opts.tz ? { defaultTimeZone: opts.tz } : {}) });
  return { svc, clock, events, dir, path };
}
