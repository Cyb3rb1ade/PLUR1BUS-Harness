# Desktop: install and manage PLUR1BUS on a remote host over SSH — design

**Status:** Owner decisions Q1–Q5 decided 2026-10-18 (D113); S0 partial; agent-only RSA decision verified, remaining audit/acceptance gates open; transport choice (Tailscale/direct) added by owner decision 2026-10-21, §13 · **Date:** 2026-10-18 ·
**Owner:** Christian (Cyb3rb1ade) · **Track:** D (desktop), follow-up to D1 · **Plan:**
[`2026-10-18-desktop-ssh-remote.md`](../plans/2026-10-18-desktop-ssh-remote.md)

**Owner request (2026-10-18, verbatim):** „PLUR1BUS auf meinem Mac oder Windows-PC als GUI installieren und von der GUI
aus – unter Angabe von SSH-Zugangsdaten, mit Passwortabfrage oder dauerhaft gespeichert mit Anmeldung über
OpenSSH-Keys – auf einem entfernten Rechner installieren/verwalten.“

**Inputs read for this spec** (state of `origin/main` @ `8ddd9010`, plus the open desktop PRs #502 and #504):
`AGENTS.md` (*Desktop shell*), [`docs/desktop.md`](../../desktop.md), the desktop design spec
[`2026-09-27-desktop-app-design.md`](2026-09-27-desktop-app-design.md) (§6.1, §6.2, §6.9, §6.15.11, DS22),
[`docs/handoff/2026-09-30-desktop-shell-codex.md`](../../handoff/2026-09-30-desktop-shell-codex.md),
[`docs/remote-access.md`](../../remote-access.md) and `packages/remote-access`, [`docs/identity.md`](../../identity.md),
[`docs/module-guide.md`](../../module-guide.md) §12 (`setup`), [`docs/cli.md`](../../cli.md) (`setup`, `update`,
`uninstall`, `daemon`, `service`, `device`), `scripts/install/install.sh`, [`docs/reboot-survival.md`](../../reboot-survival.md),
[`docs/api.md`](../../api.md), and the D1 phase 3/4 status of #502/#504 (`docs/handoff/status/2026-10-15-d1-p3.md`,
`…-d1-p4.md` on those branches).

## 1. Goal and non-goals

**Goal.** The desktop app (macOS, Windows, Linux) gets a fourth way to reach a harness: **a host reached over SSH**. From
the GUI the person adds a host (address, user, authentication), confirms the host key, and can then:

1. **install** PLUR1BUS natively on that host (verified release binary + the existing `plur1bus setup`), including the
   OS service;
2. **manage** it: status, start/stop/restart, `1staid check`, update with automatic rollback, manual rollback,
   uninstall (with or without data);
3. **use** it: open the harness SPA in the app window exactly like any other connection, with the harness API staying
   loopback-only on the server.

Several hosts are kept as profiles. Credentials are either asked for each time (password) or stored durably as an
OpenSSH key whose private half lives only in the OS keychain.

**Non-goals (this design).**

- No new harness exposure mode. `remote.publish` stays `local | tailnet | network`; the SSH path works with `local`.
- No server-side container install over SSH in v1 (`plur1bus setup --container` on the server). The native path is the
  one with complete `update`/`update --rollback`/`uninstall` CLI support today; container-on-server is a later option
  (§11).
- No general remote shell or terminal in the GUI. The app runs a **closed set** of commands (§6.3); nothing typed by
  the person is executed.
- No change to pairing, RBAC, the device store or the API surface. Where the SSH path needs a harness contract that
  does not exist yet, it is listed as a prerequisite owned by its workstream (§9), not invented here.
- No agent forwarding, no X11, no remote port forwarding (`-R`), no SOCKS.

**Relation to earlier decisions.** The desktop spec §6.1 dropped the former D2 *Install here* action (download and run
`plur1bus setup` locally) and DS22 demoted the native installer to secondary. This design does **not** revive a local
*Install here*; it adds remote installation over SSH as a new, separate function. Because it touches DS22's wording
("the app does not drive it"), the owner confirmed it as D113 on 2026-10-18 (§12).

## 2. Decisions at a glance

