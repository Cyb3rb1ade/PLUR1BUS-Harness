# RY-A progress

Branch `codex/ry-a-rust-engine-jobs`, based on A0 `3994f2fe6e`.
This is the restart checkpoint. Read the RY plan and the 2026-11-13 addendum in
`/Users/cyberblade/worktrees/reviews/` before continuing. Use this checkout for all changes.

## Rulings

- RE-D177: Use the owner's explicitly named A0 head while #908 is open. The starting
  `origin/main` (`ee3fc2d41a`, RX merge) was already an ancestor. #908 merged as
  `f19a358ff4`, with the same tree as A0. Merged it into RY-A. Use `main` as the
  eventual PR base and open the single ready PR at the end as requested.
- RE-06 T0: Local `pnpm parity --check tests/engine-parity/scenarios` on the A0
  binary produced 15/15 comparisons, 0 failures, 0 skips. See
  `/tmp/ry-a-baseline-parity.md` for the per-engine table.

- RE-D178: A refused step leaves the active migration's lease alone, even if its
  request names that migration. Only the accepted operation can settle its lease.
  If the Core gives up after a refused request, expiry resumes compaction.
- RE-D179: A native job grant identifies one job, one agent and a live host
  workspace. The trusted host must independently attest the person and standing
  grant. Agent use/manage rights, the installation owner, capture provenance and
  the cron origin are insufficient as a standing job grant. Refusal precedes
  registry writes; the grant is never serialized to the job ledger.
- RE-D180: The producer uses the existing, chain-verified D109 GrantStore with
  `memory.jobs.run`, `scope=always` and `jobId=engine:<job>`. Only the
  grantee's own active, non-delegable grant, current agent/private-memory RBAC
  and a live link for the exact human principal qualify. More than one eligible
  human fails closed. RPC 1.26 adds the reverse method only. The existing
  `engine.jobs.run` schema and EngineClient are unchanged. A linked identity
  must use the engine's registered channel vocabulary. Legacy Core behind the
  front door additionally needs the matching kernel parent and incarnation.

## Tasks

The first Rust test compile exposed three stale field/guard references in A1.2–A1.4.
Fixed in a follow-up commit. Re-run the affected tests before final acceptance.

- [x] A1.1 Align invalid Cron with `E_INVALID_PARAMS` (exit 2). Syntax check
  passed. Node Dreams system suite 1 passed, 0 failed, 0 skipped. Rust reaches the
  next assertion (`no_jobs` versus `min_corpus`), tracked under T6.
- [x] A1.2 Move the compaction lease into the coordinator's exclusive operation.
  Regression coverage checks unrelated IDs, bad proofs, and release after an admitted
  source-drift failure. Covered by the A1 engine library run below.
- [x] A1.3 Publish `unsafe-root` only for a verified untrusted path. An absent
  store or another unavailable probe reports unsupported without a root verdict.
  Added status assertions for an absent store and a replaced root.
- [x] A1.4 Initialize the store base after locking the home and binding the listener,
  before publishing readiness. The process test changes the configured base between
  starts and checks that a refused second process leaves the new base absent.
  Process suite passed (see below).
- [x] A1.5 Document the portable idle-session cache bound. Each cached session retains
  filesystem handles and an exclusive lease. LRU eviction reopens the session on use.
  The cap and eviction behavior are unchanged.
- [x] A1.6 Exercise the real Core scheduler and its engine RPC client with both
  values of the recall-stats flag. Assert the stats call and agent scope when enabled
  and confirm promotion remains gated. Targeted test: 1 passed, 0 failed, 0 skipped.
- [x] A1.7 Document the accepted retention range (1–999,999,999), emit an explicit
  missing-directory warning, and regenerate CLI docs. `pnpm docs:gen` succeeded.
  `pnpm docs:check` succeeded. Targeted CLI tests: 6 passed, 0 failed, 0 ignored.
- [ ] F12 Native Neo projection and persistence use the same metadata for the
  journal and episode watermark. Unannotated messages retain their original
  behavior. Live Core turn metadata, RPC 1.26 and durable capture admission
  remain open. `cargo test --locked -p plur1bus-engine --features testkit --test neo`:
  212 passed, 0 failed, 0 ignored.
- [x] F13 native admission and the Core binding source. Scoped bodies use
  the reverse port; `embedding-drain` is the first live consumer. Foreground
  job requests cannot supply an owner. `grant add` accepts a standing
  `--job-id`. The Core unit test uses the real grant and identity stores.
  `cargo test --locked -p plur1bus-engine --features testkit --test jobs`:
  72 passed, 0 failed, 0 ignored.
  `cargo test --locked -p plur1bus-engine --features testkit --test host_guard_contract`:
  20 passed, 0 failed, 0 ignored. Focused Core engine tests: 14 passed,
  0 failed, 0 skipped. `pnpm --filter @plur1bus/rpc-schema test` at 1.26:
  121 passed, 0 failed, 0 skipped.
