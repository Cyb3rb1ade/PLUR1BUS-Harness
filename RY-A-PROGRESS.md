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
  human fails closed. F13 adds the reverse method on RPC 1.26. The existing
  `engine.jobs.run` schema stays closed to identity input. A linked identity
  must use the engine's registered channel vocabulary. Legacy Core behind the
  front door additionally needs the matching kernel parent and incarnation.
- RE-D181: F12 adds an optional outer `engine.capture.messageMetadata` field at
  RPC 1.26. The authenticated Core derives milliseconds from committed session
  rows and tool data from its redacting dispatcher. Provider-reported tool
  results do not qualify. Each request carries at most 256 source records
  and 256 KiB of tool content from the Core. Accepted tool messages are Neo
  input only. The normal fact/reminder selectors continue to take only user and
  assistant text. Older engines receive the original two messages. Replay
  reads the stored metadata with the original authority. The frozen Node
  contract is unchanged.
- RE-D182: Keep the pin's public `auto-accept-stale` name and 24-hour cutoff.
  Declassify the card to a confirmed note. Limit mutations to active
  agent-private cards with explicit matching owner and workspace. Legacy
  ownerless rows are ineligible. The existing ACL and workspace policy are
  checked before a conditional Lance update of the observed binding and type.
- RE-D183: S7 publishes the existing diary format only for the job's exact
  owner, agent and host workspace and the derived agent-private source scope.
  The cooperating writer lease covers both dream modes. The run hash also
  deduplicates retries that regenerate different prose. Date rendering uses
  the supplied zone, with numeric GMT offsets outside supported short names.
- RE-D184: GC targets the current Lance write namespace for one granted agent
  and exact private owner/workspace. Apply configured thresholds only to that
  pool; protected `neverForget` and core rows never qualify. A private full-row
  archive under the pin's sibling `archive/<agent>` directory is synced before
  marking a row archived. The filename uses the archived byte digest so retries
  reuse the same snapshot. GC creates no forget tombstone. The global legacy
  workspace report is outside this scoped port.
- RE-D185: Scheduled Neo retention ranks eligible revision groups lexicographically
  by status, salience/strength, confidence and age, as stated in the Controller's
  N2 decision. The release's numerical score is not used when these orderings
  disagree. Only exactly bound private rows of the canonical Capture workspace
  qualify. This increment leaves graph and indexed candidates pending endpoint
  revalidation and paired index cleanup. The Node pin prunes REM partition stores
  and omits the Capture workspace hook store. That bridge gap remains until RY-C.

- RE-D186: The deterministic episode rebuild uses the canonical owned Neo
  journal, a one-day window, up to 2,000 episodes and 5,000 turns. The pinned
  two-second time-window fallback uses only the granted owner's live user and
  assistant turns. New revisions are published together by atomic replacement
  under the capture lease. A source/version fingerprint deduplicates a retry.
  Capture reads a newer rebuild revision before continuing the open episode.
  The optional narrative uses the authenticated Core router and pinned
  500-token episode prompt when merging is enabled. Vault writes belong to
  RE-07. The existing process dry-run outcome stays `dry_run_unsupported`.

- RE-D187: The daily body uses the capture workspace and the original native
  writer lease for N2. Protect source turns used by open episode checkpoints and
  pending targets even if a foreign queue ID collides. Carry removed IDs into
  append-history so capture retries cannot resurrect them. The correction
  receipt lookup retains its latest 1,000 owned entries. The scoped TTL
  predicate requires the exact agent, owner, workspace and memory kind.
  It keeps the pin's strict expiry and permanent-card guards. The report
  writes only counters for both steps. Daily dynamics, compaction, conflict
  resolution, knowledge budget and graph cleanup remain open.

