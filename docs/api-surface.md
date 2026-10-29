# Harness API surface (generated)

Generated from `packages/api/src/routes.ts` by `scripts/gen-openapi.mjs` — do not edit by hand; run `pnpm docs:gen`. The machine-readable form is [openapi.json](openapi.json). Every later endpoint is added to the route table first (ADR-004 action item 2).

Every route is **deny by default**: a route that is not `public` answers 401 without a live session, and every route declares the RBAC action it needs (`Action` column, `authenticated` = any live principal, for session handling only); a route without a declaration answers 403. Writes need a one-time CSRF token (`X-CSRF-Token`, from `GET /api/v1/csrf`). Rate classes are per principal and per IP; request bodies are limited in size; every response, errors included, carries the security headers.

| Method | Path | Operation | Auth | Action | CSRF | Rate class | Stability · since |
|---|---|---|---|---|---|---|---|
| `GET` | `/api/v1/import/sources` | `imports.sources` | session | `imports.read` | no | read | experimental · 1.8.0 |
| `POST` | `/api/v1/import/snapshots` | `imports.snapshot.upload` | session or token | `imports.manage` | yes | upload | experimental · 1.8.0 |
| `POST` | `/api/v1/extensions/upload` | `extensions.upload` | session or token | `extensions.manage` | yes | upload | experimental · 1.8.0 |
| `POST` | `/api/v1/extensions/inspect` | `extensions.inspect` | session or token | `extensions.manage` | yes | write | experimental · 1.8.0 |
| `POST` | `/mcp` | `mcp.server` | session or token | `delegated` | no | rpc | experimental · 1.0.0 |
| `GET` | `/.well-known/agent-card.json` | `a2a.card.root` | public | `public` | no | read | experimental · 1.0.0 |
| `GET` | `/.well-known/agent.json` | `a2a.card.root.alias` | public | `public` | no | read | experimental · 1.0.0 |
| `GET` | `/a2a/{agentId}/.well-known/agent-card.json` | `a2a.card.agent` | public | `public` | no | read | experimental · 1.0.0 |
| `GET` | `/a2a/{agentId}/.well-known/agent.json` | `a2a.card.agent.alias` | public | `public` | no | read | experimental · 1.0.0 |
| `POST` | `/a2a/{agentId}` | `a2a.endpoint` | session or token | `delegated` | no | rpc | experimental · 1.0.0 |
| `GET` | `/.well-known/oauth-authorization-server` | `oauth.metadata` | public | `public` | no | read | stable · 1.0.0 |
| `GET` | `/.well-known/oauth-protected-resource` | `oauth.protected_resource` | public | `public` | no | read | stable · 1.0.0 |
| `GET` | `/oauth/authorize` | `oauth.authorize.get` | public | `public` | no | auth | experimental · 1.0.0 |
| `POST` | `/oauth/authorize` | `oauth.authorize.post` | public | `public` | no | auth | experimental · 1.0.0 |
| `POST` | `/oauth/token` | `oauth.token` | public | `public` | no | auth | stable · 1.0.0 |
| `POST` | `/oauth/revoke` | `oauth.revoke` | public | `public` | no | auth | stable · 1.0.0 |
| `GET` | `/api/v1/oauth/grants` | `oauth.grants.list` | session | `authenticated` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/oauth/grants/revoke` | `oauth.grants.revoke` | session | `authenticated` | yes | write | experimental · 1.0.0 |
| `GET` | `/api/v1/meta` | `desktop.meta` | public | `public` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/desktop/pair` | `desktop.pair` | public | `public` | no | auth | experimental · 1.0.0 |
| `POST` | `/api/v1/desktop/redeem` | `desktop.redeem` | public | `public` | no | auth | experimental · 1.0.0 |
| `POST` | `/api/v1/desktop/ticket` | `desktop.ticket` | public | `public` | no | auth | experimental · 1.0.0 |
| `POST` | `/api/v1/desktop/step-up/start` | `desktop.step-up.start` | public | `public` | no | auth | experimental · 1.8.0 |
| `POST` | `/api/v1/desktop/step-up/poll` | `desktop.step-up.poll` | public | `public` | no | auth | experimental · 1.8.0 |
| `POST` | `/api/v1/desktop/step-up/cancel` | `desktop.step-up.cancel` | public | `public` | no | auth | experimental · 1.8.0 |
| `GET` | `/api/v1/desktop/step-up/approval/{userCode}` | `desktop.step-up.approval` | session | `authenticated` | no | read | experimental · 1.8.0 |
| `POST` | `/api/v1/desktop/step-up/decision` | `desktop.step-up.decision` | session | `authenticated` | yes | write | experimental · 1.8.0 |
| `POST` | `/rpc` | `web.rpc` | session | `delegated` | yes | rpc | experimental · 1.0.0 |
| `GET` | `/events` | `web.events` | session | `delegated` | no | stream | experimental · 1.0.0 |
| `POST` | `/api/v1/invitations/redeem` | `invitation.redeem` | public | `public` | no | auth | experimental · 1.0.0 |
| `POST` | `/api/v1/accounts/bootstrap` | `account.bootstrap` | public | `public` | no | auth | experimental · 1.0.0 |
| `GET` | `/api/v1/me/passkeys` | `passkeys.list` | session | `my.read` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/me/passkeys/options` | `passkeys.options` | session | `my.write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/me/passkeys/register` | `passkeys.register` | session | `my.write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/me/passkeys/change` | `passkeys.change` | session | `my.write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/session/passkey/options` | `passkeys.login.options` | public | `public` | no | auth | experimental · 1.0.0 |
| `POST` | `/api/v1/session/passkey` | `passkeys.login` | public | `public` | no | auth | experimental · 1.0.0 |
| `GET` | `/api/v1/chats` | `chats.list` | session or token | `chat:read` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/chats` | `chats.create` | session or token | `chat:write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/agents/{agentId}/chats` | `chats.create-agent` | session or token | `chat:write` | yes | write | experimental · 1.0.0 |
| `GET` | `/api/v1/chats/{sessionId}` | `chats.get` | session or token | `chat:read` | no | read | experimental · 1.0.0 |
| `PATCH` | `/api/v1/chats/{sessionId}` | `chats.update` | session or token | `chat:write` | yes | write | experimental · 1.0.0 |
| `GET` | `/api/v1/chats/{sessionId}/messages` | `chats.messages` | session or token | `chat:read` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/chats/{sessionId}/messages` | `chats.submit` | session or token | `chat:write` | yes | expensive | experimental · 1.0.0 |
| `GET` | `/api/v1/chats/{sessionId}/events` | `chats.events` | session or token | `chat:read` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/chats/{sessionId}/cancel` | `chats.cancel` | session or token | `chat:write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/chats/{sessionId}/archive` | `chats.archive` | session or token | `chat:write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/chats/{sessionId}/restore` | `chats.restore` | session or token | `chat:write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/chats/{sessionId}/fork` | `chats.fork` | session or token | `chat:write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/chats/{sessionId}/export` | `chats.export` | session or token | `chat:read` | yes | write | experimental · 1.0.0 |
| `DELETE` | `/api/v1/chats/{sessionId}` | `chats.delete` | session or token | `chat:delete` | yes | write | experimental · 1.0.0 |
| `GET` | `/api/v1/chats/{sessionId}/model` | `chats.model-get` | session or token | `chat:read` | no | read | experimental · 1.0.0 |
| `PATCH` | `/api/v1/chats/{sessionId}/model` | `chats.model-set` | session or token | `chat:write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/ws-ticket` | `ws.ticket` | session | `settings.write` | yes | stream | experimental · 1.0.0 |
| `GET` | `/ws` | `ws.reserved` | session | `settings.write` | no | stream | experimental · 1.0.0 |
| `GET` | `/api/v1/remote` | `remote.get` | session | `settings.read` | no | read | experimental · 1.0.0 |
| `PATCH` | `/api/v1/remote` | `remote.set` | session | `settings.write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/remote/confirm` | `remote.confirm` | session | `settings.write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/remote/certificate` | `remote.certificate` | session | `settings.write` | yes | write | experimental · 1.0.0 |
| `GET` | `/api/v1/devices/pairing` | `remote.pairing.status` | session | `admin.pairing.read` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/devices/pairing` | `remote.pairing.offer` | session | `admin.pairing.read` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/devices/pair-proof` | `remote.pair-proof` | public | `public` | no | auth | experimental · 1.0.0 |
| `POST` | `/api/v1/devices/pair` | `remote.device.pair` | public | `public` | no | auth | experimental · 1.0.0 |
| `GET` | `/api/v1/devices/trust` | `remote.trust.get` | session | `device.list` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/devices/trust/challenge` | `remote.trust.challenge` | session | `remote.device.write` | yes | auth | experimental · 1.0.0 |
| `POST` | `/api/v1/devices/trust/ack` | `remote.trust.ack` | session | `remote.device.write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/devices/trust/rotate` | `remote.trust.rotate` | session | `admin.pairing.read` | yes | write | experimental · 1.0.0 |
| `GET` | `/api/v1/channel-dms` | `channel.history.list` | session | `chat:read` | no | read | experimental · 1.0.0 |
| `GET` | `/api/v1/channel-dms/{sessionId}` | `channel.history.get` | session | `chat:read` | no | read | experimental · 1.0.0 |
| `POST` | `/api/v1/channel-handoffs` | `channel.handoff.create` | session | `chat:write` | yes | write | experimental · 1.0.0 |
| `POST` | `/api/v1/channel-handoffs/redeem` | `channel.handoff.redeem` | session | `chat:write` | yes | write | experimental · 1.0.0 |
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

## Härtung und Testabdeckung

Every route of this table is called by the hardening tests (`packages/api/test/hardening-*.test.ts`, `secrets-never-leave.test.ts`): anonymous, signed in, with a bearer token, with a wrong method, a foreign `Origin` and a query string. Each answer carries the security headers; about 200 real answers validate against [openapi.json](openapi.json); every documented status is observed at least once; and the password, owner token, TOTP secret, backup codes, login challenge, session ids and token secret appear only in the answer that issues them, never in another body or header, a log line, an audit event or a call to the core. `components.Error.error.enum` is derived from the core's closed `ErrorCode` list, so a new code needs a regenerated `openapi.json`. Details, limits and known gaps: [api.md](api.md#härtung-und-testabdeckung).
