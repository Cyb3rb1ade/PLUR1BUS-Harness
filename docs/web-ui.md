# Web UI pages and API usage (`packages/web`)

`@plur1bus/web` is the M3 web UI: the shell of [`ui/web-shell.md`](ui/web-shell.md) plus the pages Chat, Memories & Dreams, Models, Usage & Quota,
Doctor (M3 part 1) and Agents, Settings (general, models, memory, extensions, network, users & roles, secrets, devices), Logs
(log viewer, activity feed, sessions overview) and the first-run wizard (M3 part 2), a command palette (⌘K / Ctrl+K), a typed API
client and mock servers for tests. The remaining nav items are still placeholders. The package stays a static build (`index.html`, `main.js`, lazy page chunks, `styles.css`) under
the strict CSP of ADR-004. Everything it needs beyond the five REST routes of [`api-surface.md`](api-surface.md) (`/rpc`, `/events`)
is not served by `origin/main`; the pages show that as the `unavailable` state, and the follow-ups below list what the backend owes.

`ui/web-shell.md` stays the reference for layout, responsive modes, sign-in and the session API. Parts of it are superseded:
ruling 8 ("Search pill is drawn and disabled") no longer holds, the pill opens the palette (see Palette); the i18n catalogues are no
longer one file `src/i18n.ts` but one file per area (see Runtime building blocks); "pages other than sign-in are placeholders" holds
only for the placeholders listed below. That file is not edited by this change.

## Pages

Hash routes. The landing route is `#/chat`. A page owns its `<h1>`; the shell moves focus there on navigation. "States" are the
`PageState` kinds (`components/page-state.ts`): loading, empty, error, forbidden, unavailable. Lists of nav ids are in `src/nav.ts`,
the page for each id in `src/pages/registry.ts`.

Route names are percent-encoded segments: build them with `routePath("skills", name)` (never a template string), read `Route.sub` (kept
encoded) with `subSegments(sub)`. `.`/`..` segments (also encoded), malformed escapes and paths over 2048 characters are not-found.
A page with unsaved edits calls `registerDirtyGuard(isDirty, message)` (or `registerLeaveGuard`) and calls the disposer on unmount;
`navigate`, links, the sidebar, the palette and the back button then ask first, and a refused hash change puts the address bar back
(the history keeps one extra entry). Redirects the app makes itself pass `{ force: true }`.

| Route | Page | Nav group | States | Notes |
|---|---|---|---|---|
| `/chat`, `/chat/new`, `/chat/<sessionId>` | Chat | Workspace | all five; a missing session (`E_NOT_FOUND`) and an archived one (`E_CONFLICT`) show as empty with their own text | History column plus conversation (`ListDetail`, the conversation replaces the list in compact). New chat: agent from `GET /api/v1/agents`, "not remembered" switch (`memoryMode: "incognito"`), first message. Transcript follows `session.event` on SSE; without `/events` it polls `session.events` every 1 s, only while a reply is running. Send, cancel, unsent text is put back on failure. Chat head: two selects, model (configured profiles; a profile locked by "Nur lokale Modelle" or gone from the catalog stays listed, disabled, with the reason) and reasoning ("Default (provider)" plus only the levels the model offers; a stored level the model lacks is shown with the level it becomes). A change applies from the next reply (a model change asks for a cache-cost confirmation first; see [user/en/chat-models.md](user/en/chat-models.md)), is refused while a reply runs, reloads on a stale revision and adds a "Model changed: … · Reasoning: …" event note that survives reload for remembered chats and stays in RAM for incognito chats. Accepted privacy changes invalidate the picker immediately through `chat.models.changed`; the client rereads its authorized options. |
| `/memories`, `/memories/<cardId>` | Memories | Workspace | per area (agents, health, reviews, search, cards, detail): all five plus `not-found` | Agent picker (from `core.status`, else `GET /api/v1/agents`), health, pending proposals (read-only), recall search with trace, card list ("Show more": 20 at a time up to 100) and detail. Live indicator from `/events`. `dreams` is reserved and never a card id. |
| `/memories/dreams`, `/memories/dreams/<runId>` | Dreams (tab of Memories) | Workspace | per area, as above | Status per agent and phase, schedule, run log and one run's log, dry-run plan before a run, enable/disable. Run needs role owner/admin/operator, enable/disable owner/admin (client hint from `docs/rbac.md`; a server `E_DENIED` disables the action for the rest of the page session). |
| `/models`, `/models/<provider>/<id>` | Models | Build | all five; a member gets the forbidden state with no `models.*` request | Providers, filterable list, detail, "new" badges and acknowledge, scan, manual add, override edit, remove manual. Add, edit and remove are offered to owner and admin only (`models.write`). Both id parts are percent-encoded. Unknown fields are shown with secret-named values masked. Live updates on `models.changed`. |
| `/usage`, `/usage/<tab>` (`global`, `agents`, `other`, `usage`) | Usage & Quota (budget) | Control | all five | Limits with soft/hard state, set/edit/remove limit dialogs (offered to owner and admin only; the backend has no RBAC rule for `budget.set`, see the test status below), usage per period, agent and model. Scopes the UI does not know (project, user) appear in the `other` tab. Limits and use are counted in the limit's metric, chosen in the dialog: tokens (input + output), images or video seconds; the usage tab shows images and video seconds per period, agent and model. There is no money dimension (owner decisions 2026-10-19). |
| `/doctor` | Doctor | Control | each part separately: health, core status, agents (ok, unavailable, forbidden, error, `down` for a 503 `status: down`); whole page forbidden if health is | Re-check button, automatic refresh every 30 s (stops while the tab is hidden), provisioning check: reads `doctor.report` with a bounded refresh; absent authoritative categories are explicitly skipped. A local `1staid.check/1` file can still be chosen, copied or downloaded without upload. |
| `/agents`, `/agents/new`, `/agents/<id>` | Agents | Build | all five; unknown id is not-found | List from `config.get agents`, detail, three-step create (name and id, skills, review) with a client idempotency key, pause/resume, archive/unarchive and export (bundle download) wired to `agent.*`, delete only for archived agents with export offer and typed name (F39), voice real-time profile override with reset. Only owner/admin create. |
| `/settings`, `/settings/<section>` (`general`, `models`, `memory`, `extensions`, `network`, `security`, `voice`) | Settings | pinned | all five plus read-only | Section navigation 224 px, content up to 880 px. Fields from a static index of the config schema (F17), restart class badge, "Review changes" with a dry-run diff, save with `ifRevision`, `?focus=<key>` scrolls to and highlights a field. Voice section manages speech language, downloads, licences and real-time profile. |
| `/settings/users` | Users & roles | pinned | all five | People list (`identity.list`), role presets with plain text, simple mode and rights matrix per agent (draft), invite dialog and break-glass dialog; role change, invitations (shareable link with a chosen validity of 1 h, 24 h, 7 d, 30 d or custom, shown once with a copy button; open invitations with revoke, see [invites.md](invites.md)), use/manage rights per agent and the break-glass request are wired; the last Owner cannot be demoted and the error is explained (F40, F41). People tab: Owner/admin only. Identities tab (`?tab=identities`, the former hidden `/identities` route, whose deep links redirect here): all five roles read, a Viewer cannot write. |
| `/settings/secrets` | Secrets | pinned | all five | Names and metadata only; create, rotate (masked input, a confirmation step before `secret.set`, value cleared at submit, then Owner-only timestamps from `secret.status`, with unknown legacy timestamps shown explicitly) and delete (typed name). No value is ever in the DOM, storage, URL, console or an error text (tested; see [user/en/secrets.md](user/en/secrets.md)). |
| `/settings/security` | Security & Permissions | pinned | all five plus forbidden below admin | Read-only rules from one `config.get` (`remote.publish`, `tools.hostctl.enabled`, `tools.hostctl.shell.allowed`, `extensions.allowUnsigned`, `secrets.fileFallback.enabled`) with links to Approvals, Break-glass and Devices; owns no config key; rules without a key are left out ([security.md](security.md)). |
| `/settings/devices` | Devices & remote | pinned | all but empty | Hidden behind a note when `remote.publish` is `local` or unknown; the pairing QR (`pairing.qr`) and the device list with rename and revoke (`device.list/rename/revoke`) are wired; Owner/Admin see all devices, everyone else only their own (F44). |
| `/settings/voice` | Voice | pinned | all five plus read-only | Speech language with fast/quality profiles, download progress, licence confirmations without active links, research-only badges; real-time switches, endpointing slider, speculative turn-start, confirmation sound, feature switches with time budgets, cost metrics and engine-fixed indicator. Each voice error (`E_VOICE_BUDGET`, `E_VOICE_LICENSE`, `E_VOICE_LICENCE`, `E_VOICE_UNAVAILABLE`) has its own text, research-only licences are recognised under any dash and never preselected (`voice-hardening.test.ts`, docs/voice.md). |
| `/settings/modules` | Modules & Updates | pinned | all five; actions by role | Installed modules from `module.list` with state, enabled flag, version and API version, and what each depends on or is needed by from `module.graph` (a plain list, no graph drawing). Start, stop and restart (Owner and Admin) each open a confirmation that names the modules a stop or restart takes down with it; install from a directory on the host and uninstall with a typed module name are Owner only, since RBAC has no `module.*` row and the server decides. `module.watch` only shows a reload hint on `module.state`; the list is always read from `module.list`. Optional cached `availableVersion`, `updateBlockedReason` and `feedCheckedAt` show update offers and blockers from the last update check. No list-time network or install action. |
| `/logs`, `/logs/activity`, `/logs/sessions` | Logs (tabs Logs, Activity, Sessions) | Control | all five per tab | Log viewer: filters, cursor paging, live tail (long poll, pause with buffer), virtual list, detail with redaction marks, export. Activity: grouped, human-readable events and the `audit.verify` status. Sessions: operators see other people's sessions (filter owner/agent, columns owner, model, usage), transcripts only through an active break-glass window (F41, F42). Links `?trace=`, `?q=`, `?stream=` prefill the viewer. The time range (last 24 hours, 7 days, 30 days, all) is sent as `from` to `logs.query`. Agent state history uses `agent.activity.list` with agent ID, from/until and cursor paging. Owner/Admin see all agents; other human roles need use/manage rights. The protected audit feed remains Owner/Admin. |
| `/projects`, `/projects/<id>` | Projects | main | all five | Projects Kanban board with project list in the sidebar (open and overdue badges), columns with WIP limits, cards with priorities, due dates, links, assignees with agent icons, drag & drop and accessible keyboard navigation (aria-live), detail drawer with safe Markdown, comments, activity, filters, and /events live sync (F29). Column delete with cards needs a target column: the form states the card count, and with no other column the button stays disabled. A WIP refusal on delete names the column. Card priority changes from the drawer footer (`project.card.update`). |
| `/home` | Home | none (accessible via wordmark logo) | all five | Links to FAQ, guides (bundled user docs), repositories, contact and donation placeholders (hidden while empty), compact version/build and core status. Clicking wordmark logo morphs back into "PLUR1BUS" and navigates to `#/home`. The status card shows only what `/api/v1/health` and `core.status` report (no invented version), says "Status is not available for your role." instead of "Disconnected" when every source answers 403 (a Member or Viewer lacks `doctor.read`), offers Retry and never takes the links with it (`home-hardening.test.ts`). |
| `/help`, `/help/<slug>` | Help | pinned | all five | Bundled user documentation from `docs/user/{de,en}` rendered safely as HTML-free Markdown; follows UI language; table of contents, local search (titles and slugs, plain text), deep-linking per page chunk and per heading (`#/help/<slug>#<heading>`); a page the German handbook lacks opens in English; `#/help/de/<slug>` and `#/help/en/<slug>` pin a page to one language whatever the UI language is (the "other language version" link at the top of each page uses them); links other than http(s)/mailto, handbook pages and anchors are shown as text. Covers topics including [quickstart](user/en/quickstart.md), [privacy](user/en/privacy.md), [cloud embeddings](user/en/cloud-embeddings.md), [reembed](user/en/reembed.md), [chat models](user/en/chat-models.md), [secrets](user/en/secrets.md), [import rollback](user/en/import-rollback.md), and [operations](user/en/operations.md). |
| `/library` | Library | Workspace | all five | Media library gallery over `media.output.list`, filters by kind (image/video/audio), preview via `media.output.get`, download, deletion confirmation via `media.output.delete`, caption inspect/edit via `media.caption.set`. Links to `#/media` for media search. Generate and edit dialogs (`media.generate`, `media.edit`) built from `media.adapters.list`: kinds, adapters, and parameters come from the capabilities an adapter advertises (video: duration range, resolutions, FPS, audio; image: the closed request fields; an adapter-supplied `capabilities.params` list replaces them). Edit offers only what the adapter advertises (prompt edit, inpainting with a library mask, image to video, video edit). Every adapter not marked `local` counts as cloud and needs a confirmation before anything is sent; no cost estimate is shown (no money dimension since 2026-10-19). The job bar lists running and recent jobs from `media.job.list` / `media.job.get` with progress, cancel (`media.job.cancel`) and a link to the result; `media.job.progress` and `media.job.finished` are only a hint to call `media.job.get` again, and the list is reloaded when the event stream reconnects (plus a 4 s `media.job.get` fallback while a job runs). A small Defaults section holds the global metadata switch (`media.preferences.get|set`) and a per-browser default adapter per kind (the backend stores none). Failures show the code of `errors.md` (`E_MEDIA_PRIVACY`, `E_MEDIA_LICENSE`, `E_DENIED` + `budget_exceeded`, `E_NOT_AVAILABLE` + `backend_unavailable`, job codes such as `content_policy`) beside a text. Not offered because the backend has no parameter for them: audio generation, variation, upscale, crop. |
| `/setup`, `/setup?mode=bundled` | First-run wizard | none (not in the sidebar) | per step | Eight steps (seven when bundled), progress, back/next/skip, resume after reload, licence gate for non-commercial embedding models, and voice language selection step with system language preselected. |
| `/skills`, `/plugins` | Skills & Plugins | Workspace | all five | Single shared extensions view (`ExtensionsPage`) filterable between Skills, Plugins and Modules. List from `ext.list`, detail from `ext.show`/`ext.inspect`, enable/disable (`ext.enable`/`ext.disable`), uninstall dialog with purge/cascade options (`ext.uninstall`), restore from trash (`ext.restore`), local file upload/install (`.p1x`/tarball) with inspection before confirm (`ext.install`), and notice for plur1bus.app remote catalog. Live updates via `ext.watch` SSE. |
| `/approvals`, `/approvals/<requestId>` | Approvals & Grants | Control | all five | Pending requests from `approval.list`/`approval.get` using D109 layout (targets and action summary displayed strictly before the unverified agent reason). Approval decision dialog via `approval.decide` (selectable grant duration capped at 90 days; OS attestation prompt note when server requires it), cancellation (`approval.cancel`), and active grants list from `grant.list` with revocation (`grant.revoke`). Role gates hide page from agent principals. Approve, Deny, Cancel and Revoke send one request per click (a lock outlives the render and stays shut until the reloaded list replaces the card); a denial sends neither scope nor delegation; failures show a localized sentence, never the server's text; `summary`, `targets` and `agentReason` are shown with credential-looking values hidden (defence in depth on top of the core's redaction); the result is announced in a status region and the focus returns into the panel. The approval record has no field for the OS confirmation; the page shows only the sentence for a refusal of `approval.decide` (never the raw error) and offers no way around it ([security.md](security.md)). |
| `/recurring`, `/recurring/<jobId>` | Recurring Tasks | Control | all five | Scheduled background jobs from `jobs.list`, execution history from `jobs.history`, and manual trigger ("Run now") with confirmation (`jobs.run`), offered to owner, admin and operator only (client gate; the server decides). Human user-job creation, editing and confirmed deletion use `jobs.create/update/delete`; only manageable agents are offered, with a three-run cron preview (date and UTC offset per run, a note when a DST change skips or doubles a run), cron and timezone trimmed and limited to 128 characters like the schema, a warning that names the previous runAs when editing changes it, and a paused badge with the reason when the server disabled a task. Next-run and history times carry the date. |
| `/breakglass` | Break-Glass | Control | owner and admin only; other roles get no trigger | Request with a mandatory reason (10 to 500 trimmed characters) and a window (1 to 60 minutes) behind a confirmation, a persistent banner while a window runs, running and past windows with remaining time, revoke with confirmation, durable notices. A second entry point on the Users page (`components/break-glass.ts`) sends the request without the confirmation step; see the test status below. |
| `/switchboard` | Switchboard | Control | all five | Channel list and detail. "Test message to me" asks for confirmation first, names the channel and sends nothing before it is confirmed; Cancel and Escape send nothing. |
| `/inbox` | Inbox | Workspace | all five | Own entries from `inbox.list`, filters by kind and unread, cursor paging (an expired cursor, `E_INBOX_CURSOR`, reloads the list from the top), mark read, dismiss and mark all read (`inbox.markRead`, `inbox.dismiss`). Each entry links to its target route. The sidebar badge is the unread total from `inbox.count`, refreshed on sign-in, on a reconnect of `/events` and on `inbox.changed`, which is only a hint. Lazy chunk with its own CSS. A refresh keeps the loaded depth and, when it fails, the list; entries are validated (`isEntry`); under a kind filter "Mark all as read" confirms and marks only the unread entries shown; nothing is filtered by role on the page (`inbox-hardening.test.ts`, docs/inbox.md). |
| `/login` | Sign-in | none | form errors only | Owner token against `POST /api/v1/session`; see `ui/web-shell.md`. One neutral refusal text, rate-limit wait in seconds or minutes, `autocomplete=current-password`, field emptied after any failure, no inline style or script, nothing logged ([security.md](security.md)). |
| any other path | 404 | none | n/a | Link back to the landing route. |
| ⌘K / Ctrl+K, `/` | Command palette | overlay | n/a | Only while signed in and on a page (not on `/login`). Groups: navigation, actions, settings, agents, chats, logs; entity groups come from a bounded, abortable fan-out (150 ms debounce, 5 per group, 1.5 s per source) and are filtered by role. The dialog is its own lazy chunk. |
| `/gallery/<pattern>` | Pattern gallery | n/a | n/a | Exists only in builds made with `PLUR1BUS_WEB_GALLERY=1` (tests); the shipped bundle drops it (`__GALLERY__` build constant). |

