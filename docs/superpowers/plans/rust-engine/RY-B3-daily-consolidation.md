# RY-B3 — Daily similarity compaction and conflict resolution

One PR after RY-B2 and before RY-C. Merge it before RE-11 removes the Node engine. Allow 4–6 agent days.
Reference behavior: engine pin `9f34008c143c5da87b2194b5a28442b407ff8ba7`, in
`engine/jobs/internal-job-bodies.js`, `lib/jobs/daily-consolidation.js`,
`lib/jobs/memory-compaction.js` and `lib/jobs/conflict-resolver.js`. Start from the Rust
`jobs/consolidate_daily.rs` and `jobs/lance_scope.rs`. The detailed reason for the gap is in
[Phase 1 evidence](../../../evidence/engine-parity-phase1.md#open-findings).

| Part | Input and output | Estimate |
|---|---|---:|
| Similarity compaction | Under the job grant, scan the selected Lance table and its eligible owned rows (text, vector, time, identity and epistemic state). Port the lookback (30 days), similarity (0.88), batch size (50), exact duplicates, overlap cursor and proposal selection. Without an LLM merge route retain the deterministic delete/redundancy/conflict **proposals**; the daily caller does not set `autoApply`. Preserve the existing proposal envelopes in `.adaptive-learning/merge-proposals.jsonl` and the compatible compaction fields of the Neo run state wherever the pinned path reads or writes them. | 2–3 AT |
| Conflict resolution | Read `.adaptive-learning/conflict-log.jsonl` and `conflict-resolved.jsonl` for the permitted workspace. With the `conflict-resolution` route, select unresolved pairs aged at least seven days, up to 20 per run. Append the pinned `original`, decision, confidence, recommendation and timestamp envelope; uncertainty and low confidence remain review outcomes. No route or unauthorized workspace means no call or append. The job does not apply a decision to Lance; use the existing native review/apply path separately. | 1–1.5 AT |
| Parity and recovery | Record Node fixtures with the unchanged pin and a fake LLM port, freeze the inputs, and run the Rust path on them. Verify identifiers, ordering, ACL envelopes, unknown JSON fields, no-route proposals, route-present conflict outcomes, idempotence across restarts and a mixed Node→Rust→Node round trip. Exercise interrupted publication and re-check ownership and tombstones before a write. | 1–1.5 AT |

Reuse the job's caller-bound partition and current policy throughout. Scope every scan and file access to the exact
agent, workspace and owner; re-check bindings before publishing so a stale grant or row cannot widen visibility.
For private/user partitions require an owner-bound sink, never the shared workspace output. Preserve the current
TTL, decay, Neo prune and physical Lance optimize. No new RPC surface or Node pin is needed. Keep the parity
exception from RY-B2 until this evidence passes.
