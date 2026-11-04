# SH6 Controller F3 implementation plan

**Authorization:** Section F3 of the afternoon Controller rulings dated 2026-11-01 and the SH5/SH6/SH7 review from that date. The Owner permits the private TypeScript format and API changes. No RPC/wire shape, dependency, Rust or Engine change. Normal merges only; the Controller merges PRs.

**Base:** Merge `fc44649606a464c05b6f6be5eb65c49e23356ef3` from SH5 first, completed as `8b379c591b55da31b0c60d7959b9aa0b93a4d79d`.

## Ownership and implementation

- API worker owns certificate SPKI derivation, internal current/stage/staged callbacks, private directory checks, v2 persistence, rotation/recovery and API tests.
- Library worker owns idempotent cancellation in phase `none`, the successful-stage model assertion, the device-side TODO and lost-history characterization.
- Root owns documentation, changelog, integration review, gates, actual Claude review and publication.
- Focused tests may run in assigned slices. No generators/builds until source freeze. Whole Core, if needed, runs alone. Workers do not stage or commit.

## Private state

- [x] Keep public Anchor, announcements, pairing offers and responses unchanged. The private envelope uses `version: 2` with explicit valid `state.revoked` and separate key metadata: current/next SPKI or explicit unknown, retired SPKIs, unresolved legacy DER anchors.
- [x] Read legacy v1 missing history as empty; the next write emits strict v2. Reject missing/corrupt v2 lists and inconsistent phase/key metadata.
- [x] DER-only retired history cannot yield SPKI. Preserve it as unresolved and refuse new staging/activation rather than inventing keys. Reads and cancellation stay available; already-completed legacy activation recovery may finish without erasing uncertainty.
- [x] Check directory type and owner with lstat before tightening to 0700/SecurePath, before trust reads and writes.

## Rotation and recovery

- [x] Clean newly rejected candidates with cancelStage. Reject duplicate stage before creating/reading another candidate; preserve an already durable candidate, including when its announcement failed.
- [x] Cancellation is idempotent with no staged state and cleans orphaned material while preserving history and a switched summary.
- [x] Block both retired DER and retired SPKI. Permit renewal of the currently active key, retiring that SPKI only when departing from it.
- [x] Compute switchTrust and private key metadata before activation. Validate both serialized intent and final state, including newline, against the reader's 256 KiB limit before irreversible TLS changes.
- [x] Recheck actual staged material after asynchronous announcement. Persist the validated intent, activate, then save the precomputed final state.
- [x] Recovery and pending-intent retries reuse persisted devices/time/metadata. Emit one departing-anchor audit per intent as an activation attempt; do not claim atomic completed-event semantics across separate stores.

## Evidence and publication

- [x] Meaningful RED→GREEN tests: company-CA retired candidate cleanup and later fresh upload, duplicate-stage preservation, failed-announcement persistence, same-key new certificate, active-key renewal, strict v2/legacy migration, directory refusal, restart/crash recovery, one retirement audit, and both pre-activation size bounds.
- [x] Preserve the model's failed-stage reasons and liveness windows; successful stage also proves no retired candidate was accepted.
- [x] Add the explicitly authorized device-history test.todo with closure condition/inventory reference, plus executable initTrust lost-history characterization. Do not claim device-side history is fixed.
- [x] English Security documentation covers restart guarantees, cleanup/recovery, capacity, legacy uncertainty, device history, lost/rolled-back state and downgrade limits.
- [ ] Run relevant remote-access/API gates, lint/docs checks and actual Claude review on the frozen tree. Commit, push #861 and report the exact head; then merge it into SH7.
