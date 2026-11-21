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
| K4 auth, openai-auth | 1,881 (29) | 22 | `openai-plan-usage.sqlite` (unversioned); credentials only through the secret store | none (HTTP is a port, R-K-14; built in K4) |
| K5 sessions | 4,158 (25) | 38 | `sessions.sqlite` v9 | none |
| K6 collab, coding, federation | 5,433 (36) | 60 | `collab.sqlite` (`migrations.ts`), `coding-gate.sqlite`, `chat-promotions.sqlite` | none found |
| K7 jobs and friends | 5,863 (58) | 72 | `user-jobs.sqlite`, `dreams.db` v7+, learn store v7, `skill-mining.sqlite`, system-job ledger (`state/system-jobs/ledger.jsonl`, JSONL) | cron parser unverified (`dreams/cron.ts` is TypeScript of its own) |
| K8 ACP | 1,059 (12) | 17 | none | none |
| K9 prompt, tool-call runtime, decision, triage | 7,030 (65) | 70 | `capabilities.sqlite` (tool-call index) | none found |
| K10 gate, exec, fs, host tools | 2,833 (26) + hostctl 655 (10) | 17 + hostctl 20 | none | K10a: `plur1bus-core`, `plur1bus-canon`, `plur1bus-log-schema` (first party), `base64`, `regex`, `rustix` (unix) for `plur1bus-tools`; `rustix` (unix) and `winapi-util` (Windows) for `plur1bus-core`. All locked already; added in K10a |
| K11 decision receipts | new (D133) | new | `decision-receipts.sqlite` v1 (new) | none |



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
  (`service.rs`), the model-download exception (`model_downloads.rs`). URLs are read with the `url` crate (`egress::parse_url`,
  R-K-17), mapped onto the members the gate reads (`egress::Url`).
- *Ported, policy:* `decide` over JSON values (`decide.rs`: a malformed call, context or grant takes the TypeScript branch; the members
  the evaluator does not validate are compared with JavaScript's `===`, `>`, `+`, `Number`, `String`, `Boolean` and `Math.min`,
  `js_value.rs`: an array converts through `join(",")` to any depth, and a conversion that throws in JavaScript returns an error; the
  helpers read five flags by truthiness and `batch` only when it is `true`), the capability table and
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
  `winapi_util::file::information` gives the serial number, the index and the link count without `unsafe`). *Since K10a the
  adapter exists (R-K-12, §11); `open_verified` goes through the checked parent's descriptor (R-K-11), which prevents K2-D7.*
- *IDNA and NFC:* both are ports with a production adapter, added by the controller (`url = "2"` and `icu_normalizer = "2.3"` in
  `crates/plur1bus-core/Cargo.toml`; two lines in the lock file, no package). `egress::HostIdna` is `url::Host::parse`, because Node's
  `domainToASCII` is the host parser of the URL Standard and not UTS 46 alone: a name that ends in a number is read as IPv4 or refused
  (`0x7f.0x1`, `foo.0x`), which a port that only lower-cases ASCII gets wrong and so accepts entries TypeScript refuses. `policy::paths::IcuNfc`
  is `icu_normalizer`. Every vector replays against the adapters with no fail-closed allowance; the doubles that decline (`AsciiIdna`,
  `LatinNfc`) are test-only and keep the fail-closed branches proven.
- *Known differences:* **K2-D4** (fails closed): Node accepts an `xn--` label that is not valid IDNA (`xn--zz.example`, `xn--a.example`), as
  an `allowHosts` entry and as a URL host; the Rust host parser refuses it, so the entry is a configuration error (deny-all) and the URL is
  `invalid-url`. The vectors carry `divergence` (the policy and gate cases, and the `xn--` rows of `egress/urls.json`). **K2-D8**
  (availability): `validGrant` does not look at `lastJobTurnAt`, and a value there that has no primitive form (an object with an own
  `toString` member) makes the TypeScript `decide` throw; Rust skips that grant as it skips an invalid one and decides without it (the
  rows of `policy/values.json` carry `divergence`). **K2-D2**: the policy audit cuts a string before a surrogate pair where TypeScript
  keeps a lone high surrogate. **Unicode data**: `icu_normalizer` 2.3 and the ICU of Node 24.21 may differ for code points one of them
  does not know yet. The IP rules are a copy of `apps/desktop/net` (outside the workspace), held to the same shared vector file.
- *The gate's URL reader (R-K-17, replaces R-K-9):* `egress::parse_url` is `url::Url::parse`, mapped field by field onto `egress::Url`
  (`scheme`, the percent-encoded `username` and `password`, `hostname` with the brackets of an IPv6 address, `port` without the default
  port of the scheme). The small reader of the configuration code (`config::endpoint::Url`) stays where it was, for the configuration's
  endpoint policy; the model-download exception reads host and path from the same single parse. `egress/urls.json` holds Node's reading
  of a hostile corpus (named classes from review A and 3,600 generated URLs with a fixed seed), and the replay requires every member to
  match; the only rows where Rust refuses what Node reads are the `xn--` ones (K2-D4). One correction on top of the crate: it ends a
  port at `\` for every scheme, where the URL Standard does so only for a special scheme, so a URL of another scheme with a `\` in its
  host or after its port is refused (TypeScript: `invalid-url`, not `scheme`). At the flip the HTTP client must dial the host, port and
  pin the gate judged and must not parse the raw URL again with a parser of its own.
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
hand-off are K3b (below).

- *Ported, the store:* `db.rs` (`openApprovalsDb`: directory 0700 and file 0600 before SQLite, WAL, `synchronous = FULL`, the four
  migration texts byte for byte, one `BEGIN IMMEDIATE` migration that re-reads the version under the lock, a newer schema refused and
  the file left alone), `chain.rs` (the HMAC-SHA256 chain with its keyed head; verification in TypeScript's order: sequence, linkage,
  MAC, head, the semantic rules over MAC-valid entries, the signatures; the verified view cached per connection until an append, a new
  signer or another connection's commit; `append` only inside a write transaction and never on a broken chain), `store.rs` (request,
  decide, cancel, consume, get, list, all decided from the chain; the `approvals` table is a projection), `signing.rs` and `keys.rs`
  (Ed25519 over `ring`, through `crate::ed25519`, which first refuses the fourteen encodings of the eight points of small order as
  the key or as R, as Node's OpenSSL does; the signed message, the public key and the signature are read with Node's lenient hex and
  base64 decoders, `node_codec.rs`; PKCS #8 v1 and v2; the chain key and the signing identity from a secret-store port, created once, a corrupt value
  never replaced), `integrity.rs` (the `approvals.integrity` handler: spec, next run with jitter, arguments, one run), `js_json.rs`
  (JSON with JavaScript's member order and number printing, for the bytes the MACs cover and the strings the store compares).
- *Ported, grants:* `grants/store.rs` (`create` with every rule in TypeScript's order, the chain-vouched views with the row read as
  `node:sqlite` hands it over, revoke and end, `markUsed`, `consumeOnce`, the owner job grant and its renewal from proved turns,
  `announceDue`), `grants/open.rs` (`PermissionStores`: the one connection, every write through `Store::write_with`, both stores on one
  chain, and the real `policy::decide::GrantSource`).
- *Ported, the service:* `approvals/service.rs` (`request`, park, expiry, abort, `decide`, `decideForSession`, `begin`, `list`, `get`,
  `cancel`, `verify`, `policyContext`, `dispose`), with the waiting call as a callback the host turns into a future.
- *Proof:* mode V from `export-approvals.ts` (nine files under `fixtures/parity/approvals/`, about 2.7 MiB, the largest 939 KiB; `--check`, a stale guard in
  `parity.test.ts`, POSIX only because the grant paths are POSIX spellings): the replay writes TypeScript's rows byte for byte (MACs,
  head tag, Ed25519 signatures, grant definitions and their hashes, every audit line of the grant store), judges 45 tamper cases and the
  other-key case as TypeScript does (with and without a pinned signer, the grant states and the approval list after each), the semantic
  rules over twenty sequences a key holder could append, the grant creation rules (162 inputs, with every line terminator and
  Unicode space around capability, `attestedVia` and path segments), signature verification over altered bytes and Node's lenient
  decoders, Node's verdict over 200 Ed25519 edge cases (`ed25519.json`: keys and R of small and mixed order, non-canonical encodings,
  S out of range; `scripts/parity/ed25519-cases.ts`), and the key reads. Service level (review B, `approvals-service-cases.ts`,
  replayed by `approvals/vectors_service.rs`): `regex.json` drives the real service over 100 path targets and 22 job names through
  every character class in which a JavaScript expression could part from its port, 20 stored details of another shape than
  `detailOf` writes, the held-grant check and `dispose`; `cells.json` and `cells-grants.json` give one column of one row of each of
  the five tables a value of a foreign storage class (120 cases) and then call every public operation, compared by answer, audit
  lines, events, waiter answers and the rows left in the file. The exporter fixes the process's randomness while it records these. Mode B: `tests/core-parity/approvals-b-driver.ts` +
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
  closed); a store read that fails inside `GrantSource` yields no grant (decide asks) where TypeScript throws. A cell of another
  storage class than its column's (a blob in a text column, a text or a fraction in an integer column) is read as `node:sqlite` hands
  it over and used as TypeScript uses it (vectors `cells*.json`); only a number in a text column of the chain, which SQLite never
  stores there, is refused. **K3-D1** (TypeScript `chain.ts` `eq` throws `RangeError` on a MAC of the right length in UTF-16 units but
  not in bytes): the port now throws there too (an error, no integrity failure), so both fail closed alike. **K3-D5** (divergence,
  fail closed): a SubjectPublicKeyInfo spelled with a long-form or indefinite length (BER), which OpenSSL reads and Node never writes,
  is no key here. **K3-D6** (divergence, fail closed): a PKCS #8 file whose embedded public key is not its seed's, or version 1 without
  a public key, or a long-form outer length, loads in Node and is `corrupt` here. **K3-D2** (security,
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


**K3b as built** (inbox, delivery and the channel hand-off; `crates/plur1bus-core/src/{inbox,delivery,handoff}/`, one `pub mod` line each in
`lib.rs`, plus a private `private_store.rs` that prepares the file the way the TypeScript stores do; no RPC method, nothing wired into
the front door, `native*.rs`, the relay or the supervisor). The three stores are unversioned (`CREATE TABLE IF NOT EXISTS`, no
`user_version`), opened with `Store::open_owner` and `Schema::Unversioned`; every write goes through `Store::write_with`
(`BEGIN IMMEDIATE`). `inbox.sqlite` runs `STRICT` tables on a rollback journal, as TypeScript creates them; delivery and hand-off use
WAL and `synchronous = FULL`.

- *Ported, the hand-off (a security rule, line by line, fail closed):* `handoff/service.rs` (`observe`: a group or broadcast message
  taints a session for good and removes its direct record, a direct message from the linked owner makes only a session with no
  history visible; `#origin`: taint, direct record, parseable value, session kind `channel`, the owner principal, the person resolved
  with an active link, `agent.read` or `agent.use`; `issue`: five outstanding links per person, a 43-character token, only its SHA-256 stored,
  ten minutes, the audit line before the row; `issueMessage`; `redeem`: shape of the token, `expires <= now` is expired, the audit line
  before the claim, the claim is one `DELETE ... expires > now`, the context cut to 8000 UTF-16 units; `list`, `get`; `webBase`),
  `handoff/store.rs`. Every failure is the single `E_NOT_FOUND` "channel conversation or continuation unavailable".
- *Ported, delivery:* `delivery/policy.rs` (`deliveryAllowed`, including the Buzz public key rule), `delivery/service.rs` (`add`,
  `challenge` with a 16-byte code in hex that is never returned or logged, ten minutes (`clock < expires`), at most five tries,
  `confirmMessage` for the ASCII case-insensitive `/delivery` command with JavaScript's `\s`/`trim` set, quota 32 per person including
  the race across the awaited DM lookup, `validate` that audits `delivery.denied`, `deliver`, `subscribe` (last 32 kept), `notify` over a
  snapshot that swallows channel errors, `eligible`, `list`, `remove`).
