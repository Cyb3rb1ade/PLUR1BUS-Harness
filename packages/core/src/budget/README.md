# Budgets (M2 acceptance 10, L8)

Usage accounting and limits for model and media calls, enforced in the core, not in prompts (ADR-010 §4). Budgets count tokens, calls and media units (generated images and video seconds): there is no money dimension (owner decisions 2026-10-19; no price table, no cost limit, no cost display). Provider adapters (built separately) call `recordUsage` after a call and `check`/`enforce` before it; this directory holds the interface and the store, and has no runtime dependencies outside `node:*` and this module. Context allocation uses a type-only import from the prompt interface.

The complete L8 port is `createCallBudget` in `calls.ts`: atomic pre-call admission/reservation, user/project/agent hierarchy, settlement and injected audit events. It shares this ledger and honors existing RPC limits. Zonal allocation, retry budgets and subagent caps are separate pure/internal helpers exported from `index.ts`. See [the budget contract and integration follow-ups](../../../../docs/budgets.md). The legacy `check`/`enforce` API below remains advisory and is retained for RPC compatibility; it is not the concurrent-admission hook.

## Interface

```ts
const budget = createBudgetService({ path, clock, events, securePath });
budget.enforce(agent, model, { inputTokens, outputTokens });   // before the call: throws BudgetExceededError on a hard breach
budget.recordUsage({ agent, model, provider, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, requestId });  // after
```

- `check` returns `{ allowed, breaches, warnings }` and never throws on a breach; `enforce` is `check` plus the throw. The error message names the limit, the use, the call's estimate and when the period resets.
- A **hard** limit refuses a call whose `used + estimate` would exceed it (landing exactly on the limit is allowed). A **soft** limit allows the call and warns, once per limit and period (persisted, so a restart does not warn again); the warning goes to the `events` sink (`budget.soft`, `budget.hard`), which the core wires to its logger.
- Limits are per agent or global, per `day` or `month`, on `tokens` (input + output, output including reported reasoning tokens; input is the whole prompt, so cache reads and writes are counted in it, cache reads with the [cache-read weight](#cache-reads-re-d29)), `images` or `videoSeconds`. `check`/`enforce` take a token estimate and apply token limits only; image and video-second limits are enforced by the call port (`calls.ts`, `CallRequest.images`/`videoSeconds`, see [docs/budgets.md](../../../../docs/budgets.md#media-units-images-and-video-seconds)). A limit row with metric `cost` written by an older core is ignored.
- Events (`budget.soft`, `budget.hard`) are delivered after the transaction commits, without the write lock, so a sink may call back into the service. Once a period has passed its hard limit, its soft notice is consumed silently (the hard event is the announcement). A usage event whose `ts` lies beyond the `Date` range, or whose token sum exceeds the safe-integer range, is refused with `BudgetInputError`.
- `check` is advisory: there is no reservation, so concurrent in-flight calls can overshoot by their own estimates.

## Periods

A period is the local calendar day or month in the configured IANA zone (`budget.set timeZone`, default `UTC`). `period.ts` finds period starts by searching the zone's own date function, so DST days (23/25 h) and skipped midnights are right. Aggregation is by query over the ledger, so a zone change re-buckets history consistently.

## Cache reads (RE-D29)

Provider adapters report `inputTokens` as the whole prompt, cache reads and writes included (`packages/providers` `Usage`); `cacheReadTokens` and `cacheWriteTokens` are the parts read from and written to the provider's cache, and the ledger keeps both. A token limit counts `input - cacheRead × (1 - w) + output`, where `w` is the cache-read weight: a setting beside the time zone, `cacheReadWeight()` and `setCacheReadWeight(w)` (a number from 0 to 1, kept in millionths; anything else is a `RangeError`). Weight 1, the default, counts every cache read in full, as before the setting. Which default ships is an open owner decision (RE-D29). Cache writes always count in full.

- `cache-read-weight.ts` applies the weight when usage is summed; it is never written into the ledger, so a change re-rates every period at once. It applies to `check`/`enforce`, the `recordUsage` notices, the limits in `status` and every scope of the call port; a settled call of a user, project, turn or session takes its cache reads from the usage event its settlement wrote.
- An event takes off at most its own input. The weighted share of a period's reads is rounded up to a whole token, once per sum.
- Reservations, `check` estimates and the `reserve`/`settle` events stay unweighted: the reads are unknown before the call.
- A stored weight that cannot be parsed reads as 1.
- At weight 1 the reads are not summed at all. Below 1, a user, project, turn or session limit looks up one usage event per settled call of its period.

## Store

`state/budget.sqlite` (`node:sqlite`, WAL, `busy_timeout`, `PRAGMA user_version` migrations; a store written by a newer core is refused untouched). Tables: `usage_event` (append-only ledger of ids and integer counts, including `images` and `video_seconds` since schema 2), `budget_limit`, `settings`, `notice`. Schema 2 is additive: `budget_limit` is rebuilt with the widened metric check and every row kept, and the two unit columns default to 0. The schema-1 money columns of `usage_event` (cost, price-table version) remain unused (NULL / empty). **There is no column for prompt or response content, and `recordUsage` rejects any property beyond the closed event shape and any identifier that is not a plain id**, so content cannot be stored by accident. Every write is a single `INSERT` (or `IMMEDIATE` transaction), so concurrent writers, including several processes, lose no update; a `requestId` makes a retried event a no-op.

## Surface

RPC `budget.status`, `budget.set` (experimental, since 1.5.0; `budget.set` is never a WebMCP tool). CLI `plur1bus budget status [--agent ID]`, `plur1bus budget set (--global|--agent ID) --period day|month [--metric tokens|images|video-seconds] [--soft V] [--hard V] [--clear-soft] [--clear-hard] [--timezone ZONE]`; values are whole counts in the metric (tokens by default).

The cache-read weight has no RPC or CLI surface yet. `budget.set` `cacheReadWeight`, `plur1bus budget set --cache-read-weight` and the split per period in `budget.status` (fresh input, cache reads, cache writes, output, the sum counted at the active weight) need an RPC schema change; until then the weight stays at 1 unless set through the library ([follow-up](../../../../docs/budgets.md#follow-ups-and-verification-boundaries)).

## Tests

```bash
cd packages/core && node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test test/budget/*.test.ts test/budget-rpc.test.ts
```
