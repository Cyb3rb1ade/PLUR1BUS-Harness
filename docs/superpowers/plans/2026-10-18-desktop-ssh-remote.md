# Desktop SSH remote: install and manage PLUR1BUS on a remote host — implementation plan

**Goal.** The desktop app adds, installs, manages and opens a native PLUR1BUS harness on a Linux host over SSH, as
specified in [`2026-10-18-desktop-ssh-remote-design.md`](../specs/2026-10-18-desktop-ssh-remote-design.md) (cited as
"spec §n").
**Architecture.** A new desktop workspace crate `plur1bus-desktop-ssh` (russh session, host-key policy, auth, closed
remote command set, tunnel connector) used by `src-tauri` through new native commands; profiles in `ssh-hosts.json`,
secrets only in the OS keychain; installation and management drive the existing harness CLI (`setup`, `update`,
`uninstall`, `daemon`, `1staid`) with `--json`; the SPA reaches the server's loopback API through in-process
`direct-tcpip` channels.
**Status.** Q1–Q5 decided 2026-10-18 (D113, spec §12). S0 is partial: the ring-only research executable is not linked into the app; direct RSA and the full-workspace audit remain blocked. See `../../handoff/status/2026-10-18-dssh-s0.md`. WP1 waits for S0 acceptance and a policy-compliant resolution of RSA.
**Constraints.** Desktop rules from `AGENTS.md`: exact-pinned direct dependencies, `--locked`, no shell/fs/http/dialog/
opener plugins, native commands with capabilities and origin checks, no tokens in JS or files, scratch state and
injected seams in tests, no real keychain or personal runtime. Desktop Green gate per `AGENTS.md`. No harness RPC, API or pairing-policy change in these WPs. P1–P3 remain M3-owned; **WP4 includes the additive Harness/CLI offline Node input P5**, required by owner Q3 (spec §9). No CI polling,
force-push, rebase, amend or stash.

## Review focus

1. No secret (password, passphrase, sudo input, private key, pairing code, device token) in any file, log line, event,
   IPC response, argv or environment variable.
2. A changed host key can never be bypassed; first-contact confirmation happens before any authentication.
3. Remote commands are only the closed enum; every argument passes the quoting-free charset check; scripts go via
   stdin to `/bin/sh -s`.
4. Release bytes are installed only after the desktop verified the signed feed **and** the server-side SHA-256 matches.
5. `authorized_keys` editing touches only the app's own line, is idempotent, and is rolled back when the key turns out
   not to work.
6. The tunnel offers no listening socket in the preferred mode; the fallback is secret-gated and loopback-only.

## Dependencies and order

```text
S0 spike ──► WP1 ssh core ──► WP2 profiles + keys ──► WP3 IPC + UI ──► WP4 install/manage ──► WP6 CI + docs
                                   │                                       │
                                   └──────────────► WP5 connect (gated by M3 P1–P3) ◄┘
WP7 later options (macOS remote, ssh_config import, native secret prompts)
```

One branch and one **ready** PR per phase, including stacks (owner 2026-10-18). Branches H–M/T use `codex/ssh-s0-spike`, `ssh-wp1-core`, `ssh-wp2-hosts`, `ssh-wp3-ui`, `ssh-wp4-install`, `ssh-wp5-connect`, `ssh-wp6-ci-docs` under `codex/`. Each starts from fresh `origin/main`, or cleanly stacks on its predecessor with that branch as base and `Stacked on #N` in the PR body. Never Draft; never copy code from open branches. Großpaket 1 A–G must be open/merged before implementation after H (Q inventory is the other exception).

---

## S0 — Spike and dependency record (≈ 2 agent days)

**Purpose.** Prove the pinned `russh` on all five desktop targets before product code depends on it, and record the
exact version and features for the owner's dependency approval (Q2).

**Files.**
- `apps/desktop/transport-spike/`: research-only executable `plur1bus-ssh-spike`, not linked into the app; no personal keychain/agent/runtime. Exact pins and the desktop lockfile, with RSA omitted while its no-fix advisory is unresolved.
- `docs/handoff/status/2026-10-18-dssh-s0.md`: results table and decision.

