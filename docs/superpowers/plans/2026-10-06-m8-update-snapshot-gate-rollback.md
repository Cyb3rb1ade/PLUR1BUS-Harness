# M8 `plur1bus update`: snapshot → swap → health gate → rollback

**Goal.** `plur1bus update` (without `--check`) applies a release per D78 / milestones §6.3 item 4 on a native install:
verified feed → download + checksum → snapshot → swap → start → health gate → automatic rollback on failure, with a
persistent state machine, `update --rollback` and `update status`. Spec: ADR-001 amendment (D78), ADR-012 §11 ("Native
installs follow the same D78 sequence on the state root"), milestones M8 acceptance 3.

**Non-goals.** Memory-store migration (stays `admin migrate`, patch releases never migrate), node-runtime or bundled
module changes (refused, see Rulings), the desktop/container upgrade path (image swaps, §11), notes display UI.

## Design

State lives in `<home>/update/`: `state.json` (the machine), `snapshot/` (`snapshot.json` = SHA-256 manifest, copies of
the binary, `config.json`, `manifest.json`, and the previous `runtime/core` tree *moved* there at swap time), `staging/`.

Phases (`state.json`, written atomically before the step it names): `downloading → stopping → snapshotted → swapping →
swapped → started → gated → committed`; failure path `rolling-back → rolled-back`; `failed` (snapshot unusable).
`owner` = pid of the updater. Recovery (`update::recover`, run by every `update` invocation and by `daemon start`) acts
only when the owner is dead: phase ≤ `snapshotted` → clean up; `swapping..started` or `rolling-back` → roll back
(idempotent, verifies the snapshot hashes first); `gated` → roll forward (commit the manifest).

Process steps go through a `Host` trait (stop, start, version, daemon-ready, `1staid check`): the real one execs the
*target* binary (so the new supervisor runs the new code; the service manager is reached only through `daemon
start|stop`, i.e. the existing `service` abstraction), tests inject a fake or a shell-script binary plus
`PLUR1BUS_SERVICE_FAKE`.

## Tasks → acceptance

| # | Task | Acceptance → test |
|---|---|---|
| 1 | `update/state.rs`: phases, atomic persistence, owner liveness | unit: round-trip, torn write ignored, phase order |
| 2 | `update/snapshot.rs`: create / verify / restore (binary, config, manifest, core move) | unit: byte-identical restore; tampered snapshot refused |
| 3 | `update/mod.rs`: apply + recover + rollback over `Host` | unit (fake host): happy path; gate failure → rolled back; crash at each phase → consistent |
| 4 | CLI: `--rollback`, `--yes`, `status`; feed verification shared with `--check`; `daemon start` recovery hook | `tests/update_apply.rs` (script binary, local signed feed): happy path; gate failure → byte-identical rollback; kill after swap → next start consistent; tampered feed / checksum refused; no real service manager |
| 5 | Docs: `docs:gen`, ADR-012 record, milestones status | `pnpm docs:check` |

## Rulings

- R1 `update` applies only a **verified** feed: a dev build with no baked key refuses (`release-unverified`); `--check` keeps reporting `verified:false`.
- R2 The swap covers the `plur1bus` binary and the core payload (`runtime/core`, which carries the bundled modules). A release that changes the node runtime or the installed module set is refused (`unit-unsupported`) and names the units: re-run `setup`. Fail closed.
- R3 Snapshot = binary, `config.json`, `manifest.json` (copied, hashed) and `runtime/core` (moved, same filesystem); never `state/`.
- R4 The swap target is `current_exe()`; `PLUR1BUS_UPDATE_TARGET_BIN` replaces it only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`.
- R5 Health gate = `<target> --version` equals the release version, the core child is `ready`, `1staid check` has no `fail`, all within `PLUR1BUS_UPDATE_GATE_TIMEOUT_MS` (default 90 s; seam under test internals).
- R6 The snapshot of the last committed update is kept for `update --rollback` and replaced by the next update.
- R7 No `--yes` and no terminal → exit 2, nothing changed (same rule as `1staid repair`).

## Open points

`admin smoke` (container-only today) is not part of the native gate; store migration on minor releases; module/node updates.
