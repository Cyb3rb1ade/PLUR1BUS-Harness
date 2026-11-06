# CX6 fullscreen terminal evidence — 2026-11-02

Product source: `5fe209e901f50fff27ce47407bd4346a13609b59`; parent CX4 `0ed1814433216331fd6b7c28b4c1b3d1948e56ab`.
The default-on `tui` Cargo feature selects the renderer for explicit `code --tui` in a supported interactive terminal.
No RPC schema or session migration is added. Calls, events and approval decisions remain in CLI-1's existing runtime.

## Automated native coverage

- 47 coding unit tests pass: keys, bounded Unicode paste, ownership, history and preview limits, actual wrapped
  scrolling, folding, resizing through zero-sized frames, measured status projections, de/en, and six complete
  TestBackend frame snapshots. A row-end marker preserves every terminal cell in whitespace-clean fixtures.
- Real PTY child processes prove complete termios restoration and alternate-screen/paste/cursor cleanup after
  normal exit and an intentional unwind. Every child and descriptor is owned and cleaned up.
- Real Core/router/dispatcher integration: eleven native coding tests and the local help test pass, including
  physical approval followed by execution, SIGTERM during an unanswered approval with no execution, idle EOF,
  piped JSON and `TERM=dumb`. The fullscreen path retains one binding and at most the same two connections,
  including its final cancellation; no separate renderer RPC client is created.
- Feature-off build: sixteen coding unit tests, nine native Core integration tests, the help test and all-target
  package Clippy pass. No new skip or ignored test was introduced. Two fullscreen-only PTY cases are compiled
  only when their renderer exists; fallback cases run in either build.

The new regressions were observed failing before their fixes: unknown `--tui`; display bounds and terminal
control escaping; stale approval identity; raw-mode cleanup on unwind; third-connection cancellation; bounded
ASCII paste; short help scrolling; active diff eviction at the shared preview limit; and an omitted line-limit
marker. Golden frames were inspected and rerun in normal comparison mode. Full repository push gates are
reported in the PR separately from these scoped preflights.

## Release help startup and size

Native darwin arm64, Apple M5 Pro, OS 27.2.0,
18 logical CPUs, 51,539,607,552 bytes RAM, Node v24.21.0.
Rust 1.95, locked optimized release builds, two build jobs, no incremental compilation. This is a local host,
not the five-target acceptance matrix or the B1 coding reference run.

Each cell uses 30 measured new processes. Cold-process means fresh home paths and zero warmups; warm-process
uses one home path and three discarded warmups. OS page and antivirus caches remain uncontrolled. Percentiles
use nearest rank. No measured sample or outlier was discarded, and no Core was started.
[Raw samples, binary hashes and hardware](cx6-help-startup-2026-11-02.json) are retained.

| Build | Command | Scenario | p95 ms | Maximum ms |
|---|---|---|---:|---:|
| feature-off-control | help | cold-process | 4.633 | 4.678 |
| feature-off-control | help | warm-process | 3.762 | 3.827 |
| feature-off-control | code-help | cold-process | 3.691 | 3.737 |
| feature-off-control | code-help | warm-process | 3.633 | 3.666 |
| default-tui | help | cold-process | 3.748 | 5.825 |
| default-tui | help | warm-process | 3.662 | 3.707 |
| default-tui | code-help | cold-process | 3.952 | 4.371 |
| default-tui | code-help | warm-process | 3.612 | 3.964 |

With the feature enabled, every measured help p95 is below 100 ms. Release size is **28,654,256 bytes**;
the same CX6 source built without default features is **28,348,512 bytes**: **+305,744 bytes**.
That control measures the frontend feature's size, not a delta against the unavailable B1 coding baseline.
The local release build has no pinned OS-attestation helper digest; it is not a signed release acceptance build.

## Remaining acceptance

- B1 coding baseline and per-package comparison: open until the owning benchmark package supplies the baseline.
- Manual terminal checks on all five release targets remain open, including Alt+Enter in Windows Terminal,
  conhost and macOS Terminal.app (U18). `/queue` remains available as a key-independent fallback.
- Native Windows/Linux and the remaining macOS target are not claimed from these local arm64 tests.
- Real OS-confirmation helper acceptance remains separate from deterministic test attestation.
- Post-tool steering and queued-follow-up acceptance require H3-1; an older Core is reported honestly.

Dependency ages, exact pins, licences, LRU unification and the existing strict cargo-deny maintenance advisory
are recorded in the [dependency evidence](cx6-terminal-dependencies-2026-11-02.md). No policy exception was added.
