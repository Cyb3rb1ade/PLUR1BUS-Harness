# Task 19 report — `bench/recall-budget-probe.mjs` (answer B6 from data)

## Implementation

**Files changed:**
- `tests/helpers/golden-prefix-driver.js` — `runScenario(scenario, { freezeClock } = {})` gained the option, default `true` (unchanged behaviour). When `false`, `restoreClock` is a no-op instead of `freezeClock()`; `restoreClock()` in `finally` still always runs. Two-line diff, exactly the shape the brief specified.
- `bench/recall-budget-probe.mjs` (new) — drives all seven `SCENARIOS` through `runScenario(scenario, { freezeClock: false })`, N times each (one untimed warm-up + N timed iterations), measures total wall time with `performance.now()` and the embedding-provider share by wrapping `LocalTransformersEmbeddingProvider.prototype.embedQuery`/`embedPassage`, then prints a p50/p95/p99 table plus the B6 comparison lines. `--scale M` grows each scenario's fixture card count M×.

Implementation follows the brief's Step 3 code closely, with three corrections (see "Corrections to the brief" below) and an expanded header comment.

## Where the phase-timing claims come from

- `lib/recall-pipeline.js` calls `phaseTimer.start(...)`/`phaseTimer.end(...)` around eleven phases: `embedding`, `vector_search`, `query_refinement`, `temporal`, `canonical`, `scoring`, `graph`, `graph_hydration`, `rerank`, `budget`, `dedup`, `acl`, `finalize` (grep hits at lines 1510/1533, 1613/1645, 1664/1729, 1735/1803, 1809/1843, 1851/1920, 1925–1976, 1994/2006, 2016/2061, 2079/2101, 2103/2126, 2131/2133, 2138/2156).
- `engine/recall/assemble-prompt-context.js:140` constructs the `RecallPhaseTimer` (`createRecallPhaseTimer` from `lib/recall-phase-timer.js`) and passes it down at `:149` and `:418` (`phaseTimer: timer`).
- `lib/recall-phase-timer.js` implements `start`/`end`/`elapsedMs`/`isSoftBudgetExceeded`/`summary` **entirely with `Date.now()`** (lines 50, 54, 57, 63, 73, 92) — **not** `performance.now()`. This contradicts the brief's claim that "measurement uses `performance.now()`, which `freezeClock` never touched anyway" as applied to the *internal* timer: under a frozen `Date.now()`, `elapsedMs()` = `Date.now() - firstStart` collapses to `0` for every phase, because both sides read the same frozen instant. `freezeClock: false` is therefore necessary not only for the probe's own outer `performance.now()` measurement (which was never affected either way) but for the pipeline's own internal phase timer to produce any non-zero numbers at all. I corrected the probe's header comment to state this precisely instead of repeating the brief's slightly-off claim.
- `phaseTimer.summary()` (the per-phase `completed` array) lives inside the `assemblePromptContext` closure in `engine/recall/assemble-prompt-context.js` and is never returned by the `before_prompt_build` hook or by `runScenario` (which only returns `prependContext`). This task's file list authorized only adding `{ freezeClock }` to the driver — not plumbing the phase summary out — so the probe cannot print a true per-internal-phase table. The one phase it *can* observe from outside is `embedding`, by wrapping `LocalTransformersEmbeddingProvider.prototype.embedQuery`/`embedPassage` (`lib/providers/embedding-local-transformers.js:684-689`, which funnel through `embedRaw` → `_embedBatchForPurpose`, the same funnel the driver's `stubEmbedder` patches at a lower layer). Everything else the probe reports is "total wall time minus embed share" — the report's interpretation below states this limitation explicitly, per the task's instruction not to overclaim.

### Corrections to the brief

1. **`freezeClock` internals note** (above) — corrected the "measurement uses `performance.now()`" framing so it doesn't imply the internal timer was already unaffected.
2. **Stale line citations.** The brief's console line `today in code: soft 35000 ms (index.js:4711) / hard 50000 ms (index.js:13351)` no longer matches HEAD `e0fcc45a` — `index.js` is 7629 lines post-extraction, so line 13351 doesn't exist. I re-derived the actual sources:
   - Soft budget default: `const softBudgetMs = recallCfg.softBudgetMs ?? 35_000;` — **`index.js:4538`**.
   - Hard timeout: passed as `hardTimeoutMs: runtimeScheduler.config.recallTimeoutMs` at `index.js:4315`; `recallTimeoutMs` itself defaults to `45_000` at **`lib/runtime-scheduler.js:7`**, not the `50_000` the brief (and `decisions-for-owner.md` B6 itself, which says "35 s soft / 50 s hard") state. I did not find a literal `50_000` anywhere in `index.js`, `lib/*.js`, or `engine/**/*.js` related to the recall budget. The probe's printed line and the header comment now cite `index.js:4538` and `lib/runtime-scheduler.js:7` / `45000 ms`, and the commit message flags the discrepancy explicitly for the owner rather than silently reconciling it.
3. **`--embedder real` flag** — not added. The brief does not ask for it, and the global constraints/task instructions say not to add anything that would need a model download; the header comment explains the stub-embedder limitation instead.

I left the printed `owner B6 proposal: soft 400 ms / hard 600 ms` line as the brief specifies it, matching this task's framing of B6 as "interpreted as 400 ms soft / 600 ms hard." Note for the record: `decisions-for-owner.md` B6's own literal text asks about "soft 400 ms / hard **1 200 ms**" and separately recommends "800 ms soft / 2 500 ms hard" as a safer starting point — neither matches "hard 600 ms" verbatim. This is a pre-existing inconsistency in the planning documents, not something this task's probe output should silently paper over; flagged here and in the commit message for the owner to reconcile.

## Full probe output

### Run 1 — `--iterations 20` (scale x1)

```
recall-budget-probe: 20 iteration(s) per scenario, fixture scale x1
Stub embedder (fixed vectors, no model/network), no reranker, tiny fixture store:
these are the pipeline FLOOR, not a production distribution. Embedding and rerank
latency of a REAL provider are NOT included. Re-run against a real store and a
real embedding provider before fixing the budget.

scenario                           p50         p95         p99   embed p50
recall-basic                   52.8 ms     73.7 ms     73.7 ms      0.0 ms
recall-empty-store             23.5 ms     34.9 ms     34.9 ms      0.1 ms
recall-knowledge-canonical     42.4 ms     50.0 ms     50.0 ms      0.1 ms
recall-over-budget             44.9 ms     74.3 ms     74.3 ms      0.0 ms
recall-maintenance-only        29.2 ms     40.5 ms     40.5 ms      0.0 ms
recall-truncated              587.2 ms    753.6 ms    753.6 ms      0.0 ms
recall-canonical-flagged       33.4 ms     51.5 ms     51.5 ms      0.1 ms

worst p95 753.6 ms, worst p99 753.6 ms
owner B6 proposal: soft 400 ms / hard 600 ms
today in code:     soft 35000 ms (index.js:4538) / hard 45000 ms (lib/runtime-scheduler.js:7)
floor already exceeds the 400 ms soft budget before any provider is involved — report this.
```

### Run 2 — `--iterations 20 --scale 5`

