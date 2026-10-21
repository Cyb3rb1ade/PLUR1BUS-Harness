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
`pnpm lint`, `pnpm docs:check` and `git diff --check` pass. The full workspace
suite is running separately at handoff (`/tmp/memissues-a4-suite-serial.log`),
without an overall-pass claim. An earlier parallel prep collided on the API
build's `dist/bin.js` rename; the full command was restarted after prep completed.

No Rust production surface, Engine pin or committed lockfile changed. #669
uses `Refs #609` until the Controller pin and required acceptance complete.
No CI polling, merge or deployment occurred.
