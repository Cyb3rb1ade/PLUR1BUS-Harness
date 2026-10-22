# F5 Session Model Routing Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; root performs the independent final review.

**Goal:** Add per-agent fixed/auto routing through the shared DecisionClient with stable session choices and an ordered, restricted failover chain.
**Architecture:** Composition owns SessionModelRouting and its cache, surviving role-provider recreation. The existing provider router receives only the selected tier and following configured candidates; its budget, auth, billing and privacy remain authoritative. Redacted model.selected turn events record actual served models and restore completed session choices after restart.
**Tech Stack:** Node 24.21, TypeScript, existing ProviderRouter/DecisionClient, JSON Schema.
**Spec:** D30/D105, ADR-015 and GP4 F5.

## Global Constraints

No Engine pin/lock/dependency changes, paid/cloud tests, CI polling, amend/rebase/force. Do not edit F4 decision types/client/maintenance or F6 pruning/skill-selection code. Config source first with live restart and tiers. Existing configs without modelPolicy preserve D105 behavior exactly.

## Review Focus

- Session choices stay stable when complexity changes; perTurn is explicit; actual failover models remain pinned on the next turn.
- Explicit modelProfile bypasses auto; aborted/incomplete choices never poison cache; changed privacy cannot reuse a forbidden cached model.
- Only configured named tiers are eligible; unknown/unsupported tiers do not open fallback to arbitrary profiles; billing/voice restrictions still apply.
- All calls share the existing client, request signal and voice budget; timeout uses the conservative eligible tier without starting a second role pipeline.
- Actual model/reason events contain no user message or model prose; restore only completed owned session turns, including after Core restart.

## Task 1 — Agent config

Files: config schema, config TS interface, config test and generated fixtures/settings/docs.
- [x] Write failing tests for optional modelPolicy {mode,tiers,perTurn}, auto requiring a nonempty unique list, live metadata, defaults and closed bounds.
- [x] Run red; define schema/type; gen and run green.

## Task 2 — Shared session routing

Files: new core/composition/model-routing.ts and model-routing tests.
Interfaces: SessionModelRouting.select(req, profiles, defaultProfile, triage) -> optional selection with ordered candidates, reason, served/finish hooks; restore port and live policy/privacy callbacks.
- [x] Write deterministic client tests for stable session selection, perTurn opt-in, explicit/fixed, abort/deadline, eligibility and restore.
- [x] Run red; implement bounded cache/choice and conservative fallback; run green.

## Task 3 — Production router and trace

Files: composition/provider.ts and index.ts, session/role-routing.ts context reservation, SessionEventType/schema, regression tests and handoff.
- [x] Write low-level provider fake tests for exact tier failover and actual-model pinning, privacy/billing, full Core events/cache/restart and explicit override.
- [x] Run red; add per-request synthetic route on the existing router (same budget/secret/privacy/settlement), publish model.selected and restore completed owned metadata; run green.
- [x] Gen/docs, relevant regression suites, typecheck, Rust RPC/Config, formatting/hygiene/diff. No horizontal full suites after green without a new concern.
- [x] Root review, fixes, owner commit/push, genuine Draft stack on F2, attach PR.

## Ledger

2026-10-20: Managed worktree created at gp4-f5-model-routing from F2 c9632307cd. Root confirms one routing choice via shared client in addition to unchanged D105 triage; no further routing choice on session cache hits. Natural messages never set cloudEligible. Inline implementation already authorized.

2026-10-20: Config3 new tests green, total63 configpackage. Routing18 green including realCore restart and realvoice budget. Existing relevantCore261 pass plus1 unchanged opt-inlive skip; RPCschema56pass; RustConfig/RPC148pass0ignored. Typecheck/gen/docsgen/docscheck/fmt/hygiene green. Root review requested against current worktree. No foreign-owned source paths edited.

2026-10-20: Root review found no confirmed correctness issue. Clarified D30 fixed semantics: one agent/default profile, existing profile-internal fallback only; stored tiers activate only in auto. Added fixed-mode regression before final review. Push held pending root followup.

2026-10-20: Self-review found that swallowing a failed durable cache read could silently reselect after restart/cache eviction. Added a red test, then refuse with content-free model-policy-state-unavailable before any choice. Relevant routing suite18 green.

2026-10-20: Root completed independent source review, including restore ownership/current profiles and same-router admission; no actionable findings. Fixed contract regression and durable-read fail-closed regression are green. Root cleared owner commit and Draft-stack delivery on F2.
