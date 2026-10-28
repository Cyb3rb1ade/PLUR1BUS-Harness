# Rust engine rewrite — hand-off briefs

One brief per work package of [`../2026-10-23-rust-engine-rewrite.md`](../2026-10-23-rust-engine-rewrite.md) (the
plan). A brief is written for an implementer who has not seen the plan, this repository or the engine: it names the
files, the interfaces, the tests and the acceptance, and nothing that the implementer can decide alone. The plan holds
the reasoning (why a process, why this store strategy, the change packages CP-1…CP-7, the pros and cons); a brief holds
the work. Read the plan's §1 (starting point) and §2 (target architecture) once before the first brief.

| Brief | Package | Size | Depends on | Enables |
|---|---|---|---|---|
| [RE-00](RE-00-foundations.md) | Decisions, crate skeleton, dependency gate, lint policy | S | — | everything |
| [RE-01](RE-01-contract.md) | Contract schema, generated types, traits, config validation | M | RE-00 | RE-02…RE-09 |
| [RE-02](RE-02-store.md) | Store layer, byte-compatible (LanceDB, SQLite, neo files, ledgers, locks) | L | RE-01 | RE-03, RE-04, RE-05, RE-07 |
| [RE-03](RE-03-embeddings.md) | Embedding identities, local ONNX providers, remote providers, guarded transport | L | RE-01, RE-02 (fixture) | RE-04, RE-05 |
| [RE-04](RE-04-recall.md) | Recall pipeline (12 stages, namespaces, budget, rerank, ACL, render) | XL | RE-02, RE-03 | RE-08 end-to-end, RE-09 goldens |
| [RE-05](RE-05-capture.md) | Capture pipeline, neo working memory, journal, checkpoint | XL | RE-02, RE-03, RE-04 (render) | RE-06, RE-07 |
| [RE-06](RE-06-jobs.md) | Job registry, 19 jobs, prompts, dreams, afterthought, skill-miner | XL | RE-05, RE-07 | Phase 1 exit |
| [RE-07](RE-07-ops.md) | Memory and admin operations, snapshot, tombstones, re-embedding, models | L | RE-02, RE-03 | RE-06, RE-10 |
| [RE-08](RE-08-process-rpc.md) | Engine process, RPC schema `x-server: "engine"`, supervisor slot, `EngineClient`, seams | L | RE-01 (RE-04 for the first recall) | RE-09 system runs |
| [RE-09](RE-09-parity.md) | Parity harness, golden vectors, CI job | M, continuous | RE-01 (format), RE-08 (runs) | Phase 1 exit |
| [RE-10](RE-10-phase2.md) | Phase 2: memory-facing core paths move into the engine; the three behaviour changes of plan §1.6 (T7–T9, behind RE-D11…RE-D13); inside T8, the lexical analyzer of plan §2.5 (RE-D15); T10 moves the legacy text helpers onto it (RE-D16); T11 is the gated German lexicon (RE-D18) | L | Phase 1 exit | RE-11 |
| [RE-11](RE-11-phase3.md) | Phase 3: retire the Node engine, ADR-018, docs | M | RE-10 | — |
| [RE-12](RE-12-forward-port.md) | Forward-port CP-5 and CP-7 to the Node engine `main` now | S | — (independent) | goldens for RE-04/RE-06 |
| [RE-13](RE-13-harness-surfaces.md) | Phase 2: harness surfaces for the three dropped adapter functions — critical-memory confirmation, skill-proposal acceptance, the daily review (plan §1.7) | M | Phase 1 exit; RE-05, RE-06, RE-08 | RE-11 |
| [RE-14](RE-14-token-counter.md) | Token counter and provider cache profiles: one Rust counter served over `engine.tokens.*`, the versioned cache-profile table, core prerequisites for provider prompt caching (plan §2.6) | M | core prerequisites now; engine side after RE-01, RE-03, RE-08 | RE-10 |
| [MODULE-MAP](MODULE-MAP.md) | Module inventory: every file of the engine closure → owner brief and disposition (port / fold / decide / drop) | — | — | the completeness check of every brief |

