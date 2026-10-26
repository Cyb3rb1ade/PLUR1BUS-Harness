# RE-14/T1 cache-profile parity implementation plan

**Goal:** Read the Core's cache-profile table in Rust with identical lookup semantics, generated parity vectors and a generated provider matrix.

**Architecture:** The TypeScript loader remains the reference implementation. A generator records its normalization, lookup and URL-route results; Rust reads the JSON table and schema at compile time and checks those vectors. A separate documentation generator owns the bounded generated section of `docs/provider-matrix.md`.

**Tech stack:** Node 24.21.0, pnpm 10.28.0, Rust 1.95, existing workspace dependencies.

**Spec:** Package A in the user-supplied `arbeitspakete-RE-D20-RE-D29.md`; repository design in `2026-10-23-rust-engine-rewrite.md` §2.6 and `rust-engine/RE-14-token-counter.md` T1.

## Global constraints

- P2 #783 and P3 #784 are merged; branch from `origin/main` at `a27f2d98`.
- Implement A only. B waits for A's merge; D is independent and separately assigned.
- No engine behavior consumes the new table in Phase 1 (RE-R1).
- One PR, no automatic merge, no CI polling, no force-push/rebase/amend.
- Tests first; no skipped tests. Commits as Cyb3rb1ade <cyb3rblade@me.com>.
- Reuse locked and already licensed regex/url crates; do not change provider facts.

## Review focus

- Narrow profile rows must precede broad rows, including platform-specific and local routes.
- Explicit route overrides must win over gateway/platform decorations in model identifiers.
- Every alias, gateway prefix, profile row and host pattern needs a generated witness.
- URL host matching must handle normalization and reject look-alike hosts consistently.
- Generated documentation and fixtures must fail checking on drift without rewriting handwritten content.

## Task 1: Reference vectors

Files: `packages/providers/src/cache-profile-vectors.ts`, `packages/providers/test/cache-profile-vectors.test.ts`, `packages/providers/fixtures/cache-profile-vectors.json`, `packages/providers/package.json`.

- [ ] Write coverage, literal-example, deterministic generation and stale-fixture tests; observe failure.
- [ ] Export `buildCacheProfileVectors()` returning `{ version: 1, profiles, urls }`. Profiles contain `name`, `model`, `route` and `expected: { ref, platform, gateway, rowId }`; URLs contain `url` and `expected` route.
- [ ] Generate expectations only through `normalizeModelRef`, `findCacheProfile` and `cacheRouteForUrl`; check coverage against the table so added rows/hosts require witnesses.
- [ ] Wire generation into `pnpm gen`; generate and commit the fixture; pass provider tests.

## Task 2: Rust parity

Files: `crates/plur1bus-engine/src/cache_profiles.rs`, `src/lib.rs`, `tests/cache_profiles_parity.rs`, `Cargo.toml`, `Cargo.lock`.

- [ ] Write schema-rejection and vector-parity tests first; observe failure.
- [ ] Load and validate the shared table using `include_str!` and jsonschema; implement normalization, ordered lookup and host routing.
- [ ] Compare every generated vector, preserving absent optional fields and null missing row IDs.
- [ ] Pass Rust formatting, clippy and tests. No runtime consumers.

## Task 3: Generated provider matrix

Files: `scripts/gen-provider-matrix.mjs`, `scripts/gen-provider-matrix.test.mjs`, `docs/provider-matrix.md`, root `package.json`.

- [ ] Write rendering, deterministic output and CLI drift tests first; observe failure.
- [ ] Generate profile, alias, host and gateway facts from the table, keeping source/date/status visible; move useful handwritten background outside the generated block.
- [ ] Wire into `pnpm docs:gen` and `pnpm docs:check`, including generator tests in the docs check.
- [ ] Pass generator tests and docs checks.

## Task 4: Integration and delivery

- [ ] Run `pnpm gen`, `pnpm lint`, provider tests, `pnpm docs:check`, and Cargo fmt/clippy/test; record exact results and any blockers.
- [ ] Review the complete diff independently, correct material findings and verify fixes.
- [ ] Commit, push and open exactly one PR titled `RE-14/T1: cache-profile table in the engine, parity vectors, generated provider-matrix §3`; report the PR number.
