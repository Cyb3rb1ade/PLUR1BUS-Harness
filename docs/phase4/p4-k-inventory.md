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
| K1 budgets, licences | 1,292 + 25 (15) | 16 (in `budget/`, 3 of them helpers) + `budget-rpc` + 2 | `budget.sqlite` v2 (+ lazy tables), `model-licences.sqlite` (unversioned) | `chrono-tz`, `chrono` (both already locked by the engine; added in K1) |
| K2 policy, egress, audit, attestation | 2,862 (23) | 38 | audit chain files (JSONL, not SQLite) | `url` (the host parser, with IDNA) and `icu_normalizer` (NFC), both already locked; added in K2. Windows file ids: `winapi-util` (locked, not added; until then fail closed) |
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

Time-zone database: budget periods are the local day, week or month in an IANA zone, so `period_bounds` needs one. It sits behind
the `Zones` port; the production adapter is `budget::zones::TzdbZones` over `chrono-tz` (`chrono-tz.workspace = true` and `chrono`
in `crates/plur1bus-core/Cargo.toml`; both were already locked through `plur1bus-engine`, so the lock file gains two lines and no
package). Added by the controller (Ruling R-K-5 in the ledger).


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
  real caller passes a value, and the preview is then text). `Store::open_owner` sets a 5 s busy timeout of its own, so a
  shorter one given to the service is applied after it. No P4D was claimed: every difference above is either not observable through the
  ports or is in a vector with a note; the controller decides whether any needs a number.
- *Time zones:* every period vector (1,719 rows, nine named zones and one offset zone, with Apia's skipped day, Sao Paulo's skipped
  midnight and Lord Howe's half-hour DST) and every validation vector replays against `TzdbZones`; the tests of the service run on it too,
  and there is no test double left. The adapter follows ICU where a database keyed by exact name would not: names match without regard
  to ASCII case, and an offset identifier (`+01`, `+0100`, `+01:00`, the sign may be U+2212) is a zone. Checked once by hand, not by a
  test (it would pin the ICU release of whoever runs it): all 597 names of `chrono-tz` 0.10.4 are accepted by Node 24.21 (ICU 78.3), and
  all 418 names of `Intl.supportedValuesOf("timeZone")` are known to `chrono-tz`. What can still differ: `chrono-tz` 0.10.4 carries tzdb
  2025b and Node 24.21 carries 2026c, so a rule changed between those releases is answered the old way by Rust until the crate moves;
  a link name only ICU knows is refused by Rust; and an instant beyond chrono's range (about the year 262,000, short of the `Date`
  range of about 275,000) has no local date in a named zone and is refused as an invalid time zone.
- *Ports for the flip:* `Clock`, `IdSource` (`UuidIds`), `Zones`, the event sink (`EventSink`, `BudgetEmitter`), the audit sink
  (`rbac::audit::AuditSink`), `SubagentResultPort`, and the licence catalogue `NcCatalogue` (the four model ids and revisions are given by the
  caller on purpose; the TypeScript ids are in `packages/core/src/licences/memory.ts`).

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


**K2 as built** (`crates/plur1bus-core/src/{egress,policy,audit,attestation}/`,
one `pub mod` line each in `lib.rs`; no RPC method, nothing wired into the front door, `native*.rs`, the relay, the dispatcher or the supervisor).

- *Ported, egress:* the compiled policy and `hostAllowed` (`policy.rs`), the gate (`gate.rs`), the guarded resolution and the address
  classification it stands on (`guard.rs`, `ip.rs`: `tools/web/{guard,ip}.ts`), the dry run `decide` and `status` with their counters
  (`service.rs`), the model-download exception (`model_downloads.rs`). URLs are read with the configuration code's reader
  (`config::endpoint::Url`) plus the IDNA step of the host parser (`egress::parse_url`).
