# Harness API: authentication and hardening

Status: M3, authN slice. Authorities: ADR-004 (*Harness API*, *CSP*), ADR-007 (*Authentication*, *Enforcement*, *Privacy*),
`docs/milestones.md` §M3 (acceptance 3, 4, 5). Code: `packages/api/src`. The route table, with the RBAC action every route
needs, is generated into [api-surface.md](api-surface.md) and [openapi.json](openapi.json); this page is the behaviour
behind it.

The API is the only listening TCP surface, loopback only. It is a peer client of the core (local RPC), not part of the core
process. It reuses the core's pure RBAC (`authorize`, the policy table, the break-glass registry) and the core's hash-chained
audit log; see *Follow-ups* for how that import is done today.

## Ways in

| Way | For | Credential | Gets |
|---|---|---|---|
| Owner token | bootstrap, the installation owner | `run/api-owner.token` (0600), `POST /api/v1/session {"token"}` | session cookie, role `owner` |
| Password (+ TOTP) | local accounts | `POST /api/v1/session {"username","password"}`, then `POST /api/v1/session/totp` when a second factor is on | session cookie |
| Personal API token | CLI, scripts | `Authorization: Bearer plb_<id>_<secret>` | one request at a time, no cookie |

A token is accepted only on the routes marked `session or token` in the surface map (today `health`, `whoami`,
`agents.list`). Everything that manages credentials (sessions, tokens, TOTP, break-glass) takes the session cookie only, so a
stolen token cannot mint another one or switch off a second factor. The core's RPC token is never accepted.

## Passwords

Argon2id through `node:crypto` (no dependency), as a PHC string `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>`: 19 MiB, 2
passes, 1 lane, 16-byte salt, 32-byte tag. ADR-007 defers the parameters to ADR-005, which states none; these are the OWASP
minimum for Argon2id and are a decision to confirm. A stored hash is only trusted inside bounds (8 MiB to 256 MiB, 1 to 10
passes, 1 to 4 lanes), so a planted record cannot make a login allocate gigabytes. After a good login a hash made with other
parameters is replaced by one made with the current ones.

- **Constant work.** An unknown name, a disabled account and an account without a password each cost one Argon2id
  verification against a dummy hash, and answer exactly like a wrong password (`401`, `reason: invalid-credentials`).
- **Lock.** Per account *name*, known or not: 5 failures, then the name is locked for 30 s, doubling per further failure up
  to 15 min (`429`, `reason: locked`, `Retry-After`). Because it applies to names that do not exist alike, it is no oracle. A
  locked name refuses even the right password until the time is up.
- **Bucket.** On top, the `auth` rate class (below) limits login attempts per address, whatever the names (spraying).

## Sessions

Cookie `plur1bus_session` (`__Host-plur1bus_session` over TLS): `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` over TLS,
no `Domain`. The value is 256 random bits; the server keeps only its SHA-256, in memory.

- **Expiry.** Idle 30 min (each use pushes it out) and absolute 12 h; at most 64 live sessions, the oldest goes first.
- **Fixation.** A cookie the login request carries is ended and never becomes the logged-in session; the new value is always
  fresh. The same holds for the TOTP step.
- **Rights are read per request.** The role and object rights come from the user directory on every request, never from the
  session, so a demotion applies at once and a disabled or deleted account loses its session at its next request.
- **Rotation.** When the user's record changes (role, rights, password) or the host calls `rightsChanged(userId)`, the
  next request gets a new cookie value, the old one dies, pending CSRF tokens are dropped and the lifetime is not extended.
- **Logout.** `DELETE /api/v1/session` ends the session on the server; `DELETE /api/v1/sessions` ends every session of the caller.

## CSRF

Writes need a one-time token from `GET /api/v1/csrf`, sent in `X-CSRF-Token`: bound to the session, valid once, 10 minutes,
at most 16 pending. It is spent before any rotation. Besides the token:

- `Origin`, when present, must be one the API issued; `Sec-Fetch-Site` must be `same-origin` or `none`.
- A write that carries a `Referer` must name the API's own origin (also when `Origin` is fine). Reads may carry any `Referer`.
- Login has no session to bind a token to; it relies on those checks, `SameSite=Strict` and a JSON-only content type.
- These checks run before the rate limiter, so a hostile page cannot drain the owner's buckets.

A request without `Origin` and `Referer` is a non-browser client and passes these two checks (the token is still needed).

## Personal API tokens

