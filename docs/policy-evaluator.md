# Policy evaluator (D109, part 1)

`packages/core/src/policy/` is the pure decision function of the D109 permission model
(`docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md`, D109 §2–§9). It is **not wired into any
dispatcher yet**; the approval store, path canonicalisation (`paths.ts`) and the `grant`/`approval` RPC are separate parts.

- `effects.ts` — the effect axis (`read`, `local-write`, `local-destructive`, `external`, `money`) and the mappings from D103
  `sideEffects`, extension `tools[].effect` and MCP annotations (annotations only raise).
- `capabilities.ts` — the capability table (default class inside/outside roots, grant ceiling, minimum surface, base risk) and
  `DEFAULTS` (grant lifetimes, the 90-day `always` expiry, prompt cap, batch size). **All defaults live here**, so owner answers to Q12–Q19 change one file.
- `decide.ts` — `decide(call, ctx, { grants, clock })` returns `allow`, `ask(request)` or `deny(reason, rule)`.
  Precedence: deny-list > never > `tools.deny` > grants > roots > default. Names are case-folded; `tools.deny` entries are exact names or `*` globs (an unreadable entry denies everything); invalid grants (non-finite times, missing surface) are ignored; an unknown effect counts as `money`; a per-agent `allowed` override never lifts the roots. Grants come in through `GrantSource`; time through `Clock`.
  Also exports the helpers surfaces and the store will reuse: `maxScopeFor`, `requiredSurface`, `surfaceMayDecide`, `grantExpiry`, `grantReviewDue`, `pathCovered`.

The caller computes the call's flags (`outsideRoots`, `denyListHit`, `privileged`, …) and passes canonical targets; the evaluator never
inspects a path for the deny-list. Tests: `packages/core/test/policy/` (`permission-eval` is the table-driven adversarial set: every attack
row must be refused, at least 95 % of the benign twins allowed).
