# F2 — Decision service and existing role backend

F2 is stacked on F1 (`codex/gp4-f1-decision-contract`, c569c89a30). F1 defines ADR-015/config; this phase supplies the running Core client. D70 module packaging and native/cloud-specific backends remain F3/F4/F7.

## Result

One `DecisionClient` per production composition handles `noul`, `choice`, `score`, plus the internal D105 compatibility bridge. Every request reads current backend/budget/confidence/privacy settings. Attempts share one monotonic deadline, propagate abort and race an abort-ignoring backend; late responses cannot emit acceptance. Outputs validate probability distributions, selected IDs, score expectation and confidence. Status contains process-lifetime counts, per-backend counts, error rate and a bounded 512-request latency window.

The role backend delegates through the existing `createTurnProvider` router, keeping auth leases, egress, billing fallback, budget admission and usage settlement. It offers no tools or memory. The served provider/model is recorded as `modelRevision`; role self-reported confidence stays `uncalibrated`, Noul confidence is derived as max(p,1−p). No new dependency, Engine pin or lock change.

The production D105 classifier now uses this client; task-boundary selection and the existing triage validator remain authoritative. Its internal bridge preserves the existing 200,000 UTF-16 message admission, while portable primitive state remains limited to 16,384. This documented compatibility exception avoids making existing large messages core-only merely because the client was introduced.

The existing binary pruning port goes through `choice keep|drop`; the original pruner still rejects protected, recent, restored or concurrently modified pairs. Raw tool pairs force local processing, including provider failover. Unavailable, invalid, low-confidence or privacy-refused decisions retain originals. This replaces the absent-Laya heuristic fallback in the composed decision path with ADR-015's conservative keep; an explicitly selected heuristic pruner remains unchanged. F6 owns truncate and richer pruning policy.

`decision.status` and `decision.test` are experimental core RPC methods, since 1.6.0, with closed params, Owner/Admin human-only RBAC, WebMCP exclusion and Rust/fixture inventories. The test accepts only agentId and asks the fixed synthetic parity question for 2; no arbitrary prompt, tool, memory or transcript write. The full Core test exercises real socket handlers with a fake low-level streaming provider, rather than replacing the service/router.

`decision.completed` is a mapped SessionEventType, persisted and replayed for foreground requests under existing session/transcript RBAC. It contains request/primitive/use-case, eligible attempts, elapsed time, outcome, backend/model revision and confidence provenance; no raw state, option descriptions or model prose. Background calls without a running turn emit the same redacted completion metadata to the normal Core log. Telemetry errors never invalidate admission. Aggregate status resets on Core restart; session events retain the durable audit trail.

## Validation

Node `/Users/cyberblade/.node24/bin/node` 24.21.0; Rust 1.95.0. All inference tests use local in-process recorded/scripted response shapes, no paid or cloud calls.

- Decision suite: **18 passed**, no skip/TODO; includes full Core RPC/session replay, shared budget admission, abort-ignoring backend, total fallback deadline, malformed/uncertain outputs, unavailable role, current local-only checks, protected pruning, and local-to-cloud pruning failover.
- Relevant existing Core suites (triage, role routing, compaction, composition opening, RBAC): **867 passed**, **one existing opt-in live evaluation skip**, no failures. No test was weakened or newly skipped.
- RPC schema package: **56 passed**, no skip/TODO.
- WebMCP package: **652 passed**, **132 pre-existing TODO**, no failures; decision methods pass their new authorization/exposure checks.
- Rust RPC workspace crate: **89 passed**, zero ignored/failures; typed fixtures, roundtrips and generative tables include both new methods.
- TypeScript typecheck, `pnpm gen`, `pnpm docs:gen`, `pnpm docs:check`, Rust formatting, hygiene and diff checks pass. Shared Cargo target requires explicit `PLUR1BUS_BIN` for docs generation; the standard scripts were rerun successfully with that path.

## Remaining phases

No installed Laya/Kev/Jev backend is claimed. Auto native selection requires affirmative hardware/language eligibility evidence. Native measurement, model catalog/download, German calibration and D70 packaging belong to F3/F4; no paid/cloud approval is implied. F5/F6/F7 own new routing policy, three-way pruning, skill selection, D116 adapters and the settings UI. The F2 diagnostic is callable now; UI integration follows F7. Existing WebMCP TODOs and opt-in evaluation skip remain outside this phase.
