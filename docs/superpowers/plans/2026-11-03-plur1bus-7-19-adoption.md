# Adopting PLUR1BUS 7.19.0 (changes since 7.18.24) into the Harness and the Rust engine

Status: plan, 2026-11-03. Owner request: analyse the changes since 7.18.24 and adopt them into the Harness and the Harness engine. Companion to [the engine pin plan](2026-11-03-engine-pin-lens-acl-capture-logs.md), whose P0 pin this plan extends.

## 1. Source and the two engine lines

Repository `Cyb3rb1ade/openclaw-plur1bus-memory` has two lines:
- **Release line** (OpenClaw plugin, `lib/` layout): `v7.18.24` (`c3c1cb44`) → `v7.18.31` (`6419a60e`) → `v7.19.0` (`83640e6b`, 2026-11-02). 31 commits, 135 files since 7.18.24.
- **Engine line** (`engine/` layout, `main`, contract 1.17.0): the Harness pins it (`9f34008c`, PR #275 branch).

The lines have diverged: `v7.19.0` carries 52 commits that are not on `main`, and `main` carries 488 that are not in `v7.19.0`. The Harness therefore cannot pin `v7.19.0`; the release-line changes reach the Harness by porting them to the engine line (Node) and then to the Rust engine. The 21 older release-line commits (7.18.5–7.18.23) that are also missing on `main` are outside this request (see §5, Q4).

## 2. Changes since 7.18.24 and where they go

| Release | Change | Classification | Target |
|---|---|---|---|
| 7.19.0 | `zod` override 4.6.7 (high-severity memory exhaustion in the `openai` chain) | Security | Harness root overrides (today 4.6.6), engine `main` (today 4.6.6) |
| 7.19.0 | `@huggingface/transformers` 4.3.2, `sharp` 0.35.5 (CVE-2026-96889) | Security | Harness already resolves `sharp@0.35.5`; `transformers` 4.3.1 → 4.3.2 for alignment |
| 7.19.0 | Jev emotion assessment `emotion.jev` (`off`/`shadow`/`active`, global and per agent): incoming reaction evidence before recall (also when `autoRecall` is off or the store fails), 1,000 ms deadline, no retries; `active` applies bounded evidence to the shared per-agent EmotionalState by elapsed time and skips the legacy writer and injector; `shadow` logs bounded proposal metadata only | Engine feature | Engine `main` (Node), Harness config/decision route, later Rust (Q1) |
| 7.19.0 | Telegram outgoing speech adapter: canonical semantic intent and delivery planning instead of raw mood text, `shadow`/`active`, content-free proposals, run-bound private context snapshot (hashed run id, time-bounded, exact agent/session/run/workspace match), fallback to final-text-only; bilingual `de`/`pl` ElevenLabs for three named agents | Concept for Harness voice; the deployment itself is OpenClaw- and owner-specific | Harness voice (D45 phase 2, U12), provider- and language-neutral (Q3) |
| 7.18.31 | Skill Miner: genuine low-confidence decisions vs technical/invalid responses (only genuine ones cached for seven days); versioned fingerprints (evidence content and trust, prompt, effective model and policy, authorized catalogue); invalid cached extraction results rejected; same-owner workflow comparison, explicit rejections binding, repeated instructions are duplicates; bounded topic cohorts (≤ 12 excerpts, ≤ 8 catalogue entries); extensions of existing skills as update proposals bound to a base-content hash | Engine and Harness feature | Engine `main` `lib/jobs/skill-miner*`; Harness skill mining in core (gap analysis, H3) |
| 7.18.28 | Reranker order kept through namespace merge and tier budget; bounded reranker input; retry of incomplete KNOWLEDGE embeddings; graph-only hits that fail relevance excluded; ties keep provider order; omitted caps keep the candidate pool | Engine fix, backport of engine PR #257 (still open, not on `main`) | Engine `main` (merge #257); Rust already follows it (RE-04/T4, CP-5.1 plugin golden) |
| 7.18.27 | Read-only recall comparison (40/50/100 ANN candidates, optional Jev prefilter); production keeps 40 candidates and at most 15 prompt memories; provider ACL checked right before reranking; model selection grouped by provider with natural sorting; catalogue reconciliation separates complete from partial inventories | Operator tool and UX | Harness: optional `memory recall compare`, defaults check, model discovery (D112) |
| 7.18.25, 7.18.26 | Afterthoughts: one persisted random idle delay of 15–120 min, invalidated by new interaction, pinned channel/account/thread/session generation, durable send intent (no automatic retry after an uncertain send), result may be nothing, a short follow-up or a document; stable reflection prefix cached separately from the untrusted conversation | Harness feature candidate | Harness scheduler, channels, prompt cache (Q2) |
| 7.18.25 | Persona learning and proactive feedback exclude heartbeat templates and explicit internal execution | Engine fix | Engine `main`, later Rust |
| 7.18.25, 7.18.29 | Jev credential editing and status in the OpenClaw dashboard | OpenClaw only | none (the Harness keeps credentials in its own secret store) |
| 7.18.30 | Feature-cron RPC retry across OpenClaw plugin reloads | OpenClaw only | none (native Harness scheduler) |

## 3. Tasks

### S1 – Security dependencies (Harness PR, now, about 0.25 agent-days)
`zod` override 4.6.6 → 4.6.7 in the root `package.json` and `pnpm-lock.yaml`; `@huggingface/transformers` 4.3.1 → 4.3.2 where it is a direct dependency. Both go through the dependency policy (exact pin, age at least two weeks); if a version is younger, the owner decides on a security exception. `pnpm audit`, full CI.

### E1 – Engine line (engine repo, owner merges)
On top of the pin plan P0 (#275, #278, #279): merge #257 (rerank order) and the `zod` 4.6.7 override into `main`. The result is `PIN_NEW`.
### E2 – Engine-line ports from the release line (engine repo PRs)
Port 7.18.31 Skill Miner rules and the 7.18.25 persona-learning exclusion to `main`'s `lib/jobs/skill-miner*` and persona modules, with the release-line tests. After Q1: port `emotion.jev`.

### H1 – Harness pin bump
As pin plan P1, to `PIN_NEW`. CHANGELOG additionally names the rerank-order fix.

### H2 – Rust engine
Pin plan P2 and P3, plus: once the Node pin keeps rerank order, re-record the namespace goldens so the CP-5.1 plugin golden and the pin golden agree; remove the contrast note. Any other output change is a stop.

### H3 – Harness skill mining (TypeScript, about 1–1.5 agent-days)
Gap analysis of the Harness skill-mining module against the 7.18.31 rules in §2, then implement the missing ones: decision classes in the cache, versioned fingerprints, same-owner workflow comparison with binding rejections, bounded cohorts, extension proposals bound to a base-content hash. Admission and ACL gates stay unchanged.

### H4 – Emotion assessment (after Q1, about 2 agent-days plus the Rust port later)
Config `emotion.jev` with `mode: off | shadow | active` globally and per agent, default `off`; assessment before recall with a 1,000 ms deadline and no retries; `active` updates the shared per-agent EmotionalState by elapsed time and bypasses the legacy writer; `shadow` writes only bounded, content-free metadata; doctor row and docs. Tests for deadline, store failure, `autoRecall` off and both modes.

### H5 – Afterthoughts (after Q2, about 2 agent-days)
Per-agent opt-in, default off. Scheduler job with a persisted random idle delay, invalidated by new interaction; channel/account/thread/session generation pinned; durable send intent; outcome none / short follow-up / document; stable reflection prefix cached apart from the untrusted conversation; budgets apply. Tests for invalidation, uncertain send and cache prefix stability.

### H6 – Outgoing speech planning (after Q3, about 2 agent-days)
In the Harness voice module: semantic intent and delivery planning instead of raw mood text; `shadow` and `active`; content-free proposals; a private, time-bounded run context snapshot with an exact match on agent, session, run and workspace; fallback to final-text-only. Languages, voices and providers are per-agent configuration, not hard-coded.

### H7 – Recall defaults and comparison (optional, about 0.5 agent-days)
Confirm that the Harness and the Rust engine use 40 ANN candidates and at most 15 prompt memories with the ACL check right before reranking; optionally a read-only `plur1bus memory recall compare`. Model-selection grouping and catalogue reconciliation go into the D112 model-discovery backlog.

## 4. Order
S1 now. E1 → H1 → H2 (with pin plan P1–P3). E2 and H3 in parallel. H4, H5 and H6 after the owner answers Q1–Q3.

## 5. Owner questions
- **Q1 Emotion:** Engine-owned EmotionalState with the assessment routed through the Harness decision service (recommended), or a Harness-only implementation that writes the engine state through the host API?
- **Q2 Afterthoughts:** Adopt in the Harness as per-agent opt-in, default off (recommended)?
- **Q3 Speech planning:** Adopt the concept into the Harness voice roadmap, provider- and language-neutral (recommended)? The OpenClaw Telegram rollout for the three named agents stays outside the Harness.
- **Q4 Older release-line commits (7.18.5–7.18.23, 21 commits not on `main`):** separate audit (recommended), for example host hints not captured, other bots' group thinking blocks not answered, recall preferring the origin row over its chunks, session reset no longer stopping the runtime.