## Working assumptions

The plan lists owner decisions RE-D1…RE-D29 (plan §6). RE-D15…RE-D19 are the tokenization and text-analysis decisions of plan §2.5, RE-D20…RE-D29 the token-counting and provider prompt-caching decisions of plan §2.6; RE-D20 was decided (a) on 2026-10-26, the jina part of RE-D19 and RE-D25 on 2026-10-28, RE-D29 waits for real numbers, the others are open. RE-D11…RE-D13 are the three behaviours of plan §1.6 that Phase 1
keeps at parity on purpose; the owner decided on 2026-10-24 that all three are fixed in Phase 2, on the same day that
the three dropped adapter functions of plan §1.7 get harness surfaces (RE-13), and, also on 2026-10-24, that an advisory
inside the pinned Lance closure is answered with a fork at the pinned tag carrying only the fix, not with an allow-list
exception (RE-D14); for the zstd advisories of 2026-10-26, which need a major step, the owner allowed a time-limited exception until 2026-11-25 while those forks are built. Until the owner decides otherwise, every brief assumes the
recommendation. If a decision changes, the briefs named in the last column change; nothing else does.

| Decision | Assumed | Briefs that depend on it |
|---|---|---|
| RE-D1 integration | supervised process + harness RPC, not N-API | RE-08, RE-09, RE-10 |
| RE-D2 location | crate `crates/plur1bus-engine` in this workspace | RE-00 and all |
| RE-D3 store | `lancedb` pinned to the Lance version the Node package embeds (0.26.x, `lance = 2.0.0`); no store migration in Phase 1–2 | RE-02, RE-07 |
| RE-D3b ONNX Runtime | `ort` with `load-dynamic`, a `libonnxruntime` shipped per target | RE-03, RE-08 (payload) |
| RE-D4 embedding IPC | `lib/providers/scoped-embedding-ipc.js` is not ported; `engine.embedding.*` RPC replaces it | RE-03, RE-08 |
| RE-D5 jobs | staged: deterministic core first, go/no-go before RE-06 | RE-06 |
| RE-D6 contract | the pin's 1.17.0 (1.16.0 + `admin.reembedding.validate`) at parity; A1 curated memory and the memory-tree members are additive, under the numbers the engine assigns them on merge | RE-01, RE-07 |
| RE-D7 engine repository | stays for the OpenClaw plugin line; the harness stops depending on it in Phase 3 | RE-11 |
| RE-D8 forward-port | CP-5 and CP-7 go to the Node engine's `main` now | RE-12 |
| RE-D9 TypeScript core | not part of this programme | — |
| RE-D10 distribution | the engine binary joins the release payload, the container image and the desktop bundle | RE-08 |
| RE-D11 recall score | decided 2026-10-24: at parity in Phase 1; cosine score and calibrated thresholds in RE-10 T7 | RE-02 (metric default), RE-04, RE-10 |
| RE-D12 hybrid retrieval | decided 2026-10-24: at parity in Phase 1; full-text index and rank fusion in RE-10 T8 | RE-02, RE-04, RE-10 |
| RE-D13 job partitions | decided 2026-10-24: at parity in Phase 1; the agent partition reads its scoped rows in RE-10 T9 | RE-06, RE-10 |
| RE-D14 tantivy patch | decided 2026-10-24: the root `[patch.crates-io]` replaces `tantivy 0.24.2` with the fork `Cyb3rb1ade/tantivy`, branch `plur1bus/0.24.2-lru-0.18.2`, commit `038215a5` pinned by `rev` (`lru = "0.18.2"`, nothing else), until the Lance pin moves past tantivy; `deny.toml` `[sources]` allows that one git source | RE-00, RE-02 (the Lance pin), RE-11 |
| RE-D15 lexical analyzer | assumed (a), open: our own DE/EN analyzer from adopted parts; its terms in the derived table `_lexical` (memories first, then `_lexical`; a content-hash diff at open); a pass-through Lance BM25 index; Lance's language-neutral built-in profile only as the fallback | RE-02 (round trip with `_lexical`), RE-10 |
| RE-D16 legacy text helpers | assumed, open: ported as they are in Phase 1, moved onto the analyzer in RE-10 T10 | RE-04, RE-05, RE-06, RE-10 |
| RE-D17 JS string behaviours | assumed, open: a slice cut inside a surrogate pair stays a `JsString`, written as Node writes it per target (the JSON escape in JSON text and JSON-built hashes, U+FFFD at UTF-8 boundaries); Node-written JSON read with a tolerant reader; the collator locale recorded from Node 24.21 under the CI locale | RE-02, RE-03, RE-04, RE-05, RE-06 |
| RE-D18 own tokenizer | assumed, open: no subword tokenizer; a German decompounding lexicon only behind the gate (RE-10 T11); a future own model adopts a permissive vocabulary | RE-10 |
| RE-D19 `tokenizers` | assumed, open: `=0.23.2`, regex backend chosen by RE-03 T0's token-id goldens. Decided 2026-10-28: the jina goldens are committed, with `NOTICE-jina.md` beside them; normal CI checks their token ids against jina tokenizer files fetched by SHA-256 pin and never committed; vectors and scores stay in the `real-models` target | RE-03, RE-09 |
| RE-D20 token counting | decided 2026-10-26: (a), one Rust counter in the engine (`src/tokens/`), served to the core over `engine.tokens.*`; exact tokenizer files where public, calibrated estimates elsewhere; the core keeps chars/4 until Phase 2 | RE-14, RE-08, RE-10 |
| RE-D21 cache-profile table | assumed, open: one versioned JSON table in `packages/providers`, read by the core and by the engine (`include_str!`, parity vectors) | RE-14 |
| RE-D22 cache markers | assumed, open: only the core writes markers, TTLs and affinity keys, through one emitter; the engine states segments, boundaries and a reuse class | RE-01, RE-06, RE-08, RE-14 |
| RE-D23 engine budgets | assumed, open: byte-identical in Phase 1 (words, characters, chars/3 and chars/4 heuristics) | RE-04, RE-05, RE-06 |
| RE-D24 job prompt order | assumed, open: byte-identical in Phase 1; reordered for caching in Phase 2 only for `Batch` and `Session` purposes | RE-06, RE-10 |
| RE-D25 tokenizer files | decided 2026-10-28: fetched on first use through RE-03's catalogue, never bundled; of the files under a conditional licence the owner approved Kimi K3 (keep the notice), Grok-2 (xAI Community License) and Gemma 3 (Gemma Terms) | RE-03, RE-14 |
| RE-D26 margin near minimums | assumed, open: every count carries `lower`/`upper`; markers and budgets use the side the profile requires | RE-14 |
| RE-D27 calibration | assumed, open: an affine fit per route and family in the engine, fed by reported usage | RE-14 |
| RE-D28 OpenRouter | assumed, open: a route-level profile per upstream, always `session_id`, documented marker forms only | RE-14 |
| RE-D29 cache reads in the token budget | open, owner decision: full weight in Phase 1, reads and writes recorded separately; RE-14/P5 builds the setting (default 1.0) and the split view the decision needs. The owner said on 2026-10-28 to decide once that view shows real numbers | RE-14 |

