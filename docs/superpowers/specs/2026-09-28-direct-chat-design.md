# Direct chat: talking to an agent outside projects — design

**Status:** Draft for owner review · **Date:** 2026-09-28 · **Owner:** Christian (Cyb3rb1ade) · **Decision rows:** core spec D92–D93 (`2026-09-24-m1b-2a-core-daemon-cli-design.md` §2) · **Milestones:** additions to M2, M3, M4, M5, D1, D2 (`docs/milestones.md`); canvas gap G8 in desktop spec §13.3 · **Inputs:** ADR-003 (behaviour profiles, precedence, lifecycle), ADR-004 (harness API, pages, visibility), ADR-007 (principal, RBAC, privacy, break-glass), ADR-010 (prompt zones, budgets), ADR-016 (stability); core spec D13, D21–D24, D30, D32, D36, D43–D48, D49; desktop spec §6.3, §6.8, §13 (canvas at version `1790550130-fce1`); `docs/rpc.md` (rpc 1.3.0); `docs/cli.md`; `docs/assumptions.md` A7.

**Owner requirement, 2026-09-28 (translated from German):** "A way to just talk to your agent, apart from any projects."

The owner was not available while this was written. Every open choice has a default the design runs on; the choices are in §9 with a recommendation each. Nothing here is implemented.

## 1. Verified current state

Read 2026-09-28 on `origin/main` @ `d5f5756` and on the canvas.

| # | Fact | Evidence |
|---|---|---|
| F1 | The session store is **`node:sqlite` + FTS5**, part of M1b; it is built in **M1b-2c** (session store, submit/event turn loop, compaction), which runs after 2b and M1b-3. No session schema or `session.*` RPC exists yet. | `milestones.md` §M1 scope "Core daemon"; core spec D1; `assumptions.md` A7; `rpc.md` has no `session.*` method |
| F2 | Chat wire formats (`chat_completions`, `codex_responses`, `anthropic_messages`, streaming, tool calls) arrive in **M2**; M2 acceptance 3 is one tool-call turn per format against fixtures. | `milestones.md` §M2 |
| F3 | D21 already names `/new`, `/sessions`, `/resume`, `/compact` → `session.*` (2c) and fixes **one active session per chat** on single-conversation channels. D30: `/model` overrides the model **for the session**. D32(e): `SessionScope conversation\|thread` is the single session key. | core spec D21, D30, D32 |
| F4 | D43 Talk (voice) is "a perspective item, milestone after M3"; the canvas places `V2Talk` and `V2ComposerStates` (attach, dictate, talk) in M3. | core spec D43; desktop spec §13.2 |
| F5 | M4 channels (Telegram DMs etc.) are chats: `chat.kind: direct\|group\|broadcast` per message (D22); memory is per agent, not per channel (D48); one human across channels only by proof (D24). | core spec D22, D24, D48 |
| F6 | Canvas `V2Session` is card-bound: header "Forge · PLB-140 Dreaming scheduler: REM phase · Session 3 of 5 · scope: conversation · started 01:22 · **open card**". No board shows a session without a card. | canvas `project/V2Session.dc.html` |
| F7 | Canvas `V2Sidebar` groups: *Workspace* (Projects, Agents, Inbox, Memories & Dreams), *Build*, *Control*, a *Projects* list, Settings/Help. **No "Chat" entry.** `V2Search` already offers an action "Ask Bernd about … — Opens a chat with the question already typed", linked to `V2Talk`: the canvas presumes a direct chat that has no screen. | canvas `V2Sidebar`, `V2Search` |
| F8 | ADR-004's page table has no chat page; "Sessions / Logs / Audit" (session list and replay) is visible to Owner, Admin **and Operator**. | ADR-004 §Pages, visibility table |
| F9 | The CLI has no `chat` command (top-level: setup, 1staid, agent, memory, dreams, config, module, admin, daemon, service, core, update, user, model, login, channel, project, import, uninstall). | `docs/cli.md` |
| F10 | Engine capture takes `TurnRecord.incognito: boolean`, "classified by the host, fail-closed"; the core passes `incognito: false` explicitly today; `CallerIdentity` says "a client can never supply trust, origin or incognito". | `rpc.schema.json` `CallerIdentity`; `packages/core/src/rpc/methods.ts`; M1a plan `TurnRecord` |
| F11 | Memory scopes are `agent-private`, `workspace` (a project = one PLUR1BUS workspace + pool) and `user`; `allowedScopes` is **intersection-only**, `tools.deny` union-only across the four behaviour layers; shipped `direct` default: capture `full`, all three scopes. `agent-private` cards are visible to principals holding `manage` on the agent. | ADR-003 §Behaviour profiles; ADR-007 §Privacy |
| F12 | Delete is **archive-first** everywhere; a user may export their own sessions; hard erasure on request leaves only an audit tombstone. | ADR-003 §Lifecycle; ADR-007 §Privacy |
| F13 | The desktop tray and global shortcut exist as shell features: tray in D1, global shortcut and push-to-talk in **D2** (no default binding; X11 only, none on Wayland). | desktop spec §6.3, §6.8 |
| F14 | The next free decision number is **D92** (`D90`, `D91` are the highest in `docs/`). | `grep -rhoE '\bD9[0-9]\b' docs` |

