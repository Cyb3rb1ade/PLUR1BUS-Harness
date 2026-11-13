# RY-A progress

Branch `codex/ry-a-rust-engine-jobs`, based on A0 `3994f2fe6e`.
This is the restart checkpoint. Read the RY plan and the 2026-11-13 addendum in
`/Users/cyberblade/worktrees/reviews/` before continuing. Use this checkout for all changes.

## Rulings

- RE-D177: Use the owner's explicitly named A0 head while #908 is open. The starting
  `origin/main` (`ee3fc2d41a`, RX merge) is already an ancestor. Integrate later main
  by merge. Open the single ready PR at the end as requested.
- RE-06 T0: Local `pnpm parity --check tests/engine-parity/scenarios` on the A0
  binary produced 15/15 comparisons, 0 failures, 0 skips. See
  `/tmp/ry-a-baseline-parity.md` for the per-engine table.

- RE-D178: A refused step leaves the active migration's lease alone, even if its
  request names that migration. Only the accepted operation can settle its lease.
  If the Core gives up after a refused request, expiry resumes compaction.

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
- [ ] F12 Turn metadata seam and F13 principal binding source.
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
- [ ] RE-06 T4 reflection, S6 and A1 importance staging.
- [ ] RE-06 T5 skill mining.
- [ ] RE-06 T6 dreams, S2b, S7 and C6.
- [ ] RE-06 T7 job parity, background read inventory and local acceptance.

## Local evidence

| Command | Result |
| --- | --- |
| `cargo test --locked -p plur1bus-engine --lib --test rpc_server` | Engine library 480 passed, 0 failed, 1 ignored. Process 31 passed, 0 failed, 0 ignored. |
| `cargo clippy --locked -p plur1bus-engine -p plur1bus --all-targets -- -D warnings` | Exit 0 at the A1 checkpoint. |
| `node --test scripts/tokens/*.test.mjs scripts/ci/*.test.mjs` | 195 passed, 0 failed, 0 skipped. |
| `node scripts/parity/module-map.mjs --check` | Exit 0, map current. |
| `cargo test --locked -p plur1bus --bin plur1bus backup::retention` | 6 passed, 0 failed, 0 ignored. |

New goldens disclosed before commit. `tests/fixtures/prompts/hashes.json`
records four Phase 1 prompt functions at pin `9f34008c`, with empty and
populated input (SHA-256 `3ec2ceb0d8e97f88bef218185ca1c6ad9ff019db0dd407bc240f8f6d3e532241`).
`tests/fixtures/prompts/cache-key.json` records the pin's SQLite key for a
prompt split inside a surrogate pair (SHA-256 `8539c232cfe92a4c860644c0dc21bdc78b22b220ca04910da1974d07a71f0bc7`).
Each recorder invocation checked two runs, and two invocations matched.
