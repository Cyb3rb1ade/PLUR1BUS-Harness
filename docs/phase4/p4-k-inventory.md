# P4-K inventory: what the package ports, and how each part is proven

Package P4-K (card `reviews/paket-p4-k-kern-bibliotheken-2026-11-18.md`), milestone K0, 2026-11-18. Basis `fc113b4e2d`.
K1 was read in full; K2 to K11 are an inventory from file lists, `grep` and the head comments, not from a reading of the code,
so a mode named below for them is a proposal that the milestone's own implementer confirms or corrects.

Parity modes (plan §3): **V** vectors (exporter), **B** store round trip, **T** transcripts, **W** wire fixtures, **S** system
suites. A test file with no mode has its reason in the "no mode" column. Sizes are lines of `.ts` under `packages/core/src` and
`packages/core/test`. A file that is not named in a row is covered by the row's directory pattern.

## 1. At a glance

| Milestone | Source lines (files) | Test files | Stores (file, `user_version`) | Missing crate for `plur1bus-core` |
|---|---|---|---|---|
| K1 budgets, licences | 1,292 + 25 (15) | 16 (in `budget/`, 3 of them helpers) + `budget-rpc` + 2 | `budget.sqlite` v2 (+ lazy tables), `model-licences.sqlite` (unversioned) | **time-zone database** (see K1) |
| K2 policy, egress, audit, attestation | 2,862 (23) | 38 | audit chain files (JSONL, not SQLite) | none found; OS differential needs a CI leg per OS |
| K3 approvals, grants, inbox, delivery, handoff | 3,572 (28) | 37 | `approvals.sqlite` v4, grants (inside it), `inbox.sqlite`, `delivery.sqlite`, `channel-handoff.sqlite` (the last three unversioned) | none found |
| K4 auth, openai-auth | 1,881 (29) | 22 | `openai-plan-usage.sqlite` (unversioned); credential files | HTTP client for the OAuth exchanges (not a dependency of `plur1bus-core`; P4-W owns the provider HTTP) |
| K5 sessions | 4,158 (25) | 38 | `sessions.sqlite` v9 | none |
| K6 collab, coding, federation | 5,433 (36) | 60 | `collab.sqlite` (`migrations.ts`), `coding-gate.sqlite`, `chat-promotions.sqlite` | none found |
| K7 jobs and friends | 5,863 (58) | 72 | `user-jobs.sqlite`, `dreams.db` v7+, learn store v7, `skill-mining.sqlite`, system-job ledger | cron parser unverified (`dreams/cron.ts` is TypeScript of its own) |
| K8 ACP | 1,059 (12) | 17 | none | none |
| K9 prompt, tool-call runtime, decision, triage | 7,030 (65) | 70 | `capabilities.sqlite` (tool-call index) | none found |
| K10 gate, exec, fs, host tools | 2,833 (26) + hostctl 655 (10) | 17 + hostctl 20 | none | process and OS calls: only what `plur1bus-tools` already links (not checked) |
| K11 decision receipts | new (D133) | new | new store | none |



## 2. K1: budgets and licence ledger (P4-24)

| What | Files (lines) |
|---|---|
| `src/budget/` | service 365, calls 291, store 142, peer 79, period 62, retry 68, cache-read-weight 56, cache-report 51, context 46, subagent 37, index 17, media 10 |
| `src/licences/` | ledger 27, memory 41 |
| `src/rpc/session-usage.ts` | 25 |

| Test file(s) | Mode | Note |
|---|---|---|
| `budget/period`, `edges-b14` (periods, zones, DST) | V | pure functions of (instant, zone); needs the zone database (below) |
| `budget/limits`, `service`, `status-breakdown`, `cache-read-weight`, `cache-report`, `audit-b14` | V for the pure rules (weights, counted tokens, thresholds), B for the ledger | the store-bound cases run against the real file in Rust |
| `budget/l8`, `media-units`, `reservations` (call port) | B | reservation, settlement, TTL, hierarchy over `budget_call*` |
| `budget/peer` | B | `a2a_peer_*` tables |
| `budget/concurrency`, `reservations` (worker processes) | none as such | covered by the one-writer rule (`BEGIN IMMEDIATE`) and a Rust test with two connections; the multi-process pool stays TypeScript |
| `budget-rpc`, `rpc/media-budget`, `admin/usage` | T, later | the `budget.*` methods belong to the flip, not to this package |
| `licences/ledger`, `licences/async-precheck` | B (ledger) | `async-precheck` tests the TypeScript config-write path: no mode, belongs to the flip |