## 2. Concept (D92)

**A direct chat is a session of kind `direct`: one agent, one owning principal, no project, no card.** It uses the 2c session engine unchanged (turn loop, recall, capture, compaction, approvals, slash commands); what is new is a small set of session attributes, list/search/lifecycle operations, and the surfaces that make it a first-class place.

Session kinds after this design: `direct` (this spec), `card` (bound to a D36 card), `project` (M5 project sessions, delegations), `channel` (one per channel chat, D21), `acp` (inbound ACP editor, D25; behaves like `direct` for its principal). **Invariant I1: a session's `kind`, `agentId` and `owner` are immutable.** Everything that looks like moving a chat — promote, handoff, fork — creates a new session or a link; nothing re-scopes existing turns. This keeps capture scopes, prompt caches and RBAC decisions valid for the whole life of a session.

### 2.1 Session attributes added for direct chats

| Attribute | Type | Notes |
|---|---|---|
| `kind` | `"direct"` | immutable (I1) |
| `owner` | harness user id (person-level, D24) | immutable; before M3 the CLI principal (`user:v1:…`), linked to the owner's v2 user at M3 by the ADR-007 link table (union, no rewrite) |
| `title`, `titleSource` | string ≤ 80, `auto\|user` | auto-title (§2.2); a user rename is never overwritten |
| `pinned` | boolean | pinned chats sort first |
| `state` | `active\|archived` | archive-first (§2.4) |
| `memoryMode` | `remember\|incognito` | §3.3; set only through `session.update`, applied by the core |
| `modelOverride` | `ModelRef \| null` | §5.1; `null` = the agent's D30 policy |
| `links` | `[{ kind: card\|project\|session, id, rel: promoted-to\|linked\|continued-as }]` | §2.5 |
| `forkOf` | `{ sessionId, turnId } \| null` | §2.6 |
| `handoffFrom` | `{ sessionId, channel } \| null` | §4.2 |
| `usage` | tokens in/out, cached share, cost, turns | from turn events (ADR-016 §6) |
| `lastTurnAt`, `createdAt` | timestamps | history ordering |

### 2.2 Operations

- **New chat** with an agent the caller may `use` (ADR-007 object right). Creating is lazy: the row is written with the first submitted turn, so an abandoned "New chat" leaves nothing behind.
- **History list** per principal: pinned first, then by `lastTurnAt`, grouped Today / 7 days / 30 days / older; filters by agent, archived, incognito, and (M4) channel DMs (§4.3).
- **Auto-title** after the first assistant reply: one call on the cheap `summarize` model role (D23), ≤ 60 characters, in the chat's language, never including a secret or an attachment name; for an agent pinned to local processing (D30/D45) a local model or, failing that, the first user line truncated. Titles live only in the session store, so they are generated in incognito chats too (they are not memory).
- **Search**: FTS5 over titles and message text of the caller's own sessions (`session.search`), `bm25` ranked, with snippet offsets; the `V2Search` "Tasks & sessions" scope calls the same method, so ⌘K finds chats (F7, B11) — RBAC-filtered by construction, since the query is keyed by `owner`.
- **Pin / unpin, rename.**
- **Archive → delete** (§2.4). **Export** (§2.7). **Promote / link** (§2.5). **Fork** (§2.6).

### 2.3 Idle, end and checkpoints

A direct chat has no natural end. The core writes the engine's `session-end` checkpoint after an idle window (`sessions.direct.idleCheckpointMinutes`, default 30, `x-tier: advanced`) and on archive; a later turn simply continues the same session (the checkpoint is idempotent per turn range). Incognito sessions never checkpoint (§3.3).

### 2.4 Archive-first delete

