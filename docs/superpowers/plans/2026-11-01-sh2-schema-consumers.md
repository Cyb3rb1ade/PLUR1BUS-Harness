# SH2 Schema Consumers Implementation Plan

> **For agentic workers:** Execute inline using superpowers:executing-plans and TDD. One fresh whole-branch review.

**Goal:** Prevent declared configuration secrets from reaching settings, public outputs, diagnostics or logs.

**Architecture:** Pure schema projections preserve JSON structure. Existing private watch snapshots serve runtime
and write-back consumers. A configuration registration group feeds the existing Core redaction registry before
logs; Rust consumers share one projection and credential extractor.

**Tech Stack:** TypeScript, JSON Schema, Rust 1.95, Node 24.21, pnpm 10; no new dependencies.

**Spec:** [Owner-authorized SH2 design](../specs/2026-11-01-sh2-schema-consumers-design.md).

## Global Constraints

- SH1 is ready PR #851; this branch starts at its commit `142cedc7`. One separate SH2 PR.
- Preserve RPC shape, JSON types, unknown fields, internal runtime credentials and compare-and-set behavior.
- Only required SH2 Rust changes are authorized. No Engine-contract or import implementation edits.
- Generate canaries at runtime; never weaken, retry or skip tests.
- English docs, German PR, author Cyb3rb1ade <cyb3rblade@me.com>; no rebase, amend, force-push or merge.
- Run gates sequentially, never alongside full Core; do not poll CI. Regular-backup policy awaits the Owner.

## Review Focus

- Whole/key/parent/tier reads must agree; arrays, maps, inherited annotations and Engine metadata remain protected.
- Public token limits, fingerprints and unmarked names stay public; endpoints retain host/path and list boundaries.
- Agent removal, provisioning compensation and repair must preserve other agents' original credentials.
- Rejected candidate values must not appear in validation errors, status, first aid or logs.
- Startup and accepted changes must register configuration values before any dependent log or output.

### Task 1: Shared projection

**Files:** `packages/config-schema/src/{sensitive,url-credentials,index}.ts`,
`packages/config-schema/test/sensitive-display.test.ts`, Rust `crates/plur1bus-config/src/sensitive.rs` and `src/lib.rs`.

**Interfaces:** `redactConfig(value, { key?, schema? })` returns a fresh JSON-shaped value; default schema is the
Harness schema. `maskUrlCredentials(string)` is a pure browser-safe helper. Rust equivalents are
`redact_config`, `redact_with_schema`, `mask_url_credentials` and schema-extracted secret strings.

- [x] Write red tests for arbitrary marked names, unmarked credential-looking names, unknown fields and no mutation.
- [x] Cover inherited object/map/item flags, subtree reads, known Engine metadata and URL credential variants.
- [x] Implement the projection and extract browser-safe URL logic; preserve SH1 extraction/warning behavior.
- [x] Port the same semantics to Rust without dependencies; run Config Schema and Rust config tests.

### Task 2: Private snapshots and Rust outputs

**Files:** `crates/plur1bus/src/{config_redaction,main}.rs`, `supervisor/{config,config_policy}.rs`,
`commands/config.rs`, `repair/safe.rs`, `modules/mod.rs`, `firstaid_bundle/mod.rs`,
`packages/core/src/agents/config.ts`, relevant config-service/repair/bundle tests and Rust marker test.

**Interfaces:** A local `config.watch` call returns `{ config, revision }` for internal consumers. The public
`get_result` still returns its existing envelope after applying the shared projection. Installed module schemas
apply at their own `modules.<name>` subtree. Validation formatting emits paths/constraints rather than values.

- [ ] Reproduce public output, invalid candidate, audit and bundle leaks with runtime canaries.
- [ ] Move internal write-back readers to private snapshots first; test surviving agents and repair round trips.
- [ ] Apply the shared public projection to whole/key/tier, config audit and bundle configuration.
- [ ] Register configuration values for other bundle texts before cleaning/sealing; retain pattern/rescan checks.
- [ ] Make validation diagnostics value-free and extend the already-sharp Rust marker coverage.
- [ ] Run focused Rust config-service, CLI, first-aid, bundle, repair and log-schema tests.

### Task 3: Web and Core consumers

**Files:** `packages/web/src/pages/settings/config/{model,fields}.ts`, `sections/config.ts`,
`packages/web/src/palette/{match,index-build,config-values,dialog}.ts`, browser policy helper, i18n and settings tests;
`packages/core/src/{core,config-source}.ts`, `agents/export.ts`, `rpc/channel-surface.ts`,
`secrets/{redaction,store,runtime}.ts`, Core secret/log/export/protocol tests.

**Interfaces:** Browser policy comes from generated `CONFIG_POLICY`. Palette values retain array members until
final rendering. `SecretRedaction.replaceGroup(group: symbol, values: readonly string[])` atomically replaces a
private registration group; the store's named values retain their existing API. Optional registry injection lets
the Core, store and audit/log sinks share one registry.

- [ ] Activate the Web metadata regression; reproduce arbitrary marked keys and joined-URL-list masking.
- [ ] Remove runtime configuration name guesses; implement untouched/replaced/cleared secret and URL drafts.
- [ ] Mask JSON and review cells with their configuration prefix; preserve public numeric/policy values.
- [ ] Reproduce configuration leaks before a store read and on configuration changes, including rotated/removed values.
- [ ] Register initial values before early-log flush and accepted changes before downstream listeners.
- [ ] Apply metadata to agent configuration exports and channel configuration projection without changing RPC shape.
- [ ] Check captured Rust process output with a red reproduction and fix the proven shared sink if necessary.
- [ ] Extend secret/protocol leak tests and run focused browser/Core tests.

### Task 4: Verification and publication

**Files:** `CHANGELOG.md`, `docs/config.md` and its generator when generated text changes, relevant diagnostic docs.

- [ ] Resolve the regular-backup scope answer and record the exact boundary.
- [ ] Document the complete source-to-output inventory and preserved private-snapshot behavior in the German PR.
- [ ] Obtain one fresh read-only bypass/regression review, confirm findings and fix them with red/green evidence.
- [ ] Run `pnpm lint`, Config Schema, full Core, full Web, affected Rust suites, `cargo fmt --all -- --check`,
  `cargo clippy -p plur1bus --all-targets -- -D warnings`, `cargo test -p plur1bus`, docs generation/check and diff checks.
- [ ] Obtain actual Claude review on the frozen final candidate; address confirmed blockers and reverify relevant gates.
- [ ] Commit, push and open one ready SH2 PR, attach/open it and report its number. Continue SH3 after publication.
