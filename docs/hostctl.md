# Local computer control (hostctl)

`@plur1bus/hostctl` extends the existing D106 `host-tools`, `tools/fs` and `tools/exec` implementation patterns. It runs inside the local Harness Core and registers through the [turn composition](architecture/turn-pipeline.md). It opens no listener, hosts nothing remotely, and has no MCP transport. It reuses the D109 path canonicaliser, verified file handles, clipboard adapters and notification adapters. No separate computer-control ADR was found; this is an additive D106 implementation, not a replacement policy.

## Tools and capabilities

Every name below has the `hostctl.` prefix. All tools have closed JSON parameter schemas and traverse `ToolDispatcher` → `policy.decide` → the normal approval/grant mechanism before execution.

| Tools | D109 capability | Default |
| --- | --- | --- |
| `fs.read`, `fs.list`, `fs.search`, `fs.stat` | `fs.read` | Allowed inside roots |
| `fs.write`, `fs.append`, `fs.edit`, `fs.mkdir`, `fs.copy`, `fs.move` | `fs.write` | Existing D106 inside-root default; normal policy overrides apply |
| `fs.trash` | `hostctl.fs.trash` | Approval, at most task scope |
| `proc.exec`, `proc.start`, `proc.shell` | `shell.exec` | Approval; shell also needs explicit config opt-in |
| `proc.list`, `proc.read_output` | `hostctl.proc.session.read` | Allowed for owned sessions only |
| `proc.write_stdin` | `hostctl.proc.session.write` | Approval, at most session scope |
| `proc.kill` | `proc.signal` | Approval, at most session scope |
| `proc.kill_foreign` | `hostctl.proc.kill_foreign` | Separate approval, once only |
| `sys.info` | `sys.read` | Allowed |
| `app.open`, `notify` | `os.script` | Approval, at most session scope |
| `clipboard.read`, `clipboard.write` | `clipboard.read` | Approval, existing D106 clipboard capability |

Capability names deliberately reuse D106 where possible. Clipboard writes and app opening retain separate tool names, so `tools.deny` and tool-specific rules can narrow them independently. Hostctl never raises caller surface trust; unattested surfaces must remain T1 under the existing authentication/surface rules. Medium/high-risk approval is unavailable from T1. Read the [approval](approvals.md) and [RBAC](rbac.md) contracts before adding tools.

## Configuration

The generated [config reference](config.md) is the source for schema defaults. `tools.hostctl` restarts Core when changed:

```json
{
  "tools": {
    "hostctl": {
      "enabled": true,
      "shell": { "allowed": false, "default": "bash" },
      "exec": { "timeoutMs": 30000 },
      "output": { "maxBytes": 65536 },
      "env": { "allow": ["PATH", "LANG", "LC_ALL", "TZ", "TERM", "SystemRoot", "PATHEXT", "TEMP", "TMP"] },
      "denyPatterns": [],
      "search": { "maxResults": 100 }
    }
  }
}
```

Set shell.default to `pwsh` on Windows or `zsh` on macOS if desired. argv execution never starts a shell implicitly. Explicit shell interpreters must use `proc.shell`; arbitrary approved interpreters/programs can still execute code. Secret/injection environment names remain blocked even if added to the allowlist. Additional deny patterns are case-insensitive literal substrings; built-in dangerous-command checks cannot be removed.

## Files and safety boundaries

Relative paths resolve against the first configured root (the agent workspace by default). Parent traversal, UNC/device paths, Windows reserved names/alternate streams, credential deny paths and symlink/junction escapes are refused. Reads open verified handles and detect binary/invalid UTF-8. `offset` and `length` are byte ranges. Files larger than the output limit require an explicit range; a range starting inside a UTF-8 codepoint is refused as binary.

Writes, appends and exact unique edits publish a sibling temporary file atomically. Append/edit read a bounded snapshot: concurrent edits by another writer are not a merge mechanism; coordinate shared-file changes. Copy handles bounded regular files; move handles regular files on the same filesystem; copy requires a fresh destination, and mkdir creates one level. Recursive listing/search cap depth at 16, entries at 1000 and results at the configured search limit. When installed, ripgrep receives verified bounded text over stdin, never caller paths; otherwise a JS matcher is used. Search treats queries literally and ignores binary/oversize/denied files. Links are never traversed recursively.