- *Ported, policy:* `decide` over JSON values (`decide.rs`: a malformed call, context or grant takes the TypeScript branch; the members
  the evaluator does not validate are compared with JavaScript's `===`, `>`, `+` and `Math.min`, `js_value.rs`), the capability table and
  defaults (`capabilities.rs`), the effects (`effects.rs`), `headlessGate` (`headless.rs`), the policy audit writer (`audit.rs`) and the pure
  path rules with the platform as an argument (`paths.rs`: `checkSyntax`, the reserved names, `foldForDeny`, `matchDeny`,
  `invalidDenyEntry`, `containsExact`, `isForbiddenRoot`, `isSystemTreePath`, `grantReachesSystemTree`).
- *Ported, the file-system half of the path layer* (`policy/fs_paths.rs`): `canonicalisePath` (`canonicalise_path`) and `openVerified`
  (`open_verified`), in the TypeScript order: the deny-list check before anything is resolved, the deny entries resolved like targets,
  the syntax, the roots (real path, stamped identity, home and its real path, system trees), the walk up to the deepest existing
  ancestor with dangling links, loops and non-directories refused, the deny list again on the real target, the two hard-link scans with
  their caps (incomplete = refused), the special trees, the UNC and name re-check on the real path, exact containment with the most
  specific root, the hard-linked write, and `systemTree`. The open: `O_NOFOLLOW`, `O_EXCL` for a create, `O_CREAT` dropped for an
  existing leaf, the parent checked before and after, then on the open descriptor identity (device, inode, birth time), link count,
  the Linux `/proc/self/fd` path and the Windows branches (the planted-leaf check before a create, the real-path check after it).
  Node's `path.posix`/`path.win32` `dirname` and `basename` are ported with it.
- *Ported, audit:* the append half (`audit/mod.rs`): `ChainSink`, the core's `AuditSink` over the existing `plur1bus-audit` chain (no second
  chain writer; the event must be recordable and the detail is redacted, as `createAuditChain` does), and `recorded_then`, which runs an
  effect only after its audit line was written.
- *Ported, attestation:* the service (`service.rs`: nonce per attempt, replay and mismatch, the skew window, never ask unrecorded, probe), the
  pin rules (`helper.rs`: `helperPinned`, `helperFromEnv`) and `run_helper` (verify, run, verify again).
- *Proof:* mode V from three exporters (`export-egress.ts`, `export-policy.ts`, `export-attestation.ts`; the address classification from the
  shared `packages/core/test/fixtures/net/ip-classification-vectors.json`), each with `--check` and a stale guard in `parity.test.ts`. The
  policy vectors hold the `permission-eval` attack/benign table and a seeded grid of 2,200 calls; the path vectors hold darwin, linux, win32
  and forced Windows rules, so every operating system replays every platform (no CI leg per OS is needed for them). The chain:
  `crates/plur1bus-core/tests/audit_chain_cross.rs` (the Rust sink writes, the TypeScript verifier accepts, the TypeScript chain appends to the
  same file, Rust appends after it, one verified chain). Ported tests: `{egress,policy,attestation}/tests.rs`, `audit/mod.rs`.
- *Proof, the file-system half:* differential mode V from `export-policy-fs.ts` (`fixtures/parity/policy-fs/darwin.json`, 113 KiB): 61
  cases, each a file tree (files, symbolic and hard links, FIFOs) built in a fresh temporary directory and a list of steps
  (canonicalise, open, change the tree between check and use, read back, list), with `$ROOT` and `$TMP` for the per-run directory.
  `fs_vectors.rs` builds the same trees and must give the same answers. Tests that the vectors cannot hold are in `fs_tests.rs` (26 in
  all with the replay), among them the races inside one call through a scripted double of the `PathFs` port (a parent swapped between
  the pre-check and the open, a link planted between the `lstat` and the open, a descriptor whose identity or type changes, a directory
  the scan cannot read, the Linux and Windows branches on macOS).
- *Proven where:* **macOS** (arm64, APFS, case-insensitive): all 61 cases and all tests, run here. **Linux:** only the CI legs of #933
  (`cargo test --workspace` on ubuntu-24.04, macos-15 and windows-2025, and the `plur1bus-core` job on windows-2025): the replay plays the 55 portable cases and
  asserts that exactly the six macOS-only ones are left out (case and Unicode-normalisation insensitivity, the 1,024-byte path limit,
  permission bits, `/etc` → `/private/etc`, `/var` → `/private/var`); `a_link_into_proc_is_judged_on_its_real_target` runs only there.
  The cross-check for `x86_64-unknown-linux-gnu` and `x86_64-pc-windows-msvc` could not run on this Mac (the C builds of
  `libsqlite3-sys` and `ring` need a cross toolchain), so the `cfg` code is proven only by the CI. **Windows:** `RealFs` answers inode 0
  (see below), so every path is refused (`no-identity`) and the replay plays no case (counted and asserted). The Windows branches of
  `openVerified` run on macOS through the double. The TypeScript guard in `parity.test.ts` and `export-policy-fs.ts --check` compare only
  on macOS and say so elsewhere (a skip with its reason; the exporter prints `skip` and exits 0 on `--check`, 1 without it).
