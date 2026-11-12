# Engine parity

RE-09/T1 runs the installed Node engine through the Core's `bindEngine` and the Rust engine through the existing
`EngineClient` over authenticated local IPC. The Rust fixture host uses the Core's guarded reverse RPC handlers with
an in-memory secret store and a deny-all egress policy. Each run gets its own temporary Harness home and a copy of the
requested Lance fixture. The fixture workspace and the engine process are released at the end of the run.

## Run

```sh
pnpm install --frozen-lockfile
pnpm gen
cargo build --locked -p plur1bus-engine

export PLUR1BUS_ALLOW_TEST_INTERNALS=1
pnpm parity --check tests/engine-parity/scenarios --node-only
pnpm parity --check tests/engine-parity/scenarios --report /tmp/parity.md
pnpm parity --compare tests/engine-parity/scenarios/recall/plain.json
node --conditions=source --test tests/engine-parity/run.test.ts
```

Use Node 24.21.0 and Rust 1.95. `PLUR1BUS_ENGINE_BIN` can point to a different locally built binary. `--check`
with no path selects the complete scenario directory. `--report` can also select that directory by itself.
The report shows each engine's outcome. Missing dependencies and unsupported operations fail the check.
The four starter cases exercise plain and temporal recall, a capture and its replay, and list/show/forget
followed by a visibility check. Later cases add warm-only recall and `recall/weak-hit-refined`, a hash-embedder
recall whose raised `autoRecallMinScore` is met only by the refined query (RE-D151). The Rust check is expected
to expose any operations still awaiting composition. `ops/correct`, `ops/share-propose` and `ops/import-unimport`
(RE-D165) compare only steps whose results both engines can produce identically: refusals, empty proposal lists,
import replay, unimport previews and an apply that selects nothing. A successful correct, share or propose
returns a fresh ID (Node's fixed UUID sequence, a random v4 ID in Rust), an applying unimport differs by
`derived.cleanupErrors` (KNOWN-GAP F14/RE-D129), `memory.state` returns the run's archive path and counts only
ACL-visible cards (RE-D31/F4), and the pin has no A1 methods (`stats`, `promote`, `curation`). The import scenario
lists the whole time range: a windowed list after an import returns fewer cards at the pin, which fetches
`limit + 1` rows before its ACL check (RE-D31/F4; Rust is right).

RX9/T9a adds four scenarios on the `store-v1` and `empty` stores. `ops/checkpoint` captures one turn and checkpoints
twice (written, then the idempotent repeat). `ops/rebind-unbind-link` runs `memory.rebind` as a dry run (the
store has no user-owned cards, so nothing matches and the real write, whose ID differs per engine, is left out),
`memory.unbind` with a malformed and an unknown ID, and `memory.link` through its dry run, first link, repeat, a
missing card and a blank `sourceRef`; these write operations need the `system` actor. `ops/admin-migrate` runs
`admin.migrate` on the migrated store (`1 -> 1` is not applied, `0 -> 1` conflicts). `jobs/run` runs `embedding-drain`,
the only job Rust composes without an owner binding (the other 19 answer `E_NOT_AVAILABLE`/`operation-unavailable`),
with explicit triggers and with and without `dryRun`; the neo-disabled skip is identical on both sides.

RX9 also commits `jobs/run-default-trigger` (a run without `trigger` is a `harness` run, as at the pin) and
`ops/admin-migrate-empty` (`admin.migrate` on a home without a store conflicts and writes nothing).

An inline `expect` is one exact expectation for both engines and for the recording, so it cannot express an engine
specific exception. These differences are named exceptions and have no scenario:

- `jobs.run` for an agent without a store: Node `failed` with reason `error:Error`, Rust `skipped` with `neo_disabled`
  (Rust is more precise; no caller depends on the difference).
- Jobs other than `embedding-drain` answer `operation-unavailable` in Rust (F13, KNOWN-GAP).
- A capture returns fresh card IDs (Node's fixed UUID sequence, a random v4 ID in Rust), so a list after a capture
  cannot be compared by ID.
- `memory.state` (F4/RE-D31): Rust counts only ACL-visible cards, and `archiveDir` is a fresh temporary path per run,
  which also prevents a recording; it needs a runner change.

## Record

```sh
PLUR1BUS_ALLOW_TEST_INTERNALS=1 pnpm parity --record tests/engine-parity/scenarios
```

The recorder verifies the frozen workspace lockfile and the pin's recorded source hashes before importing Node.
It accepts a golden only after two equal recordings from fresh homes. Give any golden change its source pin
and reason in the PR. Keep the existing goldens under `goldens/tokens` and `config` with their own recorders.

Scenario files use `engine-parity.scenario/1` and contain an engine config override, a store selection and a
list of operations with closed `engine.*` arguments. An inline expectation is an exact normalized result subject
to the same step tolerance. Use it for intentional errors such as `not-found`. Unanticipated operation errors
fail a golden check.

The offline lane supports the committed `store-v1` store and `empty`, the Core's flat embedding seam and the
RE-04 hash embedder. Both sides use the specified logical clock. Node also fixes UUID inputs during recordings so
the generated deletion receipt is checked as an ID. The process adapter uses real monotonic deadlines and a stdin
lifeline. The optional `llm: "fixture:<name>.json"` loads `llm/<name>.json`, a map from SHA-256 of the JSON list
of `[role, content]` pairs to an object with `text`. A missing prompt fails the scenario even if the engine catches
the fixture error. Real models, reranker fixtures, a scored store fixture and the snapshot adapter require their
own integration before a scenario can use them.

The comparator ignores named timestamps, durations, timings and run IDs. It keeps field presence, memory IDs,
counts, order and rendered text exact. Score fields allow an absolute delta of `1e-6` by default. A step can set
`tolerance.scores` and list numeric JSON pointers in `trace.compare`. Trace structure is always checked. Results,
events, fixtures and diagnostics are screened for the same synthetic secret probes as the system redaction suite.