**Checks (each a recorded yes/no per target).**
- Build with `ring` backend on macOS arm64, Windows x64/arm64, Linux x64/arm64; `cargo deny` / licence check.
- Ed25519, ECDSA P-256 and RSA (rsa-sha2-256/512) client auth; encrypted OpenSSH key with passphrase.
- Agent client: Unix socket (`SSH_AUTH_SOCK`), Windows `\\.\pipe\openssh-ssh-agent`, 1Password socket on macOS,
  Pageant (optional); `sk-ssh-ed25519@openssh.com` identities through an agent (expected: document the outcome).
- known_hosts parsing including hashed `|1|` entries (crate helper or own parser).
- `direct-tcpip` as the transport of (a) a `reqwest`/hyper request, (b) an SSE stream with first-event latency, (c) a
  `tokio-tungstenite` WebSocket — through the existing SPA proxy upstream path; p95 overhead on a LAN host.
- Nested session over `direct-tcpip` (jump host).
- Supported kex/cipher/MAC list against OpenSSH 8.9 (Ubuntu 22.04) and 9.6 (Ubuntu 24.04).

**Acceptance.** Status doc lists version, features, licence, binary size delta, every check per target, and the
transport decision (in-process connector vs. fallback listener, spec §7.1). No product code merged. **RSA, five-target, OpenSSH and proxy-transport evidence are gates, not inferred from the local fixture.**

---

## WP1 — SSH core crate (≈ 5 agent days)

**Purpose.** All SSH mechanics in one testable crate with no Tauri dependency.

**Files.**
- `apps/desktop/ssh/Cargo.toml` — new workspace member `plur1bus-desktop-ssh`; `apps/desktop/Cargo.toml` members,
  `apps/desktop/Cargo.lock`.
- `apps/desktop/ssh/src/lib.rs` — public API (`Session`, `SessionConfig`, `HostKeyPolicy`, `AuthMethod`,
  `RemoteCommand`, `ExecOutcome`, `Tunnel`).
- `src/session.rs` — connect, keepalive (15 s × 3), close; optional single jump host.
- `src/host_key.rs` — fingerprint (`SHA256:` base64, no padding), decision `Unknown | Match | Changed`, algorithm
  preference, known_hosts reader (plain + hashed; read-only).
- `src/auth.rs` — password, keyboard-interactive (single password prompt or verbatim prompts), key file (load +
  passphrase), agent (socket/pipe; pinned key fingerprint), in-memory key; one method per attempt.
- `src/secret.rs` — `SecretString` reuse or thin wrapper over the app's existing type (zeroize, redacted Debug/Display,
  no `Serialize`).
- `src/command.rs` — `RemoteCommand` enum, rendering, charset validator `[A-Za-z0-9._/:=@+-]`, stdin scripts for
  `/bin/sh -s`, per-command timeout and output caps.
- `src/scripts/` — `enroll_key.sh`, `remove_key.sh`, `install_binary.sh` as `include_str!` POSIX `sh` scripts.
- `src/exec.rs` — exec channel with bounded stdout/stderr, stdin streaming (upload), cancel → close + signal.
- `src/tunnel.rs` — `direct-tcpip` connector usable by hyper/reqwest and tokio-tungstenite (shape from S0).
- `apps/desktop/ssh/tests/support/server.rs` — in-process russh server fixture (scripted exec handlers, direct-tcpip
  to a local echo/HTTP server, configurable host key, password/pubkey/kbd-interactive acceptance, test agent).

**Tests (`apps/desktop/ssh/tests/`).**
- `host_key.rs`: first contact returns `Unknown` and authenticates nothing; confirm → `Match`; other key → `Changed`
  aborts before auth; known_hosts plain/hashed/multiple-keys/port syntax `[host]:port`; `ssh-rsa` SHA-1 and DSA refused.
- `auth.rs`: each method succeeds against the fixture; wrong password → one failure, no retry spray; encrypted key
  with wrong passphrase; agent with pinned fingerprint ignores other keys; kbd-interactive OTP prompt surfaced verbatim.