## RPCs and routes per page

"Real" means served by `origin/main` (`packages/api/src/routes.ts`: only `session`, `csrf`, `whoami`, `health`, `agents` under
`/api/v1`). "Assumed" means `POST /rpc` (JSON-RPC 2.0, method names of `docs/rpc.md`) or `GET /events`, which no server provides yet.
"Write" is what the client sends with a one-time CSRF token (`rpc()` fetches one by default; pure reads pass `write: false`).

| Page | Method or route | Status | Write |
|---|---|---|---|
| Shell, sign-in | `POST /api/v1/session`, `GET /api/v1/whoami`, `GET /api/v1/csrf`, `DELETE /api/v1/session` | real | login no (public), logout yes |
| Chat | `GET /api/v1/agents` | real | no |
| Chat | `session.list` (`kind: direct`, `archived: exclude`, `limit: 100`) | assumed | no |
| Chat | `session.create` (`agentId`, `kind: direct`, `memoryMode`) | assumed | yes |
| Chat | `session.resume` (`limit: 200`), `session.events` (`afterSeq`, `limit: 500`) | assumed | no |
| Chat | `session.submit`, `session.cancel` | assumed | yes |
| Chat | `/events`: `session.event` | assumed | no |
| Chat | `GET /api/v1/chats/{id}/model` (`chat.model.get`), `PATCH /api/v1/chats/{id}/model` (`chat.model.set`: `profile`, `reasoning`, `expectedRevision`) | real | `PATCH` yes |
| Memories | `core.status` (agents, engine health), `memory.state`, `memory.list`, `memory.show`, `memory.recall` (`joined: false`), `memory.proposals.list` (`pending`, `limit: 20`) | assumed | no |
| Memories | `GET /api/v1/agents` (fallback when `core.status` fails) | real | no |
| Memories | `/events`: `job.run`, `memory.proposal` (refresh triggers) | assumed | no |
| Dreams | `dreams.status`, `dreams.log` (list, or `runId`), `dreams.schedule.get` | assumed | no |
| Dreams | `dreams.run` (also with `dryRun: true`), `dreams.enable`, `dreams.disable` | assumed | yes (the dry run too: it is sent like a write) |
| Models | `models.list` (also `newOnly: true`) | assumed | no |
| Models | `models.scan`, `models.setOverride`, `models.removeManual`, `models.acknowledge` | assumed | yes |
| Models | `/events`: `models.changed` | assumed | no |
| Usage | `budget.status` (soft warning and hard stop bounds per period/agent) | assumed | no |
| Usage | `budget.set` (setting limits; guarded by confirmation when lowering below consumption) | assumed | yes |
| Doctor | `GET /api/v1/health`, `GET /api/v1/agents` | real | no |
| Doctor | `core.status` | assumed | no |
| Doctor | `doctor.report`; optional `1staid.check/1` document | RPC mock verified; optional local file read in the browser, never sent | refresh: yes |
| Agents | `config.get` (`agents`), `config.set` (`agents.<id>`, `ifRevision`), `ext.list` (`kind: skill`) | assumed | set: yes |
| Agents | `agent.rights.get` (`agentId`), `agent.export`, `agent.archive`, `agent.unarchive`, `agent.delete` | assumed | rights/export: no; lifecycle: yes |
| Settings | `config.get` (whole configuration, then one call per key for `restartClass`), `config.set` (`dryRun: true`, then with `ifRevision`) | assumed | set: yes |
| Users | `identity.list`, `config.get` (`agents`) | assumed | no |
| Secrets | `secret.list`, `secret.status`, `secret.set`, `secret.delete` (`secret.get` is never called) | assumed | set, delete: yes |
| Devices | `config.get` (`remote.publish`) | assumed | no |
| Modules & Updates | `module.list`, `module.graph`, `module.watch` (read); `module.start`, `module.stop`, `module.restart` (Owner, Admin); `module.install`, `module.uninstall` (Owner) | assumed (supervisor methods, `x-server: supervisor`) | start, stop, restart, install, uninstall: yes; list, graph, watch: no |
| Logs viewer | `logs.query`, `logs.tail` (long poll) | assumed | no |
| Activity | `agent.activity.list`; `logs.query` (audit and diagnostic, optional `from`), `audit.verify` | Core | no |
| Sessions | `session.list` (`kind: direct`, `archived: any`, `limit: 200`) | assumed | no |
| Wizard | `GET /api/v1/whoami`, `models.list`, `config.set` (`agents.<id>`, `modelRoles.chat`, `modelRoles.rerank`, `embedding.*`), `admin.backup.snapshot` | real / assumed | set, snapshot: yes |
| Palette | `config.get` (`agents`, and the whole configuration for setting values), `session.list` (`search`, `limit: 5`) | assumed | no |
| Voice | `voice.language.list` (`agentId?`), `voice.language.get` (`agentId?`), `voice.realtime.profile.get` (`agentId?`), `voice.metrics.get` (`agentId?`) | assumed | no |
| Voice | `voice.language.set` (`language`, `profile`, `acceptLicences`, `agentId?`), `voice.realtime.profile.set` (`agentId?`, `...`) | assumed | yes |
| Voice | `/events`: `voice.download.progress` (`modelId`, `receivedBytes`, `totalBytes`, `done`, `error?`) | assumed | no |
| Home | `GET /api/v1/health`, `core.status` | real / assumed | no |
| Help | none (bundled docs chunks, no remote calls) | n/a | no |
| Library | `media.output.list`, `media.output.get`, `media.output.delete`, `media.caption.set`, `media.adapters.list`, `media.generate`, `media.edit`, `media.job.get\|list\|cancel`, `media.preferences.get\|set`, events `media.job.progress`, `media.job.finished` | assumed | delete, caption, generate, edit, cancel, preferences: yes |
| Skills & Plugins | `ext.list`, `ext.show`, `ext.inspect`, `ext.enable`, `ext.disable`, `ext.uninstall`, `ext.restore`, `ext.install` | assumed | enable, disable, uninstall, restore, install: yes |
| Skills & Plugins | `/events`: `ext.watch` | assumed | no |
| Approvals | `approval.list`, `approval.get`, `approval.decide`, `approval.cancel`, `grant.list`, `grant.revoke` | assumed | decide, cancel, revoke: yes |
| Recurring Tasks | `jobs.list`, `jobs.history`, `jobs.run`, `jobs.create`, `jobs.update`, `jobs.delete` | typed RPC mock verified; authenticated transport pending | run/create/update/delete: yes |
| Break-Glass | `breakglass.request`, `breakglass.list`, `breakglass.revoke`, `breakglass.notices` | assumed | request, revoke: yes |
| Break-Glass | `/events`: `breakglass.notice` | assumed | no |