| # | Topic | Decision (recommendation) | Main alternative, why not |
|---|---|---|---|
| R1 | Remote targets | **Linux x64 and arm64 (glibc, systemd)** in v1. macOS arm64 as a later, separate package. Windows hosts: not planned. | Windows OpenSSH server + Task Scheduler + PowerShell is a second command dialect and service model; macOS launchd user agents need a GUI login for persistence (§3). |
| R2 | Desktop hosts | **macOS arm64, Windows x64/arm64, Linux x64/arm64** — the five D8 targets; the SSH code is pure Rust and target-neutral. | — |
| R3 | SSH implementation | **Native Rust (`russh`)** inside the desktop's Rust core, exact-pinned. | System `ssh`: depends on per-OS client versions, password and host-key prompts need `SSH_ASKPASS` scraping, `~/.ssh/config` can inject `ProxyCommand`/`Match exec`; see §4. |
| R4 | Host keys | **TOFU with fingerprint confirmation**, optional read-only import from `~/.ssh/known_hosts`, app-owned store, **changed key = hard stop**, no "connect anyway". | Accept-new silently: no MITM protection on first contact. |
| R5 | Auth methods | Password (asked, never stored) · existing key file (passphrase asked, never stored) · SSH agent (OpenSSH, Windows OpenSSH agent, 1Password) · **app-generated Ed25519 key, private half in the OS keychain**, public half enrolled with one password login. | Storing passwords "for convenience": rejected by the request and AGENTS.md. |
| R6 | Install method | Desktop verifies the **signed release feed** with its baked key, the server fetches (default) or receives (offline) the binary, SHA-256 checked on the server, then **`plur1bus setup --non-interactive --json`**. No root; `sudo` only for `loginctl enable-linger` when polkit refuses. | Piping `install.sh` into a remote shell: it does not check the feed signature (HB19 known limit) and runs a downloaded script. |
| R7 | Service | **systemd user unit** (what `plur1bus service install` already writes) + **linger** so it survives logout and reboot. | System unit as root: not supported by `service install`, needs root for every update. |
| R8 | Using the harness | **SSH tunnel (direct-tcpip) from the Rust core to the server's loopback API**; pairing by running the native-attach pairing command over SSH. API stays loopback on the server. | `tailnet`/`network` exposure + code pairing: works today and stays available, but needs Tailscale or a TLS listener on the server; §7.3 compares. |
| R9 | Tunnel shape | **In-process transport** (no local listening port) for the Rust client and the SPA proxy's upstream; a loopback listener only as a measured fallback. | `ssh -L`-style local port: any local process of any user can reach the remote API through it. |
| R10 | Storage | New **`ssh-hosts.json`** (public metadata only, separate from `connections.json`); secrets only in the OS keychain under service `app.plur1bus.desktop`. | Adding rows to `connections.json`: an older app build would quarantine the whole file on an unknown kind (closed schema, `.corrupt-*` rule), i.e. a downgrade would hide all connections. |
| R11 | Command execution | Closed `RemoteCommand` enum; arguments limited to a quoting-free safe charset; no secret in argv or environment; bounded output; per-command timeout. | Free-form command strings or shell-quoting at runtime: the login shell (bash, zsh, dash, fish) parses the exec string; one quoting bug is remote code execution. |
| R12 | Tests | In-process `russh` server for unit/integration tests on all five targets; an **OpenSSH container** (pinned digest, built in CI) for protocol truth; a real-install e2e against the Linux runner's own `sshd` + `systemd --user`. Keys generated at runtime, never committed. | Mocks only: would not catch OpenSSH behaviour (algorithms, `authorized_keys` options, `permitopen`). |
| R13 | Path to the host (owner 2026-10-21) | Per profile **„Über Tailscale“ or „Direkt“**, free choice; public direct targets get a banner and an explicit confirmation, Tailscale targets a reachability check; the SSH session connects only to the checked addresses. Detail in [`2026-10-21-desktop-transport-choice-design.md`](2026-10-21-desktop-transport-choice-design.md). | Forcing one path: contradicts the owner decision. |

## 3. Target systems (R1, R2)

### 3.1 Remote hosts

| Remote OS | v1 | Reason |
|---|---|---|
| Linux x64, glibc | **yes** | release target `linux-x64`; `setup` + systemd user unit + `update`/`uninstall` exist and are tested |
| Linux arm64, glibc | **yes** | release target `linux-arm64`, same path |
| Linux musl (Alpine) | no | no release binary (`platform-matrix.md`: optional); refused with `unsupported-target` |
| Linux without systemd (OpenRC, runit, WSL1, minimal containers) | install yes, service no | `setup --no-service`; the GUI says the harness stops with the SSH session and offers nothing it cannot keep running |
| macOS arm64 (Remote Login) | later (plan WP8) | release target exists, but a launchd user agent normally needs a GUI login session to start at boot (reboot-survival.md step 2); headless Mac minis need the owner's decision on LaunchDaemon vs. auto-login |
| macOS x64 | no | not a release target (Q2 best-effort) |
| Windows Server / Windows with OpenSSH server | no | `cmd`/PowerShell as the exec shell, `%LOCALAPPDATA%` layout, Task Scheduler service; a second command dialect for every operation; revisit only on demand |

Detection is read-only and happens before anything is written (§6.4 step 1). An unsupported host gets a precise
reason (`unsupported-os`, `unsupported-arch`, `unsupported-libc`, `no-systemd-user`) and no partial install.

### 3.2 Desktop hosts

All five desktop targets (macOS arm64, Windows x64/arm64, Linux x64/arm64). Agent sockets differ per OS (§5.3);
everything else is identical Rust.

## 4. SSH implementation (R3, R4)

### 4.1 Native Rust vs. the system OpenSSH client

| Criterion | `russh` in-process | System `ssh` binary |
|---|---|---|
| Availability | ships with the app | macOS yes; Windows only with the optional OpenSSH client feature; Linux usually, not always |
| Host-key policy | fully ours: TOFU UI, fingerprint check, hard stop on change, app-owned store | via `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=<app file>`; first-contact prompt needs scraping or a pre-scan (`ssh-keyscan`, unauthenticated) |
| Password / passphrase | passed in memory as `SecretString` | needs an `SSH_ASKPASS` helper program, i.e. a second executable that hands the secret back over some IPC |
| Port forwarding | `direct-tcpip` channels per connection, no listening port | `-L` listener on loopback, reachable by every local process |
| User config | not read (v1) | `~/.ssh/config` applies, including `ProxyCommand`, `Match exec`, `LocalCommand` — arbitrary command execution from a file the app does not own |
| FIDO/`sk-` keys, GSSAPI/Kerberos, smartcard PKCS#11 | not supported directly; `sk-` keys may work through an agent (to verify, spike S0) | supported |
| Tests | in-process server, deterministic, all targets | needs a real `ssh` on every runner, output parsing per version |
| AGENTS.md rules | fits: native Rust, no subprocess | a subprocess with fixed argv is allowed, but prompts and config make it hard to keep fixed |

**Decision: `russh`**, exact-pinned in `apps/desktop/Cargo.toml`/`Cargo.lock` (current line 0.64.x on docs.rs,
2026-10-18; the exact version, its crypto backend — `ring`, matching the existing `rustls` feature — and the agent
features are fixed by spike S0). This is a **new dependency** under `docs/dependency-policy.md`, approved by the owner on 2026-10-18 (Q2), subject to a green audit. S0 pins `russh =0.64.1`, `default-features=false`, `features=["ring"]`; RSA in v1 is agent-only (owner 2026-10-18); direct RSA file login is excluded with `rsa-direct-unsupported` because of RUSTSEC-2023-0071. The `rsa` crate is absent from the whole resolved desktop workspace. Key, agent and known_hosts APIs are built into `russh::keys`, not a separate legacy key crate. Known cost: no GSSAPI and no direct FIDO; people who need those use their agent or keep using
`tailnet`/`network` pairing.

