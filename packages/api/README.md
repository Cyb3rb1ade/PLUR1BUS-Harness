# @plur1bus/api

The first slice of the M3 Harness API (ADR-004): one HTTP server on loopback, deny by default, a peer client of the core.
Plan: `docs/superpowers/plans/2026-10-06-m3-api-foundation.md`. Surface map and OpenAPI document (generated):
`docs/api-surface.md`, `docs/openapi.json`.

## What it does

- Binds **loopback only** (`127.0.0.0/8`, `::1`, `localhost`); any other host is refused at construction. Remote
  exposure (`remote.publish`, D35) is a later slice. The `Host` header must be the server's own loopback name, so DNS
  rebinding gets a 421.
- **Login** with the owner token (`POST /api/v1/session`), a 256-bit secret in `run/api-owner.token` (mode 0600, made on
  first start). The core's RPC token is never accepted. The reply sets an `HttpOnly; SameSite=Strict` cookie (`Secure` and
  `__Host-` prefixed over TLS). Sessions are in memory, keyed by the hash of the cookie, idle 30 min / absolute 12 h.
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

Not a module yet: it has no manifest, provides no RPC methods and owns no `modules.<name>` config keys. It consumes the
core's `core.status` and `agent.list`. Wiring under the supervisor (a module manifest, host/port config keys) is a later
slice, so the restart class of those keys is not decided here.

## Run and test in isolation

```bash
export PATH=/home/claude/.node24/bin:$PATH
pnpm --filter @plur1bus/api build
node packages/api/dist/api.js --home /tmp/h [--port 7100]   # needs a running core in /tmp/h (see AGENTS.md)
cat /tmp/h/run/api-owner.token                                # the login secret; never paste it into a log or an issue

cd packages/api && node ../../scripts/test-package.mjs        # fake clock, fake core, local sockets only; no engine needed
```