`plb_<12 hex id>_<43 base64url secret>`. The secret is 256 random bits; only its SHA-256 is stored, and the full string is
shown once, in the answer to `POST /api/v1/tokens`. A list shows id, prefix, name, scopes, times and last use, never a hash.

- **Scopes** are RBAC action names or `prefix.*` (`agent.*`), validated against the policy table. They can only narrow: on
  every use `authorize` intersects the user's *current* role with the scopes, so a token is never more than its user (a
  member's `settings.write` token is refused; a demotion shrinks the token; a disabled account kills it).
- **Principal.** A token acts as an *agent* principal, so it can never hold a human-only action (`grant.*`, `approval.*`).
  Object rights (which agents a member sees) still apply through it.
- **Lifetime.** 1 hour to 365 days, 90 by default; at most 50 live tokens per user; `lastUsedAt` is written at most once a minute.
- **No CSRF token** is needed (a browser never attaches `Authorization` by itself). A bad `Bearer` value is a `401` with no
  fallback to a cookie; the word `Bearer` always means a token.
- Routes: `GET /tokens`, `POST /tokens`, `POST /tokens/revoke`. Revoking is immediate; revoking someone else's token or an
  unknown id is the same `404`.

## Second factor (TOTP)

RFC 6238 over RFC 4226, SHA-1, 6 digits, 30 s: what every authenticator app supports; checked against the RFC test vectors.

1. `POST /me/totp/setup` returns a fresh 160-bit secret and its `otpauth://` URI (shown once). Nothing is on yet.
2. `POST /me/totp/confirm {"code"}` with a code from that secret turns it on and returns 10 one-time backup codes, once;
   they are stored as hashes. A live second factor is never replaced silently (`409 totp-enabled`).
3. A right password for an account with a second factor answers `session.challenge/1` and sets **no cookie**. The
   challenge is one-time, valid 5 minutes, dies after 5 wrong codes and is bound to the user's record version.
   `POST /session/totp {"challenge","code"}` turns challenge and code into the session (which also records a step-up time).
4. `POST /me/totp/disable {"code"}` needs a valid TOTP or backup code.

A window of one step either side; all candidates are compared in constant time; a code from a step at or before the last
accepted one is a replay and refused (the code that confirmed enrolment is spent too). A backup code works once.
Brute force is bounded **per user** on the `totp` rate class, so a fresh challenge (which only needs the password) does not
reset it. The owner-token login has no account and no second factor; its routes answer `409 no-account`.

## Authorization

Every route declares what it needs (`authz` in the route table): `public` (the two login steps), `authenticated`, or an RBAC
action. The dispatcher builds the principal from the user directory and calls core's `authorize(principal, action,
resource)`. A route without a declaration answers `403 undeclared-route` whoever calls it. `authenticated` (any live
principal) is for session handling only (`whoami`, `csrf`, logout, log out everywhere), so a Viewer can still see who it is and
sign out; a test names exactly those routes. `health` needs `doctor.read` (Owner, Admin, Operator). `agents.list` shows only
the agents the caller holds `agent.read` on (acceptance 3). A denied write is audited with the action and the reason.

## Rate limits

Token buckets, per address and per identity (the session's principal or the token), per route class. `429`, `Retry-After`
in whole seconds, `reason: rate-limited`.

| Class | Capacity | Refill | Used by |
|---|---|---|---|
| `auth` | 5 | 1 per 12 s | login |
| `totp` | 5 | 1 per 60 s | second step, confirm, disable (also per user on the second step) |
| `read` | 120 | 20 per s | reads, static files |
| `write` | 30 | 5 per s | writes |
| `stream` | 6 | 1 per 5 s | reserved for SSE/WebSocket connections (no such route yet) |

Forwarding headers (`X-Forwarded-For` and the like) are not trusted; the address is the socket's.

## Headers and the web app

Every response, errors and malformed requests included, carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Permissions-Policy` (camera, microphone, geolocation, payment off), COOP/CORP `same-origin`,
`Cache-Control: no-store`, and over TLS HSTS. No response grants CORS.

- JSON and assets: `Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- The app shell (`webRoot` / `--web-root`, normally `packages/web/dist`) is served read-only below `/`, never under `/api`,
  with `default-src 'self'; script-src 'nonce-<N>' 'strict-dynamic'; style-src 'self' 'nonce-<N>'; img-src 'self' data:;
  font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. `<N>` is
  128 fresh random bits per response. It reaches the page at delivery time: every `<script>` and `<style>` tag without a
  nonce gets one and `__CSP_NONCE__` is replaced, so `packages/web` is not touched. No `unsafe-inline`, no `unsafe-eval`.
