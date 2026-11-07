# Core parity harness (Phase 4, modes T, S and B)

Every Phase 4 package proves parity with this harness: the Rust core must behave like the TypeScript core, and a deviation
is allowed only as a recorded defect `P4D-n` or an owner decision. Plan: `docs/superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md` §3 and §4.3.
Which TypeScript file maps to which mode: `docs/superpowers/plans/phase4/MODULE-MAP.md`.

| Mode | Where | What |
| --- | --- | --- |
| V, vectors | `scripts/parity/`, `fixtures/parity/` | exporters record pure-function results; see `scripts/parity/README.md` |
| T, transcripts | this directory | record RPC traffic of the TypeScript core, replay it against a core |
| S, system | `tests/system/helpers.ts` | `PLUR1BUS_CORE_IMPL=ts\|rust` for every suite in `tests/system/` |
| W, wire | arrives with P4-03 | a Rust fake HTTP/WebSocket server (`crates/plur1bus-core/tests/support/`) |
| B, stores | `store-roundtrip.ts` | open a copy of a core SQLite store, write, read, check `user_version` |

## T, transcripts

**Recorder.** The TypeScript `RpcServer` (`packages/module-api/src/parity-recorder.ts`) writes one NDJSON line per frame
(`{"seq","conn","dir":"in"|"out","msg"}`), but only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1` **and** an explicit
`PLUR1BUS_PARITY_RECORD=<file>`. The credential of the handshake is replaced by `<token>`.

**Determinism.** A `ts` target (`target.ts`) is the real `createCore` with the existing seams: a fixed clock
(`FAKE_CLOCK_START_MS`, counting up by one per read), a fixed `instanceId`, the flat embedder and no dream scheduler. Other
generated values (subscription ids, connection ids, `core.status.pid`, a few timestamps that do not use the injected clock)
are normalised by the comparison, not faked.

**Flows.** `flows.ts` defines the recorded flows; `record.ts` records them into `transcripts/<flow>.ndjson` (never edit by
hand): `core-status`, `auth-handshake`, `settings-roundtrip` (media.preferences, because `config.get/set` are served by the
supervisor, not by the core), `events-subscribe` (`core.state` after a second connection calls `core.shutdown`),
`error-paths` (unknown agent, unknown method, invalid params).

**Replay.** `replay.ts` sends the `in` lines on their connections, one request at a time, waits for the recorded responses and for
the recorded number of notifications, and returns the transcript of what happened. `transcript.ts` compares: uuids are
numbered by first appearance, times and pids under listed keys are masked, notifications are compared as a multiset (their order
and their position between responses are free), responses in the order of their requests. `--strict-order` compares the full
frame sequence. A difference prints as `conn 0, response to #3 media.preferences.get: $.result.global: expected true, got false`.

```text
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/run.ts [--impl ts|rust] [--strict-order] [file.ndjson ...]
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/record.ts [flow ...]
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test tests/core-parity/*.test.ts
```

`--impl rust` (or `PLUR1BUS_CORE_IMPL=rust`) fails with `plur1bus-core not built (P4-03/P4-10)` until the binary exists; it never
falls back to `ts`. The self-test (`selftest.test.ts`) records every flow against the TypeScript core, replays it against the
TypeScript core, and checks that the committed transcripts are still what a fresh recording produces.

## S, system

`PLUR1BUS_CORE_IMPL=ts` (default) is today's behaviour. `rust` starts `plur1bus-core` with the legacy core behind it (P4-10) and
until then fails with a clear error. Every core start in `tests/system/helpers.ts` goes through `selectCoreImpl()`.

## B, stores

`StoreCopy.open(file)` copies a core store (and its WAL) into a temp dir, then `write`, `read`, `check()` (integrity, foreign keys,
`user_version`, journal mode), `assertUserVersion(n)` and `migrateWith(migrate)`. `createStoreAtVersion` builds a store at schema
version N with the store's own `migrate`. The Rust side opens the same files through `StoreCopy.path`.