### 4.2 Host-key verification

- **First contact (TOFU with confirmation).** The app connects, receives the host key, and shows algorithm and the
  OpenSSH-style fingerprint (`SHA256:<base64>`, plus the randomart-free short form) with the instruction to compare it
  out of band (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server). Nothing is authenticated and no
  password is sent before the person confirms. Declining closes the connection.
- **Import.** If the person's `~/.ssh/known_hosts` already has an entry for `host[:port]` (plain or hashed `|1|`
  entries), the app offers *Use the key from your known_hosts* and still shows the fingerprint. The file is read once,
  read-only, by Rust; the app never writes to it.
- **Store.** Confirmed keys live in `ssh-hosts.json` per profile: `{ algorithm, publicKey (base64), fingerprint,
  confirmedAt, source: confirmed|known_hosts }`. Several keys per host are allowed (a server offers ed25519 and ecdsa);
  the app prefers ed25519, then ecdsa, then rsa-sha2-512/256 (no `ssh-rsa` SHA-1, no DSA).
- **Changed key = hard stop.** A key that matches no stored key for that profile aborts before authentication with
  `host-key-changed`, showing stored and offered fingerprints. There is no *connect anyway*. The only way forward is the
  explicit **Forget host key** action in the profile's settings, which needs a typed confirmation of the host name, is
  journaled (§8.4), and leads back to first-contact confirmation. Same rule for the jump host.
- **Algorithms.** Key exchange curve25519/sntrup-hybrid where offered, ciphers chacha20-poly1305 / aes-gcm, no CBC,
  no SHA-1 MACs. The exact list follows what the pinned `russh` supports and is recorded in the S0 decision.

### 4.3 Agent forwarding, jump host, keepalive

- **Agent forwarding: never.** The app never requests `auth-agent@openssh.com`; a compromised server must not reach the
  person's agent.
- **Jump host: optional, one hop in v1.** A profile may name another profile as its jump host. The app opens the jump
  session (own host-key check, own authentication), then a `direct-tcpip` channel to the target and runs the second SSH
  session over it (ProxyJump semantics, no command on the jump host). Chains longer than one hop: later.
- **Keepalive** every 15 s, dead after 3 missed replies; reconnect uses the existing 1–30 s jittered backoff
  (`docs/desktop.md`, WP9 bridge). Password-authenticated profiles do not reconnect silently: the app asks again.

## 5. Authentication (R5)

### 5.1 Methods

