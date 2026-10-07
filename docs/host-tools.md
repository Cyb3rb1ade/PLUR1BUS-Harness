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
| `apps.open` | open app / file / URL; URL schemes `http` `https` `mailto` | `open` / `open -a` | `explorer.exe` | `xdg-open` | `sys.read` | low |
| `apps.running` | running GUI apps where the OS exposes them | `osascript` System Events | `tasklist /V` console / titled windows | `wmctrl -l` when present | `sys.read` | low |
| `clipboard.read` | read clipboard; never log the content | `pbpaste` | PowerShell `Get-Clipboard` | `wl-paste` / `xclip` / `xsel` (first found) | `clipboard.read` | low |
| `clipboard.write` | write via stdin, never argv; 64 KiB cap | `pbcopy` | PowerShell `Set-Clipboard` from stdin | `wl-copy` / `xclip` / `xsel` | `clipboard.read` | low |
| `notify` | desktop notification; text escaped | `osascript` `display notification` | PowerShell BurntToast, else WinRT toast | `notify-send` argv | `sys.read` | low |

D106 also names `fs.*` and `shell.*` (already shipped) and later surfaces (`sys.memory/startupItems/services/updates`,
`apps.focus/quit`, `pkg.upgrade`, privilege). Those are not in this library.

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

**`apps.open`** allows URL schemes `http:`, `https:`, `mailto:` only. Other schemes and deny-listed
file paths fail with `denied_by_denylist`.

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
- Output is capped; a hung child is killed after `timeoutMs`.

## Follow-ups (not this PR)

1. Register the tools in the central tool registry / dispatcher.
2. D109 approvals for `proc.kill`, `pkg.install` / `pkg.remove` execution, and `apps.open` of
   untrusted targets (this library only returns the plan or refuses).
3. OS sandbox for `shell.*` (already a separate family).
4. `tool-eval` host scenarios (free disk space, install-with-approval, restart a hung app).
5. Remaining D106 names: `sys.memory` / `startupItems` / `services` / `updates`, `apps.focus` /
   `apps.quit`, `pkg.upgrade`.
