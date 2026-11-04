# SH1 Schema Secrets Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, with TDD and one independent final review.

**Goal:** Make configuration sensitivity and URL credential handling explicit, complete and test-enforced in the schema.

**Architecture:** Schema annotations are the single input to shared metadata and credential extraction. A frozen legacy heuristic detects omissions but is not used by the new runtime helpers. Documentation and tier snapshots are generated from the same schema.

**Tech Stack:** TypeScript, JSON Schema, Node 24.21, pnpm 10; no new dependencies.

**Spec:** [Approved SH1 design](../specs/2026-10-31-sh1-schema-secrets-design.md).

## Global Constraints

- No Rust, `crates/**`, engine contract, RPC schema, import implementation or `import/prompt/**` edits.
- Generate test secrets at runtime; do not weaken or skip tests.
- English repository documentation, German PR description, exact owner commit identity.
- Run lint, affected package tests and docs checks sequentially; never alongside the Core suite.
- No rebase, amend, force-push or PR merge.

## Review Focus

- New secret-bearing fields must fail coverage until marked or explicitly justified.
- Dynamic maps and sensitive string-array items retain their annotations.
- URL credentials must not register or mask a public hostname or path.
- Repeated and encoded query values and userinfo are extracted without exposing values in warnings.
- Public fingerprints, policy values and AWS profile selectors remain explicitly non-sensitive.
- Supported Engine pass-through credentials, headers and URLs are covered by nonvalidating Harness metadata and a pinned-schema completeness oracle; preserve validation and the Engine contract.

### Task 1: Enforce and annotate sensitivity

**Files:** `packages/config-schema/schema/config.schema.json`, `packages/config-schema/test/sensitive.test.ts`, `packages/config-schema/test/helpers/sensitive-schema.ts`.

- [x] Write coverage tests for the frozen heuristic, allowed sensitive types and exactly-one URL classification.
- [x] Run `node --experimental-strip-types --conditions=source --test packages/config-schema/test/sensitive.test.ts`; confirm missing annotations fail.
- [x] Annotate all declared secret references and credential-bearing strings; keep justified public exceptions explicit in the test.
- [x] Mark endpoint URLs with `x-url-credentials`; classify credential-bearing webhook URLs entirely sensitive when present.
- [x] Regenerate tier fixtures and verify schema tests.

### Task 2: Shared metadata and safe validation warnings

**Files:** `packages/config-schema/src/sensitive.ts`, `packages/config-schema/src/index.ts`, `packages/config-schema/test/sensitive-values.test.ts`.

**Interfaces:** Export `sensitiveOf`, `urlCredentialsOf`, `configSecretEntries` and `configurationWarnings`, plus their metadata types. Successful `validate` may include value-free warnings; existing warning-free and error shapes remain unchanged.

- [x] Write and run failing tests for maps, array items, credential extraction, userinfo warnings, unmodified valid URLs and a public standard hostname in the real log redactor.
- [x] Implement schema traversal, extract only userinfo/query values for endpoint URLs, and add optional warnings to successful validation.
- [x] Verify every test passes, including encoded and repeated query values and whole-sensitive synthetic webhook fields.

### Task 3: Generated reference and publication

**Files:** `scripts/gen-docs.mjs`, `packages/web/scripts/gen-settings-index.mjs`, `packages/web/src/palette/{index-build,match}.ts` (metadata safety guards), generated `packages/web/src/palette/settings-index.ts`, generated `docs/reference/config-keys.md`, generated tier fixtures and `CHANGELOG.md`.

- [x] Generate the complete key reference with `x-sensitive` and `x-url-credentials`; preserve the existing tier overview.
- [x] Preserve both annotations in the browser-safe generated settings metadata, including inherited flags and sensitive string-array items; consumers remain SH2.
- [x] Generate complete browser policy separately from editable settings, including Engine metadata, maps and array items. Preserve the existing palette-target alignment assertion; add no Engine controls.
- [x] Respect both generated policy flags at both palette inputs to protect secrets and endpoint credentials, including URL arrays; leave complete heuristic removal and other consumers to SH2.
- [x] Add an English changelog entry describing SH1 foundations, without claiming SH2 consumers are implemented.
- [ ] Generate docs, then run `pnpm lint`, Config Schema and Web package tests, Rust config compatibility tests and `pnpm docs:check` sequentially; inspect every exit code.
- [x] Obtain an independent read-only review and address material findings with red/green evidence.
- [ ] Verify no forbidden files changed, commit, push and open one ready SH1 PR with the complete candidate/exception and URL-class tables. Attach the PR and report its number.