Following ADR-003's lifecycle: **archive** hides the chat from the list, keeps transcript, FTS rows and attachments, and is reversible (`session.restore`). **Delete** is allowed only from `archived`, needs a confirmation bound to the session id and a nonce, and purges transcript, FTS rows and attachments whose content-addressed refcount (D47; forks share parents' blobs) drops to zero. The delete dialog offers, unchecked by default, **"also forget what the agent remembered from this chat"** → `memory.forget` over memories whose provenance carries this `sessionId` (archive-first in the engine, E1). No automatic purge of archived chats by default (§9 O10). A user erasure request (ADR-007) purges archives and leaves only the audit tombstone.

### 2.5 Promote and link

- **Promote to card** (with D36 tasks): a dialog creates a card in a chosen project board; title from the chat title; description = an editable summary (the prepared D23 summary when one exists, else one `summarize` call); the chat gets `links += { card, rel: promoted-to }`, the card gets a link back. **What is shared is explicit:** *summary only* (default), *selected messages*, or *full transcript* (copied into the project as a card attachment, with a confirmation that project members will see it). The chat itself stays private to its owner (I1): members see a "linked private chat" chip without access. Optional **"Continue on the card"** opens a new `card` session seeded with the same summary (`links += { session, rel: continued-as }`); later turns captured there go to the project's workspace scope, earlier ones stay where they were.
- **Promote to project** (M5): the same dialog with "new project" instead of a board; the project's first card is created as above.
- **Link to an existing card or project**: search dialog, adds the link both ways, copies nothing. While linked, recall in the chat may include that project's workspace pool (§3.2).
- Memories are never re-scoped by promotion; specific memories move with the existing `/share` into the workspace pool (D31).

### 2.6 Fork from a message (cheap, included)

History is append-only (D23), so a fork is a new session with `forkOf { sessionId, turnId }` whose prefix is read by reference from the parent up to `turnId` — no copy. Prepared compaction summaries covering only turns ≤ `turnId` are reused; with the same model the provider prompt cache hits the shared prefix (ADR-010). Forks inherit `memoryMode` and `modelOverride` and may change both. Deleting a parent that has live forks materialises the referenced prefix into each fork first. Effort ≈ 1 ad on top of the store; it lands with the web chat in M3 (`/fork` in the CLI REPL from the same RPC).

### 2.7 Export

`session.export { format: "md" | "json", includeAttachments }`: Markdown for people (turns, tool calls collapsed, attachment names); JSON lossless (schema-versioned, tool calls and results, model per turn, usage, links, `forkOf`), optionally zipped with attachments. Exports pass the ADR-005 redaction filter (action 8 covers exports); never contain secrets or other principals' data. The ADR-007 "export my data" bundle includes all direct chats.

## 3. Memory and privacy (D93)

### 3.1 Setting

A web or API direct chat runs with `Principal.chat = { channel: "web" | "api" | "cli", id: <sessionId>, kind: "direct" }` (D22; the channel vocabulary is open after PR-06, and `CallerIdentity.channel` gains `web`/`api` with M3). It is a private conversation with the human it belongs to, so D22's rule "sensitive memories are recalled only in a private conversation with their owner" admits them here. Behaviour layer: `behaviour.direct` (ADR-003 level 2a), channel-kind layer `web`.

### 3.2 Capture and recall scopes

Direct chats sit **outside projects, so the `workspace` scope has no target**. The per-session effective `allowedScopes` is computed by the same intersection-only merge (ADR-003), with one new innermost, restrict-only input — the session layer (this is the per-chat layer ADR-003 Q2 asks about, restricted to narrowing):

