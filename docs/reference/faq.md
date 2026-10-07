# FAQ

Short answers, taken only from the existing user documentation. Each answer links to its source. For details, follow the link.

## Installation

**Where is the home directory?**
`--home <path>` wins, then the `PLUR1BUS_HOME` environment variable (an empty value counts as unset), then `~/.plur1bus` on Linux and macOS or `%LOCALAPPDATA%\PLUR1BUS` on Windows. Source: [user/en/operations.md, Directories](../user/en/operations.md).

**What do I run first after installing?**
`plur1bus setup`, then create an agent and start a first conversation. Source: [user/en/quickstart.md, §2–§4](../user/en/quickstart.md).

**Does setup start the background service?**
Yes, unless you pass `--no-service`. `plur1bus service install` registers the supervisor in your user context without administrator rights. Source: [user/en/operations.md, Service management](../user/en/operations.md).

## Backup

**How do I make a backup?**
`plur1bus backup create` writes `<home>/backups/plur1bus-backup-<UTC>.tar.gz`. `--dry-run` lists what would be archived without writing. `create` needs a running core. Source: [user/en/quickstart.md, §5](../user/en/quickstart.md).

**Are API keys included in a backup?**
No. The archive never contains secrets, which stay in the OS keyring, and `run/` is never archived. Source: [user/en/quickstart.md, §5](../user/en/quickstart.md).

**Is a backup encrypted or signed?**
No. The archive is neither signed nor encrypted. Source: [user/en/quickstart.md, §5](../user/en/quickstart.md).

**How do I restore?**
Stop the daemon, run `plur1bus backup restore <archive>` (`--dry-run` prints the plan, scripts need `--yes`), then start the daemon and run `plur1bus 1staid check`. The replaced state is kept in `<home>/backups/pre-restore-<id>/`. Source: [user/en/quickstart.md, §5](../user/en/quickstart.md).

## Update

**How do I check for an update without applying it?**
`plur1bus update --check` compares with the release manifest and prints the plan; it changes nothing. Source: [user/en/quickstart.md, §6](../user/en/quickstart.md).

**What happens when an update fails?**
The update takes a snapshot first and restores it on any failure at the health gate. `plur1bus update --rollback` goes back to the snapshot of the last applied update. Source: [user/en/quickstart.md, §6](../user/en/quickstart.md).

**When must I use `setup` instead of `update`?**
When the release changes the Node runtime or the module set; `update` refuses such releases. Source: [user/en/quickstart.md, §6](../user/en/quickstart.md).

## Logs

**Where are the logs?**
All under `<home>/logs/`: per-process JSON logs (`supervisor.log`, `core.log`, `<module>.log`), their stdout/stderr (`*.out.log`), and `audit.log`. Source: [user/en/operations.md, Logs](../user/en/operations.md).

**How do logs rotate?**
By size. The newest rotated file is `<file>.1`, then `<file>.2` and so on. Source: [user/en/operations.md, Logs](../user/en/operations.md).

**Where does the systemd service write its output?**
Its output also goes to the user journal. Source: [user/en/operations.md, Logs](../user/en/operations.md).

## Troubleshooting

**Where do I start when something is wrong?**
With "Find out what is wrong" in the operations handbook, which covers exit codes, error codes and common situations. Source: [user/en/operations.md, Troubleshooting](../user/en/operations.md).

**`update --check` says `E_NOT_AVAILABLE`. Why?**
Usually because `manifest.json` is missing, reason `not-installed`. Run `setup` first. Source: [user/en/operations.md, Directories](../user/en/operations.md).

**My `config.json` is damaged. What now?**
`plur1bus 1staid repair` restores it from the running configuration or from the newest valid `config.json.bak-*`. Source: [user/en/quickstart.md, §5](../user/en/quickstart.md).

**Should I edit `config.json` by hand?**
Use `plur1bus config set`. Editing it by hand while the supervisor runs is not advised. Source: [user/en/operations.md, Directories](../user/en/operations.md).

**What are the error codes?**
The full list of typed error codes is in [errors.md](errors.md). The short meanings for operators are in [user/en/operations.md, Error codes](../user/en/operations.md).

Hinweis: Diese FAQ ist ein Einstieg. Die deutschen Nutzerdokus stehen unter [user/de](../user/de/) und folgen derselben Gliederung.