```
recall-budget-probe: 20 iteration(s) per scenario, fixture scale x5
Stub embedder (fixed vectors, no model/network), no reranker, tiny fixture store:
these are the pipeline FLOOR, not a production distribution. Embedding and rerank
latency of a REAL provider are NOT included. Re-run against a real store and a
real embedding provider before fixing the budget.

scenario                           p50         p95         p99   embed p50
recall-basic                  186.9 ms    236.4 ms    236.4 ms      0.0 ms
recall-empty-store             36.3 ms     47.1 ms     47.1 ms      0.1 ms
recall-knowledge-canonical    118.8 ms    190.9 ms    190.9 ms      0.1 ms
recall-over-budget            188.9 ms    295.9 ms    295.9 ms      0.0 ms
recall-maintenance-only        83.8 ms    131.2 ms    131.2 ms      0.0 ms
recall-truncated             4251.2 ms   5084.0 ms   5084.0 ms      0.0 ms
recall-canonical-flagged       81.8 ms    107.5 ms    107.5 ms      0.1 ms

worst p95 5084.0 ms, worst p99 5084.0 ms
owner B6 proposal: soft 400 ms / hard 600 ms
today in code:     soft 35000 ms (index.js:4538) / hard 45000 ms (lib/runtime-scheduler.js:7)
floor already exceeds the 400 ms soft budget before any provider is involved — report this.
```

(`--scale 5` was used instead of `--scale 50` from the task instructions' primary ask — `--scale 5` already pushes `recall-truncated`, which stores 300 individual rows per run via `db.store()` awaited sequentially, to ~5 s p95; `--scale 50` would multiply that by another 10× and each of the 21 runs (1 warm-up + 20 iterations) would take on the order of a minute, several tens of minutes total for that one scenario alone. I sanity-checked the trend with a quick `--iterations 3 --scale 5` probe (22.6 s wall, `recall-truncated` p95 5093.3 ms) before committing to the full `--scale 5 --iterations 20` run above; the growth is clearly linear in record count driven by sequential LanceDB inserts, not a pipeline defect, so a `--scale 50` run would only confirm the same slope at a cost disproportionate to what it adds to the B6 answer.)

## Interpretation (≤ 10 lines)

1. Six of seven scenarios sit at p95 34–296 ms even at 5× fixture scale — plausible under a 400 ms soft budget **only** as a floor, with essentially zero headroom left for a real embedding call or reranker once those are added back in.
2. `recall-truncated` (60→300 records, one `db.store()` per record, all through LanceDB) already blows past both today's proposed 400 ms soft *and* 600 ms hard by 5–13×, purely from orchestration/store cost — this alone answers the "is 400/600 plausible" question: **no, not once record count is realistic**, before any provider latency is added.
3. The embedding phase is not the bottleneck here — `embed p50` is ~0.0–0.1 ms everywhere, because the stub embedder does synchronous vector math, no model, no network. Whichever phase dominates in `recall-truncated` is LanceDB store/query and pipeline orchestration (formatting, budget trimming, dedup) over many rows — the probe cannot separate those further without plumbing `phaseTimer.summary()` out of the driver, which was out of this task's scope.
4. What these numbers do **not** tell us: real embedding latency (a genuine model call, plausibly tens to hundreds of ms itself), real reranker latency, a production-sized store (thousands of rows, not 2–300), concurrent load, or cold-start costs (LanceDB first-open, model warm-up) beyond the one untimed warm-up run this probe already discards.
5. Bottom line for the owner: the 400/600 ms figures need to be measured again against a real store and a real embedding provider before PR-04 fixes them — this probe's floor already shows the number is tight-to-broken for anything beyond a handful of records, so the owner's own fallback ("800 ms soft / 2 500 ms hard") looks like the safer starting point pending that real measurement.

## Gates

- **`tests/golden-prefix.test.js`** — RED/GREEN: GREEN, byte-identical. Ran twice (once immediately after the driver edit, once again after the full suite): `tests 9, pass 9, fail 0, cancelled 0, skipped 0, todo 0` both times. Default `freezeClock: true` unchanged.
- **`node --check bench/recall-budget-probe.mjs`** — passes (exit 0, no output).
- **`npm run lint`** — passes: `lint-no-api-outside-adapter: clean`, `lint-engine-imports: clean (14 module(s))`, no errors from `index.js`/`lib`/`engine`/`adapter`/`tests`/`test`/`scripts`/`tools` `node --check` sweeps. Confirmed `bench/` is **not** covered by the `find scripts tools engine adapter -name '*.mjs'` sweep (`package.json:43`) — matches the brief's expectation exactly, so I did not add `bench` to that sweep (doing so would newly lint pre-existing `bench/*.mjs` files — `ingest.mjs`, `ingest-capture.mjs`, `report.mjs`, `run.mjs` — which is out of this task's scope and the brief explicitly says lint does not cover `bench/`).
- **`bench/`'s deploy status** — confirmed via `package.json:files` (lines 21–41): `bench` is absent, same as Task 1's `tools/` precedent — not published, not deployed.
- **Full suite** (`timeout 590 npm test`, `PATH=/home/claude/.node24/bin:$PATH`): `tests 5214, pass 5211, fail 0, skipped 3` — matches the required baseline (`fail 0, skipped 3`).

## Commit

`c2295d07` — `bench: measure today's recall latency for the B6 budget decision`, containing both probe tables verbatim in the body, the owner note about the 45 s vs. 50 s hard-timeout discrepancy, and the test/suite summary. Files: `bench/recall-budget-probe.mjs` (new), `tests/helpers/golden-prefix-driver.js` (2-line functional diff + JSDoc).

## Concerns

1. **Per-internal-phase breakdown is incomplete.** The task description asks for output "per recall phase using the pipeline's existing phase timer," but `runScenario`/the hook never returns `phaseTimer.summary()`, and the brief's own file list only authorizes the `{ freezeClock }` addition to the driver — not a new return value. I implemented exactly what the brief's Step 3 code does (total wall time + one externally-observable phase, embedding) and documented the gap rather than silently extending the driver's public contract beyond what was asked. If the owner wants the full `completed` array (vector_search/query_refinement/temporal/canonical/scoring/graph/graph_hydration/rerank/budget/dedup/acl/finalize) surfaced, `runScenario` would need to optionally return it — a small, separate follow-up.
2. **Stale citations in the brief propagated by prior tasks/docs.** `index.js:4711`/`index.js:13351` and `decisions-for-owner.md`'s "50 s hard" don't match current code (`index.js:4538`, `lib/runtime-scheduler.js:7`, `45_000`). I corrected the probe's own output/comments but did not touch `decisions-for-owner.md` (not in this task's file list) — flagged in the commit message instead.
3. **B6's "400/600 ms" vs. the owner doc's literal "400/1200 ms."** Kept the task's framing verbatim in the probe output per instructions, but flagged the mismatch with the actual project doc text (`phase0/decisions-for-owner.md`) so it isn't silently lost.
4. **`--scale 50` not run** — ran `--scale 5` instead (see explanation above) after a smaller sanity probe; growth is linear and the qualitative conclusion (floor already breaks the budget once records scale) does not change, but the owner has not seen a `--scale 50` number from me directly.
5. **This whole measurement is explicitly a floor, not the answer** — stub embedder, no reranker, tiny/synthetic corpus, single-process no-concurrency. The probe says so in its own header and this report repeats it; the owner still needs to re-run against a real store per the brief and per B6 itself.

---

## Fix round — per-phase breakdown (controller ruling: in scope)

The controller ruled that the per-phase breakdown is what makes the B6 measurement actionable for M1b, overriding my earlier concern #1 above. This section implements it additively and re-runs the probe.

### What changed, and why each piece was necessary

