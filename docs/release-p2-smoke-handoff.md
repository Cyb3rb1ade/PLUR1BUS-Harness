# Release phase 2 — functional smoke and installers (2026-10-15)

Builds on #522. Base main `6e2beb9e`; no M8/T6 acceptance claimed.

## Inventory / decisions

- Extend `tests/e2e/smoke.test.ts` from #168: fresh home, production dependency payload, setup with pinned real Node, installed-runtime daemon, agent, fake-provider chat, capture/recall, backup/verify/restore, stop, uninstall and absent service. No new parallel smoke implementation.
- Native five-target `release-smoke.yml`: macOS ARM, Windows x64/ARM, Linux x64/ARM. All steps fail normally; no informational matrix legs or retries. This functional flat-embedder/fake-chat suite is **not** the real-model/reranker T6 proof required by milestones §5.3.
- Windows cleanup inventories process command lines and matches the complete home argument before killing. A portable regression covers quoted paths, regex metacharacters, sibling homes, null command lines and the test process itself.
- New setup parity integration test compares runtime file tree, bytes, owner permissions (Windows: readonly attributes) and manifest excluding per-install timestamps/home paths, interactive default answers versus explicit non-interactive mode. It uses the existing installer fixture and fake service manager, not administrative setup. It does not prove Windows ACL equivalence.
- Run existing launcher, setup, service-unit and archive contracts on the five runners. Existing injected-update, uninstall and simulated reboot fixtures use Unix executables/signals and run explicitly on POSIX only. Their Windows port remains open; empty cfg(unix) suites are not Windows evidence.
- Manual reboot record now includes all five native targets and exact service/task identity. Actual OS service registration remains the existing `ci.yml` real-service job, not the recording fake in this smoke.

## Validation

macOS arm64, Node 24.21.0: extended smoke passes (1 test, no skips), Windows cleanup matcher passes, installer parity passes, typecheck passes. Real pinned Node archive was downloaded with curl and verified against Node's published SHA-256; local smoke used `PLUR1BUS_SMOKE_NODE_MIRROR=file:///tmp/release-p1-tools` with the unchanged production hash because the local Rust HTTP client's connection stalled. CI uses its normal Node download. POSIX service/update/uninstall/reboot contracts run separately (see PR results). Actionlint validates the new workflow. No native Windows/Linux run is claimed.

## Gating / owner questions / KNOWN-GAP

No existing job promoted; no three-success evidence. New functional workflow fails on errors but branch protection is owner controlled. No CI polling, merge or tag. Audit threshold proposed high; sandbox tools/bwrap permission remains an owner question. Runner labels exist in repository workflow configuration, but runner allocation/availability still requires native runs.

Open: real-model T6 matrix, native Windows injected-update/reboot fixture port, Windows ACL parity, real reboot records and native five-target outcomes. Desktop jobs (#504), web a11y (#497), engine and unrelated package code untouched.

Conflict hotspots: shared system-test process helpers, Fresh-Home smoke, setup integration tests; new workflow is independent of desktop.yml. Installer binary is a copied candidate; production core dependencies and pinned Node runtime are real. The smoke does not prove signed-feed distribution or OS-admin-free installation on all targets until those runners actually execute it.

## Real-model matrix extension

Reuse the existing `two-session-recall.test.ts` with `PLUR1BUS_REAL_MODELS=1` on all five native legs; it requires real reranker timing with no fallback and recall after restart. No timeout or assertion in that acceptance test is relaxed. The model cache uses a Windows junction (no symlink privilege) and a normal POSIX directory symlink. This is a separate acceptance test after the installed-runtime functional smoke, not a claim that one end-to-end installed home with real models is already accepted. Local/native model execution still needs its actual outcomes. First own functional smoke run 38764711674 passed Linux x64 and ARM before this additional real-model step; other legs were still running/queued at the single read.

## Native rollback fixture and final local evidence

Replace the Unix shell stand-ins in `update_apply.rs` with native fixture programs compiled once by the required Rust toolchain. All seven existing assertions now compile/run without `cfg(unix)`, including injected health failure, byte-identical rollback, interrupted-swap recovery and manual rollback. Correct target IDs/executable suffixes and user-directory isolation for Windows; the five-target workflow invokes the suite unconditionally. Existing uninstall/reboot fixture suites remain POSIX-only, while installed-home smoke now waits for the copied binary's removal (including deferred Windows removal). No production updater change or added dependency.

Local macOS ARM: native update suite 7/7 passes; existing real-model/reranker/restart test 1/1 passes; installed-home real-model smoke 1/1 (~57 s) and flat smoke 1/1 pass with recall after restart. Native Windows outcomes remain pending.