No page sends a `caller`: a browser never asserts identity or trust (the `memory.*`, `session.*`, `models.*`, `budget.*`,
`dreams.*`, `core.status` and `config.get` calls all omit it; see F1). Event consumers accept an SSE message either named
by its `event:` field or as a JSON-RPC notification object whose `method` is the name (memories, models); chat requires
`event: session.event` with `data: { event: SessionEvent }`.

## Administration backend status (F39–F42, F44)

The [admin backends](admin-backends.md) now supply the RPC/CLI contracts below. The admin pages are now bound to these
calls (**angebunden**). Every page shows only what the role may read, translates the error codes (de/en) and falls back to
`unavailable` when the server does not know a method. Open gap: agent hard-erasure is blocked by the pinned engine API (delete then reports `engine-erasure-unavailable`).

| What the UI needs | Backend status | Remaining UI work |
|---|---|---|
| Agent pause/resume, archive/unarchive, export/delete (F39) | RPC and CLI available; delete safely reports missing engine erasure API | Done: bound (F39); the erasure limitation is displayed |
| Users, role presets, invitation, use/manage matrix (F40) | RPC and CLI available, stored roles/rights, one-time Identity proof | Done: bound (F40) |
| Break-Glass window and affected-person notice (F41) | RPC/CLI, durable self-scoped notices, audited transcript/user-memory reads | Done: request, list with remaining time, revoke (F41); inbox backend available (`inbox.*`, docs/inbox.md), inbox page follows |
| Operator session overview (F42) | `session.list` owner/agent filters, explicit allOwners, owner/model/tokens metadata | Done: filters and owner/model/usage columns (F42); transcripts stay behind Break-Glass |
| Devices, QR payload and remote mode (F44) | Persistent device store, `device.list/revoke/rename`, CLI, `pairing.qr` and `remote.publish` available | Done: QR, device list, rename (own device) and revoke with confirmation that open connections close (F44) |

### Budgets and limits (soft warning & hard stop)

- **Soft and hard bounds**: Limits configured via `budget.set` support both a soft bound (`soft`, warning state) and a hard bound (`hard`, stop state) per period and agent. Status is reported via `budget.status`.
- **Consumption guard**: Lowering a limit below current consumption (`currentConsumption`) warns explicitly and requires user confirmation via checkbox before saving.

### Agent lifecycle and rights verification

- **Rights verification**: Agent lifecycle actions query `agent.rights.get` for explicit `manage` rights, enabling authorized users beyond the owner/admin role gate.
- **Lifecycle actions**: Export bundle (`agent.export` with JSON download), archive/unarchive (`agent.archive`/`agent.unarchive`), and deletion (`agent.delete`) requiring strict name entry confirmation and offering export.
- **Server-side creation**: No `agent.create` RPC exists in the backend schema (client-side configuration creation is currently used; issue proposal for dedicated server RPC documented).

## M3 part 2: inventory (K1)

What the second web UI change builds fully and what it renders as `unavailable`, measured against `origin/main` @ `809f2d5`
(`docs/rpc.md`, `packages/rpc-schema`, `packages/config-schema`, `packages/api/src/routes.ts`; nothing in `packages/api`, `core`,
`providers`, `rpc-schema` or the RBAC tables is changed by this work).

Two different questions decide a row:

- **Schema** — does the method exist in `docs/rpc.md` / the config schema? If not, the function is built as an `unavailable`
  state (text from the `PageState` pattern, no dead buttons that send something) and listed under Follow-ups. Nothing is added to the backend.
- **Reach** — is it served over HTTP? **No RPC is.** `/api/v1` has the five routes above only; `/rpc` and `/events` are F1 and F2 of
  the first change. So every "RPC exists" row is built against the assumed `/rpc` bridge, exactly like the pages of the first
  change, and shows the `unavailable` state against the real backend until F1 lands. Tests use the mock `/rpc` of `test/mock-rpc.ts`.

"Built" means: full flow with the five states (success, empty, error, forbidden, unavailable) in tests. "Partial" names what is missing.