| Method | What the person provides | Stored | Notes |
|---|---|---|---|
| **Password** | password, each time a session starts | **never** | used for one-off work and for enrolling a generated key; keyboard-interactive with a single password prompt is accepted as password, other prompts (OTP) are shown verbatim and answered by the person |
| **Existing key file** | an Ed25519/ECDSA private key under the person's home (e.g. `~/.ssh/id_ed25519`), passphrase if encrypted | path only (public metadata); **passphrase never** | Rust offers the standard `~/.ssh/id_*` files it finds, or a typed absolute path; it refuses group/world-readable files on POSIX, symlinks out of the home, and files over 16 KiB; no file picker plugin (AGENTS.md) |
| **SSH agent** | nothing | nothing | macOS/Linux `SSH_AUTH_SOCK` (includes 1Password's socket when the person points `SSH_AUTH_SOCK`/the profile at it); Windows `\\.\pipe\openssh-ssh-agent` (Windows OpenSSH agent; 1Password for Windows serves the same pipe); the profile may pin the expected key fingerprint so a different agent key is not tried; Pageant optional (S0) |
| **Generated key (recommended for durable access)** | the account password **once** | private key **only in the OS keychain**; public key in `ssh-hosts.json` and the server's `authorized_keys` | §5.2 |

The order tried within one session is the profile's single configured method; the app does not spray every key it
can find (servers lock accounts after `MaxAuthTries`).

### 5.1.1 RSA in v1 — owner decision 2026-10-18

RSA authentication is supported **only through an SSH agent**. The agent owns the
private key and signs; the desktop uses `authenticate_publickey_with` with
`rsa-sha2-256` or `rsa-sha2-512`. Never enable `russh/rsa`, never use SHA-1
`ssh-rsa`, and never fall back to loading an RSA private key locally. New generated
keys remain Ed25519 (§5.2).

When a selected key file's public algorithm is RSA, refuse before requesting its
passphrase or decrypting the file, with stable reason **`rsa-direct-unsupported`**.
The bundled UI in WP3 translates the reason and shows:

- DE: „Lade den Key in deinen SSH-Agent oder erzeuge einen ed25519-Key.“
- EN: “Load the key into your SSH agent or generate an ed25519 key.”

Direct RSA returns only after a Marvin-safe version or an audit-compliant backend
exists. It remains a named future TODO, **not a v1 gate**. This does not waive any
other audit finding or grant an exception for public-key operations.

The S0 OpenSSH 10.5 probe verifies both RSA SHA-2 variants and authenticated exec
using a separate agent, a separate sshd and test-generated keys. Rust receives only
public metadata and the isolated socket path. Its host-key pin uses an Ed25519
server key; this does not establish RSA-only server-host-key interoperability.

### 5.2 Generated Ed25519 key

1. Rust generates an Ed25519 key pair (CSPRNG). The private key is serialized to OpenSSH private-key format **in
   memory** and written to the keychain: service `app.plur1bus.desktop`, account `ssh-key-<profile uuid>`. It is never
   written to a file and never crosses IPC.
2. The person logs in once with the password. The app appends **one** line to `~/.ssh/authorized_keys` on the server
   with a closed script (§6.3, `EnrollKey`): creates `~/.ssh` `0700` and the file `0600` if missing, skips if the exact
   key is already present (idempotent), writes through a temporary file and `mv` in the same directory, never touches
   other lines. The line carries options and a comment:
   `restrict,port-forwarding,permitopen="127.0.0.1:*" ssh-ed25519 AAAA… plur1bus-desktop:<profile uuid>`.
   `restrict` disables pty, agent and X11 forwarding and `~/.ssh/rc`; `port-forwarding` re-enables only local
   forwarding, and `permitopen` limits it to the server's loopback. Servers whose OpenSSH predates `restrict` or port
   wildcards (detected from the version banner) get the line without options and a visible note.
3. The app reconnects **with the new key only** and verifies it works. If it does not (the server uses an
   `AuthorizedKeysFile` elsewhere, LDAP/FreeIPA keys, `PubkeyAuthentication no`), the app removes its line again and
   reports `key-enrollment-not-effective`; the profile stays on password.
4. **Removal.** Deleting the profile, or *Revoke key*, removes exactly that line (matched by the full public key, not
   the comment) with the same closed script, then deletes the keychain entry. If the server is unreachable, the
   keychain entry is still deleted on request and the UI says that the line stays on the server until removed there.
5. **No durable keychain** (Linux without Secret Service, memory-only store): key generation is refused with the same
   explanation the host bridge uses (`docs/desktop.md`, WP9). A key that would vanish at restart while its public half
   stays authorized on the server is worse than none.

`restrict` means no pty. The sudo case (§6.5) that needs a tty (`requiretty`) therefore runs in a password session.

### 5.3 Secrets and the webview

AGENTS.md: *no tokens in JavaScript or files*. Stored credentials (device token, generated private key) follow that
rule strictly: Rust-only, keychain-only, never over IPC. **Typed one-time secrets** — SSH password, key passphrase,
sudo password, OTP answers — must be entered somewhere. Recommendation:

- They are typed into the **bundled shell page** (a trusted zone per desktop spec §6.9, no remote content), in a field
  that the page sends **once** through a dedicated IPC command (`ssh_secret_submit { requestId, secret }`), clears
  immediately, never stores in state, never logs, and never receives back. Rust wraps it in `SecretString` (zeroize,
  redacted Debug/Display) and drops it after use.
- The request is driven by Rust (`ssh_secret_request` event with a nonce and a purpose enum); a submit without a live
  matching request is refused.
- Later hardening option: native OS credential prompts (Windows `CredUIPromptForWindowsCredentials`, macOS secure
  text field) instead of the shell page. Not in v1 because there is no Linux equivalent and it adds platform code.

This is a deliberate, bounded exception to "no secrets in JS" for transient input, confirmed by the owner on 2026-10-18 (Q4). It does not permit persistent credentials in JavaScript.

## 6. Remote installation and management (R6, R7, R11)

### 6.1 Principles

- **Trust root is the desktop's verified feed.** The desktop already verifies the signed release feed
  (`{channel}.json` + `.minisig`, schema-compatible with `plur1bus update`'s manifest, `docs/desktop.md` WP10). It takes
  `native.binary["linux-x64"|"linux-arm64"]` (URL, SHA-256) from the *verified* bytes. This is stronger than
  `install.sh`, which cannot check the signature on a bare host (HB19).
- **No root.** Everything goes under the SSH user's home: binary `~/.local/bin/plur1bus`, state root as `setup` decides
  (`~/.plur1bus`), unit in `~/.config/systemd/user/`. `sudo` is asked for only in §6.5.
- **Idempotent.** Every step checks before it acts; `setup` itself skips steps that match the install manifest
  (`already-installed`). Re-running *Install* on an installed host is a repair, not a second install.
- **One operation per host at a time**, serialized in Rust (like the existing connection mutex); a second request gets
  `busy`.
- **Every step is visible.** Progress events to the shell page, a per-operation log (§8.3), a final summary.

### 6.2 Transfer modes

| Mode | When | How |
|---|---|---|
| **Server fetch** (default) | the server reaches the release host | the server runs `curl` (or `wget`) with fixed arguments (https only, redirects https only, size cap) into `~/.local/bin/plur1bus.tmp-<rand>`, then `sha256sum` (or `shasum -a 256`, `openssl dgst`) on the server; the app compares with the verified feed hash and only then `chmod 755` + `mv` |
| **Upload from this computer** | server without internet (clinic and company networks), or the person chooses it | the app downloads and verifies locally, streams the bytes over an exec channel into the same temp path (`cat >` with the closed command, no SFTP subsystem needed), re-hashes on the server, then moves |

`setup` itself downloads the Node runtime and the core payload against hashes baked into the binary. For a fully
offline server this needs an offline input for the Node runtime that `setup` does not have yet (`--core-from` exists,
a Node equivalent does not). That is a harness CLI prerequisite (§9, P5) and an owner question on scope (Q3).

### 6.3 Remote command model

sshd hands the exec request to the user's **login shell** (`$SHELL -c '<string>'`), which may be bash, zsh, dash or
fish. Therefore:

- All remote work is a **closed enum** `RemoteCommand` in Rust (`Probe`, `ReadApiJson`, `FetchBinary`, `ReceiveBinary`,
  `VerifyAndInstallBinary`, `Setup`, `LingerStatus`, `EnableLinger`, `DaemonStatus`, `DaemonStart|Stop|Restart`,
  `FirstAidCheck`, `UpdateCheck`, `UpdateApply`, `UpdateRollback`, `UpdateStatus`, `UninstallPlan`, `Uninstall`,
  `EnrollKey`, `RemoveKey`, `DevicePair`, …). Each renders to a fixed string.
- **Arguments are validated to a quoting-free charset** `[A-Za-z0-9._/:=@+-]` (channel and use-class are enums, agent
  ids follow the harness id rule, paths are app-chosen). A value outside the charset is refused before anything is
  sent; nothing needs quoting, so no shell can reinterpret it. The home directory is probed once and must itself match
  the charset, otherwise the host is refused with `unsupported-home-path`.
- Multi-step scripts (`EnrollKey`, `VerifyAndInstallBinary`) are sent as **stdin of `exec /bin/sh -s`**, never inside
  the exec string, so the login shell only sees the fixed `exec /bin/sh -s` and POSIX `sh` parses the script.
- **No secret in argv or environment**, ever (they show up in `ps` and audit logs). The only secret that goes to the
  server is the sudo password, on sudo's stdin (§6.5).
- **Bounds:** stdout/stderr each capped (64 KiB for JSON commands, 1 MiB rolling for `setup`/`update` logs), per-command
  timeout (30 s probes, 15 min `setup`/`update`), channel closed and remote process signalled on cancel.
- **Machine output:** every harness command runs with `--json` and is parsed as the raw `schema`-tagged document
  (`setup/1`, `update.apply/1`, `daemon.status/1`, `1staid.check/1`, …, ADR-016 §8). Unknown fields are tolerated;
  a missing or foreign `schema` is an error.

### 6.4 Install flow

1. **Probe (read-only):** `uname -s`, `uname -m`, `/etc/os-release`, libc (`getconf GNU_LIBC_VERSION`), systemd user
   manager (`systemctl --user is-system-running` or equivalent), `$HOME`, free space in `$HOME` (`df -Pk`), existing
   `~/.local/bin/plur1bus --version` and install manifest, `curl`/`wget` and SHA-256 tool presence. Result: target id,
   blockers, warnings. Nothing written.
2. **Plan screen:** target, channel, transfer mode, what will be written where, whether linger is set, whether sudo
   may be asked, and the existing installation if any (then the action is *Repair* or *Update* instead of *Install*).
3. **Binary:** §6.2; skipped if the installed binary's SHA-256 already equals the feed hash.
4. **`plur1bus setup --non-interactive --json`** with the GUI's choices (`--channel`, `--use-class`, `--agent`,
   `--profile full`, media flags left to defaults, `--accept-nc-licence` only after the person accepted it in the GUI).
   stderr lines stream into the operation log; the final `setup/1` document drives the summary (step ids and reasons:
   `already-installed`, `after-failure`, …). A failed step stops; the GUI offers *Retry* (setup is idempotent) and
   *Copy log*.
5. **Linger:** §6.5.
6. **Health:** `daemon status --json` and `1staid check --json`; `fail` rows are shown verbatim.
7. **Connect** (if the person wants the SPA): §7.

### 6.5 Service, linger and sudo

`setup` registers the systemd user unit through `plur1bus service install` (`systemctl --user enable` + start). Without
linger the user manager, and with it the harness, stops when the last session of that user ends — including the app's
own SSH session. After setup the app reads `loginctl show-user <user> --property=Linger`:

- `yes`: done.
- `no`: it runs `loginctl enable-linger <user>` **without sudo** first (polkit allows this for one's own user on many
  distributions; `docs/phase0/research/platform-binaries-and-startup.md` flags the per-distro policy as untested).
- refused: the app explains the consequence and offers (a) **Enable with sudo** — `sudo -S -p '' loginctl enable-linger
  <user>` with the sudo password on stdin; `sudo -n true` first, so a NOPASSWD rule needs no password; a `requiretty`
  failure is reported, then retried once in a pty-enabled password session — or (b) **Continue without** (the
  harness runs only while the user is logged in; shown as a permanent warning on the host card).

No other step uses sudo. Root-only facts (firewall, SELinux denials) are reported, not fixed.

### 6.6 Management operations

| GUI action | Remote command(s) | Notes |
|---|---|---|
| Status | `daemon status --json`, `service status --json` | polled only while the host page is open, at most every 10 s |
| Start / Stop / Restart | `daemon start|stop|restart --json` | stop asks for confirmation if the SPA is open |
| Check | `1staid check --json` | rows shown with their ids |
| Diagnostics bundle | `1staid bundle --out <app-chosen path> --json`, then download over an exec channel | the bundle is already redacted and `0600`; the app deletes the remote copy after download |
| Check for update | `update --check --json` / `update --plan --lang <de|en> --json` | plan shown with notes and breaking changes |
| Update | `update --yes --json` (online) or upload bundle + `update --from <path> --yes --json` (offline) | the CLI's own snapshot → swap → health gate → automatic rollback; the GUI never re-implements it |
| Roll back | `update --rollback --yes --json` | confirmation that post-update changes are lost |
| Update state | `update status --json` | after reconnect, to settle an interrupted update |
| Uninstall (app only on the server) | `uninstall --dry-run --json`, then `uninstall --yes --json` | data stays |
| Uninstall with data | `uninstall --purge --yes --json` (backup by default) | typed confirmation of the host name; `--no-backup` only behind a second explicit choice |
| Remove host from the app | local only (+ optional `RemoveKey` on the server) | the server installation is untouched |

### 6.7 Remote-side files the app writes

Only: the binary and its temp file in `~/.local/bin/`, its own line in `~/.ssh/authorized_keys`, upload temp files
under `~/.cache/plur1bus-desktop/` (deleted after use), and whatever the harness CLI writes itself. The app never edits
harness state, `config.json` or service units directly.

## 7. Using the remote harness (R8, R9)

### 7.1 Tunnel

The SSH session that manages the host also carries the API traffic. The server's API stays bound to `127.0.0.1`
(`remote.publish = local` is enough). The app reads the API origin from `<state root>/run/api.json` on the server
(`ReadApiJson`, size ≤ 8 KiB, closed schema `{ url, pid, instanceId, installationId, apiVersion }` as in desktop spec
§6.1) and accepts only a literal loopback `http://127.0.0.1:<port>` or `http://[::1]:<port>` in the D72 range.

**In-process transport (preferred).** The Rust HTTP client and the SPA proxy's upstream open one SSH `direct-tcpip`
channel per TCP connection to that loopback address. There is no local listening socket, so no other local process
(or other user on a shared Mac) can use the tunnel. This needs a custom connector under the existing `reqwest`/
`tokio-tungstenite` upstream code paths (`client.rs`, `spa_proxy.rs`); spike S0 proves HTTP, SSE and WebSocket over it.

**Fallback (only if S0 fails on a target):** a loopback listener on an ephemeral port that accepts only connections
from the app's own proxy (per-launch secret header, like the existing SPA loopback fallback), never a plain `-L`.

The **origin** stored for the connection is the server-side loopback origin (`http://127.0.0.1:18700`). The proxy
sends exactly that `Host`/`Origin` upstream, so the harness sees what a browser on its own machine would send; the
existing origin rules (literal loopback http allowed) need no exception. The `installationId` check before every
authenticated call (desktop spec §6.2) is unchanged and is what detects a reinstalled server.

### 7.2 Pairing over SSH

The trust anchor is the SSH login: whoever can run commands as the harness's OS user can already read that user's
harness state. The app therefore uses **the native-attach flow over SSH**: it runs the fixed
`~/.local/bin/plur1bus device pair --json --kind desktop --name "<desktop hostname> desktop"` (desktop spec §6.2 flow 1,
`docs/desktop.md` *Native attach*) through the SSH session, reads the one-use code from the bounded output, redeems it
through the tunnel at `POST /api/v1/devices/redeem`, and stores the device token in the keychain as for every other
connection (`device-<connection uuid>`). The code exists only in Rust memory; the person sees no code. Scopes:
`ui.session`, `events.read` (no `bridge.serve`; the host bridge is bundled-only).

**Blocked today.** #502's status records that the real harness has no `device pair --kind desktop`/desktop bearer
issuance, no `user create --owner`, and no `/api/v1/meta`, redeem or SPA session ticket routes (`d1-p3.md`, *Concrete
missing contracts*). The SSH connect step depends on exactly the same M3 contracts as native attach and the bundled
harness; it adds none. Until they land, *Open* on an SSH host is disabled with that reason, while install and
management (§6) work (owner question Q5). There is **no fallback** that reads `run/api-owner.token` over SSH: that
file is the owner's bootstrap credential, and copying it to a desktop would turn every paired laptop into an owner
token holder.

### 7.3 Comparison: SSH tunnel vs. existing remote access

| Criterion | SSH tunnel + SSH pairing (recommended) | `tailnet` exposure + code pairing | `network` exposure + pinned TLS |
|---|---|---|---|
| Server exposure | none beyond sshd, which is already there | tailnet only, Tailscale needed on both sides | a TLS listener on the LAN, security notice, `1staid` warning while on |
| Certificates | none (SSH host key pins the server) | Tailscale-issued | self-signed pin or company CA, trust rollover |
| First trust | host-key fingerprint confirmation | tailnet identity + typed code | QR/pin or `pair-proof` with typed code |
| Works for phones/other browsers | no (desktop only) | yes | yes |
| Works when the person has no SSH access | no | yes | yes |
| Survives SSH being blocked | no | yes | yes |
| Extra attack surface on the server | none | `tailscale serve` | listener, pair-proof oracle (remote-access.md known gap) |
| Implementation in desktop | new transport + reuse of native-attach pairing | exists (WP4/WP5) | exists (WP4/WP5) |

**Recommendation:** the SSH tunnel is the default for hosts added over SSH, because the person already proved access
and the server stays closed. The existing remote kind remains, and a host managed over SSH can additionally be paired
as a normal remote connection (the GUI offers *Also pair over the network* if the harness reports `tailnet` or
`network`). The two connections are independent rows with independent device tokens.

### 7.4 Profiles and multiple hosts

`ssh-hosts.json` (app config dir, atomic, `0600`, closed schema, version 1, unknown or corrupt files kept as
`.corrupt-<ms>-<uuid>` as `connections.json` does), one entry per host:

```text
{ id (UUIDv7), name, host, port, user,
  transport: tailscale | direct,                                   // §13, required in v1
  publicAck?: { atMs, classifier },                                // §13, no addresses
  auth: { kind: password | keyFile | agent | generated, keyPath?, agentKeyFingerprint?, generatedPublicKey? },
  jump: <profile id>?,
  hostKeys: [ { algorithm, publicKey, fingerprint, confirmedAt, source } ],
  remote: { target?, home?, installedVersion?, channel?, lingered?, lastProbeAt? },   // cache, never authoritative
  connectionId?: <UUIDv7 of the SSH connection row> }
```

No secret, no password, no passphrase, no private key. The in-memory connection list merges `connections.json` rows
and SSH rows; an SSH row has `kind: ssh` in memory only. Removing a host removes its connection, its device-token
keychain entry and its generated-key keychain entry (same ordering rules as WP4's credential cleanup: keychain first,
then metadata; a denied keychain deletion keeps the row and the obligation).

## 8. Security

### 8.1 Threat model

| Threat | Asset at risk | Protection | Residual risk |
|---|---|---|---|
| **Stolen or lost laptop** (unlocked session) | generated SSH key, device tokens | keys only in the OS keychain (OS login protects it; macOS/Windows can require confirmation); `restrict` + `permitopen` on the server limits a stolen key to commands as that user and loopback forwards; *Revoke key* and `device revoke` on the server end both | an attacker with the unlocked session acts as the person; same as for any SSH key or browser session |
| **Stolen laptop** (locked/off) | same | keychain encryption at rest; nothing in files (`ssh-hosts.json` holds public data only) | disk images without keychain access learn host names and users |
| **MITM on first contact** | password, server | host key confirmed by fingerprint before any authentication; known_hosts import | a person who confirms without comparing; the UI says how to compare |
| **MITM later / server re-keyed** | same | changed key = hard stop, no override, explicit *Forget host key* with typed confirmation | — |
| **Malicious or compromised server** | the desktop, the person's other systems | no agent forwarding, no remote forwarding, no X11; remote output is parsed as bounded JSON with closed schemas, never executed or rendered as HTML; the device token is scoped to that harness; the app never uploads anything but release artefacts it verified | the server sees the typed password when password auth is used (true for every SSH client); it can lie about its state; it can serve a hostile SPA, which is already handled by the SPA proxy/CSP model for any paired harness |
| **Malicious release artefact** | the server | signature-verified feed in the desktop, SHA-256 checked on the server before `mv`; `setup` verifies its payloads against baked hashes | a compromised signing key (out of scope here, D78/WP10 key rotation) |
| **Command injection via host data** | the server and desktop | closed command enum, quoting-free charset, scripts on stdin of `/bin/sh -s`, no free text | — |
| **Secrets in logs** | password, keys, tokens, codes | single redacting formatter (existing desktop rule); argv contains no secrets; pairing code and device token never logged; stdout of `device pair` is never written to the operation log | — |
| **Local other users / processes** | the tunnel, the API | in-process transport, no listening port; fallback listener with per-launch secret | same-OS-user malware (out of scope, as for every desktop credential) |
| **Brute force via the app** | server accounts | one configured auth method per attempt; no key spraying; backoff after failure | — |
| **Downgrade of the app** | connection metadata | SSH data in its own file; older builds ignore it and keep `connections.json` intact | an older build shows no SSH hosts until upgraded again |

### 8.2 Tauri rules

- **No new plugins.** Never `shell`, `fs`, `http`, `dialog`, `opener` (AGENTS.md). SSH, file reads of `~/.ssh` and the
  keychain are native Rust.
- **New native commands** live in the shared command table (`apps/desktop/desktop-contract`), which generates the ACL
  for the `shell` webview at the exact bundled origin; each command re-checks label and origin in Rust and takes a
  closed serde struct (`deny_unknown_fields`). The SPA and the approvals window get none of them.
- Commands take **profile ids and enums**, never commands, paths on the server, URLs, ports or key material. The only
  free text is the profile's `name`, `host` (validated as DNS name or IP literal, punycode), `user` (POSIX user-name
  charset) and the local key path (validated in Rust as above).