- `command.rs`: every enum variant renders to a fixed golden string; table of refused arguments (space, quote, `$`,
  backtick, `;`, newline, non-ASCII, empty, > 255 bytes); home path outside charset → `unsupported-home-path`.
- `exec.rs`: caps truncate and flag; timeout kills; cancel closes channel; stdin upload of 10 MiB with SHA-256 match.
- `tunnel.rs`: HTTP GET/POST, SSE first event unbuffered, WebSocket echo, 50 parallel connections, channel refused
  (server `permitopen` denial) surfaces as `tunnel-refused`.
- `jump.rs`: second host key checked independently; jump `Changed` aborts the whole chain.
- `secrets.rs`: Debug/Display of every type holding a secret prints `***`; no `Serialize` impl (compile-fail doc test).

**Acceptance.**
- Desktop Green for the workspace (fmt, clippy debug all-targets and release, `cargo test --offline --locked
  --workspace -- --test-threads=1`).
- No Tauri, no filesystem write, no network except the session's socket in this crate.
- The crate's public API takes no free-form command string.

---

## WP2 — Host profiles, host keys and key management (≈ 4 agent days)

**Purpose.** Durable public metadata, keychain-held secrets, key generation, enrollment and removal.

**Files.**
- `apps/desktop/src-tauri/src/ssh_hosts.rs` — `ssh-hosts.json` store: version 1, closed schema, UUIDv7 ids, atomic
  `0600` writes, `.corrupt-<ms>-<uuid>` handling, serialized mutations under the existing connection mutex.
- `apps/desktop/src-tauri/src/ssh_keys.rs` — Ed25519 generation, OpenSSH serialization in memory, keychain account
  `ssh-key-<profile uuid>` via the existing `secrets.rs` store abstraction; refuse on memory-only stores.
- `apps/desktop/src-tauri/src/ssh_enroll.rs` — `EnrollKey` / `RemoveKey` orchestration: password session → append →
  verify with key-only session → rollback on failure; removal by full public key.
- `apps/desktop/src-tauri/src/ids.rs` — keychain account prefix, file names.
- `apps/desktop/src-tauri/src/connections.rs` — in-memory `Kind::Ssh` (never serialized into `connections.json`).

**Tests (`apps/desktop/src-tauri/tests/`).**
- `ssh_hosts_store.rs`: round trip; unknown field / unknown version / duplicate id → corrupt file kept, store empty;
  `connections.json` byte-identical after adding/removing SSH hosts (downgrade safety); concurrent mutations serialized.
- `ssh_keys.rs`: generated key lands only in the injected store; no file in the scratch dir contains private-key
  material; memory-only store refuses generation with the WP9-style reason; deletion order (keychain first, then
  metadata; denied deletion keeps the row and the obligation).
- `ssh_enroll.rs` (against the WP1 fixture with a real `sh` handler): first enrollment adds exactly one line with the
  options and comment; second run adds nothing; existing foreign lines preserved byte-for-byte; missing `~/.ssh`
  created `0700`, file `0600`; key-only verification failure removes the line again and reports
  `key-enrollment-not-effective`; removal deletes only the matching key even when the comment was edited.
- `known_hosts_import.rs`: import offers the matching entry, never writes the file.

**Acceptance.**
- `ssh-hosts.json` contains no secret (test greps the file for the generated private key, the password and any
  base64 block longer than a public key).
- Every keychain access goes through the existing store abstraction; tests use injected stores only.

---

## WP3 — Native commands and shell UI (≈ 5 agent days)

**Purpose.** The person can add, confirm, authenticate and remove hosts from the GUI.

**Files.**
- `apps/desktop/desktop-contract/src/lib.rs` — new command names in the shared command table (ACL generation):
  `ssh_hosts_list`, `ssh_host_add`, `ssh_host_update`, `ssh_host_remove`, `ssh_host_probe`, `ssh_hostkey_confirm`,
  `ssh_hostkey_forget`, `ssh_secret_submit`, `ssh_key_generate`, `ssh_key_revoke`, `ssh_operation_cancel`.
