# Phase 0 brief — PLUR1BUS Harness

**Status:** binding for Phase 0 · **Date:** 2026-09-22 · **Owner:** Christian (Cyb3rb1ade)

This brief is the original commission (`auftrag-original-2026-09-21.md`, German) plus the decisions taken on 2026-09-22 that supersede parts of it. Where the two disagree, this brief wins. Phase 0 produces analysis and decision records only — **no product code before explicit approval**.

## 1. Decisions taken on 2026-09-22 (supersede the original)

| # | Decision | Replaces in original |
|---|----------|----------------------|
| D1 | **Variant B is the favourite:** a single TypeScript monorepo, Node ≥ 24, pnpm. Variant A (Hermes as pinned Python dependency) is evaluated only as a counter-check in ADR-001, not as the default. | §2.2 default = A |
| D2 | **PLUR1BUS is the core, not a plugin.** The harness must *grow out of* PLUR1BUS: PLUR1BUS gains a host-neutral engine with its own API; the harness is that engine's primary, native host; the existing OpenClaw plugin becomes a secondary adapter. No host shim that emulates the OpenClaw plugin API. No plugin-style loading of PLUR1BUS inside the harness. | §4.1 stage 1 (host shim) is dropped; stage 2 (host-neutral core) becomes mandatory and is the first work package |
| D3 | Engine changes (extraction, principal model, multi-identity recall, Windows port, socket → named pipe) go to the PLUR1BUS repo as PRs. Whether harness and engine end up in one monorepo is decided in ADR-002 with evidence; default is two repos so the OpenClaw plugin keeps its own release cadence. | §2.1 last bullet (kept, sharpened) |
| D4 | **Dreaming must demonstrably work.** Reference model: OpenClaw's sleep plan — light sleep (sort short-term notes, shortlist candidates), REM (reflect on themes and recurring ideas, improve ranking), deep sleep (evaluate shortlisted candidates, promote to long-term memory, write the dream diary). Screenshot: `openclaw-sleep-plan-reference.png`. Requirements: own scheduler (never host cron), per-phase schedule + enable switch + last/next run + duration + outcome counts + per-run log, dream diary readable in UI, "run now", visible error state, timezone-aware. PLUR1BUS is the sole owner of the dreaming logic (`rem-dream`, `consolidate-daily`, `classify-recent`, …); no second loop. | §4.1 feature crons (kept, made a first-class subsystem, new ADR-009) |
| D5 | **External coding agents** are a first-class subsystem: attach installed coding CLIs (claude-code, codex, gemini-cli, grok, kimi, opencode, pi, agy, goose, …) comfortably — auto-detect binary, reuse its login, expose it as an agent for `delegate_task` / `consult_agent`, project boards and channels. Basis: ACP client; PTY/JSON adapter for CLIs without ACP. | §8 ACP client (kept, expanded, new ADR-011) |
| D6 | **Latency is a design goal with numbers:** CLI cold start target < 100 ms for `--help`/simple commands (lazy loading, no full bundle for trivial paths), core daemon warm in background, recall runs inside a time budget in parallel with prompt assembly, first token streamed immediately, local embedding/rerank models pre-loaded. Benchmarked from M1. | new (ADR-010) |
| D7 | **Input/output caching for token efficiency**, three layers: (1) provider prompt caching (Anthropic `cache_control`, OpenAI automatic prefix caching, Gemini context caching) with a cache-stable prompt layout — volatile recall/temporal/mood blocks placed *after* the cached prefix; (2) embedding cache keyed by embedding identity + content hash; (3) response/tool-result cache with explicit invalidation. | new (ADR-010) |
| D8 | **Per-agent behaviour profiles for group chats vs. 1:1**: reply policy (always / on mention / on question / keyword), tone overlay, memory-capture rules, rate limits, per-channel overrides. | §5 agent settings (expanded, ADR-003) |
| D9 | Embedding **and** reranking models are mandatory core capabilities (restated three times by the owner). Owner of `embed()`/`rerank()` is the PLUR1BUS engine, in-process (Transformers.js/ONNX) and remote. | §6.2 (kept) |
| D10 | Repo `Cyb3rb1ade/PLUR1BUS-Harness`, public, MIT. Documentation and code comments in English; conversation with the owner in German. | §0 (kept, language fixed) |
| D11 | Work is done by subagents matched to the task (Haiku for extraction, Sonnet for code reading and matrices, Opus for ADRs, gap analysis and reviews). Kimi is no longer involved; nothing from earlier attempts is reused. | §13 executor |

Everything in the original not touched by D1–D11 remains binding: functional requirements §5–§9, platforms §10, security/quality §11, milestones §12 (to be re-cut for Variant B in `docs/milestones.md`), open questions §13 with their defaults.

## 2. Phase 0 deliverables (re-cut for D1–D9)

| File | Content |
|------|---------|
| `docs/host-contract.md` | Every OpenClaw host-API surface PLUR1BUS uses today (hooks, `runtime.llm.complete`, memory slot incl. `classifyWorkspaceMemoryPaths`, gateway methods, CLI registration, cron provisioning, control-UI descriptor, session entry form, shutdown, config schema) with file:line, semantics, time budget — and its mapping onto the future engine API / harness host. Plus: all embedding/rerank call sites, today's principal model, the uniform-dimension assumption, the Unix-socket embedding owner, `0o600/0o700` and shell-script assumptions. |
| `docs/engine-extraction.md` | What in PLUR1BUS is engine, what is OpenClaw adapter, what is UI; proposed package boundaries; PR plan for the PLUR1BUS repo; behaviour-neutrality test strategy (full suite green under both adapters). |
| `docs/learnings-hermes-openclaw.md` | What Hermes and OpenClaw do well (agent loop, provider runtime, OAuth, adapters, profiles, cron delivery, subagents, skills, dreaming) and what we take as *design ideas* (never code); what we deliberately do differently. Replaces the original `hermes-gap-analysis.md`. |
| `docs/provider-matrix.md` | Chat / embedding / rerank capability per provider, wire format, base URL, auth kinds, discovery, prompt-caching support, policy status, source + check date. |
| `docs/platform-matrix.md` | Native binaries per target for `@lancedb/lancedb`, `onnxruntime-node` / `@huggingface/transformers`, `sharp`, `node:sqlite`, Matrix crypto; CI runner labels; Node-24 startup techniques. |
| `docs/import.md` | OpenClaw and Hermes source formats (versions, paths, schemas) and mapping onto the harness. |
| `docs/adr/ADR-001 … ADR-011` | 001 base (B vs A) · 002 PLUR1BUS engine & harness host · 003 agent model & collaboration incl. group/1:1 behaviour · 004 web UI & harness API · 005 auth policy & secret store · 006 embedding/rerank service · 007 users, roles, identity linking · 008 protocols MCP/ACP/A2A · 009 dreaming scheduler · 010 latency & caching · 011 external coding agents |
| `docs/milestones.md` | Milestones re-cut for B (CLI first, GUI later), effort, risks, test plan. |
| `docs/assumptions.md` | Explicit assumptions and open questions, kept current. |

Then **stop** and wait for approval.

## 3. Rules for everyone working on Phase 0

- Nothing invented. Every claim about a provider endpoint, OAuth flow, protocol version, SDK, native binary or PLUR1BUS internals carries a source (URL or `file:line`, commit, date).
- Reality contradicts the brief → stop, report the finding and options; never deviate silently.
- No secrets, tokens or real user data anywhere.
- Small, topical commits (Conventional Commits).