- Events to the page carry public data only (fingerprints, step ids, bounded redacted log lines).

### 8.3 Logs

Per operation an entry in the app's existing redacted log directory: profile id, host, operation, command ids,
exit codes, durations, and bounded stdout/stderr of non-secret commands. The UI's *Copy log* uses the same redacted
text. Not logged: passwords, passphrases, sudo input, private keys, pairing codes, device tokens, `device pair` output,
cookie or ticket values. The redaction test of the desktop logger is extended with SSH fixtures.

### 8.4 Audit

- **Desktop side:** an append-only, owner-only operation journal `ssh-journal.jsonl` (bounded, rotated) records
  security-relevant events: host key confirmed / imported / forgotten, key enrolled / removed, install, update,
  rollback, uninstall (with/without purge), sudo used, pairing performed. No secrets; host and user are stored because
  the journal is local to the person.
- **Harness side:** the harness audits its own operations through its existing mechanisms (`device.paired`,
  config/audit records). The app adds no server-side audit writer of its own. The server's own `sshd` log records the
  logins; the authorized_keys comment `plur1bus-desktop:<profile uuid>` makes the key attributable.

## 9. Harness prerequisites (owned elsewhere)

| # | Prerequisite | Needed for | Owner workstream | Status on `main` |
|---|---|---|---|---|
| P1 | `plur1bus device pair --kind desktop --json` issuing a code (or token) for a desktop device | §7.2 pairing | M3 | missing (`DeviceCmd` has list/revoke/rename) |
| P2 | Owner bootstrap for a fresh install (`user create --owner` or the M3 equivalent) so the SPA opens as owner | first open after install | M3 | missing |
| P3 | API process under the supervisor writing `run/api.json`; `/api/v1/meta`, redeem, session ticket routes | §7.1, §7.2 | M3 | API standalone; routes missing (`d1-p3.md`) |
| P4 | Line-oriented progress from `setup`/`update` (e.g. `--progress jsonl` on stderr) | live progress instead of log lines + final document | M8 / installer | not present; v1 works without it |
| P5 | Offline Node runtime input for `setup` (counterpart to `--core-from`) | fully offline server install | M8 / installer | not present |

