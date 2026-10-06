# Budgets (M2 acceptance 10, L8)

Usage accounting and limits for model calls, enforced in the core, not in prompts (ADR-010 §4). Provider adapters (built separately) call `recordUsage` after a call and `check`/`enforce` before it; this directory holds the interface and the store, and imports nothing outside `node:*`.

## Interface

```ts
const budget = createBudgetService({ path, clock, prices, events, securePath });
budget.enforce(agent, model, { inputTokens, outputTokens });   // before the call: throws BudgetExceededError on a hard breach
budget.recordUsage({ agent, model, provider, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, requestId });  // after
```

- `check` returns `{ allowed, breaches, warnings }` and never throws on a breach; `enforce` is `check` plus the throw. The error message names the limit, the use, the call's estimate and when the period resets.
- A **hard** limit refuses a call whose `used + estimate` would exceed it (landing exactly on the limit is allowed). A **soft** limit allows the call and warns, once per limit and period (persisted, so a restart does not warn again); the warning goes to the `events` sink (`budget.soft`, `budget.hard`), which the core wires to its logger.
- Limits are per agent or global, per `day` or `month`, on `cost` (micro-USD) or `tokens` (input + output; cache tokens are priced but not counted).
- `check` is advisory: there is no reservation, so concurrent in-flight calls can overshoot by their own estimates.

## Periods

A period is the local calendar day or month in the configured IANA zone (`budget.set timeZone`, default `UTC`). `period.ts` finds period starts by searching the zone's own date function, so DST days (23/25 h) and skipped midnights are right. Aggregation is by query over the ledger, so a zone change re-buckets history consistently.

## Prices

`prices.ts` is data: append-only `PriceTable`s (`version`, `effectiveFrom`, USD per million tokens per model). An event is priced once, at record time, from the table in force at the **event's** timestamp, and keeps that cost and `price_version` forever. A model without a price is recorded unpriced (cost `NULL`, counted in `unpricedEvents`) and a **hard cost limit refuses it** (`unpriced-model`) rather than guessing. The shipped table is minimal; verify and extend it before relying on cost limits.

## Store

`state/budget.sqlite` (`node:sqlite`, WAL, `busy_timeout`, `PRAGMA user_version` migrations; a store written by a newer core is refused untouched). Tables: `usage_event` (append-only ledger of ids and integer counts), `budget_limit`, `settings`, `notice`. **There is no column for prompt or response content, and `recordUsage` rejects any property beyond the closed event shape and any identifier that is not a plain id**, so content cannot be stored by accident. Every write is a single `INSERT` (or `IMMEDIATE` transaction), so concurrent writers, including several processes, lose no update; a `requestId` makes a retried event a no-op.

## Surface

RPC `budget.status`, `budget.set` (experimental, since 1.5.0; `budget.set` is never a WebMCP tool). CLI `plur1bus budget status [--agent ID]`, `plur1bus budget set (--global|--agent ID) --period day|month --metric cost|tokens [--soft V] [--hard V] [--clear-soft] [--clear-hard] [--timezone ZONE]`; cost values in USD (≤ 6 decimals).

## Tests

```bash
cd packages/core && node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test test/budget/*.test.ts test/budget-rpc.test.ts
```