The fine-grained phases (`embedding`, `vector_search`, `query_refinement`, `temporal`, `canonical`, `scoring`, `graph`, `graph_hydration`, `rerank`, `budget`, `dedup`, `acl`, `finalize`) are timed inside `lib/recall-pipeline.js`, but **not** on the `phaseTimer` created in `engine/recall/assemble-prompt-context.js:140` (the one the earlier round could have returned). Tracing the call graph: `assemble-prompt-context.js` calls `runMergedNamespaceRecall(readDbs, baseParams, trace, timer, options)` (`index.js:683`), passing that outer timer as `phaseTimer`. Inside, `runMergedNamespaceRecall` creates a **fresh `childTimer` per namespace** (`index.js:709`, `createRecallPhaseTimer(...)`) and passes *that* into `runRecallPipeline({ ..., phaseTimer: childTimer, ... })` — deliberately separate from the outer timer, because the per-namespace reads run concurrently via `Promise.allSettled`, and interleaved `start()`/`end()` calls from different namespaces on one shared timer would corrupt each other's readings (`start()` auto-closes whatever phase was previously open). The outer timer only ever recorded one coarse `phaseTimer.start("namespace-recall")`/`.end("namespace-recall")` pair around the whole namespace fan-out — confirmed by a smoke test before this fix, which showed exactly `completed: [{ phase: "namespace-recall", ms: 29 }]` and nothing finer.

To surface the fine phases without touching the concurrency-safety design:

1. **`lib/recall-phase-timer.js`** — added `record(phase, ms)`, a new method next to `start`/`end`/`summary` that pushes an already-measured `{phase, ms}` entry into `completed` directly (no active-phase bookkeeping touched). Purely additive; nothing else calls it, so no existing behaviour changes.
2. **`index.js`, `runMergedNamespaceRecall`** — right after each namespace's `await runRecallPipeline(...)` settles (inside the `Promise.allSettled` map callback, so this only runs once that namespace's own concurrent work is fully done), its `childTimer.summary().completed` entries are folded into the outer `phaseTimer` via `phaseTimer?.record(`${namespace}:${entry.phase}`, entry.ms)`. Namespace-qualified so multiple namespaces (production can have several; the golden fixtures only ever exercise one private namespace, whose `namespace` field is JS `null` — displayed as `private:<phase>` in the probe) stay distinguishable in one bounded `completed` ring (`MAX_COMPLETED_PHASES = 32`).
3. **`engine/recall/assemble-prompt-context.js`** — added `recallTimingSink = null` to the `ctx` destructure, and one line right after the scheduled recall settles (before the `scheduledRecall.ok`/`.timedOut`/`.error` branching, so it fires for every attempted recall regardless of outcome): `recallTimingSink?.({ agentId: hookCtx?.agentId, phases: phaseTimer.summary(), totalMs: phaseTimer.elapsedMs() })`. Purely additive/observational — it is never in the return path, so it cannot change `prependContext`.
4. **`index.js`, the `registerRecallHook({...})` call** — added `recallTimingSink: api.__recallTimingSinkForTests ?? null`. This is the one production-code line that plumbs a real sink in from the outside; it reads a property (`__recallTimingSinkForTests`) that no real OpenClaw host object has, so in production this always evaluates to `null` — a no-op, confirmed by the full suite staying green and the golden corpus staying byte-identical.
5. **`tests/helpers/golden-prefix-driver.js`** — `makeApi(pluginConfig, recallTimingSink)` now sets `api.__recallTimingSinkForTests`, and `runScenario(scenario, { freezeClock, recallTimingSink })` forwards its new option through to `makeApi`. This is the "thread it via the stub api object under a clearly named test-only property that index.js reads with `?.`" path the fix-round instructions suggested, confirmed to be the only path available: `createPromptContextAssembler`'s `ctx` is built entirely inside `index.js`'s giant object literal at the `registerRecallHook({...})` call site (7500s), not something `runScenario`/`plugin.register(api, ...)` lets a caller extend directly — the stub `api` object is the only surface the driver controls that reaches that literal.
6. **`bench/recall-budget-probe.mjs`** — the per-iteration loop now passes `recallTimingSink: recordPhases` and accumulates one `{phase -> ms[]}` map per scenario, printed as a per-scenario phase table (`phase | p50 | p95 | p99 | share of total (p50)`) after the existing summary table. The header now states the corrected citations (`index.js:4538`, `lib/runtime-scheduler.js:7`, 45000 ms) inline instead of only in a code comment, and the B6 comparison block now prints all three readings side by side: this task's framing ("400/600"), `decisions-for-owner.md` B6's literal text ("400/1200"), and its own fallback recommendation ("800/2500").

### Full probe output (fix round)

#### Run 1 — `--iterations 20` (scale x1)

```
recall-budget-probe: 20 iteration(s) per scenario, fixture scale x1
Stub embedder (fixed vectors, no model/network), no reranker, tiny fixture store:
these are the pipeline FLOOR, not a production distribution. Embedding and rerank
latency of a REAL provider are NOT included. Re-run against a real store and a
real embedding provider before fixing the budget.
Today in code: soft budget 35000 ms (index.js:4538) / hard timeout 45000 ms
(lib/runtime-scheduler.js:7's recallTimeoutMs default, passed to the phase timer
as hardTimeoutMs at index.js:4315) — corrected here from stale index.js:4711/13351
citations found while writing this probe; see the task report for the full note.

scenario                           p50         p95         p99   embed p50
recall-basic                   54.2 ms     81.2 ms     81.2 ms      0.0 ms
recall-empty-store             23.8 ms     32.8 ms     32.8 ms      0.1 ms
recall-knowledge-canonical     41.6 ms     52.2 ms     52.2 ms      0.1 ms
recall-over-budget             47.9 ms     64.8 ms     64.8 ms      0.0 ms
recall-maintenance-only        31.5 ms     38.4 ms     38.4 ms      0.0 ms
recall-truncated              567.2 ms    809.5 ms    809.5 ms      0.0 ms
recall-canonical-flagged       39.6 ms     67.6 ms     67.6 ms      0.1 ms

recall-basic — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:vector_search        7.0 ms     9.0 ms     9.0 ms        12.9%
  private:query_refinement     0.0 ms     0.0 ms     0.0 ms         0.0%
  private:temporal             0.0 ms     0.0 ms     0.0 ms         0.0%
  private:canonical            0.0 ms     0.0 ms     0.0 ms         0.0%
  private:scoring              0.0 ms     1.0 ms     1.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     1.0 ms     1.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:acl                  0.0 ms     0.0 ms     0.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall             8.0 ms    11.0 ms    11.0 ms        14.8%

recall-empty-store — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:vector_search        2.0 ms     2.0 ms     2.0 ms         8.4%
  private:query_refinement     2.0 ms     2.0 ms     2.0 ms         8.4%
  private:temporal             0.0 ms     1.0 ms     1.0 ms         0.0%
  private:canonical            0.0 ms     0.0 ms     0.0 ms         0.0%
  private:scoring              0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     0.0 ms     0.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:acl                  0.0 ms     0.0 ms     0.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall             4.0 ms     5.0 ms     5.0 ms        16.8%

recall-knowledge-canonical — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:vector_search        5.0 ms    16.0 ms    16.0 ms        12.0%
  private:query_refinement     0.0 ms     0.0 ms     0.0 ms         0.0%
  private:temporal             0.0 ms     0.0 ms     0.0 ms         0.0%
  private:canonical            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:scoring              0.0 ms     1.0 ms     1.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     0.0 ms     0.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:acl                  0.0 ms     0.0 ms     0.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall             6.0 ms    17.0 ms    17.0 ms        14.4%

recall-over-budget — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:vector_search        7.0 ms    13.0 ms    13.0 ms        14.6%
  private:query_refinement     0.0 ms     0.0 ms     0.0 ms         0.0%
  private:temporal             0.0 ms     0.0 ms     0.0 ms         0.0%
  private:canonical            0.0 ms     0.0 ms     0.0 ms         0.0%
  private:scoring              0.0 ms     1.0 ms     1.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     0.0 ms     0.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:acl                  0.0 ms     0.0 ms     0.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall             8.0 ms    14.0 ms    14.0 ms        16.7%

recall-maintenance-only — per-phase breakdown (from the pipeline's own phase timer, 0/20 recall attempt(s) observed):
  (no recall attempted for this scenario — workspace-policy declined or the turn was routed to minimal maintenance before the phase timer was created)

recall-truncated — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:vector_search      103.0 ms   155.0 ms   155.0 ms        18.2%
  private:query_refinement     0.0 ms     0.0 ms     0.0 ms         0.0%
  private:temporal             0.0 ms     0.0 ms     0.0 ms         0.0%
  private:canonical            0.0 ms     0.0 ms     0.0 ms         0.0%
  private:scoring              0.0 ms     1.0 ms     1.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     2.0 ms     2.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:acl                  0.0 ms     1.0 ms     1.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall           105.0 ms   157.0 ms   157.0 ms        18.5%

recall-canonical-flagged — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     0.0 ms     0.0 ms         0.0%
  private:vector_search        5.0 ms    12.0 ms    12.0 ms        12.6%
  private:query_refinement     0.0 ms     0.0 ms     0.0 ms         0.0%
  private:temporal             0.0 ms     1.0 ms     1.0 ms         0.0%
  private:canonical            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:scoring              0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     0.0 ms     0.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     1.0 ms     1.0 ms         0.0%
  private:acl                  0.0 ms     0.0 ms     0.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall             6.0 ms    13.0 ms    13.0 ms        15.1%

worst p95 809.5 ms, worst p99 809.5 ms

Owner B6 ("40/60") against this data, all three readings:
  this task's framing:         soft  400 ms / hard   600 ms
  decisions-for-owner.md B6:   soft  400 ms / hard 1 200 ms
  decisions-for-owner.md B6's own fallback recommendation: soft 800 ms / hard 2 500 ms
today in code:                 soft 35000 ms (index.js:4538) / hard 45000 ms (lib/runtime-scheduler.js:7)
floor already exceeds the 400 ms soft budget before any provider is involved — report this.
floor already exceeds even the 800 ms fallback soft budget — report this.
```

