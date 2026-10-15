# v0.1.0 release blockers and known gaps — 2026-10-15

**Unreleased; not acceptance-ready.** Scope: the four release-hardening drafts, against main `6e2beb9e`.
This list supplements existing package KNOWN-GAP tests and milestone status; it is not a replacement for them.

- Five-target real-model/reranker T6 is unproven. The workflow runs installed-runtime functional smoke with flat embeddings/fake chat and, separately, the existing real-model/reranker/restart acceptance on every native target. Configuring those steps is not a green result.
- Three consecutive successful native runs of repaired jobs are absent; no existing job is promoted to gating.
  Repository branch protection remains owner-controlled.
- Windows Python client/named-pipe checks passed the first own #522 run, then three Hermes provider test fixtures
  failed. A test-only follow-up fixes native executable/path assumptions; its next native result remains pending.
- Real services/reboots and Windows ACL parity remain open. Update/rollback now uses native fixtures on all five targets; their Windows outcomes remain pending. Standalone POSIX uninstall/reboot fixtures are not Windows evidence. See [reboot record](reboot-survival.md).
- Dependency audit fails under the owner-selected production High/Critical policy: 8 npm High, 1 Rust High,
  plus 2 unscored Rust unsoundness blockers. Critical Vitest is development-only and warns. Lower severities
  and maintenance notices warn. No exceptions are allowlisted. See [audit evidence](release-audit-evidence-2026-10-15.md).
  Dependency remediation remains with the owning packages; this package does not override or suppress them.
- Portable encrypted backup passed locally with file-fallback secrets. Real keyrings, native Windows/Linux and
  interrupted-process recovery are not accepted. Windows passphrase/scratch ACLs need review; portable restore
  is not crash-atomic across all app databases/keyrings. Keep its encrypted recovery artifact. See [backup](portable-backup.md).
- The Web bundle CLI entry guard still has an independently diagnosed symlinked-entry-path case; the space-path regression uses a canonical native temp path. Web production code was not changed.
- The source-wide local TS run exposed existing Web UI failures in approvals focus, lazy pages, model detail and
  recurring tasks. They are outside this package's ownership and remain unsuppressed; final full-suite green
  is not claimed.
- Desktop #504, Web a11y #497, sandbox containment, other milestone gates, engine publication/plugin parity,
  benchmark/reference-hardware figures, DE/EN release notes, signatures/provenance and canary acceptance remain
  with their owning packages/owner. No merge, tag or release was performed here.
- Attribution is generated from installed production npm and locked Cargo graphs with available upstream texts.
  Each native payload regenerates it for its optional dependencies. Independent legal completeness and future
  Buzz/Nostr/A2A SDK Apache notices still require review when those SDKs are shipped.

Audit policy is decided. Owner decisions: required checks/code-owner branch protection; bwrap/runner tool installation; allocation/availability of
native ARM runners. [Documentation gaps](release-documentation-audit.md) and [§6.2 checklist](release-checklist-v0.1.0.md)
record the remaining work. Local proofs alone do not satisfy release acceptance.
