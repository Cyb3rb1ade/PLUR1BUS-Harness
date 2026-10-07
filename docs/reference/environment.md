# Environment variables

This page lists every environment variable that the code in `packages/`, `apps/`, `hosts/`, `clients/`, `scripts/` (TypeScript/JavaScript) and `crates/`, `apps/` (Rust) reads, plus the variables set or read by `.github/workflows`. Paths are relative to the repository root. Purposes come from nearby code and comments only; where none exists the entry says "unklar – prüfen". Test-only seams are marked "[Test]" in the Purpose column. Build-time values come from `option_env!`/`env!`, so they are fixed at compile time.

## PLUR1BUS_* variables

| Variable | Read in | Purpose | Default | Source |
|---|---|---|---|---|
| PLUR1BUS_HOME | crates/plur1bus/src/paths.rs; packages/core/src/paths.ts; apps/desktop/src-tauri/src/discovery.rs | Overrides the install/state home | `~/.plur1bus` (POSIX) / `%LOCALAPPDATA%\PLUR1BUS` (Windows) | packages/core/src/paths.ts:10; crates/plur1bus/src/paths.rs:128,154; apps/desktop/src-tauri/src/discovery.rs:22 |
| PLUR1BUS_RUN_ACL | packages/module-api/src/secure-path.ts | Run-dir ACL mode; the value `inherited` is checked | – | packages/module-api/src/secure-path.ts:33,161 |
| PLUR1BUS_CONTAINER | crates/plur1bus/src/container.rs; apps/desktop/mock-harness/src/main.rs | Container mode when exactly `1`; setup/update refuse | unset (false) | crates/plur1bus/src/container.rs:7; apps/desktop/mock-harness/src/main.rs:27 |
| PLUR1BUS_NODE | crates/plur1bus/src/commands/core.rs | Explicit Node binary for the core | `<home>/runtime/node-*/bin/node`, then `node` on PATH | crates/plur1bus/src/commands/core.rs:11 |
| PLUR1BUS_CORE_JS | crates/plur1bus/src/commands/core.rs; scripts/bench.mjs | Path to `core.js` | `<home>/runtime/core/core.js`; bench: `packages/core/dist/core.js` | crates/plur1bus/src/commands/core.rs:45-47; scripts/bench.mjs:14 |
| PLUR1BUS_ACP_JS | crates/plur1bus/src/commands/acp.rs | Path to `acp.js` | `acp.js` next to `core.js` | crates/plur1bus/src/commands/acp.rs:19-21 |
| PLUR1BUS_IMPORT_JS | crates/plur1bus/src/commands/import.rs | Path to `import.js` | `import.js` next to `core.js` | crates/plur1bus/src/commands/import.rs:16-18 |
| PLUR1BUS_SERVICE_MANAGER | crates/plur1bus/src/supervisor/mod.rs | Names the service manager; used to map exit codes so launchd does not restart non-transient failures | – | crates/plur1bus/src/supervisor/mod.rs:624 |
| PLUR1BUS_SERVICE_FAKE | crates/plur1bus/src/commands/service.rs | [Test] Directory for a fake service runner; requires `PLUR1BUS_ALLOW_TEST_INTERNALS=1` | unset → real `SystemRunner` | crates/plur1bus/src/commands/service.rs:13-16 |
| PLUR1BUS_SUPERVISOR_TIME_SCALE | crates/plur1bus/src/supervisor/mod.rs | Scales supervisor timings; read only with test internals | `1.0` | crates/plur1bus/src/supervisor/mod.rs:662-664; parse at :366 |
| PLUR1BUS_NODE_MIRROR | crates/plur1bus/src/install/pins.rs | Alternative Node distribution base URL (trailing `/` trimmed) | `https://nodejs.org/dist` | crates/plur1bus/src/install/pins.rs:10,88-90 |
| PLUR1BUS_RELEASE_BASE_URL | crates/plur1bus/src/install/pins.rs (build-time) | Release base URL baked into release builds | – (None in dev build) | crates/plur1bus/src/install/pins.rs:113-114 |
| PLUR1BUS_RELEASE_PUBKEY_STABLE | crates/plur1bus/src/install/pins.rs (build-time) | Minisign public key for the stable channel | – | crates/plur1bus/src/install/pins.rs:127 |
| PLUR1BUS_RELEASE_PUBKEY_BETA | crates/plur1bus/src/install/pins.rs (build-time) | Minisign public key for the beta channel | – | crates/plur1bus/src/install/pins.rs:126 |
| PLUR1BUS_CORE_SHA256 | crates/plur1bus/src/install/pins.rs (build-time) | SHA-256 of the core payload, baked at release build | – (None in dev build) | crates/plur1bus/src/install/pins.rs:107 |
| PLUR1BUS_DESKTOP_CONFIG_DIR | apps/desktop/src-tauri/src/{commands,lib,discovery,pair,secrets,diagnostics,gnome}.rs; controller/autostart.rs; examples/production_spa.rs | Desktop fixture config dir; its presence also disables OS integration (autostart, install hook) | – | apps/desktop/src-tauri/src/discovery.rs:19-20; commands.rs:39,145; lib.rs:83,101; diagnostics.rs:74,95; autostart.rs:40 |
| PLUR1BUS_DESKTOP_REAL_KEYCHAIN | apps/desktop/src-tauri/src/secrets.rs | Uses the real OS keychain when `1` | off | apps/desktop/src-tauri/src/secrets.rs:161,324 |
| PLUR1BUS_DESKTOP_COOKIE_GUARD | apps/desktop/src-tauri/src/spa.rs; apps/desktop/scripts/native-lifecycle.mjs | Cookie-guard toggle (Windows debug builds); `0`, `false` or `off` disables it | enabled | apps/desktop/src-tauri/src/spa.rs:53-55; native-lifecycle.mjs:103 |
| PLUR1BUS_DESKTOP_TEST_CONTROL | apps/desktop/mock-harness/src/main.rs | Enables test control in the mock harness | off | apps/desktop/mock-harness/src/main.rs:24 |
| PLUR1BUS_DESKTOP_APPROVALS_DECIDE | apps/desktop/mock-harness/src/main.rs | Mock harness auto-decides approvals when `1` | off | apps/desktop/mock-harness/src/main.rs:26 |
| PLUR1BUS_DESKTOP_E2E_RUNTIME | apps/desktop/stub-image/smoke.mjs | Expected runtime selector; mismatch fails the smoke test | – | apps/desktop/stub-image/smoke.mjs:11 |
| PLUR1BUS_SECRETS_KEYRING | packages/core/src/secrets/runtime.ts | [Test] `off` = keyring unavailable, `memory` = in-process keyring; requires `PLUR1BUS_ALLOW_TEST_INTERNALS=1` | unset → real `@napi-rs/keyring` | packages/core/src/secrets/runtime.ts:10-15 |
| PLUR1BUS_ALLOW_TEST_INTERNALS | packages/core/src/bin.ts; packages/core/src/tools/fs/ops.ts; crates/plur1bus/src/{supervisor/mod.rs, install/pins.rs, install/setup.rs, update/*.rs, ext/*.rs, modules/manifest.rs, commands/*.rs} | Master gate: every [Test] seam is ignored unless this is `1` | unset | packages/core/src/bin.ts:22; crates/plur1bus/src/supervisor/mod.rs:358; crates/plur1bus/src/install/pins.rs:13 |
| PLUR1BUS_TEST_INTERNALS | crates/plur1bus/src/commands/core.rs; crates/plur1bus/src/supervisor/child.rs | [Test] Test-internals mode forwarded to the core as `--test-internals` | – | crates/plur1bus/src/commands/core.rs:68-69; supervisor/child.rs:69 |
| PLUR1BUS_TEST_CHAT_PROVIDER | packages/core/src/bin.ts | [Test] Only the value `fake` is accepted | – | packages/core/src/bin.ts:74-76 |
| PLUR1BUS_TEST_DISCOVERY_PROFILES | packages/core/src/bin.ts | [Test] Path to a JSON discovery-profile file | – | packages/core/src/bin.ts:41,46 |
| PLUR1BUS_LIVE_EVAL | packages/core/src/toolcall/eval.ts | Live eval mode; must be `1`, otherwise the run is skipped | unset (skipped) | packages/core/src/toolcall/eval.ts:66 |
| PLUR1BUS_EVAL_REPORT | packages/core/test/toolcall/eval.test.ts | [Test] Path prefix for JSON and Markdown eval reports | – | packages/core/test/toolcall/eval.test.ts:9-11 |
| PLUR1BUS_LIVE_EMBED | packages/embedding-adapters/test/live/helpers.ts | [Test] Enables live embedding-adapter smoke tests | unset | packages/embedding-adapters/test/live/helpers.ts:5 |
| PLUR1BUS_TRACE_FILE | packages/core/test/helpers/trace-loader.mjs | [Test] File that URLs are appended to | – | packages/core/test/helpers/trace-loader.mjs:13 |
| PLUR1BUS_FUZZ_SEED | packages/module-api/test/framing-fuzz.test.ts; crates/plur1bus-ext/tests/fuzz.rs | [Test] Fuzz seed | TS: `0xe1f022`; Rust: unklar – prüfen | packages/module-api/test/framing-fuzz.test.ts:12; crates/plur1bus-ext/tests/fuzz.rs:419 |
| PLUR1BUS_FUZZ_CASES | packages/module-api/test/framing-fuzz.test.ts | [Test] Number of fuzz cases | `300` | packages/module-api/test/framing-fuzz.test.ts:13 |
| PLUR1BUS_FUZZ_SECONDS | crates/plur1bus-ext/tests/fuzz.rs | [Test] Duration of the ignored long fuzz test | `20` | crates/plur1bus-ext/tests/fuzz.rs:547 |
| PLUR1BUS_WEB_SHOTS_DIR | packages/web/test/responsive.test.ts; packages/web/test/shots.ts | [Test] Output directory for screenshots | – | packages/web/test/responsive.test.ts:18; packages/web/test/shots.ts:277 |
| PLUR1BUS_WEB_SHOTS_WIDTHS | packages/web/test/shots.ts | [Test] Comma-separated custom viewport widths | built-in widths | packages/web/test/shots.ts:63 |
| PLUR1BUS_WEB_SHOTS_CHECK | packages/web/test/shots.ts | [Test] `1` enables check mode | off | packages/web/test/shots.ts:65 |
| PLUR1BUS_WEB_SHOTS_ONLY | packages/web/test/shots.ts | [Test] Comma-separated filter of shots to run | all | packages/web/test/shots.ts:279 |
| PLUR1BUS_WEB_GALLERY | packages/web/build.ts | Gallery build when `1` | off | packages/web/build.ts:36 |
| PLUR1BUS_WEB_E2E_REQUIRED | packages/web/test/harness.ts | [Test] Fails instead of skipping when no Chromium is found | off | packages/web/test/harness.ts:18 |
| PLUR1BUS_CHROMIUM | packages/web/test/harness.ts | [Test] Chromium executable path | Playwright executable, then `/opt/pw-browsers/chromium` | packages/web/test/harness.ts:11 |
| PLUR1BUS_SCREENSHOT_DIR | apps/desktop/ui/test/layout.test.ts | [Test] Screenshot directory | temporary directory (removed after) | apps/desktop/ui/test/layout.test.ts:42-43 |
| PLUR1BUS_LIFECYCLE_REPORT | apps/desktop/scripts/native-lifecycle.mjs | Output path for the Windows lifecycle report JSON | – | apps/desktop/scripts/native-lifecycle.mjs:101-107 |
| PLUR1BUS_CI_HEAD_SHA | apps/desktop/scripts/windows-focus-summary.mjs; apps/desktop/scripts/native-lifecycle.mjs | Commit SHA written into the report | – | apps/desktop/scripts/windows-focus-summary.mjs:41; native-lifecycle.mjs:102 |
| PLUR1BUS_DESKTOP_MATRIX_RESULT | apps/desktop/scripts/windows-focus-summary.mjs | Result of the desktop CI matrix, used in the summary | – | apps/desktop/scripts/windows-focus-summary.mjs:41 |
| PLUR1BUS_F2_STARTUP_ROOT | apps/desktop/scripts/windows-startup.test.mjs | [Test] Root directory for startup test runs | `RUNNER_TEMP`, then tmpdir | apps/desktop/scripts/windows-startup.test.mjs:467 |
| PLUR1BUS_F2_STARTUP_TIMINGS | apps/desktop/scripts/windows-startup.test.mjs | [Test] Output path for startup timings JSON | – | apps/desktop/scripts/windows-startup.test.mjs:521 |
| PLUR1BUS_F2_STARTUP_PRODUCTION_CAP | apps/desktop/scripts/windows-startup.test.mjs | [Test] `1` selects the 12 s helper timeout; otherwise 40 s | 40000 ms | apps/desktop/scripts/windows-startup.test.mjs:490 |
| PLUR1BUS_BIN | scripts/gen-docs.mjs; scripts/bench.mjs | Path to the CLI binary used by the script | gen-docs: `target/debug/plur1bus`; bench: `target/release/plur1bus` | scripts/gen-docs.mjs:82-83; scripts/bench.mjs:13 |
| PLUR1BUS_FIXTURE_MODULE | crates/plur1bus/tests/{modules,module_cmd,reboot,windows,ext_supervisor}.rs; crates/plur1bus-ext/examples/make-fixtures.rs | [Test] Directory of the fixture module | `packages/module-fixture/dist` | crates/plur1bus/tests/modules.rs:23-26 |
| PLUR1BUS_TEST_NODE_SHA256 | crates/plur1bus/src/install/pins.rs | [Test] Replaces the current target's Node SHA-256 pin | committed pin | crates/plur1bus/src/install/pins.rs:55 |
| PLUR1BUS_TEST_CORE_SHA256 | crates/plur1bus/src/install/pins.rs | [Test] Replaces the core payload SHA-256 | build-time value | crates/plur1bus/src/install/pins.rs:83 |
| PLUR1BUS_TEST_RELEASE_PUBKEY | crates/plur1bus/src/install/pins.rs | [Test] Replaces the release minisign key | build-time key | crates/plur1bus/src/install/pins.rs:98 |
| PLUR1BUS_MODULE_API_CURRENT | crates/plur1bus/src/modules/manifest.rs | [Test] Overrides the module API version (n ≥ 1) | `MODULE_API_VERSION` = 1 | crates/plur1bus/src/modules/manifest.rs:4-12 |
| PLUR1BUS_REEMBED_POLL_MS | crates/plur1bus/src/commands/memory_reembed.rs | Poll interval of the re-embed follow loop; honoured only with test internals | `1000` ms | crates/plur1bus/src/commands/memory_reembed.rs:18,26 |
| PLUR1BUS_UPDATE_GATE_TIMEOUT_MS | crates/plur1bus/src/update/host.rs | [Test] Update gate timeout | `90000` ms | crates/plur1bus/src/update/host.rs:8-11 |
| PLUR1BUS_UPDATE_TARGET_BIN | crates/plur1bus/src/update/mod.rs | [Test] Replaces the update target binary | – | crates/plur1bus/src/update/mod.rs:456-457 |
| PLUR1BUS_TEST_UPDATE_KILL_AT | crates/plur1bus/src/update/mod.rs | [Test] Kill point during update | – | crates/plur1bus/src/update/mod.rs:89 |
| PLUR1BUS_TEST_FAIL_RUN_ACL | crates/plur1bus/src/supervisor/mod.rs | [Test] Forces a run-ACL failure | off | crates/plur1bus/src/supervisor/mod.rs:458 |
| PLUR1BUS_TEST_SETUP_PAUSE_AT | crates/plur1bus/src/install/setup.rs | [Test] Pauses setup at the named step | – | crates/plur1bus/src/install/setup.rs:225 |
| PLUR1BUS_TEST_HARNESS_VERSION | crates/plur1bus/src/ext/host.rs | [Test] Overrides the harness version (valid semver) | `CARGO_PKG_VERSION` | crates/plur1bus/src/ext/host.rs:18-22 |
| PLUR1BUS_TEST_EXT_INSPECT_TTL_MS | crates/plur1bus/src/ext/host.rs | [Test] TTL of an extension inspection | 10 minutes | crates/plur1bus/src/ext/host.rs:45 |
| PLUR1BUS_TEST_EXT_FAIL_AT | crates/plur1bus/src/ext/commit.rs | [Test] Fails the extension commit at the named step | – | crates/plur1bus/src/ext/commit.rs:133 |
| PLUR1BUS_TEST_EXT_WORKER_ARGS | crates/plur1bus/src/ext/worker.rs | [Test] Extra worker args per op (`op:args;…`) | empty | crates/plur1bus/src/ext/worker.rs:82 |
| PLUR1BUS_TEST_EXT_WORKER_DEADLINE_MS | crates/plur1bus/src/ext/worker.rs | [Test] Deadline override per op (`op:ms`) | caller default | crates/plur1bus/src/ext/worker.rs:97 |
| PLUR1BUS_TEST_EXT_REVOCATIONS | crates/plur1bus/src/ext/overlays.rs | [Test] Revocation list seam | – | crates/plur1bus/src/ext/overlays.rs:107 |
| PLUR1BUS_TEST_EXT_PUBKEYS | crates/plur1bus-ext/src/trust.rs | [Test] Extra trusted keys (`label=base64`) | pinned set only | crates/plur1bus-ext/src/trust.rs:24,144 |
| PLUR1BUS_TEST_BACKUP_FAIL_AT | crates/plur1bus/src/commands/backup.rs | [Test] Fails the backup at the named step | – | crates/plur1bus/src/commands/backup.rs:167-169 |
| PLUR1BUS_SERVICE_TEST | crates/plur1bus/tests/service_real.rs | [Test] Opt-in for real OS service tests | off | crates/plur1bus/tests/service_real.rs:11 |
| PLUR1BUS_FAKE_SCENARIO | apps/desktop/test-bins/src/lib.rs | [Test] Scenario for the fake plur1bus binary | – | apps/desktop/test-bins/src/lib.rs:39 |
| PLUR1BUS_FAKE_ORIGIN | apps/desktop/test-bins/src/lib.rs | [Test] Origin the fake binary calls | `http://127.0.0.1:18700` | apps/desktop/test-bins/src/lib.rs:107 |
| PLUR1BUS_FAKE_RECORD | apps/desktop/test-bins/src/lib.rs | [Test] File the fake binary records calls to (falls back to `PLUR1BUS_HOME`) | – | apps/desktop/test-bins/src/lib.rs:127-129 |
| PLUR1BUS_LINK_PROBE_FAIL | apps/desktop/src-tauri/tests/build_link.rs | [Test] Forces the link probe to fail | – | apps/desktop/src-tauri/tests/build_link.rs:365 |
| PLUR1BUS_LINK_PROBE_METADATA, PLUR1BUS_LINK_PROBE_AFTER | apps/desktop/src-tauri/tests/build_link.rs (compile-time `env!`) | [Test] Values set by the probe build; purpose unklar – prüfen | – | apps/desktop/src-tauri/tests/build_link.rs:401-402 |

## Other runtime variables

| Variable | Read in | Purpose | Default | Source |
|---|---|---|---|---|
| PATH | packages/core/src/tools/exec/env.ts (allowlist); scripts/run-ts-tests.mjs; crates/plur1bus/tests/service_real.rs | Child-process environment allowlist; pnpm lookup | – | packages/core/src/tools/exec/env.ts:5 |
| LANG, LC_ALL, LC_CTYPE, TZ, TERM | packages/core/src/tools/exec/env.ts | Passed through to exec children (allowlist) | – | packages/core/src/tools/exec/env.ts:5 |
| SystemRoot, SYSTEMROOT | packages/module-api/src/secure-path.ts; packages/core/src/tools/exec/env.ts | Windows system tool path (`<SystemRoot>\System32\…`) | `C:\Windows` | packages/module-api/src/secure-path.ts:43-44 |
| PATHEXT, COMSPEC, TEMP, TMP | packages/core/src/tools/exec/env.ts | Windows child-process allowlist | – | packages/core/src/tools/exec/env.ts:7 |
| HOME | packages/core/src/import/sources/openclaw.ts; apps/desktop/src-tauri/src/discovery.rs; apps/desktop/src-tauri/src/pair.rs | OS home fallback | `homedir()` | packages/core/src/import/sources/openclaw.ts:11; apps/desktop/src-tauri/src/discovery.rs:28; pair.rs:86 |
| USERPROFILE | packages/core/src/import/sources/openclaw.ts; packages/core/src/import/paths.ts; crates/plur1bus/src/coexistence.rs | Windows home fallback | – | packages/core/src/import/sources/openclaw.ts:11; packages/core/src/import/paths.ts:35-38; crates/plur1bus/src/coexistence.rs:91,235 |
| LOCALAPPDATA | packages/core/src/paths.ts; packages/core/src/import/sources/hermes.ts; crates/plur1bus/src/paths.rs; apps/desktop/src-tauri/src/{discovery,pair,windows_spa_profile}.rs | Windows state root | `<home>\AppData\Local` | packages/core/src/paths.ts:13; packages/core/src/import/sources/hermes.ts:26; crates/plur1bus/src/paths.rs:135 |
| APPDATA | packages/core/src/auth/adc.ts | gcloud ADC file location on Windows | `%USERPROFILE%\AppData\Roaming` | packages/core/src/auth/adc.ts:33 |
| GOOGLE_APPLICATION_CREDENTIALS | packages/core/src/auth/adc.ts | Path to ADC credentials file | `~/.config/gcloud/application_default_credentials.json` | packages/core/src/auth/adc.ts:33 |
| XDG_CONFIG_HOME | crates/plur1bus/src/service/systemd.rs | systemd user unit directory (absolute values only) | `~/.config` | crates/plur1bus/src/service/systemd.rs:8-11 |
| XDG_CURRENT_DESKTOP | apps/desktop/src-tauri/src/commands.rs | Desktop environment detection on Linux | `""` | apps/desktop/src-tauri/src/commands.rs:76 |
| FLATPAK_ID | apps/desktop/src-tauri/src/gnome.rs | Detects Flatpak; compared with the app bundle ID | – | apps/desktop/src-tauri/src/gnome.rs:215 |
| DISPLAY, WAYLAND_DISPLAY | packages/core/src/auth/env.ts | Decides whether a graphical browser can open | unset | packages/core/src/auth/env.ts:27 |
| SSH_CONNECTION, SSH_CLIENT, SSH_TTY, CODESPACES, CLOUD_SHELL, GITPOD_WORKSPACE_ID, VSCODE_IPC_HOOK_CLI, REMOTE_CONTAINERS, CLAUDE_CODE_REMOTE | packages/core/src/auth/env.ts | Remote-session markers for the login flow | unset | packages/core/src/auth/env.ts:15 |
| OPENCLAW_HOME | packages/core/src/import/sources/openclaw.ts; crates/plur1bus/src/coexistence.rs | OpenClaw home | OS home-based; see openclaw.ts:5-12 | packages/core/src/import/sources/openclaw.ts:12; crates/plur1bus/src/coexistence.rs:95 |
| OPENCLAW_STATE_DIR | packages/core/src/import/sources/openclaw.ts; crates/plur1bus/src/coexistence.rs | OpenClaw state root | – | packages/core/src/import/sources/openclaw.ts:33; crates/plur1bus/src/coexistence.rs:103,240 |
| OPENCLAW_PROFILE | packages/core/src/import/sources/openclaw.ts; crates/plur1bus/src/coexistence.rs | Profile; resolves to `~/.openclaw-<profile>` | – | packages/core/src/import/sources/openclaw.ts:34-37; crates/plur1bus/src/coexistence.rs:119 |
| OPENCLAW_CONFIG_PATH | packages/core/src/import/sources/openclaw.ts | OpenClaw config file path (non-`--source` case) | – | packages/core/src/import/sources/openclaw.ts:45 |
| HERMES_HOME | packages/core/src/import/sources/hermes.ts | Hermes root; overrides the platform default | platform default | packages/core/src/import/sources/hermes.ts:20 |
| (names copied from the host into MCP stdio children) | packages/core/src/mcp/env.ts; packages/core/src/mcp/stdio.ts | Host variables listed in an MCP server's `fromHost`; copied as secrets | – | packages/core/src/mcp/env.ts:20-26; packages/core/src/mcp/stdio.ts:42 (dynamic key) |
| CI | packages/log-schema/test/parity-fixtures.test.ts | [Test] Regeneration-diff check runs only under CI | unset | packages/log-schema/test/parity-fixtures.test.ts:17 |
| UPDATE_GOLDEN | packages/providers/test/stream-replay.test.ts | [Test] Writes the golden file when `1` | – | packages/providers/test/stream-replay.test.ts:94 |
| UPDATE_SNAPSHOTS | packages/web/test/responsive.test.ts | [Test] Updates snapshots when `1` | – | packages/web/test/responsive.test.ts:17 |
| npm_execpath | scripts/run-ts-tests.mjs | Detects pnpm as the runner | – | scripts/run-ts-tests.mjs:33 |
| SOURCE_DATE_EPOCH | scripts/release/assemble-payload.mjs | mtime for reproducible payload archives | `0` | scripts/release/assemble-payload.mjs:153 |
| GITHUB_ACTIONS | apps/desktop/scripts/windows-libtest-loader.mjs | Guard: runs only on GitHub Actions Windows | – | apps/desktop/scripts/windows-libtest-loader.mjs:388 |
| GITHUB_STEP_SUMMARY | apps/desktop/scripts/windows-focus-summary.mjs | Appends the Markdown job summary | – | apps/desktop/scripts/windows-focus-summary.mjs:43,47 |
| RUNNER_TEMP | apps/desktop/scripts/windows-libtest-loader.mjs; windows-startup.test.mjs; transport-spike.mjs | Temporary root on runners | `os.tmpdir()` | apps/desktop/scripts/windows-libtest-loader.mjs:391; windows-startup.test.mjs:662 |
| SystemRoot, SYSTEMROOT (tests) | apps/desktop/scripts/windows-startup.test.mjs; crates/plur1bus/tests/{daemon,repair,firstaid,windows}.rs | [Test] Windows system directory | `C:\Windows` (Rust tests) | apps/desktop/scripts/windows-startup.test.mjs:475 |
| P1B_PEER_LISTEN | crates/plur1bus-rpc/tests/client.rs | [Test] Peer listen path | – | crates/plur1bus-rpc/tests/client.rs:516 |
| P1B_NOT_DECLARED, AMBIENT_TOKEN, EXPLICIT, MCP_TEST_SECRET | packages/core/test/mcp/*.ts | [Test] Secret-leak checks for MCP child env | – | packages/core/test/mcp/secrets.test.ts:20; stdio-hardening.test.ts:42 |
| FIXTURE_WEDGE, FIXTURE_STARTUP_MS | packages/core/test/mcp/helpers/fixture-stdio.ts | [Test] Fixture behaviour (wedge, startup delay) | `0` | packages/core/test/mcp/helpers/fixture-stdio.ts:7,11 |
| WP05_NATIVE_SCRATCH | apps/desktop/src-tauri/examples/production_spa.rs | [Test] Scratch directory (required) | – (unwrap) | apps/desktop/src-tauri/examples/production_spa.rs:2299,2765 |
| WP06_CRASH_CHILD_DIR, WP06_CRASH_CHILD_BLOCKED | apps/desktop/src-tauri/tests/crash.rs | [Test] Crash-child directory and blocked flag | – | apps/desktop/src-tauri/tests/crash.rs:23,26 |
| RUSTC, TARGET | apps/desktop/src-tauri/tests/build_link.rs | [Test] Compiler and target for the link probe | required | apps/desktop/src-tauri/tests/build_link.rs:374-376 |
| CARGO_MANIFEST_DIR, OUT_DIR, CARGO_CFG_TARGET_OS, CARGO_CFG_TARGET_ENV, CARGO_BIN_EXE_*, CARGO_PKG_VERSION | build.rs files; Rust `env!` sites | Build-time values provided by cargo (not runtime) | – | apps/desktop/src-tauri/build.rs:17-19; crates/plur1bus-rpc/build.rs:55,110 |

## Nur CI/Workflows (zur Info)

These variables are set or read by `.github/workflows/*.yml`. They are not runtime inputs of the product. Some overlap with the PLUR1BUS_* table where scripts read them.

| Variable | Workflow | Purpose | Source |
|---|---|---|---|
| GH_ENGINE_READ_TOKEN (secret) | ci.yml, container.yml, harness-release.yml, hermes-host.yml, nightly.yml, release.yml | Read token for the private engine dependency; git URL rewrite when set | .github/workflows/ci.yml:47 |
| PLUR1BUS_BIN | ci.yml, nightly.yml | Binary under test | .github/workflows/ci.yml:141,147,153,274 |
| PLUR1BUS_CI_RECALL_HARD_MS | ci.yml, nightly.yml | Recall latency budget (shared runners) | .github/workflows/ci.yml:141 |
| PLUR1BUS_EXT_FIXTURES | ci.yml | Extension fixture directory | .github/workflows/ci.yml:141 |
| PLUR1BUS_SYSTEM_INTERNALS | ci.yml | Selects the `flat-embedder-cold` system-internals mode | .github/workflows/ci.yml:147 |
| PLUR1BUS_SOAK_TURNS | ci.yml, nightly.yml | Soak-test turn count (200 in CI, 1000 nightly) | .github/workflows/ci.yml:153; nightly.yml:72 |
| PLUR1BUS_SOAK_RECALL_BUDGET_MS | nightly.yml | Recall budget for the soak test (3000) | .github/workflows/nightly.yml:72 |
| PLUR1BUS_SOAK_SEED | ci.yml | Soak seed | .github/workflows/ci.yml:149 |
| PLUR1BUS_SERVICE_TEST | ci.yml | Enables the real service test | .github/workflows/ci.yml:198 |
| PLUR1BUS_LIVE_REQUIRED | ci.yml | Live tests must run (not skip) | .github/workflows/ci.yml:277 |
| PLUR1BUS_REAL_MODELS | nightly.yml | Use real models | .github/workflows/nightly.yml:3,62 |
| PLUR1BUS_MODELS_CACHE | nightly.yml | Model cache directory (`${{ github.workspace }}/.models-cache`) | .github/workflows/nightly.yml:5,25 |
| PLUR1BUS_FUZZ_SEED | nightly.yml | Fuzz seed | .github/workflows/nightly.yml:82 |
| PLUR1BUS_FUZZ_SECONDS | nightly.yml | Fuzz duration (600 s) | .github/workflows/nightly.yml:92 |
| PLUR1BUS_CI_HEAD_SHA | desktop.yml | Head SHA written into desktop reports | .github/workflows/desktop.yml:71,240 |
| PLUR1BUS_DESKTOP_MATRIX_RESULT | desktop.yml | Desktop matrix result for the focus summary | .github/workflows/desktop.yml:241 |
| PLUR1BUS_DESKTOP_E2E_RUNTIME | desktop.yml | Runtime for the E2E matrix entry | .github/workflows/desktop.yml:265 |
| PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY | desktop.yml | Set to `1` for desktop test builds | .github/workflows/desktop.yml:69,300 |
| PLUR1BUS_DESKTOP_COOKIE_GUARD | desktop.yml | Cookie-guard matrix value | .github/workflows/desktop.yml:70,301 |
| PLUR1BUS_LIFECYCLE_REPORT | desktop.yml | Lifecycle report output path | .github/workflows/desktop.yml:96 |
| PLUR1BUS_ALLOW_TEST_INTERNALS | hermes-host.yml | Set to `1` for the Hermes host job | .github/workflows/hermes-host.yml:97 |
| PLUR1BUS_TEST_INTERNALS | hermes-host.yml | `flat-embedder` test seam | .github/workflows/hermes-host.yml:98 |
| PLUR1BUS_SERVICE_FAKE | hermes-host.yml | Fake service directory | .github/workflows/hermes-host.yml:127,158 |
| PLUR1BUS_RELEASE_BASE_URL (var) | harness-release.yml | Release base URL (repo variable) | .github/workflows/harness-release.yml:90,248 |
| PLUR1BUS_RELEASE_PUBKEY_STABLE (var) | harness-release.yml | Stable minisign key (repo variable) | .github/workflows/harness-release.yml:246 |
| PLUR1BUS_RELEASE_PUBKEY_BETA (var) | harness-release.yml | Beta minisign key (repo variable) | .github/workflows/harness-release.yml:247 |
| PLUR1BUS_CORE_SHA256 | harness-release.yml | Core payload SHA-256 checked before release | .github/workflows/harness-release.yml:256-261 |
| MACOS_SIGNING_IDENTITY (var) | harness-release.yml | codesign identity | .github/workflows/harness-release.yml:336 |
| MACOS_CERT_P12, MACOS_CERT_PASSWORD (secrets) | harness-release.yml | Signing certificate import | .github/workflows/harness-release.yml:311-312 |
| APPLE_API_KEY_P8, APPLE_API_KEY_ID, APPLE_API_ISSUER (secrets) | harness-release.yml | Notarization API key | .github/workflows/harness-release.yml:345-347 |
| GITHUB_TOKEN (secret) | nightly-report.yml | `GH_TOKEN` for `gh` | .github/workflows/nightly-report.yml:18 |
| GH_REPO, WORKFLOW, RUN_URL | nightly-report.yml | Set from the triggering workflow run | .github/workflows/nightly-report.yml:19-21 |
| P1B_HOME, P1B_BIN, P1B_CORE_PAYLOAD, HH, HERMES_DIR, FAKE_HOME, E2E | hermes-host.yml | Job-internal paths written to GITHUB_ENV | .github/workflows/hermes-host.yml:121-126,156 |
| HERMES_HOME, HERMES_BIN | hermes-host.yml | Hermes install location | .github/workflows/hermes-host.yml:182-223 |
| GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0 | ci.yml, desktop.yml, hermes-host.yml | Rewrites `git@github.com:` to HTTPS | .github/workflows/ci.yml:262-265; desktop.yml:73-75; hermes-host.yml:141-144 |
| GIT_CONFIG_GLOBAL | hermes-host.yml | Separate global git config for Hermes install | .github/workflows/hermes-host.yml:236 |
| PYTHONDONTWRITEBYTECODE | ci.yml, harness-release.yml, hermes-host.yml | Prevents `.pyc` output | .github/workflows/ci.yml:213 |
| SOURCE_DATE_EPOCH | container.yml, harness-release.yml | Reproducible build timestamp (`0`) | .github/workflows/container.yml:72; harness-release.yml:128 |
| IMAGE, SIZE_TARGET_MB | container.yml | Image tag and compressed size target (350 MB) | .github/workflows/container.yml:50,52 |
| INPUT_VERSION, INPUT_CHANNEL, DRY_RUN | harness-release.yml, release.yml | Workflow-dispatch inputs | .github/workflows/harness-release.yml:87-89; release.yml:57-58 |
| BASE_SHA | ci.yml, desktop.yml, hermes-host.yml | PR base SHA for change detection | .github/workflows/ci.yml:33 |
| XDG_RUNTIME_DIR | ci.yml | Set after `loginctl enable-linger` on Linux | .github/workflows/ci.yml:189 |
| GITHUB_ENV, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, GITHUB_WORKSPACE, RUNNER_TEMP, RUNNER_OS, RUNNER_ARCH | all workflows | GitHub-provided runner variables | .github/workflows/ci.yml:183 (example) |

## Unsichere Stellen

1. Injizierte Env-Objekte (`env[...]`, `o.env`, `hostEnv`) und dynamische Namen (`process.env[k]`, `process.env[name]`) lassen sich per grep nicht vollständig erfassen. Die daraus folgenden Einträge wurden von Hand nachverfolgt.
2. Der Rust-Default von PLUR1BUS_FUZZ_SEED und der OPENCLAW_HOME-Default sind nicht verifiziert.
3. PLUR1BUS_LINK_PROBE_METADATA / _AFTER und PLUR1BUS_DESKTOP_E2E_RUNTIME haben Zwecke, die als "unklar – prüfen" markiert sind.
4. Ausgeschlossene Falschtreffer: der String `"TERM"` in packages/core/src/host-tools/proc.ts:204 (ein Signalname), die Wörter `DEBUG` und `CI` in crates/plur1bus-log-schema/src/lib.rs:89 und crates/plur1bus-rpc/src/acl.rs:73 (keine Env-Lesezugriffe), sowie `NODE_VERSION` in scripts/build-hermes-provider.mjs:85 (Regex-Label).
5. PLUR1BUS_*- und CI-Variablen, die Testcode unter anderen Namen über Hilfsfunktionen liest, wurden nur über direkte Grep-Treffer verfolgt.
