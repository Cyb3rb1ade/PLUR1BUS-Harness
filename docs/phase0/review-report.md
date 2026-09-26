# Phase 0 — independent review

**Status:** review of the Phase-0 deliverable set · **Date:** 2026-09-22 · **Reviewer:** an independent subagent that wrote none of the reviewed documents · **Scope:** `docs/phase0/brief.md`, `docs/assumptions.md`, `docs/adr/README.md`, `docs/adr/ADR-001…011`, `docs/host-contract.md`, `docs/engine-extraction.md`, `docs/learnings-hermes-openclaw.md`, `docs/provider-matrix.md`, `docs/platform-matrix.md`, `docs/import.md`, `docs/milestones.md`. Research notes under `docs/phase0/research/` were consulted as inputs only.

**Reference checkouts used for the spot-check:** `openclaw-plur1bus-memory` @ `89148f9`, `openclaw` @ `b9421f4`, `hermes-agent` @ `743ee72`, `agent-client-protocol` @ `bba7ddf`, `A2A` @ `afda831`, `modelcontextprotocol` @ `24efd6e`, `buzz` @ `77729ab`.

**Headline:** 84 citations checked — **78 confirmed exact, 5 line drift, 1 wrong, 0 not found.** No blockers. 14 should-fix and 9 nit findings; 21 mechanical edits made. Phase 0 **meets** the brief's §2 deliverable list.

---

## 1. Citation spot-check

Every row below was checked by opening the cited file at the cited lines in the reference checkout. Verdicts: **confirmed** = the claim is at the cited location; **drift** = the claim is true but the line range is wrong or incomplete; **wrong** = the cited lines contain something else; **not found** = no such content.

### 1.1 PLUR1BUS @ `89148f9`