Stores: `state/budget.sqlite`, `user_version` 2 (`BUDGET_SCHEMA_VERSION`; v1 has `cost` metric and `cost_micros`, v2 widens the
metric check and adds `images`, `video_seconds`). Created lazily by constructors, outside `user_version`: `budget_call`,
`budget_call_limit`, `budget_call_notice` (call schema `settings.budget_call_schema` 1 or 2) and `a2a_peer_call`,
`a2a_peer_turn_total` (peer port). `state/model-licences.sqlite`: one table, no `user_version`, `synchronous=FULL`.

Ports (R-K-2): clock; audit sink (`rbac::audit::AuditSink`); event sink (`budget.soft/hard`, `warn/reserve/settle/...`);
id source (reservation and peer-call ids); time-zone database; token counter and full-result store for the subagent cap;
the licence catalogue (the four non-commercial model ids and revisions, kept out of product code on purpose).
Not ported here: `deferMaintenanceStart` (composition seam), file permissions via the host's `securePath` (a port, the Rust store
sets 0700/0600 itself), `voice/budget.ts` and `embedding-migrate/budget.ts` (other packages).

Missing crate: **`plur1bus-core` has no time-zone database.** `chrono-tz` is a workspace dependency but only `plur1bus-engine`
lists it. Budget periods are the local day/month/week in an IANA zone, so `period_bounds` needs one. K1 puts it behind the
`Zones` port and tests against a rule-based test double; the production adapter is the one line of `Cargo.toml`
(`chrono-tz.workspace = true`, plus `chrono = "0.4"`, which only `plur1bus-engine` lists too) and the adapter at the end of this section.


**K1 as built** (`crates/plur1bus-core/src/budget/`, one `pub mod budget;` in `lib.rs`; no RPC method, nothing wired into the front door,
`native*.rs`, the relay or the supervisor).

- *Ported:* periods and zone validation (`period.rs`), the cache-read weight (`weight.rs`), the retry rules (`retry.rs`), the context zone
  allocation (`context.rs`), the media-unit mapping (`media.rs`), the subagent result cap (`subagent.rs`), the cache report
  (`cache_report.rs`), the budget service (`service.rs`: limits, `check`, `enforce`, `record_usage`, `status`, settings, `prune`), the call
  port (`calls.rs`: admission, reservations, TTL, settlement, `run`), the A2A peer budget (`peer.rs`) and the licence ledger and the memory
  model check (`licences.rs`). The store (`store.rs`) is `Store::open_owner` with the two migration texts byte for byte; one writer
  (`BEGIN IMMEDIATE`), a newer schema is refused and the file left alone, no money column and no USD amount anywhere. Events go out after
  the commit and the lock release, so a sink may call back into the service, and a panicking sink does not fail the call.
- *Proof:* mode V (`scripts/parity/export-budget.ts`, seven files under `fixtures/parity/budget/`, replayed by `vectors.rs`), the ported
  TypeScript tests (`tests.rs`, `tests_calls.rs`; the call port has no test file of its own in TypeScript, so those tests follow the source and
  `reservations.test.ts`), and mode B (`tests/core-parity/budget-b-driver.ts`, `crates/plur1bus-core/tests/budget_mode_b.rs`): TypeScript writes
  the store at v1 and v2 together with the call, peer and licence tables, Rust migrates, reads and writes, TypeScript reads the result with the
  product code, and the schema text of a migrated or freshly created file equals the one TypeScript makes. The only change to TypeScript is
  behaviour-neutral: `BUDGET_MIGRATIONS` and `migrateBudgetSteps` are exported from `budget/store.ts` (the private `migrate` delegates to it).