- RE-D188: The recent critical classifier scans at most the pinned 500 active
  untyped cards in the owning DB's 24-hour default window. Native filters
  require the exact private owner, agent and workspace. Provider failures leave
  the row untyped. A covered chunk is classified without inference only after
  the whole covering it commits. The update rechecks the current row and source
  version. Direct feature settings refuse host-route fallback. Critical push
  delivery, direct feature transport and the complete Node delta are open.

- RE-D189: N3 approval uses the v7.19.2 shared metadata/hash envelope for
  automatic and human review. Canonical JSON sorts UTF-16 property names and
  reproduces JavaScript number formatting. A low-risk adversarial pass
  cannot authorize a wider user scope, and payload drift prevents apply.
  The prepared codec grants no writer access. Integration still needs the
  scoped Skill Miner publisher and the RE-13 T3 review writer.

- RE-D190: Emotion refinement scans exactly owned agent-private pending cards
  (100 rows, four minutes). Importance refinement runs with T3 disabled. When
  Schicht 1.5 is enabled, fact/decision candidates get a retryable pending
  record before the conditional final judgment, including a low judgment.
  Another owner's queue entry survives normalization or the write fails
  closed. The foreground reviewer consumes a final low verdict with
  `importance-below-threshold`. Inactive rows get finalized without inference.
  Direct feature transport and the complete Node job golden remain open.

- RE-D191: A feature-owned transport resolves `apiKeyRef` for every call.
  A missing, denied or empty secret prevents the HTTP request even if a
  literal is configured. Use the guarded client with the same deadline for
  secret resolution, egress, connection and response. Private prompt bodies
  stay at the configured endpoint, so a redirect fails. Auth headers come
  from the credential policy. The S8 path is wired for the recent classifier
  and emotion encoding. Host-route reasoning and persistent caching are open.

- RE-D192: C5 daily graph cleanup reads the canonical Capture graph while
  holding the Neo writer lease and the Lance mutation gate. Only exact private
  edges with two independently verified private Lance endpoints are judged.
  Inactive or pinned weak/old edges may be removed. Absent rows, episode
  anchors, foreign rows, and incomplete bytes are preserved. The endpoint
  snapshots and original graph bytes are rechecked before atomic publication.

- RE-D193: The native reminder queue is the Lance row's scoped `pending`
  state. The legacy workspace JSON queue has no human binding. Native recall
  surfaces due or pending rows only in the exact person's proved direct chat
  and applies the tombstone mask. Webhook dispatch reserves an attempt before
  I/O and uses the row ID as `Idempotency-Key`. A confirmed HTTP failure
  retries after five minutes through attempt five. An ambiguous transport
  outcome or failed post-delivery status write leaves the row pending for
  local recall. HTTP 2xx headers suffice to acknowledge delivery. The frozen
  host has no reminder delivery callback, so that configured mode skips.

- RE-D194: Light Dream runs on Harness and Manual triggers. Its source is the
  latest exact-owner private Capture session with a user turn in the past 24
  hours (up to 20 turns). Its fingerprint binds owner, agent, workspace and the
  selected source revisions. A second leased read fences publication. Use the
  pinned 400-token limits for insights and Light Dream narrative. Persist a
  valid narrative in the Neo diary before exporting it to DREAMS.md. An
  interrupted export resumes the exact stored prose without another model call.
  The narrative memory, recall strengthening, behavior inference, echo and
  alternate source scopes remain open.

- RE-D195: REM uses the previous ISO week in the configured zone (default
  Europe/Zurich), and one exact private partition. It keeps the pin's
  since-week-start acquisition, 1,000 local or 5,000 remote candidates, and
  10/20 neighbors with adaptive reload through 4,096. Exact stored vectors
  determine cosine and centroid membership. The native deadline caps model
  analysis at 32 clusters. A run with narrative enabled remains incomplete
  without a valid narrative. Its private Neo record freezes pattern revisions
  before the diary export. Continued and already disappeared patterns are
  suppressed. Narrative memory, mood/soul, echo and the complete Node delta
  remain open.

