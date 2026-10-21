# Host tools (D106)

Hand-written. Code: `packages/core/src/host-tools/`. Tests: `packages/core/test/host-tools/`. Spec:
D106 and D109 (`docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md`); placement:
`docs/milestones.md` §M1b-2b ("Host toolset (D106)").

This package is a **standalone library**. It is not registered in the tool registry, not wired into
the dispatcher, and it does not grant D109 approvals. Callers construct a `HostContext` (injected
exec / filesystem / clock / OS, or `createNodeHostContext()` for the real host) and call
`runHostTool(name, input, ctx)`.

`fs.*` and `shell.*` already live under `packages/core/src/tools/` and are out of scope here.

## W1 inventory

Capability ids are taken from `packages/core/src/policy/capabilities.ts`. Risk classes are D109
`RISKS`: `low` / `medium` / `high` / `critical`.

| Tool | Spec requirement (D106) | macOS | Windows | Linux | Capability | Risk |
|---|---|---|---|---|---|---|
| `proc.list` | list pid, name, user, cpu, mem; redact secret-shaped args | `ps -axo pid=,ppid=,user=,pcpu=,pmem=,command=` | `tasklist /FO CSV /V` (+ `wmic process` for ppid) | same `ps` as macOS / procfs-shaped columns | `sys.read` | low |
| `proc.info` | inspect one pid | same list source | same list source | same list source | `sys.read` | low |
| `proc.kill` | signal/kill; never pid 1, never the harness tree, never another user | `kill -<SIG> <pid>` | `taskkill /PID <pid>` (`/F` for KILL) | `kill -<SIG> <pid>` | `proc.signal` | medium |
| `proc.wait` | wait until the pid exits or the timeout elapses | poll `ps` | poll `tasklist` | poll `ps` | `sys.read` | low |
| `sys.info` | OS, version, arch, CPU, RAM, uptime | `node:os` only | `node:os` only | `node:os` only | `sys.read` | low |
| `sys.disks` | mounts, total/free | `df -kP` | `wmic logicaldisk get Caption,FreeSpace,Size /FORMAT:csv` | `df -kP` | `sys.read` | low |
| `sys.network` | interfaces, no secrets / no MAC | `node:os.networkInterfaces()` | same | same | `sys.read` | low |
| `sys.battery` | charge when the hardware exposes it | `pmset -g batt` | `wmic path Win32_Battery …` | `/sys/class/power_supply/BAT*` | `sys.read` | low |
| `pkg.detect` | brew / apt / dnf / pacman / winget / choco / scoop present? | `which` on PATH | `which` + PATHEXT | `which` on PATH | `sys.read` | low |
| `pkg.search` | read-only search | `brew search` | `winget search` | `apt-cache search` (and dnf/pacman) | `sys.read` | low |
| `pkg.list-installed` | read-only installed set | `brew list --versions` | `winget list` | `dpkg-query` / `dnf list installed` / `pacman -Q` | `sys.read` | low |
| `pkg.info` | read-only metadata | `brew info` | `winget show` | `apt-cache show` / `dnf info` / `pacman -Si` | `sys.read` | low |
| `pkg.install` | dry-run plan only (D106 batch / D109 `pkg.change`) | plan `brew install <name>` | plan `winget install <name>` | plan `apt-get install` / `dnf install` / `pacman -S` | `pkg.change` | high |
| `pkg.remove` | dry-run plan only | plan `brew uninstall` | plan `winget uninstall` | plan `apt-get remove` / `dnf uninstall` / `pacman -R` | `pkg.change` | high |
| `apps.list` | installed applications | `/Applications` + `mdls` | Uninstall registry keys + Start Menu `.lnk` | `.desktop` files | `sys.read` | low |
| `apps.open` | open app / file / URL; URL schemes `http` `https` `mailto` | `open` / `open -a` | `explorer.exe` | `xdg-open` | `apps.launch` | medium |
| `apps.running` | running GUI apps where the OS exposes them | `osascript` System Events | `tasklist /V` console / titled windows | `wmctrl -l` when present | `sys.read` | low |
| `clipboard.read` | read clipboard; never log the content | `pbpaste` | PowerShell `Get-Clipboard` | `wl-paste` / `xclip` / `xsel` (first found) | `clipboard.read` | low |
| `clipboard.write` | write via stdin, never argv; 64 KiB cap | `pbcopy` | PowerShell `Set-Clipboard` from stdin | `wl-copy` / `xclip` / `xsel` | `clipboard.read` | low |
| `notify` | desktop notification; text escaped | `osascript` `display notification` | PowerShell BurntToast, else WinRT toast | `notify-send` argv | `sys.read` | low |

