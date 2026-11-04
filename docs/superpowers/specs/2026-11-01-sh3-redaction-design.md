# SH3: escaped values, bounded redaction and startup knowledge

> Historical initial design. The [Controller F2 implementation plan](../plans/2026-11-01-sh3-controller-f2.md) supersedes its base, matcher, native capture and startup details. F2 authorizes the narrow native sandbox capture fix and requires bounded asynchronous preload.

The Owner already authorized SH3 after ready SH2 PR #854. Implement the six supplied requirements with a real failing
test first; if a requested gap is already closed, retain the proof and explain the no-op in the PR. No new approval
round is needed for routine implementation choices inside that scope.

## Scope and approach

Keep the existing successful-result boundary: raw JSON size refusal precedes parsing and secret checks; only hits
are walked; numeric secrets remain withheld; key collisions remain numbered. Extend exact-value handling to JSON
escape spellings in nested text, including slash, quote, backslash and mixed Unicode/Go escapes. Public text without
a registered value stays intact. Recognize equivalent escapes without generating exponentially many spellings.

Use one bounded current-generation form cache with set-membership invalidation. The shared registry owns the
production cache; dispatchers may use a local fallback when supplied only an iterable callback. Read the current
forms after the tool executes so secrets registered during the call count. This is the builder's implementation
choice; the Owner specified the behavior, not these internal interfaces.

Keep redaction before cuts. The allowed Core `OutputLines` path retains at most 64 KiB but currently redacts only an
8 KiB window; reproduce a longer registered value crossing that window. Prefer redacting the already bounded line
before its visible 4096-byte cut. Avoid approximate matching of every string suffix, which could hide a public URL
sharing a sensitive webhook prefix. The existing exact-value minimum remains eight UTF-16 units in Core.
Ordinary dispatcher failures already redact before the 500-character cut; preserve that behavior. Make the allowed
Core character cuts and postmask strings well formed at surrogate boundaries. No Engine or sandbox change.

Startup preload enumerates both accessible Store backends without invoking list/status migration. Preserve disabled
file-fallback and unavailable-backend policy. Pin readable initial values as a private startup snapshot until Core
exits; return no plaintext. Failed reads produce only fixed phases/backend identifiers and counts. Queue config,
platform and Store startup messages until preload finishes. Populate the default writer before constructor-generated
records as well as the injected logger. Metadata-only Store operations remain metadata only.

## Alternatives considered

Per-call variants preserve current behavior but repeat derivation. Cache-by-array-identity can retain stale mutable
input. A membership-aware cache with only the current generation avoids both. Finite serializer spellings alone do
not cover mixed Unicode escapes; use bounded escape recognition alongside cached canonical variants. Generic suffix
prefix masking can damage public URLs; moving masking ahead of a bounded cut is narrower.

## Constraints and proof

TypeScript and docs only; no new dependencies, RPC shapes/codes, Engine contract, `crates/**`, `packages/api`, import
implementation, A2A/MCP/OAuth features, external agents or `tools/sandbox/**`. Generate canaries at runtime. Never
weaken, retry or skip tests. Preserve no-hit deep results, size checks, residual checks and all SH2 reference rules.

Recreate the #836 scale as committed regression coverage: 512 secrets and large/no-hit/escaped-hit results, with
bounded event-loop delay. #836's published reviewer scripts measured about 82 ms for a 1 MiB no-hit result and 159 ms
for 50k short strings on that machine; report this host's measurements honestly. Run lint, full Core, affected
packages/browser startup checks and docs sequentially. Obtain one fresh whole-branch review and actual Claude review
on the frozen candidate, then one ready PR. The Controller merges.
