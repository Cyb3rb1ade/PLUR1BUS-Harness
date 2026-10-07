# Web UI pages and API usage (`packages/web`)

`@plur1bus/web` is the M3 web UI skeleton: the shell of [`ui/web-shell.md`](ui/web-shell.md) plus five real pages (Chat, Memories &
Dreams, Models, Usage & Quota, Doctor), a command palette (⌘K / Ctrl+K), a typed API client and mock servers for tests. Every other
nav item is still a placeholder. The package stays a static build (`index.html`, `main.js`, lazy page chunks, `styles.css`) under
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
| `/projects`, `/agents`, `/inbox`, `/library`, `/skills`, `/plugins`, `/switchboard`, `/recurring`, `/approvals`, `/logs`, `/settings`, `/help` | placeholder | as in `nav.ts` | none (fixed text `page.placeholder`) | `PlaceholderPage`. `/settings` is the target of palette settings hits. |
| `/login` | Sign-in | none | form errors only | Owner token against `POST /api/v1/session`; see `ui/web-shell.md`. |
| any other path | 404 | none | n/a | Link back to the landing route. |
| ⌘K / Ctrl+K, `/` | Command palette | overlay | n/a | Only while signed in and on a page (not on `/login`). |
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
| Palette | `config.get` (whole configuration, for the current values of settings; best effort) | assumed | no |

No page sends a `caller`: a browser never asserts identity or trust (the `memory.*`, `session.*`, `models.*`, `budget.*`,
`dreams.*`, `core.status` and `config.get` calls all omit it; see F1). Event consumers accept an SSE message either named
by its `event:` field or as a JSON-RPC notification object whose `method` is the name (memories, models); chat requires
`event: session.event` with `data: { event: SessionEvent }`.

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
| Agents: pause | no lifecycle RPC (`agent.close` closes the runtime, it is not a pause) | **no** | `unavailable` (F39) |
| Agents: archive, delete (archive-first, export offer, typed name), export bundle without secrets | none | **no** | `unavailable`; the confirmation dialog is built and tested but sends nothing (F39) |
| **Users & roles**: list, create | `identity.list`, `identity.human.create` | yes | Built |
| Users: pairing codes, link, unlink | `identity.pair.start`, `.claim`, `.confirm`, `identity.link`, `identity.unlink` | yes | Built |
| Users: invite | none | **no** | Pairing code is the closest; no invite (F40) |
| Users: role presets, simple mode | none to assign; presets are static text from `docs/rbac.md` | **no** (assign) | Presets and simple mode built as display; assignment `unavailable` (F40) |
| Users: object rights per agent (use/manage) | none | **no** | `unavailable` (F40) |
| Users: Member sees only shared agents | `agent.list` (the server decides), `principal.role` from `whoami` | yes | Built: the UI hides what the role may not see and shows a server `E_DENIED` as forbidden |
| Break-glass dialog (reason, window, notice) | `breakglass.request`, log read | **no** (library only, `docs/rbac.md`) | Dialog built (reason 10 to 500 characters, 1 to 60 min, "the person concerned is notified"); submit shows `unavailable` (F41) |
| **Settings** routed sections, forms, restart class, diff before save | `config.get` (`key`, `tier`; returns `restartClass`, `revision`), `config.set` (`dryRun`, `ifRevision`) | yes | Built. Titles, help and enums come from the static index of the schema (no schema RPC; F17) |
| **Secrets** list, create, rotate, delete | `secret.status`, `secret.list`, `secret.set`, `secret.delete` (`secret.get` is never called with `reveal`) | yes | Built |
| **Sessions overview** | `session.list` | yes, own sessions only | Partial: metadata of the caller's own sessions (no owner, model or usage fields in `SessionRecord`). The all-users operator view and usage per session have no RPC (F42) |
| Sessions: transcript via break-glass | `breakglass.request` | **no** | Same dialog, `unavailable` (F41) |
| **Log viewer** query, filters, export | `logs.query` (`stream`, `minLevel`, `component`, `text`, `from`, `to`, `order`, `limit`, `cursor`) | yes | Built. `trace_id` has no parameter: it is matched with `text`; export is the loaded, filtered rows (F43) |
| Log viewer live tail | `logs.tail` (long poll with `waitMs`) | yes | Built over `/rpc`; there is no log event on SSE (F2) |
| **Activity feed** | `jobs.history`, `dreams.log`, `models.list`, `logs.query` with `stream: "audit"`, `audit.verify` | yes | Built |
| Devices / pairing card | `config.get` key `remote.publish` | **no** (key is not in the config schema on main) | Card hidden at `local` and when the key is unknown; paired devices, QR or deep link, fingerprint and remove have no API (F44) |
| **Command palette** entities | `GET /api/v1/agents`, `agent.list`, `session.list`, `logs.query`, static navigation, settings and actions | yes | Built as a client fan-out over those lists, capped and abortable (F14 is answered; a server endpoint stays a later option) |
| Grants and approvals (D109, PR #190) | not built | n/a | The existing `approvals` navigation entry stays a placeholder |

Where a page lives: `/agents`, `/agents/new`, `/agents/<id>`; `/settings/<section>` with `general`, `users`, `secrets`, `devices`;
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
  chunks) 46 KiB, each lazy page chunk 12 KiB, `styles.css` 8 KiB. Measured on this branch: start-up closure 40.0 KiB (`main.js`
  8.2 KiB), page chunks 4.7 to 7.9 KiB, `styles.css` 6.2 KiB. The same test forbids `eval`, `new Function`, inline script or style,
  `javascript:` URLs and remote origins.
- **Screenshots.** Not a test; run by hand, e.g. for a PR:
  `PLUR1BUS_WEB_SHOTS_DIR=<dir> pnpm --filter @plur1bus/web exec node --experimental-strip-types test/shots.ts`. It captures chat,
  memories, dreams, models, usage, doctor and palette, light and dark, at 400 and 1600 px, against the mock server with filled
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

- **F14. Search across entities** (palette). The palette finds navigation entries and settings only. Agents, Switchboard, memories,
  sessions and actions need a search endpoint or a client fan-out: owner decision (milestones M3, desktop spec §13.3 B11).
- **F15. Voice input** for the palette search (same scope as F14; nothing is implemented).
- **F16. Settings page.** `/settings` is a placeholder; the palette navigates to `#/settings?focus=<key>`, which the page must
  evaluate once it exists (scroll to and focus that setting).
- **F17. Localised setting labels and help.** The schema has no titles; labels are derived from the key and help is English. Needs
  schema titles or an owner-approved UI catalogue.
- **F18. i18n catalogues per page.** All areas are in the start-up closure (40.0 KiB gzip, budget 46 KiB; the target of ADR-004 was
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
- **F29. Placeholders.** Twelve pages (Projects, Agents, Inbox, Library, Skills, Plugins, Switchboard, Recurring, Approvals, Logs,
  Settings, Help) are placeholders.