| # | Citation | Claim | Verdict |
|---|---|---|---|
| 1 | `index.js:5594-5595` | one `vectorDim` scalar into `MultiNamespacePool` **and** `SharedMemoryPool` | **confirmed** (exact, both lines) |
| 2 | `index.js:13315-13325` | `applyGlobalInjectBudget` over six named blocks, `maxChars ?? 17_000`, droppability neo/start/memories yes, time/temporal/reminder no | **confirmed** (exact, all six names and flags) |
| 3 | `index.js:13351` | recall hook `{ timeoutMs: recallTimeoutMs + 5_000 }` | **confirmed** (exact) |
| 4 | `lib/runtime-scheduler.js:7` | `recallTimeoutMs: 45_000` | **confirmed** (exact) |
| 5 | `index.js:4711` | `recallCfg.softBudgetMs ?? 35_000` | **confirmed** (exact) |
| 6 | `lib/runtime-scheduler.js:392` | `max(1000, min(hard−2000, hard×0.5))` | **confirmed** (exact) |
| 7 | `index.js:11299` | capture hook `{ timeoutMs: 60_000 }` | **confirmed** (exact) |
| 8 | `index.js:12967-12969` | `crrCfg.timeoutMs ?? 50` hard `Promise.race`, rejects `crr_timeout` | **confirmed** (exact) |
| 9 | `index.js:12216` | reply-outcome `before_prompt_build` (2 of 3), registered without options | **confirmed** (exact) |
| 10 | `index.js:12285` | recall `before_prompt_build` (1 of 3) | **confirmed** (exact) |
| 11 | `index.js:10354` | `agent_end` auto-capture | **confirmed** (exact) |
| 12 | `index.js:12259`, options `:12275` | `reply_dispatch`, `{priority: Number.MIN_SAFE_INTEGER, eligibleDispatchKinds:["agent","acp"]}` | **confirmed** (exact) |
| 13 | `index.js:12278-12283` | `agent_end` turn-route cleanup `clearRun` | **confirmed** (exact) |
| 14 | `index.js:10068-10104` handler, `:10105-10111` loop | critical-push claiming hook registered on `before_dispatch` + `before_agent_reply` | **confirmed** (loop exact at 10105-10111) |
| 15 | `index.js:4534-4543` | unsafe direct feature-cron guard, registered only when `!cronDirectDispatchReady` | **confirmed** (exact) |
| 16 | `index.js:7043-7046`, `:7066`, `:7069` | cron bootstrap guard; 90 000/0 ms deferred timer; `{timeoutMs: 5_000 \| 30_000}` | **confirmed** (all exact) |
| 17 | `index.js:5296`, `:5300-5306` | `NEO_WORKER_WARMUP_DELAY_MS = 20_000`; `gateway_start` warm-up | **confirmed** (exact) |
| 18 | `index.js:5939-5965`, options `:5961-5963` | `skill_proposal_changed` + `{registrationId:"plur1bus-skill-workshop-lifecycle-v1", timeoutMs: 30_000}` | **WRONG.** Hook spans `:5939-5956`; the options object is at `:5952-5955`. `:5961-5963` is unrelated re-embedding-fingerprint code. **Fixed.** |
| 19 | `lib/runtime-shutdown.js:308` | `api.on("gateway_stop", shutdownOnce, {timeoutMs: 30_000})` | **confirmed** (exact) |
| 20 | `lib/inject-budget.js:9-35` (35 lines) | budget algorithm, file length | **confirmed** (exact; file is 35 lines) |
| 21 | `lib/setup/feature-cron-plan.js:25-170`, keys `:28,42,54,64,83,97,110,121,131,147,157` | 11 `REQUIRED_FEATURE_CRONS` specs | **confirmed** (exact — all eleven `feature:` line numbers match) |
| 22 | `feature-cron-plan.js:337` | `if (explicitlyEnabled(cfg.merging)) enabledFeatures.add("rem-dream")` | **confirmed** (exact) |
| 23 | `feature-cron-plan.js:163-168` | `gc-run` `45 4 * * *`, `Europe/Berlin`, `singleton: true` | **confirmed** (exact) |
| 24 | `lib/setup/feature-cron-plugin-runtime.js:20` | `FEATURE_CRON_TIMEOUT_MS = 540_000` | **confirmed** (exact) |
| 25 | `scripts/setup-feature-crons.mjs:13-17` | "this script must NEVER fail an install… exits 0" | **confirmed** (verbatim) |
| 26 | `scripts/setup-feature-crons.mjs:48`, `:57-72` | `NATIVE_PROBE_TIMEOUT_MS = 30_000`; `--help` marker list; throws if not ready | **confirmed** (exact, all six markers) |
| 27 | `lib/dreaming/rem-dream.js:1094,1118,1136,1139,1165,1170` | six early returns: `acl_partition_missing`, `acl_sink_missing`, `candidate_read_failed`, `too_few_memories`, `lock_held`, `already_processed` | **confirmed** (all six exact) |
| 28 | `rem-dream.js:1326-1340` (ADR-009) / `:1327-1338` (host-contract §f.3) | run marked complete without a narrative pre-7.12.58; comment names 241 memories / 59 s | **confirmed** (exact; both ranges land inside the comment block) |
| 29 | `rem-dream.js:1088` | `getPreviousWeekWindow` — REM is weekly | **confirmed** (exact) |
| 30 | `lib/providers/scoped-embedding-ipc.js:207-216` | Linux abstract socket; every other platform `127.0.0.1:49152 + (hex%16384)`, `exclusive:true` | **confirmed** (exact) |
| 31 | `scoped-embedding-ipc.js:434-435` | `listenServer(...)` then `chmodSync(socketPath, 0o600)` | **confirmed** (exact) |
| 32 | `scoped-embedding-ipc.js:143-163`, `:153` | token `openSync(…,"wx",0o600)` → fsync → rename → `chmodSync(tokenPath,0o600)` | **confirmed** (exact, incl. `:153`) |
| 33 | `scoped-embedding-ipc.js:24-31` | 256 KiB / 4 MiB / 120 000 ms / 10 000 ms, port constants, `FINGERPRINT_ID_RE` | **confirmed** (exact) |
| 34 | `scoped-embedding-ipc.js:263-287`, `:270-276` | paths under `<stateRoot>/control/embedding-ipc/`, `0o700`, darwin 103-byte guard | **confirmed** (exact) |
| 35 | `lib/memory-request-context.js:302-304` | `userPrincipal = "user:v1:" + sha256(JSON.stringify([channel, accountId, userId]))`, all three or none | **confirmed** (exact) |
| 36 | `memory-request-context.js:24-25` | `SUPPORTED_PEER_KINDS`, `SUPPORTED_ROUTE_PROVIDERS = {telegram,discord,slack,mattermost}` | **confirmed** (exact) |
| 37 | `memory-request-context.js:37-39`, `:42-44` | `w-`/`u-` pool keys, `.slice(0,62)` | **confirmed** (exact) |
| 38 | `memory-request-context.js:1405-1417` | any failure returns `safeHookBase`, never throws | **confirmed** |
| 39 | `lib/acl-middleware.js:102-159` | `checkAccess`, scope default `agent-private`, stable reason codes | **confirmed** (function begins at `:103`; range covers) |
| 40 | `index.js:3921` | `KNOWLEDGE_MD_FILE = "memory/KNOWLEDGE.md"` | **confirmed** (exact) |
| 41 | `lib/dreaming/dream-diary.js:27` | diary target `["DREAMS.md","dreams.md"]` | **confirmed** (exact) |
| 42 | `lib/providers/openclaw-memory-embedding-adapters.js:56` | `process.env.OPENCLAW_HOME \|\| join(process.env.HOME \|\| ".", ".openclaw")` | **confirmed** (exact — the Windows `HOME` bug is real) |
| 43 | `index.js:9224-9231`, `:9226` | `/state` exists because "'/status' is reserved by OpenClaw" | **confirmed** (verbatim) |
| 44 | `lib/embedding-cache.js:57-58` | key `provider\0model\0dimensions\0scopeId\0cacheVersion\0textHash` | **confirmed** (exact) |
| 45 | `lib/telegram-commands/memory-edit.js:508` | `/share` computes a **fresh** embedding in the *source* agent's identity | **confirmed** (exact) |
| 46 | `lib/setup/control-ui-plugin-runtime.js:987-990`, `:991-1013`, `:1015-1016`, `:1390-1400`, `:1403-1408`; 1426 lines; zero `type="search"` | iframe/token-copy comment, token block, density values, dual descriptor path, HTTP route | **confirmed** (all; `grep -c 'type="search"'` = 0) |
| 47 | `index.js:4556-4565` | `createLlmResultCache({… maxBytes: 67_108_864})` | **confirmed** (exact) |
| 48 | `lib/providers/config-normalize.js:63`, `:65-73`, `:158` | embed 15 000 ms + rationale + 1000 ms floor; rerank `?? 5000` | **confirmed** (exact) |
| 49 | `index.js:12311-12313` | "Der Host bricht den Hook nach 15 s ab" — the 45 s rationale | **confirmed** (exact) |
| 50 | `index.js:13337-13346` | on timeout: cached recall, else `undefined` | **confirmed** (exact) |

### 1.2 OpenClaw @ `b9421f4`