- RE-D196: Scheduled `knowledge-update` reuses the foreground promotion
  planner, source marker, atomic commit and queue cleanup. F13 attestation
  authorizes the scheduled entry point. The native document is in the
  private store under a key derived from agent, exact owner and workspace.
  Foreground private recall rechecks the source row and tombstone before
  embedding a promoted section. An ownerless or foreign row does not grant
  selection or queue cleanup. The original foreground workspace document
  remains a separate publication path. The configured per-run cap applies
  within the sole bound workspace. Daily integration remains open.

- RE-D197: Semantic discovery evaluates only the authenticated private
  Lance partition. Persist a native private link index with the original
  content-hash and entry shape. Bound acquisition to 5,000 rows and honor
  the configured per-run, neighbors and per-record caps. Publish under a
  private lease after rechecking the source rows and feature policy. Vault
  and mirror writes are assigned to RE-07.

## Tasks

- T3 C5 `discover-semantic-links`: `cargo test --locked -p plur1bus-engine
  --lib rpc::engine::jobs_tests::semantic_discovery` 1 passed, 0 failed,
  0 ignored. Explicit false disables writes, the test's one-item limit holds,
  a retry reports unchanged entries, and no foreign row enters the index.
  Workspace Clippy passed.

- Native `knowledge-update`: `cargo test --locked -p plur1bus-engine --lib
  rpc::engine::jobs_tests::knowledge_update` 1 passed, 0 failed, 0 ignored.
  Tests cover the cap, retry, foreign and ownerless pending rows, exact
  private recall and deletion of a source. Workspace Clippy passed.

- T6 Dreams system acceptance: wait for the agent job catalog over the real
  Core connection before testing the scheduler. The original corpus, run,
  idempotency and ledger assertions are retained. `TZ=UTC
  PLUR1BUS_ENGINE_IMPL=rust node --experimental-strip-types --test
  --test-concurrency=1 tests/system/dreams.test.ts` 1 passed, 0 failed, 0
  skipped. Same command with `node` engine 1 passed, 0 failed, 0 skipped.

- T6 REM and C6: `cargo test --locked -p plur1bus-engine --lib rem_`
  2 passed, 0 failed, 0 ignored. The fixtures cover the ISO year boundary,
  scoped Lance neighbors, rejected narrative, interrupted diary and
  retry-safe pattern publication. Workspace Clippy and locked binary build
  both passed.

- T6 model discovery system acceptance: authorize the HTTP fixture's exact
  loopback address and ephemeral port through standard configuration.
  `TZ=UTC PLUR1BUS_ENGINE_IMPL=rust node --experimental-strip-types --test
  --test-concurrency=1 tests/system/model-discovery.test.ts` 1 passed, 0
  failed, 0 skipped. Same command with `node` engine 1 passed, 0 failed,
  0 skipped.

- T6 Light Dream narrative and S2b/S7 publication. Process tests
  `cargo test --locked -p plur1bus-engine --lib rpc::engine::jobs_tests::`
  30 passed, 0 failed, 0 ignored. Workspace Clippy passed with `-D warnings`.
  After adding torn-tail repair, the focused Light Dream test passed again
  (1 passed, 0 failed, 0 ignored).

- T4 C5 reminder dispatch: `cargo test --locked -p plur1bus-engine --lib
  rpc::engine::jobs_tests::reminder_dispatch` 1 passed, 0 failed, 0 ignored.
  The test exercises guarded HTTP, the capped retry and owned pending recall.
  Workspace Clippy passed with `-D warnings`. The Node job delta and
  independent rate-state parity remain open.

