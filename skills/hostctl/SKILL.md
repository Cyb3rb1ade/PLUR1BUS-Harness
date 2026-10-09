---
name: hostctl
description: Operate the human's local computer through root-contained D109 tools, with bounded files and owned process sessions.
---

Use only registered `hostctl.*` tools. They run locally inside the Harness; never start a remote host or expose a server for computer control.

1. Read/list/stat first. Stay in configured roots. For a large file, read a byte range with offset/length; binary content is refused.
2. Edit a precise unique string with `hostctl.fs.edit`; use more context after NOT_UNIQUE. Write/append publish atomically. Coordinate concurrent writers.
3. Use `hostctl.fs.trash` to remove an entry. Never use permanent deletion, shell deletion or a different tool to bypass a refusal.
4. Prefer `hostctl.proc.exec` with program, args array and root-contained cwd. For a long job use proc.start, retain its ID, inspect proc.read_output and close stdin/kill when done. IDs belong to the current agent/person/session and expire on session cleanup.
5. Shell commands need explicit config opt-in and normal D109 approval. Executables are not OS-sandboxed by cwd. Use the smallest task and timeout; avoid secrets in arguments/environment. Never turn a denied file action into an executable workaround.
6. Let the dispatcher request approvals only when needed; never claim a grant or surface trust. Foreign process termination uses proc.kill_foreign and a separate once approval. Clipboard reads require approval by default.
7. Open only intended root files or HTTP(S) links. Clipboard/notifications need an interactive desktop; report UNAVAILABLE/IO_ERROR if a helper is missing.

Examples:

```json
{"tool":"hostctl.fs.read","args":{"path":"notes.txt","offset":0,"length":4096}}
{"tool":"hostctl.fs.edit","args":{"path":"notes.txt","oldText":"Status: pending","newText":"Status: done"}}
{"tool":"hostctl.proc.start","args":{"program":"node","args":["scripts/check.mjs"],"cwd":"/granted/project","timeoutMs":120000}}
{"tool":"hostctl.proc.read_output","args":{"id":"ID_FROM_START"}}
```

Set shell.default to pwsh on Windows or bash/zsh on Unix; paths still use the host's rules. Trash uses Finder, Recycle Bin or freedesktop gio and never falls back to permanent deletion. No screen/input tools are available in this package.