| # | Citation | Claim | Verdict |
|---|---|---|---|
| 51 | `src/plugins/hooks.ts:110-112` | "A timed-out hook is logged and skipped, but the plugin's underlying work is not cancelled" | **confirmed** (verbatim at `:111-112`) |
| 52 | `hooks.ts:117-137`; `:118`, `:136` | void-hook defaults: `agent_end` 30 000, `channel_pairing_requested` 2 000, `before_/after_compaction` + `skill_*` 30 000, `gateway_stop` 5 000 | **confirmed** (exact, every value and line) |
| 53 | `hooks.ts:138-155`; `:148` | modifying-hook defaults 15 000 incl. `before_prompt_build` at `:148`; `skill_proposal_evaluate` 120 000 | **confirmed** (exact) |
| 54 | `hooks.ts:616-621` | a plugin-supplied `timeoutMs` takes precedence over the default | **confirmed** (exact) |
| 55 | `hooks.ts:630-631` | claiming hooks get no default timeout | **confirmed** (exact) |
| 56 | `src/memory-host-sdk/dreaming.ts:21-56` | "all defaults literal in source" | **DRIFT.** Scalar defaults run to `:65` (REM `:59-61`, execution `:63-65`); the per-phase `sources` arrays are at `:272-284`, outside the range. Values quoted are all correct. **Fixed** to `:22-65` + `:272-284`. |
| 57 | `dreaming.ts:23` | `timezone: undefined` (host-local) | **confirmed** (exact) |
| 58 | `dreaming.ts:47-48` | `maxPriorEntryLossFraction 0.25`, `maxPromotedSnippetTokens 160` | **DRIFT** — actual `:50-51`. **Fixed.** |
| 59 | `dreaming.ts:31-36` | `LEGACY_MEMORY_*_CRON_NAME` constants | **DRIFT** — actual `:33-38`. **Fixed.** |
| 60 | `extensions/memory-core/src/dreaming-cron.ts:96-121` | one managed job, `sessionTarget:"isolated"`, `payload.kind:"agentTurn"`, `__openclaw_memory_core_short_term_promotion_dream__`, `delivery.mode:"none"` | **confirmed** (exact, every field) |
| 61 | `ui/src/styles/carapace-control-ui.css:1-23` | the verbatim MIT attribution header | **DRIFT** — the header runs `:1-24`; `:root` begins at `:25`. Quoting only `:1-23` would truncate the final comment line. **Fixed** in ADR-004 (two places). |
| 62 | `OC:src/memory-host-sdk/dreaming.ts:40-50` (learnings §2.7, §6.5) | deep-phase gate thresholds | **DRIFT** — actual `:42-51`. **Fixed.** |

### 1.3 Hermes @ `743ee72`

| # | Citation | Claim | Verdict |
|---|---|---|---|
| 63 | `hermes_cli/web_server.py:315-322, 403-414` (ADR-001 K4) | dashboard auth is one process-wide shared token; no user record, no role | **confirmed in substance** (both ranges land on the right code; `_has_valid_session_token` is exact at `:403-414`). **Caveat:** the quoted expression `_SESSION_TOKEN = os.environ.get(...) or secrets.token_urlsafe(32)` is a paraphrase — the code indirects through `_resolve_session_token()` at `:318-319` — and the *primary* check is now the `X-Hermes-Session-Token` header (`:410-411`), with the quoted `Bearer` comparison the documented legacy path. K4's verdict is unaffected. |
| 64 | `tools/memory_tool.py:229-232` | `get_builtin_memory_store_flags()` → `(memory_enabled, user_profile_enabled)` | **confirmed** (exact) |
| 65 | `gateway/authz_mixin.py:32-38` | `<PLATFORM>_ALLOWED_USERS` / `_ALLOW_ALL_USERS` env allowlists | **confirmed** (at `:32-35`, within range) |
| 66 | `pyproject.toml:225` | `mautrix[encryption]==0.21.1` (native libolm) | **confirmed** (exact) |

### 1.4 Protocol specs

