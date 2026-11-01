# SH2 Controller F1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans with disjoint workers for the independent consumers. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close B1 first and complete every F1 correction in #854 before merging its new head into the upper SH branches.

**Architecture:** The config schema remains authoritative. Browser-safe `./policy` uses the existing structural schema format, preserving known versus unknown members. TS and Web share its resolver/projector; Rust exposes one projector for display and archive output. Each installed module is interpreted from its original value and its own schema root before results join the Harness projection.

**Tech Stack:** TypeScript/Node 24.21, Rust 1.95, existing Ajv/jsonschema; no new dependency or RPC shape.

**Spec:** F1 of `/Users/cyberblade/worktrees/reviews/controller-rulings-2026-11-01-pm.md`, supported by `sh12-review-2026-11-01.md`.

## Global constraints

- #843 was pushed as `fbbbdaac`; all F1 changes belong to #854, leaving #851 unchanged.
- Never rebase, amend or force-push. Push/report #854 before upper-branch implementation.
- Preserve reference names, ordinary-backup reference roundtrips, webhook regeneration and portable encrypted-backup behavior.
- Rust follows `docs/coding-standard.md`; fmt, clippy `-D warnings` and `cargo test -p plur1bus` must pass.
- Tests generate credentials at runtime. No weakened leak tests, new skips or fixture-derived expectations.
- Final checks run sequentially, full Core alone. Workers do not run builds/generators/tests without an assigned slot.

## Review focus

- Unknown strings in every open namespace and unclassified map/array stay private, including malformed scalar shapes.
- Typed public maps and complete safe references remain public; token-like or syntactically invalid references are masked and warned.
- URL projection masks userinfo/query/fragment while registry selection preserves benign hosts, paths, regions and versions.
- Module install/update/removal/repair changes policy without requiring a config edit, including disabled/childless modules.
- Both public and archive projections use the same decisions; restored URL placeholders satisfy TS and Rust validation.

### Task 1: Shared policy and source schema (root)

**Files:** `packages/config-schema/src/{policy,sensitive,secret-reference,url-credentials,disclosure-policy,index}.ts`, schema, package exports/build, config-schema tests/fixtures.
**Interfaces:** `ConfigSchemaNode`, `ConfigPolicy`, `configPolicyAt(schema, readonly string[])`, `policyForNode`, `valuePolicy`, `referenceSchema(node, root)`, `redactWithPolicy(value, schema, path?, isReference?)`, `policySchema(schema)` in `./policy`.

- [x] Write shared projection vectors and prove current B1 cases fail (four failures, three controls pass).
- [x] Use `x-unknown-members: sensitive|public`, retaining typed AP declarations; default unclassified values stay private.
- [x] Use `x-text-credentials: parts` for four args/env collections; registry extraction recognizes credential assignments and token-like parts.
- [x] Mark both schicht15 reference forms; add a reference-slot guard and frozen sensitivity snapshot.
- [x] Mask fragments, use linear edge trimming, register typed Ajv keywords, warn for invalid references, make inventory-only APIs internal.
- [x] Test schema/display/registry vectors and structured dotted-member paths, with no changes to live input.

### Task 2: Web consumer (Web worker)

**Files:** `packages/web/src/config-policy.ts`, palette/settings consumers and their tests; `packages/web/scripts/gen-settings-index.mjs`.
**Consumes:** Task 1 pure policy API, generated structural `CONFIG_POLICY_SCHEMA`, existing shared reference matcher and reference-name policy.

- [x] Replace the positive-row-only browser walker with the common projector and structural policy metadata.
- [x] Restore credential-key and URL backstops, except complete validated reference values.
- [x] Reverse the permissive settings/palette expectations and execute shared projection vectors, preserving known-public controls.

### Task 3: Rust projection, backup and bundle (Rust worker)

**Files:** config crate policy/reference modules; CLI config_redaction, backup, firstaid_bundle, module/supervisor policy integration and corresponding tests.
**Produces:** `placeholder_with_schema(value, schema, placeholder)` returning projected JSON/replaced keys; `supports_config_disclosure_policy(schema)` shared with module validation.

- [x] Share resolution/flags/reference matcher between display and archive; delete the second backup policy walker.
- [x] Use ASCII `REDACTED` in URL components; validate create/restore results and report re-entry keys.
- [x] Partition known module values before base projection and registry extraction; retain Harness `enabled` and each module's own definitions.
- [x] Restore bundle key/URL defense and the original unknown-key assertions; add real-binary tests across all requested namespaces and log text.
- [x] Reject uninterpretable schemas at install/update; preserve logs with private fallback and recover on repaired metadata.
- [x] Run shared projection vectors against both Rust output modes; remove public inventory exports.

### Task 4: Core/module lifecycle and warning consumption (Core worker)

**Files:** `packages/core/src/config-disclosure.ts`, `core.ts`, config-source integration as needed; `packages/module-api/src/manifest.ts`; targeted tests.
**Consumes:** Pure interpretability check, public text-secret extraction, existing module lifecycle/filesystem mechanisms.

- [x] Exclude known module values from the Harness pass, then collect each original module value with its own schema.
- [x] Validate installable manifest privacy declarations and reload atomically on install/update/remove/repair, even without a child/config change.
- [x] Emit bounded, value-free URL/reference warnings through actual TS runtime consumers; never disable logging.
- [x] Test preconfigured disabled modules, repair/reload and reference exemptions without resolving target secrets.

### Task 5: Integration, documentation and publication (root)

- [ ] Execute shared vectors in TS/Web/Rust display/archive, URI create → restore → validate in TS/Rust, and real-binary bundle probes.
- [x] Describe `accounts.db` honestly as currently included by default, contrary to the 2026-10-21 opt-in decision; implementation follows as SH8 after this stack.
- [ ] Run complete affected package/Core/Web/native gates sequentially, plus fmt/clippy/docs checks; obtain actual Claude review.
- [ ] Commit/push #854, update/open its ready PR, report exact head; only then merge it into SH3 and continue F2/F3.