- T2/T6 narrative prompts: the S7 German Light and REM prompt layout,
  fenced evidence, mood and length limits match the S7 source. Run
  `node crates/plur1bus-engine/tests/fixtures/prompts/record-dream-narrative.mjs`
  at Node 24.21 with `PLUR1BUS_ENGINE_GIT` and `TZ=UTC`. Two invocations,
  each recording both cases twice, produced SHA-256
  `671479ce6fd6756555bd1f88bce063a5f04af7cca10ebc3f404f77bb4b0cac77`.
  `cargo test --locked -p plur1bus-engine --test jobs job_prompts::` 4 passed,
  0 failed, 0 ignored. Hashes use UTF-16LE to retain a split surrogate.

- Workspace acceptance follow-up: the crash test now publishes its checkpoint
  atomically before the parent can kill the child. The previous file-existence
  check could see a zero-byte checkpoint. `cargo test --locked -p
  plur1bus-engine --test ops ops_tombstone_crash::` 3 passed, 0 failed, 0 ignored.

- F13 acceptance follow-up: add `host.jobs.authority` to Rust generative,
  round-trip and pruned validator fixture coverage. `cargo test --locked -p
  plur1bus-rpc --features server --test generative --test roundtrip
  --test server_dispatch` 28 passed, 0 failed, 0 ignored.

- T3 C5 graph pruning: `cargo test --locked -p plur1bus-engine --lib
  rpc::engine::jobs_tests::daily_consolidation` 1 passed, 0 failed, 0 ignored.
  Workspace Clippy passed with `-D warnings`.

- T2 S8 guarded direct routes: `cargo test --locked -p plur1bus-engine
  --lib jobs::llm::` 5 passed, 0 failed, 0 ignored. The loopback test verifies
  rotation, unresolved reference before I/O, body/limits and redirect refusal.
  `cargo test --locked -p plur1bus-engine --lib rpc::engine::jobs_tests::`
  28 passed, 0 failed, 0 ignored. Workspace Clippy passed with `-D warnings`.

- T4 emotion-refine: native job, owned queue staging, pending judgment and
  below-threshold consumption verified. `cargo test --locked -p
  plur1bus-engine --lib rpc::engine::jobs_tests::` 28 passed, 0 failed,
  0 ignored. `cargo clippy --workspace --all-targets --locked -- -D warnings`
  passed.

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
- [x] A1 addendum at 01:10 UTC: the shutdown-deadline test waits for the
  stderr reader to observe EOF before testing the complete warning. The wait is
  bounded. `cargo test --locked -p plur1bus --test core_run_engine
  an_engine_that_ignores_shutdown_is_killed_after_the_deadline`: 1 passed, 0
  failed, 0 ignored on macOS.
