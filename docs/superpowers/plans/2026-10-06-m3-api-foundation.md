# M3 Harness HTTP API foundation (`packages/api`)

**Date:** 2026-10-06 · **Milestone:** M3 (first slice) · **Decisions:** ADR-004 (*Harness API*), ADR-016 (error format), ADR-007 (*Authentication*), D35 (remote exposure, **not** in this slice).

## Goal

The first, deliberately small slice of the M3 Harness API: one HTTP server on loopback with deny-by-default
authentication, CSRF protection, security headers, rate limits, size and time limits, versioned `/api/v1` routes, a
generated OpenAPI document and three read-only endpoints (`health`, `whoami`, `agents`). Everything later (users and
roles, API tokens, `/rpc`, `/events`, `/ws`, `/mcp`, SPA, remote exposure) mounts on this chokepoint.

## Where it lives: `packages/api`, not `packages/core/src/http`

- The core is a process entry point, not a library; `packages/core/src/core.ts` is a shared hot file and the core
  must keep its RPC-only, engine-bound surface (ADR-012). The API is a **peer client of the core** (ADR-004: "CLI and UI
  are peers, both thin clients"), so it talks to the core over the local RPC through `@plur1bus/module-api`'s client.
- It can therefore be loaded lazily (D6) and tested with a fake core; its tests need neither the engine nor models.
- `packages/api` follows the `module-api`/`webmcp` shape (`exports` with a `source` condition, esbuild bundle).
- Wiring it under the supervisor (a `modules/api` manifest, `daemon start` spawning it) is a follow-up that touches
  `supervisor/` and is out of scope here; the package ships a standalone entry (`dist/api.js --home <path>`).

## Files

| Path | Purpose |
|---|---|
| `packages/api/package.json`, `README.md` | package, how to run and test in isolation |
| `src/errors.ts` | `ApiError`, `error/1` body, status mapping from the closed `ErrorCode` enum |
| `src/rate-limit.ts` | token bucket + limiter (injected clock) |
| `src/session.ts` | session store (hashed ids, idle + absolute expiry), one-time CSRF tokens, owner-token verifier |
| `src/headers.ts` | CSP and the other security headers |
| `src/redact.ts` | log field redaction (tokens, cookies, authorization) |
| `src/routes.ts` | the single route table (method, path, auth, CSRF, rate class, schemas, handler) |
| `src/openapi.ts` | OpenAPI 3.1 document generated from the route table |
| `src/server.ts` | `createApiServer` (HTTP/HTTPS, host/origin checks, limits, timeouts, dispatch) |
| `src/bin.ts` | standalone entry: connects to the core, serves on loopback |
| `scripts/gen-openapi.mjs`, `docs/openapi.json` | generator and `--check`, wired into `docs:gen`/`docs:check` |
| `test/*.test.ts` | one file per concern, a fake clock and a fake core, local sockets only, hard timeouts |

## Tasks (test first, one small commit each)

1. Plan (this file).
2. Package skeleton, `ApiError`/`error/1`, security headers, redaction. Tests: header set on every response kind, error shape.
3. Token bucket and limiter with a fake clock. Tests: trips, refills, per-principal and per-IP independence.
4. Sessions, CSRF, owner verifier. Tests: expiry on a fake clock, one-time CSRF, constant-time compare, no session without the owner token.
5. Route table and server: loopback-only bind, Host/Origin checks, body limit, timeouts, dispatch. Tests: 401, 403, 413, 429, 404/405, 408/504, non-loopback refused.
6. Endpoints `health`, `whoami`, `agents` over a fake core. Tests: results, core down → degraded/503.
7. OpenAPI generator, `docs/openapi.json`, `--check` in `docs:check`. Tests: every route in the table is in the document and vice versa.
8. Log marker test (tokens never in logs), README, AGENTS.md/docs rows, standalone `bin.ts`.

## Acceptance → test

| Acceptance | Test |
|---|---|
| Unauthenticated → 401 on every non-public route | `auth.test.ts` "every route that is not public answers 401 without a session" (iterates the route table) |
| CSRF without a token → 403 | `csrf.test.ts` (missing, wrong, replayed, other session's token) |
| CSP set on every response | `headers.test.ts` (200, 401, 403, 404, 405, 413, 429, 500, OPTIONS) |
| Rate limit trips and recovers | `rate-limit.test.ts` (unit, fake clock) and `server-limits.test.ts` (429 + `Retry-After`, then 200 after the clock advances) |
| Oversized body → 413 | `server-limits.test.ts` (declared and streamed, connection closed) |
| OpenAPI generated and checked | `openapi.test.ts` (route table ⇄ document) and `pnpm docs:check` |
| Tokens never in logs | `log-marker.test.ts` (owner token, session id, CSRF token, cookie header never appear in any captured log line, including failures) |
| Loopback only, fail closed | `bind.test.ts` (0.0.0.0, `::`, a LAN address, a hostname that resolves elsewhere are refused; Host header of another name → 421) |

## Rulings (defaults taken, to list in the PR)

- **R1 Principal.** Until the users store (ADR-007) lands there is one principal, the owner (`role: "owner"`).
- **R2 Login.** `POST /api/v1/session` with the owner token. The token is a separate 256-bit secret (`run/api-owner.token`, `0600`, created by the API process), verified in constant time. **The core's RPC token is never accepted** as a web credential. Pairing (D35) and personal API tokens are not implemented; a `Bearer` credential is not a way in.
- **R3 SameSite.** ADR-004's table says `Lax`; the task and the stricter reading say `Strict`. `Strict` is used (the SPA is same-origin).
- **R4 CSP.** `default-src 'none'` for API responses plus `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`; no `unsafe-inline`, no nonce yet (no HTML is served; ADR-004's per-response nonce arrives with the SPA).
- **R5 `/health` is authenticated** (deny by default, "unauthenticated denied on every endpoint", milestones §6). Only `POST /api/v1/session` is public.
- **R6 CSRF.** One-time token per write, bound to the session, fetched with `GET /api/v1/csrf`. Login is protected by `Origin`/`Host` checks, `SameSite=Strict` and a JSON-only content type instead (there is no session to bind to).
- **R7 Exposure.** Only loopback binds are accepted; `remote.publish` other than `local` is not read here (D35 later) and any non-loopback host is refused at construction.
- **R8 Error format.** `{ "schema": "error/1", "error": "<ErrorCode>", "message": …, "reason"?: … }`, the CLI's `--json` shape (ADR-016 §8, G15) with the closed `ErrorCode` enum.
- **R9 Response ids.** `health/1`, `whoami/1`, `agents.list/1`, `session.create/1`, `session.delete/1`, `csrf/1`.

## Open points (for the owner)

- Container health checks (D1) cannot call an authenticated `/health`; a separate unauthenticated liveness route, or the supervisor's own probe, needs a decision (R5).
- TLS is supported by the server (`tls` option) but certificate generation and pinning belong to D35.
- Session persistence across API restarts (in-memory today) and revocation lists belong to the users/roles slice.