| `sys.memory` | physical memory bytes | `node:os` | same | same | `sys.read` | low |
| `sys.startupItems` | standard startup-entry names, bounded | LaunchAgents/Daemons dirs | Startup folder only | autostart dirs | `sys.read` | low |
| `sys.services` | read service status | launchctl list | sc query | systemctl --user | `sys.read` | low |
| `sys.updates` | list updates, never install | softwareupdate --list | winget upgrade list | apt list --upgradable only | `sys.read` | low |
| `apps.focus` | activate validated app id | osascript activate | AppActivate by process name | wmctrl -xa | `apps.launch` | medium |
| `apps.quit` | graceful close, no force | osascript quit | CloseMainWindow | wmctrl -xc | `proc.signal` | medium |
| `pkg.upgrade` | exact dry-run plan only | brew upgrade | winget upgrade | apt --only-upgrade / dnf / pacman plan | `pkg.change` | high |

The table describes typed platform routes, not proof that the current sandbox permits every OS service. See the Draft backend/coverage section below. `fs.*` and shell operations have equivalent file/hostctl surfaces, with PTY and delete gaps explicitly listed there.

## Shape

Each tool is a `HostTool`: `{ name, capability, riskClass, schema: { input, output }, run(input, ctx) }`.
`runHostTool` wraps `HostFailure` as `{ isError: true, error: { code, message } }`.

`HostContext` is injectable so the suite never talks to a real host:

- `exec` — `node:child_process.spawn` with `shell: false` and a fixed argv list (never a shell string)
- `fs` — `exists` / `readFile` / `readdir` / `stat`
- `clock` — `now` / `setTimeout` / `clearTimeout` / `sleep`
- `os` — `node:os` fields used by `sys.info` / `sys.network`
- `signal`, `timeoutMs` (default 30 s, hard 300 s), `maxOutputBytes` (default 64 KiB, hard 1 MiB)

Failure codes (closed): `not_supported_on_platform`, `not_found`, `permission_denied`, `timeout`,
`aborted`, `denied_by_denylist`, `invalid_input`, `too_large`.

## Guard rails

**`proc.kill`** refuses pid 1, the current harness pid, every descendant and ancestor of that pid, and
a process whose user is not the caller (unless uid 0). The argv is always `["-<SIG>", "<pid>"]` or
`taskkill /PID …`.

**`pkg.install` / `pkg.remove`** return `{ plan: { program, args, capability: "pkg.change", riskClass: "high", executed: false } }`
and do not spawn the manager. Execution is a D109 approval follow-up.

**`apps.open`** allows URL schemes `http:`, `https:`, `mailto:` only. The allowlist applies to any target that
carries a scheme, whatever `kind` says (`ssh:`, `vnc:`, `smb:`, `file:` fail with `denied_by_denylist`); a single
letter before `:` is a Windows drive, not a scheme. File and app targets are checked against the deny-list both
as given and after `~` expansion and `.` / `..` collapsing; symlinks are not resolved. Targets starting with `-`
and an unknown `kind` are `invalid_input`. A non-zero exit of the opener is reported as `not_found`.
It is registered as `apps.launch` / `medium` (policy `approval`, grant at most `once`). Targets that would start
a program are refused with `denied_by_denylist`: launchable extensions (`.exe` `.com` `.bat` `.cmd` `.ps1` `.msi`
`.vbs` `.js` `.hta` `.reg` `.jar` `.command` `.tool` `.app` `.pkg` `.desktop` `.AppImage` and similar) and regular files
with an execute bit. A `.app` bundle is accepted only below `/Applications/` or `/System/Applications/`, and
`kind: "app"` with a bare name (`Safari`) stays `open -a`. Windows `.lnk` Start Menu shortcuts stay openable.

**Clipboard** content is never placed on argv, never interpolated into an error message, and never
logged by this library. Writes above 64 KiB are `too_large`.

