# Red-team review: local HTTP API (`/api/v1/**`), 2026-10

Scope: `packages/api` as merged in #136 (`server.ts`, `routes.ts`, `session.ts`, `rate-limit.ts`, `headers.ts`,
`errors.ts`, `core-link.ts`, `owner-token.ts`, `redact.ts`) against the RBAC pieces in `packages/core/src/rbac/guard.ts`
and `docs/rbac.md`. Method: read the code, then attack an in-process server with a fake core and a fake clock.
All evidence is in `packages/api/test/redteam.test.ts` (test names carry the finding id) unless a code line is cited.

Environment limits: the review ran on Node v22.22.0 (the container has no Node 24; the package declares `>=24.16`).
The `@plur1bus/api` tests ran with `node --experimental-strip-types`; the engine dependency could not be fetched, so the
rest of the monorepo was not exercised here.

## Confirmed findings

| ID | Severity | Finding | Evidence / reproduction | Status |
|---|---|---|---|---|
| F1 | Medium | The per-IP rate limiter ran **before** the Origin / `Sec-Fetch-Site` check. Every browser request comes from `127.0.0.1`, so a hostile web page could fire 5 refused cross-origin `POST /api/v1/session` calls (default `auth` bucket) and the owner was locked out of login (then 1 attempt per 12 s); the same for the `read` bucket with cross-site GETs. | `server.ts` (before the fix: limiter at the `ipVerdict` line, origin check after the route lookup). Repro: test `F1` sends 10 logins with `Origin: https://evil.example`, then a correct login: it was 429, now 200. | Fixed: the origin check moved ahead of the limiter (about 8 lines). Test `F1`, red in commit 366d6ce, green in 303584c. |
| F2 | Low | A core error with a known code was forwarded to the HTTP caller with the core's own `message` and any string `reason`, verbatim. A core message such as `cannot read /home/alice/.plur1bus/config.json` (e.g. `E_CONFIG_INVALID`) reached the browser. `E_INTERNAL`/`E_STORAGE` were already masked. | `errors.ts` `fromCoreError` (before: `message = e.message`, `reason` unfiltered). Repro: test `F2` (fake core throws `E_CONFIG_INVALID` with a path). | Fixed: a fixed message per code, and `reason` only when it matches `^[a-z0-9][a-z0-9._-]{0,63}$`. Test `F2`. |

## Open points (described, not fixed)

| ID | Severity | Point | Evidence | Recommended fix |
|---|---|---|---|---|
| D1 | Medium, **hypothesis, not reproduced** | Cookies are not isolated by port (RFC 6265). While the owner is logged in at `http://localhost:PORT`, the browser also sends `plur1bus_session` to any other server on `localhost` that the user visits (another dev server, a rogue local process); HttpOnly does not stop the server side from reading it. With the cookie it can fetch `/api/v1/csrf` and act as the owner (no Origin header from a non-browser client). The `__Host-` prefix over TLS does not add port isolation either. | `routes.ts` `sessionCookie` sets no port binding (none exists for cookies). Not testable in-process. | ADR-004 follow-up: bind the session to a second secret that is not a cookie (a header the SPA keeps in memory, sent on every call), or issue the SPA a per-origin token. Larger than a small fix. |
| D2 | Low | All loopback clients share one `ip:127.0.0.1` bucket and one `maxConnections` pool (128). Any local process can lock the owner out of login (5 failed or successful attempts) or exhaust reads, and 128 idle sockets block everyone until the header timeout. This is inherent to a loopback listener with no peer identity. | `server.ts` (`ip:` key before auth; `server.maxConnections`); the existing test `the rate limit trips ...` shows unauthenticated requests spend the same IP bucket; `OK-12`/`OK-13` show the timeouts that bound it. | Count only failed logins against the `auth` IP bucket; keep reads per principal once a session exists. Needs a design decision. |
| D3 | Info | The HTTP API has one role. `OWNER` is the only principal (`session.ts`) and the API reaches the core through one connection that the core resolves to `LOCAL_OWNER` (`guard.ts`, docs/rbac.md ruling R8). A per-role matrix (Admin/Operator/Agent) therefore cannot be tested through HTTP; any future passthrough or per-user route must forward the session principal, or the core cannot tell callers apart. Today the routes call only `core.status` and `agent.list`, no `admin.*` (`OK-7`). | `routes.ts` `buildHandlers`; `guard.ts`; docs/rbac.md "RPC integration". | Gate any new route on an explicit RBAC action in the route table before it ships. |
| D3b | Info | A request with a query string carrying a token is not rejected, only ignored (`?token=...` has no effect, it is not logged). | `OK-1`. | Optional: answer 400 for a query that contains `token`, `cookie` or `csrf` keys to catch misuse early. |
| D4 | Info | The Host allow-list always carries the port, so a listener on port 80 or 443 (browsers omit the port) would answer 421 to every request. Availability only. | `server.ts` `listen()`: `names.map((n) => \`${n}:${port}\`)`. | Add the port-less names when the port is 80 (HTTP) or 443 (TLS). |
| D5 | Info | Login does not invalidate other sessions and there is no "log out everywhere"; at `maxSessions` (64) the oldest session is dropped silently. | `session.ts` `create`. | Add a logout-all route when the users store lands. |
| D6 | Info | The `unhandled error` log line carries `e.message` of an unexpected exception (may hold a host path). It goes to the local `logs/api.log` only, never to the caller. | `server.ts` (`log.error("unhandled error", ...)`). | Accept, or log the error name only. |