P1–P3 gate the *Open* step; P4 is a quality improvement. **P5 and an egress-blocked offline installation test are v1 release gates** (Q3, decided 2026-10-18); upload is mandatory, not an optional later mode. P1–P3 are proposed in open PR #581 and are not accepted on main at the S0 inventory base `c2c75ab23`.

## 10. Testability

- **Unit/integration (all five desktop targets):** an in-process `russh` server fixture in the SSH crate's tests
  serves exec, `direct-tcpip` and a scripted fake `plur1bus` (reusing `apps/desktop/test-bins` fixtures where possible).
  Covers host-key first contact/confirm/decline/changed, known_hosts import (plain and hashed), every auth method,
  agent (a test agent on a temp socket/pipe), jump host, command rendering and charset refusals, output bounds,
  timeouts and cancellation, enrollment idempotency and removal, transport HTTP/SSE/WS through the proxy.
- **OpenSSH truth (Linux CI):** `apps/desktop/ssh-test-server/` holds a Dockerfile `FROM` a digest-pinned Debian image
  with `openssh-server`; host keys and a test user's keys are **generated at container start** in a temp volume and
  exported to the test as public data only. Tests run the real client against it: algorithms, `authorized_keys`
  options (`restrict`, `permitopen`), password and keyboard-interactive, changed host key, jump host (two containers).