- `apps/desktop/src-tauri/src/ssh_commands.rs` — handlers: closed serde structs with `deny_unknown_fields`, label +
  exact bundled origin check, profile ids and enums only; secret request/submit with Rust-issued nonces (spec §5.3).
- `apps/desktop/src-tauri/capabilities/shell-ui.json` — generated grants (no plugin permissions).
- `apps/desktop/ui/src/views/ssh-hosts/*.ts` — host list, add-host wizard (address/user/auth → fingerprint confirm →
  secret prompt → result), host detail with key actions; `ui/src/models/ssh-model.ts`; `ui/src/ipc.ts` bindings.
- `apps/desktop/ui/src/i18n/{en,de}` — strings for every state and error code.

**Tests.**
- Rust: command ACL test (only the `shell` webview at the bundled origin; approvals window and SPA refused); input
  validation table (host as IDN/IP/garbage, user charset, port range, key path outside home/symlink/world-readable);
  `ssh_secret_submit` without a live request or with a reused nonce refused; secret never echoed in any response.
- Browser suite (existing Playwright harness, injected test transport): wizard happy path; changed-key state shows both
  fingerprints and offers no connect; *Forget host key* needs typed host name; password field cleared after submit and
  absent from page state snapshots; axe light/dark DE/EN; 44 px targets; 400 px layout; keyboard-only flow.

**Acceptance.**
- `node scripts/lint-hygiene.mjs` and `node scripts/check-i18n.mjs` pass; no new Tauri plugin in `Cargo.toml` or
  capabilities.
- A host can be added with each auth method against the fixture via the UI test transport.

---

## WP4 — Remote install, update, rollback, uninstall (≈ 6 agent days)

**Purpose.** Spec §6: probe, plan, transfer, `setup`, linger/sudo, health, management actions, journal and logs.

**Files.**
- `apps/desktop/src-tauri/src/ssh_remote/mod.rs` — per-host operation runner (one at a time, `busy`), progress events,
  cancellation.
- `ssh_remote/probe.rs` — read-only probe → `{ target, blockers[], warnings[], existing? }`; reasons
  `unsupported-os`, `unsupported-arch`, `unsupported-libc`, `no-systemd-user`, `unsupported-home-path`, `low-disk`.
- `ssh_remote/feed.rs` — reuse `updates.rs` verification to get `native.binary[target]` from the verified feed bytes;
  no second verifier.
- `ssh_remote/transfer.rs` — server fetch (fixed curl/wget args, size cap, https-only) and mandatory SFTP upload (local download +
  verify, explicit offsets and resumable transfers); server-side SHA-256 compare before `mv`.
- `ssh_remote/setup.rs` — `setup --non-interactive --json` with enum-validated flags; parse `setup/1`; stderr into the
  operation log.
- `ssh_remote/linger.rs` — status, enable without sudo, sudo path (`sudo -n true`, then `sudo -S -p ''` with stdin),
  `requiretty` retry in a pty password session, *continue without* warning state.
- `ssh_remote/manage.rs` — daemon/service/1staid/update/rollback/status/uninstall commands per spec §6.6; diagnostics
  bundle download and remote deletion.
- `ssh_remote/journal.rs` — `ssh-journal.jsonl` (owner-only, bounded, rotated) per spec §8.4.
- `apps/desktop/src-tauri/src/logging/` — SSH redaction fixtures added to the existing formatter tests.
- Contract additions in `desktop-contract`: `ssh_install_plan`, `ssh_install_run`, `ssh_manage` (closed action enum),
  `ssh_update_check`, `ssh_update_apply`, `ssh_update_rollback`, `ssh_uninstall_plan`, `ssh_uninstall_run`,
  `ssh_diagnostics_fetch`.
- UI: `ui/src/views/ssh-hosts/install.ts`, `manage.ts`, `update.ts`, `uninstall.ts` with progress, plan and
  confirmation dialogs (typed host name for purge).

