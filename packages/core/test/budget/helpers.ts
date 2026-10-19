import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createBudgetService, type BudgetEvent, type BudgetService } from "../../src/budget/service.ts";

export class Clock { t: number; constructor(t: number) { this.t = t; } now() { return this.t; } advance(ms: number) { this.t += ms; } set(t: number) { this.t = t; } }

export function open(opts: { clock?: Clock; tz?: string; dir?: string } = {}) {
  const dir = opts.dir ?? tempDir("p1b-budget-");
  const clock = opts.clock ?? new Clock(Date.UTC(2026, 9, 6, 12));
  const events: BudgetEvent[] = [];
  const path = join(dir, "state", "budget.sqlite");
  const svc: BudgetService = createBudgetService({ path, clock, events: (e) => events.push(e), ...(opts.tz ? { defaultTimeZone: opts.tz } : {}) });
  return { svc, clock, events, dir, path };
}