- **Real install (Linux runner, dispatch + nightly, non-gating at first):** the runner's own `sshd` on loopback, a
  throwaway user with `systemd --user` and linger (as the H3 service job does), a locally built release binary and a
  `file://` feed signed with a throwaway key injected through the existing debug-only feed-key seam. Covers install →
  status → update → rollback → uninstall → reinstall (idempotency) and connect once P1–P3 exist.
- **Keychain:** the existing scratch-profile seam (`PLUR1BUS_DESKTOP_CONFIG_DIR` forces MemoryStore) and injected
  stores; never the real keychain in tests. A generated-key test asserts the private key reaches only the injected
  store and no file, event, log or IPC payload.
- **Secrets never leave:** one test drives a full flow (password login, key generation, enrollment, install, pairing)
  and searches every IPC payload, event, log line, journal entry and metadata file for the password, the private key,
  the pairing code and the device token (pattern of `packages/remote-access/test/secrets-never-leave.test.ts`).
- **No keys in the repository.** All keys are generated at test runtime in temp dirs; the root hygiene check
  (`scripts/lint-hygiene.mjs`) already refuses private-key blobs and keeps doing so.
- **UI:** Playwright browser suite with the injected test transport for the host list, add-host wizard (fingerprint
  confirm, secret prompt), install progress, update/rollback/uninstall confirmations; axe in light/dark, DE/EN, 44 px
  targets, 400 px layout.

