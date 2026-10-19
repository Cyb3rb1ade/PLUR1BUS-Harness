# @plur1bus/api

The M3 Harness API (ADR-004): authenticated loopback, tailnet and TLS network listeners, deny by default, a peer client of Core.
Plan: `docs/superpowers/plans/2026-10-06-m3-api-foundation.md`. Surface map and OpenAPI document (generated):
`docs/api-surface.md`, `docs/openapi.json`.

## What it does

- The ordinary listener binds **loopback only**. The standalone entry also applies `remote.publish`: a separate private `tailscale serve` backend or a TLS-only network listener with notice confirmation and socket CIDRs. Remote Host/Origin must match the configured HTTPS origin. DNS rebinding gets a 421. Missing Tailscale produces a visible unavailable/Doctor status with no network fallback.
- `remote.publish`, `remote.tls`, `remote.publicOrigin`, `remote.bind.*`, `remote.allowSubnets`, `remote.noticeAck.*` and `auth.requireSecondFactor` have restart class **core** in the schema. The standalone API reads them at startup: restart the API process/daemon as well when changing them. Default factor policy is `remote` for Owner/Admin.
- Direct-chat REST and response SSE use principal ownership, current object rights and bounded chat scopes. Incognito uses RAM storage. `/ws` reserves a cookie/Origin/single-use-ticket gated PTY handshake, rejects content and closes on logout/revocation.
- Device pairing and trust rollover reuse the Core DeviceStore. Only the explicitly reviewed owner-opened proof/code bootstrap routes accept an unpaired client; management uses account authorization, CSRF and audit. Private TLS material is 0600 and certificate replacement is staged.
- **Login** uses the durable local account. A fresh installation has one loopback-only Owner account bootstrap using the private `run/api-bootstrap.token` proof. It is permanently closed after transactional consumption; audit failure prevents the account commit. Production startup does not generate an owner-token login file.
- **Native desktop attach** uses `plur1bus device pair --kind desktop`, a ten-minute code, a fixed-scope device token, and an origin/device-bound one-use SPA ticket. Never read `run/api-owner.token` for attach. Enrolled or mandatory second factors currently refuse native attach until its scope-preserving MFA continuation is completed. See `docs/desktop.md` for the contract and remaining acceptance questions.
- Sessions use an `HttpOnly; SameSite=Strict` cookie (`Secure` and `__Host-` over TLS), held in memory by cookie hash, idle 30 min / absolute 12 h. Device sessions recheck live person/device authority and cannot acquire ambient Owner permissions.
- **CSRF**: every write needs a one-time `X-CSRF-Token` (`GET /api/v1/csrf`), bound to the session. `Origin` and
  `Sec-Fetch-Site` that are not the API's own are refused.
- **Headers** on every response (errors and malformed requests included): CSP `default-src 'none'; frame-ancestors 'none'`,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cache-Control: no-store`, HSTS over TLS.
- **Limits**: token buckets per IP (before a session) and per principal (after), per route class `auth`/`read`/`write`
  (429 + `Retry-After`); 64 KiB request bodies (413); header, request and handler timeouts (431/408/504).
- **Errors** are the CLI's `error/1` document with a member of the closed `ErrorCode` enum and a `reason`.
- Tokens, cookies and CSRF tokens never reach a log line (`test/log-marker.test.ts`).

## Routes

`POST /api/v1/session` (public), `DELETE /api/v1/session`, `GET /api/v1/csrf`, `GET /api/v1/health`,
`GET /api/v1/whoami`, `GET /api/v1/agents` (core RPC `agent.list`). The route table, `src/routes.ts`, is the single
source of the server, `docs/openapi.json` and `docs/api-surface.md`; add a route there first, then `pnpm docs:gen`.

## Manifest, RPC and config

The first-party supervisor role is `api` (distinct from installed modules); no module manifest or new config keys are introduced. The entry is bundled into `runtime/core/api.js` with the Core payload for atomic setup/update, or can run standalone as `packages/api/dist/api.js`. The supervisor starts the listener on loopback, checks `/api/v1/meta`, publishes private `run/api.json`, monitors/restarts it and closes its stdin lifeline on stop. HTTP loopback has `fingerprint: null`; remote TLS pins retain their existing meaning.

The package provides HTTP routes, consumes Core status/agent/chat/device/identity RPCs and the private `admin.api.desktop.redeem|token|resolve` service operations, and delegates remote configuration to the supervisor with revision CAS. Existing remote/auth config restart classes remain `core`.

## Run and test in isolation

```bash
export PATH=/home/claude/.node24/bin:$PATH
pnpm --filter @plur1bus/api build
node packages/api/dist/api.js --home /tmp/h [--port 7100]   # needs a running core in /tmp/h (see AGENTS.md)
# First-owner registration uses the private run/api-bootstrap.token proof locally.
# Native attach uses: plur1bus --home /tmp/h device pair --kind desktop --json

cd packages/api && node ../../scripts/test-package.mjs        # local sockets, fake clocks and real-Core flat seams; no model downloads
```