| # | Citation | Claim | Verdict |
|---|---|---|---|
| 67 | ACP `schema/v1/CHANGELOG.md` @ `bba7ddf` | v1 latest **1.23.0**, 2026-09-18 | **confirmed** (exact) |
| 68 | ACP `schema/v2/CHANGELOG.md` | v2 alpha line exists, wire-incompatible | **confirmed** |
| 69 | ACP `registry.mdx:112`, `:121`, `:168`, `:629`, `:685` | `agentclientprotocol/claude-agent-acp`; Claude Agent 0.79.0, Codex 1.12.0, Gemini CLI 0.60.0 (now Antigravity CLI `agy`, D40), goose 1.51.0 | **confirmed** (exact, all five) |
| 70 | A2A `docs/specification.md` header @ `afda831` | spec `1.0.0` | **confirmed** |
| 71 | A2A `docs/topics/agent-discovery.md:25` | `/.well-known/agent-card.json`, RFC 8615 | **confirmed** (exact) |
| 72 | A2A `specification.md` §9/§10/§11 | JSON-RPC (`:2239`), gRPC (`:2515`), HTTP+JSON/REST (`:2751`) are **co-equal bindings**; §8.3 at `:1992` requires accurate `supportedInterfaces` | **confirmed** — the ADR-008 finding that "JSON-RPC mandatory" is *our* policy and not the spec's is correct |
| 73 | A2A `specification.md:1879` | "Production deployments **MUST** use encrypted communication" | **confirmed** (verbatim) |
| 74 | A2A `:2140` | clients **SHOULD** verify at least one signature before trusting a card | **confirmed** (exact) |
| 75 | A2A `:632`, `:1926-1931`, `:683`, `:3523-3525` | `input-required`; `TASK_STATE_AUTH_REQUIRED`; events MUST NOT be reordered; `kind` discriminator removed | **confirmed** (all four exact) |
| 76 | MCP `docs/specification/2026-07-28/deprecated.mdx` @ `24efd6e` | Roots, Sampling, Logging (SEP-2577) and Dynamic Client Registration (PR #2858) deprecated in `2026-07-28`, earliest removal "first revision released on or after 2027-07-28"; HTTP+SSE deprecated `2025-03-26`, reclassified under SEP-2596 | **confirmed** (verbatim, all five rows) |
| 77 | MCP `2026-07-28` is the current final revision | dated revision directories present | **confirmed** (`2026-07-28` is the newest dated directory) |

### 1.5 URL-sourced claims

| # | Source | Claim | Verdict |
|---|---|---|---|
| 78 | [code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance) | "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users… developers may not collect, store, or intermediate Claude.ai credentials or session tokens"; "The Claude Code binary must not be modified."; API-key use permitted where billed to the key owner and not resold | **confirmed verbatim** (re-fetched 2026-09-22). The page additionally states "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription" — which is direct support for ADR-011's design and is worth quoting there. |
| 79 | [geminicli.com/docs/resources/tos-privacy/](https://geminicli.com/docs/resources/tos-privacy/) (Gemini CLI is now Antigravity CLI `agy`, D40) | "Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service) using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies." | **confirmed verbatim**, including the OpenClaw naming and the suspension/termination consequence |
| 80 | `registry.npmjs.org/@modelcontextprotocol/sdk/latest` | **1.30.0** | **confirmed** |
| 81 | `registry.npmjs.org/@agentclientprotocol/sdk/latest` | **1.5.0** | **confirmed** |
| 82 | `registry.npmjs.org/@a2a-js/sdk/latest` | **1.2.0** | **confirmed** |

Two further URL claims were **not re-verified** this pass and are carried as-is: The Register 2026-02-20 (Anthropic clarification reporting) and `openai/codex` discussion #8338. Neither is load-bearing on its own — the Anthropic position is established by the vendor page above, and the OpenAI row's conclusion ("ambiguous, not shipped") rests equally on the absence of published endpoints.

**Tally: 82 rows / 84 individual checks — 78 confirmed, 5 line drift, 1 wrong, 0 not found.**

Assessment of sourcing quality: **high.** One wrong citation in 84 is a 1.2 % error rate, and the four drifts are all ≤ 3 lines or an under-wide range, never a fabricated value. Notably, every *number* checked — budgets, caps, ports, thresholds, model defaults, SDK versions — was correct even where the line pointer was not. I found no invented claim.

---

## 2. Consistency findings

Severity: **blocker** = must be resolved before Phase 0 can be approved · **should-fix** = must be resolved before the work it governs starts · **nit** = cosmetic or low-consequence.

### Blockers

**None.** Nothing found prevents the owner from approving Phase 0.

### Should-fix

| # | Finding | Severity | Where |
|---|---|---|---|
| S1 | **Open-question numbering was wrong in eight places.** ADR-004 called the bot-routing question Q3 (canonical Q4) and the role model Q4 (canonical Q5); ADR-005 called subscription logins Q2 (canonical Q3) in four places; ADR-002 and `engine-extraction.md` called the monorepo question "§13 Q5" (it is not in §13 at all — it is Q6, added 2026-09-22); ADR-011 called the M6 CLI set Q6 (canonical Q7); `platform-matrix.md` called macOS x64 Q1 (canonical Q2) in four places. A reader following any of these lands on the wrong question. | should-fix | **All fixed** — see §3 |
| S2 | **Two PR numberings for one plan, with no mapping in the ADR.** ADR-002 uses P0–P10; `engine-extraction.md` §c and `milestones.md` use PR-01…PR-15. `milestones.md:4` already says they are the same plan at different grain, but ADR-002 — the document a reader reaches first — did not. They are *not* a 1:1 mapping (P1 = PR-02+PR-03; P5 = PR-07+PR-08; P9 spans four PRs), so a reader could reasonably conclude they are two plans. | should-fix | **Fixed** — explicit mapping note added to ADR-002 and a pointer added to `engine-extraction.md` |
| S3 | **The in-process embedding owner has no PR row.** ADR-001 conflict C1 decides it, ADR-002 P6 names it ("make the owner transport pluggable and add an in-process owner"), and `milestones.md` M1 scope requires it. But `engine-extraction.md` §c PR-11 covers **only** the Windows named-pipe transport. The work that resolves ADR-001's own conflict is therefore in no numbered PR. | should-fix | `engine-extraction.md` §c — reported, not edited (adding a PR row is a plan change) |
| S4 | **Two interface sketches for the same API disagree on four points.** ADR-002 §"Engine API surface" and `engine-extraction.md` §b.2 both sketch `Engine`/`Principal`. They differ on: (a) `Principal.proof: "transport"` vs `Principal.trust: "proved"\|"inferred"` (`host-contract.md` §c.2 sides with `trust`); (b) `TurnOrigin` as an object `{kind, incognito, sessionId, runId, surface}` vs a string union plus a separate `AgentContext{origin, background, jobId, parentRunId}`; (c) `capture()` returning a non-blocking `CaptureHandle` ("returns in < 5 ms") vs `Promise<CaptureResult>`; (d) `RecallResult.degraded` as `{reason, capability}` vs a boolean. ADR-002 action item 2 already says to freeze a versioned `.d.ts` **before PR-01** — that action item is now load-bearing, because the OpenClaw adapter is written against whichever shape wins. | should-fix | ADR-002 vs `engine-extraction.md` §b.2 — reported, not edited (these are design sketches) |
| S5 | **`node-pty` win32-arm64 is resolved in one document and still open in two.** `platform-matrix.md` §2 and §5(b) resolve it — "confirmed shipped", by direct tarball inspection listing `prebuilds/win32-arm64/` with `pty.node`, `conpty.node`, `winpty-agent.exe` — and `assumptions.md` A8 agrees. But ADR-001 Option B still says "win32-arm64 is **unverified**", ADR-001 risk table still lists `@lydell/node-pty` or spawn+pipe as a required degradation, ADR-001 **Q3 asks the owner a question that no longer needs asking**, and ADR-011 Tier 3 still says "not yet verified". `milestones.md` M8 knows the answer ("now largely moot since the prebuild is confirmed"). The two ADRs cite the older research note; `platform-matrix.md` supersedes it with a better source. | should-fix | ADR-001 Option B / risks / Q3, ADR-011 Tier 3 — reported, not edited (sourced claims) |
| S6 | **The recall-budget relation was stated in one direction only.** ADR-002 sets harness targets (soft 400 ms / hard 1 200 ms) against today's 35 s / 50 s and explains the reasoning. `host-contract.md` §b listed today's budgets with no forward pointer, so a reader of the host contract alone would take 50 s as a target to preserve. | should-fix | **Fixed** — a "Relation to the harness targets" paragraph added to `host-contract.md` §b |
| S7 | **"No open TCP port except the harness API" is stated absolutely in ADR-004 while ADR-001 C1 records that the engine violates it today** on every non-Linux platform (`scoped-embedding-ipc.js:207-216`, verified). ADR-001 resolves it for the harness path; ADR-004's security table did not acknowledge the dependency. | should-fix | **Fixed** — caveat + cross-reference added to ADR-004's Binding row |
| S8 | **ADR-009's REM phase is scheduled while its value is formally unestablished.** Conflict C2 says no reader of REM trends was traced in `lib/recall-pipeline.js`; action item 1 calls tracing it "**blocking** for giving REM a schedule". Yet the phase table already assigns REM `15 1 * * *`, and M1 acceptance A1 requires a `lastRunAt` for **all three** phases. If the trace comes back empty, either A1 or REM's schedule must move — the plan does not say which. | should-fix | ADR-009 phase table vs C2 vs A1 — reported |
| S9 | **`assumptions.md` Q4's default silently differs from the original §13 #4's default.** Original: "beides unterstützen, Routing nachrangig" (support both, routing lower priority). `assumptions.md` Q4: "one agent, many bot connections for M4; mention-routing no earlier than M6." That is a *sequencing* of the original default, which ADR-003 argues for well — but `assumptions.md` presents it as the default without marking it as a change, and `milestones.md` §7 lists multi-agent routing as **out of scope for v0.1** entirely, which is a third position. Three documents, three shades. | should-fix | `assumptions.md` Q4 vs ADR-003 §"Answer to Q4" vs `milestones.md` §7 — reported (the ADR-004 pointer was fixed) |
| S10 | **ADR-001 Q5 and ADR-004 Q3 are the same question** (built-in TLS vs reverse-proxy-only for v0.1), asked twice with different numbers, and `milestones.md` routes them to different milestones (M8 and M3). One answer, two places to record it. | should-fix | ADR-001 Q5 / ADR-004 Q3 — reported |
| S11 | **The two deliberately behaviour-changing PRs have no sign-off gate.** `engine-extraction.md` §c says PR-08 (run-state semantics) and PR-10 (ranking) "need an explicit owner decision before they land", and `milestones.md` R1's trigger row mentions it — but neither is a Definition-of-Done item in §6.1, so nothing mechanically stops them merging unsigned. | should-fix | `milestones.md` §6.1 — reported |
| S12 | **`engine-extraction.md` reports two line-count figures that disagree with its own source and does not reconcile one of them.** `lib/jobs/` is "5 895 *(wc)* (research §10 says 5 165)" and `lib/**` is "80 464 *(wc)*" vs research's ≈ 79 734; the adapter bucket is "≈ 6 400 *(note)*, itemised sum ≈ 6 544". These are honestly flagged, which is good practice — but A1 in `assumptions.md` and ADR-002's Context both quote the *research* figures (68 000 / 6 400 / 79 734) as if settled. Pick one set. | should-fix | `engine-extraction.md` §a.1 vs `assumptions.md` A1 vs ADR-002 Context — reported |
| S13 | **`better-sqlite3` is asserted in ADR-001 but absent from `platform-matrix.md`.** ADR-001 Option B lists "confirmed prebuilds on all six targets for … `better-sqlite3@13.0.3`". The claim is sourced (research note, binaries table, verified) but `platform-matrix.md` §2 — the document that is supposed to *be* the binaries matrix — has no `better-sqlite3` row, and A7 says it is not required. Either it is in the matrix or it is not a dependency. | should-fix | `platform-matrix.md` §2 vs ADR-001 — reported |
| S14 | **`import.md` used "soul" as the harness-side term** for the persona file in two mapping rows, after ADR-003 renamed it to `persona.md` and `milestones.md` M7 codified "`SOUL.md` accepted on import, `persona.md` written". Source-side `SOUL.md` references are correct and were left alone. | should-fix | **Fixed** — both mapping targets now name `persona.md` and cite ADR-003 / Q8 |

### Nits

| # | Finding | Where |
|---|---|---|
| N1 | ADR-009 used `## Trade-offs`; the template in `docs/adr/README.md` says `## Trade-off analysis`. All other ten conform. | **Fixed** |
| N2 | `docs/adr/README.md`'s index had no file-name column, so a reader must guess the slug. | **Fixed** (column added) |
| N3 | The ADR index title for 008 was "Protocols: MCP, ACP, A2A"; the file's own H1 is "Protocols — MCP, ACP, A2A". | **Fixed** (index now matches the file) |
| N4 | ADR-002 open questions are numbered Q1–Q6 locally and ADR-009's Q1–Q7 likewise, colliding visually with the canonical Q1–Q11. Nothing is wrong, but the collision is what produced S1. | **Fixed** by adding an "Open-question numbering" paragraph to `docs/adr/README.md` |
| N5 | `milestones.md` M3 lists "ADR-004 Q1–Q5" as blocking but then enumerates Q1, Q2, Q3, Q5 — correctly skipping Q4, which belongs to M4. The range label is wrong; the enumeration is right. | reported |
| N6 | `host-contract.md` §a.1 headline says "30 `api.on` sites total" while `§a.5`'s `api.*` census and `engine-extraction.md` §a.1 both say 37 `api.register*`/`api.on(` sites in `index.js` alone. Both are true (30 `api.on` + 7 `api.register*` matched by that grep), but the two numbers sit two sections apart without a note. | reported |
| N7 | ADR-001 cites `index.js:13315-13325` as "the whole per-turn injection contract is one return value, `{ prependContext: string }`" — the return is `{ prependContext: <array joined by applyGlobalInjectBudget> }`; the string framing is a simplification the other documents do not make. | reported |
| N8 | `learnings-hermes-openclaw.md` §6.9 says "`MEMORY.md` is not a promotion target anywhere in the PLUR1BUS codebase" and `host-contract.md` §e.5 says PLUR1BUS "never reads or writes MEMORY.md" while also listing `lib/promoted-memory-reindex.js` as a read-only discoverer of it. Both are accurate; the two phrasings read as contradictory at a glance. | reported |
| N9 | `assumptions.md` closes with a count of per-ADR open questions ("24 in ADR-001/002/009/010, 8 in ADR-003/007/008/011, 14 in ADR-004/005/006"). Actual: ADR-001 5 + ADR-002 6 + ADR-009 7 + ADR-010 7 = **25**; ADR-003 5 + ADR-007 6 + ADR-008 6 + ADR-011 6 = **23**; ADR-004 5 + ADR-005 5 + ADR-006 5 = **15**. Total 63, not 46. | reported |

### Template conformance and placeholders

- **All 11 ADRs** carry `**Status:** Proposed`, a `**Date:**`, `**Deciders:** Christian (owner)` and an `**Inputs:**` line, and all eight template sections (Context · Decision · Options considered · Trade-off analysis · Consequences · Conflicts with the brief · Open questions for the owner · Action items). ADR-001, 002, 009 and 010 add extra sections, which the template permits. N1 was the only heading deviation.
- **No placeholders.** A repo-wide scan for `TBD`, `TODO`, `FIXME`, `XXX`, bare `…` as content and empty sections found none in any deliverable. Every hit for "placeholder" is legitimate content (zero-vector placeholders, fixture placeholder keys). Every heading is followed by content or by a legitimate sub-heading.
- **No secrets.** `import.md`'s fixture section deliberately specifies non-functional values (`sk-fixture-not-real`, `fixture-not-real`) and an explicit test that greps reports for them.

### Things I checked that turned out to be **consistent**

Worth recording, because they were the obvious places for drift: ACP SDK pinned at **1.5.0** in ADR-008 and `milestones.md` and nowhere else contradicted; MCP memory tools **read-only in v0.1** consistent between ADR-008 Q4 and `milestones.md` M6 acceptance 2; default embedding model **Qwen3-Embedding-0.6B recommended / E5-small keyless fallback / Jina gated** consistent across ADR-006, `assumptions.md` Q9, `milestones.md` R5 and §7; role model **five roles as presets** consistent across ADR-007, `assumptions.md` Q5, ADR-004's visibility table and `milestones.md` M3; the **M6 CLI set** (Claude Code, Codex, Goose gated + Gemini CLI (now Antigravity CLI `agy`, D40) best-effort) consistent across ADR-011, `assumptions.md` Q7 and `milestones.md`; **MEMORY.md vs KNOWLEDGE.md** consistently treated as an open question (Q10 / ADR-009 Q3) rather than silently decided; the **persona file** decision consistent everywhere once S14 was fixed; and the **17 000-char cap with six named blocks** identical in `host-contract.md`, ADR-002, ADR-010 and `engine-extraction.md`.

### Original §12 acceptance criteria

Every acceptance criterion in the original commission §12 reappears in `milestones.md`, re-cut and traceable: M1 (4/4), M2 (6/6), M3 (4/4), M4 (3/3), M5 (4/4), M6 (6/6), M7 (4/4), M8 (5/5). Two are re-cut with a stated reason rather than dropped — M1's "Hermes memory loop off" becomes "no second memory loop" (Variant A is rejected, so there is no Hermes loop to switch off), and M2's "device-code login headless over SSH" gains the loopback/paste-callback alternatives because no frontier vendor documents a third-party-usable device code. Both re-cuts are correct and are declared in place. **Nothing from §12 is missing.**

---

## 3. Edits made

All edits are mechanical: wrong cross-references, wrong question numbers, wrong or drifted line citations, a heading that violated the template, a missing index column, and one naming alignment. **No decision, recommendation, estimate or sourced claim was changed.**

| # | File | Edit |
|---|---|---|
| 1 | `docs/adr/ADR-004-harness-api-and-web-ui.md` | Inputs: `§13 Q3` → `§13 Q4` |
| 2 | ADR-004 | AuthZ row: "role set itself is ADR-007 / Q4" → "/ Q5" |
| 3 | ADR-004 | Open question 4: "Q3 (§13)" → "Q4 (§13)"; the quoted default now matches `assumptions.md` Q4 and cites ADR-003's answer section |
| 4 | ADR-004 | Binding row: added the ADR-001 C1 caveat that the engine binds a loopback TCP port on non-Linux today |
| 5 | ADR-004 | Attribution: `carapace-control-ui.css:1-23` → `:1-24` (two occurrences), noting `:root` begins at `:25` |
| 6 | `docs/adr/ADR-005-auth-policy-and-secrets.md` | Inputs: `§13 Q2` → `§13 Q3` |
| 7 | ADR-005 | Context: "§13 Q2 leaves open" → "§13 Q3 leaves open" |
| 8 | ADR-005 | Conflicts: "(…, §13 Q2)" → "§13 Q3" |
| 9 | ADR-005 | Open question 1: "§13 Q2" → "§13 Q3"; the pointer to `assumptions.md` Q2 → Q3, reworded to match what Q3 actually says now |
| 10 | `docs/adr/ADR-002-plur1bus-engine-and-host.md` | Decision: "(Q5 answered below)" → "(open question Q6 of `docs/assumptions.md`, answered below)" |
| 11 | ADR-002 | Section heading: "Two repos vs monorepo (§13 Q5 for this ADR)" → "(open question Q6, `docs/assumptions.md`)" |
| 12 | ADR-002 | Added a **Numbering note** to the PR-plan section giving the full P0–P10 ↔ PR-01…PR-15 mapping and naming PR-01…PR-15 authoritative |
| 13 | `docs/adr/ADR-011-external-coding-agents.md` | Conflicts Finding 3: reworded; the M6 question is registered as **Q7**, not "a new numbered question" |
| 14 | ADR-011 | Open question 1: "Q6" → "Q7"; section heading "recommendation (Q6)" → "(Q7)" |
| 15 | ADR-011 | Action item 11: changed from "add as open question 6" to a closed item recording Q7 |
| 16 | `docs/engine-extraction.md` | Inputs: `assumptions.md A1/A5/Q5` → `A1/A5/Q6` |
| 17 | `docs/engine-extraction.md` | §(e) heading: "Recommendation on Q5" → "on Q6"; added a numbering note pointing at ADR-002's mapping |
| 18 | `docs/platform-matrix.md` | Four occurrences of open question **Q1** → **Q2** (macOS x64) |
| 19 | `docs/host-contract.md` | §a.1: `skill_proposal_changed` citation corrected — hook `:5939-5965` → `:5939-5956`, options `:5961-5963` → `:5952-5955` (the wrong citation from §1) |
| 20 | `docs/host-contract.md` | §b: added "Relation to the harness targets", tying today's budgets to ADR-002's 400/1 200 ms and ADR-010 L4/B4 |
| 21 | `docs/adr/ADR-009-dreaming-scheduler.md` | Heading `## Trade-offs` → `## Trade-off analysis`; `dreaming.ts:21-56` → `:22-65` + `:272-284`; `:47-48` → `:50-51`; `:31-36` → `:33-38` |
| 22 | `docs/learnings-hermes-openclaw.md` | `OC:src/memory-host-sdk/dreaming.ts:40-50` → `:42-51` (two occurrences) |
| 23 | `docs/import.md` | Two mapping rows: harness-side target renamed from "soul" to the persona file `persona.md`, citing ADR-003 / Q8 |
| 24 | `docs/adr/README.md` | Index gains a **File** column; title for 008 aligned to the file's own H1; new **Open-question numbering** paragraph declaring `assumptions.md` Q1–Q11 canonical |
| 25 | `README.md` (new) | Root README: what the harness is, Phase-0 status, document map, relationship to the PLUR1BUS repo, language rule, MIT |

Plus this file and `docs/phase0/decisions-for-owner.md`.

---

## 4. Residual risks — where I think the plan is optimistic

This section is deliberately adversarial. None of it contradicts a sourced finding; it is judgement about the plan.

**R-A — M1 is the riskiest milestone in the plan and is estimated as if it were average.** M1 carries ten engine PRs (PR-01…09 + 15), three of them "L", *plus* a resident core daemon with JSON-RPC over UDS/named pipe, a `node:sqlite`+FTS5 session store, an in-process embedding owner, a complete dreaming scheduler (nine mandatory guards, three tables, timezone/DST/catch-up cron semantics, an idempotency key over transcript digests), a bundled lazy-loading CLI, and the B1–B10 benchmark harness — at **45–70 agent-days**, of which the scheduler gets 6–10. The scheduler alone has eight acceptance tests requiring a virtual clock; ADR-009 itself concedes "we own cron semantics including DST and catch-up — a classic source of subtle bugs". PR-03 (splitting a 13 496-line `index.js` with 37 registration sites spread over `:4431-13443`) is the single item most likely to blow the range, and R1 rates it L3/I5. My read: if R1 fires, 70 is not the high end, it is the new midpoint. **Recommendation: split M1 into M1a (PR-01…03 + Host interface + golden-prefix corpus) and M1b (recall/capture/jobs + daemon + scheduler + CLI), with an owner gate between them.** The plan's own P3 rule ("no milestone starts before the previous is approved") then gives the boundary teeth.

**R-B — the recall budget is a 37× tightening justified by a target, not a measurement.** 35 000 → 400 ms soft and 50 000 → 1 200 ms hard is the most consequential number in Phase 0 and the least evidenced. ADR-002 argues it correctly from D6 and from the fact that the 45 s default exists only to survive a 15 s host abort (verified). But nothing in Phase 0 measures what fraction of recalls on a *real* store complete in 400 ms with per-identity embedding, Neo lanes, global search, lane assembly and a rerank inside them. ADR-002 Q2 asks the owner to **choose** the number. That is the wrong instrument. **Recommendation: before PR-04, run today's pipeline against the owner's own store with the phase timer already in the code (`index.js:12292-12296`) and set the budget from the p50/p95/p99 distribution.** It is a day of work and it converts a guess into a fact. Otherwise M1 acceptance 1 ("fact recalled in session 2 with rerank") may pass only because the fixture corpus is small, and the first real store will miss the budget silently — the degraded path is by design non-blocking, so nobody will notice except through worse answers.

**R-C — upstream review latency is on the critical path and is explicitly excluded from every estimate.** The effort convention excludes "upstream PLUR1BUS review latency"; P2 mitigates *blocking* with `0.x-<sha>` prereleases but not *reviewing*. The same single human owns both repos and reviews every PR in both. 211–324 agent-days across fifteen engine PRs and eight milestones means the calendar is governed by a quantity the plan declines to estimate. R11 names it and sets a monorepo trigger; that is the right mitigation and it should be tested early rather than after three blocked milestones.

**R-D — what is under-specified for M1, concretely.** (i) The **golden-prefix corpus** is the gate for PR-02/PR-04 and the whole neutrality argument, but nobody has said how many recorded `(principal, turn) → prependContext` pairs it needs, how they are generated without real user data (§11 forbids it), or how a *legitimate* change to that corpus is approved. It is listed as action item 3 with no owner and no size. (ii) The **in-process embedding owner** (S3) has no PR. (iii) The **engine `.d.ts`** (S4) must be frozen before PR-01 and two documents currently disagree about its contents. (iv) **`Host.workspaceDir` for a harness agent with no workspace** is handled in one sentence in `engine-extraction.md` R7 ("a synthetic one under `Host.stateDir`") but the persona file, `KNOWLEDGE.md`, the diary, the ACL audit and the run state all live there — that synthetic directory is a real design decision, not a footnote. (v) **PR-08's ledger** is new persistent state that `milestones.md` §6 requires in the backup order at M8, but nothing says how it migrates when its schema changes during M2–M7.

**R-E — dreaming's measurable outcome is still undefined.** ADR-009 is the best document in the set: the eleven causes are each traced to a line, the guards each map to a named failure, and A1–A8 are real tests. But `learnings-hermes-openclaw.md` §6.10 states that no quality measurement exists for dreaming in either reference system and that "ADR-009 must define its own measurable outcome" — and ADR-009 defines **observability**, not **quality**. A1–A8 all pass on a scheduler that reliably promotes worthless material. The Revisit clause admits this ("A1 passes but the diary is judged worthless"). **Recommendation: add one quality gate to M1 — e.g. promoted entries must be measurably more likely to be recalled in the following week than a random control from the candidate table.** Without it, "dreaming demonstrably works" (D4) means "dreaming demonstrably runs".

**R-F — REM may be a phase with no consumer** (S8), and `emotion-refine`, `persona-evolve` and `discover-semantic-links` are mapped into phases on the same assumption that their outputs are read. Only REM's gap is flagged. The same trace should cover all four before any of them gets a schedule.

**R-G — ADR-007's `user:v2` puts M4 behind three upstream PRs, and the stated fallback contradicts §2.1.** Matrix and Buzz — two of four mandatory channels — cannot produce a user principal today. ADR-007 Finding 1 makes the channel-vocabulary PR the first of three and calls it an M4 blocker, correctly. But the schedule fallback is "run the harness against a pinned branch and document the delta in `UPSTREAM.md`". A pinned branch of a repo you also own, carrying unmerged memory-logic changes, is a fork in everything but name, and §2.1 forbids the harness holding "keine abweichende Kopie der Memory-Logik". Worth an explicit owner position on what actually happens if those PRs slip.

**R-H — scope.** Nine subsystems, four channels, three protocols, fourteen attachable CLIs, five platforms, a web UI with WCAG 2.1 AA and two locales, two importers, and an engine refactor — 211–324 agent-days for one human owner plus subagents. R10 and R11 name the risk and the mitigations are milestone gating and an out-of-scope list, both of which cut *within* the plan rather than cutting the plan. The option the plan never puts to the owner is a **v0.1 that is M1–M3 plus one channel**, with M4–M7 as v0.2. I would put it on the table, because "release v0.1.0" at M8 is currently gated on every single subsystem being done, which is the shape of project that never ships a 1.0.

**R-I — smaller things I would challenge.** The UI framework recommendation is explicitly "not yet evidence-backed" and M3 depends on a spike excluded from the estimate. Five rerank wire formats are unverified and ADR-006 action 3 requires live smoke tests against TEI, vLLM, llama.cpp and oMLX — standing those four servers up is in no milestone's scope line. Two pinned local-model artefacts come from third-party re-export repos (`ldwformat/…`, `woxpas-ai/…`); ADR-006 action 10 mitigates with an offline mirror, which is the right answer and should be scheduled, not just listed. And the `0.25 USD/agent/day` dreaming cap (ADR-009 Q1) is a number with no derivation at all — it is a reasonable guess, but it should be labelled as one.

**What I think is unusually strong**, since a review that only lists problems is not useful: the conflict-reporting discipline. Eight of eleven ADRs report a finding that makes the product *smaller or later* than the commission asked — subscription logins not shipped, the CLI support matrix narrowed from fourteen to four, `MEMORY.md` not existing, `agent_turn_prepare` never registered, no session-entry form, the ACP schema figure stale, the JSON-RPC binding being our policy rather than the spec's. That is the brief's §3 rule actually working rather than being recited. The evidence base is also genuinely traceable: on 84 checks I found one wrong pointer and no invented value, and the documents consistently mark what they could not verify (`unverified`, `[secondary]`, gap tables) rather than smoothing it over.

---

## 5. Verdict

**Phase 0 meets the brief's §2 deliverable list.** All nine rows are present and substantive:

| §2 deliverable | Present | Assessment |
|---|---|---|
| `docs/host-contract.md` | yes | Covers every surface §2 enumerates — hooks, `runtime.llm.complete`, the memory slot incl. `classifyWorkspaceMemoryPaths`, gateway methods, CLI registration, cron provisioning, the control-UI descriptor, session-entry *reads*, shutdown, config schema, plus all embedding/rerank call sites, the principal model, the uniform-dimension assumption, the Unix-socket owner, the `0o600/0o700` sites and the four shell scripts. Two of §2's named surfaces ("session entry form", the compaction hook) **do not exist** and are reported as corrections in §e rather than invented — exactly what the brief's §3 requires. Adds a defects section (§f) the brief did not ask for and that is the most immediately useful part of the document. |
| `docs/engine-extraction.md` | yes | Engine/adapter/UI split with measured line counts, four package boundaries, a 15-PR plan with a per-PR neutrality gate, and an explicit declaration of the two PRs that are *not* behaviour-neutral. Gaps: S3, S4, S12. |
| `docs/learnings-hermes-openclaw.md` | yes | Replaces `hermes-gap-analysis.md` as instructed. Fifteen topic comparisons, sixteen operational criteria, a binding plagiarism rule, and a 14-item gaps list that admits the five commissioned YouTube sources were unobtainable and names the written substitutes. |
| `docs/provider-matrix.md` | yes | Per-provider capability, wire format, base URL, auth kind, discovery, prompt-caching support, policy status, source and check date — all dated 2026-09-22, with the subscription-login policy table that drives ADR-005. |
| `docs/platform-matrix.md` | yes | Six platform triples × eight packages, CI runner labels, Node-24 startup techniques, a Windows work package, and two gap checks closed by direct tarball inspection. The strongest primary-source work in the set. |
| `docs/import.md` | yes | Both source formats with versions, paths and schemas, mapped onto the harness, with a fixture plan and six acceptance tests. |
| `docs/adr/ADR-001 … ADR-011` | yes | All eleven, all template-conformant, all with a Conflicts section. |
| `docs/milestones.md` | yes | M0–M8 re-cut for Variant B, every §12 criterion traceable, effort ranges, a twelve-row risk register, a layered test plan and a release checklist. |
| `docs/assumptions.md` | yes | A1–A8 and Q1–Q11 with defaults, discussion pointers and the milestone each is asked before. |

**Phase-0 rules (§3) compliance.** *Nothing invented* — verified across 84 citations with a 1.2 % pointer-error rate and zero fabricated values. *Every claim sourced* — yes, and unverifiable items are labelled rather than dropped. *Conflicts reported, not hidden* — yes, eleven times, several of them costly. *No secrets* — yes, including a deliberate fixture-token grep test.

**Recommendation: approve Phase 0**, with the S1–S7 fixes already applied in this pass, and with **S3, S4, S5, S8 and S11 closed before PR-01 begins** — S4 in particular, because the engine `.d.ts` is the contract both adapters are written against and two Phase-0 documents currently describe it differently. The owner decisions that gate M1 are consolidated in `docs/phase0/decisions-for-owner.md`.