## 11. Alternatives considered (and later options)

- **System OpenSSH client** (§4.1) — rejected for v1; could become an *advanced* transport later for GSSAPI/FIDO users.
- **Remote container install** (`plur1bus setup --container` or `deploy/compose.yaml` on the server over SSH) — later;
  it needs a Docker/Podman socket on the server, image-digest upgrades, and the desktop controller's container logic
  over SSH instead of the local Engine API.
- **Reading `~/.ssh/config`** — not in v1 (ProxyCommand/Match exec). A later read-only import of `HostName`, `User`,
  `Port`, `IdentityFile`, `ProxyJump` for a single host alias is possible.
- **Server-side pairing code typed by the person** — unnecessary: the SSH session already proves access.
- **`tailnet`/`network` as the only way** — stays available, but forces exposure or Tailscale for a person who only
  wants their own server.

## 12. Owner decisions — entschieden 2026-10-18

| Question | Binding owner answer |
|---|---|
| Q1 | **Yes — D113.** The desktop may install/manage a remote native harness over SSH. Amend DS22/§6.1; local *Install here* stays removed. |
| Q2 | **Yes.** Exact-pinned `russh`, `ring` backend and key/agent support in the desktop workspace under the dependency policy. Approval does not waive the audit gate. Fix security advisories through updates; exceptions only for unmaintained crates with no fix, reason and expiry. |
| Q3 | **Offline servers are v1 need**, including clinic networks. Upload the verified release artifact and matching Node runtime. Offline Node input P5 and the no-egress installation test gate WP4 and release. |
| Q4 | SSH password, key passphrase and sudo password are entered in the bundled shell, submitted once through the dedicated nonce-bound IPC (§5.3), never stored/logged, and zeroized after use. Durable OpenSSH keys live only in the OS keychain. |
| Q5 | Ship install/manage first. **Open stays disabled until M3 desktop pairing P1–P3 are on main**; then SSH pairing uses a ten-minute single-use claim. |

Authentication is either a one-time password prompt or durable OpenSSH-key authentication (owner 2026-10-17).

### S0 RSA decision follow-up, 2026-10-18

**Decided:** agent-only RSA in v1; direct RSA file login is excluded. With
`russh =0.64.1`, defaults off and only `ring`, the entire desktop dependency
metadata contains **no `rsa` crate**. The graph regression checks this explicitly.
The external OpenSSH agent signs for SHA-256 and SHA-512; actual SSH authentication
and subsequent exec succeed against an isolated OpenSSH server. No RSA advisory
exception or public-operation exception is needed or added.

The old direct-feature candidate still pulls `rsa 0.10.0-rc.18`, covered by
[RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html); it stays
outside the committed dependency graph. S0 remains partial because five-target,
proxy/jump, supported OpenSSH-version and installed-size evidence is still open.
Whole-workspace audit findings remain separate gates. See the
[S0 evidence and remaining gates](../../handoff/status/2026-10-18-dssh-s0.md).

## 13. Transport choice — owner decision 2026-10-21

Each host profile records how the person reaches it: **„Über Tailscale“** or **„Direkt“** (R13, `transport` in §7.4).
The choice selects checks and notices only; R4 (host keys), R5 (authentication) and R8/R9 (loopback API behind the
tunnel) are unchanged. Before the first SSH packet the app resolves the host once, classifies every address against the
IANA special-purpose registries (public direct target ⇒ banner and explicit confirmation, no block; mixed ⇒ public),
runs the Tailscale reachability check for `*.ts.net` names and tailnet addresses, and hands **exactly the checked
socket addresses** to the SSH session (WP1 `SessionConfig` takes pre-resolved addresses; the SSH crate does no DNS).
A jump host is checked as the first hop; a target behind it is resolved by the jump host and not locally (transport spec §6.1,
`target-via-jump`). Reconnects repeat the check. Detail, codes, texts and security analysis:
[`2026-10-21-desktop-transport-choice-design.md`](2026-10-21-desktop-transport-choice-design.md); plan:
[`2026-10-21-desktop-transport-choice.md`](../plans/2026-10-21-desktop-transport-choice.md), package T6.
