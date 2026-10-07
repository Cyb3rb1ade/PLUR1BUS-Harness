# File tools (`file.read`, `file.write`, `file.list`, `file.stat`)

Hand-written. Code: `packages/core/src/tools/fs/`. Plan: `docs/superpowers/plans/2026-10-07-b2-fs-tools.md`. Path rules: D109
(`packages/core/src/policy/paths.ts`, used unchanged).

`createFsTools({ roots, deny?, cwd?, limits? })` returns dispatcher-ready specs and capability rows (like `createWebTools`);
nothing registers itself.

| Tool | Effect (D109 §2) | Notes |
|---|---|---|
| `file.stat` | read | type, size, mtime of the real target |
| `file.list` | read | sorted, links shown never followed, deny-listed names hidden, ≤ 1000 entries, > 10 000 refused |
| `file.read` | read | regular files only; ≤ 1 MiB unless `offset`/`length`; text (UTF-8) or `encoding: "base64"` |
| `file.write` | local-write | whole file, temp + `fsync` + rename; create-only unless `overwrite: true`; parent must exist; ≤ 4 MiB |

## Guarantees
- Every path is canonicalised on the **real target** and must lie inside a root; `..`, backslashes (POSIX), Windows
  drive-relative / UNC / `\\?\` / stream / device-name forms, links leaving the root, dangling links, hard-linked write
  targets and `/dev`, `/proc`, `/sys` are refused with `path-refused` and the policy's `reason`.
- Opens go through `openVerified` (`O_NOFOLLOW`, dev/ino/birth re-check, parent re-check). Reads decide "regular file?"
  on the **opened handle** (`fstat`), and open with `O_NONBLOCK` so a FIFO cannot hang the tool.
- A write re-validates the destination (same real path, same file or still absent, same parent) immediately before the
  swap. Create-only publishes with `link` + `unlink` (never clobbers); overwrite uses `rename`, which replaces a planted
  link instead of following it. The temp file is removed on every failure path.
- Results and failures never contain the host's absolute path; paths are `rootId` + root-relative `/` path.

## Residual risks
- A parent directory swapped between the last check and the `rename`/`link` syscall is detected only before it (Node has
  no `openat`/`renameat`); the swap target must still be inside the temp file's directory tree on the same volume.
- Windows has no `O_NOFOLLOW`; the policy's identity and path re-checks carry the weight (see `openVerified`).
- On file systems without hard links the create-only publish falls back to check + `rename` (small window).

## Test seam
`FsConfig.testHooks.afterCheck` injects a race between check and use; honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`.