- *Deliberately not ported:* the `deferMaintenanceStart` seam and the timer that watches for stale reservations (a host's job; `reconcile_expired`
  is there to call), a `:memory:` licence ledger (a test convenience), and the refusal of an unknown property on an input object (a closed Rust
  type has no unknown property; that refusal is the JSON boundary of the flip). `voice/budget.ts` and `embedding-migrate/budget.ts` belong to
  other packages.
- *Known differences:* `serde_json` prints an object's keys sorted and prints a float differently from `JSON.stringify(v, null, 2)`, so the
  subagent cap's preview of a structured result differs for floats and for key order other than sorted (the vectors use key-sorted values; a
  real caller passes a value, and the preview is then text). A time-zone name is matched exactly by `chrono-tz` and case-insensitively by ICU
  (`utc`, `europe/berlin` are valid in TypeScript; the vectors carry a `note`). `Store::open_owner` sets a 5 s busy timeout of its own, so a
  shorter one given to the service is applied after it. No P4D was claimed: every difference above is either not observable through the
  ports or is in a vector with a note; the controller decides whether any needs a number.
- *Not replayed yet:* the period vectors for `America/Sao_Paulo`, `Australia/Lord_Howe` and `Pacific/Apia` (a skipped midnight, a half-hour
  DST, a skipped day). `vectors.rs` asserts that exactly these three are the ones it does not model, so none is skipped silently; they
  replay as soon as the adapter below stands in for the rule-based double.
- *Ports for the flip:* `Clock`, `IdSource` (`UuidIds`), `Zones`, the event sink (`EventSink`, `BudgetEmitter`), the audit sink
  (`rbac::audit::AuditSink`), `SubagentResultPort`, and the licence catalogue `NcCatalogue` (the four model ids and revisions are given by the
  caller on purpose; the TypeScript ids are in `packages/core/src/licences/memory.ts`).

