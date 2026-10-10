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

| Route | Page | Nav group | States | Notes |
|---|---|---|---|---|
| `/chat`, `/chat/new`, `/chat/<sessionId>` | Chat | Workspace | all five; a missing session (`E_NOT_FOUND`) and an archived one (`E_CONFLICT`) show as empty with their own text | History column plus conversation (`ListDetail`, the conversation replaces the list in compact). New chat: agent from `GET /api/v1/agents`, "not remembered" switch (`memoryMode: "incognito"`), first message. Transcript follows `session.event` on SSE; without `/events` it polls `session.events` every 1 s, only while a reply is running. Send, cancel, unsent text is put back on failure. |
| `/memories`, `/memories/<cardId>` | Memories | Workspace | per area (agents, health, reviews, search, cards, detail): all five plus `not-found` | Agent picker (from `core.status`, else `GET /api/v1/agents`), health, pending proposals (read-only), recall search with trace, card list ("Show more": 20 at a time up to 100) and detail. Live indicator from `/events`. `dreams` is reserved and never a card id. |
| `/memories/dreams`, `/memories/dreams/<runId>` | Dreams (tab of Memories) | Workspace | per area, as above | Status per agent and phase, schedule, run log and one run's log, dry-run plan before a run, enable/disable. Run needs role owner/admin/operator, enable/disable owner/admin (client hint from `docs/rbac.md`; a server `E_DENIED` disables the action for the rest of the page session). |
| `/models`, `/models/<provider>/<id>` | Models | Build | all five | Providers, filterable list, detail, "new" badges and acknowledge, scan, manual add, override edit, remove manual. Both id parts are percent-encoded. Unknown fields are shown with secret-named values masked. Live updates on `models.changed`. |
| `/usage`, `/usage/<tab>` (`global`, `agents`, `other`, `usage`) | Usage & Quota (budget) | Control | all five | Limits with soft/hard state, set/edit/remove limit dialogs, usage per period, agent and model. Scopes the UI does not know (project, user) appear in the `other` tab. Money is micro-USD, converted without float drift. |
| `/doctor` | Doctor | Control | each part separately: health, core status, agents (ok, unavailable, forbidden, error, `down` for a 503 `status: down`); whole page forbidden if health is | Re-check button, automatic refresh every 30 s (stops while the tab is hidden), provisioning check: loads a `1staid.check/1` JSON file chosen by the owner, shows it as a table, copy/download of the unchanged text. |
| `/agents`, `/agents/new`, `/agents/<id>` | Agents | Build | all five; unknown id is not-found | List from `config.get agents`, detail, three-step create (name and id, skills, review) with a client idempotency key, pause/resume, archive/unarchive and export (bundle download) wired to `agent.*`, delete only for archived agents with export offer and typed name (F39). Only owner/admin create. |
| `/settings`, `/settings/<section>` (`general`, `models`, `memory`, `extensions`, `network`) | Settings | pinned | all five plus read-only | Section navigation 224 px, content up to 880 px. Fields from a static index of the config schema (F17), restart class badge, "Review changes" with a dry-run diff, save with `ifRevision`, `?focus=<key>` scrolls to and highlights a field. |
| `/settings/users` | Users & roles | pinned | all five | People list (`identity.list`), role presets with plain text, simple mode and rights matrix per agent (draft), invite dialog and break-glass dialog; role change, invitations (code shown once, copy button), use/manage rights per agent and the break-glass request are wired; the last Owner cannot be demoted and the error is explained (F40, F41). Owner/admin only. |
| `/settings/secrets` | Secrets | pinned | all five | Names and metadata only; create, rotate (masked input, value cleared at submit) and delete (typed name). No value is ever in the DOM, storage, URL or console (tested). |
| `/settings/devices` | Devices & remote | pinned | all but empty | Hidden behind a note when `remote.publish` is `local` or unknown; the pairing QR (`pairing.qr`) and the device list with rename and revoke (`device.list/rename/revoke`) are wired; Owner/Admin see all devices, everyone else only their own (F44). |
| `/logs`, `/logs/activity`, `/logs/sessions` | Logs (tabs Logs, Activity, Sessions) | Control | all five per tab | Log viewer: filters, cursor paging, live tail (long poll, pause with buffer), virtual list, detail with redaction marks, export. Activity: grouped, human-readable events and the `audit.verify` status. Sessions: operators see other people's sessions (filter owner/agent, columns owner, model, usage), transcripts only through an active break-glass window (F41, F42). Links `?trace=`, `?q=`, `?stream=` prefill the viewer. |
| `/setup`, `/setup?mode=bundled` | First-run wizard | none (not in the sidebar) | per step | Seven steps (six when bundled), progress, back/next/skip, resume after reload, licence gate for non-commercial embedding models only (the default, EmbeddingGemma 2, is Apache-2.0 and asks nothing). |
| `/projects`, `/inbox`, `/library`, `/skills`, `/plugins`, `/switchboard`, `/recurring`, `/approvals`, `/help` | placeholder | as in `nav.ts` | none (fixed text `page.placeholder`) | `PlaceholderPage`. `approvals` stays a placeholder (grants and approvals, D109, are not part of this change). |
| `/login` | Sign-in | none | form errors only | Owner token against `POST /api/v1/session`; see `ui/web-shell.md`. |
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
| Memories | `core.status` (agents, engine health), `memory.state`, `memory.list`, `memory.show`, `memory.recall` (`joined: false`), `memory.proposals.list` (`pending`, `limit: 20`) | assumed | no |
| Memories | `GET /api/v1/agents` (fallback when `core.status` fails) | real | no |
| Memories | `/events`: `job.run`, `memory.proposal` (refresh triggers) | assumed | no |
| Dreams | `dreams.status`, `dreams.log` (list, or `runId`), `dreams.schedule.get` | assumed | no |
| Dreams | `dreams.run` (also with `dryRun: true`), `dreams.enable`, `dreams.disable` | assumed | yes (the dry run too: it is sent like a write) |
| Models | `models.list` (also `newOnly: true`) | assumed | no |
| Models | `models.scan`, `models.setOverride`, `models.removeManual`, `models.acknowledge` | assumed | yes |
| Models | `/events`: `models.changed` | assumed | no |
| Usage | `budget.status` | assumed | no |
| Usage | `budget.set` | assumed | yes |
| Doctor | `GET /api/v1/health`, `GET /api/v1/agents` | real | no |
| Doctor | `core.status` | assumed | no |
| Doctor | `1staid.check/1` document | no route; local file chosen by the owner, read in the browser, never sent | no |
| Agents | `config.get` (`agents`), `config.set` (`agents.<id>`, `ifRevision`), `ext.list` (`kind: skill`) | assumed | set: yes |
| Settings | `config.get` (whole configuration, then one call per key for `restartClass`), `config.set` (`dryRun: true`, then with `ifRevision`) | assumed | set: yes |
| Users | `identity.list`, `config.get` (`agents`) | assumed | no |
| Secrets | `secret.list`, `secret.status`, `secret.set`, `secret.delete` (`secret.get` is never called) | assumed | set, delete: yes |
| Devices | `config.get` (`remote.publish`) | assumed | no |
| Logs viewer | `logs.query`, `logs.tail` (long poll) | assumed | no |
| Activity | `logs.query` (streams `audit` and `diagnostic`), `audit.verify` | assumed | no |
| Sessions | `session.list` (`kind: direct`, `archived: any`, `limit: 200`) | assumed | no |
| Wizard | `GET /api/v1/whoami`, `models.list`, `config.set` (`agents.<id>`, `modelRoles.chat`, `modelRoles.rerank`, `embedding.*`), `admin.backup.snapshot` | real / assumed | set, snapshot: yes |
| Palette | `config.get` (`agents`, and the whole configuration for setting values), `session.list` (`search`, `limit: 5`) | assumed | no |

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
| Break-Glass window and affected-person notice (F41) | RPC/CLI, durable self-scoped notices, audited transcript/user-memory reads | Done: request, list with remaining time, revoke (F41); inbox/live notice follows |
| Operator session overview (F42) | `session.list` owner/agent filters, explicit allOwners, owner/model/tokens/cost metadata | Done: filters and owner/model/usage columns (F42); transcripts stay behind Break-Glass |
| Devices, QR payload and remote mode (F44) | Persistent device store, `device.list/revoke/rename`, CLI, `pairing.qr` and `remote.publish` available | Done: QR, device list, rename (own device) and revoke with confirmation that open connections close (F44) |

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
| Users: invite | `user.invite.create`, `.list`, `.revoke` | yes | Built; the code is shown once (F40) |
| Users: role presets, simple mode | `user.list`, `user.role.set` | yes | Built; the last Owner is protected (F40) |
| Users: object rights per agent (use/manage) | `agent.rights.get`, `agent.rights.set` | yes | Built (F40) |
| Users: Member sees only shared agents | `agent.list` (the server decides), `principal.role` from `whoami` | yes | Built: the UI hides what the role may not see and shows a server `E_DENIED` as forbidden |
| Break-glass dialog (reason, window, notice) | `breakglass.request`, `.list`, `.revoke` | yes | Built (reason 10 to 500 characters, 1 to 60 min, "the person concerned is notified"); running windows with remaining time and revoke (F41) |
| **Settings** routed sections, forms, restart class, diff before save | `config.get` (`key`, `tier`; returns `restartClass`, `revision`), `config.set` (`dryRun`, `ifRevision`) | yes | Built. Titles, help and enums come from the static index of the schema (no schema RPC; F17) |
| **Secrets** list, create, rotate, delete | `secret.status`, `secret.list`, `secret.set`, `secret.delete` (`secret.get` is never called with `reveal`) | yes | Built |
| **Sessions overview** | `session.list` | yes | Built: owner/agent filters and owner, model, usage columns for operators; Member sees own sessions (F42) |
| Sessions: transcript via break-glass | `breakglass.request` | yes | Same dialog; transcripts only while a window is active (F41) |
| **Log viewer** query, filters, export | `logs.query` (`stream`, `minLevel`, `component`, `text`, `from`, `to`, `order`, `limit`, `cursor`) | yes | Built. `trace_id` has no parameter: it is matched with `text`; export is the loaded, filtered rows (F43) |
| Log viewer live tail | `logs.tail` (long poll with `waitMs`) | yes | Built over `/rpc`; there is no log event on SSE (F2) |
| **Activity feed** | `logs.query` (streams `audit` and `diagnostic`), `audit.verify` | yes | Built from the log streams only; `jobs.history`, `dreams.log` and `models.list` are not used (F43) |
| Devices / pairing card | `config.get` key `remote.publish`, `pairing.qr`, `device.list`, `device.rename`, `device.revoke` | yes | Built: mode card hidden at `local` and when the key is unknown (Owner/Admin); the QR comes from `pairing.qr`; the device list shows name, platform, paired at/by, last seen and status for everyone (own devices, Owner/Admin all); rename for the device's own person, revoke with a confirmation (F44) |
| **Command palette** entities | `config.get` (`agents`), `session.list`, static navigation, settings, actions and a log-search link | yes | Built as a client fan-out over those lists, capped and abortable (F14 is answered; a server endpoint stays a later option) |
| **Settings: Providers** | `auth.credentials.list`, `auth.status`, `auth.login.start`, `auth.login.await`, `auth.login.cancel`, `auth.logout`, `secret.set` | yes | Built. Replaces unavailable provider login state. Masked secret key entry, headless SSH hint and callback paste flow. Interface wish: `auth.login.callback` RPC for manual callback URL forwarding (F33) |
| **Switchboard** | `channel.list`, `channel.status`, `channel.get`, `channel.enable`, `channel.disable`, `channel.set`, `channel.test` | yes | Built. Channel list and detail, enable/disable toggles, field edit with secret rejection and link to secrets, test channel and test message to owner (`sendOwner: true`). When the channel host is missing, `not-registered` is rendered as "not started (host missing)" without an error state (F34) |
| Grants and approvals (D109, PR #190) | not built | n/a | The existing `approvals` navigation entry stays a placeholder |

Where a page lives: `/agents`, `/agents/new`, `/agents/<id>`; `/settings/<section>` with `general`, `users`, `secrets`, `devices`, `providers`;
`/switchboard` and `/switchboard/<id>`;
`/logs` with the tabs Logs (`/logs`), Activity (`/logs/activity`) and Sessions (`/logs/sessions`); `/setup` (not in the sidebar).

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
  `config.get`, best effort (any failure means no values). Keys whose name contains `key`, `token`, `secret`, `password` or
  `credential` are never indexed with a value. A settings hit navigates to `#/settings?focus=<key>`; the router drops the query and
  the page is a placeholder (F16, F27).

## Tests and verification

```bash
export PATH=/opt/homebrew/bin:$PATH        # or any Node >= 24.16 with pnpm
pnpm --filter @plur1bus/web test           # node:test; all suites run against the mock server
pnpm --filter @plur1bus/web build          # packages/web/dist (PLUR1BUS_WEB_GALLERY=1 adds the gallery)
pnpm typecheck                             # whole repo, includes packages/web
pnpm lint                                  # typecheck, hygiene, check-i18n (not this package, F20), script tests
```

- **Browser suites** (`e2e`, `a11y`, `responsive`, the per-page suites, palette) need Chromium: `PLUR1BUS_CHROMIUM`, Playwright's
  install or `/opt/pw-browsers/chromium`; nothing is downloaded. Without one they are skipped; `PLUR1BUS_WEB_E2E_REQUIRED=1` turns
  that into a failure. `UPDATE_SNAPSHOTS=1` rewrites `test/fixtures/responsive.json`.
- **Coverage.** axe (WCAG 2.1 AA) per page, state and theme; layout checks at 400, 960, 1440 and 2560 px (1024 where a mode changes),
  no horizontal scroll, 200 % text zoom (a 1440 px window becomes a 720 px viewport), keyboard paths, contrast of the tokens.
- **Bundle budgets** (`test/build.test.ts`, gzip level 9): `main.js` 10 KiB, start-up closure (`main.js` plus statically imported
  chunks) 54 KiB, each lazy page chunk 12 KiB, `styles.css` 9 KiB. M3 part 2 raised the start-up closure from 46 (it was 40.0 KiB) and
  `styles.css` from 8 (it was 6.2 KiB) because ten new i18n areas live in the start-up closure (F18); the palette dialog became a lazy
  chunk to keep it down. Measured: start-up closure about 51 KiB, page chunks up to 7.5 KiB, `styles.css` 8.6 KiB. The same test forbids `eval`, `new Function`, inline script or style,
  `javascript:` URLs and remote origins.
- **Screenshots.** Not a test; run by hand, e.g. for a PR:
  `PLUR1BUS_WEB_SHOTS_DIR=<dir> pnpm --filter @plur1bus/web exec node --experimental-strip-types test/shots.ts`. It captures chat,
  memories, dreams, models, usage, doctor, palette, agents, settings (general, users, secrets, devices), logs (viewer, activity, sessions) and setup, light and dark, at 400 and 1600 px, against the mock server with filled
  fixtures; files are `<page>-<hell|dunkel>-<compact|wide>.png`. `PLUR1BUS_WEB_SHOTS_ONLY=chat,doctor` narrows the pages (empty
  means all), `PLUR1BUS_WEB_SHOTS_CHECK=1` also reports overflow, axe violations and targets below 24 px (44 px high below 1024 px),
  `PLUR1BUS_WEB_SHOTS_WIDTHS=400,640,960,1440,2560` replaces the two widths. Screenshots are not committed.

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
- **F9. Provisioning check** (Doctor). There is no RPC or route for `1staid.check/1`; it is printed by `plur1bus 1staid check --json`,
  so the page loads a file the owner picked. A route (read-only, owner) would let the page run the check.
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
- **F23. Wordmark morph** (`V2LogoMorph`).
- **F24. Sidebar.** Projects list and badges.
- **F25. Chat.** Context column, recents, fork, archive (`session.archive`), search (`session.list` with `search`), model selection and
  attachments (the last three need F6), rename and pin (F5).
- **F26. Memories.** Accepting and rejecting proposals (`memory.proposals.accept`, `.reject`), forget and correct (`memory.forget`,
  `memory.correct`), `dreams.schedule.set` (the UI only enables and disables), conflicts, migration (`admin.migrate`). All exist in
  `docs/rpc.md`; the page is read-only for them, with a confirmation flow still to design.
- **F27. State in the URL.** The router drops the query (`#/path?x` is read as `#/path`), so the chosen agent, search text, filters
  and `?focus=` are lost on reload and cannot be linked; the agent choice lives in memory only. (`?theme=` is read separately.)
- **F28. Doctor file picker.** The text of the native file input follows the OS language, not the UI language.
- **F29. Placeholders.** Eight pages (Projects, Inbox, Library, Skills, Plugins, Recurring, Approvals, Help) are placeholders; Switchboard is built.

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
  owner/agent filters and explicit `allOwners`. Operations roles may list metadata; Member sees own only. Costs/models join
  the existing budget ledger; unknown/pending costs remain null. Transcripts and foreign transcript search are protected.
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
| Wire types (temporary) | `src/api/media-search.types.ts` | — | — |
| Rules (pure: captioning preselection, validation mirror of E_MEDIA_*, config changes against the defaults, query params, time labels) | `src/pages/media-search/model.ts` | all of the below | — |
| Setup, media part of the Memory step | `src/pages/media-search/setup.ts` | `/setup`, step Memory (the wizard model `setup/model.ts` carries the answers as `media`) | `config.set` on Next, only for values that differ from the defaults |
| Memory settings panel (text and media index side by side, video and audio options, captioning, backfill, status card with pause, resume, re-index) | `src/pages/media-search/settings.ts` | `/settings/memory`, above the form | `config.get`, `config.set` (`ifRevision`), `media.index.status`, `media.index.pause\|resume\|reindex` |
| Per-agent override | `src/pages/media-search/override.ts` | agent detail | `config.get`, `config.set` (`agents.<id>.memory.mediaEmbedding.*`) |
| Search in the Media view, "Find similar" button, hits with segment and jump, caption edit | `src/pages/media-search/search.ts` | Media view | `media.index.status`, `media.search`, `media.caption.set`, `media.output.get` (playback) |
| Typed RPC methods (merged into `RpcMethods`) | `src/pages/media-search/rpc-types.ts` | — | — |
| Texts (de and en, one area) | `src/i18n/mediasearch.ts` | — | — |

Registration lines in existing files (each is one line or one import): `src/i18n/index.ts` (area), `src/pages/setup/model.ts` (the
`media` answer, its loading, the memory validation and the change list), `src/pages/setup/page.ts` (the memory step renders the media
part and passes the error), `src/pages/settings/page.ts` (the panel above the Memory section), `src/pages/agents/detail.ts` (the
override), `src/pages/surfaces/media.ts` (the search and the "Find similar" button per medium).

### Rules the components rely on

- **Free provider choice.** Text and media providers are chosen independently; there is no combination list. Validation checks only
  capability (the media provider must take every chosen modality, so OpenAI can only be the text index), licence (a non-commercial
  model needs its confirmation, `E_MEDIA_LICENSE`), privacy pin (`E_MEDIA_PRIVACY`) and availability. The pin is not in the wizard's
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

### Follow-ups (media search)

- **F47. Generated RPC types.** Replace `src/api/media-search.types.ts` and the merge in `rpc-types.ts` with the generated types, once
  the backend's `media.*` methods and `memory.mediaEmbedding.*` keys are in `rpc.schema.json` and `config.schema.json`. Until then
  the hand-written copy is the only definition here; a drift test against the schema would then replace the review.
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
- **F53. Privacy pin.** The setup only explains the pin. The Settings panel does not show whether it is set; the server's refusal
  (`E_MEDIA_PRIVACY`) is the only signal.
- **F54. Size.** The contract's catalogue has no size; the forms show "not stated". A size field would make the setup's "Größe" useful.
- **F55. Playback test.** The browser test checks the `#t=` fragment and `data-start`, not actual playback.