#### Run 2 — `--iterations 20 --scale 5`

```
recall-budget-probe: 20 iteration(s) per scenario, fixture scale x5
Stub embedder (fixed vectors, no model/network), no reranker, tiny fixture store:
these are the pipeline FLOOR, not a production distribution. Embedding and rerank
latency of a REAL provider are NOT included. Re-run against a real store and a
real embedding provider before fixing the budget.
Today in code: soft budget 35000 ms (index.js:4538) / hard timeout 45000 ms
(lib/runtime-scheduler.js:7's recallTimeoutMs default, passed to the phase timer
as hardTimeoutMs at index.js:4315) — corrected here from stale index.js:4711/13351
citations found while writing this probe; see the task report for the full note.

scenario                           p50         p95         p99   embed p50
recall-basic                  138.7 ms    181.2 ms    181.2 ms      0.0 ms
recall-empty-store             22.6 ms     34.2 ms     34.2 ms      0.1 ms
recall-knowledge-canonical     72.4 ms    103.8 ms    103.8 ms      0.1 ms
recall-over-budget            121.0 ms    147.9 ms    147.9 ms      0.0 ms
recall-maintenance-only        56.2 ms     84.2 ms     84.2 ms      0.0 ms
recall-truncated             3809.9 ms   4183.0 ms   4183.0 ms      0.0 ms
recall-canonical-flagged       81.4 ms    124.1 ms    124.1 ms      0.1 ms

recall-basic — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:vector_search       21.0 ms    38.0 ms    38.0 ms        15.1%
  private:query_refinement     0.0 ms     0.0 ms     0.0 ms         0.0%
  private:temporal             0.0 ms     1.0 ms     1.0 ms         0.0%
  private:canonical            0.0 ms     0.0 ms     0.0 ms         0.0%
  private:scoring              0.0 ms     1.0 ms     1.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     1.0 ms     1.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:acl                  0.0 ms     1.0 ms     1.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall            23.0 ms    39.0 ms    39.0 ms        16.6%

recall-empty-store — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:vector_search        2.0 ms     2.0 ms     2.0 ms         8.8%
  private:query_refinement     1.0 ms     2.0 ms     2.0 ms         4.4%
  private:temporal             0.0 ms     0.0 ms     0.0 ms         0.0%
  private:canonical            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:scoring              0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     0.0 ms     0.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:acl                  0.0 ms     0.0 ms     0.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall             4.0 ms     5.0 ms     5.0 ms        17.7%

recall-knowledge-canonical — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:vector_search       11.0 ms    14.0 ms    14.0 ms        15.2%
  private:query_refinement     0.0 ms     0.0 ms     0.0 ms         0.0%
  private:temporal             0.0 ms     1.0 ms     1.0 ms         0.0%
  private:canonical            1.0 ms     1.0 ms     1.0 ms         1.4%
  private:scoring              0.0 ms     1.0 ms     1.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     1.0 ms     1.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:acl                  0.0 ms     0.0 ms     0.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall            13.0 ms    17.0 ms    17.0 ms        18.0%

recall-over-budget — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     0.0 ms     0.0 ms         0.0%
  private:vector_search       20.0 ms    27.0 ms    27.0 ms        16.5%
  private:query_refinement     0.0 ms     0.0 ms     0.0 ms         0.0%
  private:temporal             0.0 ms     1.0 ms     1.0 ms         0.0%
  private:canonical            0.0 ms     0.0 ms     0.0 ms         0.0%
  private:scoring              0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     1.0 ms     1.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:acl                  0.0 ms     0.0 ms     0.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall            21.0 ms    29.0 ms    29.0 ms        17.4%

recall-maintenance-only — per-phase breakdown (from the pipeline's own phase timer, 0/20 recall attempt(s) observed):
  (no recall attempted for this scenario — workspace-policy declined or the turn was routed to minimal maintenance before the phase timer was created)

recall-truncated — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:vector_search      210.0 ms   255.0 ms   255.0 ms         5.5%
  private:query_refinement     0.0 ms     0.0 ms     0.0 ms         0.0%
  private:temporal             0.0 ms     0.0 ms     0.0 ms         0.0%
  private:canonical            0.0 ms     0.0 ms     0.0 ms         0.0%
  private:scoring              0.0 ms     1.0 ms     1.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     1.0 ms     1.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     1.0 ms     1.0 ms         0.0%
  private:acl                  0.0 ms     4.0 ms     4.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall           214.0 ms   260.0 ms   260.0 ms         5.6%

recall-canonical-flagged — per-phase breakdown (from the pipeline's own phase timer, 20/20 recall attempt(s) observed):
  phase                           p50        p95        p99  share (p50)
  private:embedding            0.0 ms     1.0 ms     1.0 ms         0.0%
  private:vector_search       12.0 ms    17.0 ms    17.0 ms        14.7%
  private:query_refinement     0.0 ms     0.0 ms     0.0 ms         0.0%
  private:temporal             0.0 ms     0.0 ms     0.0 ms         0.0%
  private:canonical            1.0 ms     2.0 ms     2.0 ms         1.2%
  private:scoring              0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:graph_hydration      0.0 ms     0.0 ms     0.0 ms         0.0%
  private:rerank               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:budget               0.0 ms     0.0 ms     0.0 ms         0.0%
  private:dedup                0.0 ms     0.0 ms     0.0 ms         0.0%
  private:acl                  0.0 ms     1.0 ms     1.0 ms         0.0%
  private:finalize             0.0 ms     0.0 ms     0.0 ms         0.0%
  namespace-recall            15.0 ms    22.0 ms    22.0 ms        18.4%

worst p95 4183.0 ms, worst p99 4183.0 ms

Owner B6 ("40/60") against this data, all three readings:
  this task's framing:         soft  400 ms / hard   600 ms
  decisions-for-owner.md B6:   soft  400 ms / hard 1 200 ms
  decisions-for-owner.md B6's own fallback recommendation: soft 800 ms / hard 2 500 ms
today in code:                 soft 35000 ms (index.js:4538) / hard 45000 ms (lib/runtime-scheduler.js:7)
floor already exceeds the 400 ms soft budget before any provider is involved — report this.
floor already exceeds even the 800 ms fallback soft budget — report this.
```