## Checked, no finding (with evidence)

| ID | Area | Result | Evidence |
|---|---|---|---|
| OK-1 | Token in URL or query | `POST /session?token=OWNER` is 400 (the body is required); a query token never replaces a body token; a session id, owner token, `Authorization` (Bearer, Basic) or other header is never a session; a CSRF value in the query, body or cookie is not the header. No log line contains any of these secrets. | test `OK-1` (also `log-marker.test.ts`) |
| OK-2 | Wrong, truncated, upper-cased, quoted, other-prefixed or expired session | 401; idle expiry runs on the injected clock; the first duplicate cookie wins. | test `OK-2` |
| OK-3 | Timing | The owner token is hashed (SHA-256) and compared with `timingSafeEqual`, so the compare length never depends on the guess; the candidate cap (512) leaks only length class. Session and CSRF lookups use a hash-keyed `Map`, not a string compare. Not measured statistically (conclusion from code only). | `session.ts` line 91; test `OK-3` asserts the code shape and the odd inputs |
| OK-4 | CSRF | A token of a logged-out session is useless in the next one; tokens are bound to their session and one-time; a repeated header is not a match. Missing, wrong, replayed, expired and foreign tokens were already covered by `csrf.test.ts`. | test `OK-4` |
| OK-5 | DNS rebinding / Host | Foreign, look-alike, userinfo, trailing-dot, comma-list, missing and HTTP/1.0-without-Host values are 400/421. Node keeps the first of two `Host` headers and that one is judged (browsers cannot send two). The check runs before routing. | test `OK-5`; `server.ts` line 123 |
| OK-6 | Origin / CORS | `null`, foreign, look-alike, wrong-scheme and empty Origins are 403; a missing Origin is allowed (non-browser client, SameSite=Strict cookie); preflights get no `access-control-*` header and create or spend nothing. | test `OK-6`; `headers.test.ts` |
| OK-7 | Route table / RBAC reachability | Only `session.create` is public; every other route is 401 for anonymous and forged cookies; every authenticated write needs CSRF; the only core methods ever called are `core.status` and `agent.list`; `/admin/*`, `/rpc`, `/users`, `/identity`, `/secrets` are 404 for all methods even with a valid session and CSRF token. | test `OK-7` |
| OK-8 | Consistency | Every `admin.*` RPC method has an `RPC_RULES` entry in `guard.ts` and a docs/rbac.md row that is Owner and Admin only (Operator, Member, Viewer `–`); no HTTP route path contains `admin`. (The core's own `guard.test.ts` also pins the first half.) | test `OK-8` |
| OK-9 | Body shape | 30 000-deep nested JSON, `__proto__` keys, extra keys and invalid JSON are 400, an oversize body 413, never 500. | test `OK-9`; `server-limits.test.ts` |
| OK-10 | Content types | `text/plain`, form, multipart, `application/jsonx`, `application/json-patch+json`, `text/json`, XML and none are 415. | test `OK-10` |
| OK-11 | Unread body | An unterminated chunked body on a route that takes none is answered and ends on the request timeout; the server stays usable. | test `OK-11` |
| OK-12 | Slowloris | Dripped headers get the 408 from the request timeout; the connection cap is free again. | test `OK-12`; `server-limits.test.ts` |
| OK-13 | Connection flood | Connections over `maxConnections` are dropped at accept; held ones are unaffected. | test `OK-13` |
| OK-14 | Error responses | No stack frame, `.ts/.js:line`, host path, `node_modules`, `Error:`, token, or Node default HTML in 404/405/400/421/403/431/503 bodies. | test `OK-14`; `errors-headers.test.ts` |
| OK-15 | Binding | `loopbackBind` refuses `0.0.0.0`, `::`, empty and look-alike names; `localhost` is pinned to `127.0.0.1`; the listener is on loopback. | `bind.test.ts`; `server.ts` `loopbackBind` |
| OK-16 | Cookie flags / headers | HttpOnly, SameSite=Strict, Path=/, `Secure` and `__Host-` over TLS; CSP, nosniff, frame, referrer, CORP/COOP, no-store on every response. | `auth.test.ts`, `headers.test.ts` |
| OK-17 | Logs | The logger wraps every sink in `redactFields`; the request line carries the route id, never the URL; tokens never reach the file. | `redact.ts`; `log-marker.test.ts` |

## Not covered

Cookie behaviour in real browsers (D1), TLS configuration, a core that returns hostile data on `agent.list` (the value
is passed through as documented, ruling R13), and the supervisor wiring of the API (a later slice).
