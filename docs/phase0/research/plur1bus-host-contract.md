# PLUR1BUS → OpenClaw host-API surface (raw inventory)

**Source of truth:** `/home/claude/refs/openclaw-plur1bus-memory`, git HEAD `89148f9f604a27149094efbc7cd910a7d362a94a` (`89148f9`, 2026-09-21), package `@cyb3rb1ade/plur1bus-memory` 7.15.4, manifest id `memory-lancedb-namespaced`.
All `file:line` references below are relative to that repo root at commit `89148f9`. Every claim was read out of the file cited; nothing is inferred from the README or the CHANGELOG unless marked as such.

**Declared host contract** (`package.json:8-20`): `openclaw.compat.pluginApi ">=2026.8.1"`, `minGatewayVersion "2026.8.1"`, `build.openclawVersion "2026.8.2"`, `build.pluginSdkVersion "2026.8.2"`. Manifest `kind: "memory"` (`openclaw.plugin.json`, top-level), `contracts.tools = [knowledge_update, memory_forget, memory_recall, memory_search, memory_store]`, `contracts.embeddingProviders = [plur1bus-openai, plur1bus-openai-compatible, plur1bus-e5-small]`.

---

## 0. Brief-vs-code hook-name reconciliation (read this first)

| Name in the brief | Present in code? | Evidence |
| --- | --- | --- |
| `before_prompt_build` | **Yes** — 3 registrations | `index.js:12216`, `index.js:12285`, `index.js:13354` |
| `before_agent_reply` | **Yes** — 2 registrations | `index.js:4535` (cron guard), `index.js:10105-10107` (loop with `before_dispatch`) |
| `before_dispatch` | **Yes** — 1 registration, via the same loop | `index.js:10105-10107` |
| `gateway_start` | **Yes** — 5 registrations | `index.js:5300`, `index.js:7047`, `index.js:9585`, `index.js:10332`, plus fallback `index.js:7027` |
| `gateway_stop` | **Yes** — 4 + 1 | `index.js:7028`, `index.js:9586`, `index.js:10333`, `lib/runtime-shutdown.js:308` |
| "session/shutdown hooks" | **Partly.** There is **no** `session_start` / `session_end` hook anywhere. Shutdown is `gateway_stop` + `registerRuntimeLifecycle` + `registerService`. | `lib/runtime-shutdown.js:232-345`, `:383-440` |
| "compaction checkpoint" hook | **No such hook is registered.** `grep` for `compaction`/`preCompact`/`checkpoint` finds no host hook in `index.js`. Compaction is only *read* as `event.compactedAt`/`ctx.compactedAt` inside the recall hook (`index.js:12959`) and drives conversation-reactivation recall. `docs/compatibility-openclaw.md:186` states explicitly: "PLUR1BUS supplies no file-memory flush plan because conversation capture is handled by typed hooks." | `index.js:12959`; `docs/compatibility-openclaw.md:186` |
| `agent_turn_prepare` | **Not present at commit 89148f9.** It is listed in the stale v6 audit (`OPENCLAW_SDK_COMPAT_AUDIT.md:30`, dated 2026-06-02) but `grep -rn agent_turn_prepare index.js lib/` returns nothing. Neo recall routing now rides `before_prompt_build` + `reply_dispatch` instead. | `OPENCLAW_SDK_COMPAT_AUDIT.md:30` (stale) vs. empty grep |

Additional hooks used that the brief did not name: **`agent_end`** (3 registrations), **`reply_dispatch`** (1), **`skill_proposal_changed`** (1).

`OPENCLAW_SDK_COMPAT_AUDIT.md` is dated 2026-06-02 against OpenClaw 2026.5/2026.6 and is **stale for this commit** — e.g. it lists `registerMemoryEmbeddingProvider` (`:39`), whereas the code now uses `registerEmbeddingProvider` (`lib/providers/openclaw-memory-embedding-adapters.js:317`), and `docs/compatibility-openclaw.md:35-36` confirms "The retired memory-specific registrar is not used." Treat `docs/compatibility-openclaw.md` as the current doc and the code as authoritative.

---

## 1. Host hook inventory