| M3 page / function | Needed RPC or route | In schema? | Built as |
|---|---|---|---|
| **First-run wizard** (`/setup`), progress, back/next, resume after reload, validation per step, 6/7-step variant | none (browser only; progress in `localStorage`, never a secret) | n/a | Built. Variant hint `?mode=bundled` (6 steps); no `core.status` field tells native from bundled (F30) |
| Wizard: *Your account* (native/VPS) | `POST /api/v1/session` (owner token) | yes (real) | Partial: signs in with the owner token. A one-time *bootstrap* token and its route do not exist (F31) |
| Wizard: *Name & persona* | `config.set` on `agents.<id>` (`displayName`, `createdAt`) | yes | Partial: name and id. Persona text (`SOUL.md`) has no RPC (F32) |
| Wizard: *Main model* | `models.list`; `config.set` on `modelRoles.chat` | yes | Partial: model choice. Provider login has no RPC (`plur1bus login` is a stub; F33) |
| Wizard: *Switchboard* | channel list and connect | **no** (no `channel.*` RPC) | `unavailable`, step can be skipped (F34) |
| Wizard: *Memory* with licence gate | `config.set` on `embedding.useClass`, `embedding.acceptedNcLicence`, `embedding.acceptedNcLicenceAt`, `modelRoles.rerank` | yes | Partial: the NC confirmation shows who (`GET /api/v1/whoami`), when, licence and model + revision from the ADR-006 table; the schema stores only the flag and the time, so who, licence and revision are not persisted (F35) |
| Wizard: *Backups* | `admin.backup.snapshot` | yes | Partial: "Create a backup now". Schedule and list have no RPC (F36) |
| Wizard: optional *Import* | none (`plur1bus import` is CLI only) | **no** | `unavailable` with the CLI command to copy (F37) |
| **Agents** list, detail | `GET /api/v1/agents` (real), `agent.list`, `agent.status`, `config.get` key `agents` | yes | Built |
| Agents: create (multi-step, client idempotency key) | `config.set` with `ifRevision` on `agents.<id>` | yes | Partial: the client key is the reserved id plus `ifRevision`; there is no `agent.create` with a saga or key (F38) |
| Agents: pause, resume | `agent.pause`, `agent.resume` | yes | Built (F39) |
| Agents: archive, unarchive, delete (archive-first, export offer, typed name), export bundle without secrets | `agent.archive`, `agent.unarchive`, `agent.delete`, `agent.export` | yes | Built (F39) |
| **Users & roles**: list, create | `identity.list`, `identity.human.create` | yes | Built |
| Users: pairing codes, link, unlink | `identity.pair.start`, `.claim`, `.confirm`, `identity.link`, `identity.unlink` | yes | Built |
| Users: invite | `user.invite.create`, `.list`, `.revoke` | yes | Built; the link (or, without an origin, the code) is shown once (F40, [invites.md](invites.md)) |
| Users: identities tab | `identity.link.list`, `identity.link.request`, `.approve`, `.decline`, `.remove`, `identity.principals` | yes | Built; the former `/identities` route, now a tab of Users & roles |
| Users: role presets, simple mode | `user.list`, `user.role.set` | yes | Built; the last Owner is protected (F40) |
| Users: object rights per agent (use/manage) | `agent.rights.get`, `agent.rights.set` | yes | Built (F40) |
| Users: Member sees only shared agents | `agent.list` (the server decides), `principal.role` from `whoami` | yes | Built: the UI hides what the role may not see and shows a server `E_DENIED` as forbidden |
| Break-glass dialog (reason, window, notice) | `breakglass.request`, `.list`, `.revoke` | yes | Built (configured reason/window bounds, defaults 10 to 500 characters and 1 to 60 min, "the person concerned is notified"); running windows with remaining time and revoke (F41) |
| **Settings** routed sections, forms, restart class, diff before save | `config.get` (`key`, `tier`; returns `restartClass`, `revision`), `config.set` (`dryRun`, `ifRevision`) | yes | Built. Titles, help and enums come from the static index of the schema (no schema RPC; F17) |
| **Secrets** list, create, rotate, delete | `secret.status`, `secret.list`, `secret.set`, `secret.delete` (`secret.get` is never called with `reveal`) | yes | Built |
| **Sessions overview** | `session.list` | yes | Built: owner/agent filters and owner, model, usage columns for operators; Member sees own sessions (F42) |
| Sessions: transcript via break-glass | `breakglass.request` | yes | Same dialog; transcripts only while a window is active (F41) |
| **Log viewer** query, filters, export | `logs.query` (`stream`, `minLevel`, `component`, `text`, `from`, `to`, `order`, `limit`, `cursor`) | yes | Built. `trace_id` has no parameter: it is matched with `text`; export is the loaded, filtered rows (F43) |
| Log viewer live tail | `logs.tail` (long poll with `waitMs`) | yes | Built over `/rpc`; there is no log event on SSE (F2) |
| **Activity feed** | `logs.query` (streams `audit` and `diagnostic`), `audit.verify` | yes | Agent transitions from `agent.activity.list`; the separate audit summary uses log streams (F43) |
| Devices / pairing card | `config.get` key `remote.publish`, `pairing.qr`, `device.list`, `device.rename`, `device.revoke` | yes | Built: mode card hidden at `local` and when the key is unknown (Owner/Admin); the QR comes from `pairing.qr`; the device list shows name, platform, paired at/by, last seen and status for everyone (own devices, Owner/Admin all); rename for the device's own person, revoke with a confirmation (F44) |
| **Command palette** entities | `config.get` (`agents`), `session.list`, static navigation, settings, actions and a log-search link | yes | Built as a client fan-out over those lists, capped and abortable (F14 is answered; a server endpoint stays a later option) |
| **Settings: Providers** | `auth.credentials.list`, `auth.status`, `auth.login.start`, `auth.login.await`, `auth.login.cancel`, `auth.logout`, `secret.set` | yes | Built. Replaces unavailable provider login state. Masked secret key entry, headless SSH hint and callback paste flow. Interface wish: `auth.login.callback` RPC for manual callback URL forwarding (F33) |
| **Switchboard** | `channel.list`, `channel.status`, `channel.get`, `channel.enable`, `channel.disable`, `channel.set`, `channel.test` | yes | Built. Channel list and detail, enable/disable toggles, field edit with secret rejection and link to secrets, test channel and test message to owner (`sendOwner: true`). When the channel host is missing, `not-registered` is rendered as "not started (host missing)" without an error state (F34) |
| **Projects** | `project.list`, `project.create`, `project.column.*`, `project.card.*` (incl. `project.card.update` for priority), `project.card.comment.*`, `project.card.activity.list`, `/events` (`project.card.changed`, `project.column.changed`) | yes | Built. Replaces placeholder page. Project list in the sidebar with open and due count badges; board columns with WIP limit warnings; cards with title, priority, labels, assignees (agent icon), due date and link indicators; drag & drop and keyboard card movements with aria-live; detail drawer with safe HTML-free Markdown description, comments, activity log, assignments and archive actions; column management with RBAC checks; filters for text, assignee, label, and archived cards; live updates via `/events` SSE; optimistic updates with automatic rollback on error or WIP limit breach (F29) |
| **Skills & Plugins** (`/skills`, `/plugins`) | `ext.list`, `ext.show`, `ext.inspect`, `ext.enable`, `ext.disable`, `ext.uninstall`, `ext.restore`, `ext.install`, `ext.watch` | yes | Built. Unified filterable page, details, agent-specific or global toggles, file upload installation with dry-run inspect, trash restore, plur1bus.app catalog notice |
| **Grants and approvals** (D109, `/approvals`) | `approval.list`, `approval.get`, `approval.decide`, `approval.cancel`, `grant.list`, `grant.revoke` | yes | Built. D109 card order (targets strictly before rationale), configured grant duration (default 90 days), OS confirmation status and helper prompt explanation, active grants list and revoke, principal role gating |
| **Recurring Tasks** (`/recurring`) | `jobs.list`, `jobs.history`, `jobs.run` | yes | Built. Cron/interval task list, execution history, manual trigger with confirmation. Human user-job create/edit/delete and runAs-aware history are connected to the typed mock; production transport remains pending |
| **Break-Glass** (`/breakglass`) | `breakglass.request`, `breakglass.list`, `breakglass.revoke`, `breakglass.notices`, `/events` (`breakglass.notice`) | yes | Built. Dialog "Break-Glass anfordern" (configured trimmed reason/window bounds (defaults 10-500 characters and 1-60 min), confirmation before submit), persistent warning banner while a window is active, active and past windows list with remaining time and confirmed revocation, durable notices from breakglass.notices, Owner and Admin access only |

Where a page lives: `/agents`, `/agents/new`, `/agents/<id>`; `/settings/<section>` with `general`, `users`, `secrets`, `devices`, `providers`;
`/switchboard` and `/switchboard/<id>`;
`/logs` with the tabs Logs (`/logs`), Activity (`/logs/activity`) and Sessions (`/logs/sessions`); `/setup` (not in the sidebar);
`/approvals`; `/recurring`; `/breakglass`.

## API client (`src/api/**`)

Pages depend on the `Api` interface (`rpc`, `get`, `post`, `put`, `patch`, `delete`, `events`), never on `fetch`.

- **Singleton.** `getApi()` (`api/shared.ts`) creates the client lazily, same origin. When a call finds the session gone it sets
  the session state to anonymous (sign-in page) and, for an interrupted write, the "expired" notice. `setApiForTests()` swaps it.
- **One place for paths.** `API_ROUTES` (`api/routes.ts`): `rpc` = `/rpc`, `events` = `/events`, `rest` = `/api/v1`, `agents`. The
  session routes stay in `SESSION_ROUTES` (`session.ts`). When the backend settles `/rpc` or `/events`, it is a one-line change.
- **Typed RPC.** `RpcMethods` is extended per page by declaration merging in `pages/<page>/rpc-types.ts`. The browser keeps its own
  copy of the `ErrorCode` enum because `@plur1bus/rpc-schema` pulls in Node-only code.
- **Failures.** Every call rejects with one `ApiError`, discriminated on `kind`: `unauthenticated` (401 on a read, `E_UNAUTHORIZED`),
  `session-expired` (401 on a write), `forbidden` (403, `E_DENIED`), `csrf` (token refused twice), `unavailable` (404, 405, 501-504,
  no network, `E_NOT_AVAILABLE`, `E_CORE_UNAVAILABLE`, or an answer that is not the wire format; carries `status`, `reason`, parsed
  `body`), `rpc-error` (JSON-RPC error object with `code`, `errorCode`, `reason`), `http` (other non-2xx, with `retryAfterSeconds`),
  `aborted`. Messages never contain tokens, cookies or CSRF values.
- **CSRF.** A write fetches `GET /api/v1/csrf` first. A `403` with reason `csrf` is retried once with a fresh token, then `csrf`.
  A read that the server answers with `csrf` is retried once as a write. Tokens are never kept.
- **SSE.** `events()` reads the stream with `fetch` (no `EventSource`: abortable, can send headers, shows the HTTP status) and a
  WHATWG-conformant parser. Status signal: `connecting`, `open`, `retrying`, `closed`, `unavailable`. A cut stream reconnects with
  exponential backoff (500 ms base, 30 s cap, jitter between half and full delay) and `Last-Event-ID`. 401 and 403 end it for
  good (`closed`); 404, 405, 501 or a content type other than `text/event-stream` end it as `unavailable`. A throwing handler
  does not end the stream.
- **Test helpers.** `test/mock-server.ts` serves the built files under the production CSP plus the `/api/v1` routes. `test/mock-rpc.ts`
  adds `/rpc` (`handle`, `scenario` success/empty/error/forbidden/unavailable, `setDelay`, `calls`, one-time CSRF, `-32601` for
  unregistered methods) and `/events` (`push`, `pushRaw`, `comment`, `dropConnections`, `waitForConnections`, `refuse`, replay by
  `Last-Event-ID`). Both are off (404) until a test enables them, which matches the real backend today. The mock always reports the
  principal as `owner`.

## Runtime building blocks

- **Lazy pages.** Each real page is its own chunk, loaded by `import()` on first use (`pages/lazy.ts`, esbuild splitting). Chunks are
  same-origin files next to `main.js`, so `script-src 'self'` holds. While loading, the frame shows the heading and the loading
  state; a failed load shows the error state, and a second failure reloads the page once (a deploy can remove old chunks). A test
  checks that `main.js` contains no page RPC names.
- **i18n.** `src/i18n/index.ts` composes one file per area (`core`, `chat`, `memory`, `models`, `budget`, `doctor`, `palette`), each
  exporting `en` and `de`; keys are prefixed with the area (`chat.send`) and unique across areas; a page agent edits only its own
  file; adding an area is one import and one line in `AREAS`. `Key` is the union of all keys, so `t()` is checked by the compiler.
  `test/i18n.test.ts` asserts identical keys and placeholders in `en` and `de`. All catalogues are in the start-up closure.
  `scripts/check-i18n.mjs` does not cover this package: `scripts/check-i18n.config.json` registers only the surface `desktop-ui`
  (F20).
- **Theme.** `system`, `light`, `dark`. Precedence: `?theme=` in the URL (query or hash query), cookie `plur1bus_theme` (Path=/,
  SameSite=Strict, one year, `Secure` over https), `localStorage` cache, `system`. An explicit URL choice is persisted. Dark is the
  base (no OS preference gives dark).
