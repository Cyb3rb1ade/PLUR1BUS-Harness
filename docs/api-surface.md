# Harness API surface (generated)

Generated from `packages/api/src/routes.ts` by `scripts/gen-openapi.mjs` — do not edit by hand; run `pnpm docs:gen`. The machine-readable form is [openapi.json](openapi.json). Every later endpoint is added to the route table first (ADR-004 action item 2).

Every route is **deny by default**: a route that is not `public` answers 401 without a live session. Writes need a one-time CSRF token (`X-CSRF-Token`, from `GET /api/v1/csrf`). Rate classes are per principal and per IP; request bodies are limited in size; every response, errors included, carries the security headers.

| Method | Path | Operation | Auth | CSRF | Rate class | Stability · since |
|---|---|---|---|---|---|---|
| `POST` | `/api/v1/session` | `session.create` | public | no | auth | experimental · 1.0.0 |
| `DELETE` | `/api/v1/session` | `session.delete` | session | yes | write | experimental · 1.0.0 |
| `GET` | `/api/v1/csrf` | `csrf.issue` | session | no | read | experimental · 1.0.0 |
| `GET` | `/api/v1/health` | `health` | session | no | read | experimental · 1.0.0 |
| `GET` | `/api/v1/whoami` | `whoami` | session | no | read | experimental · 1.0.0 |
| `GET` | `/api/v1/agents` | `agents.list` | session | no | read | experimental · 1.0.0 |
