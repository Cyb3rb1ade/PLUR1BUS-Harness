# Budgets — ADR-010 §4 / M2 acceptance 10 (L8)

The budget module owns accounting, admission, allocation and retry/return policies. This change supplies an internal call port, not new RPC methods. **End-to-end M2 acceptance 10 remains pending until the turn-loop and provider follow-ups wire every model call through this port.** No source under `prompt/`, `session/`, `providers/` or `media/` is changed.

## B1: inventory on the local main baseline

Baseline: locally available `origin/main` at `748a9d558dee4799a96106ed20442395f566660b`; no network refresh was performed. Paths below are relative to `packages/core/` unless explicitly prefixed with `docs/`.

| ADR-010 §4 / L8 requirement | On baseline main? | Existing evidence / completion in this change |
| --- | --- | --- |
| Pre-call check and explicit refusal | Partial: advisory `check`/throwing `enforce`; no invocation wrapper | `src/budget/service.ts`, `test/budget/limits.test.ts`; atomic `checkBeforeCall` and guarded `run` in `src/budget/calls.ts`, `test/budget/l8.test.ts` |
| Versioned usage/cost ledger and Price Book | Yes (#141), token units only | `src/budget/{store,prices,service}.ts`, `test/budget/{service,prices}.test.ts`; immutable validated prices and media calculations added |
| Agent/project/user hierarchy | Agent/global only | `test/budget/limits.test.ts`; all scopes in `calls.ts`, hierarchy tests in `l8.test.ts` |
| Calendar periods with timezone | Day/month only | `src/budget/period.ts`, `test/budget/period.test.ts`; Monday-based week and rollover tests in `l8.test.ts` |
| Reservation, reconciliation, concurrent admission | No; README explicitly calls checks advisory | `calls.ts`, `test/budget/{l8,reservations}.test.ts` (including six independent processes) |
| Soft/hard events, injectable audit | Partial: `budget.soft`/`budget.hard` callback | `service.ts`; `BudgetEmitter` warn/refuse/reserve/settle in `calls.ts`, `l8.test.ts` |
| Per-turn/session token and cost ceilings | No | Optional turn/session identities and lifetime limits in `calls.ts`; `l8.test.ts` |
| Per-zone allocation and overflow reporting | No budget API | `src/budget/context.ts`; property sweeps in `l8.test.ts`; type-only `ZoneName` import |
| Typed per-class retries and turn cost ceiling | No | `src/budget/retry.ts`, `l8.test.ts` |
| Subagent return protocol cap (~2,000 tokens) | No | `src/budget/subagent.ts`, `l8.test.ts` |
| Media image/video/resolution units (ADR-017 preparation) | No | `src/budget/prices.ts`, `l8.test.ts` |
| Existing budget RPC compatibility | Yes: `budget.status`, `budget.set` | Unmodified `test/budget-rpc.test.ts`; schemas and RBAC unchanged |

## Admission, hierarchy and accounting

```ts
import { createCallBudget, PriceBook } from '../packages/core/src/budget/index.ts';

const budget = createCallBudget({ path, clock, prices: new PriceBook(tables), emitter });
budget.setLimit({ scope: 'user', id: 'user-1', period: 'month', metric: 'cost', hard: 5_000_000 });
const decision = budget.checkBeforeCall({
  principal: 'user-1', project: 'project-1', agent: 'agent-1', model: 'model-id',
  estimatedInputTokens: 1000, maxOutputTokens: 500,
});
if (decision.kind === 'refuse') {
  // Surface decision.code === 'budget_exceeded'; do not invoke the model or alter caps.
} else {
  // Invoke once, then reconcile even if actual usage differs from the estimate.
  budget.settle(decision.reservationId, { inputTokens: 900, outputTokens: 200 });
}
```

`checkBeforeCall` checks **and reserves**, returning `allow { reservationId, estimatedCostMicros }` or `refuse { code, reason, scope, id, metric, limit, used, estimate, resetsAt }`. A reservation is an admission for one invocation only. Never reuse it for a retry. All matching agent, project, user and global limits apply; the tightest remaining capacity wins. IDs are canonical, trusted host identities; project/user cannot be inferred from old agent-only ledger entries.

Token ceilings count input plus maximum output; cache counts affect actual costs. Costs use integer micro-USD and the Price Book effective at call start. Unknown pricing under any hard cost ceiling refuses (`unpriced-model`); unpriced historical usage also blocks a hard cost ceiling instead of treating it as free. Input and output caps are never mutated. `run(request, invoke)` performs admission, throws `CallBudgetExceededError` (`budget_exceeded`) before invocation on refusal, and settles successful usage.

The same SQLite database stores legacy usage/RPC limits and the lazily initialized version-1 call extension (`budget_call`, `budget_call_limit`, `budget_call_notice`, version in `settings`). Initialization, admission and settlement use `BEGIN IMMEDIATE`, serializing separate connections and processes. A future call-extension schema is refused. The unchanged legacy service can still open databases without initializing the extension. All persisted values are identifiers and numeric counts; no prompt/response payload is stored here.

Legacy agent/global RPC limits and legacy recorded usage participate in admission. Settlement inserts into the existing usage ledger exactly once, so `budget.status` sees reconciled usage. New project/user/turn/session limits and pending reservations are internal port state; the unchanged RPC status does not expose them. Do not also call legacy `recordUsage` for a settled reservation: that would double-count.

Settlement replaces the estimate atomically with actual usage, returning `recorded`, actual cost and explicit `overages`. Underestimation is accounted honestly even above a hard ceiling; subsequent calls refuse. Duplicate settlement is a no-op. Emitters run after commit and cannot interrupt accounting if they throw. Durable ledger updates are authoritative; event delivery is best effort, not a transactional outbox.

Failed/aborted calls without authoritative usage keep their reservation. `run` throws `CallUsagePendingError` (`budget_usage_pending`, original error in `cause`, `reservationId` for reconciliation). Call `settle` with measured usage (or an estimate) when known; `releaseUnused` only when the host can prove nothing billable was sent. Pending reservations survive restart and count across calendar rollover until `reservationTtlMs` (default 30 minutes, longer than any provider call): an older reservation is an orphan, no longer counts, and is released with an `expire` event on open or by `reconcileExpired()`. `reservation(id)` and `pendingReservations()` are read-only diagnostics. Settled calls belong to their admission timestamp; this convention avoids moving in-flight work into a later accounting period. Hosts using the lower-level hook already hold the reservation ID.

## Periods and warnings

Day/week/month are local calendar periods in the persisted IANA timezone (default UTC or injected `defaultTimeZone`). Weeks start Monday; keys name the Monday date, including across year boundaries. Local-date search handles DST without fixed 24-hour arithmetic. Changing the existing timezone setting re-buckets history. Calendar resets apply to user/project/agent/global ceilings.

Optional `turn` and `session` request IDs support token/cost ceilings for the entire identity lifetime. Their totals and warnings do not reset at midnight; `period` is retained in the limit key but does not reset lifetime usage. A host that configures these ceilings must supply the corresponding IDs on every invocation, including retries. It should use one period key consistently for each lifetime limit.

A call limit defaults its soft warning to 80% of the hard limit; explicit `soft` overrides it. Warn once per limit/period (persistent across reopen), including when actual settled usage crosses the threshold. Hard limits allow equality and refuse any excess. Existing soft-only RPC limits also warn through the call hook. `BudgetEmitter.emit` receives typed `warn`, `refuse`, `reserve`, `settle`, `release`, `expire`; absent emitter is a no-op. It imports no logging module. Refused calls emit refusal, never a reservation or a soft warning.

## Context zones

`allocateContext(modelWindow, policy)` operates on the **usable input window**, after the caller subtracts maximum output and provider-envelope headroom. Its five keys use the existing type-only prompt interface: `tools`, `system`, `memory` (frozen snapshot), `conversation`, `volatile` (tail/recall). Each has `minShare`, `maxShare` and optional `maxTokens`.

Integer minima round up, maxima round down. Minima are allocated first, then spare capacity is shared evenly within maxima; unused capacity is returned. Infeasible minima return `{ kind: 'infeasible', reason }`. An allocated result always sums to at most the window. The default memory maximum is 4,250 estimated tokens, corresponding to the engine's 17,000-character default at four characters/token; hosts should override with model tokenizer measurements. Default minimum shares are zero to support empty zones and tiny windows; nonzero policies are tested as well.

`checkZones(budgets, measuredCounts)` returns `within_budget` or `zone_exceeded` with all overflowing zones, limits and measured counts. It never changes prompt bytes. The caller decides whether to refuse or perform an explicit, visible compaction step and remeasure. Tools/system are never silently cut by this module.

## Retry budgets

`RetryBudget` uses explicit `rate_limit`, `overloaded`, `network`, `timeout`, `tool_call_invalid` rules, each with maximum retry attempts and cumulative micro-USD cost per turn. The initial call is excluded. `consume(turnId, class, estimatedCostMicros)` reserves one retry and its conservative cost before retrying; the shared turn cost ceiling applies across classes. Exceeding either raises `RetryBudgetExceededError` (`retry_budget_exceeded`, class and reason). Fatal/schema/semantic errors without an explicitly supported class must abort at the caller; they cannot enter this retry counter by inference.

Defaults: attempts 3/2/2/1/1 in the order above, class costs 100,000/100,000/50,000/100,000/50,000 micro-USD, shared turn cost 200,000. Policy is injectable and copied. Retry `consume` returns a ticket; `RetryBudget.settle(ticket, actualCostMicros)` corrects its reserved cost exactly once. An actual overage is retained and raises a typed cost abort, blocking further retries. Unknown usage keeps its reservation. Actual call usage also goes through the persistent call port's `settle`. Counters live in the core process; keep one counter owner throughout a turn and call `endTurn` only when it ends. Persisting/resuming turns requires the follow-up host to preserve/reconstruct retry state before executing more retries.

## Subagent return cap

`capSubagentResult(textOrStructured, { limit: 2000, port, countTokens? })` returns `complete { value }` or `capped { text, pointer, originalTokens }`. Structured values are serialized for a preview; capped previews deliberately become text, never invalid partial JSON presented as a structured object. Complete structured results retain their shape.

`SubagentResultPort.store(fullValue)` persists the original and returns a plain reference. The preview prefers paragraph/line/word boundaries, preserves Unicode code points, and includes `[truncated; full result: POINTER]` **inside** the cap. Invalid pointers, counters or limits that cannot fit the marker are errors. The port owns access control and retrieval; the budget module stores no full peer payload. Without an injected model tokenizer, UTF-8 byte count is a conservative token upper bound, so the default may return less text than 2,000 model tokens. No suffix is dropped silently.

## Media units (ADR-017 preparation)

`ModelPrice.media` adds resolution-keyed micro-USD prices: `image` (per image) and `videoSecond` (per second). `MediaUnits` carries kind, explicit resolution tier and quantity. Images require integer counts; video duration may be fractional. `mediaCostMicros` rounds each charge upward; unknown positive units return `null`, invalid quantities throw, zero quantities cost zero. This price schema is internal TypeScript data, not a new generated/RPC schema. No vendor rates are guessed or fetched.

Optional media estimates participate in `checkBeforeCall`; actual units participate in `settle`. The provider/media host must report token counts exclusive of separately priced media to avoid double billing. Missing media rates under a hard cost ceiling fail closed.

## Follow-ups and verification boundaries

1. **Turn-loop/scheduler hook:** wire all model invocations, including dreaming/fan-out, to `checkBeforeCall` or `run`; pass canonical principal/project/agent and turn/session IDs; handle refusal before invoking; connect zone measurement/allocation and per-turn retry counter ownership. End-to-end L8 cannot be claimed before this lands.
2. **Provider hook:** settle actual token/cache/media usage on success and charged failure, preserve uncertain reservations on abort, reconcile pending IDs on restart; inject an exact model tokenizer for return caps. Retried calls need distinct reservations. Map provider failure taxonomy explicitly.
3. **Web UI display:** expose hierarchy limits, pending reservations, warnings/refusals, resets, overages and result pointers through a separately reviewed integration; no new RPC methods in this change.
4. **Media integration (ADR-017):** supply explicit resolution/duration measurements and verified local Price Book entries; handle missing units/prices without treating them as free.
5. **Retention/resume:** host-controlled pruning of call extension history must preserve user/project/lifetime totals; old `prune` only affects the legacy ledger. Do not prune either ledger while its periods/ceilings still need those records. Add recovery/retention policy with the host integration.

Tests use fake time, synthetic usage/prices, temporary SQLite files, and local child processes; no model calls or network. Run from the repository root:

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 packages/core/test/budget/*.test.ts packages/core/test/budget-rpc.test.ts
pnpm exec tsc -p tsconfig.base.json --noEmit
```

Hosted Linux/macOS/Windows unit CI and PR creation require network access. The offline implementation does not claim those checks or a PR number.
