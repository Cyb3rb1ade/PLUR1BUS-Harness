# RE-04/T4 review fixes implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` for native implementation and one final independent review. Follow the existing owner-directed workflow; one commit set updates #850.

**Goal:** Resolve Claude's two high, four medium and nine low findings on #850.

**Architecture:** Keep namespace policy in T4. Use existing store identity metadata and embedding-provider interfaces; apply the existing T3 tier allocator after identity fusion/global merge and before the retrieval ledger. Record actual Node runtime outputs and preserve the persisted ledger's byte representation.

**Tech stack:** Rust 1.95, Node 24.21, pnpm 10; existing dependencies only.

**Spec:** [RE-04/T4](rust-engine/RE-04-recall.md) and Claude's review `~/worktrees/reviews/pr850-review-2026-11-01.md`, head `4c3b1dda`.

## Global constraints

- Start on `grok/re-04-t3-rerank`; merge main and retarget #850 when #846 and #848 have merged. Both merged during implementation; main `752a1843` has now been merged without rebasing.
- No rebase, force-push, amend or stash. Author: Cyb3rb1ade <cyb3rblade@me.com>.
- Node pin: `9f34008c143c5da87b2194b5a28442b407ff8ba7`; CP-5: plugin `v7.18.31`, `6419a60e79975d0b5244798c1fdbbd7997a712ce`. Reference trees are read-only.
- No changes to `context.rs`, `text/`, contracts, RPC, dependency pins or RE-03. Stop and report if RE-03 changes prove necessary.
- Goldens come only from actual Node execution. No derived data from restricted model sources.
- Run the six prescribed gates sequentially before every push, including the full locked engine suite with `PLUR1BUS_TOKENIZER_FILES_REQUIRED=1`.

## Review focus

1. Absent adaptive-budget configuration still applies the merged budget; ledger ids/count reflect its final selection.
2. Equal-width foreign embeddings are never searched using the active vector; missing providers and unequal widths degrade instead of failing the recall.
3. Available providers embed once per identity; identity fusion preserves stable ties and reaches the global reranker correctly.
4. Canonical and graph trace entries arise at their real stages, including rows later removed by ACL, dedupe or caps.
5. Persisted JSONL is byte-identical after UUID normalization, including nulls, field order and selected-id order.

## Tasks

### 1. Pin the missing behavior with failing tests

- [x] Add regressions for default/enabled merged tier budgets, both identity mismatch widths and vector-free projected entries; observe their failures on `4c3b1dda`.
- [x] Enforce immutable source hashes before recorder imports. Record default/enabled budget, foreign identity unavailable/available, reranker ties, canonical, graph and dedupe runtime cases.
- [x] Compare normalized raw Node ledger lines with persisted Rust text, including nullable fields.

### 2. Correct namespace orchestration

- [x] Add the merged budget using `budget::apply_recall_budget`, retaining CP-5.1 reranked order, before ledger construction.
- [x] Route by each leased store's actual identity, coalesce its query, fuse independent spaces or return `embedding-unavailable` for absent providers. Use existing RE-03 interfaces unchanged.
- [x] Use the request query as the single query source; bound concurrent namespace workers and retain settle-all/error ordering.
- [x] Correct the typed `RetrievalLedgerLine` shape and ordered writer.

### 3. Correct the stage boundary

- [x] Port `projectRecallEntry` without vectors and test defaults/epoch conversions against Node.
- [x] Emit trace observations at vector, canonical, score, graph and hydration boundaries, preserving event order and actual reasons.
- [x] Make retained hydrated row/source/score alignment structural and consume rows instead of cloning their vectors.
- [x] Keep T6's explicitly accepted UTF-16 diagnostic-id/serialization deferral and document private-only/optional-source limitations.

### 4. Close coverage and code-shape gaps

- [x] Enumerate genuine rerank permutations with fixed rows/placements and assert the unreranked distractor's position.
- [x] Record equal rerank-score ties and exercise a real child store-read error; assert the returned failure and empty ledger.
- [x] Extract focused helpers, name the child candidate cap and keep new Rust lines within 100 columns.
- [x] Describe `StoreRoutes` in `docs/engine-stores.md`; update fixture README, MODULE-MAP and status notes.

### 5. Verify and publish one correction set

- [x] Run focused RED→GREEN checks, independently repeat recordings, then the full prescribed gates.
- [x] Obtain one independent read-only review; fix the valid-empty global reranker finding against G-RERANK-5 (both fallback policies, empty ledger), RED→GREEN.
- [ ] Commit/push normally to #850 and update its German description with findings, source pins, goldens, results and remaining accepted T6 scope.
