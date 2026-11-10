# Shared import/capture classification oracles

These two pure recorders and their existing Node goldens were recovered from the hash-checked CA2 snapshot before integration. They have been re-executed against read-only engine pin `9f34008c143c5da87b2194b5a28442b407ff8ba7`; both golden files and the generated Unicode data are byte-identical to the preserved originals. C3 uses identical source bytes for these classifiers.

- `record-quality.mjs`: 1,419 quality/category/importance cases plus Unicode 17 boundary checks. `quality-unicode17.json` carries the Node ICU Unicode-3.0 notice and a golden-bound hash.
- `record-dynamics.mjs`: 868 pure dynamics cases, both flashbulb flag states, exact ordered JSON projections. The recorded deferred-queue observations remain source evidence; the deferred queue is not integrated by this change.

Run with Node 24.21.0, `PLUR1BUS_ENGINE_SRC` pointing at the read-only pin export, `PLUR1BUS_ENGINE_GIT` at its read-only repository, and `PLUR1BUS_NODE_LICENSE` at that Node distribution's LICENSE for the quality recorder. The Rust tests compare raw output bytes and use the production modules. The imported capture folder currently contains shared pure rules and schema defaults, not capture admission or the RX6 pipeline.

## Recovered CA1 admission/replay fixtures (RX6)

Recovered unchanged from `880e1bcdd5`/`7ba409d5cc`. All four modes were run twice on Node 24.21.0 against the hash-verified pin in a separate review directory; all six recovered goldens remain byte-identical. Native suites now use physical temporary roots, so the macOS `/var` alias cannot accidentally bypass or trip production link refusal. Capture row production, Neo integration and durable restart acceptance remain separate RX6 work.

# Pinned Node capture recordings

Node `v24.21.0` records these fixtures; no golden is edited by hand. `PLUR1BUS_ENGINE_SRC` points to an isolated
archive of pin `9f34008c143c5da87b2194b5a28442b407ff8ba7`; `PLUR1BUS_ENGINE_GIT` is a read-only Git object source
containing that pin. The recorder compares source bytes/hashes against the pinned blobs **before** importing them.
The public-capture recorder verifies all engine/lib JS/JSON and manifest inputs, plus its pinned embedding helper.
The smaller module recorders verify their transitive source closure. Each golden records those hashes.

```sh
export PATH=/Users/cyberblade/.node24/bin:$PATH
export TMPDIR=/private/tmp
export PLUR1BUS_ENGINE_SRC=/private/tmp/ca-re05-node-g25thyji
export PLUR1BUS_ENGINE_GIT=/Users/cyberblade/worktrees/engine-package-baseline
node crates/plur1bus-engine/tests/fixtures/capture/record.mjs --keys
node crates/plur1bus-engine/tests/fixtures/capture/record.mjs --queue
node crates/plur1bus-engine/tests/fixtures/capture/record.mjs --accept
node crates/plur1bus-engine/tests/fixtures/capture/record.mjs --epistemic
```

Use the equivalent Node 24.21 location on another host. The read-only source repository need not be checked out at
the pin; only its object database is read. The public-capture recorder resolves the genuine pinned engine's native
dependencies from a prepared Harness checkout (`pnpm test:prep`). It uses the pin's deterministic hash embedder,
no model download, a null reranker and an absent LLM. Unrecorded network is refused. Defaults are preserved rather
than silently disabling Neo, dynamics or classification; relevant switches and counterfactuals are recorded in
the scenarios of their owning task. None of these recorders accesses jina artifacts.

| Mode | Goldens | Byte boundary and explicit controls |
|---|---|---|
| `--keys` | `replay-keys.json`, `replay-guard.json` | Raw `JSON.stringify` key material, raw UTF-16 units and persisted guard-file bytes. Clock fixed at 1000; TTL/caps, duplicates, cancellation, takeover, corrupt/legacy values and late callbacks are exercised. |
| `--queue` | `queue.json` | Runtime normalization, RSS boundaries, admission, FIFO/priorities, concurrency, timeout settlement and post-turn payload bytes. Pressure/lag are explicitly controlled for deterministic scheduling; pressure thresholds are separately recorded. Random filenames/UUID metadata are explicitly normalized by the recorder. |
| `--accept` | `accept.json` | Actual public `engine.capture(...).done` JSON text, receipt metadata, guard/journal effects and required unscheduled-inline diagnostic. Clock fixed at 1710000000000; temporary base path normalized. Real MemoryDB writes occur for completed captures. |
| `--epistemic` | `epistemic-cutoff.json`, `epistemic-capture.json` | Raw cutoff/marker bytes, restore-safe failures and Node trust/injection booleans. Input strings are UTF-16 units, including timestamp boundaries at 40/41 emoji and lone surrogates. |

Rust compares persisted/result strings directly, not parsed object equality. Generated contract types remain the
caller-facing data shape; typed/tolerant projections preserve the Node insertion order at persistence boundaries.
The two CA-R2 error-log regressions inject synthetic private exception content; they assert a diagnostic is emitted
and contains only fixed class/code/stage/count fields. They preserve the original programmatic failure.

The row and classification modes and their scenario matrices are extended by CA2/CA3 in separate pull requests.

## RX6 post-turn isolation (RE-D48)

`record-post-turn-isolation.mjs` verifies the pinned queue dependency closure and executes six synthetic cases twice. The recorded macOS filesystem aliases Alpha/alpha; the Rust regression checks the actual filesystem and also passes on case-sensitive systems. Original unsafe Node callbacks/removal are retained, while Rust explicitly refuses them. The oversized-entry regression is a native resource bound (64 MiB). Existing CA1 goldens are unchanged.

## RX6 acknowledged capture WAL (RE-D49)

`record-wal-failures.mjs` checks the four pinned replay source hashes and executes six Node cases twice: corruption, malformed pending, duplicate turn keys, failed write, pending TTL and pending capacity eviction. The native WAL refuses unsafe admission/writes, preserves incomplete plans and retains valid Node bytes. Existing goldens remain unchanged. Four valid scenarios additionally run through the productive durable adapter. Actual child-process kills test state/lock recovery before plan, after plan and after settlement; they do not claim Lance-row end-to-end recovery.

## RX6 fragment compaction (RE-D161)

`record-fragment-compactor.mjs --source <directory> --out <file>` reads
`engine/store/fragment-compactor.js`, `lib/log-redact.js` and `lib/lancedb-optimize.js` at
`9f34008c` from `<directory>` (extracted with `git show`), checks their SHA-256 before any
import and runs the compactor with scripted `fragmentCount`/`optimize` ports, a fixed clock
and a captured timer. `fragment-compactor.json` holds 27 `resolveLancedbCompaction` inputs,
21 `keepVersionsHours` inputs and 17 scenarios with every port call, timer, log line and
explicit outcome. Two recordings (Node 26.12.1) were byte-identical. Log lines are compared by
level and kind; their Node text names the agent and a hashed reason, the native text neither.
