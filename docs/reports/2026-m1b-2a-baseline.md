# M1b-2a baseline report

**Date:** 2026-09-28 · **Commit measured:** `d5f5756` (origin/main, PR #40 merged) · **Spec:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` §10 criterion 8, §12.

This report gives the B1/B8/B9/B11 baselines the spec's exit criterion requires, plus the Task 1 recall-timing
evidence for HB4 and a note on Task 2's Windows module-ready floor. Every number below was measured in **this
build sandbox: a cloud container, 2 vCPU, no local model cache** — it is not one of the spec's five CI runners and
not the owner's reference hardware. Numbers from those are marked "pending" with the exact command to run.

## 1. B1 — `plur1bus --help` p95 (gate: < 100 ms)

Measured with `pnpm bench` (`scripts/bench.mjs`), which times 50 `--help` invocations after 3 untimed warm-ups,
against the release binary (`cargo build --release -p plur1bus`).

| Runner | p95 | median | Gate | Result |
|---|---|---|---|---|
| **Sandbox (cloud container, 2 vCPU)** | **5.55 ms** | 4.25 ms | < 100 ms | PASS |
| `ubuntu-24.04` (CI) | pending | — | < 100 ms | not run this pass — CI runs `pnpm bench` on every PR; see `.github/workflows/ci.yml` |
| `macos-15` (CI) | pending | — | < 100 ms | same |
| `windows-2025` (CI) | pending | — | < 100 ms | same |
| macOS arm64 (owner reference) | **pending, owner run** | | < 100 ms | `PLUR1BUS_BIN=target/release/plur1bus node scripts/bench.mjs` |
| Windows x64 VM (owner reference) | **pending, owner run** | | < 100 ms | same |
| Ubuntu VM (owner reference) | **pending, owner run** | | < 100 ms | same |

The sandbox number is well inside the gate; the CI matrix already runs this same script on every PR (green as of
`d5f5756`), so the three CI-runner rows are not independently reproduced here — this report adds the reference
hardware to the CI numbers the pipeline itself already gates on, per O6.

## 2. B8 — core ready without local models (advisory: < 3 s)

Same `pnpm bench` run: a core started via `plur1bus core run` with the flat-embedder test seam (no model load),
timed from spawn to the `{"ready":true,...}` line.

| Runner | Value | Target | Gate | Result |
|---|---|---|---|---|
| **Sandbox (cloud container, 2 vCPU)** | **5671 ms** | < 3000 ms | advisory | SLOW (flagged, non-blocking) |
| macOS arm64 / Windows x64 VM / Ubuntu VM (owner reference) | **pending, owner run** | < 3000 ms | advisory | `PLUR1BUS_BIN=target/release/plur1bus node scripts/bench.mjs` |

B8 is advisory until M3 (spec §10 criterion 8), so this does not gate the milestone. The sandbox figure is high
because the container has 2 vCPUs shared with the rest of this build (`cargo build --release` and `pnpm build`
ran moments earlier), not because of a regression in the core's startup path — the `two-session-recall` system
test below shows first-start times of 541–560 ms on the same box once nothing else is contending for CPU. The
number is reported as measured, unadjusted.

With local models warm (real E5-small + reranker), the spec's other B8 figure (< 15 s) needs
`PLUR1BUS_REAL_MODELS=1` and a populated model cache; not attempted here (no cached models in the sandbox, no
network egress to download ~600 MB of them mid-task). **Pending, owner or nightly run:**

```bash
PLUR1BUS_BIN=target/release/plur1bus PLUR1BUS_REAL_MODELS=1 PLUR1BUS_MODELS_CACHE=~/.cache/plur1bus-models \
  node --experimental-strip-types --test tests/system/two-session-recall.test.ts
```

(The nightly workflow already runs this on `macos-15`; see `.github/workflows/nightly.yml`.)

## 3. B9 — zero socket/spawn syscalls during recall assembly (gate: 0)

Two independent measurements, both on the sandbox:

**a) The existing in-process proxy test** (`packages/core/test/b9-no-syscalls.test.ts` — wraps every
`net`/`tls`/`child_process`/`dgram`/`http`/`https` entry point Node exposes and counts calls during one
`memory.recall`):

```
✔ one memory.recall over an open connection makes 0 socket/spawn calls (34.16 ms)
✔ the counters are live (sanity: a wrapped spawn is counted) (51.66 ms)
```

**b) A real kernel-level trace**, as the plan asks (`strace -f -e trace=socket,connect,clone,execve` around a
`plur1bus memory recall` call against a running core, flat-embedder seam, Linux sandbox):

```bash
strace -f -e trace=socket,connect,clone,execve -o /tmp/b9-strace.log -- \
  target/release/plur1bus --home "$H" core run &
target/release/plur1bus --home "$H" memory add --agent bernd "The launch code is 4821."
# mark the line count, then:
target/release/plur1bus --home "$H" memory recall --agent bernd "launch code" --json
# lines appended to the trace during the recall call:
```

Result: **0 lines appended** to the trace between the `memory add` and the end of `memory recall` (the recall
itself reported `timing.totalMs: 190`, entirely local: embedding/vector_search/graph/rerank/finalize phases, no
network phase). dtruss on macOS was not attempted (no macOS hardware in this sandbox); recorded as **not
measured**, per the plan's instruction to record rather than skip silently.

