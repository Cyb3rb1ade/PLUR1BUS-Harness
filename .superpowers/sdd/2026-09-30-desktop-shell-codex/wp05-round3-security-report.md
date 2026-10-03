# WP5 Round3 security and test-bounds report

Date: 2026-10-03  
Worktree: `/Users/cyberblade/.codex/worktrees/desktop-shell-wp01/PLUR1BUS-Harness`  
Branch: `feat/desktop-shell-wp05-spa-proxy`  
Starting source SHA: `6148ed105e41d76afac53b80460eb76a8b5567f3`  
Scope: `apps/desktop/src-tauri/src/spa_proxy.rs` and `apps/desktop/src-tauri/tests/spa_proxy.rs` only.

## Security changes

- `Origin` is optional only for GET and HEAD. POST, PUT, PATCH and DELETE require one exact singleton Origin; missing, `null`, foreign, duplicate and malformed values are rejected with 403.
- The injected SPA CSP no longer contains `ipc:` or `http://ipc.localhost`. The test asserts the complete injected directive string for the bound loopback port and checks both entries are absent.
- All upstream `access-control-*` response headers are stripped. The test covers a malicious upstream response, a foreign-Origin GET and a foreign-Origin OPTIONS preflight.
- The 32-byte launch nonce uses `rand 0.9.2` `OsRng::try_fill_bytes`; RNG failure maps to `ClientError::Network`. No nonce is logged or disclosed.

Nonce deviation (explicit): the renderer can read the nonce because it is carried in the per-window User-Agent. This is not a universal confidentiality mechanism for intentional application payloads; the ambient User-Agent carrier is stripped before upstream forwarding. The nonce never admits a request alone: exact Host blocks DNS rebinding and Origin is checked by method; the injected CSP blocks exfiltration; navigations carrying the nonce are refused; and the nonce is never put in a query string or forwarded upstream.

## RED evidence

Command, from `apps/desktop`:

```text
cargo test --locked --test spa_proxy non_get_methods_require_exact_origin -- --nocapture
```

On starting SHA `6148ed1`, the new test failed as intended:

```text
assertion `left == right` failed: POST None
left: 200
right: 403
test non_get_methods_require_exact_origin ... FAILED
process exit: 101
```

Raw RED log path: none was captured. The output above is transcript-only and was not reconstructed from a saved log.

This demonstrated that a POST without Origin was admitted before the method-aware check.

## GREEN evidence

Focused security tests passed after the fixes:

```text
cargo test --locked --test spa_proxy non_get_methods_require_exact_origin -- --nocapture
cargo test --locked --test spa_proxy foreign_origin_and_upstream_cors_headers_cannot_grant_cors -- --nocapture
cargo test --locked --test spa_proxy csp_nonce_hash_are_preserved_and_foreign_reporting_is_removed -- --nocapture
```

Each exited 0. The full proxy log is `/tmp/wp05-round3-security-spa-proxy.log`; command:

```text
cargo test --locked --test spa_proxy -- --nocapture
```

Result: `24 passed; 0 failed; 0 ignored`, process exit 0, elapsed 15.27 seconds. The log contains named `elapsed_ms` lines from the 60-second helper. The 11-second SSE stream remains within the 15-second reqwest total timeout.

The complete desktop workspace log is `/tmp/wp05-round3-security-desktop-workspace.log`; command:

```text
cargo test --locked --workspace --no-fail-fast -- --nocapture
```

Result: all workspace unit, integration, fixture, TLS, proxy, mock-harness and doctest collections passed; one pre-existing explicit real-keychain opt-in test remained ignored. Process exit 0.

Formatting was checked with:

```text
cargo fmt --all -- --check
```

Process exit 0.

Every reqwest test client now uses `connect_timeout(5s)` and `timeout(15s)`, including the no-redirect builder. Every async `spa_proxy` test body goes through the 60-second timeout helper.

The resulting source head after the bounded method-matrix extension is `e06a08f917192c9e83348ea1d1fd2d00f7b77823`. That test-only commit covers optional/missing and invalid HEAD Origin values and missing, `null`, foreign and exact OPTIONS Origin values. The focused extension run was:

```text
cargo test --locked --test spa_proxy non_get_methods_require_exact_origin -- --nocapture
```

It exited 0 (`1 passed; 0 failed`, `elapsed_ms=1875`). `cargo fmt --all -- --check` also exited 0. No broad suite was rerun for the extension.

## `--report-time` compatibility

The requested stable probe was run with Rust `1.95.0 (59807616e 2026-04-14)`:

```text
rustc --version
cargo test --locked --test spa_proxy -- --report-time
```

Cargo/test exited 101 before running tests:

```text
error: The "report-time" flag is only accepted on the nightly compiler with -Z unstable-options
```

No nightly toolchain and no `RUSTC_BOOTSTRAP` were used. The honest stable alternative is the helper's named `elapsed_ms` output retained in `/tmp/wp05-round3-security-spa-proxy.log` and `/tmp/wp05-round3-security-desktop-workspace.log`.

## Native-proof boundary

The controller's genuine macOS native proof is retained at `/tmp/wp05-round3-security-native`, in `first.json` and `restart.json`. It ran after report commit `3260100198726153b6f58dd883ceee35327233a6` and before the test-only matrix commit `e06a08f917192c9e83348ea1d1fd2d00f7b77823`; the exercised product implementation is from `abf4a52c307259129072616858147eb3079de680`, with no added-test source in the native run. All four sessions report `fullProcessRestart: true`, `shellInfo: true` and `onlyShellInfo: true`; the first-run p95 is `2.080292 ms`, restart p95 is `3.837125 ms`, and the verifier is PASS.

This is controller-supplied macOS evidence, not a run by this worker. It does not prove Windows behavior or a new-head five-target CI result. The current Windows x64 and Windows ARM native children still exit 2 at `other-window` (W2). No Windows/new-head CI claim is made here. Removing the IPC CSP entries is also covered by the complete directive assertion above; native postMessage behavior is evidenced only by the controller artifact.

No secrets, real-home paths, keychain entries or service-manager objects were used or written by these tests.
