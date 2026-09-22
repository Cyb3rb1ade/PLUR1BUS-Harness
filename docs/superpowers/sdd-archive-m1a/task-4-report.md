# Task 4 (PR-01a) Report — `lib/platform.js` and its unit tests

## Summary

Added `lib/platform.js`, exporting `isFilesystemPath`, `securePath`,
`ipcAddress`, `isUnsafeLink`, and `canonicalIdentityPath`, exactly as given in
the task brief (verbatim code and tests). Pure addition — no existing file
was touched, no call site changed. Implements the shapes declared in
`types/engine.d.ts` 1.0.0's `PlatformCapabilities`, `SecurePathResult`, and
`IpcAddress`.

## Shape check against `types/engine.d.ts` (Task 3, HEAD a7f058b3)

Read `types/engine.d.ts:123-139` before writing:

- `PlatformCapabilities.securePath(path, options?: { mode?: number })` —
  the module's `securePath(target, options?)` accepts a superset of options
  (`mode`, `fd`, `platform`, `execFile`, `username`) needed for testability
  and the win32 ACL path; all are optional so the interface's narrower call
  signature is satisfied. Return shape matches `SecurePathResult` exactly
  (`applied`, optional `reason`, optional `mechanism`).
- `SecurePathResult.reason` in the `.d.ts` is a union of three strings
  (`"not-a-filesystem-path" | "missing" | "unsupported-platform"`); the
  brief's implementation only ever produces `"not-a-filesystem-path"`. No
  disagreement — a narrower runtime set is still assignable to the wider
  declared union. No brief/`.d.ts` conflict found; no deviation from the
  brief was needed.
- `IpcAddress` and `PlatformCapabilities.ipcAddress/isUnsafeLink/canonicalIdentityPath`
  match the module's exports directly.

## TDD

**RED** — created `tests/platform.test.js` verbatim from the brief, ran:

```
cd /home/claude/work/plur1bus-m1a && PATH=/home/claude/.node24/bin:$PATH node --test --test-concurrency=1 tests/platform.test.js
```

Output (tail):
```
✖ tests/platform.test.js (46.657382ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```
Failed to load with `ERR_MODULE_NOT_FOUND` for `../lib/platform.js`, as
expected.

**GREEN** — created `lib/platform.js` verbatim from the brief, ran the same
command:

```
ℹ tests 18
ℹ suites 5
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

All 18 cases pass, including:
- `securePath` chmods a real file, chmods via `fd`, and — the Review Focus
  item pinned to this task — secures a **live Unix-domain socket** bound
  with a real `net.Server` in a temp dir (`statSync(socketPath).mode & 0o777
  === 0o600` after `securePath`), rather than refusing it.
- `securePath` returns `{ applied: false, reason: "not-a-filesystem-path" }`
  for a `\\.\pipe\…` address with `platform: "win32"` — never throws.
- The win32 ACL branch (`icacls`) is reached both via the `platform` option
  and via a stubbed `process.platform`.
- `ipcAddress` abstract-socket/named-pipe/unix-socket branches, determinism.
- `isUnsafeLink` symlink detection, pre-read `stat` injection, and the win32
  junction/reparse-point path (via native realpath mismatch, since
  `isSymbolicLink()` is false for those on Windows).
- `canonicalIdentityPath` POSIX realpath resolution, win32 case/separator
  folding, and the nonexistent-path fallback to the absolute path.

## Lint / golden / full suite

```
cd /home/claude/work/plur1bus-m1a && PATH=/home/claude/.node24/bin:$PATH npm run lint
```
Exit 0, no output (runs `node --check` over `index.js`/`lib`/`tests`/`test`,
`node --check` over `scripts`/`tools`, then `scripts/typecheck.mjs`).

```
cd /home/claude/work/plur1bus-m1a && PATH=/home/claude/.node24/bin:$PATH node --test --test-concurrency=1 tests/golden-prefix.test.js
```
```
ℹ tests 9
ℹ pass 9
ℹ fail 0
```
Byte-identical golden prefix corpus confirmed (all scenario tests plus the
determinism and "covers at least five scenarios" checks pass).

```
cd /home/claude/work/plur1bus-m1a && PATH=/home/claude/.node24/bin:$PATH timeout 590 npm test
```
```
ℹ tests 5103
ℹ suites 906
ℹ pass 5100
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 429781.71738
```
Matches the accepted signature given in the task context (`fail 0, skipped
3`) — no behaviour change, no regression, and the 18 new tests are included
in the totals (5103 vs. a pre-task 5085 tests: 18 new tests added, net
+13 passing over the brief's expectation of `pass 18` for the new file plus
whatever the pre-existing suite carried; no baseline count was captured
before this task ran, so I'm reporting the observed absolute numbers rather
than a delta).

## Commit

```
c67cc820 feat(platform): add securePath, ipcAddress, isUnsafeLink, canonicalIdentityPath
```
2 files changed, 340 insertions(+): `lib/platform.js`, `tests/platform.test.js`.
Commit message matches the brief's Conventional Commits text plus the
required `Co-Authored-By` / `Claude-Session` trailers.

## Self-review (AGENTS.md)

- **camelCase**: all five exports and internal helpers/constants follow the
  convention (`isFilesystemPath`, `securePath`, `ipcAddress`, `isUnsafeLink`,
  `canonicalIdentityPath`; constant `NAMED_PIPE_PREFIX` is UPPER_SNAKE_CASE
  per the constants rule).
- **JSDoc on new exports**: all five exported functions have a one-line
  description plus `@param`/`@returns`, matching house style.
- **No silent catches**: three `catch` blocks in the module —
  `lstatSync` failure in `isUnsafeLink` (returns `false`, documented as "a
  missing path is not unsafe" — an explicit error result, not a swallow);
  `realpathSync.native` failure in the win32 branch of `isUnsafeLink`
  (returns `false`, same rationale — a target that can't be natively
  resolved isn't flagged as a reparse point); `realpathSync` failure in
  `canonicalIdentityPath` (falls back to the resolved absolute path, per the
  function's own documented contract for a nonexistent target). Each catch
  returns a deliberate, documented result rather than swallowing the error
  with no trace; none re-throws because in every case the documented
  behaviour for "target does not exist / cannot be resolved" is a specific
  non-throwing return value, which is also what the tests assert
  (`falls back to the absolute path when the target does not exist`, `is
  false for a missing path`).
- No new runtime dependencies; only `node:child_process`, `node:crypto`,
  `node:fs`, `node:os`, `node:path` (all already used elsewhere in the repo,
  e.g. `node:crypto`/`node:fs` in `lib/providers/scoped-embedding-ipc.js`).
- Did not touch `index.js`'s export list, any workflow file, the golden
  oracle fixtures, or `package.json`'s protected fields (constraints
  6/7/9 unaffected — nothing in this task touches them).

## Concerns / notes

- None blocking. One pre-existing untracked file,
  `docs/superpowers/plans/2026-09-22-m1a-engine-extraction.md`, was present
  in the worktree before this task started and is unrelated to Task 4; it
  was left untouched and unstaged (not part of this commit).
- The brief's own Step 5 "Expected" line (`suite at the accepted baseline
  (now 5 094 tests, 5 089 pass, 2 fail)`) does not match what was actually
  observed (`5103 / 5100 pass / 0 fail / 3 skipped`); I followed the task
  context's explicit override ("accepted signature in this container: fail
  0, skipped 3") rather than the brief's stale numbers, and the observed run
  satisfies that override with zero failures.