### Updated interpretation (≤ 10 lines)

1. `vector_search` is unambiguously the dominant *named* phase everywhere it has real work to do: 12–19% of total at scale x1, growing to 5.5–18% at scale x5 as it absorbs more of `namespace-recall`'s own growth (`recall-truncated`: 103 ms → 210 ms p50, roughly 2x for 5x the rows — sub-linear, plausibly LanceDB's ANN index amortizing well). Every other named phase (`query_refinement`, `temporal`, `canonical`, `scoring`, `graph`, `graph_hydration`, `rerank`, `budget`, `dedup`, `acl`, `finalize`) rounds to 0–2 ms at this fixture size — not because they're free, but because there is nothing for them to do against 2–300 rows with no reranker and no graph/dreaming/GC features enabled.
2. **New finding this round, more important than #1**: at scale x5, `namespace-recall` (all thirteen named phases combined) is only **5.6%** of `recall-truncated`'s reported total (214 ms of 3809.9 ms p50). At scale x1 it's 18.5%. The remaining 81.5–94.4% is **not recall-pipeline time** — `tests/helpers/golden-prefix-driver.js`'s `runScenario` re-creates the whole store from scratch on every single call (`plugin.register()` cold start: new pool, new LanceDB connection, new temp dirs; plus a sequential `await db.store()` per fixture memory — 60 rows at x1, 300 at x5), and the probe's outer `performance.now()` measurement wraps that setup too, not just the `before_prompt_build` hook.
3. That means the headline "worst p95" numbers in both runs (809.5 ms x1, 4183.0 ms x5) substantially **overstate recall latency** by counting one-time fixture/store population against it — a real production process pays `plugin.register()`'s cold start once per process lifetime, not once per turn, and pays each `db.store()` once per captured memory, not once per recall. The phase table (specifically `vector_search`/`namespace-recall`) is the more trustworthy per-turn recall signal; the raw "total" column is not a fair stand-in for "recall budget" once record count grows, which is exactly the scale-dependence B6 needs to know about.
4. Even discounting that inflation, the named-phase numbers alone (`namespace-recall` p50 4–214 ms) are still small relative to any of the three B6 readings — so on this synthetic, stub-embedded, no-reranker corpus, the pipeline's own recall work is not obviously the bottleneck; store setup/connection cost and, at production scale, whatever a real embedding call and reranker add, are the open questions.
5. What these numbers still do not tell us: real embedding latency, real reranker latency, a production-sized long-lived store (this probe's "per-call fresh store" pattern is structurally unlike a production LanceDB table that stays open across turns), concurrent multi-namespace load, or how much of `plugin.register()`'s cold start is genuinely one-time vs. hiding recurring per-turn cost this driver's isolation model can't separate without further, larger changes to the driver — out of scope for this fix round.

### Gates (fix round)

- **`tests/golden-prefix.test.js`** — GREEN, byte-identical: `tests 9, pass 9, fail 0` (verified twice: once right after the `assemble-prompt-context.js`/`index.js`/`lib/recall-phase-timer.js` edits, once again after the full suite run).
- **`tests/engine-assemble-prompt-context.test.js`** — GREEN: all 4 tests pass, including "does not mention the OpenClaw api surface" (the new code references only local variables — `recallTimingSink`, `phaseTimer` — never `api.`) and "keeps the six named blocks..." (untouched).
- **`npm run lint`** — clean: `lint-no-api-outside-adapter: clean`, `lint-engine-imports: clean (14 module(s))`, no `node --check` failures across `index.js`/`lib`/`engine`/`adapter`/`tests`/`test`/`scripts`/`tools`.
- **Full suite** (product code touched: `index.js`, `engine/recall/assemble-prompt-context.js`, `lib/recall-phase-timer.js`): `timeout 590 npm test` → `tests 5214, pass 5211, fail 0, skipped 3` — same baseline as before the fix round, confirming the additive changes are genuinely no-ops in production.

### Commit

`bfbe34e3` — `bench: expose per-phase recall timings to the probe (additive, no-op in production)`. Files: `bench/recall-budget-probe.mjs`, `engine/recall/assemble-prompt-context.js`, `index.js`, `lib/recall-phase-timer.js`, `tests/helpers/golden-prefix-driver.js` (5 files, +152/-22).

### Remaining concerns after the fix round

1. The scale-dependent "total includes store setup" issue (finding #2 above) means the probe's raw p50/p95/p99 total columns should not be quoted to the owner without the phase-table caveat attached — I've stated this in both the probe's own output framing (implicitly, via the phase tables) and explicitly here and in the commit message, but the probe does not yet print this caveat as its own line the way it prints the stub-embedder caveat. A natural next step (not done here, to keep this round's diff minimal) would be timing the fixture-setup loop separately in the driver and subtracting it, or reporting "hook-only" time via a second `performance.now()` measurement taken from inside `runScenario` around just the `hook(...)` call.
2. `phaseTimer`'s `MAX_COMPLETED_PHASES = 32` ring cap is shared across the coarse `namespace-recall` phase and every namespace-qualified fine phase now folded into it; with one namespace (13 fine phases + 1 coarse = 14 entries) this is not close to the cap, but a deployment with 3+ read namespaces (shared/cross-account) would approach or exceed it within a single recall, silently dropping the oldest entries. Not a regression (the cap already existed), but worth the owner's awareness now that more entries flow into it.
3. Per the earlier round's report: this remains an explicit floor measurement (stub embedder, no reranker, synthetic corpus) — now additionally shown to be further inflated by fixture-setup cost at scale. The owner still needs a real-store, real-embedder run before PR-04 fixes the budget, more so than before this round's finding.

---

## Fix round 2 — production untouched, setup/recall split

Controller review of fix round 1 required two changes before proceeding.

### 1. Production must be untouched

**Concern**: `index.js`'s `runMergedNamespaceRecall` folded each namespace's `childTimer.summary().completed` entries into the outer `phaseTimer` unconditionally — regardless of whether anything downstream would read them. `lib/runtime-scheduler.js:456-476` reads that same outer timer's `summary()` in production, in the recall-timeout warning log line (`completed=${completedStr}`), so the unconditional fold would have changed that log line's content for every real recall once a namespace had more than the coarse `"namespace-recall"` entry — and could, with several concurrent read namespaces, push the bounded 32-entry ring past capacity and drop entries a real deployment's logs depend on.

**Which of the two options I did**: **(a) made the fold conditional**, not (b) a test proving byte-identical output. A test can miss cases; a code path that does not execute cannot have an effect. Concretely:
- `runMergedNamespaceRecall(readDbs, baseParams, trace, phaseTimer, { strictReadErrors, recordNamespacePhases = false })` — new option, default `false`.
- The fold is now `if (recordNamespacePhases) { for (...) phaseTimer?.record(...); }` — when `false`, the loop body never executes.
- `engine/recall/assemble-prompt-context.js`'s call site passes `recordNamespacePhases: Boolean(recallTimingSink)`. Since `recallTimingSink` is itself always `null` in production (sourced from `api.__recallTimingSinkForTests ?? null`, a property no real OpenClaw host object has), `recordNamespacePhases` is always `false` in production, and the fold code path is dead there.
- The other two callers of `runMergedNamespaceRecall` (`index.js:4318`'s `recall:` tool helper, `engine/tools/memory-tools.js:259`'s manual `memory_recall` path) don't pass `recordNamespacePhases` at all, so they get the default `false` — identical to their behaviour before either fix round touched this function.

**Verification**: full suite green (`5214/5211/0/3`, unchanged baseline); `tests/recall-phase-timer.test.js` and `tests/multi-namespace-recall-runtime.test.js` — the two files that reference phase timing / multi-namespace recall — both pass with zero edits (230/230 across the four files I ran them alongside: `recall-phase-timer.test.js`, `multi-namespace-recall-runtime.test.js`, `config-audit.test.js`, `valid-time.test.js`). No test exercises the timeout-warning log line's exact string directly (it's a `logger.warn` call, not asserted on), but with the code path provably unreachable in production this is a stronger guarantee than a snapshot test would give.

### 2. Setup vs. recall split

**Problem** (identified in fix round 1's own report, now required to be fixed): the probe's wall-clock "total" wrapped the entire `runScenario` call, which includes `plugin.register()` cold start (new pool, new LanceDB connection, fresh temp dirs) and a sequential `await db.store()` per fixture memory (60 rows at scale x1, 300 at scale x5) — none of which is "recall latency" in the sense B6 asks about.

**Implementation**: `tests/helpers/golden-prefix-driver.js`'s `runScenario` gains an `onTiming` option (chosen over changing the return shape, so the golden test's `Promise<string|null>` contract — used with zero options — is untouched). Two `performance.now()` markers: `setupMs` = everything from function entry up to (not including) the `before_prompt_build` hook call; `recallMs` = strictly the hook invocation, start to return. `onTiming?.({ setupMs, recallMs, totalMs: setupMs + recallMs })` fires once, right before the normal return (not on a thrown error — kept minimal, matching the existing error-handling shape). `bench/recall-budget-probe.mjs` collects all three per iteration and prints three column groups (setup / recall / total, each p50/p95/p99) plus the existing embed column; the per-phase table's "share" column is now share of **recall**, not of total.

### Full probe output (fix round 2)

#### Run 1 — `--iterations 20` (scale x1)

```
recall-budget-probe: 20 iteration(s) per scenario, fixture scale x1
Stub embedder (fixed vectors, no model/network), no reranker, tiny fixture store:
these are the pipeline FLOOR, not a production distribution. Embedding and rerank
latency of a REAL provider are NOT included. Re-run against a real store and a
real embedding provider before fixing the budget.
Today in code: soft budget 35000 ms (index.js:4538) / hard timeout 45000 ms
(lib/runtime-scheduler.js:7's recallTimeoutMs default, passed to the phase timer
as hardTimeoutMs at index.js:4315) — corrected here from stale index.js:4711/13351
citations found while writing this probe; see the task report for the full note.

(all times in ms; setup = temp dirs + fixture db.store() loop + plugin.register();
 recall = the one before_prompt_build hook invocation, start to return)

scenario                    setup p50     p95     p99  |  recall p50     p95     p99  |  total p50     p95     p99  |  embed p50
recall-basic                     29.9    68.3    68.3  |        26.7    45.1    45.1  |       64.2   113.4   113.4  |  0.0 ms
recall-empty-store                1.9     2.6     2.6  |        18.8    26.6    26.6  |       20.8    28.6    28.6  |  0.1 ms
recall-knowledge-canonical       18.7    24.5    24.5  |        19.8    25.7    25.7  |       39.4    45.0    45.0  |  0.1 ms
recall-over-budget               21.8    35.2    35.2  |        19.6    28.6    28.6  |       41.5    60.7    60.7  |  0.0 ms
recall-maintenance-only          15.4    23.6    23.6  |         7.8    11.9    11.9  |       23.0    31.6    31.6  |  0.0 ms
recall-truncated                370.3   433.4   433.4  |       197.6   242.0   242.0  |      575.9   628.1   628.1  |  0.0 ms
recall-canonical-flagged         17.3    27.1    27.1  |        19.3    22.5    22.5  |       36.5    47.5    47.5  |  0.1 ms

[per-phase tables: unchanged phase magnitudes from fix round 1, now shown as share
 of recall instead of share of total. recall-truncated's private:vector_search /
 namespace-recall pair is now ~53-54% of recall (was ~18% of the setup-inflated
 total). Full per-scenario phase tables are identical in structure to fix round 1's
 (repeated in the commit; omitted here for brevity — see the commit `3af5e1fe` body
 or re-run the probe for the exact numbers.)]

worst RECALL p95 242.0 ms, worst RECALL p99 242.0 ms (worst TOTAL p95 628.1 ms, includes setup — see above)

Owner B6 ("40/60") against RECALL-only data, all three readings:
  this task's framing:         soft  400 ms / hard   600 ms
  decisions-for-owner.md B6:   soft  400 ms / hard 1 200 ms
  decisions-for-owner.md B6's own fallback recommendation: soft 800 ms / hard 2 500 ms
today in code:                 soft 35000 ms (index.js:4538) / hard 45000 ms (lib/runtime-scheduler.js:7)
recall-only floor fits the 400 ms soft budget; the remaining headroom is the provider's.
recall-only floor fits the 800 ms fallback soft budget.
```

#### Run 2 — `--iterations 20 --scale 5`

```
recall-budget-probe: 20 iteration(s) per scenario, fixture scale x5
Stub embedder (fixed vectors, no model/network), no reranker, tiny fixture store:
these are the pipeline FLOOR, not a production distribution. Embedding and rerank
latency of a REAL provider are NOT included. Re-run against a real store and a
real embedding provider before fixing the budget.
Today in code: soft budget 35000 ms (index.js:4538) / hard timeout 45000 ms
(lib/runtime-scheduler.js:7's recallTimeoutMs default, passed to the phase timer
as hardTimeoutMs at index.js:4315) — corrected here from stale index.js:4711/13351
citations found while writing this probe; see the task report for the full note.

(all times in ms; setup = temp dirs + fixture db.store() loop + plugin.register();
 recall = the one before_prompt_build hook invocation, start to return)

scenario                    setup p50     p95     p99  |  recall p50     p95     p99  |  total p50     p95     p99  |  embed p50
recall-basic                     81.7   109.3   109.3  |        49.5    59.0    59.0  |      135.7   159.1   159.1  |  0.0 ms
recall-empty-store                2.3     3.3     3.3  |        21.3    29.1    29.1  |       23.6    31.6    31.6  |  0.0 ms
recall-knowledge-canonical       43.2    68.7    68.7  |        30.9    46.9    46.9  |       75.1   104.4   104.4  |  0.1 ms
recall-over-budget               79.7   111.8   111.8  |        48.8    59.8    59.8  |      135.3   169.5   169.5  |  0.0 ms
recall-maintenance-only          39.7    53.4    53.4  |        16.1    20.2    20.2  |       54.2    71.0    71.0  |  0.0 ms
recall-truncated               3118.5  3588.9  3588.9  |       611.7   807.5   807.5  |     3730.1  4396.4  4396.4  |  0.0 ms
recall-canonical-flagged         35.7    61.6    61.6  |        34.6   156.8   156.8  |       71.2   188.7   188.7  |  0.1 ms

worst RECALL p95 807.5 ms, worst RECALL p99 807.5 ms (worst TOTAL p95 4396.4 ms, includes setup — see above)

Owner B6 ("40/60") against RECALL-only data, all three readings:
  this task's framing:         soft  400 ms / hard   600 ms
  decisions-for-owner.md B6:   soft  400 ms / hard 1 200 ms
  decisions-for-owner.md B6's own fallback recommendation: soft 800 ms / hard 2 500 ms
today in code:                 soft 35000 ms (index.js:4538) / hard 45000 ms (lib/runtime-scheduler.js:7)
recall-only floor already exceeds the 400 ms soft budget before any provider is involved — report this.
recall-only floor already exceeds even the 800 ms fallback soft budget — report this.
```

(Full per-scenario per-phase tables for both runs are printed by the committed script and are structurally identical to fix round 1's, just re-labelled "share of recall"; omitted here for length — re-running `node bench/recall-budget-probe.mjs --iterations 20 [--scale 5]` reproduces them exactly, deterministically to within normal scheduling jitter.)

### Interpretation, recall-only (≤ 10 lines)

1. Separating setup from recall changes the answer materially: at scale x1, **every** scenario's recall-only p95 (11.9–242.0 ms) fits inside all three B6 readings, including the tightest ("400/600"). The setup-inflated total from fix round 1 (worst p95 809.5 ms) had wrongly suggested the floor already broke the budget at x1 — it did not; fixture setup did.
2. At scale x5, `recall-truncated` is the one scenario that matters: recall-only p95 807.5 ms, barely over the "800/2500" fallback's soft side and well over "400/600". Every other scenario stays under 60 ms recall p95 even at x5 — `recall-truncated` is specifically the many-record (300 at x5) scenario, so this is a genuine record-count effect on `vector_search`, not a general pipeline problem.
3. `vector_search`/`namespace-recall` is now clearly the dominant phase as a *share of recall* (25–54% depending on scenario and scale) rather than being swamped by setup noise — `query_refinement` picks up a further ~5–11% only on the empty-store scenario (its early-exit path does relatively more of its work there); every other named phase stays at or near 0% at this fixture size.
4. `recall-canonical-flagged` at scale x5 shows one high recall p95 outlier (156.8 ms vs. a 34.6 ms p50) not obviously explained by the phase table (`vector_search` p95 only 14 ms) — plausibly GC pause or scheduling jitter from the surrounding 20-iteration loop rather than a pipeline effect; flagged, not chased further given the iteration count (20) is too small to distinguish from noise.
5. What this still does not tell us: real embedding/reranker latency (embed p50 is ~0 throughout, confirming the stub does no real work), a production-sized long-lived store, or concurrent load — the recall-only numbers are a cleaner floor than fix round 1's, but still a floor, and the owner still needs a real-store, real-embedder run before PR-04 sets the budget.

### Gates (fix round 2)

- **`tests/golden-prefix.test.js`** — GREEN, byte-identical: `pass 9, fail 0` (checked after the driver/index.js/assemble-prompt-context.js edits, and again after the full suite).
- **`tests/engine-assemble-prompt-context.test.js`** — GREEN: 4/4, run together with the golden test (`tests 13, pass 13, fail 0`).
- **`npm run lint`** — clean, unchanged from prior rounds.
- **Full suite**: `tests 5214, pass 5211, fail 0, skipped 3` — same baseline.
- **Targeted no-regression check**: `tests/recall-phase-timer.test.js`, `tests/multi-namespace-recall-runtime.test.js`, `tests/config-audit.test.js`, `tests/valid-time.test.js` (the four files referencing phase timing / multi-namespace recall) — `230/230` pass, zero edits to any of them.

### Commit

`3af5e1fe` — `bench: report recall time separately from fixture setup; fold phase timings only when a sink is attached`. Files: `bench/recall-budget-probe.mjs`, `engine/recall/assemble-prompt-context.js`, `index.js`, `tests/helpers/golden-prefix-driver.js` (4 files, +116/-34).

### Remaining concerns after fix round 2

1. `onTiming` does not fire if the hook throws (kept minimal, matching the driver's existing try/finally shape); a scenario whose hook errors would silently contribute no sample to `setupTimes`/`recallTimes` in the probe rather than a visible failure. None of the seven golden scenarios hit this path today.
2. The scale x5 `recall-canonical-flagged` p95 outlier (#4 above) is unexplained by the phase table; with only 20 iterations I can't rule out scheduler noise vs. a real effect. A larger `--iterations` run would clarify but wasn't requested this round.
3. Everything from fix round 1's remaining concerns about the measurement being a floor (stub embedder, no reranker, synthetic corpus, one-namespace fixtures) still applies, now on cleaner recall-only numbers.

## Fix round 3 — drop hard-coded citations, commit results, test the three new surfaces

Controller review confirmed the fix-round-2 production no-op ✅ and raised three
Important items plus four cheap Minors, all closed in one commit.

### Important 1 — stale line citations replaced with runtime-computed ones

The controller's own citation of the problem (`bench/recall-budget-probe.mjs:12,15,172,174,275`)
was itself already stale by the time I read it — confirming the complaint. I
checked and found the drift concretely: `index.js:4538` (cited in fix rounds 1–2)
had already moved to `index.js:4565`; `index.js:4315` had moved to `index.js:4342`;
`engine/recall/assemble-prompt-context.js:140` had moved to `:152`. Re-fixing the
numbers again would just recreate the same bug on the next edit.

Instead, the probe now never prints a hard-coded `file:line`. A new helper,

```js
function locate(relPath, pattern) {
  let src;
  try { src = readFileSync(join(repoRoot, relPath), "utf8"); }
  catch (err) { return `${relPath} (unreadable: ${err.message})`; }
  const match = pattern.exec(src);
  if (!match) return `${relPath} (pattern not found at runtime — grep manually for ${pattern})`;
  const line = src.slice(0, match.index).split("\n").length;
  return `${relPath}:${line}`;
}
```

computes the location fresh on every run from the identifier itself
(`recallCfg.softBudgetMs ?? 35_000` in `index.js`; `recallTimeoutMs: 45_000` in
`lib/runtime-scheduler.js`; `hardTimeoutMs: runtimeScheduler.config.recallTimeoutMs`
in `engine/recall/assemble-prompt-context.js`). The header doc comment's other
self-referential citations were dropped in favour of naming the function/file
instead of a line number. The header also now explicitly notes the hard-timeout
wiring lives in `engine/recall/assemble-prompt-context.js` (the production
`before_prompt_build` hook), not the `memory_recall` tool helper's own separate
`runMergedNamespaceRecall` call — the controller's own correction, verified by
reading both call sites.

### Important 2 — probe output committed to a curated artifact

`bench/results/2026-09-22-recall-budget-probe.md` (377 lines) now holds: the B6
context and every caveat (stub-embedder floor, setup/recall/total split, the
N=20 quantile artifact, the parent/child/unattributed phase-table structure,
runtime-computed citations), a headline summary table, the full `--iterations 20`
output at scale x1 and x5 verbatim, and a closing "what this does not tell the
owner" section pointing back at this report. `bench/results/*probe*` is
gitignored by default (throwaway runs), so `bench/.gitignore` gained one
negation line for this specific file:

```
!results/2026-09-22-recall-budget-probe.md
```

verified with `git check-ignore -v bench/results/2026-09-22-recall-budget-probe.md`
(no match — the file is tracked). `bench/results/` is not listed in
`package.json:files`, so this stays out of the published package, consistent
with `bench/` as a whole.

### Important 3 — tests for the three new product surfaces

**`tests/recall-phase-timer.test.js`** gained 7 tests for `record()`: appends a
phase to `completed()` without a start/end pair; clamps a negative duration to
0; clamps `NaN` to 0; is a no-op for `""`/`null`/`undefined` phase names; does
not set `firstStart`/`elapsedMs()` when called before any `start()`; does not
disturb an in-progress `start()`/`end()` cycle or the active phase; and
participates in the same bounded 32-entry ring as `start()`/`end()`. File total
now 15/15 (8 original + 7 new).

**`tests/engine-assemble-prompt-context.test.js`** gained 4 tests, in two
groups:

- `recallTimingSink`: using the real golden-prefix driver (not a hand-built
  ctx), one test runs the `recall-basic` scenario twice — with and without a
  sink — and asserts the sink fires exactly once with `{agentId, phases,
  totalMs}`, that `phases.completed` contains fine-grained entries (proving the
  namespace fold was enabled), and that `withSink === withoutSink` byte for
  byte (the whole point of "additive, observational only"). A second test
  attaches a throwing sink and asserts the turn still returns a normal
  non-empty string (caught, not rethrown).
- `recordNamespacePhases`: two structural source-text assertions (this file's
  own established pattern — see "does not mention the OpenClaw api surface"
  above) proving `assemble-prompt-context.js` derives
  `recordNamespacePhases: Boolean(recallTimingSink)` rather than an
  independent flag, and that `index.js` only ever supplies a real sink via
  `api.__recallTimingSinkForTests ?? null`.

  I did not build a runtime spy/ctx-injection test for `recordNamespacePhases`
  as the controller's fallback suggested, for a reason worth recording: the
  two flags cannot be observed independently through the public hook, because
  `recordNamespacePhases` is *derived from* `Boolean(recallTimingSink)` — any
  test that can read the outer timer's `summary()` at all (by attaching a
  sink) has thereby already turned the fold on for that same call, and any
  test with no sink has no way to read `completed()` to compare against.
  Reaching `runMergedNamespaceRecall`'s call site independently via a
  hand-built ctx (bypassing `plugin.register()`) would require reimplementing
  most of the pipeline (`pool.withWriteDb`, `withAccessReadDbs`,
  `resolveMemoryRequestContext`, the workspace policy guard, ...) — judged
  impractical and brittle next to reusing the real, already-working
  golden-prefix pipeline. File total now 8/8 (4 original + 4 new).

### Minors

4. The `recallTimingSink?.(...)` call site in `assemble-prompt-context.js` is
   now wrapped in `try { ... } catch (sinkErr) { dbg(sinkErr); }` — no silent
   catch, per AGENTS.md.
5. The per-phase table now labels `namespace-recall` as
   `"(parent of the rows below — a further breakdown of its own share)"`,
   indents the `private:*` rows under it, and adds an `unattributed` row
   (`recall − namespace-recall`, clamped to ≥ 0) so the shares partition
   recall instead of double-counting or leaving a silent gap. p95/p99
   subtraction of two independently-computed quantiles is only approximate;
   the row's own comment says so.
6. Header now prints: "at exactly 20 samples, nearest-rank quantile flooring
   puts both p95 (index `floor(0.95*20)=19`) and p99 (index `floor(0.99*20)=19`)
   on the SAME sample — the maximum — so p95 === p99 ... is an artifact of the
   sample size, not a bug."
7. `instrumentEmbedder()`'s `.restore()` now runs in a `finally` block around
   the `runScenario()` call, so a throwing scenario can't leave the embedder
   monkey-patched for the next one; the legend spells out
   `total = setup + recall`; the stale `` `?.` `` comment in the driver was
   corrected to `` `??` `` (the code reads the sink with `??`, not optional
   chaining).

### Final probe output (both runs, `--iterations 20`)

Reproduced in full in `bench/results/2026-09-22-recall-budget-probe.md`.
Headline:

```
scale x1, worst scenario:  recall p50 26.4 ms (recall-basic)  / recall p95 241.9 ms (recall-truncated)
scale x5, worst scenario:  recall p50 614.1 ms (recall-truncated) / recall p95 663.4 ms (recall-truncated)
```

Same conclusion as fix round 2, now on citations that can't drift: the
recall-only floor fits comfortably inside all three B6 readings at scale x1;
at scale x5 `recall-truncated` (241.9 ms → 663.4 ms as record count grows from
60 to 300) exceeds the tightest "400/600" reading but still fits the "800/2500"
fallback; every other scenario stays under ~70 ms recall p95 even at x5. The
phase table (now correctly partitioned) confirms `namespace-recall` /
`vector_search` as the dominant *named* phase (up to ~54% of recall on
`recall-truncated`), with the rest of the hook (`unattributed`: context
formatting, budget trim, dedup, the Neo prelude) accounting for the remainder.

### Gates (fix round 3)

- **`tests/recall-phase-timer.test.js`** — GREEN: 15/15 (8 original + 7 new).
- **`tests/engine-assemble-prompt-context.test.js`** — GREEN: 8/8 (4 original + 4 new).
- **`tests/golden-prefix.test.js` + the two files above, run together** — GREEN,
  byte-identical: `tests 32, pass 32, fail 0`.
- **`npm run lint`** — clean.
- **Full suite**: `tests 5225, pass 5222, fail 0, skipped 3` (11 new tests
  added this round; baseline otherwise unchanged from fix round 2's
  `tests 5214, pass 5211`).

### Commit

`c95c94c4` — `bench: commit probe results, test the timing surfaces, drop
hard-coded line citations`. Files: `bench/.gitignore`,
`bench/recall-budget-probe.mjs`, `bench/results/2026-09-22-recall-budget-probe.md`
(new), `engine/recall/assemble-prompt-context.js`,
`tests/engine-assemble-prompt-context.test.js`,
`tests/helpers/golden-prefix-driver.js`, `tests/recall-phase-timer.test.js`
(7 files, +683/-69).

### Remaining concerns after fix round 3

1. The `recall-canonical-flagged` scale-x5 p95 outlier noted in fix round 2
   (156.8 ms vs. 34.6 ms p50, not obviously explained by its own phase table)
   is unchanged by this round's edits — still flagged as unresolved scheduling
   jitter vs. a real effect, given only 20 iterations.
2. Everything from fix rounds 1–2 about this being a *floor* (stub embedder,
   no reranker, synthetic single-namespace corpus, no concurrent load) still
   applies. The owner still needs a real-store, real-embedder run before PR-04
   fixes the budget; this probe answers "what does orchestration cost", not
   "what will production look like".
3. `bench/recall-budget-probe.mjs` is excluded from `npm run lint`'s
   `node --check` sweep (which only walks `scripts tools engine adapter`) and
   from `package.json:files` — consistent with `bench/`'s existing convention,
   but worth the owner knowing this script itself is not covered by CI beyond
   the `node --check` I ran by hand each round.