- *Ported, the inbox:* `inbox/store.rs` (publish with the dedupe key, the rolling cooldown `now - last < cooldownMs`, retention by age
  (90 days) and count (1000) before and after a publish, list with the base64url cursor read as Node reads it, count, read, dismiss,
  settle), `inbox/service.rs` (best effort: a failing publish, settle or change listener is logged and never thrown), `inbox/producers.rs`
  (approval, job failure, media index, pairing, channel, break-glass and always-grant notices; `looksLikeToken`, `param` masking, UTF-16
  clips), `inbox/migrate.rs` (the break-glass notices).
- *Ports (R-K-2):* `budget::Clock`, `budget::IdSource`, `approvals::Random`, `rbac::audit::AuditSink`, `handoff::SessionPort` and
  `HumanLookup`, `delivery::DeliveryIdentity` and the allowed, target and send ports, `inbox::service::InboxPort` (the notifier and the
  listeners). The test doubles live in each module's `testing.rs` (`pub(crate)`); the awaits of TypeScript are callbacks outside the
  write transaction, and a race is tested with a hook that changes the file through a second connection.
- *Proof:* mode V from three exporters (`export-handoff.ts`, `export-delivery.ts`, `export-inbox.ts`, helper `k3b-support.ts` with scripted
  randomness (`draw:k`, `uuid:k`), installed per build and restored): `fixtures/parity/handoff/{web-base,rules}.json`,
  `delivery/{policy,rules}.json` (2681 policy cases; the largest file 976 892 bytes, under the 1 MiB rule), `inbox/{store,service,producers}.json`;
  `--check` for each and a stale guard in `parity.test.ts`. The replay compares answers, audit lines, rows and the schema text.
  Mode B: `tests/core-parity/k3b-b-driver.ts` + `crates/plur1bus-core/tests/k3b_mode_b.rs` (TypeScript writes the three stores with the product
  code, among them a link, a confirmed target and a read entry; Rust opens copies, redeems TypeScript's link, confirms a second target,
  publishes against a TypeScript dedupe key, writes its own rows and creates fresh files; TypeScript reads the result with the product code
  and the schema text of every Rust-made file is TypeScript's). Ported tests: `handoff/tests.rs`, `delivery/tests.rs`, `inbox/tests.rs`.
- *Deliberately not ported:* the three `rpc.ts` files and their RPC surface, and the lazy opening behind the handlers.
- *Known differences (K12):* **K3-D4** a clip that ends inside a surrogate pair keeps a lone surrogate half in TypeScript; Rust cannot hold one and
  drops it (the fixtures write such strings as `$u16` arrays and the replay compares the cut that Rust makes). Inbox `limit`, `cooldownMs` and
  retention take numbers as `f64` so that `NaN`, fractions and values beyond the safe range are refused as TypeScript refuses them.


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
Missing crate: none. The HTTP client is P4-W's; ruling R-K-14 makes HTTP a port here, so K4 needs no crate.

**K4 as built** (`crates/plur1bus-core/src/provider_auth/`, one `pub mod` line in `lib.rs`; no RPC method, nothing wired into the
front door, the relay, `native*.rs` or the supervisor; no schema change, no new error code, no Cargo file changed; no change under
`packages/*/src`).

- *Ported, `auth/`:* `profile.rs` (closed validation over the JSON value, check for check in TypeScript's order and with its texts,
  `parseHeaderScheme`, `loadProfiles`, the URL aliases), `env.rs` and `ladder.rs` (the two predicates and `planLogin`), `pool.rs`
  (the cooldown table, sole against several, the `Retry-After` clamp, model scope, the three strategies, status, snapshot and
  restore; JavaScript's `Map` order kept), `redact.rs` (`scrub`, `safeFields`), `record.rs` (the `SecretStore` port, the OAuth
  record byte for byte, `SecretsBridge` over `secrets::SecretStore`: a core lease revoked at once, owner writes), `http.rs` (the token
  POST, `parseTokenResponse`, `clientFields`, `HttpRefresher`), `refresh.rs` (the single refresh owner: one exchange per handle for
  any number of threads, persistence before release, the unpersisted rotation, skew and jitter, the transient backoff, re-auth
  marking, the timer as a port with `fire`), `credentials.rs` (`AuthorizationLease`, the provider and its failover), `login.rs`
  (PKCE over a loopback listener, paste-callback, the device code; `CallbackGate` is the listener's handler; `TcpLoopback` the real
  listener on 127.0.0.1, port 0), `adc.rs` (Google ADC: gcloud paths on POSIX and Windows, `authorized_user`, the RS256 assertion of a
  service account signed with `ring`, PKCS #8 and PKCS #1 PEM).
- *Ported, `openai-auth/`* (`provider_auth/openai/`): `ports.rs` (the closed codes, `call`, `SerialOwner`), `profiles.rs` (owner rule,
  endpoints, key status, failover, the retired import route, the never-list port), `wire.rs` (`guardSiwc`), `identity.rs` (host
  identity, discovery, JWKS verification with `ring`: EdDSA and RS256), `plan.rs` (login, lease with the durable spent marker,
  metadata, models, responses, logout, transfer; the registration written in TypeScript's member order), `workload.rs`,
  `federated.rs` (the supplier as a port, `FileSupplier` with the never-list and the 64 KiB cap), `loopback.rs` (the plan's gate and
  `LoopbackPkce` over the listener port), `service.rs` (`AuthService`, one plan per operation as `#plan()` does, and
  `PendingLogins`), `http.rs` (`OpenAIHttp` over the auth transport and the egress dry run), `usage.rs` (`openai-plan-usage.sqlite`).
- *Proof:* mode V and W from `export-provider-auth.ts` (eleven files, the largest `pem.json` at 563 KiB) and `export-openai-auth.ts`
  (seven files, the largest `jwks.json` at 515 KiB), `--check` and a stale guard in `parity.test.ts` that also refuses a whole secret
  in a fixture; replayed by `provider_auth/vectors.rs` and `provider_auth/openai/vectors.rs`. Mode W is proven at the HTTP port
  (R-K-14): the TypeScript code runs against a scripted `egress.request` (the pre-I/O checks of the guarded client and the real
  `createEgress().decide`) or, for `openai-auth/`, its own `HttpPort`; the Rust double compares every request (method, URL, header
  set, body byte for byte, the limits and the pinned address) and answers with the recorded one. Mode B:
  `tests/core-parity/openai-usage-b-driver.ts` with `tests/openai_usage_mode_b.rs` (TypeScript writes, Rust reads and writes and
  creates a file, TypeScript reads both; schema text equal). `tests.rs` (both levels) ports what the vectors do not hold: the listener
  gates, a real loopback login over a socket, the bridge over the real secret store with memory backends, pending logins, the
  federated cache, the printed form of every type that holds a secret.
- *Test files and their mode:* `auth/ladder`, `profile`, `pool`, `credentials`, `redaction` V; `auth/refresh`, `refresh-schedule`,
  `http-boundary`, `login-flows`, `login-callback-state`, `flow-security`, `adc-http` W (and Rust tests for the listener);
  `openai-auth/auth`, `workload`, `wiring`, `audit-b10` W and V; `openai-auth/loopback` Rust tests (the gate) and W through the plan;
  `openai-auth/store-and-errors` B for the usage book (its file-backend half is the secrets package's, P4-20); `openai-auth/federated`
  Rust tests (the supplier is a port); `openai-auth/system`, `turn` and `live` no mode: they drive the composed runtime and the
  provider adapter of P4-W (the flip).
- *Deliberately not ported:* `openai-auth/provider.ts` (the streaming adapter, P4-W's provider crate), `openai-auth/runtime.ts` (the
  composition of the flip), the multipart SDP body of `createOpenAIHttp` (voice, P4-W), the command runner of the federated supplier
  (the flip's process supervision), the promise plumbing of `startLogin`/`awaitLogin`/`cancelLogin` (`PendingLogins` keeps its
  rules), `AbortSignal` (the flip cancels).
- *Known differences* (numbers in K12, R-K-6): the deadlines of the login flows and the forged-callback window run on the clock port
  where TypeScript reads the wall clock; the credentials provider takes the refresh owner's timer and randomness as ports; a JSON body
  is written with its members in key order (`serde_json`), TypeScript keeps insertion order (nothing a server reads); a token answer
  `serde_json` cannot read (a lone surrogate escape, a number beyond a double) is `invalid_response` or `transport-failed`, fail
  closed; `ring` refuses RSA keys below 2048 bits (a service-account key, a JWKS key: K4-D5) where Node accepts them, fail closed;
  a caller waiting for another caller's refresh gives up after the wait limit, where TypeScript awaits the shared promise; a workload
  exchange answer whose `token_type` is an array that `String()` turns into `bearer` is refused, TypeScript takes it; the plan
  registration and the credential index are rewritten with their known members only (TypeScript spreads what it read, so a member
  only a hand could have added survives there); the usage book's file is created 0600 (TypeScript relies on the 0700 `state/`).
- *`K4-D` findings:* K4-D1 (robustness): `validateProfile` accepts an `extra_headers` that is a string, an array or a number
  (`Object.entries` reads indexes; `"ab"` becomes the headers `0: a`, `1: b`); Rust does the same (parity, vector). K4-D2 (test seam):
  the forged-callback rate limit of `auth/login.ts` reads `Date.now()`, not the injected clock. K4-D3 (availability, divergence):
  `auth/login.ts` resolves a request target against the redirect without a guard, so a target that is no URL makes its handler throw
  and the request gets no answer; the port answers 404 and keeps listening (`login.json`, scenario `loopback-unparsable-target`).
  K4-D4 (availability, divergence): the same in the plan's listener `openai-auth/loopback.ts` once method and headers pass
  (`listener.json`). The id-token verifier's EdDSA branch refuses keys and R of small order as Node does (`jwks.json`, `eddsa`).
  K4-D5 (divergence, fail closed): the id-token verifier refuses RSA keys below 2048 bits and with exponent 1, which TypeScript
  accepts (`jwks.json` `members`; exponent 3 at 2048 bits passes both). K4-D6 (divergence, fail closed): a header whose `alg` is an
  array is refused; TypeScript accepts it (`members`). K4-D7 (divergence, fail closed): a key set entry with a member `d` is refused
  whatever its other members say; Node reads such an entry as a private key and accepts it when the private members are complete
  (`members`). K4-D8 (divergence, fail closed): a service account PEM with `\r` at the start of a line, a NUL at the end of one or a
  byte-order mark before it is refused; OpenSSL reads it (`pem.json`). K4-D9 (fail closed): a stored record, a token header or
  claims, or a key set that `serde_json` cannot read (a number beyond a double such as `1e999`, a lone surrogate escape such as
  `"\ud800"`, nesting deeper than 128) is `invalid_secret_record` or `id-token-invalid` here, where TypeScript reads it; TypeScript
  never writes such a record itself.
- *CI fix (PR #933):* `TcpLoopback::next` ended the wait as a timeout when `accept` failed, and Windows reports a connection that
  its peer reset before it was accepted as such a failure, so such a connection ended the wait before its deadline. A failed `accept` now ends
  neither the wait nor the listener: a reset or aborted connection is skipped, any other failure is retried after the short sleep of
  the loop, and the accepting is bounded by the deadline. Node's server ignores such failures too, so this is no divergence. The
  tests inject the failures through a test-only seam (`fail_accepts`), since Unix does not report them reliably.
- **K4-D10 (loopback admission at capacity).** Both TypeScript implementations use `node:http` without setting an application
  connection limit or displacing the oldest accepted connection. Rust bounds the open set to 64 and gives it a nonblocking read
  pass at capacity before resuming accepts. If the set stays full after that pass, the next admission can displace its oldest
  connection. The wait deadline bounds both phases. The Rust loopback test checks delivery of a valid callback under load, a
  timeout in the absence of a callback, and that no accepted connection is displaced before its first read attempt.
- *Review C:* `kid` of a key set entry and of a token header is compared as `===` compares it (absent equals absent, `1` equals
  `1.0`, an array or an object equals nothing), where the port had compared the JSON values; this is the only comparison of two
  foreign JSON values under `provider_auth/` (the others compare against a constant text). A key set entry with `d` is refused (see
  K4-D7; members `p`, `q`, `dp`, `dq`, `qi` without `d` are not read, in Node either). The refresh owner catches a panic of the
  refresher and takes it as `transient`, and a panic of the store's read or write as the failed read or write it is in TypeScript (a
  rotated record is then held in memory as when the store refuses it); a panic of any other port inside an exchange still fails its
  caller, and a guard (`Release`) frees the handle and hands every waiter a retryable `refresh_failed`. No caller waits longer than
  `RefreshOwner::with_wait_limit` (120 s by default) for another caller's exchange. An empty rotated refresh token keeps the known end
  of the refresh token, as `!res.refreshToken` does (only a `Refresher` port other than `HttpRefresher` can answer one).
  `PendingLogins::cancel` leaves the login in place until `take` collects it, and a login id started twice replaces its entry, as
  `Map.set` does. The service account PEM is read line by line in the forms OpenSSL takes (`pem.json`, 126 forms).
- *The real listener* (`TcpLoopback`, review B): every connection is read side by side without blocking, until the wait's deadline;
  one must send its request head within five seconds and within the wait it came in, at most 16 KiB of it, or it is closed
  unanswered; at most 64 are held. `node:http` also serves connections side by side but waits up to 60 seconds for a head, so the
  port closes a slow client sooner. In paste-callback mode the port is bound and not read (TypeScript answers there with 400 or 410);
  connections wait until the login ends.
- *Ports for the flip:* `ports::{Clock, RandomUnit, RandomBytes, AuthLog}`, `record::SecretStore` (`SecretsBridge`),
  `http::HttpTransport`, `login::{LoopbackListener, LoginUi}` (`TcpLoopback`), `refresh::RefreshTimer` (the driver calls
  `RefreshOwner::fire`), `credentials::AdcTokenSource`, `adc::AdcFiles`, `openai::ports::{HttpPort, PkcePort, AuditPort}`,
  `openai::workload::SubjectPort`, `openai::federated::Supplier`, `openai::profiles::CredentialDenyPort`, and `randomUUID`.
- *Conditions on the real HTTP client of the flip:* connect to `Pin.address` and `Pin.port` with TLS for `Pin.host`, never resolve or
  parse the URL again (R-K-17); never follow a redirect (a 3xx is answered as it is); one deadline (`Limits.timeout_ms`) for the whole
  call (`TransportError::Timeout`); cap the decoded answer at `Limits.max_bytes` and read at most `Limits.error_body_bytes` of an error
  answer (`TransportError::TooLarge`); decode gzip, deflate and brotli as the guarded client does; send exactly the given headers plus
  `content-length`, no cookie, no `authorization` unless given; report a refused hop as `TransportError::Refused`. The OpenAI port
  needs the same with a 256 KiB cap.


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


### K5a as built (store, migrations, types, tokens; P4-40, first of three runs)

**Ported** (`crates/plur1bus-core/src/sessions/`, one `mod` line in `lib.rs`, on `plur1bus-store` with `Schema::Steps`, WAL, `synchronous=NORMAL`, mode 0600): everything in `session/store.ts`, including the methods only rewind or compaction call (`rewindPath`, `undoRewind`, `reserveRewind`, `planRewind`, checkpoint rows, `setToolVisibilities`, `addSummary`, `replaceSummaries`, `recordMessageUsage`, ...), `migrations.ts` (the eleven texts byte for byte, the test `migration_texts_are_the_typescript_texts` compares them with the exporter's copy), `types.ts`, `tokens.ts` (`TokenMeter`, `catalogWindow`) and the pure parts of `rewind-path.ts` (`activePath`, `activeSummaries`, `hiddenDigest`) and `rewind-cycles.ts` (`failedEditCycles`).

**The schema is v11, not v9.** The plan and the brief say v9; the source has `MIGRATIONS.length = 11` (v10 `path_rewinds`, `session_checkpoints` and its immutable trigger, v11 `session_worktrees` and its trigger). Mode B covers all eleven versions.

**Deliberately not ported:** `readOnlyCatalog` of `catalog.ts` (it reads the model catalogue through discovery; `ReadCatalog` is the port, `catalog_window` is ported), `turn-loop.ts` (P4-43), `methods.ts` / `service.ts` as RPC (flip), the K5b and K5c modules (compaction, pruning, context-fit, summarizer, maintenance, role-routing, chat-models, provider, turn-telemetry, memory-port; rewind*, checkpoint-*).

**Evidence.** Mode V: `scripts/parity/export-sessions.ts` runs 18 scenarios (773 ops) against the real `SessionStore` on a temporary file with a scripted clock and scripted ids; raw `sql` ops read the file (FTS `bm25`/`snippet`/`highlight`, tables, `sqlite_master`); pure cases for `activePath`, `activeSummaries`, `hiddenDigest`, `failedEditCycles`, `ftsQuery`. Six fixtures, the largest 255 KB, staleness test in `parity.test.ts`; replay in `sessions/vectors.rs`. Mode B: `tests/core-parity/sessions-b-driver.ts` and `tests/sessions_mode_b.rs`: v1 to v11 with content opened, migrated, read and written by Rust and read again by the product code; a file Rust creates and fills (with a rewind, offers, summary, calibration, visibility) read and extended by TypeScript and read again by Rust; `sqlite_master` text of every Rust-migrated and of the Rust-created file equals TypeScript's; a newer file is refused and left byte-identical. FTS5: rusqlite 0.41 bundles SQLite 3.54.1 (source id 2026-10-16), this Node's `node:sqlite` is the same build, so queries, ranks and snippets are identical here. **Risk:** the two are separate builds; an older Node (a probe on another Node reported 3.53.4) can drift in `bm25`/`snippet` output, and the vector `fts.json` would then be stale on that machine, not wrong.

**Ports for the flip (R-K-2, no third one):** `budget::{Clock, IdSource}` (ids are `prefix_` + `next_id()` drawn at the same point as in TypeScript), `ReadCatalog`, the archive/erasure listeners (`on_archived` returns `Err` like a throwing listener: dropped, the archive stays), the audit callback of `rewind_path` / `undo_rewind` (`AuditFn`), `RewindToken` for reservations. JSON columns use `approvals::js_json::J` (ordered members, array-index keys first, `stringify` = `JSON.stringify`); numbers are `i64` except calibration factors and confidences (`f64`).

**Known deviations (ledger K5-D...):**
- **K5-D1** TypeScript runs some single statements outside `#tx` (`recordMessageUsage`, `setToolVisibility`, `addSummary`, `setSummaryState`, `restoreSession`, `setTokenFactor`, `forgetCheckpoint`, `recordToolRefetch`, `freeze*`) and lets a raw SQLite error escape (`{ name: "Error", message }`); Rust gives every store error a code (`storage`/`sqlite`, same message). The replay accepts exactly this difference. `setToolVisibility` is one transaction in Rust where TypeScript has two statements.
- **K5-D2** `mapSqlite` matches `turns.session_id`, which also catches `UNIQUE(session_id, seq)`; a racing second writer would be reported as `turn-in-progress`. Ported as is, covered by a direct test of `from_message`.
- **K5-D3** Enums are closed in Rust: a trigger, summary state or event type TypeScript would store unchecked (and fail on a CHECK) cannot be built. Ops with such values were left out of the vectors; the JSON boundary of the flip must map them to `invalid`. An event `type` read from a file stays a string (a newer core's type reads).
- **K5-D4** A title cut inside a surrogate pair is stored as U+FFFD (as `node:sqlite` does); strings with a lone surrogate in an input cannot exist in Rust and are `$u16` in the vectors.
- **K5-D5** The fixtures `js/digests`, `identity/code-normalize-sweep`, `openai-auth/plan` and `openai-auth/service` are stale against the exporters on this machine's Node 26.13.1 (they are not touched by K5a); `--check` fails for those three exporters. Flag for the controller: the vectors depend on the Node version.
- **K5-D7** The bm25 `rank` of `searchMessages` depends on the platform's floating point in the last digits (the Windows x64 CI differs from the vectors recorded on macOS), the order of the hits does not, so the replay compares `rank` with a relative tolerance of 1e-9 and everything else exactly. The same holds for the raw `sql` operations of the FTS scenarios that select `bm25(messages_fts) AS rank` (the Linux and Windows CI differ there too): only that column is tolerant, the order and length of the rows and every other column and number compare exactly, and any other raw query stays exact. The capability index of `toolcall/` uses bm25 only to order its hits (ties broken by id) and returns no rank.
- Scenario limit: exporter ops use fixed ids for a few later ops (`rew_...`, `sum_...`); where setup drifted, both sides answer the same error, so the replay still matches, but those lines test less than intended. `$turn` / `$ses` placeholders resolve the ids that matter.

**What K5b and K5c find:** `store_misc.rs` and `overlay.rs` already hold the rewind overlay (`rewind_path`, `undo_rewind`, `reserve_rewind`, `plan_rewind`, `rewinds`, `summary_rewinds`, `propose_rewind` with `failed_edit_cycles`), checkpoint rows (`record_checkpoint`, `checkpoint`, `checkpoints`, `forget_checkpoint`; the git process and retention are K5c), visibility and pruning rows, summaries (`add_summary`, `replace_summaries`, `set_summary_state`, `active_messages`), calibration (`token_calibration`, `set_token_factor`, `record_message_usage`) and the learning reads. K5b needs only the pure maintenance on top; `proposeRewind`'s event member order (parentSeq, failedCycles, lastCheckSeq, agentId) is verified against TypeScript here, the callers are K5c.

### K5b as built (session maintenance without a file system; P4-40, second of three runs)

**Ported** (`crates/plur1bus-core/src/sessions/`, no new `mod` line in `lib.rs`): `context_fit` (`contextCost`, `assertContextFit`, `assertRoleContext`, the two error shapes), `compaction` (the pure helpers `estimateTokens`, `truncateWithPointer`, `fitTail`, `digest`, the defaults; `Compactor` with `view`, `prepare`, `afterTurn`, `explain`, `restoreToolRef`, `configureModel`, the whole-turn cut, the tiered merge, the stale-revision check after the summarizer and the checkpoint), `pruning` (`ToolPruner` with `view`, `run`, `restore`, `metrics`; the protection rules, the heuristic, the Laya answer check, `hiddenToolOutputs`; one `set_tool_visibilities` transaction), `summarizer` (`LlmSummarizer`: block split, up to eight pairwise merge tiers, the whole transcript for apple-fm or an empty role table, the three error texts), `maintenance` (`session_maintenance`: window 8192, ratios, prune passthrough), `role_routing` (what the adapter decides: profile and candidate resolution, `roleModels`, `modelProfiles`, `defaultModelProfile`, `contextModels`, the summary cap, the usage measurement, the augmented usage chunk, when a classifier is wired), `chat_models` (with the part of `providers/src/reasoning.ts` it needs: `nearestLevel`, `budgetFor`, `reasoningDirective`; `chatModelOptions`, `effectiveReasoning`, `directiveFor`, over `config::policy`), `turn_telemetry` (the per-turn record and the aggregate with nearest-rank quantiles and the 1024-sample ring), `memory_port` (the `TurnMemory` trait, a recording double, and the decisions the engine-backed port makes before it asks the engine). `catalog.ts` and `types.ts` hold nothing more to port (`types.ts` was K5a; `readOnlyCatalog` stays behind the `ReadCatalog` port). `jstext.rs` is the one place that cuts and measures strings in UTF-16 units as JavaScript does.

**Deliberately not ported:** `sessionRoleFactory` and the router wiring in `createSessionRoleProvider` (`createTurnProvider`, `AsyncLocalStorage`, `DecisionClient`, the stream wrapper: the router and the async plumbing; their decisions are the functions above), `readOnlyCatalog` (file read and `validateCatalog`, discovery), `engineTurnMemory` (engine, identity, channel context), `checkReasoningDirective` (an adapter guard), `rewind*` and `checkpoint-*` (K5c), `turn-loop.ts` (P4-43), `methods.ts` / `service.ts` (RPC, flip).

**Evidence.** Mode V: `scripts/parity/export-session-maintenance.ts` (with `session-maintenance-extras.ts`) runs the real `Compactor`, `ToolPruner` and `createLlmSummarizer` over a real `sessions.sqlite` with a scripted clock, ids and `performance.now` and scripted ports (summarizer, checkpoint, Laya decider, provider stream, including writes by another task while a port awaits); it also records the pure helpers, context fit with the exact error objects, telemetry, chat models and reasoning (grids over every level subset), the maintenance configuration and role routing over the real `createSessionRoleProvider` with a scripted `create`. 16 fixture files, the largest 634 KB (limit 1 MiB, guard in `parity.test.ts`). Mode B: `sessions-b-driver.ts` (`maint-*`) and `sessions_mode_b.rs`: TypeScript fills, TypeScript and Rust each prune and compact a copy, the two files are compared row by row (summaries, visibility, messages, events with their data, explanation, metrics); Rust reads the view of the file TypeScript compacted and TypeScript the view of the one Rust compacted; each keeps writing into the other's file. The same with Rust filling. Mutations: 23, all killed (four survived the first run and led to new scenarios: factor clip of a single message, the exact time budget, the ninth merge tier; one was an equivalent mutant and was replaced).

**The summarizer is a port.** No model call and no network: the provider is `SummaryProvider`, the exporter records the request TypeScript builds byte for byte and how it handles empty, blank, too long, tool-call, throwing and mid-stream-failing answers.

**Ports for the flip (R-K-2, no third one):** `CompactionHooks` (summarizer, checkpoint, `emit`, `on_error`; the store is lent to every call so a double can write during it), `PruneHooks` (decider, `min_confidence`, `aborted`, `emit`, `now_ms` as the monotonic clock), `SummaryProvider`, `RoutingOptions`, `ChatModelSources`, `ReadCatalog`, `TurnMemory`, and `IdSource` for the request ids.

**Known deviations:**
- Profile and role names are looked up as own keys; TypeScript reads `profiles[name]` on a plain object, so a role named like an `Object.prototype` member finds that member. Needs a hostile owner and gives no authority.
- `session_maintenance` refuses a configuration with a missing or mistyped member (TypeScript carries `undefined`); `config-schema` validates before.
- Counts in telemetry are `f64` (a fraction adds as a fraction), reasoning levels and descriptor kinds are closed enums (a level outside the scale cannot be built).
- The vectors cannot carry key order (fixtures sort keys): the replay writes tool events in the order the exporter's builder used (`id, name, args` / `id, output, isError`), and the exporter's own args are written in sorted order so the stored text and its hash are the same on both sides.
- `memory_port` has no recorded vectors (the real port needs an engine, an agent registry and an identity service); its gates are covered by unit tests written from the TypeScript text.

**What K5c finds:** `Compactor::pruner()` / `pruner_mut()` and the `explain` rows are in place for the rewind and checkpoint code; `maintenance_vectors.rs` shows how a scenario world is built (`World`, `during` writes) and `Run::op` still takes every base op, so rewind ops can be added to the same exporter world; `fixtures/parity/session-maintenance/` is the K5b area, K5c should use its own.

### K5c as built (rewind and file checkpoints; P4-40, third of three runs)

**Ported** (`crates/plur1bus-core/src/sessions/`, five `pub mod` lines in `sessions/mod.rs`, none in `lib.rs`): `rewind_git` (`checkpoint-git-process.ts`: the `GitProcess` port, `SystemGit` with the 30 s timeout, the 1 s kill grace, the 32 MiB output bound and an environment given exactly; `Cancel`, the polled counterpart of an `AbortSignal` with a reason; `RewindError`), `rewind_checkpoints` (`rewind-checkpoints.ts`: the Git environment policy, the private temporary index and bare Git directory, `write-tree`, `commit-tree`, `update-ref` with the all-zero old value, the once-scoped approval with its action hash, the revalidation after the wait, `git restore --overlay` as the only write, the untracked-path protection, the bounded preview), `checkpoint_retention` (`checkpoint-retention.ts`: turn retention, session-ended and card-ended cleanup, warn once per key, the archive listener and the deferred prune), `rewind` (`rewind.ts` with `rewind-cycles` and `rewind-path`, whose pure parts K5a had already ported to `overlay`: the service, the lesson facts, the `/rewind` command parser) and `rewind_project` (`rewind-project.ts`).

**Deliberately not ported:** `rewind-methods` (RPC), `turn-loop.ts` (P4-43), the collab and worktree services behind `rewind-project` (K6: ports `CollabPort` and `WorktreePort`), the timer itself (the host calls `tick`; the 10 s interval is `timer_at` against the `Clock`).

**Evidence.** Mode V: `scripts/parity/export-session-rewind.ts` puts a `git` shim first on the `PATH` of the real TypeScript `RewindCheckpoints`; it logs the argument list and the `GIT_*` environment of every call and fixes the author and committer dates so commit ids repeat. Six cases (capture and restore, refused restore, a restore overtaken while the human decides, an untracked path in the way, no repository, no commit) are replayed by `rewind_vectors.rs` against the real `git` in a temporary directory with an isolated configuration: every argument list byte for byte, the error reasons and exit codes, the commit and tree ids, the files that remain. The replay found one real difference on its first run (the Rust restore re-read the checkpoint ref although the working tree had already changed; the source short-circuits). Mode B: `tests/core-parity/sessions-b-driver.ts` commands `rewind-capture`, `rewind-checkpoint`, `rewind-restore`, `rewind-dump` and `crates/plur1bus-core/tests/sessions_rewind_mode_b.rs`: TypeScript captures and Rust restores, and the reverse, over the same SQLite file and repository; the file tree, `git status`, the checkpoint row and the private refs equal what each language does alone. Direct tests (`rewind_tests`, `rewind_git_tests`, `rewind_service_tests`) port `rewind-files`, `-missing-worktree`, `-retention-restart`, `-retention-timer`, `-git-process`, `-service`, `-store`, `-path`, `-cycles`, `-project` and the parts of `-core`, `-command-failures` and `-service-shutdown` that do not need the turn loop. Mutations: 20 recorded, 20 killed (8 survived the first run and got tests: retention of exactly 500, a directory where the checkpoint has a file, a tracked file gone from disk and index, the 200-path and 4096-unit preview bounds, the 32 MiB output bound, and, through a replaceable Git answer, the guards against `..`, `.git` and an index changed after the approval).

**Real git only in temporary directories.** `HOME`, `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` point away from the person's configuration; a test that needs `git` says it is skipped when there is none. The real-path tests are `#[cfg(unix)]` because the path layer refuses everything on Windows (R-K-12).

**Ports for the flip (R-K-2, no third one):** `GitProcess`, `RestoreApproval`, `RewindFilesPort`, `LessonSummarizer`, `CollabPort`, `WorktreePort`, `Remover`, `PathFs`, the `Clock`, the `IdSource` and the audit sink; `ProjectLookup` for the trusted D115 binding.

**Known deviations:**
- The store is lent to every call (`&mut SessionStore`) instead of being held; a restore waiting for approval is given it so a host can run maintenance meanwhile.
- Cancellation is polled by the Git process loop and carries its reason; the reason of a missing path is the OS error code, as in the source.
- `SIGTERM` is sent through the `kill` utility (`forbid(unsafe_code)`), unix only; the output bound counts raw bytes, the source counts bytes of the decoded chunks.
- Retention runs from `tick`/`idle`/`run`; the first sweep after a restart waits for the next of these. A second `run` on a session that is busy is refused with `rewind-checkpoint-busy` (the source queues it on a promise).
- The nested `changes` object of the restore audit line has its keys sorted by `serde`; the action hash is computed over the ordered text and is the source's.
- Paths Git lists are additionally refused when absolute, empty, `.`, `..` or `.git`: the source relies on Git alone. No input Git can produce reaches it.
- `rewind_project` is behind ports; there is no collab to read.
- The vectors were recorded on unix; the guard test skips on Windows.
- **K5-D8 (K5-R1):** Rust checks the working tree, index and untracked targets again after consuming approval
  and recording audit, immediately before requesting the restore. Changes after this final check still need host coordination.

**What the flip finds:** the host drives `tick` (10 s) and `idle`; the approval port must answer with scope `once` and consume it in `begin`; `ProjectLookup` must return the realpath of the card's worktree; `turn-loop` calls `RewindFilesPort::capture` before a model turn and `RewindService::after_turn`.

### K6a as built (collaboration store, rules, board and the admission side of the service; P4-50, first of three runs)

**Ported** (`crates/plur1bus-core/src/collab/`, one `mod` line in `lib.rs`, on `plur1bus-store` with `Schema::Steps`, WAL, owner-only file): the whole of `collab/store.ts` that the library uses (projects, members, agents, repo binding rows, worktree rows, artifacts, repeat memory, traces, spans, tasks, `cancelOpenTasks` with the grant port), `migrations.ts` (schema v9, every earlier version read and migrated), `limits.ts` (resolution with JavaScript number rules and the delegation work budget), `capacity.ts` (arithmetic in doubles, so a zero divisor gives the same `Infinity`/`NaN` answers), `guardrails.ts` (the first-refusal order), `ids.ts` (repeat key with the JavaScript white-space set, pair key, `traceparent`), `board.ts` (the whole project board as one JSON document, byte-equal), `scope.ts`, `ports.ts`, and from `service.ts` the project administration with RBAC and visibility, the admission of a consult or delegation (`guard`, `refuse`, the counters and repeat memory), chains (`openChain`, `finishChain`, `cancelChain`), writer slots (`reserveWriter`) and the redacted reads (`getTask`, `getTrace`, `listTraces`, `exportTrace`).

**Deliberately not ported in this run (they are still K6a work, see the ledger)**: the delegate run (`delegate`, `handoff.ts`, `delegations.ts`, `target.ts`, `runTarget` with its deadline and stall timers), `replay` of a delegation transcript, `shutdown` with in-flight runs, `bindRepo` with git, the team policy. `collab/team/*`, the coding gate and surface, chat promotion, the runner and verifier and the evaluation harnesses are K6b and K6c.

**Evidence.** Mode V: `scripts/parity/export-collab.ts` drives the real `CollabStore` (with its board) through 13 scenarios (367 ops) on a temporary file with a scripted clock and one scripted id counter per prefix; raw `sql` ops read the stored bytes. Pure cases cover 112 limit resolutions, 60 guardrail inputs, 19 capacity inputs, 32 repeat keys and 8 work budgets; the schema vector holds the text of all nine migrations, the schema after every prefix, and the newer-schema refusal. Four fixtures, the largest 760 KB. Mode B: `tests/core-parity/collab-b-driver.ts` writes the store at every version and with the product code, `crates/plur1bus-core/tests/collab_mode_b.rs` opens, migrates and writes copies, TypeScript reads them back. The service side is tested by Rust tests that follow `rbac`, `guardrails`, `limits`, `isolation`, `memory-exposure`, `redaction-port`, `events` and `concurrency`, and a marker test (content a caller must not see appears in no released trace, task, export, event or error text).

**Ports for the flip (R-K-2):** `budget::Clock` (every clock read mirrors one TypeScript read, so a scripted advancing clock stays in step), `collab::ids::CollabIds` (ids and, new, the trace and span ids), `TaskGrantEnd`, `ports::{AuthorizePort, BudgetPort, RedactionPort, EventEmitter, AgentDirectoryPort, TurnRunner}` with a scripted runner double. The session store (`sessions`), the budget (`budget`) and audit (`audit`) are reached through these ports by the flip; nothing is wired.

**Known deviations (ledger K6-D...):**
- **K6-D1** Redaction is mandatory for release. TypeScript falls back to a default redactor; the port here has none. Without a `RedactionPort` the service refuses to return a trace, task or export (`unauthorized`, reason `no-redactor`) and stores empty previews. A decision for the flip: wire a redactor.
- **K6-D2** Trace and span ids come from the `CollabIds` port (TypeScript draws them from `randomBytes` inside the module), so they can be scripted.
- **K6-D3** A TypeScript `Promise` becomes two explicit calls (`start_consult`, `finish_consult`); an abort signal is the chain's shared flag; no timer lives in the module.
- **K6-D4** Stored project settings that are not a JSON object (a string or a non-empty array spread into `{...}`) are not reproduced; `null` and unparseable settings give a raw error as TypeScript does.
- **K6-D5** The grant store's error is not logged with the warning (TypeScript passes it as structured data); the message text is the same.
- **K6-D6** TypeScript throws a plain `Error` for what SQLite refuses (a foreign key, a missing project row on insert); Rust marks these `raw` and the vectors record only that it failed, not the text.
- **K6-D21 (K6a-R2)**: Rust scopes the service repeat window to the project. Legacy global repeat entries are
  ignored by the Rust service. The shared key function and store schema remain available for TypeScript round trips.

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


**K6a-Rest as built** (collaboration execution and transcript library, with no live adapters registered).

- *Ported:* sender contract validation and bounded repair, chain-backed authority checks before ack and again before execution,
  single-start receiver tickets, return validation, byte-safe excerpts, and turn-local ownership and delivery receipts.
  The delegate admits and reserves writers, selects exactly one target, persists tasks and spans, records progress and usage, and
  finishes through the caller's clock-driven tick. Shutdown signals the runs, bounds waiting, and emits abandonment per trace.
- *Repository and transcript:* repo binding checks the existing lead, project RBAC, canonical path, local branch and audit before
  storage. Git is a read port. A local delegate can record a session and recover the redacted transcript through the authorized
  trace and span. Replay checks immutable scope and owner; only the two matching provenance ids survive masking.
- *Boundaries for the flip:* the host owns the clock ticks, target work and join, the link to the approvals and grant stores, the
  audit and redaction sinks, local tool views, repository metadata and any worktree provisioning. The receiver only sees a scoped
  view approved by dispatch; A2A cannot receive local worktree reviews or ownership transfer. There is no local scope for an
  external target.
- *Recorded differences:* role/identity checks and an audit append are required at repository binding. A consumed writer slot is
  owned by the run until terminal completion. Rust aborts an expired queued run or a late completion on its next interaction
  with the clock. The output artifact and the task result are redacted before persistence. No timer is owned by the library.
- *Proof:* the real TypeScript exporters for handoff, turn collection, repository binding, replay and delegate runs under
  `scripts/parity/export-collab-*.ts`, checked against the Rust results. Existing mode-B tests cover the unchanged collab schema.

**K6b as built** (P4-50 coding surface libraries).

- The coding gate snapshots the tracked worktree and bound manifests, picks verifiers from committed settings, and checks the
  tree again before accepting results. Independent local reviews belong to a task, tree and writer. The surface rechecks live
  card assignment, canonical worktree and tree hash before moving a card. Human overrides require live lead or owner authority,
  a bounded note and an audit write.
- Chat promotion bounds source selection by bytes and message count, omits system messages, and rechecks the original owner,
  rewind history and destination before a commit. Private receipts are owner-scoped. A destination port keyed by preview ID
  handles deduplication across receipt retries.
- The runner requires matching agent and project scope, limits the tool view of reviewers, and reports progress without model
  reasoning. Coding sessions bind a D109 root to a verified person and, for card chat, the live D115 assignment. ACP mode and
  approval presence are per connection. Connection and session cleanup withdraw pending approval and task authority.
  The profile, advice, verification and diff libraries use explicit roots and bounded output. The Git diff builds its view in
  a private index and object directory through Git and filesystem ports.
- Tests replay real TypeScript vectors under fixtures/parity/coding and verify coding-gate.sqlite and chat-promotions.sqlite
  in both directions. Local ports provide the clock, IDs, audit, scopes, approvals, project, Git and verification execution.
- Deliberate differences documented in the run ledger include current host approval for network use, checks for live
  reviewers and canonical roots, an active connection for ACP preparation, and bounded/validated Git metadata. The native
  runner, filesystem and Git adapters, approval dispatch, and destination crash recovery remain host-composition work.

**K6c as built** (P4-50)

- `external_turn/` reuses the K5 session store for scoped start, single dispatch, event and message reads, terminal result, and cancellation. It binds owner and audience to authenticated context, checks current RBAC at every effect, bounds the history and stream, treats rewind lessons as user data, and revalidates memory exposure after recall. The application supplies identity, audit, clock, provider readiness, scoped memory and notifications. The host delivers the text-only request and advances any expiry tick.
- `federation/` models offer, lease, heartbeat, local project, recall, revocation and terminal observations. Memory transfers describe only the exact mission, foreign relationship, sensitivity level and content hash. Private home entries stay home, duplicate receipts do not create imports, and unacknowledged return data stays in the outbox. The application would own peer authentication, signatures, import, durable receipts and retention effects.
- Mode V uses the actual TypeScript helpers and external service with deterministic clocks, IDs and provider doubles. Mode B reopens the same private session SQLite file in both implementations, compares the exact schema and verifies that each can read the other's messages. There is no new schema or production route.
- External attachments are unsupported at this boundary. Token assertions cannot choose ownership. Unavailable providers leave no empty session, and provider errors remain stable metadata. Local interactive owners use a distinct authenticated namespace. The ledger records boundary, lifecycle and privacy decisions for the later composition.

## 8. K7: jobs, dreams, learning pass, skill mining, knowledge file, caption pipeline (P4-51)

Sources: `system-jobs/`: index(248) ledger(299)<br>`user-jobs/`: index(386) rpc(66)<br>`dreams/`: candidates(37) cron(105) index(61) learn/aggregation(66) learn/calibration(51) learn/compose(73) learn/config(21) learn/eval(83) learn/installation(30) learn/lifecycle(18) learn/methods(26) learn/model(12) learn/predictions(42) learn/provider(30) learn/refutation(37) learn/runner(117) learn/selection(46) learn/service(217) learn/source(54) learn/store(255) learn/types(39) learn/verify(24) methods(87) producer(125) scheduler(676) store(306) types(143)<br>`skill-mining/`: artifact-policy(53) evidence(13) miner(116) review(84)<br>`knowledge/`: file(65) job(95) migration(116)<br>`media-search/`: admission(67) backfill(113) caption/cloud(68) caption/index(5) caption/keyframes(94) caption/local(113) caption/service(80) caption/types(32) disabled(28) engine-adapter(61) engine-host(33) errors(10) ffmpeg(252) hook(138) in-memory(195) index(8) paths(27) select(15) types(64) validate(138)

Tests: `system-jobs/`: audit-c05 history ledger registry rpc-jobs run<br>`user-jobs/`: approval core hardening memory rpc store visibility<br>`dreams/`: a1-gate candidates-table cron-table deep-fail-closed deep-promotion engine-acceptance engine-diary index large-corpus learn-calibration learn-eval learn-finding-lifecycle learn-installation learn-lifecycle learn-operations learn-predictions learn-provider learn-refutation learn-runner learn-selection learn-service learn-source learn-verify methods producer scheduler-guards scheduler-time store<br>`skill-mining/`: artifact-policy miner review<br>`knowledge/`: engine-acceptance file job migration<br>`media-search/`: acceptance.todo admission audit-c08 backfill caption-default-rule caption-local caption-privacy caption-service catalog channel-uploads composition disabled engine-119 engine-adapter engine-host errors ffmpeg hook in-memory matrix output-storage-policy privacy-ack select validate; top level `dreams-acceptance`, `dreams-candidates`, `dreams-cron`, `dreams-no-host-cron`, `dreams-rpc`, `dreams-scheduler`, `system-jobs`.

| Tests | Mode | Note |
|---|---|---|
| `dreams/*-table`, `cron-table`, `candidates-table`, `scheduler-time`, `scheduler-guards` | V | schedules and triggers |
| `dreams/store`, `learn-*` store parts, `user-jobs/store`, `system-jobs/ledger`, `skill-mining/*` | B | `dreams.db` and the learn store keep their migrations in private arrays or `if (version < n)` chains: exports needed |
| `media-search/*` | V (rules), W (cloud captions) | `ffmpeg` is a process |
| `*acceptance*`, `engine-*` | no mode | engine-side (forwards are out of scope, card §1) |

Stores: `user-jobs.sqlite`, `dreams.db` (`SCHEMA_VERSION = MIGRATIONS.length`), learn store (`user_version` 1 to 7 by `if` chain), `skill-mining.sqlite`, system-jobs ledger (`state/system-jobs/ledger.jsonl`, rotated to `ledger.jsonl.1` at 1 MiB: JSONL, one row version `v: 1`, not SQLite).
Ports: clock, cron/timer, job runner, engine forward (out of scope), provider call (P4-W), ffmpeg.


**K7a as built** (system jobs and user jobs; `crates/plur1bus-core/src/jobs/{cron,user,system}`, one `pub mod jobs;` in `lib.rs`; no RPC method
registered, nothing wired into the front door, the scheduler, `core.ts` or the engine; the dreams, the learning pass, skill mining, the
knowledge file, media search and the engine forwards are K7b onward).

- *Ported:* `cron.rs` (`parseCron`, `nextAfter`, `isValidTimezone` of `dreams/cron.ts`, which the dream scheduler will reuse: JavaScript's
  `\s`, ASCII-only digits and `Number` on every part, Vixie's day rule, spring-forward wall times skipped, a doubled hour fires at its first
  occurrence, zones through `TzdbZones` with the additive `local_minute`). `user/` (`UserJobs` over `user-jobs.sqlite`: definition
  validation field by field, create, update with the takeover of `runAs`, delete, list, targets, history with `Math.min(200, Math.max(1,
  limit))`, tick, manual run, the claim of a slot and the run record in one `BEGIN IMMEDIATE`, the abandoned reconcile at open, outcomes
  that switch a job off; `rpc.rs`: `who`, the merges with the legacy answers of `jobs.list` and `jobs.history`, the `since`, `agentId` and
  `limit` reads, the refusals of `jobs.run`). `system/` (`SystemJobs`: the registry with the engine-name conflict, the exclusive lock,
  exceptions, a clock that steps back; `SystemJobsLedger`: the JSONL ledger with its lenient reader, torn last line, abandoned runs read
  back as `abandoned`/`core_stopped`, rotation at 1 MiB, owner-only paths; `arm.rs`: `armApprovalsIntegrity` with the timer as a port).
- *Stores (mode B and V):* `user-jobs.sqlite` has had one schema since it was introduced and no `user_version`; a file with a non-zero
  version is refused before anything is changed. The ledger file is `state/system-jobs/ledger.jsonl` with `ledger.jsonl.1`.
  `tests/core-parity/k7a-b-driver.ts` and `crates/plur1bus-core/tests/k7a_mode_b.rs`: TypeScript writes a store with an interrupted run
  and a rotated ledger, Rust reads, abandons, appends and refuses a newer schema, TypeScript reads the result and compares the schema text
  of the fresh Rust file with its own.
- *Rights:* every check goes through `rbac::authorize` (`agent.list` on the system, `agent.manage`, `agent.use`); a job runs with the
  rights of its `runAs` person, looked up when it runs, and is switched off when they are gone, no longer a person or without `use`.
  Reported, not changed (ledger K7-D1 to K7-D3): a creator who lost `manage` but kept `use` still runs, `update` hands a job to the updater,
  a manual run needs only `use`.
- *Deliberately not ported:* the method table and call context of `rpc.ts`, `authenticatedPrincipal`, `createApprovalsIntegrityJob` (approvals),
  a real timer (a host calls `tick` and `IntegrityArm::fire`), the engine forward of the job runner.
- *Known deviations:* no DST rules after 2037 in `chrono-tz` (zones with DST give the standard offset there), a wall year below 100 and the
  instants within a day of the earliest `Date` are errors, a lone surrogate in a definition cannot be held, the user-jobs directory is 0700,
  a newer store schema is refused where TypeScript opens it. **K7-D6 (K7a-R3):** The pinned Rust tzdb 2025b and Node tzdb 2026c
  disagree on the transition to permanent UTC in `Africa/Casablanca` and `Africa/El_Aaiun` on 2026-09-20. The recorded examples on
  both sides of the transition pin the database versions and the exact UTC outcomes. [IANA 2026c release notes](https://data.iana.org/time-zones/tzdb-2026c/NEWS).
- *Ports for the flip:* clock, ids (`randomUUID`), audit (`AuditSink`), principal lookup (`resolve`), delivery check (`validateDelivery`),
  agent existence and list, budget gate, display name, the turn (`submitTurn`), `notify`, `onRecorded`, `onFailed`, `isStopping`, the
  owner-only hook, `engineHasJob`, a logger, the integrity arm's timers.
- **K7-D7 (K7a-R1):** Rust rechecks the selected job under a write transaction and conditionally advances the same
  definition that was observed. A second connection that loses the scheduled claim returns without dispatching.
- *Proof:* `fixtures/parity/jobs/{cron,user,rpc,system}.json` from `scripts/parity/export-jobs.ts` (the real TypeScript over real files,
  scripted clock, ids and ports) replayed by `jobs::{cron_vectors,user::vectors,system::vectors}`; 31 mutants, 29 killed and two explained.

**K7b as built** (`crates/plur1bus-core/src/dreams/`, exposed as a library).

- *Ported:* The dreaming ledger, the registered phase schedule, local-time windows, cron and importance triggers, catch-up,
  crash reconciliation, capture consumption, bounded candidate observation, and promotion receipts. The learning pass covers
  session selection, installation diagnostics, extraction, evidence verification, shadow scoring, resumable model calls,
  finding revisions, prediction coverage, erasure, and explicit review and procedural handoff.
- *Stores:* Dreaming and learning open each other's TypeScript and Rust files in the parity drivers. The learning driver also starts
  from v2 and compares the legacy-decision and prediction backfills through v7. Learning payload resides separately from ledger
  projections.
- *Rights:* A job uses current person and agent rights. Candidate promotion requires the checked private scope and a receipt for
  the requested agent and source ID. Learning rechecks target and evidence access around port calls. Effective tier C remains
  in place. Explicit accepted effects have a prepared journal entry and require a scoped receipt.
- *Known deviations:* The Rust scheduler returns work and deadlines to the host. Work survives as durable claims and conservative
  model reservations. Read verification accepts canonical project-relative paths through the host. A retained historical finding
  requires current evidence to reach review. The fixture scenarios and run ledger record the other guard differences.
- *Ports for the flip:* Registry and principal resolution, caller timer and cancellation, model and job execution, scoped reads
  and writes, audit, count-only notices, secure paths, and the idempotent skill bridge. CLI and RPC registrations, runtime
  adapter composition, engine forwards, and log and diary presentation remain outside the library.
- *Proof:* Vector replay from `fixtures/parity/dreams/` and `fixtures/parity/learn/`, plus the Mode B drivers below
  `tests/core-parity/`. The final run ledger records native acceptance and mutation results.

**K7c as built** (P4-51)

- `skill_mining/` stores dispatcher-confirmed execution evidence, reconstructs bounded workflows from archived scoped sessions and submits inactive proposals. Review rechecks the human's current authority and the proposal's exact content hash before claiming the single-use approval. Artifact attribution binds an explicit owner decision to current file bytes. Manual files and files that changed since attribution require a proposal. The owner-controlled direct route returns a conditional write precondition.
- `knowledge/` handles quoted imports, fixed file slots, resumable staged migrations and rollback with a private lock and SHA-256 conditional writes. The model-free job maintains an explicit schedule and dispatches registered agents through an authorized port. The host owns persistent job history, timers and promotion.
- `media_search/` uses the shared model catalog, explicit per-call route and budget checks, a scoped bounded reference index with rank fusion, deletion-aware queue work, and fingerprint backfill planning. Caption ports handle prompt and user text, local model and ASR results, keyframe sampling and metered cloud vision with function-specific consent. Codec plans use a confined input lease, typed process commands and bounded outputs.
- Mode B exercises the unversioned private execution and artifact SQLite ledgers in both directions, including exact schema comparison and rejection of a newer schema. Mode V replays actual TS vectors for all three areas. Mode W exercises the TS cloud caption wire and metering with in-process doubles.
- Composition owns the identity resolver, rooted files, audit, SQLite paths, provider dispatch, D109 once-grant consumption, codec execution and all timers. Engine forwards, model installation, classifier/provider loading, native RPC registration and CLI wiring are outside this library slice.
- Intentional restrictions include immutable execution evidence, scoped mutations, limits on work and bytes, deletion and credential revocation taking precedence over delayed work, exact endpoint consent and a stable metered route, and budget settlement for a cloud call with uncertain provider usage. See the K7c ledger for per-rule differences and verification evidence.

## 9. K8: ACP (P4-71, without external agents)

Sources: `acp/`: backend(197) core-permissions(152) failure(14) file-changes(123) framing(54) index(3) main(42) modes(13) permissions(103) protocol(19) server(277) text(62)

Tests: `acp/`: acp-backend.coverage acp-main.coverage acp-server.coverage audit-b02 backend-modes backend-permissions core-permissions file-changes framing main main-profile permissions real-core-coding server server-file-changes server-modes server-permissions

All mode W in spirit: transcripts over stdio (initialize, `session/new`, prompt, cancel, permission) recorded from the TypeScript server and replayed.
`*.coverage` files are coverage fillers for the TypeScript build: no mode. Stores: none (`ACP_PROTOCOL_VERSION = 1`).
Ports: clock, session store (K5), permission/approval port (K3), file-change source.

**K8 as built** (`crates/plur1bus-core/src/acp/`, one `pub mod acp;` line in `lib.rs`; no RPC method, no change to either schema, nothing wired
into the front door, the relay, `native*.rs`, `server.rs` or the supervisor; `main.ts` is not ported, so the library takes an input port and a
`Write`). The library has no async runtime (tokio is dev-only): the server keeps TypeScript's async shape on plain `std::future` with a small
single-threaded executor (`exec.rs`: the first poll is eager, rounds run in FIFO order until one makes no progress, `yield_now` is one
microtask tick).

- *Ported:* `framing.rs` (`LineReader`: one message per line, `\n` ends it and one `\r` before it is dropped, 1 MiB bound checked before
  decoding with one byte of slack for the `\r`, the rest of an overlong line discarded, invalid UTF-8 read as replacement characters, the
  unterminated rest flushed at the end of input but not at a destroyed input; `encode_line`), `json.rs` (a value type with JavaScript's
  member order, number printing and `JSON.parse`'s grammar, an iterative parser and iterative drop so 500,000 levels of nesting are read
  and answered as TypeScript does, a repeated key keeps its first place and its last value), `jsops.rs` (the JavaScript operators the
  port needs: `===` that is never true for arrays or objects, truthiness, `String(x)`, `Number(text)` with a leading `+`, `Math.max`
  with `NaN`), `server.rs` (handshake, `session/new`, `session/prompt` with its 200,000-unit bound counted in UTF-16 units and its
  `resource_link` rendering, `session/cancel`, `session/set_mode`, the steer and follow-up extensions, the order of frames, log lines
  that never carry prompt text, method names or secrets, the end of input and a lost reader), `permissions.rs` (agent-to-client
  requests with issued ids only, 64 open requests, 8 options, 1 MiB per message, 5 minutes, withdrawal per session, fail closed on
  every malformed answer), `core_permissions.rs` (the approval relay: lists, re-reads and decides only through `approval.*`, the choices
  `allow-once`, `allow-task`, `allow-session`, `deny`, never `always`, never above surface 2, attestation above surface 1, a refusal
  becomes a notice), `backend.rs` (`CoreSessionBackend` over a caller port: `session.create`, `code.session.open`/`mode`,
  `session.submit`, `session.events` in pages of 500, `session.cancel`, `session.archive` on a failed open), `file_changes.rs` (a
  standard diff only for a proved complete new-file write, otherwise labelled text; Node's `path.posix` and `path.win32` for the root),
  `modes.rs` and `text.rs` (modes, English and German texts).
- *Proof:* mode W over stdio, `scripts/parity/export-acp.ts` (ten files under `fixtures/parity/acp/`, 6.4 MiB in all, none over 1 MiB; `--check`
  and a stale guard in `parity.test.ts`): the exporter drives TypeScript's `AcpServer` over its own streams with a scripted input and a
  scripted backend or a scripted Core, and records every frame in both directions, the log lines, the calls on the backend or the Core
  and the order of all of them; 411 scenarios, replayed byte for byte by `acp/vectors.rs`. Framing and hostile input (64 scenarios):
  line bounds at 64 bytes and at 1 MiB, half frames, a missing final newline, invalid UTF-8, invalid JSON in every common shape, JSON
  that is no object, ids and methods of every type, answers to requests never made, floods, 500,000 levels of nesting, 3,000 members.
  Protocol (78), size limits (2), permissions (65), Core backend, relay and session limit (168), file changes (34 across four files). Rust-only
  tests in `acp/tests.rs`: oversized permission message, the issued-id rule, a root that is not a string, the 2 MiB result bound, 300
  random hostile byte streams that must neither panic nor hang. Mutations: see the K8 ledger.
- *Deliberately not ported:* `main.ts` (process wiring: argv, environment, stdio streams, signals), the real-Core test that needs a
  running Core (`real-core-coding`), the TypeScript coverage fillers. A real input adapter (reader thread and channel into `InputPort`)
  and the real `RpcCaller` over `crate::sessions` and `crate::approvals` are the flip's work.
- *Known differences* (K8-D1 to K8-D5, none a security finding, every one fails closed or only differs in a spelling): **K8-D1** a lone
  surrogate escape in a JSON string reads as U+FFFD (a Rust `String` cannot hold it), so an id that carries one is echoed with the
  replacement character. **K8-D2** requests that arrive together in one chunk are answered in arrival order; TypeScript's microtask
  ticks can swap two replies whose handlers differ in depth, which the scenarios avoid by spacing them. **K8-D3** a failing write to the
  output sets the lost-reader state at once (TypeScript logs `output-error` and keeps trying until the stream's own event arrives).
  **K8-D4** a Core that answers `session.create` with a session id that is not a string is an internal error here (TypeScript echoes
  the value). **K8-D5** a message deeper than 2,000 levels cannot be encoded and is dropped with `output-error` (only a hostile
  backend can build one; input of any depth is read).
  **K8-D6 (K8-R1)**: one connection admits at most 128 requests awaiting completion by default, configurable through the library.
  Replies to permission questions and cancellation notifications are handled outside that request count. Excess requests receive
  `pending-limit`. The line reader hands off each frame before allocating the next.
- *Ports for the flip:* a session and approval caller (`RpcCaller`: `session.*`, `code.*`, `approval.*`), the clock and id source of
  `budget` (`Clock`, `IdSource`), the file-change source (events from `session.events`; the library never touches the editor's files),
  the sleeper between two event polls, the input port, and the writer.


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

**K9a as built** (prompt builder, decision service, triage; `crates/plur1bus-core/src/{prompt,decision,triage}/`, one `pub mod` line
each in `lib.rs`, plus `js/slice.rs` for UTF-16 cuts; no RPC method, nothing wired into the front door, `native*.rs`, the relay, the
dispatcher or the supervisor). The tool-call runtime is K9b.

- *Ported, the prompt builder:* `canonical.rs` (`normalizeText`, `canonicalJson`, `sha256Hex`), `model_table.rs` (the builder's view
  of the cache-profile table through `plur1bus-tokens`, which already holds it, and `chooseCacheTtl`), `join.rs` (the harness join under
  a cap), `builder.rs` (the five zones in order, breakpoints from the model table with the drop order and the interior breakpoint,
  zone and cumulative prefix hashes, the prefix registry per agent and model, the TTL prediction, the frozen-memory clip on a line
  boundary or before a surrogate pair), `session.rs`, `skills.rs` (the skill catalogue and the tool-use instructions), `telemetry.rs`
  (hit and miss records with the cause of a miss, the 1024-session bound). The builder does no I/O; the request clock is a port.
- *Ported, the decision service:* `client.rs` (input bounds, backend order and admission, the privacy rules before any content leaves
  the client, one deadline, the confidence floor, normalisation of an answer, bounded aggregates), `skills.rs` (the rule shortlist,
  the decision-refined selection, `skill-context`: the enriched query, follow-ups and fair slots), `adapters.rs` (the three-way pruning
  verdict, forced local, and the tree chooser), `role.rs` (the decision role through the router), `system_one.rs` (the System One
  transport). The model call is a port; no provider crate and no HTTP client is linked.
- *Ported, triage:* `classes.rs` (classes and the profile table, the defaults file read at build time), `mod.rs` (`chooseClass` at its
  three thresholds with the 1e-10 slack and the confidence bump, `escalate`, `triage()` over a classifier's JSON answer checked
  member by member), `rules.rs` (the rule classifier with JavaScript's regular-expression semantics written out over UTF-16 units),
  `runtime.rs` (one decision per message and scope, task boundaries, the rule fallback, the 1024-scope bound), `message_eval.rs`.
- *Proof:* mode V from `export-prompt.ts` (213 renders and 24 refusals over 164 scenarios, 150 session operations, 166 telemetry
  operations, 248 joins, 308 table lookups, 594 TTL choices; every rendered prompt as the digest of `JSON.stringify(result)`, member
  order included), `export-triage.ts` (1224 `chooseClass` cases with each threshold at its boundary, 1416 rule decisions, 375
  `triage()` cases, 39 runtime steps, 13 evaluation sets) and `export-decision.ts` (242 client calls, 24 skill selections, 4 pruning
  batches, 29 tree queries, 29 role calls with the chat request byte for byte, 121 System One cases with every port call in order);
  `--check` and stale guards in `parity.test.ts`. The exporter scenarios take their cases from the TypeScript tests (the prompt
  corpus, breakpoints, clipping, prefix stability, the three-way pruning verdict, the tree chooser at its thresholds and deadlines);
  `prompt/tests.rs` ports `no-io`, the pinned `b6-determinism` hashes, zone and tool order and the interior breakpoint.
- *Deliberately not ported:* `decision/rpc` and the other RPC files (the flip), the decision receipts of D133 (K11), the dispatcher and
  the turn loop (P4-43), reading the class profile file (an argument here) and the classifier timer (a port).
- *Known differences:* **K9a-D1**: where a TypeScript slice leaves half a surrogate pair (a skill description, a query, a task, a node
  name), Rust carries U+FFFD in its place; the length in code units is the same and the vectors carry `divergence: K9a-D1`.
  **K9a-D2**: when no stream of the router finishes, TypeScript's role backend passes on a `modelRevision` the model wrote into its own
  answer; Rust removes the member (the revision comes from the router only), the vector carries `divergence: K9a-D2`. An answer that is
  JSON text `serde_json` cannot hold (a lone surrogate escape, nesting deeper than 128) counts as invalid here. The backend port is
  synchronous: a backend keeps the deadline it is handed and answers `Interrupted`, where TypeScript races it against a timer.
  **K9a-D3**: a configuration member whose `Number()` throws in TypeScript (an object with its own `toString`, `decision/client.ts`
  `#run`) makes the request reject there; the port has no error path at that point and counts the value as `NaN`, so the request
  fails as `invalid` and never runs (`decision/client.rs` `js_number`).
- *Ports for the flip:* `provider_auth::ports::Clock` (the builder's request clock), `decision::types::{DecisionBackend, DecisionConfig,
  Cancel}`, `decision::role::RoleRouter`, `decision::system_one::{Budget, Secrets, Http}`, `decision::skills::Chooser`, the triage
  runtime's clock, id source and classifier.

**K9b as built** (the tool-call runtime and the capability store; `crates/plur1bus-core/src/toolcall/`, one `pub mod toolcall;` in
`lib.rs`; no RPC method, nothing wired into the front door, `native*.rs`, the relay, the dispatcher or the supervisor). The prompt
builder, the decision service and triage are K9a.

- *Ported, the runtime:* `json.rs` (`JSON.parse` and `JSON.stringify` over UTF-16 strings and ordered objects: the last of two equal
  keys wins, doubles, lone surrogates, index keys first; a document deeper than 512 levels is checked for syntax but not built),
  `quirks.rs`, `validation.rs` (the schema vocabulary, the validator with TypeScript's issue texts, the three repairs a family's quirks
  allow, the one model repair round; `pattern` is an ECMAScript regular expression with `u`, through `regress`), `dialects.rs` (the wire
  schema per provider family, strict mode and its way back), `results.rs` (the byte budget, error envelopes, idempotency keys,
  batches), `tool_use.rs` (whether a turn needs a tool, the tool choice of one attempt), `tables.rs` with `first_party_table.rs`
  (generated from the vector by `scripts/parity/toolcall-first-party.mjs`; `parity.test.ts` checks every row), `skill_tools.rs`
  (`skill.load`/`skill.read`: admitted names, plain relative paths, every component checked for symlinks and its canonical spelling at
  use time, credential-style files neither listed nor read, 64 KiB, `O_NOFOLLOW | O_NONBLOCK` on Unix), `model_tool_error.rs` (the
  failed envelope the model sees: the log redactor, then the home step, fixed sentences for internal failures, the first line of an
  exception, 4096 characters).
- *Ported, the capability store:* `capabilities.rs` (the index, its BM25 ranking with embedding, lexical and prior ports, routing with
  the remembered answer of one revision, the usage prior and the calibration file), `math.rs` (fdlibm's `log` and the `2 ** x` the
  decay uses, bit for bit), `registry.rs` (`state/capabilities.sqlite`: the five tables and the full-text index created in place, no
  version, WAL, the schema text TypeScript's), `live_index.rs` (`toolEntry`; the per-turn view over admitted tools and skills, blocked
  and not-granted skills left out, priors per agent until a version changes or the recheck, local vectors stored for an entry's current
  text and cosine scores).
- *Proof:* mode V, every file under 1 MiB: `export-toolcall.ts` (`fixtures/parity/toolcall/`: json, arguments with a seeded hostile corpus of
  2000 documents, validation, dialects, tables, results, tool-use, stable-tools), `export-capabilities.ts` (`fixtures/parity/capabilities/`:
  math, calibration, index, registry), `export-skill-tools.ts` (file trees built in a temporary home; the symlink and FIFO scenarios run
  on Unix, the exporter records only where both exist), `export-live-index.ts` (tool entries and four scenarios over a real registry
  file; the ports' answers recorded, the embedder double checks the texts Rust embeds), `export-model-tool-error.ts` (766 envelopes:
  homes on three platforms, typed and internal failures, odd field types, the bounds; secret material in pieces). Mode B:
  `tests/core-parity/toolcall-b-driver.ts` + `crates/plur1bus-core/tests/toolcall_mode_b.rs` (the registry file both ways with
  TypeScript's product code, the schema text equal). Each class of JavaScript semantics the runtime leans on has its cases: `Number()`
  of numeric strings, `String()` of arrays and objects in a test, truthiness, `trim` (U+FEFF yes, U+0085 no), `.`/`\s`/`\w` in patterns,
  case folding with and without `u`, `isDeepStrictEqual` for `enum`/`const`/`uniqueItems`.
- *Test files and their mode:* `arguments`, `arguments-fuzz`, `edge`, `reliability`, `dialects`, `results`, `tool-use`, `stable-tools`,
  `first-party-metadata` (the table half), `capabilities`, `skill-tools`, `model-tool-error`, `model-tool-error-cache` (Rust test of the
  matcher cache), `model-tool-error-fs` (the envelope half; the composed file tools are K10's) V; `sqlite` V + B; `live-index` V (the
  turn composition and Doctor halves at the flip); `skill-catalogue` is the prompt's catalogue over the live index (K9a with this
  index); `shipped-models` checks `config/shipped-models.ts` against the host-eval release gate (evaluation tooling): stays TypeScript.
- *Deliberately not ported:* `coding-bench-*`, `turn-eval*`, `host-eval*`, `eval.ts` (benchmark and evaluation tooling);
  `extension-feed.ts` (the supervisor client; the index takes an `ExtensionFeed` port); `watchSkills` (an `fs.watch` debounce) and the
  recheck's system-job wiring (`job()`; its argument check is `validate_recheck_args`); the file half of `refreshSkills` (`index.json`,
  `SKILL.md`, front matter through the importer's `yaml-lite`, the author's description through `prompt/skills.ts`): a `SkillSource`
  port until the importer is ported.
- *Known differences:* **K9b-D1** (TypeScript `Math.log` on arm64 Node is fdlibm compiled with fused multiply-add and differs in the last
  place for a few arguments in a hundred; Rust computes the unfused routine everywhere, so the last digit of a score can differ from
  TypeScript on Apple Silicon; the vectors' scenarios are chosen so that it does not). `regress` folds U+017F and U+212A into `s` and `k`
  under `i` without `u`, which JavaScript does not: the runtime's patterns without `u` spell their case out instead of using the engine's
  `i` (and `\b` of the `/iu` patterns is spelled out over JavaScript's word characters). On Windows `skill.read` does not compare the
  opened handle's volume and index with the path (stable Rust does not expose them); the path is re-checked before and after the read.
  A failing registry inside the lexical port gives no lexical score instead of an exception. A thrown `TypeError` is compared by name.
- *Ports for the flip:* the model repair port, the secret matcher, the full-result store and the idempotency store of `results`, the
  clock (`budget::Clock`), `EmbeddingPort`, `LexicalPort` and `PriorPort` of the index, `LocalEmbedding`, `SkillSource`,
  `ExtensionFeed` and `CalibrationSource` of the live index, `skill_tools::Cancelled`, and the process's home directory and its
  resolved spelling (`ModelToolErrors::new`).


## 11. K10: typestate gate, exec, fs, host tools (D120 §11.2, P4-30 without web, P4-31)

Sources: `tools/exec/`: args(60) env(46) index(6) node-process(64) run(236) tool(55) types(121)<br>`tools/fs/`: failure(53) index(3) ops(337) tools(141)<br>`host-tools/`: apps(245) catalog(47) classify(14) clipboard(79) context(94) denylist(132) errors(42) exec(161) index(10) notify(41) pkg(200) proc(279) remaining(67) sys(166) types(134)<br>`packages/hostctl/src/`: atomic(52) command(129) config(18) errors(17) files(140) index(127) native(27) pool(15) processes(102) search(28)

Tests: `tools/exec/`: exec real replay<br>`tools/fs/`: fs<br>`host-tools/`: apps audit-b07 catalog clipboard-notify conformance denylist errors exec-descendants pkg proc remaining smoke sys<br>`packages/hostctl/test/`: atomic-publish-races atomic.coverage config errors.coverage files.coverage hardening-gap-apps hardening-gap-processes hardening-hostctl hostctl index.coverage listing-concurrency native.coverage native policy pool.coverage processes.coverage search-batch search-cost search.coverage trash-smoke

| Tests | Mode | Note |
|---|---|---|
| `exec/exec`, `real`, `replay`; `fs/fs` | V (argv and environment filters, classes, deny lists) + a `compile_fail` doctest | no executor without `ApprovedAction` |
| `host-tools/*` | V for classes and deny lists, no mode for tests that start real apps or processes (`smoke`, `proc`, `apps`) | reason: depends on the host machine |
| `hostctl/*` | V (policy, config, search batching), no mode for races and trash on a real file system | covered by Rust-side tests |

Stores: none. Ports: process spawner, file system, clock, audit sink, host notifier and clipboard (platform).

**K10a as built** (`crates/plur1bus-tools/src/{gate,exec,fs}/`, three `pub mod` lines in `lib.rs`; `crates/plur1bus-core/src/policy/fs_paths.rs`
and `fs_windows.rs` for the rulings R-K-11 and R-K-12; no RPC method, nothing wired: `server.rs` and `main.rs` of the tools service are
unchanged). K10b (host tools, `hostctl`) is the next run; the gate needs no change for it.

- *Ported, the gate (D120 §11.2, T1-b):* `UnverifiedAction` → `Gate::verify` → `ApprovedAction`. An `Executor` takes an `ApprovedAction` by
  value. The type has no public field, no constructor outside `gate` and no `Clone`, `Default`, `Deserialize` or `From`; it is bound to
  the verified action (tool, the arguments through the dispatcher's action hash of `plur1bus-canon`, targets, hash extra, principal,
  agent, session) and to a lifetime (30 s, the lifetime §11.2 gives a ticket), and `redeem` consumes it against what the executor is
  about to do, computed again at that moment. `verify` is step 2 of `ToolDispatcher.call` in its order: the tool's classifier (inside
  the gate, never on the caller's side), the action hash, `policy::decide` with the headless rule over the real `GrantSource`, the
  `policy.decision` line (hard: a private proof type is needed to mint an `ApprovedAction`, and only the recorded line gives one), then
  the approval port (`request`, `begin`) or the use of the grant (`consumeOnce`, `markUsed`), with the dispatcher's refusal texts. The
  MAC ticket of §11.2 is not built: the decision is made in this process now, so the value that crosses is the type (§11.2, last
  bullet). `plur1bus-tools` depends on `plur1bus-core` for this (no cycle: the core does not depend on the tools crate).
  What the type proves (review D, RD-4): that the call went through `Gate::verify` with the ports that gate was built with.
  `Gate::new` takes any implementation, so that they are the production ones is the flip's to ensure; the doubles of the gate
  and of the process port are compiled for the crate's own tests only (a `compile_fail` doctest holds it). `Executor` cannot
  force an executor to redeem; the two executors do, and their tests show it.
- *Ported, `exec.run`* (`exec/`): program and argument validation (`args.rs`), the child's environment from an allowlist of names with
  the secret-looking names never inherited (`env.rs`), the tiers (`deny` is the default), the working directory through
  `canonicalise_path`, the allowlist, the audit line `exec.run` before the spawn (`audit::recorded_then`) and `exec.result` after it, the
  timeout, cancellation, the bounded capture with secret masking (`capture.rs`: `tools/sandbox/capture.ts`), and the process port with a
  real implementation (`process.rs`: no shell, a cleared environment, the child in its own process group and the group killed with
  `SIGKILL` through `rustix`; `taskkill /T /F` on Windows) and a scripted double. `ExecClassifier` is `classifyExecRun` of the
  composition.
- *Ported, the file tools* (`fs/`): `file.stat`, `file.list`, `file.read`, `file.write` as one executor, with the limits, the order and
  the failure texts of `ops.ts` and `failure.ts`; `FsClassifier` is the `classify` the composition gives the four tools.
- *R-K-11* (`fs_paths.rs`): `open_verified` opens the checked parent directory first (`O_DIRECTORY | O_NOFOLLOW`), compares the
  identity of that descriptor, and opens the leaf relative to it (`openat`, `O_NOFOLLOW`, `O_CREAT | O_EXCL` for a create), through
  `rustix`. K2-D7 and the parent swap of K2-D5 are prevented, not only detected; the checks after the open stay as the second line.
  `PathFs` has no open by path any more; it has `open_dir`, `dir_stat`, `open_at`, `rename_at`, `link_at`, `unlink_at`, `read_dir_at`
  and `entry_at`. `open_verified_in` hands back the open parent, and `stat_verified` reads an entry through it without opening the
  entry. From the K2 review: the identity of a path is read with `lstat` at the real path (a link there is `link-swap`; V-1), and a
  directory entry whose name is not Unicode makes a deny-list scan incomplete instead of being skipped (V-2).
- *R-K-12* (`fs_windows.rs`): `RealFs` on Windows reads the volume serial number, the file index and the link count with `winapi-util`
  (what Node reports as `dev`, `ino` and `nlink`), reports every reparse point as a link and never follows one where unix sets
  `O_NOFOLLOW`, and holds the parent open without delete sharing while it opens the leaf by path below it (there is no `openat`). **It
  was written on macOS and never ran before the CI**: type-checked for `x86_64-pc-windows-msvc` in a scratch crate, proven only by the
  `cfg(windows)` tests of `fs_tests.rs`. A file index of 0 is still `no-identity`.
- *Proof:* mode V from `scripts/parity/export-tools.ts` (`fixtures/parity/tools/`, four files, about 310 KiB): the pure rules of `exec` and
  the texts of the file tools, replayed on every system; 63 runs of `createExecTool(...).execute` and 11 cases of the file tools
  recorded on darwin against real directories and files, replayed on every unix system (on Windows no run and no case is played:
  the recorded roots are POSIX paths). Nine `compile_fail` doctests for the gate, each with its error code and beside the
  code that compiles (rustdoc compares the code on a nightly toolchain only; runs with `RUSTC_BOOTSTRAP=1` did). Rust tests: the
  gate (11), `exec` against real processes with this test binary as the child (11), the file tools with their real classifier in
  front (7), the path layer (10 more than before). `plur1bus-core` has 885 lib tests (875 before), the lib of `plur1bus-tools` 47 (9
  before). 78 mutations at the load-bearing checks, 75 killed and 3 equivalent (the K10a ledger names each).
- *Test files and their mode:* `tools/exec/exec`, `replay` V and Rust tests (the policy, approval and one-time-grant cases of both are
  the gate's tests, see below); `tools/exec/real` Rust tests (`exec/tests.rs`); `tools/fs/fs` V and Rust tests;
  `host-tools/exec-descendants` is K10b's.
- *Deliberately not ported:* `execRun`'s own decision path (`decide`, the approval port and `consumeOnce` inside the tool, and the
  `shellAllowlisted` flag only that path sets): the gate is the one place that decides, and an executor cannot be called without an
  approved action. The wrapping of child output into log records (`deps.output`, three tests) and `FS_CAPABILITIES` (the capability
  index rows) belong to the flip and to the tool-call index. An abort while a person is asked is the caller's. The dispatcher's
  argument validation, repair round, sandbox precondition, result limits and redaction, taint and the outcome line of an executed
  call are P4-43.
- *Deliberately different from TypeScript* (TypeScript is frozen, D129; numbers in K12, R-K-6):
  **K10-D1**: the temporary file of `file.write` is created with mode `0600`; TypeScript creates it with the umask's default and
  narrows it afterwards. **K10-D2**: after a write whose parent directory was swapped, TypeScript removes its temporary file by path
  and so leaves it behind; Rust removes it through the directory's descriptor (the case `races` carries `divergence`).
  **K10-D4**: `file.stat` and `file.list` read through descriptors; TypeScript calls `stat` and `opendir` on the canonical path.
  Rust refuses symbolic-link metadata for the checked leaf even when the reported device and inode match.
  **K10-D5**: the file tools redeem the approved action against the target as it resolves at execution time (`changed` when it
  differs); TypeScript compares only for `exec.run`. **K10-D6**: the argument pattern of an allowlist entry is accepted in a subset
  of JavaScript's dialect in which the `regex` crate means the same (with `.`, `\d` and `\w` translated); any other pattern allows
  nothing, as an unreadable one does in TypeScript (the vectors mark the subset). An escaped `-` is accepted inside a class
  only: with the `u` flag JavaScript refuses it outside one, and a first version of the translator read it as a literal there
  (it allowed what TypeScript refuses; **K10-D8**, closed with vectors). **K10-D7**: `serde_json` holds an object sorted, so
  of two requested environment names that differ only in case (Windows), of several requested names that are refused (the first
  one refused is named) and of several unknown arguments, the one that counts or is named can differ. A FIFO is `not-a-file` as in TypeScript but is never opened (K2-D6).
  **K10-D10** (review D, RD-1): `open_verified` opens a target that did not exist when it was checked only to create it; any other
  open of it is `not-found` before anything is opened, because there is no checked identity to compare an opened file with.
  TypeScript opens it and compares nothing. A file the open created is held to its path on every system that can name the path of
  an open file (Linux `/proc/self/fd`, macOS `F_GETPATH`), not only on Linux.
  **K10-D11** (review D, RD-4): the gate refuses a call whose merged policy context names another person (`principal.person`),
  agent (`subject.agentId`) or session than the caller the approved action is bound to (`policy-never`, rule
  `context-mismatch`); the dispatcher merges its `policyContext` hook over the base unchecked.
- *Same as TypeScript, noted:* **K10-D3**: when the `exec.result` line cannot be written after the program ran, the call fails with
  `spawn-failed` and the text "nothing was run". Spawn failures are worded like Node's (`spawn git ENOENT`).
- *Ports for the flip:* gate `Permissions` (grants, their use, approvals: `ApprovalService` over `approvals.sqlite` behind it, with
  the wait for a person), `Classifier`, the policy audit (`approvals::AuditPort`), `Clock`; `exec` `ProcessPort`, `AuditSink`, the
  inherited environment, the cancellation function, `KnownSecrets`; the file tools `PathFs` (with a `File` as the handle), `Random`
  for the name of the temporary file, the cancellation function, `KnownSecrets`. The sandboxing process port of the composition
  (`createSandboxProcessPort`) and the invocation-only root for an approved working directory outside the roots are the flip's.
- *Open after R-K-11:* a checked directory that is moved keeps its identity, so a leaf can be opened or created in it at its new place
  before the parent check after the open refuses the call (nothing is written or truncated by then); identities rest on device, inode
  and birth time, so without a birth time a recycled inode number compares equal; `exec.run` hands the working directory to the
  child by path. A resolution that walks every component by descriptor (`openat2` with `RESOLVE_BENEATH` on Linux, `O_NOFOLLOW_ANY` on
  macOS) is not built: it replaces the `realpath`-based algorithm the 61 vectors hold. Because the identity of a target is still
  read by path (review of K2, V-1), `open_parent` also asks where the open directory is (`PathFs::dir_path`: `/proc/self/fd` on
  Linux, `F_GETPATH` on macOS, the firmlinked form accepted) and uses it only at the checked path (scripted double test). On
  Windows and on a Linux without `/proc` the path of the directory is not read; the checks by path remain the guard there.
- *Open after review D (not changed, for the owner or the flip):* a read through a hard link stays allowed when no deny list is in
  force (as in TypeScript; with a deny list the link count refuses it): whether that is wanted is a question for the owner. The
  blocklist of programs in `exec.run` (shells, privilege escalation) is a second layer only and is as easy to pass as in TypeScript
  (through a program that starts another, or through other spellings of a name on Windows); the tiers `ask` and `allowlist` are the
  guard. **K10-D12** (candidate): name the blocklist a hint in the documentation and the approval text, and on Windows compare
  program names in a normalised form (long name, no stream suffix). `exec.run` hands the working directory to the child by path
  (see above); a proposal is a start helper that changes into the directory from a descriptor, or `fchdir` before `exec` in a
  pre-exec hook (which needs `unsafe`, not allowed in this crate). Two findings in the TypeScript code (frozen, D129) are open:
  `openVerified` has the gap K10-D10 closes on the Rust side and passes `O_TRUNC` to `open` before its checks (TS-1), and on
  Windows Node may find a bare program name in the child's working directory first (TS-2, presumed, only Windows can show it).
  The grant store's home comparison on Windows (RD-3) and the Windows adapter are proven by the CI only.


## 12. K11: decision receipts (P4-45, D0 to D4 as a library)

Source is the owner decision D133 and its rulings 1 to 11 (project doc, in the repo `docs/decision-service.md` only for the older decision service);
there is no TypeScript implementation to port. Proof: the marker test "no content in a receipt", same receipts give the same report. New store,
new schema version 1; the helper needs no change (the store is created by Rust, TypeScript never reads it).

**K11 as built** (`crates/plur1bus-core/src/decision/receipts/`, a submodule of `decision/`, no new `pub mod` in `lib.rs`; spec
`docs/superpowers/specs/2026-11-18-decision-receipts-design.md`; no RPC method, no CLI, no change to `rpc.schema.json` or
`config.schema.json`, no new error code, nothing wired into the turn path).
- *Built:* the format `plur1bus.decisionreceipt/1` (identifiers, hashes, classes, counters and times only; `capture` reads the ids of
  the options and nothing else of a decision input); `decision-receipts.sqlite` (`user_version` 2 through `plur1bus_store`, one writer,
  one receipt per turn and use case, an incognito session writes nothing, a newer schema is refused and the file untouched);
  `record_outcome` for the follow-up fields, once per receipt; retention (30 days, upper limit a parameter with default 20,000, the
  oldest first, `prune` called by a host, the clock a port); the rights of rulings 10 and 11 (`rights`); replay through
  `DecisionClient` with a gate port (jev opt-in, only local models, egress, budget) and a case-text port, a deterministic report that
  keeps fallback cases and failed cases apart and holds no text; adoption of a baseline as a new version of the calibration record
  through the port `CalibrationRecords`. **K11-R1:** audit and a durable pending adoption precede the calibration append.
  The host opens with that same calibration port so an absent version is discarded and an exact written version is completed.
  A conflicting version is refused. Version 1 adoptions migrate as completed records.
- *Proof:* no vectors (there is no TypeScript); the marker test (no marker in the store file, its WAL, any error or `Debug` text, the
  report), same receipts same report (repeated, and written and asked in another order), one test per role and kind for each of the
  three actions, both retention limits at their boundaries, the interrupted adoption, and 31 mutations (ledger of K11).
- *Deliberately not ported / not built:* the capture point in the turn path and the dispatcher (the host calls `capture`, `write` and
  `record_outcome`), RPC, CLI, configuration keys, the web view, the use of receipts by `turn-eval` and the learn pass.
- *Known differences:* none (nothing to differ from). The golden test of D2 compares the receipt with the registry counters after the
  same events were recorded into `SqliteCapabilityRegistry`; the dispatcher that records them in a turn is not wired.
- *Ports for the flip:* the wall clock and id source (`budget`), the audit sink (`rbac::audit::AuditSink`), `ReplayGate` (the four
  rules of the live path), `CaseSource` (message text with the rights of the session store), `CalibrationRecords` (the versioned record
  of ADR-015; the Rust core holds none yet, `MemoryCalibrationRecords` is the double).


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
  K3b does it for the three small stores (`k3b-b-driver.ts`: the real `ChannelHandoff`, `DeliveryTargets` and `InboxStore` write the files, and
  an empty one of each is the reference for the schema text); the hand-off driver carries a small copy of the scripted session store of `export-handoff.ts`.
- **Two writers.** The helper is single-process; `BEGIN IMMEDIATE` interleaving is tested only inside Rust.
- **Compare the schema text.** The session driver compares `sqlite_master` of a Rust-migrated file with the TypeScript one; any new driver
  should do the same for stores the Rust core will own.
- **Rust-side migration entry** exists (`Store::open_owner` with `Schema::Steps`); the TypeScript text must be copied byte for byte into Rust.