- [ ] RE-06 T2 prompt layer and LLM routing, S8. First increment adds four
  versioned renderers and offline hash vectors, CP-1 limits, route credential
  precedence and a UTF-16-compatible cache key. Still open: other prompt call
  sites and the real completion/cache adapters.
  `cargo test --locked -p plur1bus-engine --test jobs job_prompts::`: 3 passed,
  0 failed, 0 ignored. `cargo test --locked -p plur1bus-engine --lib jobs::llm::`:
  3 passed, 0 failed, 0 ignored.
- [ ] RE-06 T3 maintenance and C5. The five C5 job names now share the existing
  same-agent overlap guard. The public singleton flag still controls scheduler
  planning. `cargo test --locked -p plur1bus-engine --features testkit --test jobs`:
  68 passed, 0 failed, 0 ignored, including unchanged Node run fixtures.
  Native `embedding-drain` now uses the shared Neo writer and embedding provider.
  The authorised process test publishes only one of two owners' queues. The
  native drain's existing publication bound of 1,000 attempts and five minutes
  applies (the pin requests 100,000 attempts and eight minutes for the manual
  job). Later runs can continue pending work.
  `cargo test --locked -p plur1bus-engine --lib rpc::engine::jobs_tests::`:
  21 passed, 0 failed, 0 ignored.
- [ ] RE-06 T4 reflection, S6 and A1 importance staging. S6 marker validation and
  the updated locale detector are implemented as reusable guards. Persona file
  mutation, prompting and other reflection bodies remain open.
- [ ] RE-06 T5 skill mining.
- [ ] RE-06 T6 dreams, S2b, S7 and C6. S7 content validation and evidence framing
  are implemented. ACL-bound persistence, retry-safe diary writes and REM remain
  open.
- [ ] RE-06 T7 job parity, background read inventory and local acceptance.

## Local evidence

| Command | Result |
| --- | --- |
| `cargo test --locked -p plur1bus-engine --lib --test rpc_server` | Engine library 480 passed, 0 failed, 1 ignored. Process 31 passed, 0 failed, 0 ignored. |
| `cargo clippy --locked -p plur1bus-engine -p plur1bus --all-targets -- -D warnings` | Exit 0 at the A1 checkpoint. |
| `node --test scripts/tokens/*.test.mjs scripts/ci/*.test.mjs` | 195 passed, 0 failed, 0 skipped. |
| `node scripts/parity/module-map.mjs --check` | Exit 0, map current. |
| `cargo test --locked -p plur1bus --bin plur1bus backup::retention` | 6 passed, 0 failed, 0 ignored. |
| `pnpm lint` | Exit 0, 227 passed, 0 failed, 0 skipped, 3 existing Laya TODOs. |
| `cargo test --locked -p plur1bus-rpc --test fixtures` | 10 passed, 0 failed, 0 ignored. The Rust fixture dispatcher covers `host.jobs.authority`. |
| `pnpm --filter @plur1bus/rpc-schema test` | 120 passed, 0 failed, 0 skipped. |
| `cargo deny --locked check bans licenses sources` | Exit 0, all three checks passed. |
| `node scripts/audit-deps.mjs --only cargo --offline` | 821 packages allowed, 0 violations. |
| `node scripts/release/audit-policy.mjs` | 0 blockers, 0 collection/policy errors. Approved paste exception recorded. |
| `pnpm --filter @plur1bus/core test` | 12,399 passed, 0 failed, 22 skipped, 16 existing TODOs at the native F12/T3 checkpoint. |

New goldens disclosed before commit. `tests/fixtures/prompts/hashes.json`
records four Phase 1 prompt functions at pin `9f34008c`, with empty and
populated input (SHA-256 `3ec2ceb0d8e97f88bef218185ca1c6ad9ff019db0dd407bc240f8f6d3e532241`).
`tests/fixtures/prompts/cache-key.json` records the pin's SQLite key for a
prompt split inside a surrogate pair (SHA-256 `8539c232cfe92a4c860644c0dc21bdc78b22b220ca04910da1974d07a71f0bc7`).
Each recorder invocation checked two runs, and two invocations matched.

New golden `tests/fixtures/job-content/guards.json` records 34 cases from the
S6 (#262) and S7 (#271) review heads. Two independent invocations, each recording
twice, produced SHA-256 `1044608263f514a6794ddbb549b1c72bd98830bb476cee547381fe519ca6a242`.
`cargo test --locked -p plur1bus-engine --test jobs job_content::`: 3 passed,
0 failed, 0 ignored.

New golden `tests/fixtures/capture/golden/neo-host-metadata.json` records
10 synthetic host messages yielding 7 actual Node turn projections from pin
`9f34008c`. Two recorder invocations, each evaluating the batch twice, returned
SHA-256 `7d0cc0a281d0ddb25e811f0247a443680278e9f4f94a38f8aec46e875d6853b4`.
The recorder uses the default 5,000-unit tool result bound and UTC.