## How a brief is worked

1. **Claim it** by opening the first pull request of its first task with the title prefix `RE-nn/Tx:`; one pull
   request per task (AGENTS.md: one pull request per package of work; a task is that package here). Report the PR
   number when it is open; the controller merges (CLAUDE.md).
2. **Read first** what the brief lists under "Read first" — the plan sections, the engine files with their line
   counts, the harness files it touches. The engine source is public:
   `git clone https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory` — `9f34008c` (branch `feat/reembedding-validate`,
   engine PR #275, unmerged) is the harness pin and the port source. It is `main` `98dfe2f0` plus
   `admin.reembedding.validate` and a zod override, so every file those two commits do not touch is identical at both.
   Tag `v7.18.31` is the OpenClaw plugin line the change packages come from. Branch `codex/gp3-a1-curated-memory`
   (tip `9b935ce1`) carries A1 curated memory; it is labelled 1.17.0 there and will be renumbered on merge.
3. **Tests first.** Every step that adds behaviour starts with the failing test the brief names; run it, see it fail,
   implement the signature the brief gives, see it pass, commit. Golden files are recorded from the Node engine with
   the command the brief gives and committed with the test; a golden is never edited by hand.
4. **Verify before the PR** with the author's checklist of [`docs/coding-standard.md`](../../../coding-standard.md)
   §11 and the brief's own acceptance section; the PR description quotes the commands and their output, and names
   what could not be run and why.
5. **Rules that always apply** (details in AGENTS.md and the standard): no string "openclaw" and no OpenClaw-shaped
   name anywhere under `crates/` (`scripts/lint-hygiene.mjs` fails the build); schema first, generated code never
   hand-edited; every test seam honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`; `rustfmt` defaults and
   `cargo clippy --workspace --all-targets -- -D warnings`; new dependencies pass `cargo deny check` and
   `node scripts/audit-deps.mjs --only cargo` locally (CI's `quality` job blocks on advisories only, through
   `scripts/release/audit-policy.mjs`; the licence part is this rule, not a workflow) and are named in the PR with licence
   and reason; never skip, disable or quarantine a test; no CI polling; no force-push.
6. **Report back** in the PR: what the brief said, what was done, every deviation with its reason, and the open
   questions for the owner. A deviation from an interface another brief consumes needs the controller's agreement
   before the PR is opened, because the other brief is written against it.
7. **Own your rows.** [`MODULE-MAP.md`](MODULE-MAP.md) assigns every file of the engine closure to a brief with a disposition.
   A brief is complete when each of its rows has a Rust module, a fold target or a recorded drop; a row's disposition or
   owner changes in the same pull request as the code, with the reason in the PR.

## Shared vocabulary

- **CP-n** — change package from the OpenClaw plugin line, plan §3; its rule is an acceptance criterion here.
- **G-&lt;name&gt;-n** — a golden vector recorded from the Node engine; committed under the brief's fixture folder.
- **f.n** — a defect id of `docs/host-contract.md` (f); the brief says which ones it fixes by construction.
- **Seam** — a test-only behaviour switch, honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`.
- **Parity** — the Rust engine and the Node engine (pinned package) answer the same scenario identically within the
  tolerance RE-09 defines: ordered ids exact, block texts exact, timings ignored.

## Status

Kept by the controller. A row changes when a task's PR opens or merges.

| Brief | Status | Pull requests |
|---|---|---|
| RE-00 | merged 2026-10-24 (T1–T4 in one PR, merge commit 76b54e9d); MSVC `protoc` follow-up #769 merged 2026-10-25 | [#759](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/759), [#769](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/769) |
| RE-01 | merged 2026-10-27 (T1–T4 in one PR); the A1 members carry `x-since: a1-pending` until the engine numbers them | [#793](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/793) |
| RE-02 | merged 2026-10-28 (T1–T7 in one PR, with the Windows root follow-up and the review fixes) | [#795](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/795) |
| RE-03 | can start: RE-01 and RE-02 are merged; the jina goldens per RE-D19 as decided on 2026-10-28 | — |
| RE-04 | T0 merged 2026-10-27; T1 onwards waits for RE-03 | [#792](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/792) |
| RE-05 | not started | — |
| RE-06 | not started (go/no-go pending) | — |
| RE-07 | not started | — |
| RE-08 | T1 and T3 in progress | — |
| RE-09 | not started | — |
| RE-10 | not started | — |
| RE-11 | not started | — |
| RE-12 | not started | — |
| RE-13 | not started (Phase 2; decided 2026-10-24) | — |
| RE-14 | P1–P4 and T1 merged 2026-10-26 (#781, #783, #784, #785, #786), T2a and T3 2026-10-27 (#788, #790); P5 (RE-D29 setting) in progress; T2b (exact Gemma 4, DeepSeek V4, Qwen 3.8, GLM counts) waits for the original files and their licences, and may add the Kimi K3, Grok-2 and Gemma 3 files RE-D25 approved; T4 with RE-08, T5 with RE-10 | — |
