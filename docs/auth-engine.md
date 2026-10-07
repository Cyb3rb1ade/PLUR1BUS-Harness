# Auth engine (core)

`packages/core/src/auth/` implements ADR-005's generic login and credential engine.
Flows are in-process APIs, driven by validated profiles. No new RPC or CLI command
is introduced here. M2 acceptance 1's **engine** returns the method used; CLI
presentation remains a follow-up. D110 OpenAI registration/wire behavior is excluded.

## P1: baseline inventory

Inventory on `origin/main` at `c82d7469` (before this change); “partial” means a
port/planner or fake-only behavior existed, not a working login.

| ADR-005 requirement → M2 acceptance | On main? | File / baseline test; work in this PR |
|---|---|---|
| Four kinds and delegated vendor CLI | Yes, types and lease dispatch | `profile.ts`, `credentials.ts`; `profile.test.ts`, `credentials.test.ts` |
| Profiles as data; mandatory policy status/source/date; prohibited never loadable → 7 | Yes; flow validation partial | `profile.ts`; `profile.test.ts`; extend aliases/nested validation and gate direct callers |
| Authorization Code + PKCE S256, IPv4 loopback | No | `ladder.ts` only planned it; new `login.ts`, `login-flows.test.ts` |
| Headless device → SSH loopback → explicit paste → 1 | Planner only | `env.ts`, `ladder.ts`; `ladder.test.ts`; execute in `login.ts` |
| RFC 8628 device authorization/polling | No | new `login.ts`; `login-flows.test.ts`, `flow-security.test.ts` |
| Google ADC / service-account credentials | Port only | `credentials.ts` `AdcTokenSource`; new `adc.ts`, `adc-http.test.ts` |
| Token endpoint refresh, rotation → 2 | Owner + fake only | `refresh.ts`, `refresh.test.ts`; new `http.ts`, local OAuth end-to-end tests |
| Single refresh owner, persist before releasing callers, restart → 2 | Partial; failed writes released in-memory token | `refresh.ts`, `secret-store.ts`; harden persistence failure, bridge existing secrets API |
| Proactive refresh with skew | On lease request only; no timer/jitter/backoff | `refresh.ts`; `refresh-schedule.test.ts` adds timer/jitter/backoff |
| Pools, classified cooldown, one authority | Yes | `pool.ts`, `pool.test.ts`; unchanged |
| Short-lived secret leases / OS store | Existing separate secrets service; auth fake only | read-only `../secrets/store.ts`; bridge in `secret-store.ts`, `adc-http.test.ts` |
| Secret-free logs/errors/snapshots → 8, auth scope | Partial; leases safe, OAuth records exposed to inspection | `redact.ts`, `redaction.test.ts`; harden records, responses and prompts; `flow-security.test.ts` |
| Logout/revocation/audit | No auth lifecycle API | follow-up with CLI/RPC ownership wiring; existing secret audit is reused |
| D12 Anthropic routes / D13 CLI backends | `external_cli`/API-key shapes only | follow-up provider routes; no harness-native Claude login or vendor token-store reads |
| D110 OpenAI-specific registration/voice/workload flows | No | explicitly excluded; design read only to establish boundary |

## Ports and usage

| Port/API | Purpose |
|---|---|
| `login(options)` | Execute OAuth login, persist one complete record, return `{ profileId, method, expiresAt }` |
| `createOAuthHttp({ egress })` | Form-encoded token/device POST; egress gate, vetted IP, TLS host verification, no redirects, 30 s deadline, 64 KiB response limit |
| `HttpRefresher(http)` | RFC 6749 refresh adapter **behind** `RefreshOwner` |
| `createAuthSecretStore(existingSecrets)` | Existing secrets API: read/revoke a core lease; audited owner set/delete; no direct backend access |
| `GoogleAdc({ http, clock, env, readFile, homedir, platform })` | Injectable ambient Google token source for `CredentialsProvider` |
| `Clock`, `RefreshTimer`, `random`, `sleep` | Deterministic expiry/jitter/polling tests |
| `AuthLog` | IDs, method names and classifications only |

