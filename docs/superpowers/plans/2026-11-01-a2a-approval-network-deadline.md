# A2A approval and network deadline implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Apply Controller F to #843: approval waiting has its own lifetime and does not consume the outbound network budget.

**Architecture:** The peer client links caller, removal and shutdown cancellation only. The transport measures time spent inside approved network execution, sharing the remaining budget across redirects while excluding each approval wait. Preview credentials are released before waiting and leased again for approved traffic.

**Tech Stack:** Node 24.21, TypeScript, existing dispatcher and approval service; no dependency or RPC change.

**Spec:** Controller F in `/Users/cyberblade/worktrees/reviews/controller-rulings-2026-11-01-pm.md`, with `pr843-rereview-2026-11-01.md`.

## Global constraints

- Commit and push #843 before SH2. Never rebase, amend or force-push.
- Preserve all earlier H1–L8 fixes and leak assertions. No Rust changes in this round.
- Run required checks sequentially; full Core runs alone. Keep private Engine dependency pinned.
- Actual Claude review before merge; update the existing PR and report its exact head.

## Review focus

- Delayed approval for the initial request and a redirect must preserve the network allowance.
- Both real trust approvals may outlast `timeoutMs`, while the peer becomes trusted only after confirmation.
- A stalled approved network request must still time out and close its connection.
- Caller cancellation/removal/shutdown during approval must prevent I/O and release late credentials.
- A preview lease may expire during approval; traffic must obtain a fresh lease afterwards.

### Task 1: Reproduce the regression

**Files:** `packages/core/test/a2a/secret-leak.test.ts`, `packages/core/test/a2a/protocol-leak.test.ts`.
**Interfaces:** Existing `A2aPeerTransport.request` and actual composed `a2a.peer.trust`.

- [x] Add an injected clock/approval callback to the transport fixture. Advance time beyond `timeoutMs` on both approvals of a same-origin redirect; assert two approved requests and success.
- [x] Add a real approval-service trust case whose approval latency exceeds its configured network timeout; assert both approvals, one card request and trusted state.
- [x] Run both cases against current source and retain expected failures.

### Task 2: Separate lifetimes

**Files:** `packages/core/src/tools/a2a-transport.ts`, `packages/core/src/a2a/peer-client.ts`, `packages/core/src/composition/a2a.ts`.
**Interfaces:** Keep transport/client public operation signatures and wire shapes unchanged.

- [x] Remove the peer-client whole-operation network timer, retaining caller/removal/shutdown signals.
- [x] Start the transport timer inside approved execution and subtract only network execution time from the shared redirect allowance.
- [x] Release preview leases before awaiting approval and reacquire before network I/O; retain all values for redaction.
- [x] Keep the stalled-network and cancellation controls passing; add fresh-lease and remaining-budget assertions.
- [x] Run the complete affected A2A/leak/budget/egress tests.

### Task 3: Documentation and publication

**Files:** `docs/handoff/2026-10-31-v1-a2a-peer-cli.md`, `docs/budgets.md`, `CHANGELOG.md`, PR description.

- [x] Correct handoff waiting/CLI timeout guidance and describe retained redacted approval previews.
- [x] Correct the stale cache-weight RPC statement at `budgets.md:92`; keep CLI follow-up explicit.
- [ ] Run lint, full Core alone, docs generation/check and diff checks; obtain actual Claude review.
- [ ] Commit normally, push `codex/v1-a2a-client`, update/open #843 and report its exact head.
- [ ] Inspect the requested unit CI results without a polling loop, then begin F1 on #854.
