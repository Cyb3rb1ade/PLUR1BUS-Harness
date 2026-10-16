# Performance budgets (ADR-010)

The executable catalogue is [`scripts/bench/budgets.mjs`](../scripts/bench/budgets.mjs). It records the policy, runner and reason for **every B1–B11 budget**. Targets are unchanged. Existing `pnpm bench` gates (B1, B6, B11) and the B9 test remain unchanged. ADR-010 also requires B5; it is not yet a reliable CI gate. The separate startup job must collect three consecutive green runs before a separate commit promotes new B1 timing gates.

| Budget | ADR target | Policy / owning measurement | Current limitation |
|---|---|---|---|
| B1 | p95 <100 ms | gate in existing bench; new 5-target job advisory | Windows values pending CI; process-cold ≠ OS-cache-cold |
| B2 | p95 <300 ms | advisory; runtime.ts mock fetch dispatch | RPC client submit timestamp excludes CLI launch |
| B3 | p95 <400 ms | advisory; client first delta | mock SSE emits at t=0; no WAN latency |
| B4 | p50 <250 ms; p99 ≤1200 ms; 0 overruns | advisory; 500-query engine timing corpus | flat-model baseline; reference models still require owner run |
| B5 | ≥.90 eligible cache-read share, turns 3–20 | required gate in ADR; currently reported target result | new reproducible mock reports a miss; synthetic accounting is not vendor usage |
| B6 | byte-identical stable zones | gate; existing 2-render/2-process probe/test | no timing percentile applies |
| B7 | >10% token increase alerts | advisory; 20 deterministic tasks | supply previous JSON via --baseline; mock token counts |
| B8 | <3 s without models; <15 s background model warmup | advisory; startup.mjs | real-model disk cache warmed once; each process loads models anew |
| B9 | 0 socket/spawn calls during assembly | gate; existing b9-no-syscalls.test.ts | JS proxy excludes native addons and some API entry points; not complete kernel tracing |
| B10 | RSS below configured ceiling; two-identity/reranker LRU unload | advisory; currently partial RSS observation | KNOWN-GAP O6-B10: two-identity ceiling/eviction soak missing; never passed by an RSS observation |
| B11 | core.status p95 <5 ms | existing gate; new runner reports advisory | 200 calls / 20 warmups; Node IPC client |

All new timing measurements retain raw samples, state their warmups and remove no outliers. No benchmark duration is inferred from test-run duration. All five targets run the same startup script. The additive `perf-budgets` job runs the reference collector on all five targets, explicitly warning on its incomplete exit status 2 and preserving JSON/Markdown. Its results are not yet independently collected on Windows/Linux in this session. No existing job is changed.

## Evidence

[`2026-10-16-perf-p1.md`](reports/2026-10-16-perf-p1.md) records the local macOS arm64 release baseline: B1 cold/warm p95 5.68/5.05 ms; B8 healthy flat 537.68 ms, real default models 6745.70 ms. The repeat is reported separately, without claiming a production optimization. Previous source/hardware: [`2026-m1b-2a-baseline.md`](reports/2026-m1b-2a-baseline.md), cloud 2-vCPU sandbox, B1 5.55 ms, B8 one sample 5671 ms; these are not comparable before/after runs.

The first local runtime probe (Node 24.21, macOS arm64, flat embeddings, 30 latency samples after 3 warmups) recorded B2 p95 **75.56 ms**, B3 p95 **103.85 ms**. Fixed 500-query B4: p50 **67 ms**, p95 **128 ms**, no overruns. Mock B5 cache share **0.60446**: **target missed**, not waived. Golden B7 total **53090 synthetic tokens** over 20 tasks; no prior comparable baseline. Raw report: [`2026-10-16-perf-p2-runtime.json`](reports/2026-10-16-perf-p2-runtime.json). These numbers are a developer-machine baseline, not O6 reference-device acceptance.

## Owner tasks and known gaps

See [DE/EN reference instructions](performance-reference-hardware.md). Device roles are designated: the Apple Silicon owner Mac, Windows 11 x64 NAS VM, Windows 11 arm64 Parallels VM (external drive required) and Ubuntu x64 NAS VM. Hardware figures must come from each generated report, never manual entries. All device reports/results: **wartet auf Owner-Messung**. VM reports name the host role and guest vCPU/RAM; they cannot establish bare-metal acceptance. Owner/controller must decide the Windows ARM advisory policy after collecting results. No gate is silently removed or relaxed. A noisy gate requires an explicit reason and change commit.

Missing acceptance: O6-B10 soak; B5 supported-breakpoint/vendor-equivalent cache model and investigation of the observed mock miss; B2 CLI timestamp coverage; native B9 traces; actual five-target runtime data; three-run gate-promotion evidence. No milestone is marked fulfilled by this catalogue.

B10 interface constraint on the current exact engine pin: public `ModelsService` has only `status()` and `warm()`, with one embedder identity and one reranker in `ModelsStatus`. There is no public two-identity load/unload/eviction-observation port to drive the required soak. The harness binds one embedding configuration in `packages/core/src/engine-config.ts`. This package does not reach into engine internals or change the engine; O6-B10 therefore requires an owner-approved public contract/measurement route before full acceptance.