The canonicaliser rechecks resolved targets and file identity around opens. Namespace operations (mkdir/move/native Trash) recheck the parent and reject symbolic-link entries. Node offers no portable directory-handle-relative rename/mkdir/Trash API: a hostile local actor concurrently replacing ancestor directories can still race these namespace operations. Use roots private to the Harness user; this is not an OS sandbox against another process running as that user. Approved executables likewise are **not** confined by cwd to the roots and may access the user's files or network. Root checks protect file tools and process cwd; command deny patterns are an additional guard, not a sandbox.

`fs.trash` calls Finder Trash on macOS, VisualBasic FileIO SendToRecycleBin on Windows, and `gio trash` (freedesktop Trash) on Linux. Missing helpers or unsupported filesystems fail closed. There is no permanent-delete fallback. Configured roots themselves cannot be trashed or moved.

## Process sessions and local integration

`proc.exec` waits for completion; `proc.start` returns an opaque ID. Use `proc.read_output`, `proc.write_stdin` and `proc.kill` with that ID. IDs bind person, agent and Harness session; another session cannot read output or control the child. Only owned processes appear in `proc.list`. Foreign termination is a distinct PID tool/capability; PID 0/1 and the Harness itself are refused.

Output combines stdout/stderr, retains a bounded prefix and appends `[OUTPUT TRUNCATED]`. Processes time out after at most five minutes; callers may choose a shorter timeout. At most 32 children run per root pool; 128 records are retained with completed records evicted first. POSIX process groups are reaped on termination and leader exit. Windows taskkill terminates a running process tree; descendants detached before the leader exits require an OS Job Object sandbox, which is not provided here. Session archive/chat replacement triggers cleanup through a post-commit observer; composition disposal reaps remaining children. Background jobs are local, finite Harness-session resources, not a service daemon.

`sys.info` returns OS, CPU, RAM, capacity of root filesystems and interface addresses without hostname, username, MAC or environment. App opening accepts a root-contained file or HTTP(S) URL without credentials. Clipboard and notifications need an available interactive desktop. Linux requires Wayland clipboard tools or xclip/xsel; notifications need notify-send. Native helper targets/text use argv/stdin, never caller-supplied shell source.

## Audit and errors

Each executed operation emits begin/end events to the existing audit sink. Begin-audit failure prevents execution. Events allowlist operation, actor/session, path targets, opaque process ID/PID, phase and result code; the D111 redactor sanitises string values. They omit file/clipboard/stdin/notification contents, process output, commands, argv and environment values. Dispatcher policy events cover denied and pending-approval calls before any operation runs. URLs and their query strings are not included in hostctl audit targets.

Tool values are `{ "ok": true, "value": ... }` or `{ "ok": false, "error": { "code": ..., "hint": ... } }`. Codes include `OUTSIDE_ROOT`, `DENIED`, `ABORTED`, `TIMEOUT`, `TOO_LARGE`, `NOT_UNIQUE`, `BINARY`, `INVALID_ARGUMENT`, `EXISTS`, `NOT_FOUND` and `IO_ERROR`. Review the hint before retrying; never work around a denial by switching tools. An executed program's nonzero exit code is returned for inspection, not silently treated as success.

## Local tests and platform evidence

```bash
pnpm --filter @plur1bus/hostctl test
HOSTCTL_TRASH_SMOKE=1 pnpm --filter @plur1bus/hostctl test
```

Tests use only temporary synthetic files, fake process timers, fake native helpers and fake approvals; no network is used. Native argv contracts for macOS/Linux/Windows run on every host. Windows junction/reserved-name cases run only on Windows. The opt-in Trash smoke touches only its newly created fixture and deliberately leaves that fixture in the native Trash. Native Windows/Linux acceptance must be recorded separately from macOS results; mocked platform tests do not prove a native run.

Desktop Commander is an external MCP server with its own transport and lifecycle. Hostctl is a built-in local tool family under the Harness D109 dispatcher; installing or exposing a remote MCP server is unnecessary. Follow-up packages cover screen/input control and RPC/Web views of process sessions. No screenshot, keyboard/mouse control, remote hosting or process-session RPC methods are included here.