Use one credentials provider/refresh owner per core, not one per turn. It schedules
proactive refresh after a credential is first acquired; a caller activating stored
profiles may prime them via `getAuthorization` at startup. `close()` cancels owner
timers on shutdown. Network, filesystem and browser ports remain explicit; the core
entry point's activation and login command wiring are follow-ups.

## Profiles

Kinds remain `api_key`, `oauth_pkce`, `device_code`, `adc`, `external_cli`.
`validateProfile`/`loadProfiles` refuse prohibited profiles, unknown fields, malformed
scopes/redirect/refresh records, credential-bearing or non-HTTPS endpoint URLs
(except explicit loopback HTTP), header injection, and missing policy metadata.
Login, HTTP refresh, ADC and credentials-provider construction also validate profiles.

| Field | Meaning |
|---|---|
| `authorizeUrl` / legacy `authorization_endpoint` | Authorization endpoint for PKCE |
| `tokenUrl` / legacy `token_endpoint` | Token endpoint for code/device/refresh/ADC exchange |
| `deviceUrl` / legacy `device_authorization_endpoint` | Documented RFC 8628 endpoint; its presence enables the device ladder step |
| `client_id`, `client_registration` | Caller-provided registration; no vendor client IDs ship. `dynamic` registration is refused at execution; D110 modes are not accepted |
| `scopes` | Array of OAuth scope tokens, sent space-separated |
| `pkce` | Optional declaration `S256`; execution always uses S256 |
| `redirect` | `{ type: "loopback", port?: 0..65535 }`; login always binds a random available port; legacy port metadata is never a fixed bind |
| `audience` | Optional OAuth audience; ADC JWT audience defaults to its token endpoint |
| `refresh` | `{ mode: "rotating" \| "static", refresh_skew_seconds?: number }`; default skew 120 s |
| `secret_ref` | Handle for one complete OAuth record, never a token |
| `policy_status/source/checked` | Required as `policy_status`, `policy_source`, `policy_checked`; ISO date; prohibited fails the entire catalogue load |

Legacy and canonical endpoint aliases may coexist only if equal. This PR ships no
vendor catalogue entries and implements no provider-specific request fingerprints.

## Login and headless ladder

`planLogin` uses the existing `canOpenGraphicalBrowser`/`isRemoteSession` predicates.
SSH and remote markers win over a display. `login` executes the selected method:

| Environment/profile | Method |
|---|---|
| Graphical PKCE | `loopback_pkce`; injected `openBrowser` |
| Headless with documented device endpoint | `device_code`; injected `onDevice` presents user code and verification URI |
| Headless PKCE without device endpoint | `loopback_ssh`; `onAuthorization` receives authorization URL and `ssh -L <port>:127.0.0.1:<port> <this-host>` |
| Explicit `pasteCallback: true` | `paste_callback`; `readCallback` supplies the full redirect URL |

The plan includes ordered fallback choices. A caller explicitly retries a fallback
(e.g. paste when forwarding is unavailable); a denial, wrong state or timeout never
silently starts a different login. API-key entry, delegated CLI login and ADC setup
remain separate operations, not OAuth flows through `login`.

Every PKCE attempt creates random state and a 43-character verifier with SHA-256
challenge. The listener binds **only `127.0.0.1`**, random port, callback path
`/auth/callback`. Only one callback is accepted; wrong state aborts; state and code
must occur exactly once. Paste checks the same origin/path/state/code and PKCE
exchange. Success, timeout (default ten minutes), cancellation and errors close
the listener. Browser error pages contain only fixed text and no callback details.
Authorization URLs and user codes are explicit UI-port values, redacted under
JSON/inspection; no device code is exposed to the UI.