- Paths are cleaned (dot segments, encodings, backslashes, NUL, dotfiles, drive and stream colons, trailing dot or space) and
  symlinks must resolve inside the root. A path whose last segment has no extension is a client-side route and gets the shell;
  a missing file or anything under `/api` is a JSON `404`. Static requests pass the same Host, Origin and rate gates.

## Break-glass

`POST /breakglass {"targetUserId","reason","ttlMinutes"?}` (Owner, Admin; cookie session only) on core's registry. The reason
is mandatory (10 to 500 characters), the window is 1 to 60 minutes (15 by default), and the grant exists only after its audit
entry was written: with no audit sink, or one that fails, the answer is `503 audit-unavailable` and there is no grant. The
affected user can read the grant (who, why, until when) at `GET /me/notices`, and `notifyBreakGlass` is called for delivery
over other channels (a throwing hook is audited, the grant stands). Grants end by themselves; lapsed ones are swept and
audited twice a minute and on every list. `GET /breakglass` lists the caller's live grants; `POST /breakglass/revoke
{"grantId"}` ends one (its holder or an Owner). A live grant is honoured by every `authorize` the dispatcher makes, and each
use is audited; the memory routes that would use it are not built yet.

## Audit

Written to the core's hash chain (`logs/audit-chain.jsonl`, see [audit-chain.md](audit-chain.md)), shape
`{at, actor:{user,host:"api"}, action, target, detail}`. Never a password, a token, a code, a cookie, a header or the name a
caller typed (a failed login records a stable hash of it).

| Action | When |
|---|---|
| `auth.login.success`, `auth.login.failure` | a login (`detail.via`: owner-token, password, password+totp, password+backup) |
| `auth.logout`, `auth.logout-all`, `auth.session.rotated` | session ends or changes cookie |
| `auth.token.created`, `auth.token.revoked`, `auth.token.used-denied` | token lifecycle; a refused token (throttled) |
| `auth.totp.enabled`, `auth.totp.disabled`, `auth.totp.failure`, `auth.totp.backup-used` | second factor |
| `auth.rate-limited`, `auth.csrf-refused` | throttled to one per actor and target per minute |
| `auth.denied` | a refused write (method other than GET) |
| `break-glass.granted`, `.used`, `.expired`, `.revoked`, `.notify-failed` | written by core's registry |

Auth events are queued and written off the request path (core shares the chain's OS lock, and a contended append would stop
the event loop); a few retries, then the event is counted and logged by action name only. Break-glass writes the chain
directly and fails closed. A tampered chain refuses new lines, so after tampering auth events are dropped and logged while
requests keep answering and break-glass refuses.

## Running it

`plur1bus-api --home <path> [--host <loopback>] [--port <n>] [--web-root <dir>]`. `createApiServer` takes `users`
(`UserDirectory`), `tokens` (`TokenStore`), `totp` (`TotpStore`), `audit`, `breakGlassAudit`, `notifyBreakGlass`, `webRoot`,
`lockout` and the limits. **Today `bin.ts` wires no user store**: only the owner token logs in, and tokens and second-factor
secrets live in memory and are lost at a restart.

## Follow-ups

- **User store.** The core has no credential store (`identity` knows humans and channel links). Passwords, tokens and TOTP
  secrets go through ports with in-memory implementations; the real ones belong in the core (TOTP seeds in the secret store).
- **OIDC and WebAuthn.** Not built (WebAuthn needs a dependency, OIDC an IdP decision, ADR-007 Q5).
- **Core subpath export.** `@plur1bus/core` exports only its bundle, so `src/rbac-bridge.ts` imports the pure `rbac` and
  `audit` modules by relative path (read and call only). A `@plur1bus/core/rbac` export turns that into a package import.
- **2FA enforcement per role** (ADR-007 recommends Owner and Admin), a step-up route, and a second factor for the owner token.
- **Break-glass delivery** to channels, and the memory routes that use a grant (they need a resource selector in the route table).
- `stream` routes (SSE, WebSocket) and OIDC/WebAuthn session binding are the next users of the `stream` class and the surface map.
- `docs/openapi.json` and `docs/api-surface.md` are regenerated with `pnpm docs:gen` whenever the route table changes.