- *CI legs that do not exist:* a recording of the file-system vectors on Linux (`linux.json`, the answers of ext4 and `/proc` from the
  TypeScript side) and any run of the real Windows file system (junctions, `\\?\` forms, case-insensitive NTFS) against TypeScript.
- *Test files and their mode:* `policy/decide`, `decide-hardening`, `decide-shell-path-grant`, `permission-eval`, `a2a`, `capabilities-table`,
  `effects-hardening`, `headless`, `system-tree`, `audit` V (and Rust tests); `policy/paths`, `paths-hardening` V (the syntax and fold
  rules in `policy/paths.json`, the file-system cases in `policy-fs/darwin.json`) and Rust tests (`fs_tests.rs`); the Windows-only block
  of `paths.test.ts` (junctions, `\\?\` spellings of a real root, 8.3 aliases from `cmd.exe`) is not ported: without file ids every
  path is refused there before those rules matter, and the syntax half of it is in the pure vectors; `permission-eval-e2e` none here (it
  drives the stores of K3). `egress/policy`, `gate`, `a2a`,
  `model-downloads`, `service` (dry run, status) V; `service` (request) and `post-paths` not ported (the guarded HTTP client is P4-30);
  `rpc` T (flip). `audit/chain*`, `durability`, `shared-recovery`, `shared-vectors` are `plur1bus-audit` (P4-03) plus the cross test;
  `health*`, `notices*`, `startup`, `rpc` T (flip). `attestation/service`, `service-hardening` V and Rust tests; `pin`, `resolve` Rust
  tests over doubles (the hash and signature checks are the production host's).
- *Deliberately not ported:* `egress.request` (P4-30), the chain's `verify`/`rotate` on the core object, `health.ts`, `notices.ts`, `rpc.ts`
  (surface of the flip), the process, hash and signature work of `attestation/helper.ts` (the flip's `HelperHost`).
- *Deliberately different from TypeScript, the file-system half* (the TypeScript code is frozen, D129; numbers in K12, R-K-6):
  **K2-D5** (security): the TypeScript open passes `O_TRUNC` to `open(2)`, before its identity check, so a leaf swapped for a hard link
  to another file (or opened through a parent swapped for a link between the pre-check and the open) empties that file before the
  refusal; the vector `swap-write-for-hard-link` records it. Rust opens without `O_TRUNC` and truncates the descriptor only after every
  check. **K2-D6** (availability): the TypeScript open of a FIFO blocks until a writer appears; Rust adds `O_NONBLOCK` (unix) and refuses
  a descriptor that is neither a regular file nor a directory (`unsupported-open`). **K2-D7** (detection): a create through a parent
  swapped for a link and back between the pre-check and the open leaves a file outside the root that TypeScript on macOS does not notice;
  Rust checks that the created file is the leaf at the checked path (refused, but the stray empty file stays: preventing it needs
  `openat` on the parent's descriptor). Not ported: the abort signal (synchronous calls; cancellation is the flip's). A real path that is
  not UTF-8 is refused (`EILSEQ` → `unresolvable`) where Node would decode it lossily.
- *Windows file ids:* `std` exposes neither the volume serial number nor the file index on stable Rust, so `RealFs` reports inode 0 and
  every path is `no-identity` (the TypeScript answer for a file system without stable ids, fail closed). A production Windows adapter
  needs `winapi-util = "0.1"` under `[target.'cfg(windows)'.dependencies]` (0.1.11 is already in the lock file through `same-file`;
  `winapi_util::file::information` gives the serial number, the index and the link count without `unsafe`).
- *IDNA and NFC:* both are ports with a production adapter, added by the controller (`url = "2"` and `icu_normalizer = "2.3"` in
  `crates/plur1bus-core/Cargo.toml`; two lines in the lock file, no package). `egress::HostIdna` is `url::Host::parse`, because Node's
  `domainToASCII` is the host parser of the URL Standard and not UTS 46 alone: a name that ends in a number is read as IPv4 or refused
  (`0x7f.0x1`, `foo.0x`), which a port that only lower-cases ASCII gets wrong and so accepts entries TypeScript refuses. `policy::paths::IcuNfc`
  is `icu_normalizer`. Every vector replays against the adapters with no fail-closed allowance; the doubles that decline (`AsciiIdna`,
  `LatinNfc`) are test-only and keep the fail-closed branches proven.
- *Known differences:* **K2-D4** (fails closed): Node accepts an `xn--` label that is not valid IDNA (`xn--zz.example`, `xn--a.example`), as
  an `allowHosts` entry and as a URL host; the Rust host parser refuses it, so the entry is a configuration error (deny-all) and the URL is
  `invalid-url`. The two vectors carry `divergence`. **K2-D2**: the policy audit cuts a string before a surrogate pair where TypeScript
  keeps a lone high surrogate. **Unicode data**: `icu_normalizer` 2.3 and the ICU of Node 24.21 may differ for code points one of them
  does not know yet. The IP rules are a copy of `apps/desktop/net` (outside the workspace), held to the same shared vector file.
- *The gate's URL reader:* `egress::parse_url` is `config::endpoint::Url` (the small reader of P4-11) plus `HostIdna`. A test holds it
  against the `url` crate on every gate vector (759 URLs, no difference). At the flip the HTTP client must dial the host, port and pin
  the gate judged and must not parse the raw URL again with a parser of its own.
- *Ports for the flip:* egress `ConfigSource`, `Resolver`, `Idna`; policy `Clock`, `GrantSource` (K3's store), `Nfc`, `PathFs` (the file
  system under `canonicalise_path` and `open_verified`; `RealFs` is the production implementation, the handle is a `std::fs::File`);
  policy audit
  `AuditSink`, `TextRedactor`, a clock and the host name; attestation `HelperHost`, `FileProbe`, `AttestAudit`, clock and nonce source; audit
  `ChainSink` (directory and writer names).

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

**K3a as built** (approvals and grants; `crates/plur1bus-core/src/{approvals,grants}/`, one `pub mod` line each in `lib.rs`; no RPC
method, nothing wired into the front door, `native*.rs`, the relay, the dispatcher or the supervisor). Inbox, delivery and the channel
hand-off are K3b.

- *Ported, the store:* `db.rs` (`openApprovalsDb`: directory 0700 and file 0600 before SQLite, WAL, `synchronous = FULL`, the four
  migration texts byte for byte, one `BEGIN IMMEDIATE` migration that re-reads the version under the lock, a newer schema refused and
  the file left alone), `chain.rs` (the HMAC-SHA256 chain with its keyed head; verification in TypeScript's order: sequence, linkage,
  MAC, head, the semantic rules over MAC-valid entries, the signatures; the verified view cached per connection until an append, a new
  signer or another connection's commit; `append` only inside a write transaction and never on a broken chain), `store.rs` (request,
  decide, cancel, consume, get, list, all decided from the chain; the `approvals` table is a projection), `signing.rs` and `keys.rs`
  (Ed25519 over `ring`; the signed message, the public key and the signature are read with Node's lenient hex and base64 decoders,
  `node_codec.rs`; PKCS #8 v1 and v2; the chain key and the signing identity from a secret-store port, created once, a corrupt value
  never replaced), `integrity.rs` (the `approvals.integrity` handler: spec, next run with jitter, arguments, one run), `js_json.rs`
  (JSON with JavaScript's member order and number printing, for the bytes the MACs cover and the strings the store compares).
- *Ported, grants:* `grants/store.rs` (`create` with every rule in TypeScript's order, the chain-vouched views with the row read as
  `node:sqlite` hands it over, revoke and end, `markUsed`, `consumeOnce`, the owner job grant and its renewal from proved turns,
  `announceDue`), `grants/open.rs` (`PermissionStores`: the one connection, every write through `Store::write_with`, both stores on one
  chain, and the real `policy::decide::GrantSource`).
- *Ported, the service:* `approvals/service.rs` (`request`, park, expiry, abort, `decide`, `decideForSession`, `begin`, `list`, `get`,
  `cancel`, `verify`, `policyContext`, `dispose`), with the waiting call as a callback the host turns into a future.
- *Proof:* mode V from `export-approvals.ts` (five files under `fixtures/parity/approvals/`, about 240 KiB, the largest 128 KiB; `--check`, a stale guard in
  `parity.test.ts`, POSIX only because the grant paths are POSIX spellings): the replay writes TypeScript's rows byte for byte (MACs,
  head tag, Ed25519 signatures, grant definitions and their hashes, every audit line of the grant store), judges 45 tamper cases and the
  other-key case as TypeScript does (with and without a pinned signer, the grant states and the approval list after each), the semantic
  rules over twenty sequences a key holder could append, the grant creation rules (73 inputs), signature verification over altered
  bytes and Node's lenient decoders, and the key reads. Mode B: `tests/core-parity/approvals-b-driver.ts` +
  `crates/plur1bus-core/tests/approvals_mode_b.rs` (TypeScript writes the store at versions 1 to 4, the last signed; Rust migrates,
  verifies, decides and signs what TypeScript left pending, consumes its once grant, writes its own; TypeScript verifies chain and every
  signature with its own verifier, decides and uses what Rust left pending, verifies again; the schema text of every Rust-migrated or
  Rust-created file is TypeScript's). The `policy::decide` integration over the real store: `grants/tests.rs`
  (`decide-integration`, the store half of `system-tree-grants` and `lifetime-core`). Ported tests: `approvals/tests.rs`,
  `approvals/tests_service.rs`, `grants/tests.rs`.
- *Test files and their mode:* `approvals/chain`, `db`, `store`, `store-cancel`, `signing`, `keys`, `integrity-job` V + B and Rust tests;
  `service`, `scope-offers` Rust tests over the real stores; `grants/store`, `once`, `integrity`, `audit-hook`, `attested`,
  `engine-owner-grants`, `decide-integration`, `system-tree-grants` (store half), `lifetime-core` (store half) Rust tests, the rules in V;
  `audit-findings`: the store half (no revival by `markUsed`, an expiry in the past, canonical paths, field lengths, `endTask` scope,
  state across a restart) in Rust tests and the rules, the matching half is `policy::decide` (K2 vectors); `approvals/rpc-*`, `core-integration`, `notify*`, `audit-c01`,
  `runtime`, the RPC half of `system-tree-grants`, the composition half of `lifetime-core`: T at the flip.
- *Deliberately not ported:* `rpc.ts`, `rpc-common.ts` and `grants/rpc.ts` (the RPC surface), `wire.ts` (the projection to the RPC
  records), `notify.ts` (the delivery rule over the RPC server's subscriptions; the service emits through its `ApprovalEvents` port),
  `runtime.ts` (lazy open on first use behind the handlers), `armApprovalsIntegrity` (the system-jobs registry is K7's), and
  `requestCodeRoot`/`code-root.ts` (the trusted request builder needs the coding sessions; a stored code-root request is refused, as
  TypeScript refuses one after a restart).
- *Known differences* (numbers in K12, R-K-6): grant ids are 24 random hex digits after `grt_` (TypeScript hashes time, `Math.random()`
  and the pid into the same shape); a payload `serde_json` cannot read (a lone surrogate escape, a number beyond the double range) is
  `malformed` here where `JSON.parse` reads it (only a key holder can write one, and then the chain is broken in Rust only: fail
  closed); a chain row whose text column holds a number or a blob is unreadable (an error) where TypeScript computes with it; a store
  read that fails inside `GrantSource` yields no grant (decide asks) where TypeScript throws; **K3-D1** (TypeScript `chain.ts` `eq` throws
  `RangeError` on a MAC of the right length in UTF-16 units but not in bytes; Rust reports the mismatch). **K3-D2** (security,
  integrity and availability): TypeScript's chain caches a verified view that was built inside a write transaction; when that
  transaction rolls back (a refused `begin` after the approval was consumed: a once grant that cannot be consumed or a grant of
  someone else; an audit line that fails after `markUsed` re-read the grant), the cache keeps the rolled-back entries. The store then
  reports the approval as used, `verify()` reports a chain the file does not hold, and the next append writes a sequence gap that
  breaks the chain for good (every later decision and grant fails closed). Rust caches only views of committed state; the vector
  `chain.json` `phantomAfterRollback` (`divergence: K3-D2`) records the TypeScript behaviour, the replay expects Rust's. `detail.flags` of a request
  keeps the members in the order the Rust evaluator returns them (sorted), not TypeScript's insertion order; nothing reads the order.
- *Ports for the flip:* `Clock`, `Random`, `keys::SecretSlot` (the secret store; lease and create as `core`), `keys::ChainKeySource`,
  `keys::SigningKeySource`, `signing::DecisionSigner`, `AuditPort` (`policy::audit::PolicyAudit` implements it), the service's `Timers`,
  `ApprovalEvents` and `ServicePorts` (`canonical` = `plur1bus_canon::canonical_json`, the redactor, the A2A trust display), and
  `grants::store::LifecycleNotify`. `db::OpenOptions::secure_path` is the platform's owner-only hook.


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