| Runner | Result | Gate |
|---|---|---|
| Sandbox (cloud container, Linux, strace) | **0 socket/spawn calls** | 0 — PASS |
| macOS (dtruss) | not measured (no macOS hardware here) | 0 |

## 4. B11 — `core.status` roundtrip p95 (gate: < 5 ms)

Same `pnpm bench` run, 200 timed calls after 20 warm-up calls, over the Node module-api client (the same caveat
the H1 baseline recorded: this measures the core side of the roundtrip, not a separate Rust-CLI timing).

| Runner | p95 | median | Gate | Result |
|---|---|---|---|---|
| **Sandbox (cloud container, 2 vCPU)** | **0.31 ms** | 0.162 ms | < 5 ms | PASS |
| macOS arm64 / Windows x64 VM / Ubuntu VM (owner reference) | **pending, owner run** | | < 5 ms | `PLUR1BUS_BIN=target/release/plur1bus node scripts/bench.mjs` |

## 5. Task 1 recall-timing evidence for HB4 (soft-budget consequence)

Ruling HB4 (engine 1.9.0's `timing.totalMs` now counts `entry` + `queue` + `prelude`, which can make a
400 ms soft-budget fallback fire earlier) requires `two-session-recall.test.ts` run three times on the sandbox,
recording `totalMs` and the phase sum. All three runs below pass, on this build (`d5f5756`, engine `b0e149b8`,
contract 1.9.0):

| Run | `timing.totalMs` (recall) | phase sum (entry+queue+prelude+namespace-recall) | soft budget | hard budget |
|---|---|---|---|---|
| 1 | 90 ms | 2+1+4+33 = 40 ms | 400 ms | 45000 ms (test override) |
| 2 | 102 ms | 2+2+3+40 = 47 ms | 400 ms | 45000 ms |
| 3 | 107 ms | 2+3+5+38 = 48 ms | 400 ms | 45000 ms |

All three are far under the 400 ms soft budget, so **HB4's reference-hardware assertion (`totalMs ≤ 400`,
H3-R26) is not tripped on this hardware** — but this is the **flat-embedder seam** (no real embedding/reranking
model), which is the fast path the ruling is *not* primarily worried about. HB4's real concern is the real-model
nightly run (`PLUR1BUS_REAL_MODELS=1`), which has its own recorded numbers in `.github/workflows/nightly.yml`'s
history, not reproduced here (no model cache in this sandbox). The owner's reference-hardware run (O6, open) is
the number that actually gates HB4:

```bash
cargo build --release -p plur1bus && pnpm build
PLUR1BUS_BIN=target/release/plur1bus PLUR1BUS_REAL_MODELS=1 PLUR1BUS_MODELS_CACHE=~/.cache/plur1bus-models \
  node --experimental-strip-types --test tests/system/two-session-recall.test.ts
```

**Pending, owner run** — report `timing.totalMs` and the phase sum from the test's diagnostic lines; if
`totalMs > 400` on that hardware, HB4 says stop and report BLOCKED with the numbers rather than adjusting the
budget unilaterally.

## 6. Task 2 — Windows `run/` ACL and module-ready time

Task 2 (PR #27) sets `MODULE_READY_FLOOR` to **10 s** — a supervisor timeout floor at test time scales, not a
measured typical module-ready duration (ruling 2026-09-28: 3 s flaked under load on `windows-2025`). No actual
Windows module-ready wall-clock measurement is recorded in the project's status ledgers (`status/2026-09-27-h3a-ledger.md`,
`status/2026-09-28-h3b-b-batch-a-ledger.md`) beyond CI going green; this sandbox is Linux and cannot produce a
Windows number. **Recorded as not measured** rather than estimated. **Pending, owner or CI-artifact run** on
`windows-2025` or the owner's Windows x64 VM:

```bash
cargo build --release -p plur1bus
PLUR1BUS_BIN=target/release/plur1bus PLUR1BUS_ALLOW_TEST_INTERNALS=1 cargo test --workspace -p plur1bus \
  --test windows -- --test-threads=1 module
```

Time the module-ready log line in the run's `daemon status` polling, or add a one-off timing print around
`readyChild` in `tests/system/modules.test.ts`.

## Summary

| Benchmark | Sandbox result | Gate/target | Status |
|---|---|---|---|
| B1 `--help` p95 | 5.55 ms | < 100 ms (gate) | PASS |
| B8 core ready, no models | 5671 ms | < 3000 ms (advisory) | SLOW, non-blocking, contention-explained |
| B8 core ready, real models | not attempted (no model cache) | < 15000 ms (advisory) | pending, nightly/owner |
| B9 socket/spawn calls during recall | 0 (proxy test + real strace) | 0 (gate) | PASS |
| B11 `core.status` p95 | 0.31 ms | < 5 ms (gate) | PASS |
| HB4 recall `totalMs` (flat embedder, 3 runs) | 90 / 102 / 107 ms | ≤ 400 ms (real-model ref-hardware gate) | PASS on this hardware; real-model reference run pending (O6) |
| Task 2 Windows module-ready | not measured (Linux sandbox) | — | pending, owner/CI |

Nothing above was invented: every "pending" row names the exact command the owner (or a CI artifact) needs to
run to fill it in.