## Credential deny-list

Compared case-folded and NFC-normalised via D109 `matchDeny`. Hits are refused (`denied_by_denylist`)
on `apps.open` of a file, and redacted (`[redacted]`) in `proc.list` / `proc.info` command lines.

Covered by default (home-relative plus well-known system paths):

- `~/.ssh`, `~/.gnupg`, OS keychains (`~/Library/Keychains`, `/Library/Keychains`, `~/.local/share/keyrings`)
- cloud CLI stores (`~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`)
- browser profiles and password-manager data (Chrome, Firefox, 1Password, Bitwarden)
- names `.env`, `.env.local`, `.netrc`, `.npmrc`, `credentials`, `auth.json`, `id_ed25519` / `id_rsa` / …
- D110 stores: `~/.codex`, `~/.hermes`, the other-host credential directory under the person's home,
  plus `CODEX_HOME` / `HERMES_HOME` and Windows `%LOCALAPPDATA%\hermes` when those env vars are set

`proc.list` also redacts argv tokens that look like API keys, GitHub PATs, JWTs, or `--token=` /
`--secret=` flags.

The person cannot lift a deny-list entry for an agent (D109 Q14).

## Tests

Same cases run against recorded fake-exec fixtures for `darwin`, `win32` and `linux`
(`packages/core/test/host-tools/conformance.test.ts`). A few smoke tests use the real OS and are
read-only (`sys.info`, `proc.list` of this process).

```bash
cd packages/core && node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 test/host-tools/**/*.test.ts
```

No network. System access in production code is `node:child_process` (fixed argv), `node:os` and `node:fs` only.

## Limits

- Not a dispatcher, not an RPC surface, not a sandbox. `shell.*` OS sandbox (Landlock / Seatbelt /
  restricted token) is a follow-up.
- `pkg.*` does not execute install/remove/upgrade.
- `sys.battery` is best-effort (`available: false` when the platform has no battery).
- `apps.running` on Linux needs `wmctrl`; without it the result is `{ apps: [], available: false }`.
- Clipboard backends that are missing (`wl-paste` / `xclip` / `xsel`) yield `not_found`.
- Output is capped; a hung child is killed after `timeoutMs`. A truncated process table fails `proc.list`,
  `proc.info` and `proc.kill` with `too_large` (a partial table would defeat the harness-tree check); a truncated
  clipboard read is `too_large` rather than a silent prefix.
- Spawn failures and unexpected exceptions are reported without paths or OS text (`not_found`,
  `permission_denied`, otherwise `invalid_input` "the operation failed"). A non-zero exit of the clipboard and
  notification backends is `not_supported_on_platform`.
- `apps.open` and `apps.focus` now require `apps.launch` (local-write, medium, approval, once); `apps.quit` requires `proc.signal`. `notify` retains its declared capability, but its subprocess is sandboxed or explicitly refused.
- A time limit or abort ends the child's process group (`taskkill /T` on Windows). After the leader exits, output in
  flight is drained for 250 ms and the pipes are closed, so a detached descendant that inherited stdout cannot hold
  the call open; it is not killed unless it stayed in the group.
- `pkg.search` and `pkg.info` refuse a term that starts with `-` (`invalid_input`) instead of passing it to the manager as an option.
- `notify` passes `--` before title and body to `notify-send`, and escapes PowerShell typographic double quotes.

## Follow-ups (not this PR)

1. Register the tools in the central tool registry / dispatcher.
2. D109 approvals for `proc.kill`, `pkg.install` / `pkg.remove` execution, and `apps.open` of
   untrusted targets (this library only returns the plan or refuses).
3. OS sandbox for `shell.*` (already a separate family).
4. `tool-eval` host scenarios (free disk space, install-with-approval, restart a hung app).
5. Remaining D106 names: `sys.memory` / `startupItems` / `services` / `updates`, `apps.focus` /
   `apps.quit`, `pkg.upgrade`.


## D106 Draft stack, 2026-10-15