- [x] F12 Core session metadata through RPC 1.26 to the authenticated Neo
  journal and episode selection. Recovery carries the same metadata from its
  durable admission. Node projection fixture and native Neo suite: 212 passed,
  0 failed, 0 ignored at the projection checkpoint. Focused Core tests:
  68 passed, 0 failed, 0 skipped after checking the real lifecycle wrapper,
  which forwards the native capture extension to the EngineClient. RPC schema: 122 passed, 0 failed, 0 skipped.
  `cargo test --locked -p plur1bus-engine --features testkit --test host_guard_contract`:
  21 passed, 0 failed, 0 ignored.
  `cargo test --locked -p plur1bus-engine --lib rpc::engine::capture_tests::`:
  62 passed, 0 failed, 1 ignored. `pnpm docs:gen` and `pnpm docs:check`
  exited 0.
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
  sites, direct feature transport and result-cache integration. Native
  process composition now supplies the authenticated agent-attributed
  completion callback. Its first consumer is the episode narrative. Feature
  model, agent default, router default and Core fallback are tried in order.
  The host and RE-01 contract have the same wire surface.
  `cargo test --locked -p plur1bus-engine --test jobs job_prompts::`: 3 passed,
  0 failed, 0 ignored. `cargo test --locked -p plur1bus-engine --lib jobs::llm::`:
  4 passed, 0 failed, 0 ignored after adding model precedence.
  `cargo test --locked -p plur1bus-engine --features testkit --test host_guard_contract`:
  22 passed, 0 failed, 0 ignored, including the authorized child process
  requesting a narrative through the attributed Core completion port.
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
  Native `auto-accept-stale` is also installed. Process job tests with the
  pinned Node delta and owner-isolation assertions: 22 passed, 0 failed, 0 ignored.
  Native `gc-run` is installed with the original threshold/protection rules
  and an archive-first status change. Job composition tests: 23 passed, 0
  failed, 0 ignored. N2 now has a native scoped selector and archive-first
  writer for independent journals. The installed daily body runs scoped TTL
  expiry and calls the canonical Capture workspace retention, reporting
  `expiredDeleted` and `hookStorePrune`. The graph endpoint fence, indexed
  candidates, cross-month retry and remaining daily steps are open.
  Process job tests: 26 passed, 0 failed, 0 ignored.
  Native `classify-recent` executes scoped classification and chunk deduplication
  through the attributed host route. The process suite checks owner and dream
  exclusions, assistant-source handling, retryable transport and repeat runs.
  `cargo test --locked -p plur1bus-engine --lib rpc::engine::jobs_tests::`:
  27 passed, 0 failed, 0 ignored. Critical Push delivery is still open.
  `cargo test --locked -p plur1bus-engine --lib neo::retention::`:
  2 passed, 0 failed, 0 ignored.
  Native deterministic `episodes-rebuild` is installed. Node field deltas,
  foreign-owner isolation, retry deduplication and ordinary Capture continuation
  are covered by `cargo test --locked -p plur1bus-engine --lib rpc::engine::jobs_tests::`
  (25 passed, 0 failed, 0 ignored). The optional narrative route is wired
  through the production Core RPC path. A follow-up applies Clippy’s equivalent `is_none_or` predicate. Workspace
  Clippy then exited 0. Body-owned numeric outcomes for rebuild, GC and
  critical expiry use the frozen `JobRun.counts` field. Counts for Lance
  mutations come from the conditional write result. Process job tests:
  25 passed, 0 failed, 0 ignored, including count persistence through history.
- [ ] RE-06 T4 reflection, S6 and A1 importance staging. S6 marker validation and
  the updated locale detector are implemented as reusable guards. Persona file
  mutation, prompting and other reflection bodies remain open.
- [ ] RE-06 T5 skill mining. Version-2 decision cache with exact ordered
  fingerprints, seven-day expiry, bounded atomic writes and terminal-only
  decisions is implemented. Grouping, catalogue selection, proposal writes,
  supersession and wiring N3 into the writer remain open. The N3 metadata
  and apply-time hash revalidation match v7.19.2 in the focused codec test.
  `cargo test --locked -p plur1bus-engine --lib jobs::review_approval::`:
  2 passed, 0 failed, 0 ignored.
  `cargo test --locked -p plur1bus-engine --lib jobs::skill_decisions::`:
  3 passed, 0 failed, 0 ignored.
- [ ] RE-06 T6 dreams, S2b, S7 and C6. S7 content validation and evidence framing
  are implemented. The S7 diary writer checks owner, workspace policy, source
  scope and output, then publishes under a cooperative lease with both narrative
  and logical-run fingerprints. Engine diary tests: 3 passed, 0 failed, 0
  ignored. Light/REM body integration and narrative memory publication remain
  open. Rust system probes: 0 passed, 2 failed, 0 skipped. A trial wait for
  model readiness timed out in Dreams; the test change was reverted.
  `model-discovery` reached its scan and refused HTTP fixture egress with
  `egress_scheme`. Both suites still need to pass.
- [ ] RE-06 T7 job parity, background read inventory and local acceptance.

## Local evidence

At `540868b472`, `cargo test --workspace --locked --no-fail-fast` on
Node 24.21.0 with the local Rust engine binary completed across 206 suites.
5,561 passed, 0 failed, 11 ignored. See `/tmp/ry-a-workspace-node24.log`.
The final gate must run again on the completed head.