Device polling uses the server interval (default 5 s), waits before the first poll,
continues on `authorization_pending`, adds **5 s permanently** on `slow_down`, and
stops on `expired_token` or `access_denied`. Transient connection failures back off;
server expiry, overall timeout and abort signal bound the flow.

## Google ADC

Credential discovery first uses `GOOGLE_APPLICATION_CREDENTIALS`, otherwise
`~/.config/gcloud/application_default_credentials.json` on macOS/Linux or
`%APPDATA%\\gcloud\\application_default_credentials.json` on Windows (home-based
AppData fallback). FS/env/home/platform are injectable; tests never read real files.

`authorized_user` exchanges the file's refresh token, client ID and client secret.
`service_account` signs an RS256 JWT with `node:crypto` (`iss`, `scope`, `aud`, `iat`,
`exp`, one-hour lifetime), then uses the JWT-bearer grant. Both exchange through the
same guarded HTTP port and cache until the refresh skew, sharing one in-flight
exchange. ADC never imports credential files into the harness secret store and
never logs file paths/content, client secrets, signing keys or assertions. Rotated
ADC refresh tokens are retained in memory; Google ADC normally has static refresh
tokens. This engine does not rewrite gcloud files; unusual rotating ADC grants do
not persist rotation across restart. Metadata-server and external-account ADC are
not implemented here.

## Refresh, rotation and errors

The existing `RefreshOwner` is the only authority. Parallel turns and background
timers join one per-credential flight. Refresh POSTs use `grant_type=refresh_token`.
A supplied replacement refresh token replaces the old one in the **same single
secret write** as access token/expiry/generation. A missing replacement preserves
the old token. Successfully persisted rotation survives a new owner/core restart.

Refresh is scheduled before expiry with profile skew plus 0–30 s early jitter
(capped to one quarter of skew). Temporary failures use exponential backoff from
1 s to 60 s plus up to 1 s jitter; turns respect the same deadline. A still-valid
access token remains usable; an expired one raises a retryable error. Invalid
refresh grants set persistent `reauthRequired` and stop background retries.

| Error/class | Behavior |
|---|---|
| `reauth_required` (`invalid_grant`/known refresh expiry) | Stop refresh; sign in again |
| `refresh_failed` / transient network, 408/429/5xx | Shared backoff; retryable, `retryAfterMs` |
| `persist_failed` | No successful login/rotation is released before storage succeeds |
| `state_mismatch` | Abort callback; no token exchange |
| `access_denied` | Stop login; no automatic fallback |
| `login_timeout` | Device expiry, timeout or cancellation; listener closes |
| `login_failed` | Fixed-text failure; no foreign response/error details |
| `adc_unavailable` | ADC discovery/signing/exchange failure, fixed text |

If storage fails **after** a vendor rotates, the owner retains the new record and
retries the write on next access without spending it again. Restart during that
storage outage can lose this in-memory recovery record and require re-login;
there is no safe unencrypted fallback. HTTP errors never retain response bodies
or causes. OAuth records, transport responses, tokens, leases and UI prompts have
redacted inspection/JSON; only explicit persistence and provider access reveal
secret values. This verifies acceptance 8 for auth outputs, not unrelated exports
or backup pipelines.

## Pools and follow-ups

Pool strategies and cooldowns remain `fill_first`, `round_robin`, `least_used`.
Confirmed exhaustion cools credentials; ambiguous errors may cool only a model;
interactive turns and cron share this authority. A stale 401 cannot invalidate a
new token generation. Existing pool/lease tests continue to run.

Follow-ups: `plur1bus login` CLI and `auth.*` RPC (method display and surface/owner
authorization); core startup/shutdown wiring; logout/revocation lifecycle; D110
OpenAI registration and wire profiles; Anthropic routes D12 (delegated Claude Code,
restricted user-obtained setup-token, API key), D13 CLI backends; dated vendor
policy catalogue/rechecks. No harness-native Claude.ai or prohibited Google
subscription login is enabled by this change.