The earlier inventory/follow-ups above describe the original library. Current additions: `sys.memory`, `sys.startupItems`, `sys.services`, `sys.updates`, `apps.focus`, `apps.quit`, `pkg.upgrade`. `remaining.test.ts` pins their three-OS argv/validation shapes. `sys.startupItems` is an explicit registry-name exception required by D106. `classifyHostTool` handles roots, deny paths, cwd and hostile environment names; absent classification remains outside roots. Upgrade is plan-only like install/remove. PTY shell.session.*, fs.delete and full startup/update coverage remain open.

### Sandbox and fail-closed behaviour

`sandboxSpawn(argv, policy)` is reusable by M5/M6; those modules are unchanged. Policy holds canonical read/write roots, immutable credential/runtime denies, network none/egress/full, environment allowlist and resource/output bounds. Egress currently becomes none with a reported warning. Missing backend/launcher refuses execution. Only owner configuration tools.sandbox.required=false enables audited unsandboxed execution, visibly marked by Doctor. No automatic fallback exists.

| Target | Backend | Current strength/evidence |
|---|---|---|
| macOS arm64 | deprecated sandbox-exec/Seatbelt | partial; real adversarial probes; fork denied, sampled RSS watchdog |
| Linux x64/arm64 | /usr/bin/bwrap + existing-libc limits helper | partial; write roots refused pending dynamic credential protection; not locally executed |
| Windows x64/arm64 | restricted token + Job Object still missing | none, refuse; pure detection tests; no real Windows isolation claim |

The five-target CI probe job skips unavailable backends with a reason. CI execution and the owner's Windows VM remain unverified. The helper is not yet delivered by installers. See phase handoffs for attack → protection → test tables and open resource/race gaps.

### Taint and host evaluation

The central result path marks untrusted web, MCP/peer tool and outside-root file content as tainted. Existing external/taint-sensitive standing grants then suspend for that turn; valid once approvals remain possible. Peer paths outside the dispatcher still need integration.

`catalog/host-eval-scenarios.json` contains 20 scratch/policy scenarios. `scripts/eval/tool-eval-host.ts` runs deterministic fake model replay, or `--live` for configured Anthropic Messages, OpenAI Responses, Gemini generateContent or Chat Completions-compatible models using safe fake OS ports. PR and main CI gate fixture correctness only (`host-tool-eval` in `ci.yml`); reviewed model recordings are replayed for release qualification in the release workflow (see below); live calls run only nightly. Nightly records missing credentials as skipped and fails completed runs below 95% or with escapes. The nightly job carries no OpenAI credential (D110 §5.8, lint rule HYG-015: OpenAI secrets exist only in the owner-gated `openai-live` job), so OpenAI models are recorded as skipped there until the owner adds that gated job. Reports are per model, bounded, freshness/corpus checked and have explicit fake/recorded/live evidence. Models/Doctor use `state/tool-eval/host-reports.json` and label unknown/limited; synthetic-only evidence never qualifies a model.

Release qualification uses **exactly** `config/shipped-models.json`, also used for provider-specific setup preselections, plus `--recorded --require-release`, which runs only where a release is made: the `release-gate` job of `release.yml` (tags `v*`, and its dry-run dispatch) blocks `attest` and every later job; PR and main CI do not run it (owner decision 2026-10-19). This is not a relaxation: the gate stays blocking for releases, without continue-on-error. Pending candidates remain mandatory coverage and block release; setup only preselects confirmed, actually available models. Anthropic `claude-sonnet-5-5` is confirmed; OpenAI `gpt-6-astra`, Google `gemini-3.8-flash` and Ollama `qwen3:8b` (Apache-2.0) await review, with authenticated listing additionally required for OpenAI/Google. xAI/OpenRouter/generic endpoints are selectable but have no shipped default. CODEOWNERS requires owner review of pins and recordings when repository protection enforces it; main is currently unprotected. No real recordings exist yet, so the release gate is expected to fail, and a tag release cannot proceed, until recordings are added. Nightly captures preserve wire format and recording time; exact corpus IDs/hash and ≤7-day evidence are required. Environment entries cannot narrow coverage. A model is supported only with matching genuine recorded/live evidence at ≥95% and zero policy escapes. No live paid run was performed locally.

User documentation: [English](user/en/host-tools.md), [Deutsch](user/de/host-tools.md). Full inventory, decisions, threats, validation and KNOWN-GAP todos: docs/handoffs/2026-10-15-d106-p{1,2,3,4}.md.
