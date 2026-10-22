# F2 Decision Service Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Root supplies the independent final review.

**Goal:** Route production triage, primitive requests and pruning through one bounded DecisionClient.
**Architecture:** The Core client owns admission, deadline, validation and aggregate telemetry. Its role backend delegates every model request to the existing composition router; D70 module packaging remains F3/F4/F7.
**Tech Stack:** Node 24.21, TypeScript strip-types, existing provider router, JSON Schema and Rust typify.
**Spec:** ADR-015; GP4 F2; core design D18/D30/D33/D34/D69/D70/D105; D116 §§7–8.

## Global Constraints

No Engine pin/lock or dependency changes, no paid/cloud test calls, no amend/rebase/force push, no CI polling. Closed experimental RPC methods; Owner/Admin human-only synthetic test. Config read per request. Raw tool output stays local. Existing D105 validator/task boundaries remain authoritative.

## Review Focus

- Abort-ignoring backend must release caller promptly; late results cannot emit success.
- Fallback attempts share one deadline; low-confidence or malformed responses never become successful decisions.
- Live local-only changes and explicit cloud role refusal prevent invocation, including failover.
- Pruning cannot remove protected pairs or use uncertain decisions; cloud never receives raw output.
- Global status and persisted decision events contain no prompt/model prose; human-only probe stays outside model surfaces.

## Task 1 — Client and role execution

Files: new `packages/core/src/decision/{types,client,role}.ts`, tests `packages/core/test/decision/client.test.ts`.
Produces: `DecisionClient` with `noul`, `choice`, `score`, internal `triage`, `status`; shared backend interface.
- [x] Write tests for primitive normalization, malformed distributions, confidence, deadlines, cancellation, shared fallback budget, unavailable and privacy failures, aggregate telemetry.
- [x] Run focused tests red; implement the bounded client and role port; run green.

## Task 2 — Production consumers and trace

Files: session role-routing/maintenance/service/types; composition; new pruning adapter; tests decision/production.test.ts.
Consumes the client; supplies existing provider-router-backed role invocation, live config and authenticated ChatRequest.
- [x] Write production tests with fake low-level streaming adapter: D105 results/task boundaries preserved, live settings effective, usage charged; protected pruning and no cloud raw outputs.
- [x] Run red; migrate classifier and pruning port, persist mapped `decision.completed` events; run green and existing triage/pruning/session suites.

## Task 3 — RPC and inventories

Files: RPC schema, RBAC guard, WebMCP deny table, Rust RPC test tables, generated docs/types/fixtures, composition surface and regression tests.
- [x] Write human-only Owner/Admin and model exclusion tests; production probe fixed synthetic input; status redaction/metrics.
- [x] Run red; add schema-first status/test handlers and method inventories; gen/docs:gen; run green.
- [x] Typecheck; relevant package suites, Rust RPC suites, docs:check, lint hygiene and diff check. Record exact results and genuine gaps in F2 handoff.
- [ ] Root independent review and fixes, owner commit, push, Draft stack against F1 and attach PR.

## Ledger

2026-10-20: Native managed worktree created from F1 c569c89a30. Inline execution already authorized by task; no further plan approval needed. No model calls in verification.

2026-10-20: Client, role transport and production composition wired. Red→green observed for missing client/transport, primitive validation/deadline cases, production shared-client wiring, pruning bridge, RPC exclusion, local→cloud pruning failover, and long-message D105 compatibility. Decision tests: 18/18 pass after review fixes. D105 bridge alone retains the existing 200,000 UTF-16 message limit; portable primitives retain ADR-015's 16,384 limit. This compatibility exception avoids changing admitted legacy messages. Auto native backends require an explicit eligibility predicate; none is installed in F2.

2026-10-20: Relevant Core regression suites: 867 pass, one pre-existing opt-in live model skip. RPC schema: 56 pass. WebMCP: 652 pass, 132 existing TODO, no failures. Full Core wire test proves shared triage/probe accounting and persisted redacted turn events. Rust fixtures initially exposed integer-vs-float JSON fixture representation; changed number-valued latency fixtures to non-integral values, without loosening schemas/assertions. Root requested no further horizontal full-suite expansion.

2026-10-20: Root review found throwing backend eligibility/locality predicates could escape the result envelope. Two failing regression cases reproduced the leak; predicates now fail closed as unavailable, fallback rechecks privacy, and completion metrics/trace remain present. Rust RPC 89 pass; generated docs/check, formatting, hygiene and typecheck pass.
