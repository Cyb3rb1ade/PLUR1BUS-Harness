# Native platform quickstarts

These are platform entry points to the [full quickstart](user/en/quickstart.md) and
[operations handbook](user/en/operations.md). [Deutsch](platform-quickstart-de.md).
Use the candidate binary and payload for the **native** target in the release manifest.
Do not treat a different architecture or an unsigned local build as packaged release evidence.

| Target | Candidate target ID | Home default | User service |
|---|---|---|---|
| macOS Apple silicon | `darwin-arm64` | `~/.plur1bus` | launchd user agent, starts at login |
| Windows x64 | `win-x64` | `%LOCALAPPDATA%\PLUR1BUS` | Task Scheduler, configured logon trigger |
| Windows ARM | `win-arm64` | `%LOCALAPPDATA%\PLUR1BUS` | Task Scheduler on native ARM |
| Linux x64 | `linux-x64` | `~/.plur1bus` | `systemd --user` |
| Linux ARM | `linux-arm64` | `~/.plur1bus` | `systemd --user` on native ARM |

Run the binary from your user-writable directory, put it on PATH, and check `plur1bus --version`.
In PowerShell use `plur1bus.exe` (or `& 'C:\path with spaces\plur1bus.exe'` when not on PATH).
Start with a disposable home for release-candidate validation:

```sh
plur1bus --home /absolute/disposable-home setup --non-interactive --no-service --agent main
plur1bus --home /absolute/disposable-home daemon status --json
plur1bus --home /absolute/disposable-home 1staid check --json
```

On Windows substitute a native absolute path such as `C:\Users\you\PLUR1BUS-test` for the home.
`--no-service` avoids OS registration during the first functional check. Configure a provider using the
[provider guide](user/en/providers.md), then follow the chat/memory steps in the full quickstart.
Do not put provider keys on the command line; `secret set` reads stdin.

For service validation use `service install` and `service status --json` with that same home. On Linux,
boot without an active login needs a user manager with lingering; see the operations handbook and
[reboot protocol](reboot-survival.md). Enabling lingering is a separate OS permission decision, not
proof that the installer itself needs administrator access. Keep the real reboot row open until run.

[Portable encrypted backups](portable-backup.md) include the vault; ordinary `backup create` archives
exclude it. [Update/rollback](updates.md), [uninstall](uninstall.md), [current release gaps](release-known-issues-v0.1.0.md)
and the [evidence checklist](release-checklist-v0.1.0.md) apply to all five targets. Native Windows injected-update outcomes and Windows ACL parity remain open. macOS Intel is best-effort per [platform matrix](platform-matrix.md).
