import { createCallBudget } from '../../src/budget/calls.ts';
import { PriceBook } from '../../src/budget/prices.ts';
const PRICES_V1 = { version: 'synthetic', effectiveFrom: 0, models: { 'm-small': { input: 1, output: 5 } } };
const gate = createCallBudget({ path: process.argv[2]!, clock: { now: () => Date.UTC(2026, 9, 6, 12) }, prices: new PriceBook([PRICES_V1]) });
let allowed = 0;
try {
  for (let i = 0; i < 20; i++) {
    const d = gate.checkBeforeCall({ principal: 'u1', project: 'p1', agent: 'a1', model: 'm-small', estimatedInputTokens: 30, maxOutputTokens: 10 });
    if (d.kind === 'allow') allowed++;
  }
  process.stdout.write(String(allowed));
} finally { gate.close(); }
