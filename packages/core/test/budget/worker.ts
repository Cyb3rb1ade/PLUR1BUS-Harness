// Child process for concurrency.test.ts: records N events into the shared store through its own service instance.
import { createBudgetService } from "../../src/budget/service.ts";
import { PriceBook } from "../../src/budget/prices.ts";
import { PRICES_V1 } from "./helpers.ts";

const [path, agent, nStr, mode] = process.argv.slice(2) as [string, string, string, string];
const svc = createBudgetService({ path, clock: { now: () => Date.UTC(2026, 9, 6, 12) }, prices: new PriceBook([PRICES_V1]), busyTimeoutMs: 30_000 });
const n = Number(nStr);
for (let i = 0; i < n; i++) {
  svc.recordUsage({ agent, model: "m-small", inputTokens: 1, outputTokens: 2, ...(mode === "dup" ? { requestId: `req-${i}` } : {}) });
  if (i % 25 === 0) svc.status(); // readers interleave with the writers
}
svc.close();