**Tests.**
- Fixture-driven (WP1 server + `test-bins/fake-plur1bus` scenarios via `PLUR1BUS_FAKE_SCENARIO`): probe matrix
  (Debian/Ubuntu/Fedora os-release, aarch64/x86_64, musl, no systemd, non-charset home, low disk); feed hash mismatch on
  server → nothing moved, temp file removed; upload mode with corrupted stream → refused; `setup/1` with
  `after-failure` → retry path; re-run on an installed host skips the binary and reports *Repair*; linger yes/no/refused
  + sudo NOPASSWD / password / wrong password / `requiretty`; update `update.apply/1` success and automatic rollback
  outcome rendered; uninstall dry-run plan shown before run; purge requires typed confirmation; cancel during transfer
  leaves no `plur1bus.tmp-*`.
- Argv audit: the fake binary records argv (`PLUR1BUS_FAKE_RECORD`); a test asserts no recorded argv or environment
  contains the password, sudo password or any key material.
- Journal: every operation writes exactly one start and one end record; journal file contains no secret.
- Browser suite: install progress, failure + retry, linger warning card, update plan, rollback and uninstall
  confirmations; axe.

**Acceptance.**
- **Offline gate (owner Q3, 2026-10-18):** desktop verifies and uploads release plus the matching Node runtime; additive offline Node input P5 in Harness/CLI; remote host egress blocked; real setup succeeds without internet. No mock proves this gate.
- Against the OpenSSH container (WP6) with a real `sh`: install of the fake binary is idempotent (second run changes
  nothing on the server: file hashes and `authorized_keys` unchanged).
- No `sudo` invocation outside `linger.rs` (static test over the command enum).

---

## WP5 — Connect: tunnel and pairing over SSH (≈ 4 agent days, gated by M3 P1–P3)

**Purpose.** Spec §7: open the remote harness SPA through the in-process tunnel; pair with the native-attach command
over SSH.

**Files.**
- `apps/desktop/src-tauri/src/client.rs` — transport abstraction `Direct | SshTunnel(profile)`; origin checks unchanged.
- `apps/desktop/src-tauri/src/spa_proxy.rs` — upstream through the WP1 connector for SSH connections (HTTP, SSE, WS).
- `apps/desktop/src-tauri/src/ssh_connect.rs` — `ReadApiJson` (≤ 8 KiB, closed schema, loopback + D72 port range),
  `/api/v1/meta` + `installationId` check, `DevicePair` over SSH with fixed argv, redeem through the tunnel, keychain
  store `device-<connection uuid>`, reconnect with backoff, password profiles prompt instead of silent reconnect.