- **Layout components** (`src/components`): `Page` (heading, actions that move into a "More actions" menu in compact, lead, width
  `settings` 880 px or `full`), `PageState`/`PageLoading`, `ListDetail`, `Tabs`, `Card`/`Badge`, `Dialog`, `MoreMenu`, `ErrorBoundary`,
  `Sidebar`, preference controls.
- **Styles.** `src/styles/*.css` (`tokens`, `app`, `data`, one file per page area, `palette`) are bundled into one `styles.css`; colours
  and sizes come from the tokens in `tokens.css` only. A test keeps the two light-theme blocks identical and every token defined in
  the dark base.
- **Palette** (`src/palette`). Opens with ⌘K (macOS) or Ctrl+K (toggle), with `/` (not while typing in a field) or from the sidebar
  pill; only when signed in. Index: navigation entries built from `nav.ts` (plus `/memories/dreams`), and settings from
  `settings-index.ts`, a static subset of `packages/config-schema/schema/config.schema.json` (a test fails when it drifts). Labels
  are derived from the key (`softBudgetMs` becomes "Soft budget ms"), help is the schema's English. Current values come from
  `config.get`, best effort (any failure means no values). Keys whose name contains `key`, `token`, `secret`, `passw`, `pwd`,
  `passphrase`, `credential`, `authorization`, `bearer`, `cookie`, `private`, `signature`, `jwt` or `hmac`, or whose last segment is `auth`,
  are never indexed with a value (the list of the Settings page). In any other value, `user:password@` of a URL and secret-named query
  parameters are masked. A settings hit navigates to `#/settings?focus=<key>`; the router drops the query and
  the page is a placeholder (F16, F27).

- **Decision-model hint** (`src/pages/common/decision-hint.ts`, keys `shared.decisionHint.*`). Without `modelRoles.decision` the built-in
  rule triage runs (a normal mode, not an error), but model-based message triage, tool pre-selection and the model class and effort
  per task are limited, as are the further consumers of ADR-015 (model routing, tool-output pruning, automatic skill choice, memory placement and zoom
  recall, compaction choice), each of which falls back as the ADR's table says. The notice lists all nine with their fallback and the way to set the role (Settings, Models & providers, and
  `plur1bus config set modelRoles.decision <provider/model>`). It shows in the setup wizard (model step and summary, reading
  `modelRoles.decision` with `config.get`; a failed read still shows it; the optional Decision step can set the role) and on the Models & providers
  settings section; it disappears once the role is a non-empty string. The same nine features are listed by `plur1bus setup`
  (`config` step, `detail.decisionRole.notice`, which also carries the Windows/Laya recommendation; the web wizard cannot know the server OS and shows no Windows notice); the `models.decision` row of `1staid check` (`info`, never a warning) still names the first three. Tests:
  `test/decision-hint.test.ts`. The `modelRoles` values are edited with catalog selectors in the settings form; the CLI remains available on the
  command line for now.

## Tests and verification

```bash
export PATH=/opt/homebrew/bin:$PATH        # or any Node >= 24.16 with pnpm
pnpm --filter @plur1bus/web test           # node:test; all suites run against the mock server
pnpm --filter @plur1bus/web build          # packages/web/dist (PLUR1BUS_WEB_GALLERY=1 adds the gallery)
pnpm typecheck                             # whole repo, includes packages/web
pnpm lint                                  # typecheck, hygiene, check-i18n (not this package, F20), script tests
```

- **Browser suites** (`e2e`, `a11y`, `responsive`, the per-page suites, palette) need Chromium: `PLUR1BUS_CHROMIUM`, Playwright's
  install or `/opt/pw-browsers/chromium`; nothing is downloaded. Without one they are skipped; `PLUR1BUS_WEB_BROWSER=off` skips them explicitly (the `unit (macos-15)` job sets it because they run in `web-browser (macos-15)`, see `docs/ci.md`); `PLUR1BUS_WEB_E2E_REQUIRED=1` turns
  that into a failure. `UPDATE_SNAPSHOTS=1` rewrites `test/fixtures/responsive.json`.
- **Coverage.** axe (WCAG 2.1 AA) per page, state and theme; layout checks at 400, 960, 1440 and 2560 px (1024 where a mode changes),
  no horizontal scroll, 200 % text zoom (a 1440 px window becomes a 720 px viewport), keyboard paths, contrast of the tokens.
- **Bundle budgets** (`test/build.test.ts`, gzip level 9): `main.js` 25 KiB, start-up closure (`main.js` plus statically imported
  chunks) 150 KiB, each lazy page chunk 40 KiB, `styles.css` 20 KiB. These are tripwires against a runaway dependency, not targets
  (owner decision 2026-10-17: parse and execute cost on weak devices matters more than transfer size). Growth inside the ceilings is
  watched against `test/bundle-baseline.json`: a value more than 20 % above its baseline prints a GitHub Actions
  `::warning title=Web bundle growth::` (not a failure). After an intended change, refresh the baseline with
  `PLUR1BUS_WEB_BUNDLE_BASELINE_WRITE=1 pnpm --filter @plur1bus/web test` and commit it. Measured at the change: `main.js` about 7 KiB,
  start-up closure about 48 KiB, page chunks up to 11.3 KiB, `styles.css` 4.3 KiB. The same test forbids `eval`, `new Function`, inline script or style,
  `javascript:` URLs and remote origins.
- **Screenshots.** Not a test; run by hand, e.g. for a PR:
  `PLUR1BUS_WEB_SHOTS_DIR=<dir> pnpm --filter @plur1bus/web exec node --experimental-strip-types test/shots.ts`. It captures chat,
  memories, dreams, models, usage, doctor, palette, agents, settings (general, users, secrets, devices), logs (viewer, activity, sessions) and setup, light and dark, at 400 and 1600 px, against the mock server with filled
  fixtures; files are `<page>-<hell|dunkel>-<compact|wide>.png`. `PLUR1BUS_WEB_SHOTS_ONLY=chat,doctor` narrows the pages (empty
  means all), `PLUR1BUS_WEB_SHOTS_CHECK=1` also reports overflow, axe violations and targets below 24 px (44 px high below 1024 px),
  `PLUR1BUS_WEB_SHOTS_WIDTHS=400,640,960,1440,2560` replaces the two widths. Screenshots are not committed.

### Contract pass: Recurring, Models, Budget, Break-Glass

Tests for the four pages are new files in `packages/web/test/` and use the mock RPC and fixtures of the existing page tests (axe and
browser checks skip without Chromium, as they do elsewhere). "Corrections" are changes to the page code that a test showed to be
needed. Counts are from the last full `@plur1bus/web` run.

| Page | Test files | Result | Corrections (page code) | Open |
|---|---|---|---|---|
| Recurring | `recurring.test.ts` | 29 pass, 2 todo | run dialog takes one request per task; confirm button uses `aria-disabled` while busy so focus stays in the dialog; "Run now" column hidden for member and viewer; outcomes shown translated | `jobs.history` is asked without `agentId`, so agent jobs are never listed; agent jobs run as the fixed `agentId` `default`. User-job create/edit/delete uses new RPCs; manageable-agent choices come from jobs.list, and history shows runAs. User jobs use the separate form/history panel. |
| Models | `models-states.test.ts`, `models-roles.test.ts`, `models-names.test.ts` (fixtures in `models-fixtures.ts`) | 48 pass, 0 todo | the documented `new` field is a known field; a provider that left the catalogue no longer filters the list; add, edit and remove hidden for operator and viewer; member gets the forbidden state with no request; a refused "mark as seen" shows an alert | No search box (filters are provider, status and "only new"); no arrow-key list navigation (Tab and Enter are tested). SECURITY (backend): `models.scan` and `models.acknowledge` have no RBAC action and are listed as not yet secured in `docs/rbac.md`, so every role that can read the page can run them. |
| Budget | `budget-states.test.ts` | 29 pass, 1 todo | set, edit and remove shown to owner and admin only. This choice is the page's own: no document names the roles that may change a budget. | SECURITY (backend): `budget.set` has no entry in `RPC_RULES` (`packages/core/src/rbac/guard.ts`), and the guard passes unlisted methods through, so any role with a session can change a limit by calling the RPC. `budget` is not in `docs/rbac.md`. Todo case `budget-states.test.ts`; not changed here. |
| Break-Glass | `breakglass-states.test.ts` | 43 pass, 0 todo | the trigger is owner and admin only (`roleIn` had let unknown roles, such as an agent, see it); one request per task; the cancel button uses the shared label; the past-windows table is keyboard reachable | SECURITY: the break-glass component on the Users page (`components/break-glass.ts`) sends `breakglass.request` after a valid reason alone, with no confirmation step. Outside this page; not changed. |

Known failure in the same run, not caused by these pages: `patterns-responsive.test.ts` ("shell and patterns at the reference widths")
finds the header wordmark link at 20 to 22 px, below the 24 px target minimum, at 1440 and 2560 px. The same test fails on `origin/main`.

## Follow-ups

Numbers are stable; other documents refer to them.

### Backend and API

- **F1. `/rpc` HTTP bridge** (all pages except sign-in). `docs/rpc.md` describes NDJSON over a socket or pipe only. The bridge must
  derive the `caller` from the session cookie and ignore any client-supplied one: `session.*` and `memory.*` require a
  `CallerIdentity` (`channel: "cli"`) in the documented schema, but no page sends one (the RPC contract says a client never
  supplies trust), so the bridge must supply it from the session. Also open: CSRF on JSON-RPC writes (the client sends `X-CSRF-Token` on every non-read
  call), HTTP status mapping of JSON-RPC errors, size and rate classes.
- **F2. `/events` SSE format** (Chat, Memories, Models). Nothing specifies how `session.event`, `models.changed`, `job.run` and
  `memory.proposal` appear on the wire. The client accepts `event: <name>` or a JSON-RPC notification object in `data`; chat needs
  `event: session.event` with `{ event: SessionEvent }`, and uses `id:` for resume (`Last-Event-ID`). Needs a decision on event ids,
  replay window and keep-alive.
- **F3. `events.subscribe` over HTTP** (Chat, Memories, Models). `session.event` is opt-in per subscription in `docs/rpc.md`; the
  HTTP side has no way to choose names or an `agentId` filter. Decide which notifications `/events` forwards and for whom.
- **F4. Budget scopes** (Usage). `budget.status` and `budget.set` know only `global` and `agent`. The UI lists unknown scopes in the
  `other` tab but cannot set them; project and user limits need the RPC first.
- **F5. `session.update`** (Chat). Not in `docs/rpc.md`: changing memory mode of an open session, renaming (title is only set at
  `session.create`, which the UI does not do), pinning.
- **F6. Chat RPCs from the direct-chat design without a `docs/rpc.md` entry** (Chat): per-chat model selection, attachments, fork.
  (Archive, `session.archive`, and search, `session.list` with `search`, are documented; the UI does not use them yet, F25.)
