# Harness hygiene, steering, rewind and the coding ACI — design

**Status:** Specification and plan only, no product code. Owner decisions of 2026-10-30 incorporated (§2); open
questions in §18 · **Date:** 2026-10-30 · **Owner:** Christian (Cyb3rb1ade) · **Tracks:** harness hygiene (H1–H4),
coding ACI (C1–C4), typestate gate (T1), core Phase 4 (P4), M6 Pi verification · **Proposed register entry:** **D120**
in the core spec's register ([`2026-09-24-m1b-2a-core-daemon-cli-design.md`](2026-09-24-m1b-2a-core-daemon-cli-design.md)
§2), not entered yet. D117 is proposed by [`2026-10-21-media-image-verify-design.md`](2026-10-21-media-image-verify-design.md),
D118 and D119 by open PR #825 (`docs/primary-client-role-switch`); no other open PR (#820, #829, #831) or local branch
uses a number above D116, so D120 is the next free one · **Amends (proposed):** ADR-012 D7 and RE-D9, through a new
ADR-019 (§13) · **Plan:** [`2026-10-30-harness-hygiene-coding-aci.md`](../plans/2026-10-30-harness-hygiene-coding-aci.md)

**Inputs read for this spec** (harness `origin/main` at `d01314fa5d`, the branch point of
`docs/harness-hygiene-coding-aci`): [ADR-003](../../adr/ADR-003-agent-model-and-collaboration.md),
[ADR-010](../../adr/ADR-010-latency-and-caching.md) (§1 and both M2 records), [ADR-011](../../adr/ADR-011-external-coding-agents.md),
[ADR-012](../../adr/ADR-012-process-model-and-languages.md) (§1, §2, §3), the Rust engine plan
[`2026-10-23-rust-engine-rewrite.md`](../plans/2026-10-23-rust-engine-rewrite.md) (§2.1–§2.4, §6) with
[its briefs](../plans/rust-engine/README.md) (RE-08, RE-11, RE-14), [`docs/prompt-cache.md`](../../prompt-cache.md),
[`docs/turn-eval.md`](../../turn-eval.md), [`docs/tool-reliability.md`](../../tool-reliability.md),
[`docs/acp.md`](../../acp.md), [`docs/doctor.md`](../../doctor.md), [`docs/voice-local.md`](../../voice-local.md),
`packages/core/src/{tools/{registry,dispatcher,repair}.ts,tools/exec/{run,tool}.ts,tools/fs/tools.ts}`,
`packages/core/src/toolcall/{stable-tools,results,capabilities,first-party-metadata}.ts`,
`packages/core/src/composition/{provider,index,tools,cache-emit}.ts`, `packages/core/src/prompt/telemetry.ts`,
`packages/core/src/session/{store,migrations,turn-loop,turn-telemetry}.ts`, `packages/core/src/rpc/chat-surface.ts`,
`packages/core/src/channels/router.ts`, `packages/core/src/collab/{coding-gate,coding-surface,verifier,guardrails}.ts`,
`packages/core/src/budget/{subagent,calls}.ts`, `packages/core/src/voice/{talk,v2}.ts`, `packages/core/src/doctor-report.ts`,
`packages/web/src/pages/chat/store.ts`, `packages/rpc-schema/schema/rpc.schema.json` (RPC 1.9.0), `deny.toml`,
`Cargo.toml`, `scripts/lint-hygiene.mjs`, the diff of open PR #820 (M6-B ACP client), and the third-party analysis
"Architektur von KI-Coding-Harnesses" (German, 19 pages, §3). Crate and package versions were checked against crates.io
and the npm registry on 2026-10-30 (§12.5).

## 1. Goal and non-goals

**Goal.** After this design is built:

1. Every tool result reaches the model within a fixed inline budget. A larger result never fails: it goes to a
   session-scoped, owner-private artifact store, and the model gets head, tail, a crushed essence and a pointer it can
   page and grep with `artifact.read` (H1).
2. We know what the prompt costs: the provider cache-hit rate per session and per provider, the fixed overhead (system
   plus tool schemas) per agent, the cause of every cache miss, and a recorded `turn-eval-live` baseline that every later
   package reports its delta against (H2).
3. A person can steer a running turn from the web UI and from every channel: the message lands after the running tool,
   the rest of that step's tool calls are skipped, and the follow-up queue keeps working (H3).
4. A person (and, if the owner allows, the agent) can rewind the active path to an earlier message and leave a short
   lesson in its place; the discarded branch stays in the store and the audit chain (H4).
5. Our own agent edits code through a coding ACI built for models: anchored line edits that never reproduce existing
   code, a tree-sitter syntax gate before any byte is written, structural outlines and symbol queries, and test and
   build output crushed to what matters, using the same runners as the D98 completion gate (C1–C4).
6. Every tool execution provably passes the one dispatcher gate, first as a TypeScript architecture test, then as a
   Rust typestate for the new Rust components (T1).
7. The path to a Rust core is written down: Rust for every new component now, a strangler-style Phase 4 after RE-11,
   and the ADR text that records it (P4, §13).

**Non-goals.** A JSONL session DAG, a hard 1,000-token system-prompt cap and a big-bang rewrite (§15). An LSP client
(tree-sitter covers syntax and names, not types). Semantic references across files (C3 is name-based). Replacing the
D98 gate or its review rule. Native (non-ACP) attachment of Pi or any other agent (owner decision 4; §14). Video or
image artifacts (H1 handles text and JSON tool results; media keep their own store). Any USD figure (owner 2026-10-19:
budgets count tokens, turns and time).

## 2. Owner decisions of 2026-10-30 (binding)

| # | Decision | Where this spec carries it |
|---|---|---|
| 1 | Our own agent writes code: in projects (D115 subprojects with worktrees, D98 completion gate) and whenever only a model is attached (API/OAuth) without an external coding CLI. A coding ACI is in scope. | §8 (C1–C4), §7 (H1 crushers) |
| 2 | Steering must work in channels and in the web UI. A message arriving mid-turn can steer: it is delivered after the running tool finishes and the remaining tool calls of that step are cancelled. The follow-up queue stays. Align with the voice barge-in. | §9 |
| 3 | Language path, option B: every new component of this spec is Rust from the start, called by the TypeScript core over RPC (the RE-D1 pattern: supervised process plus harness RPC). After RE-11 the TypeScript core moves to Rust step by step as "Phase 4", strangler-style. This amends RE-D9 and ADR-012 D7. | §5, §12, §13 |
| 4 | Other agents attach only via ACP and MCP. Pi through `svkozak/pi-acp`. An M6 verification covers sessions, cancel/steer and permissions; if ACP is insufficient, that is an owner question before any native-RPC fallback. | §14, Q18 |

Decision 3's history matters for the ADR text: the owner originally wanted everything in Rust. ADR-012 §2 put the core in
TypeScript for two reasons, "the engine is Node, and MCP/ACP/A2A SDKs are TypeScript". The first reason disappears with
RE-11 (the Node engine is retired). The second is weaker than it was: ACP is hand-written with no SDK on both sides
(`docs/acp.md` rulings; owner 2026-10-29 for the client in PR #820), the Telegram, Discord, Slack and Signal adapters
have no runtime dependency at all, and Rust SDKs now exist for MCP (§12.5). Only A2A and two Node-bound ML paths
(local voice, local captions) remain SDK questions.

## 3. The input analysis, and how much weight it carries

The analysis (German, 19 pages, 47 references) argues that the harness, not only the model, decides coding success, and
ends in a seven-point "directive" for a Rust harness. It is useful as a map of mechanisms. Its numbers are uneven, so
this spec cites it as motivation, never as proof; our own `turn-eval-live` and `host-eval` runs decide (§16).

| Claim | Source quality | Weight here |
|---|---|---|
| SWE-agent: GPT-4 Turbo on SWE-bench Lite rose from 11.0 % (plain shell) to 18.0 % with a model-specific interface (100-line viewer, summarised search capped at 50 hits, lint on edit); iterative paged search (12.0 %) did worse than no search tool (15.7 %) | Peer-reviewed (NeurIPS 2024) | The one causal result in the document. Motivates C1–C3 and H1's rule "summarise, never make the model page through noise". |
| Harbor study: 94,000 trials, 12 models, 6 harnesses; cost per task varies 2.1–3.1× for the same model; the harness with offloading and strict prefix caching ranks first on OpenAI models | Real study, run and published by the vendor of the winning harness (Strands) | Direction only (offloading, cache-stable prefix). No number is adopted. |
| Composio: the same model solved 21/30 tasks under Pi and 19/30 under OpenCode; fixed overhead under 1k vs about 6.9k tokens | Vendor blog, n = 30; two-sided Fisher exact test on 21/30 vs 19/30 gives p ≈ 0.79 | Not significant. The overhead figure motivates measuring ours (H2), not a token cap (§15). |
| Hu et al., arXiv 2609.32459 ("Beyond the Model"): +19.4 points from the harness alone; an interaction between model capability and scaffold density | Not verified for this spec | Not used. |
| Rust harness anecdotes (14× time-to-input, 4.3× fewer tokens with tree-sitter navigation, 30 MB idle RAM) | Blogs, Reddit, vendor posts | Not used as evidence. P4 rests on decision 3 and ADR-012's own reasons. |
| Seven-point directive: typestate loop; byte-identical prefix under 1,000 tokens; hashline edits with a tree-sitter pre-write gate; offloading above 1.5–2k tokens with log crushing; JSONL session DAG with branch-and-rewind; worktree subagents without nesting; a definition-of-done ratchet | Design opinion | Adopted where it fits: T1, H1, C1–C3, H4 (on SQLite). Already present: worktree subagents with depth 1 (ADR-003), the D98 ratchet. Rejected: JSONL DAG, the 1,000-token cap (§15). |

The analysis also describes Pi's two asynchronous signals (steer: delivered after the running tool, remaining calls of
the batch dropped; follow-up: queued until the run ends). Owner decision 2 adopts exactly these semantics (§9).

## 4. Starting point (verified at `d01314fa5d`)

Facts this design builds on, with the corrections the code reading produced (marked **corrected**).

