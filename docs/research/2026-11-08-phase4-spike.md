# Phase 4 spike (P4-01): Rust core dependencies, store compatibility, validation cost

Task P4-01 of package P4-A. Plan: `phase4-ts-core-to-rust/plan-2026-11-07.md` (§2.3, §3 P4-01, §5.4, §7 R3/R8). Owner decisions D129/D131.
Measurements were taken on 2026-11-07 on one machine (Apple M5 Pro, macOS 27.2, rustc/cargo 1.95.0 from `rust-toolchain.toml`,
Node 26.12.1) from `origin/main` at 705926d96a, in a throwaway worktree that is not pushed. No production code was added.
Only cargo downloaded crates and registry index data. cargo-deny used the local advisory database dated 2026-11-06.

## 0. Summary

| Question | Result |
|---|---|
| SQLite store compatibility (R3) | **Compatible. No stop condition.** Same files, both directions, WAL, FTS5 (external-content, `bm25`, `snippet`), `user_version`, JSON functions: all query results identical. Three build-level differences must be neutralised in `plur1bus-store`: foreign keys default **on** in `rusqlite` bundled (off in Node), math functions absent in bundled, `sqlite_version` 3.53.2 vs 3.54.1. |
| Skeleton core (tokio, Unix socket, NDJSON echo, `jsonschema`) | 12 s cold release build, 4.67 MB stripped, 9.0 ms median cold start to first answered request, 21 MiB idle RSS. Not a risk. |
| Result validation (`jsonschema`) | About 1 µs per validation of the ten largest results. **But** compiling a validator against the whole 569 KB schema costs 5 to 10 ms each (4.3 s for all 854 params and result validators). Pruning to the reachable `$defs` brings that to 0.03 ms each (26 ms total). P4-03 must generate or build pruned roots. |
| Crates | `axum`/`hyper`: ok. `nostr`: ok. `keyring`: ok with a Linux decision (3.6.3 pinned). `rmcp`: ok with exceptions (pin 3.7.0; HTTP client brings a second HTTP stack and, by default, a second TLS provider). `matrix-sdk-crypto`: ok with exceptions (MPL-2.0 x6, toolchain 1.96, two-week window for a security fix). SSE: ok on the existing `ureq`; `reqwest` also works but is a second HTTP stack. |
| Re-estimate | Unchanged within noise (A 203 to about 202; B 162 to about 161). R3 and R8 drop from open risks to named conditions. Details in §6. |

## 1. Skeleton core binary

