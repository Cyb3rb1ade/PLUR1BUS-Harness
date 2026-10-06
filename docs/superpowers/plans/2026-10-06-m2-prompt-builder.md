# M2 Prompt-Zone Builder and B6 Cache Gate

**Goal:** Ship `packages/core/src/prompt/`: the provider-neutral prompt builder of ADR-010 §1 (zones tools → system → frozen memory snapshot → conversation, engine recall blocks after the last cache breakpoint), a per-model cache table, the L7 frozen-snapshot session, typed clip events (engine-spec L3), and the **B6** zone-determinism gate (`pnpm bench` plus a test). Spec: ADR-010 R1–R8, B5/B6; `docs/milestones.md` §M2 (acceptance 9); engine recall blocks in `docs/superpowers/specs/2026-09-23-m1b-1-engine-api-design.md` §3.2. Wire formats are built later by `packages/providers` (another session); this package only emits **segments with cache-breakpoint markers**.

**Out of scope:** provider wire formats, the scheduler's cache-age tracking (R7 beyond a pure TTL chooser), telemetry (R8's usage half), a tokenizer, the ADR-010 ban list for timestamps in caller-supplied text (the builder itself adds none), and any change to `join.ts`, the RPC schema or `core.ts`.

## Files

| File | Purpose |
|---|---|
| `packages/core/src/prompt/canonical.ts` | Deterministic serialisation: sorted keys (code-point order), NFC strings, well-formed UTF-16, LF line ends, finite numbers only, `sha256` helper. R3. |
| `packages/core/src/prompt/model-table.ts` | Data table: per model family minimum cacheable tokens, breakpoint count, mechanism (`explicit`/`implicit`), TTLs, lookback; `lookupCacheProfile(model)`; unknown model fails closed. R1, R2. |
| `packages/core/src/prompt/types.ts` | `Segment`, `Breakpoint`, `RenderedPrompt`, `PromptEvent` (typed, discriminated), inputs. |
| `packages/core/src/prompt/builder.ts` | `createPromptBuilder` (`render`, per-`(agent, model)` prefix registry, R5), zone caps and clip events, breakpoint placement, zone/prefix hashes, volatile tail via `joinBlocks`. |
| `packages/core/src/prompt/session.ts` | `createPromptSession`: the L7 frozen snapshot, append-only conversation, recall that lands later in the conversation. |
| `packages/core/src/prompt/ttl.ts` | Pure `chooseCacheTtl` (ADR-010 Q1 default). |
| `packages/core/src/prompt/index.ts` | Public surface. |
| `packages/core/test/prompt/*.test.ts`, `packages/core/test/fixtures/prompt-*.ts` | Tests and the shared synthetic corpus. |
| `scripts/bench.mjs` | One contained block: gate **B6** (render twice in process, in two child processes). |
| `docs/adr/ADR-010-latency-and-caching.md` | Appended implementation record with the rulings. |

## Tasks (test first, one commit each)

1. **Canonical serialisation and hashing** — key order, NFC, CRLF, lone surrogates, `-0`, non-finite/undefined refused.
2. **Model table** — lookups for every row of `docs/provider-matrix.md` §3 (Anthropic 512/1 024/2 048/4 096, OpenAI 1 024, Gemini 2 048/4 096), unknown fails closed (no breakpoints, 4 096 floor).
3. **Zone render + hashes + breakpoint placement** — fixed zone order, one breakpoint per non-empty stable zone plus the trailing conversation breakpoint, ≤ model max, implicit models get none, interior lookback breakpoint only into a free slot, R2 below-minimum warning (no padding).
4. **Clip events (L3)** — memory zone cap and volatile-tail cap emit typed `prompt.zone-clipped` / `prompt.block-clipped` / `prompt.block-dropped`; nothing is clipped silently.
5. **Session (L7)** — frozen snapshot, recall lands in the volatile tail, then folds into the conversation at its anchor.
6. **B6 gate** — two renders, two processes, byte-identical zone hashes; wired into `pnpm bench`.
7. **Rulings tests and ADR record** — Q1–Q3.

## Acceptance → test

| Acceptance | Test |
|---|---|
| B6: zone hashes byte-identical across two renders and two process starts | `test/prompt/b6-determinism.test.ts`; `pnpm bench` B6 |
| L7: a new recall does not change the snapshot zone; it lands later in the conversation | `test/prompt/session.test.ts` |
| L3: clipping emits a typed event | `test/prompt/clip-events.test.ts` |
| Breakpoint placement per model table | `test/prompt/model-table.test.ts`, `test/prompt/breakpoints.test.ts` |
| A change only in the conversation zone leaves the prefix hashes unchanged | `test/prompt/prefix-stability.test.ts` |
| ADR-010 Q1–Q3 defaults as RULINGs | `test/prompt/rulings.test.ts` |
