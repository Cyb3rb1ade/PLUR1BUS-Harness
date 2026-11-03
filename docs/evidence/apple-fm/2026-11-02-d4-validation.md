# AF0 D4 verification — 2026-11-02

This is an offline verification of L12, L9 and L10 from the re-review of #865. The native receipts, their JSON observations and their rendered reports are unchanged. No `/usr/bin/fm`, licence command, or Apple Intelligence setting was used.

## Corrections

- L12: both server entry paths now use the same bounded HTTP readiness loop. A visible socket inode is insufficient: transient `ENOENT` and `ECONNREFUSED` are retried before readiness is recorded or the parent is killed. The new fake starts from a demonstrably refused stale inode and replaces it before listening. The regression fails when the old single health request is restored.
- L9: the already measured `tokenCounts.accepted5k` travels with the actual `accepted-5k` observation. `contextEvidence` over `runProtocol`'s recorded rows yields CLI lower bound 5001, matching the authoritative full receipt rather than dropping back to 4097. The existing recorded native token counts were not edited.
- L10: a future collector records `host.arch`, and rendering uses that field. The Node version also comes from the recorded CLI invocation. A renderer on another machine cannot substitute its own architecture or Node version. Historical JSON lacking `host.arch` renders an explicit “architecture not recorded”; its checked-in historical report is preserved.

## Validation

Node 24.21.0 on macOS/arm64, with `TMPDIR=/private/tmp`:

- Both AF0 test files: 45 passed, zero failures, skips or TODOs.
- The complete process-test file ran 50 times under CPU load: 12 tests per run, all 600 passed, zero failures. Eight continuously busy worker threads ran on a host reporting 18 logical CPUs. The measured interval was 89.049 seconds, including starting and stopping the load workers. This is CPU load on this Mac, not a claim of the reviewer's Linux CPU-affinity setup or a Windows run.
- The stale-inode regression rejected the old parent-death readiness code; the source was restored before the 50-run series.
- Before the fixes, the stale-inode, CLI lower-bound and recorded-architecture checks all failed. No test threshold or existing timeout was weakened.

Long-running checks wrote logs outside the repository. The CPU-load runner awaited termination of its owned worker threads. Remaining L8/L11 work follows D4's separate follow-up/AF2 step.

The combined AF0 and CI-script contract run passed all 165 tests. Root lint passed (208 passed, three existing acceptance TODOs, zero failures); `pnpm docs:check` and `git diff --check` passed. The native receipts remain byte-for-byte unchanged against the pre-D4 head.