| Surface | file:line | Semantics | Timing/budget | Blocking? | Engine or adapter? |
| --- | --- | --- | --- | --- | --- |
| `api.on("before_prompt_build")` — **primary auto-recall + injection** | `index.js:12285-13351` | Receives `(event, ctx)`. Reads `event.prompt`, `event.messages`, `event.runner`/`event.provider`, `event.sessionKey/sessionId/runId`, `event.compactedAt`; `ctx.agentId`, `ctx.workspaceDir`, `ctx.workspaceKey`, `ctx.sessionKey`, `ctx.sessionId`, `ctx.runId`, `ctx.messageProvider`, `ctx.chatId`. **Returns `{ prependContext: string }`** or `undefined`. Does not mutate `event`. | Registered with `{ timeoutMs: runtimeScheduler.config.recallTimeoutMs + 5_000 }` (`index.js:13351`). `recallTimeoutMs` default **45 000 ms** (`lib/runtime-scheduler.js:7,40`) → hook budget **50 000 ms**. Internal soft budget `recall.softBudgetMs ?? 35_000` (`index.js:4711`), hard timeout = `recallTimeoutMs`, enforced by `createRecallPhaseTimer` (`index.js:12292-12296`). Scheduler also derives `softBudgetMs = max(1000, min(recallTimeoutMs-2000, recallTimeoutMs*0.5))` (`lib/runtime-scheduler.js:392`). Comment at `index.js:12311-12313` records that the host aborts the hook after 15 s in the observed deployment. | **Yes.** It is awaited before the prompt is built; on timeout it returns a cached recall (`index.js:13337-13342`) or `undefined` (`:13343-13346`). | **Adapter** (registration + `prependContext` contract). The pipeline it calls is engine. |
| `api.on("before_prompt_build")` — **reply-outcome completion** | `index.js:12216-12251` | Registered only when `replyOutcomeEnabled`. Closes the previous turn's pending reply outcome using `event.prompt` as the *user's* reply text. Returns nothing. Writes only classification + log files synchronously; DB work is deferred to `replyOutcomeDynamics.enqueue` (comment `index.js:12223-12226`). | No explicit `timeoutMs`. Guarded by `replyOutcomeMaxAgeMs`, `replyOutcomeMaxMemoryIds`, `replyOutcomeMaxReplyChars`. Logs at `REPLY_OUTCOME_SYNC_LOG_MS`. | **Yes** — handlers run sequentially and this one runs *before* recall (explicit comment `index.js:12223`). This handler previously caused the 15 s recall timeouts. | Adapter wrapper / engine body |
| `api.on("before_prompt_build")` — **maintenance-only fallback** | `index.js:13354-13443` | Registered in the `else` branch when `autoRecall` is off but `neoEnabled \|\| schicht15Enabled \|\| gcEnabled`. Records the Neo hook, purges expired memories, and still returns `{ prependContext: [startNotice, nudge+conflictNudge, timeContext, temporalContinuityContext, reminderNudge].join("\n\n") }` (`index.js:13443`). | No explicit `timeoutMs`. | Yes (awaited) | Adapter |
| `api.on("agent_end")` — **auto-capture** | `index.js:10354-11299` | Receives `(event, ctx)`. Classifies the session as incognito via the host routing export first (`index.js:10363-10375`); fail-closed on any classifier error. Builds `memoryCtx` from `ctx.{agentId,workspaceDir,workspaceKey,workspaceId,userId,senderId,channel,messageProvider,accountId,channelContext.accountId,chatId,sessionKey,sessionId}` (`index.js:10396-10409`). Returns the capture promise so tests can await it. | Registered `{ timeoutMs: 60_000 }` (`index.js:11299`). Work runs inside `runtimeScheduler.enqueueCapture(agentId, {background}, …)` with an `AbortSignal`. | Returns a promise the host awaits up to 60 s; capture itself is queued. | **Adapter** at the boundary, engine inside |
| `api.on("agent_end")` — **reply-outcome recording** | `index.js:11304-11321` | Extracts the last assistant message (`lastMessageText(event.messages, ["assistant"])`) and appends it to the pending outcome. Skips background turns and turns without `ctx.workspaceDir`. Synchronous, returns `undefined`. | No `timeoutMs`. | Yes (sync body) | Adapter wrapper |
| `api.on("agent_end")` — **turn-route cleanup** | `index.js:12278-12283` | Clears the per-run turn-route ticket: `turnRoutes.clearRun(ctx.runId ?? event.runId)`. | none | Yes (trivial) | Adapter |
| `api.on("reply_dispatch")` | `index.js:12259-12276` | Receives `(event, hookCtx)`. Observes the outbound dispatch to mint the **turn-route ticket** later consumed by `resolveHostHookMemoryContext`. Reads `event.sessionKey`, `event.runId`, `event.ctx.{SessionKey,RunId,CommandTurn,CommandSource,CommandBody,Body,BodyForAgent,RawBody,SenderId,ChatId,Provider,Surface,AccountId,OriginatingTo,OriginatingChannel,OriginatingAccountId,isTailDispatch,MessageThreadId}`, and `hookCtx.dispatchKind`. Always returns `undefined`. | Registered with `{ priority: Number.MIN_SAFE_INTEGER, eligibleDispatchKinds: ["agent","acp"] }` (`index.js:12275`). No `timeoutMs`. | Observational only; must run **before** the corresponding `before_prompt_build` or the identity falls back to the unauthenticated base context. | **Adapter — the single hardest piece to port.** This is PLUR1BUS's only channel-identity proof. |
| `api.on("before_dispatch")` and `api.on("before_agent_reply")` — **critical-push quoted reply** | `index.js:10105-10111` (handler `10068-10104`) | One handler registered on both names in a `for` loop: `for (const hookName of ["before_dispatch","before_agent_reply"]) api.on(hookName, answerQuotedCriticalReply)`. Reads `event.body`/`event.content`, `event.replyToBody`, `event.isGroup`, `event.sessionKey`, `event.senderId`, `event.channel`; `context.sessionKey`, `context.channelId`, `context.senderId`, `context.conversationId`, `context.accountId`. **Claiming hook** — returns `{ handled: true, text, reply: { text } }` to short-circuit the agent turn, or `undefined` to fall through. | No `timeoutMs`. Runs `runCriticalCommand` inline (DB read). | **Yes, and it can pre-empt the whole turn.** The comment (`index.js:10061-10065`) notes both hooks are claiming hooks and whichever fires first with a quoted push answers. | Adapter |
| `api.on("before_agent_reply")` — **unsafe direct feature-cron guard** | `index.js:4534-4543` (predicate `guardUnsafeDirectCronTurn`, `index.js:3435-3444`) | Registered **only** when native cron dispatch is unavailable (`!cronDirectDispatchReady`). Claims a turn where `context.trigger === "cron"` and `event.cleanedBody` matches a known PLUR1BUS feature-cron message, returning `{ handled: true, reply: { text: "NO_REPLY" } }`. | none | Yes, claiming | Adapter |
| `api.on("gateway_start")` — **feature-cron bootstrap** | `index.js:7047-7070` (guard condition `index.js:7043-7046`) | Receives `(_event, gatewayContext)`. Ensures the epistemic cutoff, reconciles unsafe direct crons through `gatewayContext.getCron()` (`index.js:3454-3459`), then schedules deferred CLI bootstrap on a `setTimeout` (`unref`'d) at **90 000 ms** when the native path is ready, **0 ms** otherwise. | `{ timeoutMs: cronDirectDispatchReady ? 5_000 : 30_000 }` (`index.js:7069`). | Awaited within that budget; the real work is deferred off-hook. | Adapter |
| `api.on("gateway_start")` — **Neo worker warm-up** | `index.js:5300-5307` | Schedules `neoWorkerRuntime.warmUp()` after `NEO_WORKER_WARMUP_DELAY_MS = 20_000` (`index.js:5296`). Motivation comment: first `agent_end` after restart took 8–18 s without warm-up. | `{ timeoutMs: 5_000 }` (`index.js:5306`) | Non-blocking (timer is `unref`'d) | Adapter |
| `api.on("gateway_start"/"gateway_stop")` — **control-plane health scanner** | `index.js:9585-9586` | `controlHealth.start()` / `.stop()` | `{ timeoutMs: 5_000 }` both | Yes | Adapter |
| `api.on("gateway_start"/"gateway_stop")` — **Neo service** | `index.js:10332-10333` | `startNeoService` / `stopNeoService` (closes the worker thread). Falls back to `api.registerService({ id: "plur1bus-neo-maintenance", start, stop })` when `api.on` is absent (`index.js:10334-10340`). | `{ timeoutMs: 30_000 }` both | Yes | Adapter |
| `api.on("gateway_start"/"gateway_stop")` — **Obsidian bridge fallback** | `index.js:7027-7028` | Used **only** when `api.registerService` is unavailable; preferred path is `api.registerService(bridgeService)` (`index.js:7024-7025`). | `{ timeoutMs: 30_000 }` both | Yes | Adapter |
| `api.on("gateway_stop")` — **runtime resource shutdown** | `lib/runtime-shutdown.js:308` | `shutdownOnce` disposes DB adapter, pools, shared pool, turn routes, metrics flush, LLM result cache, scoped-embedding IPC, embedding provider, reranker, local-model generation, model-preparation coordinator, re-embedding coordinator (`lib/runtime-shutdown.js:243-297`). Idempotent via a memoised promise. | `{ timeoutMs: 30_000 }` | Yes — the host must await it or LanceDB writes can be lost | Adapter (ordering) + engine (the disposals) |
| `api.on("skill_proposal_changed")` | `index.js:5939-5965` | Receives `(event, context)`; reads `event.proposal.id`, `event.action`. Synchronises the Skill Workshop lifecycle with PLUR1BUS's local evidence record. Rethrows on failure. | `{ registrationId: "plur1bus-skill-workshop-lifecycle-v1", timeoutMs: 30_000 }` (`index.js:5961-5963`) | Yes | Adapter |

### What breaks without each hook

- No `before_prompt_build` → **no recall injection at all**: no `<relevant-memories>`, no time context, no reminder nudge, no persona/mood directive, no reactivation. The `memory_recall` tool still works, so the model can pull memory only if it chooses to. This is the single most load-bearing hook.
- No `agent_end` → **no automatic capture**; memory only grows via the explicit `memory_store` tool and the cron fallback script `scripts/auto-capture-lancedb.mjs` (documented in the file header, `index.js:15-18`).
- No `reply_dispatch` → `resolveHostHookMemoryContext` fails at the `ticket` step (`lib/memory-request-context.js:1390-1393`) and every hook-originated request degrades to `safeHookBase` — i.e. **agent-private scope only, no user principal, no shared/workspace pools**. Logged with `reason=ticket`.
- No `before_dispatch`/`before_agent_reply` → critical-push quoted replies and the cron safety guard silently stop working; the turn goes to the model instead.
- No `gateway_start`/`gateway_stop` (and no `registerRuntimeLifecycle`/`registerService`) → `registerGatewayShutdown` returns `false` (`lib/runtime-shutdown.js:238`) and no cleanup runs; the Neo worker, local models and the scoped embedding socket leak across reloads.
- No `skill_proposal_changed` → mined skill proposals and their local evidence records drift out of sync.

---

## 2. Prompt-injection points

All injection flows through **one return value**: `{ prependContext: string }` from `before_prompt_build`. There is **no** system-prompt mutation API in use for the dynamic part, so the system prompt is **not** rewritten per turn by PLUR1BUS — the dynamic material is prepended to the turn, which is cache-friendlier than a system-prompt rewrite. The only *stable* system-prompt contribution is `registerMemoryPromptSupplement` (static strings, see below).

| Surface | file:line | Semantics | Timing/budget | Blocking? | Engine or adapter? |
| --- | --- | --- | --- | --- | --- |
| **Assembly point / global cap** | `index.js:13315-13325` | `return { prependContext: applyGlobalInjectBudget({ blocks: [neo, start, memories, time, temporal, reminder], maxChars: cfg.recall?.globalInjectMaxChars ?? 17_000 }) }`. Blocks `neo`, `start`, `memories` are `droppable: true`; `time`, `temporal`, `reminder` are `droppable: false`. | cap **17 000 chars** default | — | Engine (`lib/inject-budget.js`, 35 lines) with an adapter-shaped return |
| Budget algorithm | `lib/inject-budget.js:9-35` | Drops/truncates the **last** droppable block first until the joined text fits; never touches non-droppable blocks. | — | — | Engine |
| Composite "memories" block | `index.js:13214` | `[personaDirective, moodStyleDirective, reactionDirective, dreamEchoContext, openThreadsContext, contradictionDisclosureContext, memoriesContext, reactivationContext].filter(Boolean).join("\n\n")`, then `+ nudge + conflictNudge + skillProposalNudge` at `index.js:13319`. | — | — | Engine |
| **Recall block** `<relevant-memories>` | built in `lib/relevant-memory-context.js:229`; called at `index.js:13054` | `<relevant-memories untrusted="true" mode="historical-evidence-only">` wrapping `<memory-record …><quoted-evidence>…</quoted-evidence></memory-record>` items (`lib/relevant-memory-context.js:209-211`), preceded by the compact safety preamble. Optional trailing `<memory-semantic-lens>` block (`:236`). | inside the 45 s recall budget | yes | **Engine** |
| Recall safety preamble | `lib/relevant-memory-context.js:27-38` | Full text is a fixed string; compact variant used inline in the block. | — | — | Engine |
| **Temporal context** (`timeContext`) | `index.js:13261` via `formatTimeContext(agentId, wsKey, ctx.workspaceDir, lang)` | Non-droppable block. Built from `lib/session-time.js` (89 lines). `recordActivity` is called *after* the context is formatted (`index.js:13270`). | — | yes | Engine |
| **Temporal continuity** | `index.js:13262-13269` | `formatTemporalContinuityContext(agentId, wsKey, workspaceDir, { enabled, lang, now, previousUserTurnAt })`, gated on `cfg.temporalContext`. Non-droppable. | — | yes | Engine (`lib/temporal-context.js`, 163 lines) |
| **Mood / emotion directive** | `index.js:13098` | `buildMoodStyleDirective(emotionalPool.describe(agentId), …)` — `lib/mood-style-directive.js` (131 lines), fed by `lib/emotional-state.js` (607) / `lib/emotion-engine.js`. Droppable (part of `memories`). | Emotion tier-3 has its own `emotionT3TimeoutMs` (`index.js:4987`) | yes | Engine |
| **Persona directive** | `index.js:13066-13090` | `loadPersonaDirective(ctx.workspaceDir, { maxChars: personaDirectiveMaxChars })` — reads a per-workspace persona file (`lib/persona-voice.js`, 693 lines). | char-capped | yes | Engine, but **workspace-file-bound** (adapter needs a workspace path) |
| **Reaction-nudge directive** | `index.js:13199-13212` | Only when the gateway exposes a react capability (`detectReactionsCapabilityCached()`, `index.js:4544`) or `reactionNudge.enabled === true`. Lazy `import("./lib/reaction-directive.js")`. | — | yes | **Adapter-gated** engine (host capability probe) |
| **Reactivation after pause** | `index.js:12934-12975` | `runConversationReactivationRecall({ prompt, messageText, baseRecallIds, baseRecallTopScore, workspaceDir, neoStore, graphEdges, cfg, agentId, sessionKey, now, logger, compactedAt: event?.compactedAt \|\| ctx?.compactedAt \|\| null, requestContext, getMemoryById, decisionTrace })`. | **Hard `Promise.race` timeout `crrCfg.timeoutMs ?? 50` ms** (`index.js:12967-12969`) — the tightest budget in the plugin. Rejects with `crr_timeout`. | yes, but capped at 50 ms | Engine (`lib/conversation-reactivation-recall.js`, 961 lines) |
| **Compaction signal** | `index.js:12959` | The only place a compaction checkpoint enters PLUR1BUS: `event.compactedAt \|\| ctx.compactedAt`. There is **no** compaction hook and **no** pre-compaction flush plan (`docs/compatibility-openclaw.md:186`). | — | — | Adapter input field |
| **Start notice** (`/plur1bus start`) | `index.js:12425-12427`, `index.js:13380-13382` | `consumePlur1busStartNotice(process.env.OPENCLAW_HOME \|\| join(homedir(), ".openclaw"))` → `<plur1bus-start-notice>…</plur1bus-start-notice>`. Consumed (one-shot) from a file under `OPENCLAW_HOME`. | — | yes | **Adapter** (reads `OPENCLAW_HOME`) |
| **Open threads** | `index.js:13106-13132` | `formatOpenThreadsContext(threads)` (`lib/open-threads.js`). Droppable. | — | yes | Engine |
| **Contradiction disclosure** | `index.js:12927-12931` | `formatContradictionDisclosure(contradictionPairs, { enabled: cdEnabled })` (`lib/contradiction-disclosure.js`). | — | yes | Engine |
| **Dream echo** | `index.js:13142-13193` | Governed by a proactive governor (`evaluateGovernor`/`recordProactiveSend`, `lib/proactive-governor.js`) and a daily file cooldown stamp written to `echoCooldownPath` (`index.js:13191`). | daily budget | yes | Engine + file state |
| **Reminder nudge** | `index.js:13272-13296` | Merges DB-due reminders (`listDueReminders`) with a pending file (`readPendingReminders`), dedupes by id, formats via `formatReminderNudge`, marks presented. Non-droppable. | — | yes | Engine |
| **Knowledge / conflict nudges** | `index.js:13219-13225` | `buildMaintenanceNudges({ workspaceDir, schicht15Enabled, lang, tone, logger })`. | — | yes | Engine |
| **Skill-proposal nudge** | `index.js:13228-13250` | `<skill-proposal-reminder>` emitted at most every 6 days per ACL partition (`lastPresentationAgeMs(dir) > 6*86400000`). | 6-day cadence | yes | Engine |
| **Neo recall context** | `index.js:13301-13313` | `formatNeoRecallContext(deduped.lanes, { idempotencyKey })`, deduped against already-injected LanceDB memories. Droppable. | embedding sub-budget with sentinel `NEO_EMBED_TIMEOUT` (`index.js:5298`) | yes | Engine |
| **Fallback injection on recall failure** | `index.js:13329-13330` | On a thrown recall, still returns `{ prependContext: [neoContext, startNoticeContext].join("\n\n") }` if non-empty. | — | — | Adapter |
| **Static system-prompt supplement** (stable, cache-friendly) | `index.js:7073-7088` | `api.registerMemoryPromptSupplement(() => [...])`. Two variants: without Neo it registers just `buildRecallSafetyPreamble()` (`index.js:7077`); with Neo it registers 4 fixed lines including "Dynamic PLUR1BUS recall is injected once per turn by the configured auto-recall hook; do not duplicate the same recall block." (`index.js:7082-7088`). **Returns constants — no per-turn state, so this part of the system prompt is stable.** | — | no | **Adapter** (registration); the strings are engine constants |
| **Corpus supplement** | `index.js:7090-7110` | `api.registerMemoryCorpusSupplement({ async search(params) … })` — Neo-only. Receives `params.{agentId, ownerId, userId, agentSessionKey, workspaceKey}` and returns records shaped `{ id, provenanceLabel: origin.kind, sourceType: origin.trustLevel, updatedAt }` (`index.js:7150-7156`). This is the KNOWLEDGE.md / Neo integration path into the host's own memory corpus. | — | host-driven | **Adapter** |

**Cache-friendliness summary:** the system prompt itself is stable (only `registerMemoryPromptSupplement` constants). Everything volatile is a per-turn `prependContext` prefix on the user turn, capped at 17 000 chars. A host-neutral engine API therefore needs exactly one call — *"give me the prepend block for this turn"* — returning a string plus the block metadata needed for the drop policy.

---

## 3. Command interception

Two registration surfaces, one handler set. `registerPluginCommand` (`index.js:7172-7178`) wraps `api.registerCommand(spec)` **and** records the spec in a local `pluginCommandHandlers` Map so the same handler is reachable as an operator CLI command:

```js
const registerPluginCommand = (spec) => {
  if (spec && typeof spec.name === "string" && typeof spec.handler === "function") {
    pluginCommandHandlers.set(spec.name.toLowerCase(), spec);
  }
  return api.registerCommand(spec);
};
```

| Surface | file:line | Semantics | Timing/budget | Blocking? | Engine or adapter? |
| --- | --- | --- | --- | --- | --- |
| `api.registerCommand` wrapper | `index.js:7172-7178` | Spec: `{ name, description, acceptsArgs, channels, handler }`. `channels` is consistently `["telegram","discord","slack","mattermost"]`, plus `"cron"` for the `plur1bus_*` family (`index.js:9112`). Handler receives a `commandCtx` and returns `{ text }`. | none | Host short-circuits the agent turn entirely for a matched command | **Adapter** |
| Top-level user commands | `/state` `index.js:9224-9231`; `/enable` `:9232-9238`; `/disable` `:9239-9246`; `/speaker` `:9247+`; `/memory` `:10231-10237`; `/mf` `:10238-10244`; `/forget` `:10245-10251`; `/correct` `:10252-10259`; `/share` + `/teile` `:10260-10267`; `/wiki` `:10268+` | `/state` carries the note *"'/status' is reserved by OpenClaw"* (`index.js:9226`) — a real host-name collision the harness must decide about. | — | yes | Adapter (registration), engine (handlers in `lib/telegram-commands/*`) |
| `/plur1bus …` family | `index.js:9090-9122` | 15 specs in an array, each with `prefixTokens`; all route through `runPlur1busCommand(commandCtx, command.prefixTokens)` except `plur1bus_memory`/`_forget`/`_correct`/`_critical`, which call their own runners (`index.js:9114-9119`). Names: `plur1bus`, `plur1bus_start`, `_temperament`, `_persona`, `_status`, `_doctor`, `_state`, `_enable`, `_disable`, `_memory`, `_forget`, `_correct`, `_critical`, `_dashboards`, `_conflicts`. | arg-length guard `checkArgsLength` | yes | Adapter + engine |
| Action classification (deny-by-default) | `SENSITIVE_READ_ACTIONS` `index.js:7216-7220`; `isSensitiveChatRead` `:7221-7231`; `isDestructiveAction` `:7232-7248`; `knownPlur1busActions` `:7249-7252` | Comment: *"Chat command dispatch is deliberately deny-by-classification: a new action must be added to one of these predicates before it may acquire a store or other memory-bearing dependency."* (`index.js:7213-7215`). | — | — | **Engine** (pure policy tables) |
| Cron-context detection | `index.js:7195-7201` | `isCronCommandContext(commandCtx)` matches `channel === "cron"`, `origin/source/kind === "cron"`, or `sessionKey` matching `/^agent:[^:]+:cron(?::|$)/`. | — | — | Adapter (session-key grammar) |
| Cron memory context | `index.js:7202-7211` | `runtimeIfUsable(api).agent.resolveAgentWorkspaceDir(commandCtx.config, agentId)` then `resolveMemoryRequestContext({agentId, workspaceDir, channel:"cron", accountId:"cron"})`. | — | — | Adapter |
| Operator CLI `plur1bus-command` | `lib/setup/feature-cron-plugin-runtime.js:355-380` | `api.registerCli(({ program }) => program.command("plur1bus-command") … --agent --session --locale <command...>)`. Requires a direct chat session key of the form `agent:<id>:<channel>:<account>:direct:<peer>`. Bridges to Gateway method `plur1bus.command.run`. | — | — | **Adapter** |
| Operator CLI `plur1bus-feature-cron` | `lib/setup/feature-cron-plugin-runtime.js:386-405` | `--agent --feature`; calls Gateway `plur1bus.feature.run` with `scopes: ["operator.write"]` and `FEATURE_CRON_TIMEOUT_MS`. | explicit RPC timeout constant | — | Adapter |
| Reply shaping for cron | `index.js:9079-9081` | `runOperatorCommand` coerces any empty result to `"NO_REPLY"`, preserving the host's cron contract. | — | — | Adapter |

Manifest-declared CLI commands (`openclaw.plugin.json` → `cliCommands`): `plur1bus-command`, `plur1bus-feature-cron`, `plur1bus-obsidian`, `plur1bus-reembedding`, `plur1bus-workspace`.

---

## 4. Tools exposed to the model

Single registration, factory-per-context:

| Surface | file:line | Semantics | Timing/budget | Blocking? | Engine or adapter? |
| --- | --- | --- | --- | --- | --- |
| `api.registerTool(factory, { names })` | `index.js:11328` … `index.js:12167-12169` | Factory receives the tool `ctx`; returns an array filtered by `guardWorkspaceTools(workspaceTools, workspacePolicyGuard.decision(memoryCtx))` (`index.js:12166`). Registration options: `{ names: ["memory_recall","memory_search","memory_store","memory_forget","knowledge_update"] }`. | — | — | **Adapter** |
| `memory_recall` | `index.js:11339-11352` | Params `{ query: string (req), limit: number, full_text: boolean, validAt: string }`. `validAt` is caller-supplied only and never defaulted to "now" (`index.js:11396-11403`). `limit` clamped by `normalizeBoundedRecallInteger(params.limit, maxPromptMemories, 1, 100)`. Also declared as `deterministicRecallToolName` to the host. | soft/hard recall budget as §1 | yes | Engine |
| `memory_search` | `index.js:11492-11502` | — | — | yes | Engine |
| `memory_store` | `index.js:11503+` | Includes an `origin` enum (`MEMORY_ORIGINS`) with the description *"'dm' = direct message (default), 'group' = Telegram group chat, 'cron' = background job, 'internal' = agent-generated"* (`index.js:11512`) — channel semantics leak into the tool schema. | — | yes | Engine + channel vocabulary |
| `memory_forget` | `index.js:11765+` | Gated by `security.allowModelDestructiveMemoryOps` — when false, `blockModelDestructiveTool(name)` returns the text *"…is disabled unless security.allowModelDestructiveMemoryOps=true because model-facing tool calls do not carry a user-bound authorization context."* (`index.js:11332-11337`). | — | yes | Engine |
| `knowledge_update` | `index.js:11908-11911` | Curates pending memories into `memory/KNOWLEDGE.md` under a lock; only available when Schicht 1.5 is enabled. Uses an LLM to integrate and, past 200 lines, to consolidate to ≤150 (`index.js:12095-12117`). Token/timeout resolved by `resolveKnowledgeUpdateTimeoutMs(maxTokens)` (`index.js:12072`, `:12107`). | per-call LLM timeout | yes | Engine + LLM adapter |

Tool return shape is the host's: `{ content: [{ type: "text", text }] }`.

---

## 5. Host LLM access (`runtime.llm.complete`) and other model paths

| Surface | file:line | Semantics | Timing/budget | Blocking? | Engine or adapter? |
| --- | --- | --- | --- | --- | --- |
| `runtimeIfUsable(api)?.llm` handed to the router | `index.js:4602` | `runtimeLlm: runtimeIfUsable(api)?.llm` is passed once into the LLM router construction. | — | — | **Adapter** |
| Capability probe | `index.js:4882`, `index.js:4938` | `typeof runtimeIfUsable(api)?.llm?.complete === "function"` gates whether LLM-dependent features are considered available at all. | — | — | Adapter |
| Actual call site | `lib/llm-router.js:412-450` | `const runtimeLlm = typeof callOptions?.runtimeLlm?.complete === "function" ? callOptions.runtimeLlm : route.runtimeLlm; if (typeof runtimeLlm?.complete !== "function") …; if (route.model) params.model = route.model; const result = await bounded.waitFor(runtimeLlm.complete(params));` | Bounded by `bounded.waitFor` and `route.timeoutMs`. | yes | **Adapter** — this is the entire host-LLM seam, ~40 lines |
| Model selection | `index.js:4575-4585` (`featureDefaultModel`, `createFeatureRoute`) | Features with no own transport and no own model inherit `cfg.llmRouter.defaultModel`. A feature with its own `baseUrl`/`apiKey`/`headers` keeps its own transport and is never given a foreign model. Route kinds in `lib/llm-router.js:311-346` (`DIRECT_OVERRIDE` vs. host route). `docs/compatibility-openclaw.md:184`: PLUR1BUS "consumes the effective OpenClaw runtime model for the target agent/session and does not persist its own sticky chat-model selection." | — | — | Adapter |
| Direct-provider fallback (no host LLM) | `lib/llm-call.js:27-80` | `callLlm(messages, llmCfg)` builds an `openai` client against `llmCfg.baseUrl` (default `https://api.openai.com/v1`), `DEFAULT_LLM_TIMEOUT_MS = 30_000` (`lib/llm-call.js:3`), supports `jsonMode`, `disableThinking`, `signal`, and reads `reasoning_content` when `content` is empty. | 30 s default | yes | Engine (provider-agnostic OpenAI-compatible client) |
| Per-command LLM | `index.js:7253-7256` | `callCommandLlm` wraps `callLlm` and emits `emitCommandRuntimeHook("onLlmCallContext", llmCfg?.callContext)`. | — | — | Adapter shim |
| Result cache | `index.js:4556-4565` | `createLlmResultCache({ enabled, ttlMs, maxEntries, persist, maxBytes: 67_108_864, metrics, baseDbPath, logger })`. | 64 MiB default cap | — | Engine (`lib/llm-result-cache.js`) |

**Without host LLM:** `runtimeIfUsable` returns `undefined` when `api.runtime` is absent or throws on property access (`lib/runtime-shutdown.js:35-49` — it probes `runtime.config` rather than matching `api.registrationMode`). The router then requires a complete direct-provider config; features with neither route are reported as dormant, e.g. `reportDormantFeature(… "light/REM dreaming and episode extraction require merging.enabled and an available LLM route. They will no-op until that route is available.")` (`index.js:5315-5319`).

---

## 6. Memory slot runtime, `classifyWorkspaceMemoryPaths`, MEMORY.md / USER.md

| Surface | file:line | Semantics | Timing/budget | Blocking? | Engine or adapter? |
| --- | --- | --- | --- | --- | --- |
| `api.registerMemoryCapability({...})` | `index.js:4514-4518` | `{ deterministicRecallToolName: "memory_recall", supportsPrivateTranscriptRecall: false, runtime: memoryHostRuntime }`. Guarded by `typeof api.registerMemoryCapability === "function"` (`index.js:4446`); the `else` branch logs and keeps "legacy tool and hook surfaces" active (`index.js:4519-4523`). | — | — | **Adapter** |
| Runtime construction | `index.js:4451-4513` | `createMemoryHostRuntime({ logger, hostConfig, dbPath, provider, embed, cardCount, readCard, recall })` — every dependency is a closure so the runtime can be registered before the pools exist (`lib/setup/memory-host-runtime.js:113-118`). | — | — | Adapter |
| `runtime.getMemorySearchManager({agentId, purpose})` | `lib/setup/memory-host-runtime.js:238-256` | Returns `{ manager, debug: { backend:"builtin", purpose, managerMs } }` or `{ manager: null, error }`. `agentId` must match `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`. | — | host-driven | Adapter |
| `manager.search(query, opts)` | `lib/setup/memory-host-runtime.js:163-182` | `opts.{sources,maxResults,minScore,signal}`. `maxResults` bounded 1..50, default 8 (`:28-29`). **The host's abort signal is accepted but deliberately not propagated** — "The recall pipeline has no cancellation input" (`:170-171`). | — | yes | Adapter |
| `manager.readFile({relPath, from, lines})` | `lib/setup/memory-host-runtime.js:183-201` | Only resolves `plur1bus://<agentId>/<cardId>` paths (`MEMORY_HOST_PATH_SCHEME`, `:23`); nothing from disk. | — | yes | Adapter |
| `manager.status()` | `lib/setup/memory-host-runtime.js:202-219` | `{ backend:"builtin", provider, model?, workspaceDir?, dbPath?, dirty:false, sources:["memory"], files/chunks/sourceCounts? }`. Without it `doctor.memory.status` answers "memory plugin unavailable" (`:4-7`). | — | — | Adapter |
| Embedding probe | `lib/setup/memory-host-runtime.js:137-154` | `PROBE_TIMEOUT_MS = 10_000`, `PROBE_CACHE_MS = 5 * 60_000`, probe text `"PLUR1BUS embedding readiness probe"`. | 10 s / 5 min cache | — | Adapter |
| **Deliberately not frozen** | `lib/setup/memory-host-runtime.js:156-159`, `:236` | *"The host wraps the manager in a Proxy whose `get` returns a bound copy of every function; a frozen … property makes that violate the Proxy invariant."* A host-neutral API must keep the same looseness or drop the Proxy. | — | — | **Adapter constraint worth carrying into the harness contract** |
| `runtime.classifyWorkspaceMemoryPaths(params)` | `lib/setup/memory-host-runtime.js:264-269` → `lib/setup/workspace-memory-provenance.js:68-82` | Host contract: one `{relativePath, originClass}` per input, in input order, never throws per path. | — | host-driven | **Adapter (the whole MEMORY.md/USER.md seam)** |
| Classification rules | `lib/setup/workspace-memory-provenance.js:35-60` | `realpath` both sides; outside the workspace → `untrusted`. `DREAMS.md`/`dreams.md`, `memory/dreaming/**`, `memory/.dreams/**` → `system`. `MEMORY.md`, `memory.md`, `USER.md`, and `memory/**.md` → `agent`. Everything else → `untrusted`. `ELIGIBLE_MEMORY_ORIGIN_CLASSES = ["owner","agent"]` (`:22`). | — | — | Engine rules, adapter shape |
| Why it exists | `lib/setup/workspace-memory-provenance.js:1-17` | *"Without the method the host answers `unsupported`, logs 'excluding automatic memory context: selected memory runtime does not support provenance classification' and drops both files from the automatic context."* **So: PLUR1BUS does not read or write MEMORY.md/USER.md itself — it authorizes the host to inject them.** | — | — | Adapter |
| `runtime.authorizeSearchHits({hits})` | `lib/setup/memory-host-runtime.js:270-272` | Drops every hit with `source === "sessions"` — the enforcement behind `supportsPrivateTranscriptRecall: false`. | — | — | Adapter |
| `runtime.resolveMemoryBackendConfig()` | `lib/setup/memory-host-runtime.js:257-259` | `{ backend: "builtin" }`. | — | — | Adapter |
| Workspace dir resolution | `lib/setup/memory-host-runtime.js:104-111` | Reads `hostConfig().agents.entries[agentId].workspace`, else `agents.defaults.workspace`. **Direct dependency on OpenClaw's config shape.** | — | — | **Adapter** |
| KNOWLEDGE.md (PLUR1BUS-owned, not host-curated) | `index.js:3921` (`KNOWLEDGE_MD_FILE = "memory/KNOWLEDGE.md"`), `:4097`, `:12029` | Written by PLUR1BUS under a lock file with atomic tmp+rename (`index.js:12125-12127`), with YAML frontmatter re-attached (`withFrontmatter`). Read back as the "canonical-first" recall lane. | — | — | Engine |

---

## 7. Gateway methods, CLI, Control UI, config schema

| Surface | file:line | Semantics | Timing/budget | Blocking? | Engine or adapter? |
| --- | --- | --- | --- | --- | --- |
| `plur1bus.control.status` | `lib/setup/control-ui-plugin-runtime.js:10`, registered `:1374-1392` | `{ scope: "operator.read" }`. Params must be exactly `{}` or absent (`validateStatusParams`, `:1360-1365`); responds `{ status: await getProjection({surface:"gateway"}) }`, otherwise error code `plur1bus_control_status_unavailable`. | — | — | Adapter |
| `plur1bus.workspacePolicy.{get,list,set}` | `lib/setup/workspace-policy-plugin-runtime.js:185-187` | get/list `operator.read`, set `operator.write`. Throws at registration if `registerGatewayMethod`/`registerCli` are missing (`:178-183`). | — | — | Adapter |
| `plur1bus.obsidian.{detect,prepare,confirm}` | `lib/setup/obsidian-vault-plugin-runtime.js:192-194` | detect `operator.read`; prepare/confirm `operator.write`. | — | — | Adapter |
| `plur1bus.reembedding.{plan,apply,resume,rollback,status,switch}` | `lib/setup/reembedding-plugin-runtime.js:217-252` | Registered in a loop over an `handlers` map; skipped entirely if `registerGatewayMethod`/`registerCli` are unavailable (`:217`). | — | — | Adapter |
| `plur1bus.feature.run`, `plur1bus.command.run` | `lib/setup/feature-cron-plugin-runtime.js:339-354` | `{ scope: "operator.write" }`; handler built from `runFeatureCommand`/`runOperatorCommand` with `resolveWorkspaceDir: (cfg, agentId) => runtimeIfUsable(api)?.agent?.resolveAgentWorkspaceDir?.(cfg, agentId)`. | `FEATURE_CRON_TIMEOUT_MS` on the CLI side | — | Adapter |
| `api.registerHttpRoute` | `lib/setup/control-ui-plugin-runtime.js:1403-1408` | `{ path: "/plugins/memory-lancedb-namespaced/control", auth: "gateway", match: "exact", handler }` (`CONTROL_UI_PATH` at `:13`). | — | — | **UI adapter** |
| **Control-UI descriptor (the tab)** | `lib/setup/control-ui-plugin-runtime.js:1394-1424` | Resolved from **two** places: `api.registerControlUiDescriptor` **or** `api.session.controls.registerControlUiDescriptor` — comment at `:1391-1393` records that reading only the nested path silently registered no tab on 2026.8.2. Descriptor: `{ surface:"tab", id:"plur1bus", label:"PLUR1BUS", description, path, icon:"database", group:"control", requiredScopes }` where `requiredScopes` is `["operator.read"]` in read-only mode and `["operator.read","operator.write"]` otherwise (`:1417-1423`). Returns `{ tabRegistered, writeMode }`. If either capability is missing it logs and returns `{ tabRegistered:false }` — Gateway status still works. | — | — | **UI adapter** |
| **Control-UI renderer source and design tokens** | `lib/setup/control-ui-plugin-runtime.js:1426` lines total; the HTML/CSS is emitted around `:985-1120` | **The tab inherits *no* tokens from the host at runtime.** Comment at `:987-990`: *"The tab is an iframe with an opaque origin: it cannot read the host's stylesheet and receives no theme message. The Control UI tokens are copied here under their own names, dark first like the host, light on the OS setting."* The copied tokens (`:991-1012`): `--bg #0e1015`, `--panel`, `--panel-strong #191c24`, `--card #161920`, `--bg-elevated`, `--text #bcbcc0`, `--text-strong #f4f4f5`, `--muted #8b8b94`, `--accent #ff5c5c`, `--accent-hover #ff7070`, `--accent-subtle`, `--border #1e2028`, `--border-strong #2e3040`, `--ok #22c55e`, `--warn #f59e0b`, `--danger #f87171`, `--info #60a5fa`, `--radius 10px`, `--radius-sm 6px`, `--radius-full 9999px`, `--shadow-sm`, `--font-body "Instrument Sans"…`, `--font-mono "JetBrains Mono"…`; a `@media (prefers-color-scheme: light)` block (`:1003-1013`) re-declares them (`--bg #faf9f7`, `--accent #bd4531`, …). `docs/compatibility-openclaw.md:306` notes these values are "value-identical" between 2026.8.2 and 2026.9.1, i.e. **this is a hand-maintained copy that drifts silently.** | optional `<meta http-equiv="refresh">` (`:984`) | — | **UI — fully self-contained; a harness port needs only a new token block** |
| CLI registrations | `lib/setup/feature-cron-plugin-runtime.js:355`, `:386`; `lib/setup/workspace-policy-plugin-runtime.js:225`; `lib/setup/obsidian-vault-plugin-runtime.js:196`; `lib/setup/reembedding-plugin-runtime.js:254` | All use the Commander-style `api.registerCli(({ program }) => program.command(...))` shape. | — | — | Adapter |
| Gateway SDK loader | `lib/setup/feature-cron-plugin-runtime.js:217-234` | `loadOpenClawPluginSdkRuntime(subpath)` resolves the **active OpenClaw package manifest** from `process.argv[1]` or `PATH`, asserts `manifest.name === "openclaw"`, then `createRequire(manifestPath).resolve("openclaw/plugin-sdk/<subpath>")`. Allowlist: `gateway-runtime`, `secret-input-runtime`, `memory-host-events` (`:222`). | — | — | **Adapter — a hard host-package dependency, not just an API** |
| Routing SDK | `lib/memory-request-context.js:346`, `:368` | `import("openclaw/plugin-sdk/routing")`, expecting exports `parseAgentSessionKey`, `parseThreadSessionSuffix`, `normalizeOptionalAccountId`, `normalizeMessageChannel` (`:18-23`) plus `isIncognitoSessionKey` (`:339-342`). | — | — | **Adapter** |
| Services | `index.js:7024-7025` (Obsidian bridge), `lib/providers/scoped-embedding-ipc.js:708-714`, `lib/runtime-shutdown.js:332-345` / `:383-400` / `:425-440` (model preparation, local-model ownership, re-embedding recovery), `index.js:10334-10340` (Neo fallback) | `api.registerService({ id, start, stop })`. `registerService` used 11× across the repo. | — | host-driven | Adapter |
| Runtime lifecycle | `lib/runtime-shutdown.js:232-236`, `:300-306` | `api.lifecycle.registerRuntimeLifecycle` preferred, `api.registerRuntimeLifecycle` second, `api.on("gateway_stop")` third. Registered as `{ id: "plur1bus-runtime-resources", description, cleanup }`. | `{ timeoutMs: 30_000 }` on the gateway_stop path | yes | Adapter |
| Config schema | `openclaw.plugin.json` → `configSchema.properties` (56 top-level keys) | `embedding, baseDbPath, namespaces, modelPreparation, reembedding, embeddingBatchSize, language, timezone, replyOutcomeTracking, dreaming, reminders, neo, autoCapture, captureChunking, captureChunkingMode, autoRecall, captureMaxChars, runtime, temporalContext, recallMinScore, autoRecallMinScore, duplicateThreshold, forgetThreshold, summaryMaxWords, reranker, merging, schicht15, llmRouter, skillMiner, gc, recall, recallHedging, semanticLens, controlUi, continuityEngine, conversationReactivationRecall, obsidianBridge, criticalPush, dailyConsolidation, styleDirective, dreamEcho, personaVoice, afterthought, reactionNudge, contradictionDisclosure, featureCronSetup, security, setupProfile, featuresConfirmedAt, morningReview, eveningReview, metaCognition, emotion, memoryDynamics` | — | — | **Engine config, adapter-delivered** |
| `configContracts.secretInputs` | `openclaw.plugin.json` → `configContracts` | 8 declared secret paths: `embedding.apiKey`, `embedding.fallback.apiKey`, `reranker.apiKey`, `merging.apiKey`, `schicht15.apiKey`, `skillMiner.apiKey`, `criticalPush.apiKey`, `emotion.t3.apiKey`, all `expected: "string"`. | — | — | Adapter |
| `uiHints` | `openclaw.plugin.json` → `uiHints` | 17 keys: the 8 secrets (all `sensitive: true, advanced: true`) plus `autoCapture`, `autoRecall`, `skillMiner.enabled`, `featureCronSetup.auto`, `modelPreparation.profile`, `modelPreparation.acceptNonCommercialLicense`, `reembedding.activeGeneration`, `reembedding.fingerprintId`, `reembedding.dimensions`. | — | — | UI adapter |
| Config mutation | `index.js:6158` | `typeof runtimeIfUsable(api)?.config?.mutateConfigFile === "function"` gates the whole re-embedding switch flow. | — | — | Adapter |
| **Session entry form** | — | **No such registration exists at 89148f9.** `grep` for `registerSessionEntry`/`sessionEntryForm`/`entryForm` finds nothing. What exists is a *read* of the host session entry: `runtimeIfUsable(api).agent.session.getSessionEntry({agentId, sessionKey, readConsistency})` (`index.js:12322`, `:9297`, `:9314`) and `resolveSessionEntry: async ({agentId}) => ({available:true, entry: sessionEntryFor(agentId)})` (`index.js:9333`). Workspace is read from `sessionEntry.spawnedCwd \|\| sessionEntry.spawnedWorkspaceDir \|\| sessionEntry.worktree.canonicalWorkspaceDir` (`index.js:9327-9331`). | — | — | Adapter |
| Embedding provider registration | `lib/providers/openclaw-memory-embedding-adapters.js:317-324` | `if (typeof api.registerEmbeddingProvider !== "function") { warn; return; } for (const adapter of adapters) api.registerEmbeddingProvider(adapter);` — **optional**, PLUR1BUS continues with its own provider if absent. | — | — | Adapter |

---

## 8. Identity: today's principal model, exactly

PLUR1BUS has **three** identity resolution paths. They produce the same frozen object shape but with different levels of proof.

| Surface | file:line | Semantics | Timing/budget | Blocking? | Engine or adapter? |
| --- | --- | --- | --- | --- | --- |
| Canonical context builder | `lib/memory-request-context.js:284-320` | `resolveMemoryRequestContext(commandCtx, {requireWorkspace, requireUser, workspaceAliases})`. Inputs read: `agentId` (**required**), `workspaceId`, `workspaceKey`, `workspaceDir`, `userId ?? senderId`, `channel ?? provider`, `accountId ?? account_id`, `chatId`, `chatKind`, `sessionKey`, `sessionId`. Returns a **frozen** object with `{agentId, workspaceId, workspaceIdentity, userId, userPrincipal, channel, accountId, …}`. | — | — | **Engine** (pure, testable, no host import) |
| **User principal formula** | `lib/memory-request-context.js:302-304` | `userPrincipal = userId && channel && accountId ? "user:v1:" + sha256(JSON.stringify([channel, accountId, userId])) : ""`. **All three must be present, or there is no user principal at all** — that is the authorization boundary for the shared/user pools. | — | — | Engine |
| Workspace principal | `lib/memory-request-context.js:80-97`, `:295-298` | Canonical grammar `workspace:v1:<key>` or `workspace-dir:v1:<realpath>` (`:27-28`). `workspaceDir` is `realpathSync`'d (`:105-108`). Physical pool keys are hashed: `workspacePoolKey = "w-" + sha256(...).slice(0,62)` (`:37-39`), `userPoolKey = "u-" + sha256(...).slice(0,62)` (`:42-44`). | — | — | Engine |
| Tool-context resolution | `lib/memory-request-context.js:781-793` | `resolveToolMemoryRequestContext(toolCtx)` maps host tool-ctx field names: `agentId`, `workspaceDir`, `sessionKey`, `requesterSenderId` → userId, `messageChannel` → channel, `agentAccountId` → accountId, `chatId ?? deliveryContext.chatId ?? deliveryContext.to.split(":").at(-1)`, `chatKind`. | — | — | **Adapter** (field-name map) |
| **Hook-context resolution (the hard one)** | `lib/memory-request-context.js:1259-1418` | `resolveHostHookMemoryContext(hookCtx, {getSessionEntry, workspaceAliases, accountTopology, turnRoutes, routingCapability, logger})`. Rejects non-user triggers up front: `["cron","heartbeat","background","manual"].includes(hookCtx.trigger)` → `non_user_trigger` (`:1274-1276`). Then a 6-step chain with named failure reasons: `hook` → `session_entry` → `entry` → `target` → `ticket`. **On any failure it returns `base` (the unauthenticated `safeHookBase`), never throws** (`:1405-1417`). | Measures `sessionEntryMs`, warns at ≥ 1000 ms; comment notes the host read is synchronous SQLite, 10–90 ms observed (`:1332-1342`). | yes | **Adapter** |
| Headless / webchat route | `lib/memory-request-context.js:1291-1315` | If there is no bound transport identity and the session key parses as `agent:<id>:<rest>`, it accepts `runId`+`sessionId` as proof and returns an agent+workspace-only context (no user principal). | — | — | Adapter |
| Bound-transport route | `lib/memory-request-context.js:1317-1404` | Requires **every** one of: `runId`, `sessionId`, `senderId`, `chatId`, matching agent id, thread agreement between hook and session entry, a host session entry whose `sessionId` matches, provider agreement (`base.channel` vs entry provider), account agreement, and a delivery-target peer id equal to `chatId`. | — | yes | Adapter |
| **Turn-route ticket (the proof)** | `lib/memory-request-context.js:1377-1393` | `turnRoutes.claimForPrompt(hookCtx, proofMode, ticket => …)` requires the ticket's `agentId, sessionKey, provider, accountId, chatId, peerKind, threadId` to match and `ticket.senderProof === sha256(senderId)`, plus `runId` when `proofMode === "turn-run"`. `proofMode` ∈ `account-session` / `single-account` / `turn-run` (`:1372-1376`), chosen from the session key's account and the account topology's ambiguity. Tickets are minted by the `reply_dispatch` hook (`index.js:12259-12275`) and cleared on `agent_end` (`index.js:12278-12283`). | — | — | **Adapter — the OpenClaw-specific core of the principal model** |
| Account topology | `lib/memory-request-context.js:804-815` | `buildMemoryAccountTopology(cfg)` walks `cfg.channels[provider].accounts` + `defaultAccount`, always including `"default"`, and marks a provider `ambiguous` when more than one account exists. | — | — | Adapter (reads host config shape) |
| Supported vocabularies | `lib/memory-request-context.js:24-25` | `SUPPORTED_PEER_KINDS = {direct, dm, group, channel}`; `SUPPORTED_ROUTE_PROVIDERS = {telegram, discord, slack, mattermost}`. **Hard-coded channel list.** | — | — | Adapter |
| `agent_context` (cron/subagent) | `index.js:7195-7201`, `lib/memory-request-context.js:1274` | There is **no** `agent_context` object. Cron/sub-agent detection is done by string matching on `context.trigger`, `commandCtx.channel/origin/source/kind`, and a `sessionKey` regex `/^agent:[^:]+:cron(?::|$)/`. Background turns are detected by `isBackgroundTurn(event, ctx)` and `shouldSkipAutoCaptureForInternalTurn` / `shouldSkipAutoRecallForInternalTurn`. | — | — | Adapter |
| Incognito classification | `index.js:10363-10375`; capability at `lib/memory-request-context.js:339-342` | `classifyHostIncognitoSession(sessionKey)` wraps the SDK export `isIncognitoSessionKey`. Fail-closed on missing classifier, failed import, thrown classifier, or non-boolean result (`docs/compatibility-openclaw.md:50-57`). A turn with **no** session key is captured anyway with a one-shot warning (`index.js:10378-10382`). | — | yes | Adapter |

**Summary of the principal model as implemented:** the durable authorization key is the tuple **(canonical `agentId`, canonical workspace principal, `user:v1:sha256([channel, accountId, userId])`)**, with `chatId`/`chatKind` used for ACL and confirmation binding. `gateway_session_key` (`agent:<id>:<channel>:<account>:direct:<peer>` and thread suffixes) is *parsed*, never trusted alone — it must agree with the host's session entry **and** with a `reply_dispatch`-minted ticket. Platform is a bare string from a closed 4-value list. There is no first-class "principal" object from the host: PLUR1BUS reconstructs one from six loosely-typed hook fields plus a session-entry read plus its own ticket ledger. `docs/compatibility-openclaw.md:190`: *"OpenClaw session Owner is responsibility/display metadata, not authorization."*

---

## 9. Every OpenClaw-specific object / import, classified

### `api.*` (usage counts from `grep -rno "api\.[a-zA-Z]*" index.js lib/`)

| Member | Count | Representative site | Class |
| --- | --- | --- | --- |
| `api.logger` | 341 | everywhere | **Adapter** (trivially injectable) |
| `api.on` | 30 | `index.js:12285` etc. | **Adapter** |
| `api.registerGatewayMethod` | 14 | `lib/setup/control-ui-plugin-runtime.js:1374` | Adapter |
| `api.config` | 14 | `index.js:4443` | Adapter |
| `api.registerService` | 11 | `lib/runtime-shutdown.js:339` | Adapter |
| `api.registerCli` | 8 | `lib/setup/feature-cron-plugin-runtime.js:355` | Adapter |
| `api.registrationMode` | 5 | `index.js:4435` | Adapter |
| `api.registerMemoryPromptSupplement` | 4 | `index.js:7077` | Adapter |
| `api.session` (→ `.controls.registerControlUiDescriptor`) | 3 | `lib/setup/control-ui-plugin-runtime.js:1396` | UI adapter |
| `api.lifecycle` | 3 | `lib/runtime-shutdown.js:232` | Adapter |
| `api.runtime` (`.config.current`, `.config.mutateConfigFile`, `.llm.complete`, `.agent.resolveAgentWorkspaceDir`, `.agent.session.getSessionEntry`) | 2 direct + 20 via `runtimeIfUsable` | `lib/runtime-shutdown.js:35-49`; call sites listed in §5/§8 | **Adapter — the largest single seam** |
| `api.resolvePath` | 2 | `index.js:4545` (`baseDbPath`), `index.js:5142` (`neoRoot`) | Adapter |
| `api.registerRuntimeLifecycle` | 2 | `lib/runtime-shutdown.js:234` | Adapter |
| `api.registerMemoryCorpusSupplement` | 2 | `index.js:7091` | Adapter |
| `api.registerMemoryCapability` | 2 | `index.js:4446`, `:4514` | Adapter |
| `api.registerHttpRoute` | 2 | `lib/setup/control-ui-plugin-runtime.js:1403` | UI adapter |
| `api.registerEmbeddingProvider` | 2 | `lib/providers/openclaw-memory-embedding-adapters.js:317,324` | Adapter (optional) |
| `api.registerControlUiDescriptor` | 2 | `lib/setup/control-ui-plugin-runtime.js:1394-1395` | UI adapter |
| `api.registerCommand` | 2 | `index.js:7176`, `:7179` | Adapter |
| `api.pluginConfig` | 2 | `index.js:4431` | Adapter |
| `api.registerTool` | 1 | `index.js:11328` | Adapter |

(`api.openai` / `api.cohere` do **not** exist — the grep hits were the literal URLs `https://api.openai.com/v1` and `https://api.cohere.com/v2/rerank`, e.g. `index.js:511`, `lib/llm-call.js:77`.)

### `ctx.*` in `index.js` (hook and tool context)

`ctx.workspaceDir` (55), `ctx.agentId` (3), `ctx.workspaceKey`, `ctx.workspaceIdentity`, `ctx.userPrincipal`, `ctx.sessionKey`, `ctx.sessionId`, `ctx.runId`, `ctx.lang`, `ctx.chatType`, `ctx.agentSessionKey` (1 each). Plus `context.agentId` (8), `context.signal` (4), `context.runtimeLlm` (4). All **adapter**: the harness must supply the same names or the plugin must be rewritten to a named context type.

### Module imports from the host

| Import | file:line | Class |
| --- | --- | --- |
| `openclaw/plugin-sdk/routing` (`parseAgentSessionKey`, `parseThreadSessionSuffix`, `normalizeOptionalAccountId`, `normalizeMessageChannel`, `isIncognitoSessionKey`) | `lib/memory-request-context.js:346`, `:368`, `:339` | **Adapter** |
| `openclaw/plugin-sdk/gateway-runtime` | `lib/setup/feature-cron-plugin-runtime.js:232,239` | Adapter |
| `openclaw/plugin-sdk/secret-input-runtime` | allowlisted at `lib/setup/feature-cron-plugin-runtime.js:222` | Adapter |
| `openclaw/plugin-sdk/memory-host-events` | allowlisted at `lib/setup/feature-cron-plugin-runtime.js:222`; comment `:220-221` ("the host's public event log, used by the dream diary bridge") | Adapter |

### Environment variables

`OPENCLAW_HOME` (`index.js:12425`, `:13380`, plus model cache), `OPENCLAW_CONFIG_PATH`, `NODE_TEST_CONTEXT` (`index.js:4524`). All **adapter**.

---

## 10. Engine vs adapter map

Line counts from `wc -l` at commit `89148f9`.

### Pure engine (no host dependency — port as-is)

| Path | Lines | Note |
| --- | --- | --- |
| `lib/` top-level, minus the adapter files listed below | ~**45 000** of 51 728 total | see breakdown |
| `lib/recall-pipeline.js` | 2158 | core retrieval |
| `lib/neo-arch.js` | 3500 | turn journal / graph |
| `lib/memory-graph.js` | 1078 | graph store |
| `lib/db-adapter.js` | 1325 | LanceDB |
| `lib/relevant-memory-context.js` | 434 | `<relevant-memories>` formatter |
| `lib/inject-budget.js` | 35 | global char cap |
| `lib/conversation-reactivation-recall.js` | 961 | reactivation after pause |
| `lib/temporal-context.js` | 163 | |
| `lib/session-time.js` | 89 | |
| `lib/mood-style-directive.js` | 131 | |
| `lib/emotional-state.js` | 607 | + `emotion-engine.js`, `emotion-blends.js`, `emotion-score.js`, `emotion.js` |
| `lib/persona-voice.js` | 693 | reads a workspace file |
| `lib/i18n.js` + `lib/i18n-dictionary.js` | 181 + 1896 | |
| `lib/dreaming/` | 2705 | |
| `lib/jobs/` | 5165 | mostly engine; `jobs/reminder-dispatch.js` touches delivery |
| `lib/obsidian/` | 3406 | vault writer, host-independent |
| `lib/code-index/` | 685 | |
| `lib/reembedding/` | 2239 | engine; its *plugin runtime* is the adapter |
| `lib/model-preparation/` | 570 | engine; its *service registration* is the adapter |
| `lib/memory-request-context.js` (lines 1-1250) | of 1418 | the pure-identity half: `stableIdentityHash`, `workspacePoolKey`, `userPoolKey`, `validatedIdentity`, `resolveMemoryRequestContext`, `normalizeWorkspaceTarget`, `buildMemoryAccountTopology` |

### OpenClaw adapter (must be re-implemented for the harness)

| Path | Lines | What it binds |
| --- | --- | --- |
| `index.js` registration shell — `api.on` ×30, `api.register*` ×~40, spread across `index.js:4431-13443` | of 13 496 | **the plugin entry point is a monolith; the adapter is not separated from the engine here** |
| `lib/setup/memory-host-runtime.js` | 274 | `registerMemoryCapability` runtime |
| `lib/setup/workspace-memory-provenance.js` | 82 | `classifyWorkspaceMemoryPaths` (MEMORY.md/USER.md) |
| `lib/setup/feature-cron-plugin-runtime.js` | 412 | Gateway+CLI, `openclaw/plugin-sdk/gateway-runtime` loader |
| `lib/setup/workspace-policy-plugin-runtime.js` | 256 | 3 gateway methods + CLI |
| `lib/setup/obsidian-vault-plugin-runtime.js` | 253 | 3 gateway methods + CLI |
| `lib/setup/reembedding-plugin-runtime.js` | 284 | 6 gateway methods + CLI |
| `lib/setup/skill-workshop-plugin-runtime.js` | 163 | `skills.proposals.{create,apply}` |
| `lib/setup/feature-cron-native.js` | 99 | |
| `lib/setup/feature-cron-bootstrap.js` | 69 | marker/throttle (mostly pure) |
| `lib/setup/config-contract.js` | 324 | host config-shape contract |
| `lib/runtime-shutdown.js` | 487 | `runtimeIfUsable`, lifecycle/service/gateway_stop registration |
| `lib/memory-request-context.js` lines 1237-1418 | ~180 of 1418 | `sessionEntryDeliveryView`, `resolveHostHookMemoryContext`, `createHostRoutingLoader` |
| `lib/providers/openclaw-memory-embedding-adapters.js` | 326 | `registerEmbeddingProvider` |
| `lib/providers/scoped-embedding-ipc.js` | 720 | `registerService` + Unix socket bound to the activation generation |
| `lib/llm-router.js` lines 405-460 | ~55 of 464 | the only `runtimeLlm.complete` call |
| `lib/workspace-policy-guard.js` | 114 | thin; policy itself (`lib/workspace-policy.js`, 194) is engine |
| `lib/telegram-commands/*` | 2446 | channel-shaped command handlers (engine logic, channel-shaped I/O) |
| **Adapter subtotal (excluding index.js)** | **≈ 6 400** | |

### UI

| Path | Lines | Note |
| --- | --- | --- |
| `lib/setup/control-ui-plugin-runtime.js` | 1426 | HTTP route, descriptor, **and** the whole self-contained HTML/CSS renderer with its hand-copied token block (`:987-1013`) |
| `lib/setup/control-ui-write.js` | 576 | write actions behind `controlUi.writeActions` |
| `lib/setup/control-ui-compaction.js` | 144 | |
| `lib/setup/skill-workshop-dashboard.js` | 55 | |
| `lib/control-plane-projection.js` | 754 | data shaping for the tab (engine-ish, UI-bound) |
| `lib/control-plane-health.js` | 520 | |
| `lib/control-plane-storage.js` | 90 | |
| `lib/dashboard-settings.js` | 355 | |
| `lib/dashboard-operations.js` | 134 | |
| `lib/setup/feature-profiles.js` | 606 | setup-wizard profiles |
| **UI subtotal** | **≈ 4 600** | |

### Scripts (out-of-process, no plugin API)

| Path | Lines | Note |
| --- | --- | --- |
| `scripts/*.mjs` + `scripts/*.sh` | **6 607** | 30 files. Notable host couplings: `scripts/setup-feature-crons.mjs` (also the npm `postinstall`), `scripts/auto-capture-lancedb.mjs` (the documented cron fallback for `agent_end`, `index.js:15-18`), `scripts/repair-installed-plugin.mjs`, `scripts/provider-wizard.mjs`. Everything else is maintenance over the LanceDB store and is host-neutral. |
| `lib/install/agents-patcher.js`, `lib/install/soul-patcher.js` | 181 | writes into the agent workspace at install time |

### Totals

| Bucket | Lines |
| --- | --- |
| `index.js` (mixed shell — the extraction target) | 13 496 |
| `lib/` all | 51 728 (top level) + 685 + 2705 + 181 + 5165 + 570 + 3406 + 4209 + 2239 + 6400 + 2446 = **79 734** |
| `scripts/` | 6 607 |
| `openclaw.plugin.json` | 2 899 |

---

## 11. Notes, gaps and risks for the host-neutral design

- **The adapter is not isolated today.** `index.js` (13 496 lines) contains the registration shell, the recall assembly, the command handlers and much of the engine in one `export default` factory. The first extraction step should be to pull the ~40 `api.*` call sites into a single `HostAdapter` interface; nothing in `lib/` except the files in §10's adapter bucket needs to change.
- **One injection contract.** Everything the model sees per turn is `{ prependContext: string }` plus static `registerMemoryPromptSupplement` strings. A harness `engine.buildTurnPrefix(identity, turn) → { blocks: Block[], cap: number }` covers 100 % of it; `applyGlobalInjectBudget` can stay verbatim.
- **The hardest port is `reply_dispatch` + `getSessionEntry` + the turn-route ticket.** Without an equivalent proof channel, the harness's principal model collapses to agent-private scope (which is what PLUR1BUS already does on ticket failure — a usable degraded mode, see `lib/memory-request-context.js:1405-1417`). A harness that *owns* the transport can supply a principal directly and delete this subsystem.
- **Two timing constants dominate:** the 50 s hook budget (`recallTimeoutMs 45 000 + 5 000`, `index.js:13351`, `lib/runtime-scheduler.js:7`) and the 50 ms reactivation race (`index.js:12967`). Any harness must expose a per-hook deadline and an in-band `AbortSignal`; note that the memory-slot `manager.search` deliberately **drops** the host signal today (`lib/setup/memory-host-runtime.js:170-172`), which is a defect worth fixing in the new API rather than porting.
- **Silent copies that will drift:** the Control-UI design tokens (`lib/setup/control-ui-plugin-runtime.js:991-1013`) and `buildMemoryAccountTopology`'s assumptions about `cfg.channels` shape (`lib/memory-request-context.js:804-815`). Both should become explicit inputs in the host contract.
- **Gap — hook payload types.** The exact field sets of `event` and `ctx` for `before_prompt_build`, `agent_end`, `reply_dispatch`, `before_dispatch` and `before_agent_reply` are only knowable from PLUR1BUS's *reads* (enumerated in §1). No type declaration for them exists in this repo; `docs/compatibility-openclaw.md:305` says the host exposes "42 hook names" but does not list them. Reading `openclaw@2026.8.2`'s plugin-SDK type declarations would close this.
- **Gap — `agent_context`.** The brief names an `agent_context` (cron/subagent) object; no such object exists at this commit. Cron and background turns are inferred from `context.trigger`, channel/origin strings and a session-key regex (§8). A harness should provide a typed turn-origin instead.
- **Stale document warning.** `OPENCLAW_SDK_COMPAT_AUDIT.md` (2026-06-02) contradicts the code at commit 89148f9 on at least three points: `registerMemoryEmbeddingProvider` vs `registerEmbeddingProvider`, `agent_turn_prepare` (gone), and "PLUR1BUS has no UI components" (`:211` — false; there is a full Control-UI tab). Do not cite it as current.
