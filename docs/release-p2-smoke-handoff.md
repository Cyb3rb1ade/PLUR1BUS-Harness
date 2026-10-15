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
