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
to expose any operations still awaiting composition.

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
