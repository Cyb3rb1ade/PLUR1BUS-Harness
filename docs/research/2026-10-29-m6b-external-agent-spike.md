# M6-B spike: linked worktree sandbox and ACP client (2026-10-29)

Status: spike note for Arbeitspaket Q, task B0. The Seatbelt run was on this Mac. Linux bubblewrap is covered by the containment tests on the Linux CI runner. No new npm dependency was added.

## Seatbelt and a linked worktree

A linked worktree has a `.git` file, not a directory. `config`, `hooks` and `info` live in the main repository and are shared. The profile allows writes in the worktree and denies writes to:

- the worktree's `.git` file
- `<repo>/.git/worktrees/<name>`
- `<repo>/.git/config`, `<repo>/.git/hooks` and `<repo>/.git/info`

Observed with `/usr/bin/sandbox-exec` on macOS:

| Action | Result |
|---|---|
| `git status --porcelain` | exit 0 |
| `git diff` | exit 0 |
| create a file in the worktree | allowed |
| create `.git/hooks/pre-commit` | `Operation not permitted`, file not created |
| `git config core.hooksPath` | exit 255, `could not lock config file .git/config`, config unchanged |
| write the worktree `.git` file | `Operation not permitted`, the `gitdir:` line unchanged |

`git status` and `git diff` still print a line on stderr: `couldn't create cache file '…/xcrun_db-…' (errno=Operation not permitted)`. That is a known side effect of Seatbelt denying the developer-tools cache. The git commands themselves succeed, so a read-only gitdir is enough for status and diff when hooks, fsmonitor and the external diff driver are off.

`bwrap` is not installed on this Mac. The same read-only gitdir overlay is what the Linux containment tests bind.

## Hardlinks

Seatbelt checks paths. A hard link whose name sits in the worktree still writes the file outside it. Two checks close that, and both fail closed.

New links are refused in the sandbox. On this Mac, `(allow file-link (subpath DIR))` allows a link only when both paths are inside `DIR`. Adding a second `subpath` filter allows a link from outside the worktree into it, so that is not a source rule. The profile therefore uses a blanket `(deny file-link)`. Tools that fall back to copying still run: `pnpm install` of a `file:` dependency finishes inside that profile, and the installed file has link count 1. Linux does not need a profile rule. A link to a path that is not mounted returns `ENOENT`. A link to a read-only bind of a system file returns `EXDEV`.

Existing links are refused before a session is opened and again before `terminal/create`. The scan walks the worktree, skips the root `.git` entry, and refuses a regular file with `nlink > 1` (`hardlink-in-worktree`). The log carries the count and at most one path relative to the worktree. `containedWrite` already refuses a hard link through the canonicaliser.

A process outside the sandbox could create a link after the scan and before the launch. That is outside the threat model: the external agent runs inside the sandbox, where new links are denied. Scanning this Harness checkout (`worktrees/agy-m6b-external-agents`, `node_modules` included) took 1.2 s on this Mac on 2026-10-29 and found no hard link. That cost is not optimised here.

## Windows

`sandboxSpawn` refuses the platform `win32` before it starts a process (`SandboxFailure`, reason from `detectSandbox`: no restricted-token backend). Terminal callbacks use that refusal (`sandbox-unavailable`). There is no Windows sandbox in this package.

## ACP client

Owner decision of 2026-10-29: no `@agentclientprotocol/sdk`. `@agentclientprotocol/sdk@2.1.0` was published on 2026-10-28 and fails the 14-day rule. The client is hand-written against ACP schema v1, same as `packages/core/src/acp/`. The handshake against `AcpServer` and the scripted stub (permission, fs, terminal, overlong line, traversal, unknown method, update flood, reply to an unknown id) is the test `packages/core/test/external-agents/acp-client.test.ts`.
