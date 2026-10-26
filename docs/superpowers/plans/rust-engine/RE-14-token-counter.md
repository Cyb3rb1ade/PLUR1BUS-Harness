# RE-14 — Token counter and provider cache profiles

**Package.** One token counter for the whole system, implemented once in Rust in `crates/plur1bus-engine` (`src/tokens/`)
and served to the core over `engine.tokens.*`; one versioned table of provider prompt-caching rules that the core's
prompt builder and the engine both read; and the core fixes that let every provider class actually receive its cache
markers, TTLs and affinity keys. Size M. Design: plan §2.5 (job J8) and §2.6. Decisions: RE-D20–RE-D29.

**Depends on.** Core prerequisites (P1–P4): nothing, they can start now. Engine side: RE-01 (`LlmParams`, `LlmResult`,
`CacheIntent`, `NormalizedUsage`, `RouteInfo` in the contract schema), RE-03 (`ArtifactCatalogue` for tokenizer files),
RE-08 (serving `engine.tokens.*`). **Enables.** RE-10 (the core consumes engine counts), RE-06 (reuse classes per job
purpose use the same table).

**Decided.** RE-D20 (a), 2026-10-26: one Rust counter in the engine, the core calls it over RPC, chars/4 stays the core's
fallback. **Assumes.**
RE-D21: the table lives in `packages/providers`. RE-D22: only the core emits provider cache fields. RE-D23/RE-D24:
engine budgets and job prompt text stay byte-identical in Phase 1. RE-D25: tokenizer files are fetched, never bundled.
If RE-8's hop measurement fails, RE-D20's fallback (b) builds a WebAssembly target of the same module instead of RPC
handlers.

**Read first.**
- Plan §2.6 (classes, rules, interfaces, phases) and §2.5 J7/J8; the reference values in
  [`provider-cache-profiles-2026-10-25.md`](provider-cache-profiles-2026-10-25.md).
- Core: `packages/core/src/prompt/{builder.ts,model-table.ts,session.ts}` (ADR-010; `tokens()` is `ceil(chars/4)`,
  markers are withheld below a model's minimum), `packages/core/src/composition/http.ts` (`anthropicBreakpoints`, the
  only marker emitter today), `packages/core/src/session/{tokens.ts,compaction.ts}` (chars/4 times a per-model EWMA),
  `packages/core/src/budget/` (usage store, `cache_write_tokens`), `packages/providers` (wire adapters, usage parsing).
- `docs/adr/` ADR-010 (prompt zones, L3 and B9: no I/O inside assembly), `docs/provider-matrix.md` §3.
- The `packages/log-schema` ↔ `crates/plur1bus-log-schema` pair: the pattern for a JSON source of truth read by both
  languages with generated parity vectors.

**Rules that apply.** Parity first: nothing in the engine's Phase 1 behaviour reads the counter, and the engine's goldens
stay unchanged with it linked (RE-R1). The engine never names a provider field and never parses provider usage. Count
outside prompt assembly (ADR-010 L3/B9). An absent usage field is `None`, never 0. Every tokenizer file has a sha256 and
a licence decision before it is listed (RE-D25). Tests first; no test skipped to get green.

## Files

- Create: `packages/providers/schema/cache-profiles.json`, `packages/providers/schema/cache-profiles.schema.json`,
  `packages/providers/fixtures/cache-profile-vectors.json` (generated), `crates/plur1bus-engine/src/tokens/{mod.rs,
  families.rs,methods.rs,calibration.rs,rpc.rs}`, `crates/plur1bus-engine/tests/tokens.rs`,
  `tests/engine-parity/goldens/tokens/` (count goldens).
