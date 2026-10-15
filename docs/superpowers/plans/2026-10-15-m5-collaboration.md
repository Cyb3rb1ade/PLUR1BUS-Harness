# M5 Collaboration Implementation Plan

**Goal:** Complete M5 acceptance 1, 3–8 while retaining cycle prevention; ship five sequential branches and PRs.
**Architecture:** Closed D104 JSON schemas and a receiver ticket, six tools through the existing dispatcher, a single DelegationTarget port, shared budget/session/worktree ports. Peer data remains a tool result with provenance.
**Spec:** docs/milestones.md §M5; basics D98/D104; ADR-003; direct-chat §6.5; owner work package 2026-10-15.
**Constraints:** no dependencies or engine changes; no approval/policy internals changes; no API/channel/desktop ownership changes; fan-out default off; depth 1; 3/turn, 2/pair, 25 turns/5 minutes; no CI polling, rebase, amend, force-push or stash.

## Review focus

- Forged, foreign, expired, consumed or revoked authority must fail closed, including between ack and execution.
- Sender mutation during repair and oversized inputs must not alter the accepted contract.
- Peer content must remain untrusted tool-result data, never prompt roles.
- Abort and timeout must preserve partial output while preventing later writes to closed stores.
- Project/session membership must guard transcripts, traces and promotion previews.

## Phase 1 — codex/m5-p1-handoff-format

- [x] Validate existing collab baseline with Node 24.21.
- [x] Add closed schemas and prepareHandoff / handoffTicket / validateReturn in collab/handoff.ts; one sender repair, store-backed authority, explicit ack before start.
- [x] Render structured handoff/return bodies in board card descriptions and comment feed; DE/EN, escaped content.
- [x] Test real approval stores, size repair, schema repair limit, ack and return contract; typecheck and collab regressions.
- [x] Commit, push, PR and handoff with threats, decisions, validation and known gaps.

## Phase 2 — codex/m5-p2-agent-tools

- [x] Merge fresh origin/main and Phase 1 if open; Draft depends on prior PR.
- [x] Add DelegationTarget port and six tools to existing composition; preserve dispatcher policy and approval signatures.
- [x] Bind project budget before fan-out, partial returns, user abort and real provider tool-call E2E; test real-store isolation and limits.
- [x] Check M6 P2 status and comment port contract on its PR when present. Commit and PR with handoff.

## Phase 3 — codex/m5-p3-trace-replay

- [x] Merge dependencies; persist redacted per-hop sessions linked to W3C trace; verify replay and membership.
- [x] Project trace tree with costs/duration/status/transcript links, DE/EN and keyboard support. Optional mirroring remains off.
- [x] Commit and PR with handoff.

## Phase 4 — codex/m5-p4-coding-gate-eval

- [x] Merge dependencies; independent sandbox/worktree verifier for Node, Python, Rust, Go, Java/Gradle; fixed argv, timeout, network policy.
- [x] task.complete gate, noted/audited override, reviewer at ≥200 lines and documentation gaps; verify lying delegate rejected.
- [x] ≥20 deterministic equal-token-budget single/peer cases; record numbers, keep fan-out off; commit and PR with handoff.

## Phase 5 — codex/m5-p5-chat-promotion

- [x] Merge dependencies and M3 P1 if open; explicit preview/selection to card/new/existing project with private source immutable.
- [x] Owner-only promotion tests; DE/EN Web action; update milestone evidence, architecture isolation and docs/demos/m5.md.
- [x] Commit and Draft PR with final handoff; remaining Web exposure acceptance explicitly blocked by API ownership decision.

- [ ] Resolve explicit API ownership exception/handoff, append guarded Web methods, and run live transport acceptance. No permission inferred from elapsed time.
