# RE-00 — Foundations: crate skeleton, dependency gate, lint policy

**Package.** The empty crate `crates/plur1bus-engine` (library + binary `plur1bus-engine`) with its heavy
dependencies declared, the dependency and licence gates passed, the build cost measured, and the lint policy the
crate starts under. Size S. Nothing in this package implements engine behaviour; it exists so RE-01…RE-03 start on a
green, measured base and so the owner decides the licence questions once, in one PR.

**Depends on.** Nothing. **Enables.** Every other brief.

**Assumes.** RE-D2 (crate in this workspace), RE-D3 (`lancedb` pinned to the Lance version the Node package embeds).
If RE-D3 changes to "no LanceDB", T2 drops `lancedb` and the gate runs on the replacement store crate instead.

**Read first.**
- Plan §2.4 (crate layout) and §5.2 (build time, licence closure).
- `Cargo.toml` (root): `members = ["crates/*"]` — the new crate joins the workspace by existing; `[workspace.dependencies]`
  (`serde`, `serde_json`, `clap 4.6`, `tempfile`); the `[profile.dev.package.sha2]` block and its comment (the precedent
  for per-crate dev opt-levels).
- `deny.toml` (licence allow-list: Apache-2.0, BSD-2-Clause, BSD-3-Clause, CC0-1.0, ISC, MIT, Unicode-3.0; registry
  and git source rules) and `docs/dependency-policy.md` (the `audit-deps` allow-list, which is wider: MPL-2.0,
  Unicode-DFS-2016, 0BSD added). What CI blocks on (corrected 2026-10-24 after T3's first run): the `quality` job
  (`release-quality.yml`) runs `scripts/release/audit-policy.mjs`, which **blocks merges on advisories only** — `cargo deny
  … check advisories` with an isolated configuration over the root and the `apps/desktop` manifests, plus `pnpm audit` —
  and an unscored production advisory blocks too. The licence part of `cargo deny check` is a requirement of this brief
  and of `docs/coding-standard.md`, not a workflow gate (on `main` it was already red before this package);
  `node scripts/audit-deps.mjs` runs in the informational `dependency-licenses` workflow (`continue-on-error`).
- `crates/plur1bus-config/Cargo.toml` (the JSON-Schema validator the harness already uses: `jsonschema = "0.26"`,
  `default-features = false`) and `crates/plur1bus-attest/` (the precedent for a crate that is both library and binary).
- `docs/coding-standard.md` §10 (CS-1: the target `[workspace.lints]` table).
- The engine repository's committed lockfile (`main` at `98dfe2f`): the resolved version of `@lancedb/lancedb` is the
  Lance version the Rust crate must match (plan §1.4; the Node SDK is a binding of the Rust crate of the same version).

**Rules that apply.** No "openclaw" string under `crates/` (`scripts/lint-hygiene.mjs`). Every new dependency is named
in the PR with licence, size and reason (coding-standard §1.7). `rustfmt` defaults; `cargo clippy --workspace
--all-targets -- -D warnings` stays green for every existing crate — the new lint table must not change their
diagnostics (only the new crate opts in).

## Files

- Create: `crates/plur1bus-engine/Cargo.toml`, `crates/plur1bus-engine/src/lib.rs`, `crates/plur1bus-engine/src/main.rs`,
  `crates/plur1bus-engine/tests/cli.rs`, `crates/plur1bus-engine/README.md`
- Modify: `Cargo.toml` (root: `[workspace.lints.rust]`, `[workspace.lints.clippy]`, `[profile.dev.package.*]` entries,
  `[patch.crates-io]` for RE-D14), `deny.toml` **only with the owner's approval in the PR review** (T3; `[sources]
  allow-git` for the RE-D14 fork is approved), `docs/dependency-policy.md` likewise,
  `AGENTS.md` ("Where things live": one row for the crate), `docs/ci.md` (only if T4 changes a job budget)
- Test: `crates/plur1bus-engine/tests/cli.rs`

## Interfaces

- Consumes: nothing.
- Produces: the crate name `plur1bus-engine` (library target `plur1bus_engine`, binary `plur1bus-engine`); the
  workspace lint table every later brief inherits through `[lints] workspace = true`; the dependency set
  `lancedb`, `rusqlite` (bundled), `jsonschema`, `serde`, `serde_json`, `clap`, `ureq` pinned in `Cargo.lock`.
  `ort` and `tokenizers` are **not** added here; RE-03 adds them with their own gate step.

## Tasks

### T1 — Crate skeleton (one pull request together with T2–T4)

- [ ] **Step 1: write the failing test** `crates/plur1bus-engine/tests/cli.rs`:

```rust
//! The binary exists, answers `--version` with the workspace version and refuses an unknown subcommand with the
//! usage exit code of docs/errors.md.
use std::process::Command;

#[test]
fn version_flag_prints_the_workspace_version() {
    let out = Command::new(env!("CARGO_BIN_EXE_plur1bus-engine")).arg("--version").output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(text.trim(), format!("plur1bus-engine {}", env!("CARGO_PKG_VERSION")));
}

#[test]
fn an_unknown_subcommand_exits_with_the_usage_code() {
    let out = Command::new(env!("CARGO_BIN_EXE_plur1bus-engine")).arg("frobnicate").output().unwrap();
    assert_eq!(out.status.code(), Some(2));
}
```

- [ ] **Step 2: run it** — `cargo test -p plur1bus-engine` — Expected: the crate does not exist; cargo fails.
- [ ] **Step 3: create the crate.** `Cargo.toml`: `name = "plur1bus-engine"`, `edition.workspace = true`,
  `version.workspace = true` (match `crates/plur1bus-attest/Cargo.toml` for the inherited fields), `[lints] workspace =
  true`, `[[bin]] name = "plur1bus-engine" path = "src/main.rs"`, dependencies `serde.workspace`, `serde_json.workspace`,
  `clap.workspace` (derive), `tempfile.workspace` (dev). `src/lib.rs`: a `//!` header stating what the crate is (the
  memory engine, plan §2) and `pub const CRATE_VERSION: &str = env!("CARGO_PKG_VERSION");`. `src/main.rs`: clap with
  one hidden placeholder subcommand `serve` (RE-08 fills it), `--version` from clap, exit code 2 on a usage error
  (clap's default `error.exit()` uses 2 — assert it in the test above rather than assuming).
- [ ] **Step 4: run** `cargo test -p plur1bus-engine` — Expected: 2 passed.
- [ ] **Step 5:** `cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings` — Expected: clean.

### T2 — Heavy dependencies declared and locked

- [ ] **Step 1: find the Lance version.** In the engine repository at `98dfe2f`, read the committed lockfile's resolved
  version of `@lancedb/lancedb` (the manifest says `^0.26.2`; the lock decides). Record it in the PR description.
- [ ] **Step 2: add** to `crates/plur1bus-engine/Cargo.toml`: `lancedb = "=<that version>"`, `rusqlite = { version =
  "0.40", features = ["bundled"] }`, `jsonschema = { version = "0.26", default-features = false }`, `ureq` at the version
  and feature set `crates/plur1bus/Cargo.toml` uses (one HTTP client policy in the workspace: `rustls`, no native-tls).
  Add nothing else. `cargo build -p plur1bus-engine` once so `Cargo.lock` carries the closure.
- [ ] **Step 3: check the closure for duplicates** — `cargo tree -p plur1bus-engine -d` — list every crate that now
  appears in two versions in the PR description; `deny.toml` has `multiple-versions = "warn"`, so this is information
  for the reviewer, not a failure.
- [ ] **Step 4:** `cargo metadata --locked --format-version 1 > /dev/null` — Expected: exit 0 (the lock is complete).

### T3 — Dependency and licence gate (owner decision inside the PR)

- [ ] **Step 1: run both gates** and paste their output into the PR description:
  `cargo deny check` (install `cargo install cargo-deny --version 0.20.2 --locked`, the version `quality` uses) and
  `node scripts/audit-deps.mjs --only cargo`.
- [ ] **Step 2: classify every finding** in a table in the PR: crate, version, licence expression, reachable from
  (`cargo tree -i <crate>`), proposal (add licence to the allow-list / per-crate exception with expiry / replace the
  dependency). Expect the Lance and DataFusion closure to bring licences outside both lists (`Zlib`, `BSL-1.0`,
  `Unicode-DFS-2016`, `CDLA-Permissive-2.0` are likely; `MPL-2.0` is allowed by `audit-deps` but not by `deny.toml`).
  Note which findings already exist on `main` today (`foldhash` Zlib, `zlib-rs` Zlib, `webpki-roots` and
  `webpki-root-certs` CDLA-Permissive-2.0, `borrow-or-share` MIT-0 — all informational so far) so the owner sees what
  is new.
- [ ] **Step 3: wait for the owner's decision in the review**, then apply exactly it: `deny.toml` `[licenses] allow`
  additions and/or `[licenses.exceptions]` rows (crate + allow), `docs/dependency-policy.md` allow-list and/or
  `docs/dependency-exceptions.json` entries (schema `docs/dependency-exceptions.schema.json`; every entry has
  `expires` and `reason`). Re-run both gates; `cargo deny check` must pass; `audit-deps` must show no `NOT-LISTED`
  row for a crate this PR adds.
- [ ] **Step 3b — advisories the closure brings (RE-D14, decided 2026-10-24).** An advisory against a crate the pinned
  Lance closure needs, with no fix inside the versions the pins allow, is answered with a fork of that crate at its
  pinned tag carrying only the fix (owner-created repository under `Cyb3rb1ade/`, branch `plur1bus/<version>-<fix>`,
  tag `v<version>-plur1bus.<n>`), consumed through `[patch.crates-io]` in the root `Cargo.toml` with a comment that
  names the advisories and the exit condition, and allowed in `deny.toml` `[sources] allow-git`. Never an entry in the
  audit allow-list. First instance: `tantivy 0.24.2` → `lru 0.18.2` (RUSTSEC-2026-0002, RUSTSEC-2026-0253), PR #759.
  The gate to satisfy is `node scripts/release/audit-policy.mjs` at 0 blocking findings for both manifests.
- [ ] **Step 4:** `node scripts/test/audit-deps.test.mjs` (or the test the script names in its header) still passes.

### T4 — Build cost and lint policy

- [ ] **Step 1: measure.** `cargo clean -p plur1bus-engine` is not enough for a cold number; use a fresh `CARGO_TARGET_DIR`:
  `CARGO_TARGET_DIR=/tmp/p1e-cold cargo build -p plur1bus-engine --timings` (cold) and a second build after touching
  `src/lib.rs` (warm). Record wall time and the three slowest crates from the timings report in the PR description.
- [ ] **Step 2: dev opt-levels.** Add `[profile.dev.package.<crate>] opt-level = 3` for the Lance, DataFusion and Arrow
  crates whose debug build dominates the `unit` job (the `sha2` block in the root `Cargo.toml` shows the format and the
  reasoning comment style). Re-measure; keep an entry only if it saves time.
- [ ] **Step 3: lint table.** Add to the root `Cargo.toml` the `[workspace.lints.rust]` and `[workspace.lints.clippy]`
  table of `docs/coding-standard.md` §10 **as written there**. Only `crates/plur1bus-engine/Cargo.toml` carries
  `[lints] workspace = true` in this PR; the other crates opt in under CS-1. Verify: `cargo clippy --workspace
  --all-targets -- -D warnings` is still clean for every crate.
- [ ] **Step 4: documentation.** `crates/plur1bus-engine/README.md` (purpose, how to build and test, the binary's
  one subcommand placeholder, the licence decisions made in T3 with the PR number); AGENTS.md "Where things live" row;
  `docs/ci.md` only if the `unit (ubuntu-24.04)` wall time grows by more than 10 % — then state the new figure.

## Acceptance

- `cargo test -p plur1bus-engine`: 2 passed. `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --
  -D warnings`, `cargo deny check`: clean. `node scripts/audit-deps.mjs --only cargo`: no `NOT-LISTED` row for a crate
  added by this PR. `node scripts/lint-hygiene.mjs`: clean.
- The PR description carries: the Lance version and where it was read, the duplicate-version list, the licence table
  with the owner's decision per row, the cold and warm build times.
- CI: `ci-gate` and `quality` green on the PR head (`quality` means `node scripts/release/audit-policy.mjs` at 0 blocking
  findings and the third-party notices check); the `unit (ubuntu-24.04)` job ran `cargo test --workspace` including
  the new crate (its log shows `Running tests/cli.rs`).

## Out of scope

Any engine type or behaviour (RE-01 onwards); `ort`/`tokenizers` (RE-03); CI job changes beyond a budget note; opting
other crates into the lint table (CS-1).

## Hand-off

PR title `RE-00/T1-T4: engine crate skeleton, dependency gate, lint policy`. Description per coding-standard §11 plus
the four records named under Acceptance. Reviewer: the owner (licence decisions).