Throwaway crate, own workspace: `tokio` (rt-multi-thread, net, io-util, macros), `serde_json`, `jsonschema 0.26.2` with default features off (the engine's setting). One Unix-socket listener, NDJSON lines `{id, method, params}`, params validated against one compiled schema (object, two required fields, `additionalProperties: false`), reply `result` or `E_INVALID_PARAMS`. On Windows the same code uses a tokio named pipe.

Release profile: `opt-level=3`, `lto="thin"`, `codegen-units=1`, `strip=true`. 15 runs, each a fresh process, one valid and one invalid request.

| Metric (macOS arm64, M5 Pro) | Value |
|---|---|
| Release build, cold target dir, deps included | 12.1 s wall (7.5 s user) |
| Binary size, stripped | 4,665,280 bytes (4.45 MiB). A bare tokio TCP binary is 512,192 B; a hello-world is 339,008 B. `jsonschema` with its url/idna/ICU/regex closure is about 4 MB of this. |
| Cold start: spawn to first answered request (connect, request, reply) | min 8.1 ms, median 9.0 ms, max 14.4 ms |
| Idle RSS, 1 s after start, one connection open, schema compiled | 20.9 to 21.1 MiB |
| `cargo deny check` | clean (advisories, bans, licences, sources) |
| `cargo check --release` for x86_64 and aarch64 Linux, x86_64 and aarch64 Windows (compile only, about 3.6 s each) | passes, including the named-pipe branch |

The 21 MiB idle RSS is a floor for the core: the real core adds the method table, stores and the engine client. It is far below the Node core.

### Other release targets (not measured; no CI was triggered)

The release workflow `harness-release.yml` already builds `plur1bus` and `plur1bus-tools` for five targets: linux-x64 and linux-arm64 with `cargo zigbuild ... --target <triple>.2.28` (glibc 2.28), darwin-arm64 on `macos-15`, win-x64 on `windows-2025`, win-arm64 on `windows-11-arm`. `plur1bus-core` joins that matrix as a third `-p`. What CI needs beyond that:

- Linux: no new system packages for the skeleton or for `rusqlite` bundled (needs only a C compiler, which zigbuild provides). A Linux keychain backend is the exception (§2, `keyring`).
- Windows: `rusqlite` bundled and `aws-lc-sys` (if `rmcp`'s default TLS is kept) need MSVC; `aws-lc-sys` additionally needs a C toolchain and, depending on the target, extra assembler tooling. Choosing the `ring` provider avoids this (§2, `rmcp`).
- Build time estimate: the skeleton took 12 s on this machine. GitHub-hosted runners have 4 vCPU (3 on `macos-15`), so expect 3 to 5 times that for the same crate graph: 40 to 60 s for the skeleton, and for the real core (adds `rusqlite` bundled, `rmcp`, matrix crypto, the other crates) 4 to 8 minutes cold, 1 to 2 minutes warm with `rust-cache`. `win-arm64` and `darwin-arm64` are the slowest legs.
- Binary size on the other targets will be within about 15 percent of macOS arm64; Windows binaries are typically a little larger. A size budget for the real core is not meaningful yet: expect 15 to 25 MB stripped once `rmcp` + TLS, matrix crypto, rusqlite (about 1.9 MB) and the providers are in.

## 2. Crate candidates

Method: each candidate in its own standalone throwaway workspace with the repository's `deny.toml` (licence allow-list, `unknown-git = deny`, `all-features`), `cargo deny check` against the local advisory database, then `cargo build --release` of a probe that really links the API (guarded by a runtime condition so the code is not stripped). Versions are pinned with `=`. "Release age" is the crates.io `pubtime` of the pinned version on 2026-11-07 against the two-week rule (published on or before 2026-10-24). The size delta is the stripped probe binary against a baseline of the same dependency family (tokio probe 512,192 B or hello-world 339,008 B).

A general note on the two-week rule. A fresh `cargo generate-lockfile` picks the newest compatible transitive versions, and many of those are younger than 14 days today (for example `smallvec 1.16.5`, `uuid 1.29.1`, `cc 1.11.1`, `winnow 1.0.5`, `toml_edit 0.25.19`, `rmcp-macros 3.9.0`). The rule can only be met for transitives by pinning in `Cargo.lock` (`cargo update -p <crate> --precise <version>`) when the crates are first added, or by taking the closure the repository's existing lockfile already has. `log 0.4.35`, `hyper 1.12.0`, `reqwest 0.12.28`, `rustls 0.23.46`, `tokio 1.53.3`, `ureq 3.4.2` are already locked. This is a procedure item for P4-03/P4-20 and not a blocker.

| Crate | Pinned version | Licence | Release age on 2026-11-07 | `cargo deny` | Size delta | Verdict |
|---|---|---|---|---|---|---|
| `axum` (API) with `hyper` | axum 0.8.9 (`http1`, `tokio`, `json`, `ws`, `query`), hyper 1.12.0 | MIT, MIT | axum 207 d, hyper 32 d | clean | +562,112 B vs tokio baseline | **ok** |
| `rmcp` (official MCP SDK) | 3.7.0 | Apache-2.0 | 16 d (3.8.0 is 12 d and 3.9.0 is 2 d: too young today) | clean | stdio + server: +1.47 MB; with HTTP client: +6.42 MB (aws-lc-rs default) or +4.53 MB (ring), see below | **ok with exception** |
| `keyring` | 3.6.3 (`apple-native`, `windows-native`, Linux see below) | MIT OR Apache-2.0 | 15 months | clean with `sync-secret-service`; **3 advisory failures** with any zbus route | +19,696 B vs hello (macOS backend) | **ok with exception** (Linux choice) |
| `matrix-sdk-crypto` | 0.19.1 (0.18.0 is vulnerable) | Apache-2.0 | 50 d | 6 licence rejections (MPL-2.0), 0 advisories | 0.18.0: +1.43 MB (default features off, memory store) | **ok with exceptions** |
| Nostr: `nostr` | 0.45.5 (`std`, `nip44`, `os-rng`) | MIT | 57 d (0.45.6 is 5 d, 0.45.7 is 2 d) | clean | +1.26 MB vs hello (includes secp256k1) | **ok** |
| SSE on `ureq` (existing policy) | ureq 3.4.2 (`rustls`, `platform-verifier`) | MIT OR Apache-2.0 | locked already | clean | +1.68 MB vs hello | **ok** (blocking thread per stream) |
| SSE on `reqwest` rustls | reqwest 0.12.28 (`rustls-tls`, `stream`, `json`, `http2`) | MIT OR Apache-2.0 | locked already | clean | +2.74 MB vs tokio baseline | **ok with exception** (second HTTP stack) |

### axum and hyper

`axum 0.8.9` pulls `hyper 1.12.0` (the version already in the lockfile). Licence MIT, no advisories, no native-tls, no openssl. Builds in 13 s. The core front door itself needs no HTTP (Unix socket and pipe); axum belongs to track I (Harness API), which may stay TypeScript for 0.1 (Q1). No exception needed.

### rmcp

3.7.0 requires Rust 1.88. Features probed: `server`, `client`, `macros`, `transport-io`, `transport-child-process`, `transport-streamable-http-server`, and for the HTTP client `transport-streamable-http-client-reqwest`.

- The `transport-streamable-http-client-reqwest` feature alone pulls `reqwest 0.13.5` **without TLS**: https would fail at runtime. Adding the `reqwest` feature switches TLS on, and reqwest 0.13's rustls default is **aws-lc-rs** (`aws-lc-sys 0.47.0`, a C/ASM build). That gives two reqwest versions in the workspace (0.12.28 via lance, 0.13.5 via rmcp), a second TLS provider next to `ring`, and 6.93 MB for the probe.
- The `reqwest-tls-no-provider` feature plus `rustls = { default-features = false, features = ["ring", "std", "tls12"] }` keeps `ring` as the only provider (`aws-lc-sys` absent from the lockfile), builds in 68 s cold, and gives 5.04 MB. The process must install the `ring` provider as the default at startup. `cargo deny` is clean in both variants.
- `rmcp` also pulls `schemars 1.2.3`; the workspace uses `schemars 0.8` (build-time `typify`). Two versions coexist; `bans.multiple-versions` is `warn`, so this is allowed.
- `native-tls` and `openssl-sys` are absent in every variant.
- Fallback if the exception is refused: use `rmcp` with its generic `transport-streamable-http-client` (no reqwest) and write the small `StreamableHttpClient` adapter over `ureq` on blocking threads (about 150 lines), the same shape as the SSE fallback below.
- Verdict: ok with exception (the exception is the second HTTP client version, an owner decision on the HTTP policy; recommended: take the `ring` variant). Pin `=3.7.0`, and pin its transitive `rmcp-macros` to 3.7.0 (the resolver otherwise picks 3.9.0, 2 days old). 3.8.0 passes the window on 2026-11-09.

### keyring

Two lines exist. `3.6.3` (July 2025, the last 3.x; `@napi-rs/keyring`, which the TypeScript backend uses today, wraps the same library line) and `4.2.0` (August 2026, rebuilt around `keyring-core` and separate store crates).

- 3.6.3 with `apple-native`, `windows-native`, `sync-secret-service`, `crypto-rust`: `cargo deny` clean, +19,696 B on macOS (the Security framework is linked from the OS). Cross-checks for Windows x64/arm64 pass (run with the zbus variant, which shares the Windows backend). On Linux, `sync-secret-service` links `libdbus-sys`, which needs `libdbus-1` through pkg-config: the cross-check from macOS fails exactly there ("pkg-config has not been configured to support cross-compilation"). The Linux release legs use `cargo zigbuild`, so the realistic options are the `vendored` feature (builds libdbus from source with `cc`; not testable on this machine, needs a CI trial) or `libdbus-1-dev` for the target in the runner image.
- 3.6.3 with `async-secret-service`+`tokio` (pure-Rust `zbus 4.4.0`), and 4.2.0 default (`zbus-secret-service-keyring-store`): compile cleanly for Linux and Windows but `cargo deny` reports three advisories: RUSTSEC-2026-0370 (`zvariant`), RUSTSEC-2026-0371 (`zbus_names`), RUSTSEC-2026-0372 (`zvariant_derive`), all "unmaintained", no patched version. They would need advisory exceptions (policy: per crate and range, expiry at most 90 days, no renewal).
- 4.2.0 is 70 days old and builds in 3 s, +74,720 B on macOS. Its other store crates (`apple-native-keyring-store 1.0.2`, `windows-native-keyring-store 1.1.0`, `keyring-core 1.0.1`) pass.
- Verdict: ok with exception. Recommended: `keyring =3.6.3` with `sync-secret-service` + `vendored` on Linux, to be trial-built in the first CI run of P4-20. If that fails, the zbus route with three time-boxed advisory exceptions. Hand-written fallback: macOS `security-framework`, Windows `CredRead/CredWrite`, and on Linux the encrypted file backend that already exists in `secrets/` (the keychain probe already degrades to "backend-unavailable" in the TypeScript code).

### matrix-sdk-crypto

- 0.18.0 builds (10 s warm, 114 s cold for the closure) but is **not acceptable**: RUSTSEC-2026-0318 (panic in `Device::encrypt_event_raw` / `OlmMachine::encrypt_content_for_devices` with `IdentityBasedStrategy`, patched in 0.19.0), RUSTSEC-2026-0451 (vodozemac 0.10.0 does not zeroize Olm ratchet keys, patched in vodozemac 0.11.2), RUSTSEC-2026-0292 (`imbl-sized-chunks 0.1.3` double free on panicking drop, patched 0.2.0), and two "unmaintained" notices (`bitmaps`, `proc-macro-error2`).
- 0.19.1 (published 2026-09-18) resolves with `vodozemac 0.11.2` and `imbl 7.0.2` / `imbl-sized-chunks 0.2.0`: **zero advisories**. Remaining blockers are procedural:
  1. It needs **Rust 1.96**; `rust-toolchain.toml` pins 1.95. The toolchain would have to move, for the whole workspace, before P4-65. I could resolve and run `cargo deny` on 0.19.1 but not build it here.
  2. Six crates are **MPL-2.0** (`as_variant`, `eyeball`, `eyeball-im`, `imbl`, `imbl-sized-chunks`, `readlock`; `bitmaps` with 0.18). `dependency-policy.md` allows MPL-2.0 unmodified, but `deny.toml` carries a per-crate exception only for `option-ext`, so `cargo deny` fails until six more `[[licenses.exceptions]]` entries (or MPL-2.0 in `allow`, which would be a policy edit) are added. Not modified: no fork, no patch.
  3. `vodozemac 0.11.2` (2026-11-05) is inside the two-week window until 2026-11-19, and the `ruma 0.17.2` family (2026-10-24) until 2026-11-07/08. Its fix is a security fix for key zeroization, so the rule and the advisory gate pull in opposite directions until then. P4-65 is far downstream, so this expires on its own.
- Storage: `matrix-sdk-crypto` needs a crypto store. `matrix-sdk-sqlite 0.19.1` uses `rusqlite ^0.40.2`, the same `rusqlite`/`libsqlite3-sys 0.38.2` as the workspace (0.18.0 used `rusqlite 0.37`, which Cargo's `links = "sqlite3"` rule would reject next to 0.40). So 0.19.1 is the only usable line.
- Size: +1.43 MB (0.18.0, default features off, memory store); expect about +2 to 3 MB with the sqlite store.
- Verdict: ok with exceptions (toolchain 1.96, six MPL-2.0 exceptions, wait for the window). Hand-written fallback does not exist for the crypto (vodozemac/Olm/Megolm), as the plan says; Q1 variant C can leave Matrix off.

### Nostr

`nostr 0.45.5` (MIT, 57 days old), features `std`, `nip44`, `os-rng`. `cargo deny` clean, 107 packages. The probe generates a key, builds and signs a kind-1 event through `EventBuilder::new(...).finalize(&keys)` and verifies it: works. API note for P4-66: in 0.45 signing is `EventBuilder::finalize`, not the `sign_with_keys` of older versions. `nostr-sdk` (relay pool) was not needed: the Buzz adapter is 218 lines on `nostr-tools`. Hand-written fallback (NIP-01 subset with `secp256k1`) is not needed.

### SSE streaming on rustls

Two shapes were built and run against a local chunked `text/event-stream` server (three events 0.4 s apart):

- `reqwest 0.12.28`, `default-features = false`, `rustls-tls`, `stream`: events arrive at 0.02, 0.43, 0.83 s (incrementally). No `native-tls`, no `openssl`. Already in the lockfile through lance, so no new version. Probe 3.25 MB. But it is a second HTTP client next to `ureq` in `plur1bus-engine`/`plur1bus`, against the "one HTTP client policy" comment in `crates/plur1bus-engine/Cargo.toml`.
- `ureq 3.4.2` (`rustls`, `platform-verifier`) reading the body in a blocking `BufRead` loop: events at 0.02, 0.42, 0.82 s. Probe 2.02 MB. Costs one blocking thread per open stream (use `spawn_blocking` with a channel into the async turn loop) and needs the abort path the engine already built with `socket2` (`=0.6.5`).
- Verdict: **ureq for providers (ok, no exception)**; `reqwest` only if the owner accepts the second client (it comes in anyway through `rmcp`'s HTTP client unless that is built on the generic transport). The decision interacts with `rmcp` above and should be taken once for both.

## 3. SQLite compatibility (R3)

Setup. The repository's packages are not built (no `pnpm install`, and none was allowed), so the store files were produced with the repository's own code loaded under Node's type stripping: `packages/core/src/session/migrations.ts` (the real `migrate()`, schema version 11, FTS5 tables `messages_fts` and `sessions_fts` with external content and triggers) and `MemorySensitivityStore` (`json_each`/`json_extract` data), plus the capability registry's DDL copied verbatim (`fts5(id UNINDEXED, text)`; its module imports the dispatcher and so needs built packages). Rows contain umlauts, accented text and CJK. The data is synthetic, in a temp home; no `~/.plur1bus` data was used.

What the stores use (grep of `packages/core/src` for `node:sqlite`, about 45 files): journal mode WAL (13 sites), `synchronous` NORMAL or FULL, `busy_timeout=5000`, `foreign_keys=ON` in 6 files, `user_version` (21 sites, versions up to 11 in the session store), `PRAGMA quick_check`, `wal_checkpoint`, `secure_delete`, `trusted_schema=OFF`, `query_only`, `data_version`; FTS5 only with the default `unicode61` tokenizer (no `tokenize=` anywhere), external-content tables, `bm25()`, `snippet()`; JSON functions `json_extract`, `json_each`; `DELETE ... RETURNING`; no extensions loaded, no math functions, no STRICT, no `rtree`.

| Item | Node 26.12.1 `node:sqlite` | `rusqlite 0.40.2` bundled (`libsqlite3-sys 0.38.2`) |
|---|---|---|
| `sqlite_version()` | 3.54.1 | 3.53.2 |
| FTS5 | available | available (`ENABLE_FTS5`) |
| JSON functions | `json_extract`, `json_each`, `->>` work | identical results |
| WAL, `user_version`, journal mode on existing files | read as written (11 / 1 / 0, `wal`) | identical |
| `ENABLE_MATH_FUNCTIONS` | **yes** | **no** (no stores use them) |
| `ENABLE_UNLOCK_NOTIFY` | yes | no (irrelevant: not used) |
| `SQLITE_DEFAULT_FOREIGN_KEYS` | **0** (off unless `PRAGMA foreign_keys=ON`) | **1** (on by default) |

Identical-result queries run on the same files by both engines (the Rust tool and a Node script execute the same SQL text, 16 queries): `bm25` ordering of the top five rows and the first score to nine decimals, `snippet(...)`, diacritic folding (`cafe` matches `café`, `munchen` matches `München`), CJK match, prefix and phrase queries, the UNINDEXED FTS table, `json_each` with an `IN` subquery, `json_extract`, `->>`, `integrity_check`, `foreign_key_check`, and the FTS5 `integrity-check` command. Differences: only the three rows in the table above.

Cross-engine writes and concurrency (WAL, same files):

1. Rust writes, then Node reads: 5 messages inserted in an `IMMEDIATE` transaction (the external-content FTS triggers fire), plus rows in two other databases. Node sees them, `integrity_check` ok, FTS5 `integrity-check` passes, FTS `MATCH` finds them, `user_version` unchanged.
2. Node writes, then Rust reads: same, in the other direction. Passes.
3. Node holds an open read transaction (snapshot) while the Rust process commits: the snapshot count stayed 20, the new count was 25 after the Node transaction ended. WAL snapshot isolation holds across engines.
4. Node holds `BEGIN IMMEDIATE` for 1.2 s while Rust attempts a write with `busy_timeout=5000`: Rust waited 1.2 s and committed; integrity ok.

Not covered: Node 24 (the plan's 24.21) is not installed on this machine and the Homebrew `node@22` is broken (missing dylib); the comparison used Node 26.12.1, which `package.json` `engines` allows (`>=26.1.0`). The SQLite file format is stable across 3.5x, and both engines wrote files the other one read, so the risk is low, but a Node 24 re-run of `spike/sqlite/nodecmp.mjs`-style checks should be part of gate G3 (CI has Node 24). FTS5 tokenizer data is the one place where a SQLite version difference could, in principle, change tokenisation of rare code points (unicode61 tables); the test corpus did not show any. A Rust-side delete of a row in an external-content FTS table was not exercised (Node did it in the lock test).

**Verdict: no incompatibility, no stop condition for the owner.** Conditions for `plur1bus-store` (P4-03):

- Set `PRAGMA foreign_keys` explicitly on every connection to what the TypeScript store does. Files that declare `REFERENCES` but never enable foreign keys in TypeScript (`grants/store.ts`, `user-jobs/index.ts`; `identity/store.ts` and the others do enable them) would silently start enforcing constraints under bundled `rusqlite`. Safer: set `OFF` by default in the connection factory and `ON` where TypeScript turns it on. This is the one real behaviour hazard found.
- Keep `journal_mode=WAL`, `synchronous`, `busy_timeout` per store as TypeScript sets them; `BEGIN IMMEDIATE` single writer works across engines.
- Do not use math SQL functions (not compiled in); no store uses them today.
- Expect `sqlite_version()` to differ between the Node and Rust core during coexistence; no store may branch on it.

## 4. Result-validation cost

The workspace uses `jsonschema 0.26.2`, draft 2020-12, the engine's `default-features = false`. Method: for every one of the 427 method fixtures in `packages/rpc-schema/fixtures/methods/` (`jobs.run.system` and `jobs.run.user` validate against `jobs.run`), compile a validator for `/$defs/methods/<m>/result` (and `params`) against the 569,211-byte `rpc.schema.json`, validate the fixture, then time 2,000 validations of the ten largest results (by serialised fixture size). Release build with thin LTO.

All 427 fixtures validate (params and result). The ten largest results are small (0.8 to 1.5 KB); the fixtures are not stress data, so scale the table by payload size (throughput about 1 GB/s).

| Method | Result bytes | Compile, full schema (ms) | Validate (µs) |
|---|---|---|---|
| budget.status | 1,549 | 7.39 | 1.4 |
| approval.decide | 1,260 | 6.95 | 1.2 |
| voice.agent.override.set | 1,077 | 6.12 | 1.0 |
| voice.agent.override.get | 1,077 | 6.10 | 1.0 |
| dreams.status | 945 | 6.37 | 1.1 |
| module.graph | 905 | 6.82 | 0.8 |
| chat.model.get | 887 | 7.07 | 0.9 |
| engine.adopt | 879 | 5.55 | 0.9 |
| daemon.status | 840 | 5.56 | 0.8 |
| approval.list | 813 | 5.48 | 0.7 |

- Per-call validation of the ten largest: 9.8 µs in total, similar to the 9.4 µs it takes to serialise the same ten results with `serde_json`. An invalid result (error collection with `iter_errors`) costs about 56 µs. Result validation on every response (ADR-012 §2, `E_INTERNAL reason=result-schema`) is affordable.
- **Compile cost is the finding.** Each validator built against the full document costs 5 to 7 ms, because the whole schema (305 `$defs`, 425 methods) is registered and, as far as the public API shows, each `build` also validates the schema against its metaschema (that option is private in 0.26.2, so it could not be switched off to confirm). Compiling all 854 validators takes 4.3 to 5.3 s. That would be a startup stall if done eagerly (the TypeScript side already has `precompileMethods`) and a 6 ms first-call stall if done lazily.
- Pruned roots fix it. A root that carries only the `$defs` reachable from `methods/<m>/<part>` (transitive `$ref` closure, same `$schema`/`$id`, same `$ref` spelling) compiles in **0.04 ms on average; all 854 in 26 ms**, and all 427 fixtures still validate. P4-03's `build.rs` (which already walks the schema for `typify`) should emit the closure per method, or the core should prune at startup (two lines of work per method, 26 ms in total). Only positive fixtures were run against pruned roots, so P4-03 should add a negative-fixture check (a pruned validator must reject exactly what the full one rejects); `$dynamicRef`/`$anchor` do not occur in the schema, so a `$ref` closure is sufficient.
- Memory of 854 compiled validators was not measured.

## 5. Gaps and things not done

- Linux and Windows were checked with `cargo check --target` (skeleton, keyring) and `cargo metadata`/`cargo deny` (all targets), not linked or run. Linker-level problems (libdbus, aws-lc, MSVC, NASM) are open for CI.
- Node 24 was unavailable (see §3).
- Binary-size deltas come from small probes with minimal feature sets; real usage will add code (e.g. `rmcp` macros and schemars derive output).
- Only one cargo-deny run per probe on 2026-11-07; the advisory database is from 2026-11-06. New advisories can appear at any time; the numbers in the table are a snapshot.
- Idle RSS was measured on macOS (resident set includes shared libraries); Linux RSS is typically lower for the same binary.

## 6. Re-estimate of plan §5

Agent days; "now" is the plan's number.

| Package | Now | After spike | Why |
|---|---|---|---|
| P4-01 | 2 | 0.5 used | Done in one session; the remaining value is this report. |
| P4-03 | 3 | 3.5 | + pruned result validators in `build.rs` (0.5); `plur1bus-store` factory sets `foreign_keys` explicitly (no extra time, but needs a test per store). `rusqlite` and WAL single-writer are proven, so no risk added. |
| P4-20 (secrets, `keyring`) | 4 | 4.5 | + Linux decision and a CI trial of `sync-secret-service`+`vendored` (or three advisory exceptions). macOS and Windows are straightforward. |
| P4-41 (providers, SSE) | 8 | 8 | `ureq` on blocking threads works and needs no policy change. A switch to `reqwest` would save about 0.5 d of stream plumbing and cost an exception. Net 0. |
| P4-65 (Matrix) | 5, risk H | 5, risk M | The big unknown (a Rust crypto path with a sqlite store on the workspace's `rusqlite 0.40.2`) is settled. Added work: toolchain bump to 1.96 (do it in P4-A or earlier, shared with everything else), six `deny.toml` exceptions. The WASM-to-native crypto-store data migration is still unverified and is not part of this spike. |
| P4-66 (Buzz, Nostr) | 1 | 1 | `nostr 0.45.5` works. |
| P4-70 (MCP) | 6 | 5.5 | `rmcp` clears (pin 3.7.0, or 3.8.0 from 2026-11-09). Choose the TLS provider variant once (ring). Fallback adapter on `ureq` is about 150 lines. |
| Others | | 0 | |

Total: variant A 203 to about 202 days, B 162 to about 161, C 131 to about 130. That is within the plan's own tolerance, so the direction is **unchanged, with lower risk**: R3 (store compatibility) is retired as a risk and becomes a P4-03 checklist; R8 (dependency policy) shrinks to three decisions the owner or the controller must take (below). The range (-14 % / +25 %) stays. The critical path is not touched (P4-01 was a 2-day prerequisite and is now done in less).

## 7. Decisions and follow-ups for the controller or owner

1. **Toolchain bump to Rust 1.96** before P4-65 (matrix-sdk-crypto 0.19.x). Needed for the vulnerability-free line; 0.18.0 has RUSTSEC-2026-0318 and a vodozemac advisory.
2. **MPL-2.0 per-crate exceptions** in `deny.toml` for the six matrix crates. `dependency-policy.md` already allows MPL-2.0 unmodified; this is a `deny.toml` housekeeping item.
3. **One HTTP/TLS policy for the core**: `ureq` for providers, and for `rmcp` the `reqwest-tls-no-provider` + `ring` variant (a second HTTP client crate version, one TLS provider), or the generic transport over `ureq`. Do not accept `rmcp`'s default `reqwest` feature (aws-lc-sys, +1.9 MB, a second provider).
4. **Linux keychain**: `keyring 3.6.3` + `sync-secret-service` + `vendored`, trial-built in CI; otherwise three time-boxed advisory exceptions (RUSTSEC-2026-0370, -0371, -0372, "unmaintained") or the file backend only on Linux.
5. **Transitive pins** for the two-week rule are needed in `Cargo.lock` when the crates are added (§2).
6. **Re-run the SQLite comparison with Node 24** in CI as part of gate G3.

## Appendix: throwaway material

All spike code lived in `~/worktrees/p4-01-spike/spike/` on the local branch `claude/p4-01-spike` (never pushed, no commit): `skeleton/`, `sqlcompat/` (Rust tool), `sqlite/` (generator and Node side), `valbench/`, `probes/*`, `tools/idx.py` (reads the cargo index cache for `pubtime`). The worktree is removed after the report; the branch stays.
