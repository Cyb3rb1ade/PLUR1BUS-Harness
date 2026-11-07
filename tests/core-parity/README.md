# Core parity harness (Phase 4, modes T, S and B)

Every Phase 4 package proves parity with this harness: the Rust core must behave like the TypeScript core, and a deviation
is allowed only as a recorded defect `P4D-n` or an owner decision. Plan: `docs/superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md` §3 and §4.3.
Which TypeScript file maps to which mode: `docs/superpowers/plans/phase4/MODULE-MAP.md`.

| Mode | Where | What |
| --- | --- | --- |
| V, vectors | `scripts/parity/`, `fixtures/parity/` | exporters record pure-function results; see `scripts/parity/README.md` |
| T, transcripts | this directory | record RPC traffic of the TypeScript core, replay it against a core |
| S, system | `tests/system/helpers.ts` | `PLUR1BUS_CORE_IMPL=ts\|rust` for every suite in `tests/system/` |
| W, wire | `scripts/parity/export-wire.ts`, `crates/plur1bus-core/tests/support/` | exchanges recorded from the TypeScript fake servers into `fixtures/parity/wire/`, served by a Rust fake HTTP/WebSocket server on loopback |
| B, stores | `store-roundtrip.ts`, `store-b-driver.ts` | open a copy of a core SQLite store, write, read, check `user_version`; `crates/plur1bus-store/tests/mode_b.rs` drives the driver |

## T, transcripts

**Recorder.** The TypeScript `RpcServer` (`packages/module-api/src/parity-recorder.ts`) writes one NDJSON line per frame
(`{"seq","conn","dir":"in"|"out","msg"}`), but only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1` **and** an explicit
`PLUR1BUS_PARITY_RECORD=<file>`. The recorder is a test seam in the repo's established pattern (an environment gate behind
`PLUR1BUS_ALLOW_TEST_INTERNALS=1`), never a product feature; no config key, flag or UI enables it.

**Redaction (transcripts are committed).** The handshake token becomes `<token>` (the replayer puts the live one back). Every
value under a key matching `/token|secret|password|passphrase|api[-_]?key|authorization|cookie|ticket|credential|private[-_]?key|pin$/i`,
at any depth, in params, results and notifications, becomes `[REDACTED:secret]`; so does the `value` of a `{key|name, value}`
pair whose name matches (a `config.set` change of `providers.x.apiKey`) and the `value` of any `secret.*` call. A dotted key
holding an object (a method name in the capabilities map) is not treated as a credential. The core's own string redactor
(`packages/core/src/logs/redact.ts`) is not reachable from `module-api` without a new dependency, so strings are not scanned:
a flow must not call a method that returns a credential under a neutral key name.

**Concurrent recorders.** The recorder never truncates. The first server to open `<file>` gets exactly that name; any other
server (a second `createRpcServer`, the control server, another process, a leftover file) writes a sibling
`<stem>.<server>-<pid>-<n>.ndjson`. Each file is a complete transcript with its own `seq` and `conn` numbering, and the replayer
treats each as a separate transcript. `record.ts` removes the target file first.

**Not represented.** Lines that do not parse and over-long frames are not recorded (only the error replies to them are), so a
transcript cannot represent them; the framing tests (`packages/module-api/test/framing*.test.ts`) cover them instead.
After an RPC schema change the `core.auth` result changes: re-run `record.ts`.

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

**Error texts (controller ruling, P4-03).** Error codes (`error.code`, `error.data.error`) and `reason` strings must match
exactly. The free-text `message` and the `detail` of `E_INVALID_PARAMS` are not contract (ADR-016): the Rust validator
(`jsonschema`) words its findings differently from ajv, so the comparison replaces both with `<text>` for an
`E_INVALID_PARAMS` error only (`transcript.ts`, P4-10); every other error's message is still compared.

**The `rust` target (P4-10).** `--impl rust` starts `plur1bus-core serve` (`PLUR1BUS_CORE_BIN`, else
`target/release/plur1bus-core`, else `target/debug/plur1bus-core`) with the built `packages/core/dist/core.js` behind it,
the flat embedder and no dream scheduler. The legacy core cannot take the in-process fake clock and instance id, so a
recording made from `ts` is compared with times, pids and uuids masked as always. `p4-10-parity.ts` replays a transcript
against both targets and compares the two replays (the front door must add nothing), and drives the contract fixtures
through both (gate G1).

```text
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/run.ts [--impl ts|rust] [--strict-order] [file.ndjson ...]
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/record.ts [flow ...]
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test tests/core-parity/*.test.ts
```

`--impl rust` (or `PLUR1BUS_CORE_IMPL=rust`) fails with `plur1bus-core not built (P4-03/P4-10)` when the binary is missing; it
never falls back to `ts`. The self-test (`selftest.test.ts`) records every flow against the TypeScript core, replays it against the
TypeScript core, and checks that the committed transcripts are still what a fresh recording produces.

## S, system

`PLUR1BUS_CORE_IMPL=ts` (default) is today's behaviour. `rust` (P4-10) passes `PLUR1BUS_CORE_IMPL=rust` and `PLUR1BUS_CORE_BIN`
(beside the CLI under test unless set) to the CLI and the supervisor, which then run `plur1bus-core` with the legacy core
behind it; without the binary it fails with a clear error. Every core start in `tests/system/helpers.ts` goes through
`selectCoreImpl()`.

## B, stores

`StoreCopy.open(file)` copies a core store (and its WAL) into a temp dir, then `write`, `read`, `check()` (integrity, foreign keys,
`user_version`, journal mode), `assertUserVersion(n)` and `migrateWith(migrate)`. `createStoreAtVersion` builds a store at schema
version N with the store's own `migrate`. The Rust side opens the same files through `StoreCopy.path`.
