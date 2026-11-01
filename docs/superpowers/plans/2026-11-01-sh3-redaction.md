# SH3 Redaction Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the coupled redactor tasks; the independent startup task may be delegated in an isolated worktree. One fresh whole-branch review at the end.

**Goal:** Close reproduced escaped-value, repeated-derivation, cut-boundary, UTF-16 and startup-registration gaps.

**Architecture:** Cache forms at the live secret registry, preserve the existing dispatcher envelope, redact complete
bounded text before cuts, and initialize output sinks after Store preload.

**Tech Stack:** Node 24.21, pnpm 10, TypeScript; existing packages only.

**Spec:** [SH3 design](../specs/2026-11-01-sh3-redaction-design.md).

## Global Constraints

- Base is SH2 commit `790ffc6d`; one separate ready SH3 PR, no force-push/rebase/amend or PR merge.
- No `crates/**`, Engine contract, RPC schemas/codes, import, API/protocol features, external agents or sandbox edits.
- Every requested gap gets an actual red test before a fix, or a recorded already-fixed proof with no runtime change.
- Runtime canaries only. No new dependencies, test weakening/retries/skips or Jina-derived material.
- English docs, German PR, author Cyb3rb1ade <cyb3rblade@me.com>. Gates sequential; full Core runs alone.

## Review Focus

- Mutable/reordered secret sources must invalidate by membership, including secrets registered during tool execution.
- Mixed JSON escapes, surrogate pairs and colliding object keys must retain secrecy and valid structured output.
- Public URL prefixes, short ordinary text and no-hit deep results must stay public/unchanged.
- Duplicate accessible backend copies must not retire a winning current secret or trigger Store migration.
- Default writer constructors and injected/platform loggers must not precede startup registration.

### Task 1: Probes and escaped forms/cache

**Files:** Core `logs/redact.ts`, new `logs/secret-forms.ts`, `secrets/redaction.ts`, `tools/dispatcher.ts`,
`composition/provider.ts` and its existing registry callback wiring; `test/logs/redact-secrets-only.test.ts`,
`test/tools/dispatcher-result-redaction.test.ts`, new `test/secrets/secret-leak.test.ts` and `protocol-leak.test.ts`.

**Interfaces:** `SecretFormsCache.forms(values: Iterable<string>): readonly string[]` stores one membership generation;
`SecretRedaction.forms(): readonly string[]` shares it. An optional internal `secretForms` callback reaches the
dispatcher/provider; the existing `secrets` callback remains compatible. Existing redactor/JSON helper imports remain.

- [ ] Add actual nested JSON/slash/Go/mixed-Unicode leak cases and run them red on current production helpers.
- [ ] Count real derivation allocations across repeated dispatcher calls, source mutation and rotation; establish red.
- [ ] Implement bounded escape recognition and cache; preserve raw-size-first, no-hit, numeric and key-collision tests.
- [ ] Verify new values during a call and unreadable registries still fail closed; run focused tests and commit.

### Task 2: Allowed Core cuts and UTF-16

**Files:** `logs/output.ts`, `logs/redact.ts`, `tools/dispatcher.ts`, `toolcall/model-tool-error.ts`,
`toolcall/results.ts`; their existing tests and new secret-leak cases.

**Interfaces:** Keep existing result/error shapes. Any shared prefix helper returns a well-formed string within its
existing character budget. `OutputLines` retains its 64 KiB frame bound and 4096-byte visible bound.

- [ ] Reproduce a registered value crossing the OutputLines redaction window with a runtime canary.
- [ ] Prove already-fixed ordinary dispatcher pre-cut masking and whole-result refusal/offload; do not change them unnecessarily.
- [ ] Redact the bounded retained line before the visible cap; verify short text/public URL negative controls.
- [ ] Add emoji boundary and postmask surrogate red cases, fix allowed Core cuts, run focused tests and commit.

### Task 3: Startup Store preload

**Files:** `secrets/store.ts`, `secrets/runtime.ts`, `core.ts`, `logs/writer.ts`/bootstrap if necessary;
startup/config-registration fixtures and Store tests. Relevant startup-laziness docs/comments.

**Interfaces:** Trusted in-process `SecretStore.preloadRedaction(): Promise<void>` returns no plaintext; warnings
contain only fixed backend/phase identifiers and counts. A private symbol group retains readable initial values.
No RPC method is added. Optional `WriterOptions.redactor` receives the populated live redactor before constructor
records; existing writer-owned registrations still work.

- [ ] Seed an encrypted file backend directly, queue a Store-only marker, start real Core, and reproduce default/injected startup leaks before any Store access.
- [ ] Cover enabled primary/other copies, disabled file, unavailable backend, per-entry failures and zero migration/lease/audit-access side effects.
- [ ] Implement preload and startup ordering; preserve run-directory ACL refusal before token/listener creation.
- [ ] Keep writer initialization batched/lazy to avoid rebuilding all forms once per preload value; run focused tests and commit.

### Task 4: Load, docs and publication

**Files:** Core load/regression tests, `docs/tool-reliability.md`, `docs/composition.md`, `docs/secrets.md` as needed,
`CHANGELOG.md`; no unrelated modules.

- [ ] Add 512-secret large-result load cases using the #836 scale, including new escape forms and event-loop evidence.
- [ ] Document exact minimums, supported escape/cut behavior, startup availability boundaries and lifetime pins.
- [ ] Run lint, full Core, affected package/browser startup tests and docs generation/check sequentially.
- [ ] Obtain fresh whole-branch and actual Claude reviews on the frozen final source; fix confirmed findings with red/green evidence.
- [ ] Commit, push, open/attach one ready SH3 PR and report its number; continue SH4–SH7.
