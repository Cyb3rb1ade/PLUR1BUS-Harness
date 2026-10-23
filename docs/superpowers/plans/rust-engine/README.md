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
| [RE-10](RE-10-phase2.md) | Phase 2: memory-facing core paths move into the engine; the three behaviour changes of plan §1.6 (T7–T9, behind RE-D11…RE-D13) | L | Phase 1 exit | RE-11 |
| [RE-11](RE-11-phase3.md) | Phase 3: retire the Node engine, ADR-018, docs | M | RE-10 | — |
| [RE-12](RE-12-forward-port.md) | Forward-port CP-5 and CP-7 to the Node engine `main` now | S | — (independent) | goldens for RE-04/RE-06 |
| [MODULE-MAP](MODULE-MAP.md) | Module inventory: every file of the engine closure → owner brief and disposition (port / fold / decide / drop) | — | — | the completeness check of every brief |

## Working assumptions

The plan lists owner decisions RE-D1…RE-D13 (plan §6; RE-D11…RE-D13 are the three behaviours of plan §1.6 that Phase 1
keeps at parity on purpose). Until the owner decides otherwise, every brief assumes the
recommendation. If a decision changes, the briefs named in the last column change; nothing else does.

| Decision | Assumed | Briefs that depend on it |
|---|---|---|
| RE-D1 integration | supervised process + harness RPC, not N-API | RE-08, RE-09, RE-10 |
| RE-D2 location | crate `crates/plur1bus-engine` in this workspace | RE-00 and all |
| RE-D3 store | `lancedb` pinned to the Lance version the Node package embeds (0.26.x, `lance = 2.0.0`); no store migration in Phase 1–2 | RE-02, RE-07 |
| RE-D3b ONNX Runtime | `ort` with `load-dynamic`, a `libonnxruntime` shipped per target | RE-03, RE-08 (payload) |
| RE-D4 embedding IPC | `lib/providers/scoped-embedding-ipc.js` is not ported; `engine.embedding.*` RPC replaces it | RE-03, RE-08 |
| RE-D5 jobs | staged: deterministic core first, go/no-go before RE-06 | RE-06 |
| RE-D6 contract | 1.17.0 from the start (the harness's `memory.curation.*` expectations are the spec), 1.16.0 subset at parity | RE-01, RE-07 |
| RE-D7 engine repository | stays for the OpenClaw plugin line; the harness stops depending on it in Phase 3 | RE-11 |
| RE-D8 forward-port | CP-5 and CP-7 go to the Node engine's `main` now | RE-12 |
| RE-D9 TypeScript core | not part of this programme | — |
| RE-D10 distribution | the engine binary joins the release payload, the container image and the desktop bundle | RE-08 |
| RE-D11 recall score | kept at parity in Phase 1; cosine score and calibrated thresholds in RE-10 T7 | RE-02 (metric default), RE-04, RE-10 |
| RE-D12 hybrid retrieval | kept at parity in Phase 1; full-text index and rank fusion in RE-10 T8 | RE-02, RE-04, RE-10 |
| RE-D13 job partitions | kept at parity in Phase 1; the agent partition reads its scoped rows in RE-10 T9 | RE-06, RE-10 |

## How a brief is worked

1. **Claim it** by opening the first pull request of its first task with the title prefix `RE-nn/Tx:`; one pull
   request per task (AGENTS.md: one pull request per package of work; a task is that package here). Report the PR
   number when it is open; the controller merges (CLAUDE.md).
2. **Read first** what the brief lists under "Read first" — the plan sections, the engine files with their line
   counts, the harness files it touches. The engine source is public:
   `git clone https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory` — `main` at `98dfe2f` is the harness pin and the
   port source; tag `v7.18.31` is the OpenClaw plugin line the change packages come from; branch
   `codex/gp3-a1-curated-memory` (tip `9b935ce`) carries contract 1.17.0.
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
   `node scripts/audit-deps.mjs --only cargo` and are named in the PR with licence and reason; never skip, disable or
   quarantine a test; no CI polling; no force-push.
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
| RE-00 | not started | — |
| RE-01 | not started | — |
| RE-02 | not started | — |
| RE-03 | not started | — |
| RE-04 | not started | — |
| RE-05 | not started | — |
| RE-06 | not started (go/no-go pending) | — |
| RE-07 | not started | — |
| RE-08 | not started | — |
| RE-09 | not started | — |
| RE-10 | not started | — |
| RE-11 | not started | — |
| RE-12 | not started | — |