- **F7. `memory.recall` has no explain switch** (Memories). Every answer carries `trace` and `timing`; the search shows the trace as
  raw JSON and cannot ask for a cheaper answer without it.
- **F8. `memory.list` has no cursor** (Memories). Only `limit` (UI cap 100), `topic`, `since`, `until`; the list cannot go beyond 100
  cards. `memory.proposals.list` has the same shape (limit 20, `truncated`).
- **F9. Provisioning check** (Doctor). `doctor.report` now bridges the authoritative `1staid.check/1` JSON output, caches it and permits Owner/Admin/Operator refresh at most once per 30 seconds. All human roles may read. Categories without existing authoritative checks are explicitly skipped; the uploaded-report view remains available.
- **F10. `GET /api/v1/health`** (Doctor). `core.degraded` is a boolean; the page cannot say why or which capability. `core.status`
  carries more but is itself behind F1.
- **F11. Units** (Chat, Memories, Dreams, Models, Usage). The UI assumes epoch milliseconds for `createdAt`, `updatedAt`,
  `lastTurnAt` (sessions), `createdAt`, `since`, `until` (memory), `startedAt`, `finishedAt`, `scheduledFor`, `nextRunAt` (dreams)
  and `uptimeMs`/`durationMs`, and ISO 8601 strings for `firstSeen`/`lastSeen`/`lastScanAt` (models) and `now`/`start`/`end`
  (budget). `docs/rpc.md` does not state the unit of the integer fields.
- **F12. `session.list` shape and paging** (Chat). The UI uses `{ sessions, truncated }` as in `docs/rpc.md` with a fixed
  `limit: 100`; the direct-chat design §6.4 names `{ items, next }`. Pick one; a cursor is needed for more than 100 chats.
- **F13. Recall from the UI** (Memories). `memory.recall` called from the search box may count as a recall for the Dreams utility gates
  (`docs/dreams.md`: never `recalls = 0`, at least 3 recalls and 3 queries). Decide whether a UI search must be exempt.

### Frontend and cross-cutting

- **F14. Search across entities** (palette). Answered on the client in M3 part 2: agents, chats, settings, actions and a log search
  (bounded, abortable fan-out over the list RPCs). Still open: memories and Switchboard (no list RPC), and a server search endpoint
  as the later option (milestones M3, desktop spec §13.3 B11).
- **F15. Voice input** for the palette search (same scope as F14; nothing is implemented).
- **F16. Settings page.** Done in M3 part 2: the palette links to `#/settings/<section>?focus=<key>` and the section scrolls to the field.
  Keys the page cannot edit (`engine` as an object) show a quiet notice.
- **F17. Localised setting labels and help.** The schema has no titles; labels are derived from the key and help is English. Needs
  schema titles or an owner-approved UI catalogue.
- **F18. i18n catalogues per page.** All areas are in the start-up closure (about 51 KiB gzip, budget 54 KiB, was 40.0 of 46 before M3 part 2; the target of ADR-004 was
  25 KiB for `main.js` alone). Loading catalogues with the page chunk would bring the start-up closure toward 25 KiB.
- **F19. Role gates.** Only Dreams has a client-side gate (run: owner, admin, operator; enable/disable: owner, admin), taken from
  `docs/rbac.md`. Models and Usage rely on the server answering `E_DENIED`. The mock and the only role the API documents
  (`Principal.role` is `owner`) never exercise the other roles.
- **F20. `scripts/check-i18n.config.json`** registers only `desktop-ui`, so `packages/web/src/i18n` is not checked for hard-coded
  text or dead keys. Add a surface for this package (a change in `scripts/`).
- **F21. CI.** Add a Chromium install step to the main job in `.github/workflows/**` (or run this package's tests in a job that has
  one) and set `PLUR1BUS_WEB_E2E_REQUIRED=1` there; until then CI skips the browser suites.
- **F22. Fonts.** Bundle Atkinson Hyperlegible Next, Lilita One and JetBrains Mono (ADR-004: local files, no remote origin); the
  tokens fall back to system fonts.
- **F23. Wordmark morph** (`V2LogoMorph`). Built in sidebar header. The wordmark transforms into capitalized section titles upon navigation; clicking it morphs back into "PLUR1BUS" (190 ms collapse through pivot letter '1', fully respectful of `prefers-reduced-motion`) and navigates to the Home page (`#/home`).
- **F24. Sidebar.** Projects list and badges. Built in F29: sidebar lists projects with active and overdue card count badges (backend: [project board backend](projects-board.md)).
- **F25. Chat.** Context column, recents, fork, archive (`session.archive`), search (`session.list` with `search`), model selection and
  attachments (the last three need F6), rename and pin (F5).
- **F26. Memories.** Accepting and rejecting proposals (`memory.proposals.accept`, `.reject`), forget and correct (`memory.forget`,
  `memory.correct`), `dreams.schedule.set` (the UI only enables and disables), conflicts, migration (`admin.migrate`). All exist in
  `docs/rpc.md`; the page is read-only for them, with a confirmation flow still to design.
- **F27. State in the URL.** The router drops the query (`#/path?x` is read as `#/path`), so the chosen agent, search text, filters
  and `?focus=` are lost on reload and cannot be linked; the agent choice lives in memory only. (`?theme=` is read separately.)
- **F28. Doctor file picker.** The text of the native file input follows the OS language, not the UI language.
- **F29. Projects Kanban board and placeholders.** The Projects Kanban board is built and replaces the placeholder page: full Kanban board integration with project list in the sidebar (open and overdue badges), columns with WIP limit badges and warnings, cards with title, priority, labels, assignees with agent icons, due date and link indicators. Drag & drop and accessible keyboard navigation (arrow keys with polite aria-live announcements). Card detail drawer with safe HTML-free Markdown description, comments, activity feed, assignee management and archive actions. Column management with RBAC checks. Local filters for search text, assignee, label, and archived cards. Real-time updates via `/events` SSE, optimistic updates with rollback on error, and clear `E_PROJECT_WIP_LIMIT` notices. Home (accessible via the wordmark morph), Help and Library are built, replacing placeholders. Skills & Plugins (`#/skills`, `#/plugins`), Approvals (`#/approvals`), and Recurring Tasks (`#/recurring`) are also built, as is Switchboard. The Inbox backend (`inbox.list|count|markRead|dismiss`, `inbox.changed`, [inbox.md](inbox.md)) is available, and the Inbox page (`#/inbox`) is built on it with the sidebar badge (see the route table).
  - *Skills & Plugins*: unified `ExtensionsPage` serving both sidebar entries with filterable kinds (skills, plugins, modules), detail drawer, enable/disable per agent/global, uninstall dialog with purge/cascade, file install inspection dialog, trash restore, live SSE updates, and an explicit notice that remote catalog installation (`plur1bus.app`) is not yet available.
  - *Approvals*: `ApprovalsPage` following the D109 card layout (exact targets, actions, and risks rendered strictly *before* unverified agent rationale), max 90-day grant duration constraint, OS attestation helper notices, active grants list from `grant.list`, grant revocation (`grant.revoke`), and agent-principal role gates.
  - *Recurring Tasks*: `RecurringPage` displaying cron/interval jobs (`jobs.list`), execution runs (`jobs.history`), and manual execution with confirmation dialog (`jobs.run`). User tasks connect to `jobs.create|update|delete`, live manageable-agent targets, cron/timezone previews and history with `runAs`. Core/RPC semantics are independently tested; web transport is verified against the typed mock pending the authenticated transport package.
  - *Board administration and switchboard (follow-up)*: deleting a column with cards requires a target column (the backend refuses without one, and the form now says so); WIP refusals on delete name the column; the card priority is editable in the drawer; the owner test message asks for confirmation; the activity feed has a time-range filter. Not built: an agent filter on the activity feed (no query RPC for `agent.activity`).

### M3 part 2

- **F30. Native or bundled?** (Wizard). No `core.status` field tells a native or VPS install from the bundled app, so the six-step
  variant is chosen with `?mode=bundled`.
- **F31. Owner bootstrap token** (Wizard, step "Your account"). There is no one-time bootstrap token and no route for it; the step
  shows the signed-in principal, or the owner token form.
- **F32. Persona** (Wizard). `SOUL.md` has no RPC; the persona text is shown as unavailable.
- **F33. Provider login** (Settings → Providers, `#/settings/providers`). Built against `auth.credentials.list`, `auth.status`, `auth.login.start`, `auth.login.await`, `auth.login.cancel`, `auth.logout`, and `secret.set`. Tokens are never displayed; API keys are masked and stored via Secret. Includes headless SSH forward hint and callback URL paste. Note: `auth.login.callback` RPC is requested as an interface improvement to forward pasted callbacks to the backend.
- **F34. Switchboard channels** (`#/switchboard`, `#/switchboard/<id>`). Built against `channel.list`, `channel.status`, `channel.get`, `channel.enable`, `channel.disable`, `channel.set`, and `channel.test`. Secrets are displayed only by name; secret edits are rejected with a link to Secrets. Until the channel host is registered, `not-registered` state is displayed cleanly as "not started (host missing)" rather than an error.
- **F35. Licence confirmation record** (Wizard, Memory). The config stores `embedding.acceptedNcLicence` and `...At` only; who confirmed,
  the licence and the model revision are shown in the dialog but not persisted. Also `modelRoles.embedding` is not writable while the
  engine forces its default (ADR-006 deviation O5), and several revisions are not pinned in the ADR-006 table.
- **F36. Backup schedule and list** (Wizard). Only `admin.backup.snapshot` exists.
- **F37. Import** (Wizard). `plur1bus import` is CLI only; the step shows the command.
- **F38. `agent.create` with an idempotency key** (Agents). Create goes through `config.set` with `ifRevision`, an existence check and
  a client key; a real RPC with a server-side key would replace it. `agents.<id>.state` and `skills` are assumptions about the shape.
- **F39. Agent lifecycle — wired.** `agent.pause/resume/archive/unarchive/export/delete` and
  matching CLI commands now exist. Pause retains state and rejects new work. Export is signed/redacted; delete requires
  archive, typed name and an export offer. **Engine gap:** the pinned engine lacks hard-erasure; delete fails closed with
  `engine-erasure-unavailable`. Large memory exports also need an exhaustive engine listing API (current list cap 100).
- **F40. Users, roles and rights — wired.** `user.list`, `user.role.set`,
  `user.invite.create/list/revoke`, `agent.rights.get/set` and CLI commands persist presets/rights and use Identity pairing
  for one-time invitation redemption. Last Owner protection and immediate role/right enforcement are server-side.