- `apps/desktop/src-tauri/src/pair.rs` — reuse of the native-attach output parsing (8192-byte cap, no output in errors).
- `desktop-contract`: `ssh_connect`, `ssh_disconnect`; existing `open_connection` accepts SSH connection ids.
- UI: *Open* button state per host (disabled with reason while P1–P3 are missing, feature-detected through `/meta`
  capabilities and the CLI's `device pair` presence).

**Tests.**
- Mock harness (`apps/desktop/mock-harness`) behind the WP1 fixture's `direct-tcpip`: pair → redeem → ticket → SPA
  load; SSE and WS through the proxy; `installationId` change → no token sent, re-pair offered; revoked token → keychain
  entry deleted, pairing state; SSH drop → reconnect with backoff, SPA error page with retry.
- `run/api.json` refusal table: non-loopback host, https, out-of-range port, oversize, extra fields.
- Secrets-never-leave over the full flow (password login → pairing → SPA open): password, pairing code and device token
  absent from every IPC payload, event, log line, journal record and metadata file.
- No listening socket opened in the preferred mode (test enumerates the process's listeners on Linux CI).

**Implementation gate:** do not start WP5 until M3 P1–P3 (Großpaket 1 F) are on main. WP3 ships the disabled Open control in the meantime.

**Acceptance.**
- With the mock harness: the SPA opens logged in through an SSH host with each auth method.
- With the real harness: after P1–P3 are on main, pair end-to-end with a ten-minute single-use claim; expired claims fail. No claim that a mock flow closes the real pairing gate.

---

## WP6 — CI, real-install e2e and documentation (≈ 3 agent days)

**CI gate (owner 2026-10-18):** `desktop-ssh-e2e`, budget at most 15 minutes; trigger only for `apps/desktop/**`, Harness install code and setup changes. Record the gating-vs-advisory rationale in the PR; a real offline no-egress install is required. Do not poll CI.

**Files.**
- `apps/desktop/ssh-test-server/Dockerfile` (digest-pinned Debian base, `openssh-server`), `entrypoint.sh` (generates
  host and user keys at start into a temp volume, prints public data only), `README.md`.
- `apps/desktop/scripts/ssh-e2e.mjs` — starts one or two containers (jump host case) with unique `p1t-` names and
  labels, runs the Rust e2e tests against them, removes only its own labelled objects; `--dry-run` prints the plan.
- `.github/workflows/desktop.yml` — Linux job `ssh-openssh` (gating within the desktop workflow once stable);
  `ssh-real-install` job as `workflow_dispatch` + nightly, non-gating: runner `sshd` on loopback, throwaway user,
  `loginctl enable-linger`, locally built `plur1bus` release binary, `file://` feed signed with a throwaway key via
  the debug-only feed-key seam.
- `docs/desktop.md` — section *Remote hosts over SSH* (boundaries, storage, seams, commands).
- User guide text (add host, fingerprint, authentication, linger, offline mode, uninstall) goes in the **PR body as a DE/EN template for agy**. Do not edit `docs/user/{de,en}/` or the help bundle.
- `docs/demos/d1.md` (owner worksheet from #504) — rows for the SSH flow, NOT RUN until executed.
- `docs/handoff/status/desktop-shell.md` — SSH rows in the status record.

**Tests / acceptance.**
- `ssh-openssh` job green on Linux x64 (and arm64 runner if available) with real OpenSSH 9.x: algorithms, password,
  kbd-interactive, `restrict` + `permitopen` effective (a forward to a non-loopback address is refused), changed host
  key hard stop, jump host.
- `ssh-real-install` run recorded once by the controller: install → status → update → rollback → uninstall →
  reinstall; result in the status doc (not polled by implementers).
- No private key in any committed file; `node scripts/lint-hygiene.mjs --self-test` passes.

---

## WP7 — Later options (not scheduled)

- **macOS arm64 remote** (spec §3.1): probe, launchd user agent via `plur1bus service install`, owner decision on
  boot persistence (LaunchDaemon vs. auto-login), `shasum` path, Remote Login detection.
- **`~/.ssh/config` import** of `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump` for one alias, read-only, no
  `ProxyCommand`/`Match`.
- **Native secret prompts** on macOS/Windows (spec §5.3, Q4 alternative).
- **Remote container install** (spec §11).
- **Multi-hop jump chains.**

---

## Effort and gates

| WP | Est. (agent days) | Gate |
|---|---|---|
| S0 | 2 | Q2 approved 2026-10-18; full S0 acceptance including RSA/audit remains open |
| WP1 | 5 | S0 accepted, Q2 approved |
| WP2 | 4 | WP1 |
| WP3 | 5 | WP2, Q4 answered |
| WP4 | 6 | WP3; Q3 decided: offline release + Node upload and P5 are mandatory gates |
| WP5 | 4 | WP3 + M3 P1–P3 for the real harness (Q5) |
| WP6 | 3 | WP4 (WP5 rows added when it lands) |

Total ≈ 29 agent days for S0–WP6.

## Open points carried from the spec

- P1–P3 stay with M3 (open #581 at inventory); P4 stays with installer work. P5 is part of WP4 by owner Q3. Direct RSA is blocked by RUSTSEC-2023-0071; no silent exception or narrowed acceptance.
- Per-distro polkit behaviour of `loginctl enable-linger` without sudo is unverified; WP6's real-install job and the
  owner's VMs (Ubuntu 22.04/24.04, Debian 12, RHEL-family) provide the evidence.
- FIDO (`sk-`) keys through agents and Pageant support depend on S0's findings.