- Modify: `packages/core/src/prompt/model-table.ts` (becomes the table's loader), `packages/core/src/composition/http.ts`
  and the wire adapters in `packages/providers` (emitters, usage parsing), `packages/core/src/composition/` (the batched
  count call, Phase 2), `packages/config-schema/schema/config.schema.json` (`prompt.tokenCounting`), `docs/provider-matrix.md`
  §3 (generated from the table), `scripts/gen-docs.mjs` (the §3 generator and its `--check`).

## Interfaces

The shapes are in plan §2.6 ("Interfaces"): `engine.tokens.count`, `engine.tokens.observe`, `engine.tokens.families`,
and the RE-01 contract types. A count answers `{ family, method, calibration, items: [{ id, tokens, lower, upper }] }`
with `method` one of `exact`, `tokenizer-text`, `calibrated`, `heuristic`. RE-01 owns the schema; this brief owns the
behaviour.

## Tasks

### P1–P5 — Core prerequisites (one PR each, independent of the engine)

P1–P4 merged 2026-10-26: #781, #783, #784, #785. What they built is described in `docs/prompt-cache.md`
("Provider emitter") and `packages/providers/README.md`; the table is `packages/providers/schema/cache-profiles.json`.

- [x] **P1:** failing test first: an Anthropic tool loop keeps its conversation breakpoints from round 2 on
  (`composition/http.ts` `anthropicBreakpoints` against an assistant tool-call message with null content). Then fix it.
- [x] **P2:** move `CACHE_PROFILES` into `cache-profiles.json` with its schema; `model-table.ts` loads it. Add the rows
  plan §2.6 lists (missing Claude families, the GPT-6 family in the GPT-5.6+ class, xAI, Moonshot, DeepSeek, Alibaba,
  Z.ai, Mistral, OpenRouter, local servers, platform rows where floors differ), the alias normaliser, `12h` in
  `CacheTtl`. Every row carries `source`, `verified` and `status`.
- [x] **P3:** emitters per provider class (plan §2.6 table): OpenAI GPT-5.6+ breakpoints, the Kimi TTL tier,
  OpenRouter `cache_control` plus `session_id`, xAI conversation keys, `modelProfiles.*.cache` through `chooseCacheTtl`,
  a stable sorted wire tool block. One fixture wire per class asserts the expected fields.
- [x] **P4:** usage: parse `cache_write_tokens` (OpenAI 5.6+, OpenRouter, Kimi) and DeepSeek's
  `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` into the usage store; fixtures per wire for inclusive versus
  exclusive totals and absent fields.
- [ ] **P5 (RE-D29):** the weight with which cache reads count against token limits becomes a budget setting next to
  `timeZone` (`budget.set` `cacheReadWeight` 0..1, CLI `budget set --cache-read-weight`), default 1.0, so today's
  behaviour is unchanged. Settlement counts `input - cacheRead × (1 - w) + output`, applied at query time; the
  reservation stays the unweighted upper estimate. `budget.status` shows fresh input, reads, writes and output apart.
  The budget README's "cache tokens are recorded but not counted" is wrong today (they are inside `inputTokens`) and
  is corrected. The owner picks the default from the numbers this shows.

### T1 — The table, read by both languages

Merged 2026-10-26 (#786): `crates/plur1bus-engine/src/cache_profiles.rs`,
`tests/cache_profiles_parity.rs`, `scripts/gen-provider-matrix.mjs`.

- [x] Generate `cache-profile-vectors.json` from the TypeScript loader (`pnpm gen`): model ids and routes in,
  normalised id, gateway, platform and row id out, plus `cacheRouteForUrl` over the table's `hosts`. The engine reads
  the table with `include_str!` and a parity test fails on any lookup that disagrees. `docs/provider-matrix.md` §3 is generated from the
  table and `pnpm docs:check` fails on drift.

### T2 — The counter

Starts only after the confirmed merge of T1 (#786).

Implementation started from `main` `0058ae70` after GitHub confirmed T1's merge. The counter remains an unused
library service in Phase 1; calibration and RPC are separate packages.

- [ ] Failing tests first: `lower ≤ tokens ≤ upper` for every family and method; count goldens (fixture texts × family →
  count) recorded from the reference tokenizers (o200k, Gemma 4, the local models' files) on German, English, code and
  JSON text.
- [ ] Implement `src/tokens/`: families from the table, `exact` through the `tokenizers` crate pinned by RE-03 (RE-D19)
  for families whose file is present, `heuristic` (chars/4, labelled) otherwise. Items end at message boundaries;
  `cumulative` gives running totals inside a message.

### T3 — Calibration

Starts only after the confirmed merge of T2.

- [ ] An affine fit per (route, family, method) against inclusive prompt totals, stored under the engine's state
  directory, fed by `LlmResult.usage` and by `engine.tokens.observe`. Totals are normalised first (plan §2.6, rule 5).
  A family with no observations keeps the heuristic. Provider count endpoints are used only off the critical path.

### T4 — RPC

- [ ] With RE-08: serve `engine.tokens.count|observe|families` (`x-server: "engine"`, `x-stability: "experimental"`,
  closed params). A batched call of 200 items answers within the turn-latency budget RE-08 measures.

### T5 — Phase 2 consumer (lands with RE-10)

- [ ] `prompt.tokenCounting` (`x-restart: "core"`, `x-tier: "advanced"`, default `"heuristic"`). With `"engine"` the core
  makes one batched count call per turn from `composition/`, memoised per (segment hash, family), and the builder,
  budget admission and compaction use `upper`. Switch the default only after a B5 measurement.

## Acceptance

- P1–P4: each PR green with its fixture tests; the B5 hit ratio on the Anthropic fixture is unchanged or better.
- The engine's goldens are unchanged with the counter linked. `engine.tokens.count` returns `exact` and matches the
  goldens for every family whose file is present. Every count satisfies `lower ≤ tokens ≤ upper`.
- The table parity test and `docs:check` for `docs/provider-matrix.md` §3 pass.

## Out of scope

Money in budgets (token limits only since #601; the multipliers serve TTL and write decisions). Gemini explicit
`cachedContents`. OpenRouter's response cache. Choosing tokenizer crates (RE-03, RE-D19). Moving engine budgets to counts
(Phase 2, each with its own decision id, RE-D23).

## Hand-off

PR titles `RE-14/P1: …` to `RE-14/T5: …`, one per task. Ready-to-send work packages for T1–T3 and P5 were handed to
the owner on 2026-10-26. Descriptions per coding-standard §11, with the measured numbers
and the table rows touched. Reviewer: the controller; RE-D29 and every tokenizer licence row need the owner.