- **F41. Break-glass — wired.** `breakglass.request/list/revoke` wrap the existing read-only
  library. Reasons/windows are validated and each use is audited. `breakglass.notices` is the affected person's durable
  inbox; checked opt-in live notices use `breakglass.notice`. Foreign `session.get/resume/events` and targeted
  `memory.list/show` reads require a live grant. No write is enabled by a grant.
- **F42. Sessions of other people — wired.** `session.list` adds owner/model/usage metadata,
  owner/agent filters and explicit `allOwners`. Operations roles may list metadata; Member sees own only. Tokens/models join
  the existing budget ledger; pending calls are counted, no cost is shown (no money dimension). Transcripts and foreign transcript search are protected.
- **F43. Log viewer** (Logs). `logs.query` has no `trace_id` parameter (matched with `text`, and not combinable with a search text);
  `logs.tail` is a long poll (no log event on SSE); `audit.verify` returns no check time; the activity feed relies on scheduler job
  names (`scheduler.run.*`) because the log schema registers no agent-run, dream, model-scan or backup events.
- **F44. Devices — wired.** `pairing.qr`/`plur1bus pairing qr --link`
  format an existing offer using the package's read-only QR payload. `remote.publish` is now in the config schema.
  `packages/remote-access` now supplies the persistent device store, enrollment, proof-of-key reconnect and immediate
  revocation ports. `device.list/revoke/rename` and `plur1bus device` are available with RBAC and audit. The web
  page is bound (list, rename, revoke); remote listener/route integration must share the core-owned store (see [remote access](remote-access.md#persistent-devices-f44)).
- **F45. Config schema over RPC** (Settings). No `config.schema` method: types, bounds, enums and defaults come from a static table
  in `pages/settings/config/meta.ts`, guarded by a drift test against `config.schema.json`. `config.get` could return the restart
  class for a whole tier (the page asks once per key). `config.set` has no role rule in `docs/rbac.md` (the UI allows owner and admin).
- **F46. Roles in `whoami`.** Only `owner` is emitted today; Operator, Member and Viewer paths are tested with a mock role only.

## Media search (`src/pages/media-search/**`)

The media index follows the binding contract `media-search-contract.md` (kept outside the repo). It adds a media part to the
Memory setup step, the Memory settings, a per-agent override and a search in the Media view. Nothing here changes an existing
component except one registration line per place (listed below).

| Piece | File | Where it shows | Calls |
|---|---|---|---|
| Wire types | generated `packages/rpc-schema/generated/types.ts`, merged by `src/pages/media-search/rpc-types.ts`; config and error contract in `src/pages/media-search/contract.ts` | — | — |
| Rules (pure: captioning preselection, validation mirror of E_MEDIA_*, config changes against the defaults, query params, time labels) | `src/pages/media-search/model.ts` | all of the below | — |
| Setup, media part of the Memory step | `src/pages/media-search/setup.ts` | `/setup`, step Memory (the wizard model `setup/model.ts` carries the answers as `media`) | `config.set` on Next, only for values that differ from the defaults |
| Memory settings panel (text and media index side by side, video and audio options, captioning, backfill, status card with pause, resume, re-index) | `src/pages/media-search/settings.ts` | `/settings/memory`, above the form | `config.get`, `config.set` (`ifRevision`), `media.index.status`, `media.index.pause\|resume\|reindex` |
| Media tab of the Memories page: state, counts, backfill, pause, resume, guarded re-index | `src/pages/memory/media-tab.ts` | `/memories/media` (tab "Media"); owner and admin act, other roles only read | `media.index.status`, `media.index.pause\|resume\|reindex` (re-index sends `confirm: true` after the typed word) |
| Per-agent override | `src/pages/media-search/override.ts` | agent detail | `config.get`, `config.set` (`agents.<id>.memory.mediaEmbedding.*`) |
| Search in the Media view, "Find similar" button, hits with segment and jump, caption edit | `src/pages/media-search/search.ts` | Media view | `media.index.status`, `media.search`, `media.caption.set`, `media.output.get` (playback) |
| Typed RPC methods (merged into `RpcMethods`) | `src/pages/media-search/rpc-types.ts` | — | — |
| Texts (de and en, one area) | `src/i18n/mediasearch.ts` | — | — |

Registration lines in existing files (each is one line or one import): `src/i18n/index.ts` (area), `src/pages/setup/model.ts` (the
`media` answer, its loading, the memory validation and the change list), `src/pages/setup/page.ts` (the memory step renders the media
part and passes the error), `src/pages/settings/page.ts` (the panel above the Memory section), `src/pages/agents/detail.ts` (the
override), `src/pages/surfaces/media.ts` (the search and the "Find similar" button per medium), `src/pages/memory/index.ts` (the Media tab and its route).

### Rules the components rely on

- **Free provider choice.** Text and media providers are chosen independently; there is no combination list. Validation checks only
  capability (the media provider must take every chosen modality, so OpenAI can only be the text index), licence (a non-commercial
  model needs its confirmation, `E_MEDIA_LICENSE`), “Only local models” (`E_MEDIA_PRIVACY`) and availability. The switch is not in the wizard's
  answers: the setup only explains it, and the server refuses the request.
- **Defaults write nothing.** Config changes are computed against the contract defaults and the loaded values, so an untouched form
  sends no media key. The existing setup test pins the exact `config.set` list of the default flow; this keeps it true.
- **Captioning.** Preselected to local when the text provider is local. With a cloud text provider nothing is preselected and the
  setup blocks until a choice is made (`caption-required`).
- **Suggestions only fill fields.** The three suggestion buttons (EmbeddingGemma 2 only; OpenAI text with EmbeddingGemma 2 media;
  Jina text with EmbeddingGemma 2 media) set the two provider fields and nothing else.
- **Errors.** `E_MEDIA_*` codes are read from `error.data.error`. The API client maps only the closed list of harness codes, so these
  codes reach the components through `RpcError.data`, read by `mediaErrorOf` in `model.ts`. Each code has a text under
  `mediasearch.error.*`.
- **Search.** Exactly one of `text` and `likeMediaId` is sent; the kinds filter is sent only when it narrows the search; `limit` is 20.
  Results are not compared across spaces: the server runs a text-to-media search with the media model's text encoder.
- **Playback.** A hit's file is read with the existing `media.output.get`, using the hit's `mediaId` as the output id. The contract
  does not name a file URL for hits; if the backend serves one, the player should use it instead (see Follow-ups).
- **Roles.** Index actions (pause, resume, re-index) are owner or admin; caption editing is owner, admin or operator. Both are client
  hints; the server decides. Agents never edit captions (contract).

### Mock API (`test/media-search-fixtures.ts`)

`seedMedia(rpc, opts)` registers `media.index.status`, `media.index.pause`, `media.index.resume`, `media.index.reindex` (rejects a
call without `confirm: true`), `media.search` (filters by `kinds`, excludes `likeMediaId` from its own results), `media.caption.set`,
`media.output.get` and `media.output.list`. Options: `status` (initial status), `searchError` (a refused search with an E_MEDIA
code), `noStatus` (the method is unknown, so the UI shows unavailable). The mock error list now carries the six `E_MEDIA_*` codes.
Tests: `test/media-search-model.test.ts` (rules, pure) and `test/media-search.test.ts` (browser, 21 cases: settings, setup, Media view,
override). The config mock writes into the objects it receives, so each test builds its own config (`memCfg()`).

### Media plan, steps 1–4 (Memory tab, setup, search, doctor)

- **Memory tab.** Done in `src/pages/memory/media-tab.ts`, reached from `src/pages/memory/index.ts`. Re-index needs the typed word
  (`memory.media.reindexWord`) and sends `confirm: true`. The Settings card keeps its own layout and labels.
- **Setup, media part.** The part already existed. This change adds browser tests for Back, for a reload after the step, and for the
  rule that at least one media type is needed. Open: the setup has no “Only local models” switch (the text step has none either), so the media
  validation does not assume it is on. Setup still offers local text models only; an explicitly selected cloud captioner now requires its own provider-naming privacy acknowledgment. The “Only local models” switch takes precedence independently.
- **Media search.** The find-similar button, the segment range and jump, the kind filter and the captions switch already existed.
  This change adds browser tests for the captions switch (`fuseCaptions`), for image hits without a segment, and for clearing a
  similar search. Open: the switch is labelled "Also use captions for ranking"; the owner's name "Captions einbeziehen" is not used,
  because i18n keys are only appended, never renamed.
- **Doctor.** `doctor.report` now supplies the provisioning group from authoritative Rust checks. Missing categories are skipped; the local `1staid.check/1` document view remains available.

### Follow-ups (media search)

- **F47. Generated RPC types. Done.** `src/api/media-search.types.ts` is deleted. The six `media.*` methods are merged from the
  generated types, and the forms, settings and tests use them. What the placeholder had that is not an RPC shape moved to
  `src/pages/media-search/contract.ts`: the `memory.mediaEmbedding.*` types and defaults, the catalogue capabilities and the
  `E_MEDIA_*` codes (checked against the schema's `ErrorCode` at compile time). Deviations from the placeholder, all resolved to
  the schema: `MediaKind` is `MediaIndexKind` and `MediaHit` is `MediaSearchHit`; `kinds` is a tuple of one to three kinds (a
  guard in `model.ts` builds it); `MediaSearchParams` has no compile-time "exactly one of `text` and `likeMediaId`" (the schema
  has no `oneOf`; the server answers `text-or-like-required` and `text-and-like-exclusive`, and `model.ts` sends one of them);
  `dimensions` is any integer of at least 1 in `config.schema.json` (768, 512, 256 and 128 are the model's list, checked in the
  forms); `Segment`, `BackfillState`, `PausedReason`, `CaptionSource` and `MEDIA_METHODS` were unused and are gone.
  **Open, not changed here:** the schema default of `memory.mediaEmbedding.provider` is `local-transformers`, while the forms
  preselect the catalogue entry `egemma2`. Until F48 unifies the two lists, the forms can show a provider the core does not
  name by that ID.
- **F48. Catalogue for the forms.** The provider list, licence, dimensions and capabilities come from the static table in
  `pages/setup/licences.ts` (plus the capability table in `pages/media-search/model.ts`). The contract extends the embedding
  catalogue with `capabilities`; the forms should read it from there. The catalogue's size field is not in the contract, so the forms
  show "not stated in the catalogue".
- **F49. Text index keys.** The contract names no keys for the text index. The forms write `memory.embedding.provider` and
  `memory.embedding.dimensions` (following the `agents.<id>.memory.embedding` structure the contract names for overrides) and read the
  same. This must be confirmed against the backend.
- **F50. Playback source.** Hits play from `media.output.get` (`data:` URL with a `#t=` start fragment). A file URL in the hit or a
  streaming route would avoid base64 for large videos.
- **F51. Caption provider ids.** The forms use `local`, `off` and `openai` as caption provider values. The contract says only "local"
  as the default; the cloud id must match the backend's provider registry.
- **F52. Agent override clearing.** Clearing a field writes `null`. The contract does not say whether `config.set` accepts `null` for
  an `agents.<id>.memory.mediaEmbedding.*` key; if it does not, clearing needs a dedicated delete.
- **F53. “Only local models”.** The setup only explains the switch. The Settings panel does not show whether it is on; the server's refusal
  (`E_MEDIA_PRIVACY`) is the only signal.
- **F54. Size.** The contract's catalogue has no size; the forms show "not stated". A size field would make the setup's "Größe" useful.
- **F55. Playback test.** The browser test checks the `#t=` fragment and `data-start`, not actual playback.

## Voice UI (V3 contract)

Voice settings, real-time profiles and first-run wizard integration are built against the V3 RPC contract.
The backend RPCs (`voice.*`) are in development in parallel. While the generated RPC types are pending,
hand-written wire types live in `packages/web/src/api/voice.types.ts` and merge into `RpcMethods`. If the server
does not serve a method or rejects with `E_VOICE_UNAVAILABLE`, the UI gracefully shows the existing `unavailable` state.

### Surfaces

- **Settings > Voice (`/settings/voice`):**
  - **Language panel (`LanguagePanel`):** Lists available languages and profiles (`fast` / `quality`) with download sizes and licences per model (`asr`, `tts`, `vad`). Models requiring licence confirmation (`needsConfirmation: true`) must be confirmed via checkboxes (`modelId@licenceId`) before download. Licence identifiers are rendered as text without active external links. Research-only / non-commercial licences (e.g. `blizzard-2013`, `CC-BY-NC-4.0`) are clearly badged ("Research only, no commercial use" / "nur Forschung, keine kommerzielle Nutzung"). Download progress is streamed via `/events` (`voice.download.progress`) with accessible progress bars and polite live region announcements.
  - **Real-time profile panel (`RealtimePanel`):** Controls real-time speech interaction: on/off switch, endpointing slider (200–2000 ms), speculative turn-start switch, and confirmation sound switch.
  - **Feature switches:** Individual feature controls (`autoRecall`, `promptEnrichment`, `reranker`, `decisionService`, `postTurnRefine`, `memoryWrite`, `compaction`, `toolSchemas`) supporting modes `on`, `deferred`, and `off` (`toolSchemas` additionally supports `reduced`), each with a configurable time budget (0–60 000 ms, the range of the schema; an empty field removes it).
  - **Metrics and effective status:** Measured costs per feature and speech-end-to-first-audio latency (median / p95) from `voice.metrics.get` are displayed alongside each switch. Features reported with `effective="engine-fixed"` are visually tagged ("Fixed by the engine" / "Takes effect only with engine support").
- **Agent Detail override (`/agents/<id>`):**
  - Integrated `VoiceOverride` component allowing per-agent overrides of the real-time profile.
  - Clearly indicates inherited versus overridden fields and provides a one-click reset to inherited values.
- **First-run setup wizard (`/setup`):**
  - Step "Language for voice features" (`setup.step.voice`): preselects the browser/system language; offers `fast` or `quality` profile with model sizes and licences; download flow; skippable without blocking setup.
  - English preselection: never preselects a research-only voice (such as `piper-en-lessac`); English suggests the `quality` profile (Kokoro).
  - German preselection: selects `fast` with Piper Thorsten + Kroko, gating on CC-BY-SA licence confirmation.
  - Step completion reflects in the wizard summary.

### Mock API (`test/voice-fixtures.ts`)

`installVoice(server, world)` registers:
- `voice.language.list`: lists languages, profiles, model metadata, and licence confirmation requirements.
- `voice.language.get`: returns current language and profile.
- `voice.language.set`: validates licence acceptance (`acceptLicences`), returns `{ ok: true, downloading: boolean }`.
- `voice.realtime.profile.get`: returns global profile or per-agent profile when `agentId` is supplied.
- `voice.realtime.profile.set`: saves editable profile parameters.
- `voice.metrics.get`: returns latency percentiles and feature cost medians/p95s.
- `pushProgress(server, ...)`: emits SSE `voice.download.progress` events.
Simulates error conditions `E_VOICE_LICENCE` and `E_VOICE_UNAVAILABLE`.

### Follow-ups (voice)

- **F56. Generated RPC types.** Replace `packages/web/src/api/voice.types.ts` with auto-generated RPC types once the backend's `voice.*` schemas are merged into `rpc.schema.json`.

## Härtung und Testabdeckung (Home, Surfaces, Inbox, Voice)

Tests of the hardening sweep: `home-hardening.test.ts`, `surfaces-hardening.test.ts`, `inbox-hardening.test.ts`, `voice-hardening.test.ts` (real
Chromium against the mock API; axe in light and dark, English and German, 360 and 1440 px).

- **Home.** The status card reads each field of the two answers on its own (a field of the wrong type is skipped, a `null` model entry no longer
  leaves the card loading), words such as Connected and Yes come from the catalogue, and there are four states: loading, ok, forbidden, down.
- **Surfaces (`/media`).** The agent of "Generate" is chosen from `GET /api/v1/agents` (no assumed `main`; with no agent nothing is sent), an incomplete
  entry of `media.output.list` is skipped instead of failing the page, a job answer without `progress` keeps polling, long prompts wrap at 360 px, and
  images carry an alt text.
- **Inbox, Voice.** See [inbox.md](inbox.md) and [voice.md](voice.md).
- **Known gap (Surfaces).** The live identities form (`src/pages/settings/users/identities.ts`, reached through `#/identities`) pre-fills the channel with
  `telegram`, keeps an error after a success and has identical "Remove" buttons per row; it belongs to the Settings package. `surfaces/identities.ts` and
  `surfaces/projects.ts` are no longer reached and can be deleted.

## Real browser transport

The Harness API now serves the existing `/rpc` and `/events` paths with session cookies, CSRF, delegated Core/Supervisor identity and audience-filtered SSE. The typed client resumes through Last-Event-ID and reloads on restart. Mocks remain useful for page-state/a11y coverage; they are supplemented by the real API/Core transport test and `packages/web/test/real-transport.test.ts`, which opens Inbox, Chat list and Settings against the actual supervisor. Run the stack smoke after building the CLI/core with `PLUR1BUS_WEB_TRANSPORT_REQUIRED=1` and an installed Chromium. The transport exposes a reviewed subset; excluded internal/legacy calls still report their explicit RPC refusal. The annotations and active-person callback from merged PR #426 are integrated.

## Backend follow-ups (14 October 2026)

Secrets timestamps come from the persisted status snapshot; unknown legacy metadata is shown explicitly. Approval records optionally report OS confirmation state and platform, including the device confirmation hint. The Doctor live report displays normalized statuses and repair hints and has a refresh button only for Owner/Admin/Operator. Agent activity includes bounded state-transition history, per-agent visibility, time filters and cursor paging. See [the implementation and open decisions](handoff/2026-10-14-backend-gaps.md).

### Backend follow-ups, 14 October 2026

The activity query, secret timestamps, security limits, OS confirmation status, Doctor report, user jobs, cached module offers and setup caption privacy acknowledgment are tested against the typed RPC mock. No authenticated `/rpc` or `/events` HTTP transport is added by this package. Security-limit settings remain read-only; privacy writes declare owner/admin and audit in the schema, with supervisor enforcement provided by the real web transport. Text embedding remains local. Cloud media selection and the default cloud caption binding are not implemented where no adapter exists. See the [handoff report](handoff/2026-10-14-backend-gaps.md) for exact transport requirements, stricter ADR permissions, tests and open owner decisions.

## Secret metadata and agent references (Phase E, 2026-10-18)

The owner can edit a secret description separately from rotating its value. The dialog sends only name and description to
`secret.describe`; it has no value field. Empty text clears the description. `secret.grants.list` supplies the read-only
agent access panel: agent leases are currently disabled, effective grants are empty, and provider/channel configuration
references are explicitly not grants. No grant writer or agent value path is added. Details: [secrets.md](secrets.md).
## Model roles and optional Decision setup (Phase A, 2026-10-18)

Settings → Models & providers edits the six roles that select a model (`chat`, `reasoning`, `capture`, `dream`, `decision`,
`summarize`) through catalog selectors. Unavailable models remain visible but disabled. Stored identifiers absent from the
current catalog remain visible without silently selecting another model. The existing review step uses `config.set` with
`dryRun` and `ifRevision`; a conflict requires reloading. Owner/Admin use `settings.write`. Each role has a de/en purpose text.

The schema still accepts `modelRoles.embedding` and `modelRoles.rerank`, but they select no model, so since 2026-10-25 the
section offers no field for them (and no longer asks `model.licence.check` about non-commercial models for one); a stored
value is left as it is. The memory engine takes its models from `engine.embedding` and `engine.reranker`. The section shows
them read-only at the end of the role group (`src/pages/settings/config/engine.ts`): what `core.status` reports in
`engine.models` (the embedder's model name, the reranker's provider, each with its state), or that the status could not be
read, and how to change them: the Memory step of the first-run setup while the memory store is empty (Owner/Admin get a
link to `#/setup`), `plur1bus memory reembed` once it holds memories.

The Test button on chat/LLM roles calls `models.test`: a fixed short prompt, 16 output tokens, ten-second deadline, no tools,
no recalled memory, no session or transcript writes. It uses the configured adapter and production budget; cloud models
make a cloud call. Provider output and raw provider errors are never displayed. RPC is human-only and forbidden to WebMCP.
Models and Memory also offer Engine role tests through `admin.engine.test`: a minimal real embedding or rerank call,
ten-second deadline, current Engine model, latency and embedding dimension, or a fixed error class (egress, key,
download, provider or timeout). The human Owner/Admin scope is `settings.write`; provider text and key values are
never returned. A cold model can require a download; remote roles can call their configured provider. Captioning
has no Engine role contract and is explicitly reported as unsupported.

The setup wizard now has nine standalone/eight bundled steps. Decision follows Main model, defaults to skip, and writes
only an explicit choice with a revision check. Skipping keeps the existing role, if any. CLI setup offers catalog chat
models with configured providers; unattended setup never assigns Decision. Doctor's `models.decision` reports last catalog
availability; unknown is info, unavailable is fail, and no live paid probe is performed by Doctor.

The Engine tests use the same host fetch, secret store and live egress/privacy checks as production calls. The current
role schema has no captioning role; captioning remains in its existing media settings. Existing broader role-selector
acceptance work is tracked separately; these buttons do not claim completion of the whole model-role package.