The production time-zone adapter, once `chrono-tz.workspace = true` and `chrono = "0.4"` are in `crates/plur1bus-core/Cargo.toml`
(which also changes `Cargo.lock`, so it is the controller's change):

```rust
pub struct ChronoZones;

impl Zones for ChronoZones {
    fn is_valid(&self, zone: &str) -> bool {
        zone.parse::<chrono_tz::Tz>().is_ok()
    }

    fn local_date(&self, ts_ms: i64, zone: &str) -> Option<LocalDate> {
        use chrono::Datelike;
        let tz: chrono_tz::Tz = zone.parse().ok()?;
        let at = chrono::DateTime::from_timestamp_millis(ts_ms)?.with_timezone(&tz);
        Some(LocalDate { y: at.year(), m: at.month(), d: at.day() })
    }
}
```

TypeScript's ICU also accepts aliases and case variants (`utc`); fold them in `is_valid` if the flip wants the same set.


## 3. K2: policy, egress, audit chain, attestation (P4-21)

Sources: `policy/`: audit(163) capabilities(124) decide(446) effects(49) headless(17) index(3) paths-index(3) paths(645)<br>`egress/`: gate(77) index(3) model-downloads(24) policy(102) service(105)<br>`audit/`: chain(510) health(149) notices(73) redact-detail(15) rpc(16)<br>`attestation/`: helper(180) index(4) resolve(25) service(93) types(36)

Tests: `policy/`: a2a audit capabilities-table decide decide-hardening decide-shell-path-grant effects-hardening headless paths paths-hardening permission-eval permission-eval-e2e system-tree<br>`egress/`: a2a gate model-downloads policy post-paths rpc service<br>`audit/`: chain chain-crash-recovery chain-eras chain-hardening durability health health-cache notices notices-core notices-log rpc shared-recovery shared-vectors startup<br>`attestation/`: pin resolve service service-hardening

| Tests | Mode | Note |
|---|---|---|
| `policy/decide*`, `paths*`, `effects-hardening`, `capabilities-table`, `permission-eval*`, `headless`, `a2a`, `system-tree` | V, differential per OS | decisions are pure over (action, paths, grants, platform); the card asks for one run per operating system |
| `egress/*` | V | classes and IP classification; `rpc` is T (flip) |
| `audit/chain*`, `shared-vectors`, `durability`, `shared-recovery` | V + a cross-reader test | the chain is JSONL read by the TypeScript verifier; `plur1bus-audit` already writes it |
| `audit/health*`, `notices*`, `startup`, `rpc` | T (flip) | surface and notices |
| `attestation/*` | V | `plur1bus-attest` exists |

Stores: no SQLite. Files: `audit-chain.jsonl`, rotated `audit-chain.<seq:10>.jsonl`, `audit-chain.anchor`, `*.pre-reanchor-<ms>`.
Ports: clock, file system for the chain directory, signer for attestation, platform (OS) probe.


## 4. K3: approvals, grants, inbox, delivery, channel handoff (P4-22)

Sources: `approvals/`: chain(264) code-root(83) db(174) index(4) integrity-job(91) keys(103) notify(103) rpc-common(73) rpc(200) runtime(69) service(613) signing(41) store(227) wire(102)<br>`grants/`: index(2) open(42) rpc(157) store(474)<br>`inbox/`: index(5) migrate(18) producers(86) service(71) store(208)<br>`delivery/`: policy(21) rpc(14) service(155)<br>`channel-handoff/`: rpc(14) service(158)

Tests: `approvals/`: audit-c01 chain core-integration db integrity-job keys notify notify-transport rpc-approvals rpc-attestation rpc-grants runtime scope-offers service signing store store-cancel<br>`grants/`: attested audit-findings audit-hook decide-integration engine-owner-grants integrity lifetime-core once store system-tree-grants<br>`inbox/`: audit-c04 producers store<br>`delivery/`: cross-channel-memory policy rpc targets<br>`channel-handoff/`: core handoff host

| Tests | Mode | Note |
|---|---|---|
| `approvals/store*`, `db`, `chain`, `service`, `integrity-job`, `keys`, `signing`, `scope-offers` | B + V (chain, signatures) | `synchronous = FULL` (a decision reported must survive a crash) |
| `approvals/rpc-*`, `core-integration`, `notify*`, `audit-c01` | T (flip) or no mode: surface | |
| `grants/*` | B | grants live in `approvals.sqlite` (`grants` table), `store.ts` 474 lines |
| `inbox/*`, `delivery/*`, `channel-handoff/*` | B | three small unversioned stores (`CREATE TABLE IF NOT EXISTS`) |

Stores: `approvals.sqlite` `user_version` 4 (`APPROVALS_SCHEMA_VERSION`; tables `approvals`, `approval_signatures`, `approval_chain`,
`chain_head`, `grants`), `inbox.sqlite` (`inbox_entries`, `inbox_cooldowns`), `delivery.sqlite` (`delivery_targets`),
`channel-handoff.sqlite` (`channel_taint`, `channel_handoffs`, `channel_direct`, `channel_continuations`).
Ports: clock, audit sink, identity lookup, notifier, channel delivery, signer.


## 5. K4: auth ladder, credential pool, OAuth clients (P4-23)

Sources: `auth/`: adc(82) clock(3) credentials(130) env(28) errors(36) http(98) index(14) ladder(48) log(3) login(209) pool(164) profile(130) redact(16) refresh(179) secret-store(81)<br>`openai-auth/`: federated(47) http(32) identity(64) index(11) loopback(58) plan(98) ports(72) profiles(56) provider(48) runtime(28) service(81) usage(13) wire(18) workload(34)

Tests: `auth/`: adc-http credentials flow-security http-boundary ladder login-callback-state login-flows pool profile redaction refresh refresh-schedule<br>`openai-auth/`: audit-b10 auth federated live loopback store-and-errors system turn wiring workload

| Tests | Mode | Note |
|---|---|---|
| `auth/ladder`, `pool`, `profile`, `credentials`, `redaction` | V | ladder decisions |
| `auth/refresh*`, `login*`, `http*`, `adc-http`, `flow-security`, `openai-auth/*` | W | token exchange and refresh against a fake server |
| `openai-auth/store-and-errors` | B | `openai-plan-usage.sqlite` |

Stores: `openai-plan-usage.sqlite` (`plan_usage`, unversioned). Credentials go through the secret store (`secrets::`), never a file of this package.
Ports: clock, secret lease, HTTP transport (the P4-W provider crate), loopback listener, browser opener.
Missing crate: an HTTP client, owned by P4-W (the milestone stops where it needs it, card §5 item 1).


## 6. K5: session store and maintenance (P4-40)

Sources (without `turn-loop.ts`, 333 lines): `session/`: catalog(18) chat-models(80) checkpoint-git-process(44) checkpoint-retention(151) compaction(289) context-fit(43) maintenance(64) memory-port(145) methods(219) migrations(220) provider(129) pruning(159) rewind-checkpoints(350) rewind-cycles(66) rewind-path(39) rewind-project(29) rewind(288) role-routing(81) service(144) store(962) summarizer(44) tokens(22) turn-loop(333) turn-telemetry(114) types(125)

Tests: `session/`: apple-fm-fallbacks apple-fm-models chat-models chat-pages compaction compaction-events compaction-m2 compaction-measured-hide context-fit context-messages core-session live-capabilities maintenance methods-cancel methods-owner model-switch rewind-command-failures rewind-core rewind-cycles rewind-files rewind-git-process rewind-methods rewind-missing-worktree rewind-path rewind-project rewind-retention-restart rewind-retention-timer rewind-service rewind-service-shutdown rewind-store role-routing store summarize-config-path tool-offers turn-loop turn-loop-result-redaction turn-loop-tools turn-telemetry

| Tests | Mode | Note |
|---|---|---|
| `store`, `rewind-store`, `chat-pages`, `tool-offers` | B | the helper already builds `sessions.sqlite` at every version (`createStoreAtVersion` with session `MIGRATIONS`) and `crates/plur1bus-store/tests/mode_b.rs` reads v1 to v9 |
| `compaction*`, `context-*`, `rewind-*` (pure parts), `role-routing`, `model-switch` | V | |
| `methods-*`, `core-session`, `live-capabilities` | T (flip) | |
| `turn-loop*` | no mode in this package | the dispatcher and turn loop are P4-43 |

Stores: `sessions.sqlite` `user_version` 9 (`SCHEMA_VERSION = MIGRATIONS.length`), tables incl. `sessions`, `messages` (+FTS), `turns`,
`summaries`, `session_checkpoints`, `prompt_snapshots`, `session_tool_offers`, `tool_visibility`, `token_calibration`.
Ports: clock, ids, engine memory port, git process (checkpoints), summariser.


## 7. K6: collaboration, coding surface, federation (P4-50 without team shell)

Sources: `collab/`: board(183) capacity(31) chat-promotion(108) coding-gate(119) coding-surface(86) defaults(7) delegations(121) errors(31) fanout-eval(40) guardrails(33) handoff(157) ids(32) index(20) limits(73) migrations(169) ports(93) runner(101) scope(52) service(769) store(473) target(36) team-eval(423) team/migration(84) team/plan(52) team/store(178) types(190) verifier(61)<br>`coding/`: actions(157) git-view(111) git(53) profile(100) root(51) sessions(533)<br>`external-turn/`: index(405)<br>`federation/`: loan-memory-policy(162) loan-model(139)

Tests: `collab/`: audit-b12 board chat-promotion coding-gate concurrency consult delegate e2e events fanout-eval guardrails handoff isolation limits memory-exposure migrations progress-deadline project-store rbac redaction-port replay repo-binding scope shutdown team-checker team-eval team-fixtures team-fixtures-go team-fixtures-python team-fixtures-python-csv team-fixtures-python-index team-fixtures-python-money team-fixtures-python-url team-fixtures-rust team-fixtures-typescript team-fixtures-typescript-calendar team-fixtures-typescript-coupled team-guards-go team-guards-python team-guards-rust team-guards-typescript team-live-isolation team-mutants team-plan team-process team-store team-surface tools trace turn-lifetime web-transport<br>`coding/`: actions folder-grants migration modes profile sessions<br>`external-turn/`: external-turn<br>`federation/`: loan-memory-policy loan-model

| Tests | Mode | Note |
|---|---|---|
| `collab/project-store`, `limits`, `guardrails`, `scope`, `board`, `handoff`, `delegate`, `consult`, `migrations`, `replay` | B + V | `collab.sqlite`, `migrations.ts` exports `MIGRATIONS` and `migrate`, so the helper fits |
| `collab/team-*` (fixtures, mutants, guards, eval) | no mode here | the team shell has no spec yet (card §6); `collab/team/*` is excluded |
| `coding/*`, `external-turn` | V + B (`coding-gate.sqlite`) | |
| `federation/*` | V | |

Stores: `collab.sqlite` (`SCHEMA_VERSION = MIGRATIONS.length`), `coding-gate.sqlite`, `chat-promotions.sqlite`.
Ports: clock, ids, git, process runner, session store (K5), budget (K1).


## 8. K7: jobs, dreams, learning pass, skill mining, knowledge file, caption pipeline (P4-51)

Sources: `system-jobs/`: index(248) ledger(299)<br>`user-jobs/`: index(386) rpc(66)<br>`dreams/`: candidates(37) cron(105) index(61) learn/aggregation(66) learn/calibration(51) learn/compose(73) learn/config(21) learn/eval(83) learn/installation(30) learn/lifecycle(18) learn/methods(26) learn/model(12) learn/predictions(42) learn/provider(30) learn/refutation(37) learn/runner(117) learn/selection(46) learn/service(217) learn/source(54) learn/store(255) learn/types(39) learn/verify(24) methods(87) producer(125) scheduler(676) store(306) types(143)<br>`skill-mining/`: artifact-policy(53) evidence(13) miner(116) review(84)<br>`knowledge/`: file(65) job(95) migration(116)<br>`media-search/`: admission(67) backfill(113) caption/cloud(68) caption/index(5) caption/keyframes(94) caption/local(113) caption/service(80) caption/types(32) disabled(28) engine-adapter(61) engine-host(33) errors(10) ffmpeg(252) hook(138) in-memory(195) index(8) paths(27) select(15) types(64) validate(138)

Tests: `system-jobs/`: audit-c05 history ledger registry rpc-jobs run<br>`user-jobs/`: approval core hardening memory rpc store visibility<br>`dreams/`: a1-gate candidates-table cron-table deep-fail-closed deep-promotion engine-acceptance engine-diary index large-corpus learn-calibration learn-eval learn-finding-lifecycle learn-installation learn-lifecycle learn-operations learn-predictions learn-provider learn-refutation learn-runner learn-selection learn-service learn-source learn-verify methods producer scheduler-guards scheduler-time store<br>`skill-mining/`: artifact-policy miner review<br>`knowledge/`: engine-acceptance file job migration<br>`media-search/`: acceptance.todo admission audit-c08 backfill caption-default-rule caption-local caption-privacy caption-service catalog channel-uploads composition disabled engine-119 engine-adapter engine-host errors ffmpeg hook in-memory matrix output-storage-policy privacy-ack select validate; top level `dreams-acceptance`, `dreams-candidates`, `dreams-cron`, `dreams-no-host-cron`, `dreams-rpc`, `dreams-scheduler`, `system-jobs`.

| Tests | Mode | Note |
|---|---|---|
| `dreams/*-table`, `cron-table`, `candidates-table`, `scheduler-time`, `scheduler-guards` | V | schedules and triggers |
| `dreams/store`, `learn-*` store parts, `user-jobs/store`, `system-jobs/ledger`, `skill-mining/*` | B | `dreams.db` and the learn store keep their migrations in private arrays or `if (version < n)` chains: exports needed |
| `media-search/*` | V (rules), W (cloud captions) | `ffmpeg` is a process |
| `*acceptance*`, `engine-*` | no mode | engine-side (forwards are out of scope, card §1) |

Stores: `user-jobs.sqlite`, `dreams.db` (`SCHEMA_VERSION = MIGRATIONS.length`), learn store (`user_version` 1 to 7 by `if` chain), `skill-mining.sqlite`, system-jobs ledger (file not located).
Ports: clock, cron/timer, job runner, engine forward (out of scope), provider call (P4-W), ffmpeg.


## 9. K8: ACP (P4-71, without external agents)

Sources: `acp/`: backend(197) core-permissions(152) failure(14) file-changes(123) framing(54) index(3) main(42) modes(13) permissions(103) protocol(19) server(277) text(62)

Tests: `acp/`: acp-backend.coverage acp-main.coverage acp-server.coverage audit-b02 backend-modes backend-permissions core-permissions file-changes framing main main-profile permissions real-core-coding server server-file-changes server-modes server-permissions

All mode W in spirit: transcripts over stdio (initialize, `session/new`, prompt, cancel, permission) recorded from the TypeScript server and replayed.
`*.coverage` files are coverage fillers for the TypeScript build: no mode. Stores: none (`ACP_PROTOCOL_VERSION = 1`).
Ports: clock, session store (K5), permission/approval port (K3), file-change source.


## 10. K9: prompt builder, tool-call runtime, decision service, triage (P4-42)

Sources: `prompt/`: builder(251) canonical(62) index(14) instructions(11) model-table(56) session(107) skills(44) telemetry(179) ttl(17) types(133)<br>`decision/`: client(120) pruning(16) role(75) skill-context(49) skills(48) system-one(155) tree-adapter(31) types(34)<br>`triage/`: classes(18) index(68) message-eval(19) runtime(45)<br>`toolcall/`: calibration(19) capabilities(77) categories(21) coding-bench-arms(103) coding-bench-box(121) coding-bench-check-files(97) coding-bench-checker(251) coding-bench-compile(102) coding-bench-corpus(284) coding-bench-host(44) coding-bench-live(355) coding-bench-process(139) coding-bench-provision-worker(93) coding-bench-provisioner(120) coding-bench-publication(38) coding-bench-report(525) coding-bench-runtime(179) coding-bench-secrets(84) coding-bench-smoke(81) coding-bench-stats(90) coding-bench-subject(324) coding-bench-verify(24) coding-bench-workspace(157) coding-bench(93) dialects(75) eval(77) extension-feed(34) first-party-metadata(108) host-eval-recordings(19) host-eval-store(31) host-eval(84) index(8) live-index(169) model-tool-error(151) quirks(52) results(68) skill-tools(209) sqlite-registry(109) stable-tools(42) tool-use(105) turn-eval-live(205) turn-eval(366) validation(145)

Tests: `prompt/`: b09-audit b5-metrics b6-determinism breakpoints cache-layout canonical clip-events model-table no-io prefix-stability rulings session skills telemetry<br>`decision/`: acceptance.todo client core production pruning pruning-three-way rpc skill-calibration skill-context skills system-one tree-adapter<br>`triage/`: classes message-runtime rules triage<br>`toolcall/`: arguments arguments-fuzz capabilities coding-bench-arms coding-bench-assigned-card coding-bench-checker coding-bench-cli coding-bench-corpus coding-bench-host coding-bench-native coding-bench-process coding-bench-provisioner coding-bench-report coding-bench-runtime coding-bench-secrets coding-bench-smoke coding-bench-stats coding-bench-subject coding-bench-verification coding-bench-workspace dialects edge eval eval-runner first-party-metadata host-eval live-index model-tool-error model-tool-error-cache model-tool-error-fs reliability results shipped-models skill-catalogue skill-tools sqlite stable-tools tool-use turn-eval turn-eval-live

| Tests | Mode | Note |
|---|---|---|
| `prompt/*` | V | zone and prefix hashes, byte-equal rendered prompts |
| `decision/*`, `triage/*` | V | offer sequences; D133 is K11 |
| `toolcall/{arguments*,dialects,validation,tool-use,model-tool-error*,results,stable-tools,quirks}` | V | the runtime |
| `toolcall/coding-bench-*`, `turn-eval*`, `host-eval*` | no mode | benchmark and evaluation tooling, not core behaviour; stays TypeScript |
| `toolcall/sqlite`, `live-index` | B | `capabilities.sqlite` |

Stores: `capabilities.sqlite` (`capability_vectors`, `capability_usage`, `capability_stats`, `capability_index`, `capability_hashes`; created in place).
Ports: clock, tokenizer, provider call (P4-W crate: the card says stop when a part needs it), skill catalogue, tree chooser (`decision/tree-adapter`).


## 11. K10: typestate gate, exec, fs, host tools (D120 §11.2, P4-30 without web, P4-31)

Sources: `tools/exec/`: args(60) env(46) index(6) node-process(64) run(236) tool(55) types(121)<br>`tools/fs/`: failure(53) index(3) ops(337) tools(141)<br>`host-tools/`: apps(245) catalog(47) classify(14) clipboard(79) context(94) denylist(132) errors(42) exec(161) index(10) notify(41) pkg(200) proc(279) remaining(67) sys(166) types(134)<br>`packages/hostctl/src/`: atomic(52) command(129) config(18) errors(17) files(140) index(127) native(27) pool(15) processes(102) search(28)

Tests: `tools/exec/`: exec real replay<br>`tools/fs/`: fs<br>`host-tools/`: apps audit-b07 catalog clipboard-notify conformance denylist errors exec-descendants pkg proc remaining smoke sys<br>`packages/hostctl/test/`: atomic-publish-races atomic.coverage config errors.coverage files.coverage hardening-gap-apps hardening-gap-processes hardening-hostctl hostctl index.coverage listing-concurrency native.coverage native policy pool.coverage processes.coverage search-batch search-cost search.coverage trash-smoke

| Tests | Mode | Note |
|---|---|---|
| `exec/exec`, `real`, `replay`; `fs/fs` | V (argv and environment filters, classes, deny lists) + a `compile_fail` doctest | no executor without `ApprovedAction` |
| `host-tools/*` | V for classes and deny lists, no mode for tests that start real apps or processes (`smoke`, `proc`, `apps`) | reason: depends on the host machine |
| `hostctl/*` | V (policy, config, search batching), no mode for races and trash on a real file system | covered by Rust-side tests |

Stores: none. Ports: process spawner, file system, clock, audit sink, host notifier and clipboard (platform).


## 12. K11: decision receipts (P4-45, D0 to D4 as a library)

Source is the owner decision D133 and its rulings 1 to 11 (project doc, in the repo `docs/decision-service.md` only for the older decision service);
there is no TypeScript implementation to port. Proof: the marker test "no content in a receipt", same receipts give the same report. New store,
new schema version 1; the helper needs no change (the store is created by Rust, TypeScript never reads it).


## 13. The store round-trip helper: how a new store is attached, and what is missing

`tests/core-parity/store-roundtrip.ts` (`StoreCopy`, `createStoreAtVersion`) is generic: it copies a file with its WAL, writes in
`BEGIN IMMEDIATE`, reads, checks `user_version`, integrity and foreign keys. `store-b-driver.ts` is not: it is the session store
(`prepare` builds `session-v<n>.sqlite` at every version and the node:sqlite foreign-key probe, `verify` reads what Rust left), and
`crates/plur1bus-store/tests/mode_b.rs` names that one script. To attach a store:

1. A TypeScript driver `tests/core-parity/<store>-b-driver.ts` with `prepare <dir>` (a file at every version) and `verify <dir>`.
2. A Rust test that runs it (the `driver` function of `mode_b.rs`, which does not take the script name; K1 carries its own copy).
3. The store must let `createStoreAtVersion` use its own `migrate`: it needs `migrations: readonly string[]` and a `migrate(db, migrations)`
   that returns the version reached. Only the session store and the collab store export both. The budget store keeps `MIGRATIONS` private
   and its `migrate(db)` takes no step list; approvals and dreams are the same. **Missing for them: a behaviour-neutral export** (a
   `packages/*/src` change, commit trailer `Phase4: vectors <WP>`).

What the helper cannot do today:

- **Tables created by constructors, outside `user_version`** (budget: `budget_call*`, `a2a_peer_*`; inbox, delivery, handoff, user-jobs: every
  table). A file "at version N" is then not enough; the driver has to construct the real service on it once. K1 does this with
  `createCallBudget` and `PeerCallBudget` in `prepare`.
- **Two writers.** The helper is single-process; `BEGIN IMMEDIATE` interleaving is tested only inside Rust.
- **Compare the schema text.** The session driver compares `sqlite_master` of a Rust-migrated file with the TypeScript one; any new driver
  should do the same for stores the Rust core will own.
- **Rust-side migration entry** exists (`Store::open_owner` with `Schema::Steps`); the TypeScript text must be copied byte for byte into Rust.