The workspace run through `720d89d41d` recorded 2,957 passed, 1 failed and 3
ignored in 80 suites before stopping. It failed in the existing macOS
`sandbox_limits` suite. `acp_watchdog_counts_streaming_same_group_orphan_rss`
returned attach failure 125 on an `ESRCH` sampling race, with 4 tests passed
and 1 failed in the suite. The individual retry passed (1 passed, 0 failed,
0 ignored). A complete green workspace run still needs to be recorded.

| Command | Result |
| --- | --- |
| `cargo test --locked -p plur1bus-engine --lib --test rpc_server` | Engine library 480 passed, 0 failed, 1 ignored. Process 31 passed, 0 failed, 0 ignored. |
| `cargo clippy --locked -p plur1bus-engine -p plur1bus --all-targets -- -D warnings` | Exit 0 at the A1 checkpoint. |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | Exit 0 after correcting test-only lint findings and consuming the constructor's host handle. |
| `node --test scripts/tokens/*.test.mjs scripts/ci/*.test.mjs` | 195 passed, 0 failed, 0 skipped. |
| `node scripts/parity/module-map.mjs --check` | Exit 0 after regenerating the P4-10 inventory for the F13 source and test. |
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


New golden `tests/fixtures/jobs/stale-criticals.json` records the pinned
`expireStaleCriticals` job with a synthetic DB adapter. It includes the cutoff,
ordered writes, output counts and final row columns. Two UTC recorder
invocations, each executing the job twice, returned SHA-256
`7af185e27b829d1ffb2f732e7ad7040ce7f9e8614a2f65dca1a47af790860e04`.


New golden `tests/fixtures/jobs/skill-decisions.json` records the original
`clusterFingerprint` and reuse predicate at plugin-line `v7.18.31`
(`6419a60e79975d0b5244798c1fdbbd7997a712ce`). Two UTC invocations, each
recording twice, returned SHA-256
`007e7dabb27fd55985e4bba7d3f9bb067c098641edc0e2c57510ac8dbaad0f27`.


New golden `tests/fixtures/jobs/dream-diary.json` records S7's original
diary functions from `c3cf52fda7ad281dca1277ce00bc981f3fa344e1`. It covers a
preserved existing note, a retry with changed prose and four time zones. Two
UTC invocations, each recording twice, produced SHA-256
`c0c83727b6976f02f7bfc78c816797d15603c7f86bef89a3f6e9d90ea87dfc1c`.


New golden `tests/fixtures/jobs/gc.json` records pinned GC selection and
actual archive-before-status writes using synthetic rows. Two UTC invocations,
each running the pinned functions twice, produced SHA-256
`688db385c2fdc8524481a1ddcc302f10333c5153ffd98a7b5d5925557f657b26`.

New golden `tests/fixtures/jobs/neo-retention.json` records the Node v7.19.3
selector for cutoff, revisions, and protections. Two UTC invocations, each
running the reference twice, produced SHA-256
`a91ed49234abed717e6412650130c1f3e74345f6d0286b4ca80b176ad3b47913`.

New golden `tests/fixtures/jobs/episode-rebuild.json` records deterministic
`rebuildEpisode` from pin `9f34008c`. Two UTC invocations, each running it
twice, produced SHA-256
`91e0b66758783650ea15173f4ffb9dc43a0d50ab635fcd5f56cfc2b40c410a32`.

New golden `tests/fixtures/jobs/review-approval.json` records approval
metadata and payload drift from v7.19.2
(`3c42b39ba8d5a6522e9201c26c3cad267590636d`). Two UTC invocations, each
running the original helpers twice, produced SHA-256
`6a8938b551d2fac03e16099ef1dec2013ec958680b8c90dc6de7875ebfb66ab2`.
