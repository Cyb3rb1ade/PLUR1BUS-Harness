# AF0 verification — 2026-11-01

Platform: macOS 27.2, build 26B123, Apple Silicon. Node 24.21.0, pnpm 10.28.0, Rust 1.95.0.
macOS commands used `TMPDIR=/private/tmp`. Native builds and tests used two build jobs,
`CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_PROFILE_TEST_DEBUG=0` and `CARGO_INCREMENTAL=0`;
these control build resources and debug information, not assertion or test selection.

The [final native report](./2026-11-01-probe-final.md) links the measured JSON and the unchanged
[original stopped receipt](./2026-11-01-probe.md). Its collector source is identified in the JSON.
There was no licence command, sudo, PCC completion or change to Apple Intelligence settings.

## Commands

| Command | Result |
| --- | --- |
| `node scripts/check-toolchain.mjs` | passed |
| `pnpm test:prep` | passed: frozen dependencies, generation, builds and actual prerequisites |
| `node --test scripts/test/apple-fm-probe.test.mjs scripts/ci/workflow-contract.test.mjs` | 34 passed, zero failures/skips/TODOs; includes 23 offline AF0 tests |
| `cargo fmt --all -- --check` | passed |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | passed |
| `cargo build --locked -p plur1bus-remote-fs -p plur1bus --bins --example sftp_test_server` | passed |
| `cargo test -p plur1bus-sandbox -p plur1bus-tools -p plur1bus --locked` | attempted, exit 101: package plur1bus-sandbox does not exist in this AF0 base; no tests ran under this invocation |
| `cargo test -p plur1bus --locked` | 2,782 passed, zero failed/filtered, one existing ignored test |
| `pnpm lint` | exit 0; final script suite: 163 passed, three existing acceptance TODOs |
| `pnpm --filter @plur1bus/core test` | 11,295 passed, zero failed; 22 existing skips and 12 TODOs |
| `pnpm --filter @plur1bus/providers test` | 703 passed, zero failed/skipped/TODOs |
| `pnpm docs:check` | passed |
| `pnpm test` | exit 0; 20,475 tests across 23 package summaries: 20,347 passed, 0 failed, 53 existing skips, 75 TODOs |

The sandbox and tools crates belong to the separately scoped D123/K work, and neither exists
in this AF0 checkout. The available Harness crate was tested without filters instead. This is
not a D123 sandbox/platform acceptance claim.

## Red before the fixes

- Both availability regressions first failed: available `system` with exit 1; cross or unreadable
  output with exit 0. They now pass, and the live preflight records exit 1 with `system` available.
- A real Node child creating a Unix socket reproduced the collector's missed `fs.watch` readiness.
  The regression passes after checking the actual socket and HTTP readiness.
- The shutdown-log regression first failed; evidence now includes bytes emitted during shutdown.
- The stdin/tokenizer regression first reported zero input bytes instead of four. The window
  measurement regression also failed before implementation. Both pass.
- Earlier guard, response, ownership, response-cap and protocol tests also had red runs before
  their implementation. No failing assertion was removed to make the collector pass.

## Existing acceptance gaps

No skip, TODO, ignored test, assertion or filter was added to an existing suite. The pre-existing
ignored Rust test is `whitespace_only_keys_are_refused_before_any_connection` in `coverage_login.rs` (the recorded
owner question about whitespace-only API keys). The existing lint TODO assertions still expose:

- `KNOWN GAP: production Laya service or module has public backend, bounded abort and role fallback evidence`.
- `KNOWN GAP: independent labels cover the exact paired fixture hash before calibration admission`.
- `KNOWN GAP: role comparison uses independently reviewed identical German/English cases`.

Existing Core TODO assertions also report native Windows directory-entry durability, native Kev
inference and German eligibility, the Engine media contract pin, production media reservations
and secret leases, and real Harness image/audio indexing. Their source and eligibility are unchanged. The full workspace run also preserves the existing Web and WebMCP TODOs; they do not constitute production acceptance.

AF0 measured the healthy owner's Mac. Native system-unavailable, downloading, disabled and region
error variants were not induced; exact shared context size and a forced unloaded-model cold start
remain unproven. The 4,096 catalog/guard policy stays conservative. AF5 still owns its paired German
gate and the owner decision for confidence without returned probabilities.

## Platforms and CI

The live `/usr/bin/fm` run and local commands above ran on macOS arm64. No local Linux or Windows
acceptance is claimed. CI now runs the offline probe suite in the Unix unit jobs; its live opt-in
and CI refusal prevent real `fm` inference there. The existing unit/unit-os workflow contract passes.
CI is not polled; the Controller owns review and merge.