| Principal | Capture goes to | Recall reads |
|---|---|---|
| holds `manage` on the agent (typically its owner) | `agent-private` (knowledge, the agent's experience) + `user` (personal, episodic) — engine classification decides which | knowledge (setting-neutral, full weight) · `agent-private` · the principal's `user` pool (v2 ∪ linked v1) · the workspace pool of a **linked** project only |
| has only `use` (a Member chatting with a shared agent) | **`user` only** | knowledge · the principal's `user` pool · `agent-private` rows classified knowledge · linked project's pool if the principal is a member |

Rationale for the Member row: `agent-private` cards are visible to everyone holding `manage` on the agent (ADR-007), so a Member's personal facts captured there would be readable by the agent's managers. Restricting a non-managing principal to `user` is a narrowing and therefore legal under the monotonic merge. The agent's general knowledge still grows from such chats only through the existing proposal/review queue (`memory.propose`, D31) — never silently.

Unlinked workspace pools are **not** recalled in direct chats by default (the chat is "apart from projects"; §9 O5). D22 proximity ranking applies inside what is read: same session > same channel kind (other direct chats, channel DMs of the same linked person) > the rest.

### 3.3 Incognito ("don't remember")

`memoryMode: incognito` is a per-chat toggle (composer header in the web UI, `/incognito` and `/remember`, CLI `--no-memory`):

- **The core sets `TurnRecord.incognito = true`** for every capture and checkpoint of that session; the client only flips the session attribute through an authorised `session.update`, never the engine flag (keeps the F10 rule). The engine already fails closed on anything but explicit `false`.
- No capture, no `session-end`/`compaction` checkpoints, excluded from dreaming input, D49 skill mining and any job that reads transcripts. Tool side effects still happen (incognito is about memory, not about tools).
- **Recall stays on** (read-only use of what the agent already knows); a stricter *sealed* mode without recall is an owner option (§9 O7).
- The transcript is kept like any chat (history, search, export) and marked; a *temporary* chat that deletes itself is not in v1.
- Switching **remember → incognito** applies from the next turn; earlier captures stay (the UI offers "forget what was remembered from this chat so far"). Switching **incognito → remember** never captures the incognito turns retroactively (a checkpoint only covers turns after the switch), and needs a confirmation.

### 3.4 Multi-user rules (ADR-007)

- A direct chat belongs to exactly one principal. `authorize(principal, session.*, s)` passes only for `s.owner` (person-level, so the same human on any linked identity). Another user — any role — gets **`E_NOT_FOUND`**, not `E_DENIED`, so existence does not leak.
- **Owner/Admin have no transcript access.** Access is break-glass only: mandatory reason, time-box, audit entry, notification to the chat's owner (ADR-007 §Privacy), exactly like `user`-scope memories.
- ADR-004's *Sessions / Logs* page (Operator-visible) shows direct chats as **metadata only**: agent, owner (hashed id, as provenance does), turns, tokens, cost, state, timestamps — **no title** (an auto-title is content). This is an amendment to ADR-004's visibility table (§9 O8).
- API tokens act as their user, scoped by `chat:read` / `chat:write` (narrowing only). Audit: create, archive, delete, export, promote, break-glass, memory-mode changes (event only, no content).
- No sharing of a direct chat with another user in v1; sharing is export, promote (explicit content choice), or `/share` of memories.

## 4. Continuity with channels

### 4.1 Decision: separate threads, shared memory

A Telegram DM with Bernd and a web direct chat with Bernd are **separate sessions** that share the agent's memory; continuity comes from recall, not from a merged transcript. Reasons:

1. **D21 fixes one active session per single-conversation channel chat.** The web keeps many parallel direct chats. Merging would force either web turns into the Telegram chat (messages the user never sent there) or Telegram history that silently lacks turns — the two surfaces would disagree about what "the thread" is.
2. **Setting stamps differ (D22).** Every memory is stamped with channel and chat id; recall ranks by proximity. One merged thread would carry two settings per session and blur the ranking and the sensitivity filter.
3. **Identity proof (D24).** An unlinked Telegram identity is a pseudo-principal. Merging it into a web chat owned by a harness user would bypass the proof requirement; separate sessions keep "linked or not" a property of the principal, never of a thread.
4. **Caching and compaction (ADR-010, D23)** are per session; interleaving surfaces would break the stable-prefix layout.
5. **Shared memory already gives the continuity people notice** (D48: Bernd knows on the web what he learned on Telegram), and both are private settings for the same linked person, so sensitive recall works on both sides.

### 4.2 Handoff "continue in web" (M4)

- From a channel DM: `/web` (and a button where the channel supports it) returns a **single-use deep link** (10 min, bound to the linked person, not a bearer credential — opening it requires a web login as that person; D35 remote reach when the harness is not local). Opening it creates a new `direct` session with `handoffFrom { sessionId, channel }`, seeded with the channel session's prepared summary plus the last k turns (default 6) as a read-only preamble; the channel session stays active.
- Refused for an unlinked channel identity ("link your account first", D24) and in a group (`chat.kind` not `direct`).
- From the web: a channel DM of the same person shown in history (§4.3) offers **Continue in web** with the same seed.
- **Web → channel** is not offered in v1 (it would rotate the channel's single active session, D21); §9 O3.

### 4.3 Channel DMs in the web history (M4)

The history list can show the caller's own `channel` sessions with `chat.kind: direct` (same owner after D24 linking) as **read-only** entries with a channel badge; they are searchable, exportable, and offer *Continue in web*. Groups never appear. §9 O4.

### 4.4 Talk inside a direct chat (D43)

Talk is a **mode of the same session**, entered from the composer's *Talk* button (`V2ComposerStates` state 1) or the desktop push-to-talk shortcut: streaming ASR → the same turn loop → streaming TTS with barge-in. Each spoken user turn lands in the transcript as text with `modality: voice`; agent replies are stored as text; raw audio is not stored unless the user opts in (D44). Incognito, scopes and the model override apply unchanged. A `realtime` speech-to-speech profile (D45) is usable only if it is within the agent's allowed profiles; switching into it is a model switch with the D30/L9 cache warning. Channel voice notes stay in their channel session. Talk lands with D43 (after M3); until then dictation (D44) fills the composer.

## 5. Model, cost, context

### 5.1 Per-chat model override

`modelOverride` pins one `ModelRef` for the session, chosen from the agent's **allowed set** = `runtime.model.primary ∪ fallbacks ∪` the D30 tier list, intersected with the caller's rights and the agent's local-only pin (D30/D45: a local-pinned agent offers only local models). `null` returns to the agent's policy (`auto` routes per session by default, D30). `/model` in any surface sets the same attribute. A switch mid-chat warns that the next turn re-reads the prefix (per-model prefixes are preserved, L9); the model and reason land in the turn event. Outside the allowed set: `E_INVALID_PARAMS reason=model-not-allowed`.

### 5.2 Context and compaction

Unchanged from the session engine: the four zones (tools → system → frozen memory snapshot → conversation) with recall delivered after the last breakpoint (ADR-010 §1); D23 progressive compaction (prepare at 65 %, swap at 88 %) with D33 pruning; `/compact`. Direct-chat specifics only: forks reuse prepared summaries (§2.6); handoff and promotion seeds reuse the prepared summary before paying for a new one; incognito skips the compaction checkpoint but still compacts the context.

### 5.3 Cost

Direct chats count against the agent's and the principal's budgets (ADR-010 §4; checked before every model call, L8); there is no project budget until a chat is continued on a card. Per-chat usage is shown in the context panel and in the history item's detail. Budget refusal is a typed error (`E_DENIED reason=budget`), never a silent truncation.

## 6. Surfaces

### 6.1 Web UI (M3)

- **Sidebar:** a **Chat** entry at the top of the *Workspace* group (above Projects), plus a *Chats* list (pinned + last 5) under it, mirroring the drawn *Projects* list; rail mode shows the entry only. *Agents* → agent detail gets **Chat with <agent>**. `V2Search` "Ask Bernd about …" opens a new direct chat with the question typed (F7).
- **Chat page** uses the §13.7 *Chat* pattern plus a history column: compact < 1024 list only, pushed transcript with 44 px *Back*, context as a sheet; normal: history 280 + transcript + context 320; wide: history 300 + transcript ≤ 820 + context 400. Transcript = the `V2Session` component with the card header replaced by: agent identity, title (editable), model chip, memory-mode switch, ⋯ (pin, rename, fork, export, promote, link, archive).
- **Empty state:** agent identity (IdentityDuo), "Talk to <agent> — this chat belongs to no project", starter prompts from the persona (not from memory, so nothing personal is displayed on a shared screen), the memory-mode switch and model chip visible before the first turn, a link to *My area → what <agent> remembers about me*.
- **Composer:** `V2ComposerStates` verbatim — attach (D47: paste, drop, `+`; stored per session, content-addressed), dictate (D44), talk (D43), send; placeholder "Message <agent>…"; slash commands through the D21 router with the palette drawn in `V2Session`.
- **Landing:** after setup the wizard's last step "first agent" ends in the empty state of a new direct chat; the Chat page is the default route for Members (§9 O2).

### 6.2 Desktop shell

- **Tray:** *New chat* (opens the SPA at `/chat/new` with the default agent) — D1 once M3's chat page exists; deep links `plur1bus://chat/new?agent=<id>` and `plur1bus://chat/<id>` (DS33 scheme), origin-checked like the other deep links.
- **Global shortcut (D2):** a *quick chat* window (compact layout, 480 × 640, always on top optional) with the default agent; no default binding, X11 only, tray item as the Wayland fallback (F13). The push-to-talk shortcut opens the quick chat in Talk.

### 6.3 CLI (M2)

```
plur1bus chat [MESSAGE] [--agent <id>] [--new | --continue | --session <id>]
              [--no-memory] [--model <ref>] [--attach <path>]... [--json] [--stream]
plur1bus chats list|search <q>|show <id>|rename <id> <title>|pin|unpin|archive|restore|delete|export <id> [--format md|json]
```

- No `MESSAGE` and a TTY → **interactive REPL** with token streaming, markdown rendered for the terminal, tool calls as one-line summaries, inline approval prompts (`E_APPROVAL_REQUIRED` → y/n/always-per-session), Ctrl-C cancels the running turn (`session.cancel`, D32(f) bounded-grace), Ctrl-D exits, D21 slash commands plus `/incognito`, `/remember`, `/title`, `/fork [turn]`, `/export`, `/attach <path>`.
- `MESSAGE` given, or stdin not a TTY → **single turn**, prints the reply; `--json` prints one result object `{ sessionId, turnId, reply, toolCalls, model, usage, memory: { mode, captured } }`; `--stream` with `--json` prints NDJSON events (the §6.4 notifications). Exit codes follow the existing CLI error mapping.
- Session choice: default **`--new`**; `--continue` = the caller's last active direct chat with that agent; `--session <id>` explicit. `--agent` defaults to the configured default agent (single agent → that one). `--no-memory` creates the session incognito, or flips an existing one (same rules as §3.3).
- `--model` sets `modelOverride`; `--attach` per D47.
- Principal: `CallerIdentity { channel: "cli", … }` today; a personal API token from M3.

### 6.4 RPC (core, `x-stability: experimental` first; names are 2c's to confirm)

D21 already reserves `session.*`; direct chat uses it rather than a parallel `chat.*` family. Methods (2c owns create/submit/cancel/list/compact; this design adds the attributes and the rest):

| Method | Params → result | Errors (`error.data.error` / `reason`) |
|---|---|---|
| `session.create` | `{ agentId, kind: "direct", memoryMode?, modelOverride?, forkOf?, handoffToken?, idempotencyKey }` → `Session` | `E_AGENT_UNKNOWN`, `E_DENIED` (no `use`), `E_INVALID_PARAMS reason=model-not-allowed`, `E_NOT_FOUND` (fork source not owned), `E_CONFLICT reason=handoff-used\|handoff-expired` |
| `session.submit` | `{ sessionId, message, attachments?, idempotencyKey }` → `{ turnId }` (events carry the rest) | `E_NOT_FOUND`, `E_CONFLICT reason=turn-running\|archived`, `E_NOT_AVAILABLE reason=no-model\|provider-down`, `E_DENIED reason=budget`, `E_APPROVAL_REQUIRED` |
| `session.cancel` | `{ sessionId, turnId }` → `{ cancelled }` | `E_NOT_FOUND` |
| `session.list` | `{ agentId?, kinds?: ["direct", "channel"], state?, pinned?, cursor, limit }` → `{ items: SessionSummary[], next }` | — (always filtered to the caller) |
| `session.get` / `session.history` | `{ sessionId }` / `{ sessionId, beforeTurnId?, limit }` → `Session` / `{ turns, next }` | `E_NOT_FOUND` |
| `session.search` | `{ query, agentId?, includeArchived?, limit }` → `{ hits: [{ sessionId, turnId?, title, snippet, offsets, score }] }` | `E_INVALID_PARAMS reason=fts-syntax` |
| `session.update` | `{ sessionId, title?, pinned?, memoryMode?, modelOverride? }` → `Session` | `E_NOT_FOUND`, `E_INVALID_PARAMS reason=model-not-allowed`, `E_CONFLICT reason=turn-running` (mode change mid-turn) |
| `session.archive` / `session.restore` | `{ sessionId }` → `Session` | `E_NOT_FOUND` |
| `session.delete` | `{ sessionId, confirm: { nonce }, forgetMemories? }` → `{ purged, forgotten }` | `E_CONFLICT reason=not-archived`, `E_INVALID_PARAMS reason=bad-confirmation` |
| `session.export` | `{ sessionId, format, includeAttachments? }` → `{ path \| inline }` | `E_NOT_FOUND` |
| `session.link` / `session.unlink` | `{ sessionId, target: { kind, id } }` → `Session` | `E_NOT_FOUND` (either side not visible) |
| `session.promote` | `{ sessionId, to: { board \| project }, card: { title, description, assignee? }, share: "summary" \| "selected" \| "transcript", selectedTurnIds?, continueOnCard? }` → `{ cardId, continuedSessionId? }` | `E_NOT_AVAILABLE reason=tasks-not-installed`, `E_DENIED` (no project write) |
| `session.handoff` | `{ sessionId }` (channel session) → `{ url, expiresAt }` | `E_DENIED reason=unlinked\|not-direct` |

No new error codes (the closed enum stays; ADR-016 additive rules). Notifications (subscribed via `events.subscribe`, forwarded on SSE `/events`): `turn.started { sessionId, turnId, model, reason }`, `turn.delta { sessionId, turnId, seq, text \| toolCall }`, `turn.approval { sessionId, turnId, request }`, `turn.completed { sessionId, turnId, usage, captured }`, `turn.failed { sessionId, turnId, error }`, `session.changed { sessionId, fields }` (title, pin, state, mode, links). Delivery is filtered by the same `authorize()` as the methods: a subscriber only receives events of sessions it owns.

### 6.5 HTTP API for third parties (M3, personal API tokens)

REST over the same handlers (ADR-004): `POST /api/v1/agents/{agentId}/chats`, `GET /api/v1/chats?agent=&q=&state=&cursor=`, `GET|PATCH /api/v1/chats/{id}`, `GET /api/v1/chats/{id}/messages?before=`, `POST /api/v1/chats/{id}/messages` (JSON reply when `Accept: application/json`; the turn's events as SSE when `Accept: text/event-stream`, resumable with `Last-Event-ID`), `POST /api/v1/chats/{id}/cancel`, `POST …/archive|restore|export|fork`, `DELETE /api/v1/chats/{id}` (archived only, nonce in body). Token scopes `chat:read`, `chat:write`, `chat:delete` (narrow only; effective = role ∩ scopes), `Idempotency-Key` header on POSTs, rate limits per identity and route class (ADR-004). No OpenAI-compatible `/v1/chat/completions` for direct chat in v1 — external hosts that want memory use the D28 memory proxy (§9 O12).

## 7. Milestone placement and effort

| Where | Content | Depends on | Effort (ad) |
|---|---|---|---|
| **M2** (with the first wire format) | direct-session attributes in the 2c store (kind, owner, title, pin, state, memoryMode, modelOverride, links, forkOf, usage; FTS5 over titles), `session.*` additions §6.4 minus promote/handoff, incognito wiring (core-derived `TurnRecord.incognito`), auto-title on `summarize`, export md/json, **CLI `plur1bus chat` REPL + single-turn `--json`/`--stream` + `plur1bus chats`** | 2c (store, turn loop); one M2 wire format | **4–6** |
| **M3** | Chat page (history, transcript, context), empty state, agent picker, incognito state, fork UI, sidebar entry + recents, ⌘K sessions scope, REST + SSE + token scopes, metadata-only Sessions view, break-glass path for transcripts; **first screen built in M3 and default landing** (§9 O2) | M3 API/RBAC; M2 | **6–9** |
| M3 or M5 | promote to card / link (needs D36 `tasks.*`, "after 2c with the M3 GUI"); promote to project with M5 | D36; M5 | **1–2** |
| **M4** | `/web` handoff + deep link, channel DMs read-only in history, *Continue in web* | M4 channels; D24 linking | **1–2** |
| D1 | tray *New chat* + `plur1bus://chat/*` deep links | M3 chat page | ~0.5 (absorbed in D1) |
| D2 | quick-chat window on the global shortcut; PTT into Talk | D2 shortcuts; D43 | 1–2 (not in the total) |
| with D43 | Talk inside a direct chat (modality, transcript, model switch) | D43 | ~1 (not in the total) |

**In the total: +12–19 ad** (M2 +4–6, M3 +6–9, M4 +1–2, promote +1–2). **Why CLI first:** `plur1bus chat --json` is the first end-to-end path through everything M1–M2 builds (principal → session → recall → prompt zones → provider → streaming → tool call → capture → compaction), so it becomes an **M2 acceptance criterion**: M2 acceptance 3's tool-call turn runs through `plur1bus chat` for each wire format, and M1 acceptance 1's two-session recall is repeated with a real model across two direct chats (fixture and live-smoke variants), plus an incognito chat whose fact is **not** recalled in the next one.

**Why the web chat is M3's first screen:** it is the one page every role uses on day one, it exercises the M3 chokepoints that the Memory pages do not (per-principal `authorize()` on writes, SSE streaming, API tokens, the break-glass carve-out), and it fills the Memory area with real content that the next pages then manage. ADR-004's "Memory as the main area" stays true for management; Chat becomes the landing route. Owner call O2.

## 8. Designer brief (canvas additions)

The canvas has only card-bound sessions (F6). Needed boards, light and dark (C2), text ≥ 12 px, targets per C22, each also as an `RspB-*` example:

1. **`V2Chat` — chat home / history** (1440): sidebar with *Chat* active and the *Chats* recents; history column (search field, agent filter chips, *Pinned*, date groups, incognito and handoff badges, archived toggle); an open chat (transcript + context panel with model, memory mode, usage, recalled-this-turn); row context menu (pin, rename, fork, export, promote, link, archive).
2. **`V2ChatEmpty` — empty state**: first-ever chat (no history) and "new chat" within an existing history; agent identity, starter prompts, memory-mode switch, model chip, link to "what <agent> remembers about me".
3. **`V2ChatNew` — agent picker**: popover from *New chat* and `@` in the composer; agents the viewer may `use`, with activity (D10) and last-chatted; keyboard-first; single-agent installs skip it.
4. **`V2ChatIncognito` — incognito state**: header treatment that does not rely on colour alone (icon + "Not remembered"), composer note, the confirmation when switching mid-chat in both directions, the "forget what was remembered so far" offer, the history badge.
5. **`V2ChatPromote` — promote-to-card dialog** (≤ 680): project/board picker, title, editable summary, share choice (*summary only* default / *selected messages* with a turn picker / *full transcript* with the members-will-see warning), assignee, *Continue on the card*; plus the **link-to-existing** variant (card/project search).
6. **Responsive**: `RspB-Chat-960` (history list only), `RspB-Chat-960-detail` (pushed transcript, 44 px *Back*, context as sheet), `RspB-Chat-2560` (history 300 + transcript ≤ 820 + context 400), and the 400 CSS px / 200 % zoom case.
7. Smaller additions: archive view + delete confirmation (with the unchecked "also forget memories"), fork affordance on message hover and the fork banner, handoff arrival banner ("Continued from Telegram · 14:02"), read-only channel DM entry with *Continue in web*, `V2Sidebar` with the *Chat* entry, `V2Search` sessions scope showing chats, `DskB-Tray-*` with *New chat*, the D2 quick-chat window (mac/win/gnome/kde).

## 9. Owner decisions

| # | Question | Recommended default |
|---|---|---|
| O1 | Where does chat live in the web UI? | *Chat* at the top of the sidebar's Workspace group with a recents list, plus *Chat with <agent>* on the agent page. |
| O2 | Is the web chat M3's first screen and the default landing route? | Yes — first built, landing route after setup and for Members; Memory stays the main management area. |
| O3 | Telegram DM vs web chat: one thread or two? | Two threads, shared agent memory, `/web` handoff (M4); no web → channel handoff in v1. |
| O4 | Show the person's own channel DMs in the web history? | Yes, read-only, direct chats only (never groups), with *Continue in web*. |
| O5 | Recall of unlinked project (workspace) pools in a direct chat? | Off; only the workspace of a linked project. |
| O6 | Capture scope when the chatting principal lacks `manage` on the agent? | `user` only; agent knowledge grows via proposals. |
| O7 | Incognito semantics | Capture and all transcript-reading jobs off, recall on, transcript kept, no retroactive capture; no *sealed* (no-recall) or *temporary* (self-deleting) mode in v1. |
| O8 | Admin/Operator visibility of direct chats | Metadata only, no titles; transcripts by break-glass only (amends ADR-004's Sessions row). |
| O9 | Auto-title | After the first reply, `summarize` role, local fallback for local-pinned agents; user renames win. |
| O10 | Automatic purge of archived chats | None by default; an optional `sessions.direct.archiveRetentionDays` (advanced). |
| O11 | CLI shape | `plur1bus chat` (REPL / single turn, default `--new`) and `plur1bus chats` for management. |
| O12 | Third-party API shape | Native REST + SSE under `/api/v1/chats` with `chat:*` scopes; no OpenAI-compatible endpoint for direct chat (D28 memory proxy covers external hosts). |
| O13 | Fork in v1 | Yes (≈ 1 ad, M3; `/fork` in the CLI from the same RPC). |
| O14 | Promotion semantics | Link + optional new card session seeded by summary; the chat stays private; transcript sharing only by explicit choice. |
