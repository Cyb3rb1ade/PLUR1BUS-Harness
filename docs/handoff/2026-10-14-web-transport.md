# Web transport handoff — 14 October 2026

Repository: Cyb3rb1ade/PLUR1BUS-Harness. Fresh origin/main worktree, branch codex/web-transport-1014. No force/rebase/amend/stash, no CI polling, no edits in the primary checkout or backup. No new dependencies or engine/lockfile changes. PR and complete validation results are filled in at completion.

## Inventory and decisions

- The existing API used one lazy shared CoreClient with no person context. The core's default local-token resolver was LOCAL_OWNER. REST routes had API-side authorization but their underlying core calls did not carry their actual user.
- config.get/set are supervisor methods; the core's ConfigSource watches that supervisor and uses its own internal writes. Web config calls now go directly to the supervisor with API delegation. The supervisor resolves the current person through core.auth's local-only API extension on each request.
- NotifyOptions already accepted legacy strings, connectionId and personId. The local wire omitted that audience, and the inbox producer withheld events from every subscriber when any subscriber was another person. It now addresses matching connections individually; API-only notifications carry delivery metadata through filtering/replay.
- A new separate private API credential registers clientId harness-api with the core. Delegated connections carry a principal on every request and cannot switch person/kind. The core resolves stored roles and rights; unknown users, missing principals and agents never become the local Owner or a person.
- API session bootstrap owner maps to local-owner only when the actual authenticated session is the bootstrap Owner. Directory user ids cannot obtain that alias by matching the string owner. REST Core calls are request-scoped, including kind/scopes for token agents.
- All RPC POSTs use existing CSRF because the schema has no read/write annotations. Existing Origin/Fetch-Site/Host gates remain. Body default: 1 MiB for RPC, existing configurable override. One request, no batches. Errors retain Core codes, HTTP 200, fixed text, no stacks/details/ids.
- Explicit reviewed method/event lists; Core Guard/RPC_RULES unchanged. Internal/supervisor lifecycle/subscriptions/backup/import/secret reveal/raw caller-memory paths excluded. Unguarded legacy methods have conservative Core API admission. Some pages will therefore show denials until their owning backend gaps are resolved.
- SSE has person-bound bounded replay, stale-cursor restart, 25s comment heartbeat, eight streams/person, queued-output cap, session invalidation/expiry closure and no idle renewal. Disconnect permits a two-minute resume window; logout drops that session’s replay; rights invalidation drops all feeds of that person.
- Supervisor config policy walks changed annotated descendants, supports parent replacement, inherits sensitivity, invalidates old provider/endpoint acknowledgments and records actual acknowledgment writers. Audit intents are durable before mutation; an I/O failure can leave a prepare record whose targetRevision never became live.

## Threat table

See the complete [transport threat model](../security.md#browser-transport-threat-model), with attack → protection → test mappings.

## Behavior changes

The browser's existing paths now answer real RPC/SSE. Read RPCs retry with CSRF. RPC application errors use HTTP 200. Authenticated sessions have separate local connections and replay histories; unknown users fail closed. Logout and expiry terminate streams. Legacy unguarded methods become more restrictive over HTTP. Config annotation checks and audit happen in the supervisor, with current authoritative roles. Existing ordinary local clients preserve their compatibility behavior; their OS-user trust boundary remains documented.

## Owner questions and prerequisites

1. PR #426 is currently an open Draft. Its new x-write-roles/x-audit keys and the active-person callback must be integrated before acceptance against those exact features. The user was asked whether to wait for its merge or integrate that branch into this worktree; that authorization remains pending. No merge of #426 was performed.
2. Is same-OS-user credential separation the intended boundary for the API broker? A hostile process with the same file permissions can read api-delegation.token. Stronger isolation needs an OS broker/separate user or equivalent attestation; none is invented here.
3. Which production adapter provisions a password account from a redeemed invitation and persists the API UserDirectory? Existing API ports support password/TOTP and per-request disable/version checks, but the standalone entry has no durable account adapter. E2E uses the real Core invitation and a supplied account directory, not invented credentials in the Core.
4. Which authoritative active/disabled-person source should the #426 recurring-job resolvePerson callback use? The current Core registry has roles/rights and presence, but no general disabled field. HTTP checks the supplied directory on each request and ends streams through rightsChanged/expiry; a missing server-side state cannot be fabricated.
5. Cookie ownership authenticates an account; it cannot prove the action was physically initiated by a human. WebMCP exclusion and conservative existing surface trust remain necessary. No automatic T2/T3 elevation or OS confirmation was added.

## Conflict hotspots

Sonnet security: server.ts route dispatch, session.ts entry removal, rate-limit.ts class union, route/OpenAPI classification tests. Wiring is kept in separate small commits; new logic lives in new files. rbac/Guard/RPC_RULES, webmcp, identity/switchboard, hostctl and remote-access source are untouched. Core integration is limited to principal/auth/secret-writer binding, admission of API legacy calls and targeted inbox RPC notification. Supervisor config.rs/server.rs and additive helper modules belong to this package. #426 may overlap Core auth integration, schema/generator outputs and appended documentation; normal merge is required, preserving the security logic.

## Validation

Pending final workspace checks. Already passed: complete API suite (627 pass / 8 existing TODOs), complete module-api suite (101 pass), actual socket delegation/marker tests, actual API/Core two-person invitation/RBAC/CSRF/SSE/replay/logout test, stream-limit/expiry tests, three Rust config-policy/audit tests, and forced Chromium real API/Core/Supervisor smoke for Inbox/Chat list/Settings read. CI was not polled.
