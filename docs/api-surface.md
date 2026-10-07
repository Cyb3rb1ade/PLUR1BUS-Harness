# Harness API surface (generated)

Generated from `packages/api/src/routes.ts` by `scripts/gen-openapi.mjs` — do not edit by hand; run `pnpm docs:gen`. The machine-readable form is [openapi.json](openapi.json). Every later endpoint is added to the route table first (ADR-004 action item 2).

Every route is **deny by default**: a route that is not `public` answers 401 without a live session, and every route declares the RBAC action it needs (`Action` column, `authenticated` = any live principal, for session handling only); a route without a declaration answers 403. Writes need a one-time CSRF token (`X-CSRF-Token`, from `GET /api/v1/csrf`). Rate classes are per principal and per IP; request bodies are limited in size; every response, errors included, carries the security headers.

| Method | Path | Operation | Auth | Action | CSRF | Rate class | Stability · since |
|---|---|---|---|---|---|---|---|
| `POST` | `/api/v1/session` | `session.create` | public | `public` | no | auth | experimental · 1.0.0 |
| `DELETE` | `/api/v1/session` | `session.delete` | session | `authenticated` | yes | write | experimental · 1.0.0 |
| `DELETE` | `/api/v1/sessions` | `sessions.revoke-all` | session | `authenticated` | yes | write | experimental · 1.0.0 |
| `GET` | `/api/v1/csrf` | `csrf.issue` | session | `authenticated` | no | read | experimental · 1.0.0 |
| `GET` | `/api/v1/health` | `health` | session or token | `doctor.read` | no | read | experimental · 1.0.0 |
| `GET` | `/api/v1/whoami` | `whoami` | session or token | `authenticated` | no | read | experimental · 1.0.0 |
| `GET` | `/api/v1/agents` | `agents.list` | session or token | `agent.list` | no | read | experimental · 1.0.0 |
| `GET` | `/api/v1/tokens` | `tokens.list` | session | `my.read` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/tokens` | `tokens.create` | session | `my.write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/tokens/revoke` | `tokens.revoke` | session | `my.write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/session/totp` | `session.totp` | public | `public` | no | totp | experimental · 1.0.0 |
| `GET` | `/api/v1/me/totp` | `totp.status` | session | `my.read` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/me/totp/setup` | `totp.setup` | session | `my.write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/me/totp/confirm` | `totp.confirm` | session | `my.write` | yes | totp | experimental · 1.0.0 |
| `POST` | `/api/v1/me/totp/disable` | `totp.disable` | session | `my.write` | yes | totp | experimental · 1.0.0 |
| `POST` | `/api/v1/breakglass` | `breakglass.request` | session | `breakglass.request` | yes | write | experimental · 1.0.0 |
| `GET` | `/api/v1/breakglass` | `breakglass.list` | session | `breakglass.request` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/breakglass/revoke` | `breakglass.revoke` | session | `breakglass.request` | yes | write | experimental · 1.0.0 |
| `GET` | `/api/v1/me/notices` | `notices.list` | session | `my.read` | no | read | experimental · 1.0.0 |
