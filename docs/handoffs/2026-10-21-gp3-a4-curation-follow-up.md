# A4 / #669 follow-up for #609 — 2026-10-21

The real-Core curation test now enforces Engine contract >=1.17.0 whenever
`PLUR1BUS_REQUIRE_CURATION_ACCEPTANCE=1` or `PLUR1BUS_ENGINE_ACCEPTANCE_SOURCE`
is set. The strict run fails on the actual installed 1.16.0 pin instead of
passing its explicit-unavailable branch. Ordinary pre-pin tests still verify
that refusal; after a real pin bump the same transport test automatically
exercises the real list/resolve branch. The strict Controller command in
`docs/curation.md` is a required post-pin gate, regardless of pre-pin source evidence.

Source evidence: 7/7 tests passed against Engine
`4c7cf1c359cea02e11f2853a09e551a09810f168` from
`/tmp/memissues-engine-a1-20261021`. Temporary process-only resolver invocation:

```bash
PLUR1BUS_REQUIRE_CURATION_ACCEPTANCE=1 \
PLUR1BUS_ENGINE_ACCEPTANCE_SOURCE=/tmp/memissues-engine-a1-20261021 \
node --import /tmp/memissues-engine-source-hook.mjs \
  --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning \
  --test --test-concurrency=1 --test-timeout=120000 packages/core/test/memory-curation.test.ts
```

The temporary hook only redirects `@cyb3rb1ade/plur1bus-memory/` import URLs into
that source checkout. The committed exact Engine dependency and lockfiles are
unchanged. Source acceptance seeds the known persisted Neo queue format on disk, then the
real Core/Engine lists its two own records, hides a foreign record, successfully
Keeps/Drops the records and verifies promoted/demoted JSONL revisions plus two
mandatory audit receipts. After a full Core restart the queue remains resolved,
repeat resolutions return not-found without extra audit writes, and the foreign
record remains unchanged. No Engine method or module is replaced.
The required post-pin test must still run against the actual installed Engine.

ADR-016's A4 implementation record explains why `x-since: 1.6.0` and
`x-rpc-version: 1.6.0` correctly share the current unreleased additive surface,
following its existing diary precedent. The inspected changelog's current
section is `[Unreleased]`; GitHub release/tag inventories returned empty on
2026-10-21. If 1.6.0 is published before merge, bump the RPC minor and `x-since`
together. Engine 1.17.0 is independent of RPC versioning.

Local checks: strict old-pin RED (expected contract assertion), source 7/7;
normal installed-pin curation + agent-principal RBAC 50/50; `pnpm typecheck`,
`pnpm lint`, `pnpm docs:check` and `git diff --check` pass. The full workspace run completed (`/tmp/memissues-a4-suite-serial.log`):
18,184 tests / 17,954 pass / 10 fail / 50 skipped / 170 TODO. Web was 2,091 /
2,088 pass / one old keyboard expectation failure / two TODO; Core was 9,902 /
9,851 pass / nine macOS failures / 19 skipped / 23 TODO. The keyboard assertion
is now extended and its final isolated case passes as described below; no new
full-workspace or whole-Web pass is claimed after that correction.

The nine macOS containment/rollback failures match A2's demonstrated main
baseline: all relevant source, original tests and helpers are byte-identical
to main `1dae60f2ae6d4f7b361cefa61e4717dfae00fa0b`. A2 ran the actual pre-fix RED
against those matching-main blobs and passes 83/83 after the fix in #671.
Controller integration of #671 is required; no duplicate fix or separate
full-main run is claimed here. Proofs: `/tmp/memissues-a2-main-baseline.md`,
`/tmp/memissues-a4-main-blob-proof.txt`.

The new Curation tab sits between Dreams and Media. The existing keyboard
expectation skipped that tab and failed deterministically (Light-group wait
timeout after one Left from Media). Coverage now explicitly traverses
Media -> Curation -> Dreams -> Memories, checking URL, selected state, tab stops
and focus. The targeted case passed 1/1 immediately and again 1/1 after all
whole Web suites stopped. This extends the assertions instead of weakening them.

No Rust production surface, Engine pin or committed lockfile changed. #669
uses `Refs #609` until the Controller pin and required acceptance complete.
No CI polling, merge or deployment occurred.