| Area | What the code does today | Evidence |
|---|---|---|
| Prompt layout | Four zones (tools → system → frozen memory snapshot → conversation) plus an uncached volatile tail, at most four breakpoints, zone and cumulative prefix hashes on every render; the snapshot is frozen per session and survives restarts (`prompt_snapshots`, session schema v2). Zone 1 "changes only when the agent's tool set changes … invalidate everything". | ADR-010 §1 table and M2 records; `packages/core/src/prompt/`; `composition/cache-emit.ts` (per-provider emitter, profiles in `packages/providers/schema/cache-profiles.json`) |
| Cache telemetry | **Corrected: it exists, in memory.** `createCacheTelemetry()` keeps token-weighted totals per agent+model and per agent+model+session with `hitRatio`, and the core logs `provider.cache_usage` per call. Persisted per-call usage with `cache_read_tokens`/`cache_write_tokens` per agent, provider and model (no session) lives in the budget store's `usage_event` table. Not shown in UI or doctor; `turn-eval-live` reports tool-prefix changes, not provider cache reads. | `prompt/telemetry.ts`; `composition/index.ts:409`; `budget/calls.ts:252`; `docs/prompt-cache.md` "Follow-ups"; `docs/turn-eval.md` |
| Tool offer | `CORE_TOOL_NAMES` has the 8 tools named in the brief; `memory.*` tools are also always offered. Capability routing uses topK 12; `stableToolOffer` admits previous plus newly relevant tools up to the model's `maxTools` at turn boundaries, persisted in `session_tool_offers` (schema v8). Each admission changes zone 1, so the next request misses the whole cache. The fixture corpus measured 3/24 → 0/24 tool-prefix changes after N-F1–F3; no live number exists. | `toolcall/stable-tools.ts`; `composition/provider.ts:347,386-398`; `toolcall/capabilities.ts:56`; `docs/turn-eval.md` |
| Skills | Lazy: `skill.load`/`skill.read` deliver skill text as tool results (cache-friendly, appended). | `toolcall/skill-tools.ts`, `composition/session-skills.ts` |
| Result limits | `DEFAULT_MAX_RESULT_BYTES` 64 KiB, `HARD_MAX_RESULT_BYTES` 1 MiB; above a tool's limit the dispatcher fails the call with `tool-result-too-large` (ruling: "over the limit is an error, never a cut-off JSON value"). | `tools/registry.ts:8-10`; `tools/dispatcher.ts:249-253` |
| Offloading | **Corrected: a rudimentary form exists.** After dispatch, `capResult` caps the model view at 32 KiB (128 KiB for `skill.load`/`skill.read`); a larger value is written to `state/tool-results/<uuid>.json` (directory 0700, file 0600) and the model gets only `{truncated: true, reference: "tool-result:<uuid>"}`. No head or tail, no essence, nothing resolves the reference, the store is global (not per session) with no retention, and incognito sessions fail instead. Net effect today: up to 32 KiB inline, 32–64 KiB an opaque pointer, above 64 KiB a failed call. Subagent results have their own 2,000-token cap with a pointer port. | `toolcall/results.ts:6-29`; `composition/provider.ts:727`; `composition/index.ts:409-411`; `budget/subagent.ts` |
| Exec | `exec.run` starts an allowlisted program without a shell. Each stream is capped at 64 KiB by default (configurable to 4 MiB); **the head is kept and the tail dropped**, so the end of a test run (summary, failures) is what gets lost. Two full streams exceed the dispatcher's 64 KiB and the call fails. | `tools/exec/run.ts:15-16,45-52`; `tools/exec/tool.ts:11-16` |
| Editing | **Corrected: `file.write` exists** (whole file, atomic temp-and-rename, `overwrite` flag, capability `fs.write`, registered when roots are granted); **`file.edit` does not.** The agent changes code by rewriting whole files or through `exec.run` with an allowlisted program, never through a shell. `code.test` and `code.review` are discovery categories of the tools `coding_complete` and `request_review`, not tools. | `tools/fs/tools.ts:1-4,52-60,84-90`; `composition/tools.ts:100-112`; `toolcall/first-party-metadata.ts:35-44` |
| Secrets in results | Only failed results are redacted for the model (registered secret values and log rules). Successful results, and the `state/tool-results` files, are not. | `composition/provider.ts:56-64`; `toolcall/model-tool-error.ts` |
| D98 gate | `coding_complete` (agent tool) and `task.complete` (RPC, human-only) run `CodingGate.verify`: refuses when verifier manifests changed, runs format, lint, typecheck and test from `detectVerifiers` in `sandboxVerifier` (sandbox-exec on macOS, bwrap on Linux, fail closed elsewhere, 60 s per check), requires review above 200 changed lines. **Evidence is a SHA-256 of the output; output over 64 KiB stops the check with `output-limit` and fails it; the model gets exit codes and hashes, not the failing lines.** The refusal is `E_CONFLICT` with the gate's `reason` (`verifiers-failed`, …), not the `E_PRECONDITION` the D98 register row names. | `collab/coding-gate.ts`; `collab/verifier.ts`; `collab/coding-surface.ts:27-50`; `rbac/guard.ts:147` |
| D115 worktrees | `ProjectWorktreePort.root(agentId, projectId, cardId)` binds a card to its worktree. | `collab/coding-surface.ts:15` |
| Session store | `node:sqlite`, WAL, `BEGIN IMMEDIATE` single writer, `busy_timeout` 5 s, FTS5 on messages and titles, append-only messages and events; reversible view overlays in `tool_visibility` (v3, v6) for trimming and pruning; schema v9. `forkSession` copies messages with **seq ≤ `beforeSeq`** (inclusive) into a **new** session (`chat.fork`), it does not rewind in place. | `session/store.ts:124-134,230,431-436`; `session/migrations.ts`; `rpc/chat-surface.ts:77-81` |
| Mid-turn input | Channels: the router serialises per chat, queues up to `MAX_PENDING_PER_CHAT` (20) and drops beyond. RPC and web: `session.submit`/`chat.submit` answer `E_CONFLICT turn-in-progress`; the web shows "busy" and has no queue at all. `session.cancel` aborts the whole turn. Tool calls of one model step run sequentially with an abort check before each. No steering. | `channels/router.ts:8,51-60`; RPC schema `session.submit`; `web/src/pages/chat/store.ts:56`; `session/turn-loop.ts:74-81`; `composition/provider.ts:684-735` |
| Voice barge-in | A barge-in cancels the running agent turn synchronously and stops playback. | `voice/talk.ts:32,74`; `voice/v2.ts:106` |
| Capture | Once per turn, user and assistant text only; tool results are never captured. | `session/turn-loop.ts:228-236` |
| Delegation | Depth 1 (ADR-003 open question 5, guard in `collab/guardrails.ts:23`); subagent budgets and result caps. | ADR-003; `budget/subagent.ts` |
| Eval | `turn-eval.ts` (fixture corpus, regression gate), `turn-eval-live.ts` (nightly, real models from `PLUR1BUS_TURN_EVAL_MODELS`), `host-eval*.ts` (D97). | `toolcall/`; `scripts/eval/`; `docs/turn-eval.md` |
| Rust engine | Plan RE-00…RE-14. RE-D1 (process plus RPC) is still listed as open in plan §6; the briefs assume it and RPC 1.9.0 already carries `x-server: "engine"` methods and a core `EngineClient` (`packages/core/src/engine/client.ts`). RE-D9: "a later rewrite of the TypeScript core — separate decision and plan; not implied by this one" (plan §6; the briefs' README: "not part of this programme"). RE-D20 is decided: one Rust token counter in the engine, served as `engine.tokens.*`. **ADR-018 is reserved** for the Rust engine (RE-11 T5). | plan §2.1, §2.3, §6; `rust-engine/README.md`; `RE-11-phase3.md` T5 |
| Protocols | ACP is hand-written (no SDK). Open PR #820 (M6-B) adds the ACP client: `initialize`, `session/new` (cwd = provisioned worktree), `session/prompt`, `session/cancel`, `session/request_permission` → D109 approval, `fs/*` and `terminal/*` through worktree containment, 1 MiB line limit, at most 200 updates per turn. MCP uses `@modelcontextprotocol/sdk` 1.32.1, A2A `@a2a-js/sdk` 1.3.0; Matrix `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0; local voice `sherpa-onnx-node` ^1.13.0; local captions transformers.js. | `docs/acp.md`; PR #820 diff; `packages/*/package.json` |

## 5. Architecture overview

```text
 supervisor (plur1bus supervise) — slots: engine ─► core ─► api, modules, tools
                                        │
 ┌──────────────────────────────────────┴───────────────────────────────────────────┐
 │ core (TypeScript, unchanged role)                                                │
 │  turn loop ─► provider loop ─► ToolDispatcher: resolve · validate · policy gate  │
 │     ▲  steer inbox (H3)          · approval · execute · result envelope (H1)     │
 │     │  rewind overlay (H4)            │ ticket (T1)        │ redacted bytes      │
 │  telemetry read models (H2)           ▼                    ▼                     │
 └───────────────────────────────── run/tools.{sock|pipe} + token ──────────────────┘
                                        │ harness RPC, x-server "tools"
 ┌──────────────────────────────────────┴───────────────────────────────────────────┐
 │ plur1bus-tools (Rust, new, supervised module)                                    │
 │  gate: UnverifiedAction ─verify(ticket)─► ApprovedAction (T1)                    │
 │  artifacts: per-session store, retention, paging, grep (H1)                      │
 │  crush: test / build / generic / JSON / text crushers (H1, C4)                   │
 │  aci: anchors · file.edit · file.write · syntax gate · outline · symbols (C1–C3) │
 └──────────────────────────────────────────────────────────────────────────────────┘
 plur1bus-engine (Rust, RE programme) — memory only; tokens via engine.tokens.* (RE-D20)
```

**One new process, not the engine.** The new Rust components live in one supervised module process, `plur1bus-tools`
(crate `crates/plur1bus-tools`, lib plus bin), not inside `plur1bus-engine` and not one process each. The reasons and the
trade-off table are in §12.3; in short: a parser or crusher fault must not take recall and capture down, the engine must
not gain write access to worktrees, and the RE parity programme should not absorb unrelated contract members.

**RPC.** The tools process serves `tools.*` over the harness RPC (JSON-RPC 2.0, NDJSON, `run/tools.sock` or the named
pipe, token from the supervisor, the same ACL as `run/`), declared in `packages/rpc-schema/schema/rpc.schema.json` with a
fifth server value `x-server: "tools"` (after `core`, `supervisor`, `module`, `engine`), `x-stability: "experimental"`,
`x-since` the next free minor, closed params (ADR-012 §2; ADR-016). Rust types come from `typify` in `crates/plur1bus-rpc`,
TypeScript types from `json-schema-to-typescript`; contract fixtures serve both sides. Only the core may call `tools.*`:
the connection that authenticated with the core's tools credential carries the principal kind `core`, every handler
requires it, and the dispatcher answers anything else with `E_DENIED` before a handler runs (the pattern RE-08 uses for
`host.*`). The core reaches it through `packages/core/src/tools-service/client.ts` (a `module-api` RPC client, like
`EngineClient`). Without a supervisor (`plur1bus core run`) the core spawns the binary itself, as it does for
`plur1bus-attest` (`PLUR1BUS_TOOLS_BIN` overrides the path). The binary joins the release payload, the container image and
the desktop bundle (the RE-D10 rule).

**Line limit.** NDJSON lines are capped at 4 MiB (ADR-012 §3). Artifact bodies therefore never travel in one call:
`tools.artifact.begin` → `tools.artifact.append` (chunks of at most 1 MiB, sequence-numbered) → `tools.artifact.commit`.

**Secrets never enter the new process.** The registered secret values live in the TypeScript core. The core redacts
every chunk before it sends it (§7.6); the tools process sees only redacted bytes. Phase 4 moves the redactor later.

**Degraded mode.** If the tools process is down, the core keeps working: results over the inline budget get a head/tail
envelope built in TypeScript without an artifact (`artifact: null`, `reason: "tools-unavailable"`), the coding ACI tools
answer `tool-failed` with `reason: tools-unavailable`, and doctor shows the row `tools.service` as `fail` (§6.3).
Nothing fails because a result is large.

## 6. H2 — Measurement first

H2 is telemetry only and stays in TypeScript (decision 3 covers new components; H2 adds read models to existing
TypeScript stores), except the doctor rows, which belong to the Rust CLI.

### 6.1 Cache-hit rate per session and per provider

- **Per provider, agent and model, persisted:** a read model over the existing `usage_event` table (no new store):
  `hitRatio = Σ cache_read / Σ (input + cache_read + cache_write)` per window (last 24 h, 7 d), token-weighted like
  `prompt/telemetry.ts`. Provider usage stays the source; estimated rows (no provider usage) are excluded and counted.
- **Per session:** `CacheTelemetry.summary(agentId, model, sessionId)` already exists; H2 exposes it through a new core
  method `telemetry.cache.summary { sessionId?, agentId?, window? }` (x-server core, read scope like `doctor.report`).
- **Miss attribution:** every rendered prompt carries zone hashes. H2 compares them with the previous request of the same
  session and model and emits `prompt.cache-miss { cause, session_id, agentId, model, toolsAdded, toolsRemoved }` whenever
  `cache_read` is below the stable prefix's expected size. Causes, first match wins: `tools-changed`, `system-changed`,
  `snapshot-changed`, `model-changed`, `ttl-expired` (gap since the last request exceeds the chosen TTL),
  `below-minimum` (R2), `provider` (none of the above). The per-session counters per cause go into the summary.
  This turns ADR-010 R4's "cache-killer" list into numbers and is the measurement the tool-admission decision needs.

### 6.2 Fixed overhead per agent

The fixed overhead is the token size of zones 1 and 2 (tool schemas plus system) for an agent and its model profile,
plus zone 3 (the frozen snapshot) reported separately, because the owner wants persona, SOUL and the snapshot static
and cached, not tiny (§15). Measured at render time from the zones the builder already separates, with the RE-14 token
counter (`engine.tokens.count`) when the Rust engine serves it and the builder's chars/4 estimate otherwise; every value
carries `method: "counter" | "estimate"`. Exposed as `telemetry.prompt.overhead { agentId }` and in the live eval report.

### 6.3 Doctor and 1staid rows

`plur1bus 1staid check` (Rust, `crates/plur1bus/src/commands/firstaid.rs`, ids append-only) gains four rows. Each calls
the core when it is up and reports `skip` when it is not:

| Id | Status rule |
|---|---|
| `prompt.cache-hit` | `info` with the 24 h ratio per provider; `warn` when a provider with at least 20 calls stays below 50 % while its prefix is above the model minimum |
| `prompt.fixed-overhead` | `info` with zones 1+2 and zone 3 per agent; `warn` when zones 1–3 are below the model's cache minimum (nothing caches) |
| `tools.service` | `ok` when `plur1bus-tools` answers `tools.health`; `fail` otherwise (H1 degraded mode) |
| `tools.artifacts` | `info` with store size, quota and the last retention sweep; `warn` above 90 % of the quota or when the sweep is more than 48 h old |

`doctor.report` serves them unchanged (it projects the CLI's report, `docs/doctor.md`).

### 6.4 The `turn-eval-live` baseline and the delta rule

Before any behaviour change lands, H2 records a baseline on the current tools (`file.read`, `file.write`, `exec.run`) with:
the existing live gates (needed-tool hits, missing tools, unnecessary use, skill-load hits, policy violations), plus
**provider cache-read share per scenario and provider**, fixed overhead per agent, tool-result bytes and tokens inline
(p50/p95), the count of `tool-result-too-large` and opaque-pointer results, rounds and turns per task, and wall time. The
corpus gains a **coding scenario set**: three small fixture repositories (Rust, TypeScript, Python) with tasks "make the
failing test pass", "rename a symbol across files", "add a function with a test", each verified by the repository's
own tests, run through the real turn path. `host-eval` runs the same set where a host adapter is the subject. The
baseline report is committed under `docs/evals/` with model ids, dates and denominators.

**Delta rule.** Every later work package of this spec reports its delta against that baseline (same corpus, same
models, same day where possible) in its pull request. A package that makes a gated rate worse does not merge without an
owner decision. Fixture regressions stay the per-PR gate; live runs need credentials and remain nightly or manual.

### 6.5 Admitting newly relevant tools without a full cache miss

Today every newly relevant tool changes zone 1. Four ways out:

| Option | Mechanism | Cost | Cache effect |
|---|---|---|---|
| (a) Batching | Admit pending tools only every k turns or once m are pending | The model lacks the tool exactly when routing found it; it falls back to `capabilities.search` anyway | Fewer misses, not none |
| (b) Overflow as messages | `capabilities.search` already returns discovery rows; it also returns the input schema of a not-offered tool, and a stable meta-tool `tool.invoke { name, arguments }` (in the core set) calls it. Composition rewrites `tool.invoke` into a normal dispatcher call for `name` before dispatch, so validation, repair, policy, approval and audit are exactly those of a direct call. | Provider-side strict schemas do not apply to the inner arguments (the harness validates and repairs, D97); indirect calls may cost accuracy | None: the schema rides in the conversation |
| (c) Pre-admission per agent profile | At session start the offer is the core set, `memory.*`, and the profile's tools (for a coding profile: `file.edit`, `file.write`, `file.outline`, `code.*`, `exec.run`, `artifact.read`, `coding_complete`, `request_review`), frozen for the session in `session_tool_offers` like the memory snapshot | A slightly larger fixed prefix; must stay under the model's `maxTools` | None during the session |
| (d) Provider-native deferral | Where a provider offers deferred tool loading behind its own tool search, use it | Per wire; unverified for our emitters | Depends on the provider |

**Recommendation (Q8):** (c) as the default plus (b) as the overflow path, decided only after the H2 baseline shows the
measured miss rate per admission; (a) not as a default; (d) evaluated per provider later. `artifact.read` joins
`CORE_TOOL_NAMES` (one cache bust at the upgrade, then stable; Q6).

## 7. H1 — Tool-output offloading and crushing (Rust)

### 7.1 Inline budget and the envelope

Every tool result is measured after execution. Up to the **inline budget** it goes to the model unchanged, as today.
Above it the model gets an envelope instead of the value:

```json
{
  "offloaded": true,
  "artifact": "art:<id>",
  "bytes": 912345, "lines": 18234, "sha256": "<hex>",
  "crusher": "test.cargo@1",
  "exitCode": 101,
  "summary": "test result: FAILED. 412 passed; 3 failed",
  "essence": "<the failures: names, assertions, first frames>",
  "head": "<first lines>", "tail": "<last lines>",
  "next": "artifact.read { id, grep | offset }"
}
```

- **Budget:** 2,000 tokens per result by default (Q5), configurable per installation (`tools.results.inlineTokens`,
  500–8,000, `x-restart: "live"`, `x-tier: "advanced"`) and per tool (`limits.inlineTokens`, never above the
  installation value). Counted with the RE-14 counter when available, the chars/4 estimate otherwise. Within the
  envelope: `summary` ≤ 100 tokens, `essence` ≤ 50 %, `head` and `tail` share the rest (tail first: the end of a run
  carries the verdict).
- **Exempt:** `skill.load` and `skill.read` (the text is the instruction; they keep their 128 KiB cap), `memory.*` (recall
  has its own budgets), `artifact.read` (paged inside the budget by construction).
- **Never truncated JSON:** the envelope is always valid JSON. This replaces the dispatcher ruling "over the limit is an
  error, never a cut-off JSON value" with "over the budget is an envelope, never a cut-off JSON value"; its intent stays.
- **Never fails for size.** Above the per-artifact cap (64 MiB) the body is cut at a line boundary and the envelope says
  `cut: true`; the call still succeeds. `tool-result-too-large` stays in the closed error list for compatibility but the
  dispatcher no longer produces it.

### 7.2 Artifact store

- **Layout:** `state/artifacts/<sessionId>/<artifactId>.{log|json}` plus one `index.sqlite` per installation (artifact
  id, session, owner principal, tool, call id, bytes, lines, sha256, crusher, created, expires, cut, redactions).
  Directories 0700, files 0600, on Windows the `run/` DACL pattern (owner only). Written by `plur1bus-tools` only;
  atomic (`.tmp` then rename); `state/` stays on the file tools' deny list.
- **Owner-private:** an artifact belongs to the session's owner principal and the agent acting in that session.
  `artifact.read` from another session, another owner or another agent is refused (`tool-denied`, reason
  `artifact-scope`). Delegated subagents write into the **parent** session's namespace through the existing
  `SubagentResultPort`, so the parent can read what its delegate produced.
- **Retention:** session lifetime plus 30 days (Q5, matching the media store's 30-day default), swept daily by a system
  job and at core start; an archived or deleted session starts the 30-day clock; a deleted session's artifacts go at once.
  **Quota** 1 GiB per installation (media's default `quotaBytes`); above it the oldest artifacts of ended sessions go
  first, never those of a running turn.
- **Incognito:** artifacts are allowed (today such results fail), kept only for the session's lifetime, deleted when the
  session ends and at core start, never indexed, never backed up.
- **Backups and exports:** excluded from the portable backup and from `chat.export` by default (Q7); the envelope in the
  transcript is kept, so an export shows that an artifact existed.
- **Migration:** `state/tool-results/` gets one sweep at the first start of the new version (files older than 30 days
  deleted, the rest left until their age passes 30 days); `capResult`'s store is replaced by the artifact store.

### 7.3 Crushers

Deterministic, versioned rule sets in `crates/plur1bus-tools/src/crush/`; the envelope names the crusher and its version.
"Success is quiet, failure is verbose":

| Crusher | Detected by | Keeps |
|---|---|---|
| `test.*` (node `--test`/TAP, vitest/jest, pytest, cargo test/nextest, go test, JUnit-style Gradle/Maven) | `argv[0]`/`argv[1]` plus output markers | exit code, duration, summary line, every failing test: name, assertion or panic message, the first frames of its trace (frames under `node_modules`, the std library or the runner dropped), captured output of failing tests clipped; passing tests only as counts |
| `build.*` (tsc, eslint, cargo build/check/clippy, rustc, go build/vet, ruff, mypy, gcc/clang style) | same | every `file:line:col: level: message` with two lines of context, grouped per file, duplicates folded with a count; warnings counted, listed only when there are no errors |
| `exec.generic` | fallback for `exec.run` | exit code, stderr tail, stdout tail, lines matching error, fail, panic, exception or fatal (case-insensitive) with context |
| `json` | JSON results (MCP, web APIs) | shape summary (keys, array lengths, types), the first items of large arrays, scalar leaves up to the budget |
| `text` | plain text (`web.fetch`, documents) | headings and first sentences, then head and tail |

On success a test or build run collapses to one line (`exit 0 · 412 passed · 3.2 s`). Crushers never interpret output
as instructions; their text is data like any tool output. Golden fixtures per runner (real outputs, recorded once,
committed) are the tests; a runner whose format changes gets a new crusher version, never a silent edit.

### 7.4 `artifact.read`

A core tool (capability `artifact.read`, intrinsic effect `read`, allowed inside the session's own scope, never
outside it): `{ id, offset?, limit? (lines, ≤ 400), grep? (regular expression), context? (0–10), maxMatches? (≤ 100) }`.
Results stay within the inline budget and carry `nextOffset`. `grep` uses the Rust `regex` crate (linear time; no
backtracking blow-up from a model-written pattern). Every read is audited with the artifact id and range or pattern.

### 7.5 How the TypeScript dispatcher calls the Rust service

1. `ToolDispatcher.call` runs as today up to step 4 (resolve, validate, sandbox precondition, policy, approval, execute).
2. The value is serialised once. If its size is within the inline budget, return it (no RPC).
3. Otherwise the core redacts the bytes (§7.6), then `tools.artifact.begin { sessionId, owner, agentId, tool, callId,
   kind, hints }` → `append` chunks → `commit { budgetTokens, bytesPerToken }`. `hints` carry what the crusher needs
   and the core knows (for `exec.run`: argv, exit code, duration; for MCP: the server and tool name).
4. `commit` returns the envelope; the dispatcher returns it as the tool value with `meta.offloaded = true`.
5. `capResult` in `composition/provider.ts` stays as a last safety net for the model view; it no longer needs a store.

**Exec spool.** `exec.run` does not wait for the end: when the tools service is up, stdout and stderr chunks go to an open
artifact as they arrive (redacted per chunk), so the per-stream limit becomes the artifact limit (default raised from
64 KiB to the existing 4 MiB maximum) and the in-memory capture keeps head and tail (64 KiB each) for the degraded mode.
The tail is no longer lost.

### 7.6 Secrets, approvals, audit and memory capture

- **Redaction before persistence.** The core applies the existing redactor (registered secret values plus the log
  catalogue's rules, `logs/redact.ts`) to every chunk before it leaves the core, with an overlap of the longest
  registered secret minus one byte between chunks so a value split across chunks is still caught. The artifact holds
  only redacted bytes; the redaction count is recorded. The same redactor also runs on every successful result that
  stays inline, which closes today's gap that successful results reach the model and the transcript unredacted (§4).
- **Approvals.** Offloading happens after an approved execution and adds no effect; it needs no approval. `artifact.read`
  is a read in the session's own scope and allowed by default; the capability row goes into `policy/capabilities.ts`
  so an owner can still restrict it.
- **Audit.** `artifact.offloaded { tool, callId, artifactId, bytes, sha256, crusher, redactions, cut }`,
  `artifact.read { artifactId, offset | grep }`, `artifact.swept { count, bytes }`. Never content.
- **Memory capture.** Capture takes user and assistant text only (§4); envelopes sit in tool messages and are not
  captured; artifact bodies are never indexed by recall, never mined by the skill miner, never folded into compaction
  summaries (summaries see the envelope). If the agent quotes an artifact in its reply, that quote is ordinary assistant
  text under the existing capture, sensitivity and D116 confidentiality rules. Nothing writes artifact content into
  memory directly.

### 7.7 Failure modes

| Failure | Behaviour |
|---|---|
| Tools service down or restarting | Degraded envelope from TypeScript (head and tail, `artifact: null`); doctor `tools.service` fails; the turn continues |
| Disk full or quota exhausted after eviction | Degraded envelope with `reason: "artifact-store-full"`; `tools.artifacts` warns |
| Crusher panics | `catch_unwind` at the RPC boundary → `exec.generic`; the panic is logged with the crusher id |
| Artifact expired when read | `tool-failed`, reason `artifact-expired`, with the envelope's summary repeated |

## 8. C1–C4 — The coding ACI (Rust)

The tools are registered in TypeScript like every other tool (`composition/tools.ts`): schema, `classify` (path
canonicalisation against roots and the deny list, as for `file.write`), capability, effect and risk. Their `execute`
calls `plur1bus-tools` with the dispatcher's ticket (§11). The policy, approval and audit path is therefore the one
`file.write` already uses; the Rust side re-checks containment on the canonical target it receives (defence in depth:
the canonical path must lie inside the granted root it names, no symlink may leave it, hard links are refused as in
M6-B's sandbox).

### 8.1 Anchored reading

`file.read` gains `anchors: true` (default false). The core forwards such a read to `tools.file.read` so that anchors are
computed in exactly one place. Each line comes back as `<line>:<hash>│<text>`, where `<hash>` is three base32 characters
of a truncated SHA-256 over the line's bytes without its end-of-line sequence (`sha2` is already in the workspace). The
result also carries `fileHash` (SHA-256 of the whole file), the detected end-of-line style and encoding. Large files are
read by line ranges (`fromLine`, `toLine`); `file.outline` (§8.5) is the way to find the range.

### 8.2 C1 — `file.edit`

```json
{ "path": "src/lib.rs", "expectFileHash": "<optional>",
  "ops": [
    { "op": "replace", "from": "17:k3f", "to": "19:p0a", "content": "    let x = parse(input)?;\n" },
    { "op": "insert_after", "at": "42:q9d", "content": "fn helper() {}\n" },
    { "op": "delete", "from": "60:b2m", "to": "61:b2n" } ] }
```

- Ops address lines only by anchor; the model never reproduces the code it replaces. Each anchor must match the current
  file (line number and hash); a stale anchor refuses the whole call and returns the current anchored window (±5 lines)
  around each mismatch, so the model retries without re-reading the file. Overlapping ops are refused.
- All ops apply to an in-memory buffer, then the syntax gate (§8.4) runs, then one atomic write: temporary file in the
  same directory, `fsync`, rename, file mode and end-of-line style and a byte-order mark preserved.
- Result: a unified diff of the change (through the H1 budget), the new anchors of every changed region, the gate
  verdict. Capability `fs.write`, effect `local-write`, risk `low` inside roots — the classification `file.write` has.

### 8.3 `file.write` through the same gate

`file.write` stays the whole-file create/replace tool with its existing schema and semantics; its execution moves to
`tools.file.write` so a new file passes the same syntax gate before it lands. `overwrite` keeps its meaning.

### 8.4 C2 — Pre-write syntax gate

- The patched buffer is parsed with tree-sitter before anything is written. Embedded grammars: Rust, TypeScript and TSX,
  JavaScript and JSX, Python, Go, JSON, YAML, TOML, Markdown (block and inline). The language comes from the extension
  (and a shebang for scripts); unknown languages pass with `gate: "none"`.
- **Rule (Q17):** refuse only when the edit **adds** `ERROR` or `MISSING` nodes that intersect the changed ranges compared
  with the parse of the original buffer. A file that was already broken elsewhere can still be edited. Markdown and YAML
  are error-tolerant grammars; for them the gate catches little, which is expected.
- On refusal nothing is written. The model gets only the diff it attempted plus the diagnostic: `line:col`, the node kind,
  two lines of context, no full file.
- **Linter on write (Q15):** off by default; a project opts in through `.plur1bus-verifiers.json` (`"onWrite": ["lint"]`),
  and then the project's lint command runs on the changed file in the D98 verifier sandbox after the write; its output goes
  through the H1 crusher. A lint failure does not undo the write; it is reported.

### 8.5 C3 — Outline and symbol queries

| Tool | Input | Output |
|---|---|---|
| `file.outline` | `path`, `depth?` | module items, types, functions and methods with signatures, bodies folded, line ranges and anchors of each item's first line |
| `code.list_symbols` | `path` or a directory inside the worktree, `kind?`, `query?` | symbol name, kind, file, line range; at most 200 per call, paged |
| `code.get_symbol` | `path`, `name` (qualified where the language has qualification) | the symbol's source with anchors, so a `file.edit` can follow without a read |
| `code.find_references` | `name`, `scope: "worktree"`, `path?` | file, line and anchor of each reference; name-based (tree-sitter tags), not type-resolved; at most 200, paged |

Built on `tree-sitter-tags` with the grammars' tag queries. The walk honours `.gitignore` (through `git ls-files` with the
same hardened invocation `collab/verifier.ts` uses), the deny list, the roots and a per-file size cap (1 MiB). An
in-memory index per worktree is keyed by path, size, mtime and content hash and rebuilt lazily; no persistent index in
this version. Names follow the tool-name rule of `session_tool_offers` (lower case, digits, `_`, `.`, `-`).

### 8.6 C4 — Sensors and the D98 gate

- **Exec sensors.** `exec.run` output goes through the H1 crushers (§7.3), so a test or build run the agent starts itself
  comes back as failures and errors, not as 64 KiB of passing lines.
- **One runner set.** A new tool `code.check { kinds?: ["format"|"lint"|"typecheck"|"test"], files? }` runs the
  `detectVerifiers` plan in the bound worktree through the same `VerifierPort` and sandbox as `CodingGate.verify`. The
  agent's own checks and the gate's are the same commands in the same sandbox with the same crusher.
- **Gate output.** The verifier no longer stops a check at 64 KiB: output is spooled to an artifact (cap 16 MiB per
  check, then the check stops with `output-limit` as today). `GateResult.checks[]` keeps `evidence` (now the SHA-256 of the
  full spooled output) and gains `artifact` and `essence`. `coding_complete` refusals carry the essence, so the model sees
  the failing tests without running them again. `task.complete` gets the same fields.
- **Reuse (Q16):** when `code.check` has recorded all four kinds green for exactly the current tree hash, through the
  gate's own `VerifierPort` and plan, within the last 30 minutes of the same core process, `CodingGate.verify` may accept
  those records instead of running the four checks again. The review rule above 200 lines and the manifest check are
  never skipped. Recommendation: yes.
- **Timeouts.** The 60 s per check stays the default; a project may raise it in `.plur1bus-verifiers.json` (`timeoutMs`,
  at most 600 s), because real test suites exceed a minute.

### 8.7 Which agents see these tools

The coding tools are offered to agents with a coding profile (project agents on D115 cards, and agents whose
configuration enables coding), pre-admitted per §6.5 (c). Other agents find them through `capabilities.search`.

## 9. H3 — Steering

H3 changes the existing TypeScript turn loop, provider loop, router and web composer; it is not a new component, so it
stays TypeScript (decision 3).

### 9.1 Semantics

| | **Steer** | **Follow-up** (queue) |
|---|---|---|
| When it is delivered | Into the **running** turn, at the next step boundary: after the tool that is running now finishes | After the running turn ends, as the next turn |
| What happens to the current step | Every tool call of the current model step that has not started is **skipped**: it gets a structured result `{ isError: true, error: { code: "aborted", reason: "steered", hint: "Skipped: the person sent a new instruction." } }`, because every provider wire needs a result for every tool call | Nothing |
| The running tool | Runs to completion; its result stays in the transcript. Steering never kills a tool with side effects. `session.cancel` stays the hard stop. | — |
| Model streaming text, no tool calls | The turn ends normally; the steer message starts the next turn at once, ahead of the queue | Queued |
| No turn running | Behaves as a normal submit | Behaves as a normal submit |
| Order | Several steers in one step are delivered together, in arrival order, as consecutive user messages | FIFO, bounded |

### 9.2 How the sender picks, and the defaults

| Surface | Default | Choose the other |
|---|---|---|
| Web UI | While a turn runs, **Enter = steer**, **Alt/Option+Enter = queue** (Pi's convention; Q9). The composer shows which one Enter does and the queue as removable chips. A setting swaps the two keys. | the other key, or the split button |
| Telegram, Discord, Slack, Matrix, Signal, E-mail, Buzz | **Queue** (today's behaviour). | A message starting with `!` or `/steer ` steers; the prefix is stripped. |
| CLI `plur1bus chat` | Queue | `/steer <text>` |
| Voice (Talk) | see §9.5 | — |
| API and RPC | Today's behaviour (`E_CONFLICT turn-in-progress`) when `delivery` is absent, for compatibility | `delivery: "steer"` or `"queue"` |

The channel default is configurable per agent and per channel kind (`agents.<id>.busyDelivery` with an optional
`byChannelKind` map, `"queue" | "steer"`, `x-restart: "live"`, `x-tier: "advanced"`). It sits beside the ADR-003
behaviour layers, not inside them, because those layers may only restrict and a delivery default is not a restriction.

**Who may steer (Q10).** Only the person whose message started the running turn, or an owner or admin of the
installation. Anyone else's steer request is queued as a follow-up. In group chats this prevents a third person from
redirecting someone else's task.

### 9.3 Mechanics in the turn loop

- `TurnLoop.steer(sessionId, caller, text) → { accepted, turnId | null }` puts the message into the running turn's
  `SteerInbox` (bounded to 8 messages; more are queued as follow-ups) and stores it immediately as a user message of that
  turn (`messages.turn_id` = the running turn, a `turn.steer` event, one transaction), so a crash never loses it.
- The provider loop (`composition/provider.ts`, the `for (const call of calls)` loop) checks the inbox at the top of
  each iteration, where it already checks the abort signal: if messages are waiting, every remaining call gets the
  skipped result, the steer messages are appended as user messages, and the round loop continues with the next model call.
  After a model response with no tool calls the turn completes and the steer becomes the next turn (§9.1).
- Telemetry: `TurnTelemetry` gains `steers` and `skippedCalls`; `turn.steer.applied { turnId, steerIds, skippedCalls,
  withdrawnApproval }` is a new `session.event` type.
- The prompt cache is unaffected: steering only appends to the conversation zone.

### 9.4 Approvals in flight

A steer that arrives while the current call waits for an approval **withdraws** that approval request (Q11): the
approval service records `approval.withdrawn { reason: "superseded-by-steer" }` in its event chain, the dispatcher returns
`tool-not-approved` with `reason: steered`, and, unlike a refusal today, the turn does **not** end: the provider loop
treats this result like a skipped call and delivers the steer. An approval already answered is consumed as today; a
grant is never created by a withdrawal. The dispatcher gets a second signal for this (`DispatchContext.steer`), separate
from the abort signal, so the audit can tell "aborted" from "superseded".

### 9.5 Surfaces

- **Web:** `POST /api/v1/chats/{id}/messages` and `chat.submit` take `delivery`; the composer, the queue chips and a
  "steered" marker on the message in the transcript. The web gets a real follow-up queue (in the core, per session, the
  same bound of 20 as channels), not a client-side one, so a reload keeps it.
- **Channels:** the router recognises a steer request before it serialises the message behind the running turn, checks
  the sender rule, and calls `TurnLoop.steer`. A queued message keeps today's path and drop rule.
- **Voice barge-in (Q12):** playback stops at once, always. If the agent turn is in a tool phase (a tool running or
  calls pending), the interrupting utterance's final transcript is delivered as a **steer**: side-effecting tools finish,
  the rest is skipped. If the agent is only generating or speaking, today's behaviour stays (cancel and start a new turn),
  which is the same as a steer at a boundary with nothing to skip. Speculative turns are unchanged. `TalkSession` gets an
  `agent.steer(handleId, text)` port next to `agent.cancel`. The voice D45 phase-2 plan is a project document outside the
  repository and was not read for this spec; this mapping must be checked against it before H3-2 starts (unknown U12).
- **ACP server side** (`plur1bus acp serve`, our agent driven by an editor): ACP v1 has no steer method; unchanged.

### 9.6 RPC shape

- `session.submit` and `chat.submit`: new optional param `delivery: "steer" | "queue"`; result `state` gains `steered`
  and `queued` (with `position`). Absent `delivery` keeps the current contract.
- `session.queue.list { sessionId }` and `session.queue.remove { sessionId, queueId }` (and the `chat.*` twins) for the
  web chips.
- Notifications inside `session.event`: `turn.steer.accepted`, `turn.steer.applied`, `turn.queue.changed { length }`.
- New reason strings only (`steered`, `queue-full`, `steer-not-allowed`), documented in `docs/errors.md`; no new error code.

### 9.7 Transcript and memory

Steer messages are user messages of the running turn; the turn's capture receives them in order
(`[user, steer…, assistant]`), so memory sees what the person actually asked. Incognito rules are unchanged.

### 9.8 Tests

Scripted-adapter tests on the provider loop: a steer during call 1 of 3 skips calls 2 and 3 with the structured result and
places the steer before the next model call; a steer during model streaming with no tool calls becomes the next turn ahead
of two queued follow-ups; an approval pending when a steer arrives is withdrawn, the chain records it and the turn
continues; the running `exec.run` is never aborted by a steer; every wire format (`anthropic_messages`,
`chat_completions`, `codex_responses`, `gemini`) sends a tool result for every tool call after a steer. Router tests for
the prefix, the sender rule and the queue bound; web tests for the key bindings and the chips; RPC contract fixtures;
a voice test where barge-in during a tool phase steers and during speech cancels.

## 10. H4 — Rewind with lesson

Also a change to existing TypeScript (session store, compaction view, chat surface), so TypeScript.

### 10.1 Model

Rewind hides a contiguous range of the active path and puts a short lesson after the last kept message. It is an
overlay, like trimming and pruning: messages and events stay append-only (the v3 ruling "never rewrite transcript
messages/events"). Session schema v10 adds one table:

```sql
CREATE TABLE path_rewinds (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_seq INTEGER NOT NULL,          -- last message kept on the active path (the parent link)
  hidden_from_seq INTEGER NOT NULL,     -- first hidden message
  hidden_to_seq INTEGER NOT NULL,       -- last hidden message, inclusive
  lesson_message_id TEXT REFERENCES messages(id),
  trigger TEXT NOT NULL CHECK (trigger IN ('user','agent')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);
```

The active path is "all messages minus the hidden ranges of rewinds that are not undone". `parent_seq` is the
`parent_id`-style link: the lesson and everything after it continue from that message. No JSONL, no second store, no
second writer.

### 10.2 The lesson

At most 400 tokens, stored as a message on the active path right after `parent_seq`, rendered to the model as a harness
note ("Lesson from a discarded attempt: …"). Written by the person (`--lesson "…"`), or distilled by the `summarize`
model role through the existing router and budget (the compaction path): its input is the hidden range with tool results
as H1 envelopes (never artifact bodies) and the last failing check's essence. Without a summarize role, a deterministic
digest: the files changed in the hidden range, the last failing check's summary line, and the person's note if any.

### 10.3 Triggers

- **User:** `/rewind [<seq> | last] [--lesson "…"]` as a D33-style transcript command (never reaches the model or the
  cached prefix), `chat.rewind { sessionId, toSeq, lesson? }` and `session.rewind`, and "Rewind to here" on a message in the
  web UI. Requires an idle session (`E_CONFLICT turn-running` otherwise). `/rewind --undo <id>` lifts the overlay.
- **Agent (Q13):** after N failed edit-and-test cycles (a cycle = a write through `file.edit`/`file.write` followed by a
  failing `code.check`, `exec.run` test run or gate refusal). Recommendation: off by default; on per project for unattended
  D115 cards with N = 3, where the rewind is applied at the turn boundary and audited; in interactive sessions the agent
  may only propose (the person confirms with one click or `/rewind`).

### 10.4 Interplay

- **Prompt cache:** the prefix up to `parent_seq` stays cached; the lesson appends. Rewinding is cache-friendly.
- **Compaction:** a summary whose original range overlaps a hidden range drops out of the view and is recomputed on
  demand; tool-visibility overlays inside the hidden range are irrelevant while it is hidden and come back on undo.
- **Search and export:** hidden messages stay in FTS, marked `rewound`; `chat.export` puts them in a "discarded" section.
- **Memory:** turns in the hidden range were captured when they ran; rewind changes context, not memory. A memory from a
  discarded branch is corrected with the existing `memory.correct`/`memory.forget`.
- **Worktree files (Q14):** rewind is conversation-only by default; files the hidden range changed stay changed, and the
  lesson lists them. Optional for D115 worktrees: a per-turn checkpoint ref (`refs/plur1bus/checkpoints/<session>/<turn>`,
  created with `git stash create` semantics without touching the index) and `/rewind --files`, which restores tracked
  files to the checkpoint behind an approval (effect `local-destructive`).
- **Audit:** `session.rewind { sessionId, rewindId, parentSeq, hiddenFrom, hiddenTo, trigger, actor, hiddenDigest }`
  through the chat surface's audit helper, where `hiddenDigest` is a SHA-256 over the hidden messages' ids and texts, so
  the chain proves what was hidden; `session.rewind.undone` likewise. The hidden branch itself stays in the store.

## 11. T1 — The typestate tool gate

### 11.1 Now: a TypeScript architecture test

Two checks, both in `packages/core/test/architecture/`:

1. **Static (type-checked):** a test uses the TypeScript compiler API (TypeScript 5.9.3 is already a dev dependency) over
   `packages/core/src/**` and `packages/hostctl/src/**` and fails on any call of `execute` whose receiver type is
   `ToolDef` or `RegisteredTool` outside `tools/dispatcher.ts`. Known exception today: `callWithRepair` in `tools/repair.ts`
   calls `tool.execute` and is exported, but only tests import it; the test pins that (no importer under `src/`), and the
   function moves to a test helper. `packages/webmcp` is out of scope (browser-side tools of the web page, not core tools).
2. **Runtime (fail closed):** `ToolRegistry.register` wraps each `execute` so it throws unless its context carries a
   dispatcher brand (a module-private `WeakSet` of contexts created in `ToolDispatcher.#run`). A direct call through the
   registry fails at runtime; a test drives every surface that runs tools (session turn, ACP, MCP server, A2A, recurring
   jobs, collab tools, hostctl) and asserts each execution was preceded by a `policy.decision` audit record with the same
   `actionHash`.

### 11.2 Then: the Rust typestate in `plur1bus-tools`

```rust
pub struct UnverifiedAction { /* tool, args, canonical targets, ticket — deserialised from RPC */ }
pub struct ApprovedAction { /* private fields; no constructor outside `gate` */ }
impl Gate { pub fn verify(&self, a: UnverifiedAction) -> Result<ApprovedAction, GateError> { /* … */ } }
impl ApprovedAction { pub(crate) fn execute(self, executor: &dyn Executor) -> Result<Outcome, ToolError> { /* … */ } }
```

- Every mutating `tools.*` method (`file.edit`, `file.write`, later every executor that moves to Rust) takes an
  `UnverifiedAction`; only `Gate::verify` produces an `ApprovedAction`; executors accept only `ApprovedAction`, by value
  (single use). `compile_fail` doctests prove that `execute` does not exist on `UnverifiedAction` and that
  `ApprovedAction` cannot be built outside the gate module (no new dependency). The crate is `#![forbid(unsafe_code)]`;
  the grammars' C code lives in dependencies under the dependency policy.
- **The ticket** binds the TypeScript decision to the Rust execution: after an `allow` or a used approval, the dispatcher
  mints `HMAC-SHA256(key, canonical { actionHash, tool, targets, sessionId, callId, expiresAt })`, with a key generated per
  core start and handed to the tools process on its authenticated connection (`tools.hello`). `Gate::verify` checks the MAC,
  the expiry (30 s), single use (call id), and that `actionHash` equals the hash it recomputes over capability, tool, args
  and targets with the same canonical JSON as `dispatcher.ts` (parity vectors in both test suites). The Rust side cannot
  execute what the TypeScript gate did not approve. C1 and C2 require the ticket from their first version; T1-b adds the
  typestate structure, the doctests and the extension to every mutating method.
- Phase 4 later moves policy evaluation and approvals into Rust (§12.2 step 1); the ticket then becomes an in-process
  value and the typestate covers the whole path.

## 12. P4 — Core to Rust, Phase 4 (outline)

### 12.1 Scope and gate

Phase 4 starts after RE-11 (the Node engine is retired, ADR-018 written) and after the P4 dependency spike (§12.5) has
replaced the unknowns with measurements. It moves the TypeScript core (66,631 lines in 559 files at the time the RE plan
counted, plan §2.3) to Rust one subsystem at a time. Each step keeps the RPC contract: a method moves from
`x-server: "core"` to the Rust process by schema, its contract fixtures pass on both sides before the switch, and the old
TypeScript handler is deleted in the same release that flips it (no long dual life). The web SPA stays TypeScript (it
runs in the browser); Node remains a build-time tool for it only.

### 12.2 Strangler order, and why

| Step | Subsystem | Why in this position |
|---|---|---|
| 0 | (during H1–T1) `plur1bus-tools`: artifacts, crushers, coding ACI, the ticket gate | New code, Rust from the start (decision 3); the nucleus later steps grow from |
| 1 | Tool layer: registry, dispatcher, D109 policy evaluator (`policy/`), approvals and grants store, audit append | Highest safety value (the typestate covers policy, not only execution); `policy/` is a pure library with per-OS path canonicalisation that ports with differential tests; removes the ticket hop |
| 2 | Execution: `exec.run`, sandbox backends, host tools and `hostctl` | Process control is where Rust is already at home (the supervisor handles Job Objects, process groups, lifelines) |
| 3 | Sessions and turns: session store (`node:sqlite` → `rusqlite`, same file and schema, single writer), compaction, turn loop, prompt builder, cache emitter, provider wire formats | The prompt builder is pure and has the B6 byte-identity gate; providers are HTTP plus SSE with recorded wire fixtures; the store keeps its file, so the switch is a process change, not a migration |
| 4 | Channels and switchboard | Telegram, Discord, Slack, Signal, E-mail and Buzz adapters have no runtime dependency today; Matrix gets simpler (the WASM crypto package is the Rust `matrix-sdk-crypto` compiled) |
| 5 | Protocols: ACP (client and server), MCP (client and server), A2A | ACP is hand-written already; MCP has an official Rust SDK; A2A has none (§12.5), so it goes last in this group |
| 6 | Auth engine and OAuth, budgets, inbox, identity, RBAC guard, Harness API (`packages/api`) | Broad but SDK-free; the API last because every client depends on it |
| 7 | Node-bound ML paths: local voice (sherpa-onnx), local captions (transformers.js Florence-2) | Need native ONNX Runtime work and model-specific decoding; they can stay a small Node sidecar until a Rust path is proven |

The order front-loads safety (gate, policy), then pure or dependency-free code, and leaves SDK-bound and model-bound code
for last. Each step is its own plan with work packages; the spike estimates them.

### 12.3 Process topology

| | (A) Inside `plur1bus-engine` | **(B) One supervised `plur1bus-tools` module (recommended)** | (C) One process per component |
|---|---|---|---|
| Fault isolation | A grammar, crusher or file-system fault takes recall and capture down | Own process, own restart, own backoff | Finest |
| Privilege | The engine would need read/write on worktrees beside its stores | Its own sandbox profile: granted roots and `state/artifacts/` only | Finest |
| Contract | Mixes tool methods into the engine contract while RE parity runs | Own `x-server: "tools"` methods | Many small surfaces |
| Operations | No new slot | One slot, one binary in payload, image and bundle | Three or more slots; edit → gate → artifact becomes IPC |
| RAM | None extra | A small Rust process (no Node heap; ADR-012 counts 30–50 MB per Node process) | Several |
| Phase 4 path | Muddles memory and core | Grows into the Rust core; methods move into it step by step | Fragmentation |

Recommendation (Q3): **(B)**. The engine stays the memory process. In Phase 4, `plur1bus-tools` becomes the Rust core
process (renamed when step 3 moves sessions and turns into it); the TypeScript core shrinks until it disappears. The token
counter stays one implementation (RE-D20): until the dispatcher moves, the core counts and passes `budgetTokens` and
`bytesPerToken` to the tools process; when the dispatcher moves (step 1), `src/tokens/` is extracted from the engine into a
shared crate used by both binaries.

### 12.4 RPC through the single source

Every method stays in `packages/rpc-schema/schema/rpc.schema.json` (ADR-012 §2): closed params, `x-server`, `x-stability`,
`x-since`; Rust types through `typify` in `crates/plur1bus-rpc`, TypeScript types through `json-schema-to-typescript`;
contract fixtures read by both. When a method moves, only its `x-server` changes; clients route by the capability list
each server returns in its `*.auth` result (`buildCapabilities` filters by server today).

### 12.5 Dependency spike (versions from crates.io and npm, checked 2026-10-30)

| Area | Today (TypeScript) | Rust candidate | Note |
|---|---|---|---|
| Tree-sitter (C2, C3) | none | `tree-sitter` 0.27.1 (MIT, 2026-10-08), `tree-sitter-tags` 0.27.1; grammars `tree-sitter-rust` 0.24.2, `-typescript` 0.23.2 (last release 2024-11), `-javascript` 0.25.0, `-python` 0.25.0, `-go` 0.25.0, `-json` 0.24.8, `-yaml` 0.7.2, `-toml-ng` 0.7.0, `-md` 0.5.4, all MIT; alternative bundle `tree-sitter-language-pack` 1.22.1 (MIT) | New dependencies through the gate of `docs/dependency-policy.md` and `deny.toml` (MIT is allowed); grammar ABI compatibility with 0.27 to verify (U3) |
| Diffs (C1) | none | `similar` 3.2.1 (Apache-2.0) | or a hand-written line diff |
| Regex, hashing, SQLite | — | `regex` 1.13.1, `sha2`, `blake3`, `rusqlite` 0.40.2 (all already in `Cargo.lock`; `rusqlite` 0.41.1 is current) | no new dependency |
| MCP client and server | `@modelcontextprotocol/sdk` 1.32.1 | `rmcp` 3.8.0 (Apache-2.0, the official `modelcontextprotocol/rust-sdk`, released 2026-10-26) | younger than two weeks at the check; pin an older patch per policy |
| ACP | hand-written, no SDK (owner 2026-10-29) | keep hand-written; or `agent-client-protocol` 3.6.0 (Apache-2.0, 2026-10-28) with `agent-client-protocol-schema` 1.14.0 (2026-10-30) | the no-SDK ruling most likely carries over; compare the schema crate's version line with our protocol version 1 (U8) |
| A2A | `@a2a-js/sdk` 1.3.0 | no official Rust SDK found; community crates `a2a-rs` 0.10.5 (MIT), `ra2a` 0.9.1, `a2a-rust` 0.1.0 | hand-write against the A2A JSON schema like ACP (U4) |
| Telegram | hand-written, no dependency | hand-written over `ureq`/`rustls` (in the workspace); `teloxide` 0.17.0 (MIT, last release 2025-07-11); `frankenstein` 0.52.1 is WTFPL, not in the `deny.toml` allow list | hand-written recommended |
| Discord | hand-written, no dependency | `twilight-gateway` 0.17.1 (ISC) or `serenity` 0.12.5 (ISC) | ISC is allowed |
| Matrix | `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0 | `matrix-sdk` / `matrix-sdk-crypto` 0.19.1 (Apache-2.0, 2026-09-18) | the WASM package is this crate compiled |
| Local voice | `sherpa-onnx-node` ^1.13.0 | `sherpa-onnx` 2.0.1 (Apache-2.0, k2-fsa, 2026-10-27); `sherpa-rs` 0.6.8 (MIT, 2025-10-05) | ONNX Runtime linking against RE-D3b's `load-dynamic` runtime unverified (U5) |
| Local captions | transformers.js (Florence-2, `media-search/caption/local.ts`) | `ort` 2.0.0-rc.15 plus `tokenizers` (pinned `=0.23.2` by RE-D19; 1.0.0-rc.3 is newest) with a hand-written encoder-decoder loop; `candle-transformers` 0.11.0 | Florence-2 support in candle unverified (U6) |

The spike builds a throwaway branch that compiles each candidate for the five release targets, runs `cargo deny`, and
measures binary size and cold start; it ends with a Phase 4 estimate per step.

## 13. ADR amendment (proposed text)

Decision 3 changes two recorded decisions: ADR-012 D7 ("TypeScript for the core and every module bound to a Node SDK")
and RE-D9 ("a later rewrite of the TypeScript core — separate decision and plan; not implied by this one"; the briefs'
README: "not part of this programme"). Two ways to record it:

- **An amendment section in ADR-012.** Keeps one place for languages, but ADR-012 is already 360 lines of decision plus
  implementation records, and a language policy change would sit between supervision details.
- **A new ADR (recommended, Q2).** ADR-018 is reserved for the Rust engine (RE-11 T5), so this is **ADR-019**. It states
  the policy once, ADR-012 gets a short amendment note pointing to it (the pattern RE-11 uses for ADR-018), and the RE-D9
  row in the RE plan and its README changes to "superseded by ADR-019".

Proposed text:

> **ADR-019: Rust for new components, and the core's strangler path to Rust**
>
> **Status:** Proposed (owner decision 2026-10-30, option B; D120). **Amends** ADR-012 §2 (D7) and supersedes RE-D9.
>
> **Context.** ADR-012 chose TypeScript for the core because the engine was Node and the MCP, ACP and A2A SDKs were
> TypeScript. RE-11 retires the Node engine; ACP is hand-written on both sides; the channel adapters have no runtime
> dependencies; an official Rust MCP SDK exists. The owner's original direction was Rust throughout.
>
> **Decision.** (1) Every new harness component is written in Rust from its first version and called by the TypeScript
> core over the harness RPC as a supervised process (the RE-D1 pattern), with JSON Schema as the single source of every
> cross-language type (ADR-012 §2 unchanged). New components of this kind start in one first-party module process,
> `plur1bus-tools`, unless a separate process is justified by isolation. (2) After RE-11 the TypeScript core moves to Rust
> subsystem by subsystem ("Phase 4"), in the order of the D120 design §12.2, each step behind contract fixtures, with no
> big-bang rewrite and no long dual implementation. (3) Changes to existing TypeScript code that are not new components
> stay TypeScript until their subsystem's Phase 4 step. (4) The web SPA stays TypeScript. (5) Rust work is done by Claude
> agents.
>
> **Consequences.** One more supervised process now; a growing Rust surface that later absorbs the core; the dependency
> policy applies to every new crate; Node leaves the runtime when the last Phase 4 step lands, except for any ML sidecar
> step 7 keeps.

Amendment note for ADR-012 (status line and a one-paragraph note after §2): "Amended 2026-10-30 by ADR-019: new
components are Rust from the start; the core follows in Phase 4. §2's reasons for a TypeScript core no longer hold after
RE-11." RE plan §6, RE-D9 row: "Superseded by ADR-019 (owner decision 2026-10-30, option B)."

## 14. M6 — Pi over ACP verification

Pi attaches through `pi-acp` (npm `pi-acp` 0.0.34, MIT, published 2026-09-24; ADR-011 lists it as registry-only at
v0.0.33 and as 0.0.34 in the 2026-10-07 connector catalogue), which spawns `pi --mode rpc` (Pi's package is
`@earendil-works/pi-coding-agent`, 1.4.0 on 2026-10-21; `pi-acp` needs Pi 0.81.0 or later and Node 22). The adapter's own
README states the limits that matter here: no ACP `fs/*` and no `terminal/*` delegation (Pi reads, writes and executes
locally), MCP servers accepted but not wired through, the queue implemented client-side, and steering and follow-up modes
exposed as slash commands (`/steering`, `/follow-up`, `/queue`).

The verification runs on PR #820's ACP client in a provisioned worktree against the three fixture repositories of
§6.4 and records, per item, pass, partial or fail with evidence:

| Item | What is checked |
|---|---|
| Sessions | `session/new` with the worktree as cwd; `session/load` reattaching through pi-acp's session map; `usage_update` |
| Prompt and updates | streaming, `tool_call` / `tool_call_update` mapping, structured diffs; whether a long task exceeds #820's 200-updates-per-turn limit |
| Cancel | `session/cancel` latency, the state after cancel, whether a running Pi tool finishes or is killed |
| Steer | whether a second `session/prompt` during a running prompt is accepted, queued or refused; what `/steering` changes; whether the steer lands after the running tool (decision 2's semantics) |
| Permissions | whether any `session/request_permission` arrives (Pi has no per-tool prompts by design); confirm that all writes and executions stay inside M6-B's process containment, since pi-acp does not delegate `fs/*` or `terminal/*` |
| MCP | that harness MCP servers are not reachable through pi-acp (expected), and what Pi's own MCP adapter would need |

**Expected outcome:** sessions, prompts and cancel pass; steer is partial (ACP v1 has no steer method; the closest is
cancel plus a new prompt, which loses "after the running tool"); per-tool permissions fail by design, leaving process
containment as the boundary. That result goes to the owner as **Q18** before anything else happens: either accept the
ACP limits for Pi (steer = cancel + re-prompt, containment instead of per-tool approval), or authorise a native
`pi --mode rpc` adapter as an exception to decision 4. Recommendation: accept the ACP limits for M6; revisit if ACP gains
a steering or queued-prompt primitive.

## 15. Explicitly rejected

| Proposal | Why not |
|---|---|
| A JSONL session DAG instead of SQLite | The session store already has one writer per file (`BEGIN IMMEDIATE`, WAL, `busy_timeout`), so the lock contention the analysis warns about does not arise; FTS5, overlays, migrations, erasure and the audit references all live there. Rewind needs a parent link and an overlay (§10), not a new store and a second write path. |
| "System prompt under 1,000 tokens" as a hard rule | Persona, SOUL and the frozen memory snapshot are product features. The goal is a prompt that is static and cached (ADR-010 §1), not tiny. H2 measures the fixed overhead and the hit rate; a size target follows from those numbers, if at all. |
| A big-bang rewrite | Phase 4 is strangler-style by owner decision; each step keeps the RPC contract and its fixtures. |
| Paged interactive search as the main navigation | The one peer-reviewed number in the analysis shows paged search doing worse than no search; C3 returns summarised, bounded answers instead. |
| An LSP client for C3 | Indexing and warm-up per language server, process management per language; tree-sitter covers syntax and names, which is what the gate and the outline need. |

## 16. Measurement and acceptance

Every package reports its delta against the H2 baseline (§6.4). Targets, to be confirmed by the baseline numbers:

| Package | Acceptance |
|---|---|
| H1 | zero `tool-result-too-large` and zero opaque-pointer results in the corpus; inline tool-result tokens p95 ≤ the budget; needed-tool hit rate not lower than the baseline; tasks with a failing test reach the failing assertion without a second `exec.run` |
| C1 | output tokens per edit task lower than the `file.write` baseline; stale-anchor refusals recovered within one retry in at least 90 % |
| C2 | zero syntactically broken files written in the corpus; gate latency p95 under 50 ms for files up to 1 MiB |
| C3 | fewer read tokens per "rename a symbol" task than the baseline; `code.find_references` finds every reference the fixture lists |
| H2 tool admission | cache misses caused by `tools-changed` per session reduced to at most one, or zero with pre-admission |
| H3 | the §9.8 tests; no orphan tool call on any wire |
| C4 | `coding_complete` refusals carry failing test names in 100 % of the corpus cases; no check stopped by `output-limit` under 16 MiB |
| H4 | rewind plus lesson recovers at least as many failed coding tasks as continuing on the polluted path, measured on the corpus |
| T1 | the architecture test fails on a seeded bypass; `compile_fail` doctests pass |

## 17. Security and privacy review

- **New process, least privilege:** `plur1bus-tools` gets the granted roots and `state/artifacts/` and nothing else
  (sandbox profile per platform as for the verifier); it holds no secret values and opens no network connection.
- **No new execution path:** every mutating Rust method requires a dispatcher ticket bound to the approved action hash
  (§11.2); the TypeScript architecture test guards the remaining TypeScript paths (§11.1).
- **Artifacts:** owner-private, per session, 0600/0700, redacted before persistence, excluded from backups and exports by
  default, retention and quota enforced, never captured into memory, never indexed by recall.
- **Untrusted text:** crusher output, verifier output and artifact reads are data, never instructions (the existing
  taint rule for tool results applies; `exec.run` already runs inside the sandbox).
- **Parsers:** tree-sitter grammars are C code; a crash takes down only `plur1bus-tools`, which the supervisor restarts.
  Inputs are size-capped (1 MiB per file for C2/C3).
- **Steering:** sender rule (§9.2), withdrawal recorded in the approval chain, no grant from a withdrawal.
- **Rewind:** the hidden branch stays and its digest is in the audit chain; file restore is behind an approval.

## 18. Owner questions

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | Register entry | one record D120 for H/C/T/P4; or separate records per track | **One record D120** with sub-ids H1–H4, C1–C4, T1, P4; D117–D119 are taken by proposals |
| Q2 | How to record decision 3 | amendment section in ADR-012; new ADR | **New ADR-019** (ADR-018 is reserved for the Rust engine) with an amendment note in ADR-012 and the RE-D9 row marked superseded; text in §13 |
| Q3 | Where the new Rust components run | inside `plur1bus-engine`; one `plur1bus-tools` module; one process per component | **One supervised `plur1bus-tools` module** (§12.3) |
| Q4 | RPC server value | reuse `x-server: "module"`; new `"tools"` | **New `"tools"`**, with a dispatch-level guard that admits only the core, like `host.*` for the engine |
| Q5 | Budget, retention, quota | inline 1k/2k/4k tokens; retention session + 7/30/90 days; quota 512 MiB/1 GiB/4 GiB | **2,000 tokens; session + 30 days; 1 GiB** (matches media) |
| Q6 | `artifact.read` in the fixed core set | core tool; admitted on demand | **Core tool** (one cache bust at the upgrade, never again) |
| Q7 | Artifacts in backups and exports | included; excluded; opt-in | **Excluded by default**, envelopes stay in the transcript |
| Q8 | Admitting newly relevant tools | batching; overflow via messages + `tool.invoke`; pre-admission per agent profile; provider-native deferral | **Pre-admission per profile plus the `tool.invoke` overflow**, decided on H2's measured miss rate; no batching default |
| Q9 | Web keys while a turn runs | Enter = steer; Enter = queue | **Enter = steer, Alt/Option+Enter = queue**, swappable in settings |
| Q10 | Who may steer | anyone allowed in the chat; the turn's originator plus owner/admin | **The turn's originator plus owner/admin**; others are queued |
| Q11 | A steer while an approval is pending | the steer waits for the answer; the approval is withdrawn and the turn continues | **Withdraw and continue**, recorded in the approval chain |
| Q12 | Voice barge-in | always cancel (today); steer in a tool phase, cancel while speaking | **Steer in a tool phase, cancel while speaking**; playback always stops at once |
| Q13 | Agent-triggered rewind | never; propose only; automatic after N failed cycles | **Off by default; automatic with N = 3 only on unattended D115 cards where the project enables it; propose-only in interactive sessions** |
| Q14 | Rewind and worktree files | conversation only; optional file restore from per-turn checkpoints | **Conversation only by default**; `--files` restore behind an approval in D115 worktrees |
| Q15 | Linter on write | on; off; per project | **Off by default, per-project opt-in** in `.plur1bus-verifiers.json` |
| Q16 | Gate reuse of `code.check` results | always re-run; reuse on an identical tree hash | **Reuse** when all four kinds ran green through the gate's own runner on the identical tree hash within 30 minutes; review and manifest checks never skipped |
| Q17 | Syntax gate rule | refuse on any parse error; refuse only on new errors in changed ranges | **Only new errors intersecting the changed ranges** |
| Q18 | If ACP is insufficient for Pi (expected for steer and per-tool permissions) | accept the ACP limits; authorise a native `pi --mode rpc` adapter | **Accept the ACP limits for M6** (steer = cancel + re-prompt, process containment instead of per-tool approval); ask again only if Pi's real steering is needed |
| Q19 | When Phase 4 starts | right after RE-11; after RE-11 and the P4 spike; later | **After RE-11 and the P4 spike**, in the §12.2 order, one plan per step |

## 19. Unknowns

| # | Unknown | How it gets resolved |
|---|---|---|
| U1 | Hu et al. (arXiv 2609.32459) and its harness-effect numbers are unverified; the Harbor study is vendor-run; Composio's 21 vs 19 of 30 is not significant (p ≈ 0.79) | Not used as evidence; our baseline (§6.4) decides |
| U2 | The real cache-miss cost of tool admission and the real fixed overhead per agent | H2-1, H2-2, H2-3 |
| U3 | Whether the grammar crates (0.23–0.25 lines, `tree-sitter-typescript` last released 2024-11) load under `tree-sitter` 0.27.1 on all five targets | C2's first task and the P4 spike |
| U4 | A2A in Rust: no official SDK found; the community crates are unvetted | P4 spike; default plan is hand-written |
| U5 | `sherpa-onnx` 2.0.1's ONNX Runtime linking against RE-D3b's `load-dynamic` runtime | P4 spike |
| U6 | A Florence-2 caption path in Rust (`ort` plus a decoding loop, or candle) | P4 spike; may stay a Node sidecar (step 7) |
| U7 | `rmcp` 3.8.0 was published four days before this check; API churn across 3.x | P4 spike pins an older patch |
| U8 | `agent-client-protocol` 3.6.0 / schema 1.14.0 against our hand-written protocol version 1 | P4 spike; M6 |
| U9 | `pi-acp` behaviour for a second `session/prompt` during a running one, and what `/steering` does over ACP | M6 (§14) |
| U10 | Pi's native RPC `steer`/`follow_up` commands are described by the analysis and Pi's docs; not checked here | Only relevant if Q18 authorises the native adapter |
| U11 | Provider-native deferred tool loading and its cache effect on our wire formats | After H2; per provider |
| U12 | The voice D45 phase-2 plan (a project document outside the repository) was not read; the barge-in mapping (§9.5) is based on `voice/talk.ts` and `voice/v2.ts` | Checked before H3-2 starts |
| U13 | RE-D1 is still listed as open in the RE plan (assumed by the briefs); this design uses the same pattern | Owner confirms RE-D1 together with Q3 |
| U14 | The inline budget is approximate (chars/4) until the Rust engine serves `engine.tokens.*` by default | Resolves with RE-08/RE-11 |
| U15 | Whether ACP will gain a steering or queued-prompt primitive | Watched; Q18 revisited if it does |

## 20. Sources

- Third-party analysis "Architektur-Individualität agentischer Coding-Harnesses" (German, 19 pages, 47 references),
  provided by the owner 2026-10-30; numbers treated as in §3.
- SWE-agent: Yang et al., "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering", NeurIPS 2024
  (arXiv 2405.15793, <https://arxiv.org/abs/2405.15793>).
- Harbor study (vendor): <https://strandsagents.com/blog/we-ran-94000-trials-to-measure-the-cost-of-harness-choice/>.
- Composio comparison (vendor): <https://composio.dev/content/pi-vs-opencode>.
- `pi-acp` README and versions: npm registry entry `pi-acp` (0.0.34) and `@earendil-works/pi-coding-agent` (1.4.0),
  read 2026-10-30; repository <https://github.com/svkozak/pi-acp>.
- Crate versions and licences: crates.io API, read 2026-10-30, for every crate named in §12.5.
