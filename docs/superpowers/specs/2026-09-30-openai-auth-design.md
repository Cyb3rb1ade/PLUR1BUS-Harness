# OpenAI auth: Sign in with ChatGPT, API keys, workload identity, Realtime ephemeral secrets and GPT-Live sessions — design (D110)

**Status:** Draft rev 1 for owner review · **Date:** 2026-09-30 · **Owner:** Christian (Cyb3rb1ade) · **Decision row:** core spec D110 (`2026-09-24-m1b-2a-core-daemon-cli-design.md` §2) · **Milestone:** M2 (auth engine, ADR-005) · **Amends:** ADR-005 (auth kinds, profile schema, OpenAI rows, amendment D13's route 3), `docs/provider-matrix.md` §1, §2, §4, core spec D45, `docs/milestones.md` M2 · **Depends on:** D109 (PR #56, pending) for the credential deny-list, the `money` effect and surface trust · **Input:** research of 2026-09-30 against primary OpenAI sources (developers.openai.com, openai.com, learn.chatgpt.com, `auth.openai.com` discovery, `openai/codex` source); every claim below carries its primary URL.

**Owner request, 2026-09-30 (German, verbatim):** *"make sure our OAuth mechanisms are prepared for OpenAI, GPT, Realtime and the new GPT Live."*

**Why a separate spec and not a section of the basics spec.** D110 amends the M2 auth engine (ADR-005) and the voice-provider decision D45; it is not a "basics quality bar" item. It carries its own profile tables, tests and owner questions, and the basics spec's tail is being extended concurrently by D109 (PR #56), so appending there would conflict. The direct-chat spec (D92/D93) set the precedent of a focused spec per decision cluster.

---

## 1. Verified state (2026-09-30)

**What changed at OpenAI.**

1. **Sign in with ChatGPT for open-source and local apps ("ChatGPT plan usage").** OpenAI documents an OAuth/OIDC flow built for third-party open-source apps to spend a user's ChatGPT plan: public endpoints from `https://auth.openai.com/.well-known/openid-configuration`, published scopes, loopback PKCE, a rotating refresh token, and a **client ID issued per user and workspace on first authorization** (`client_id=dynamic_agent_client` in, `oaiapp_…` out). It is open to "open-source projects, personal projects that run locally, and selected private apps"; paid or remotely hosted apps need OpenAI's approval ([overview](https://developers.openai.com/siwc/token-sharing-open-source), [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), [cookbook §Usage policy and terms](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)). Plan usage went broad on 2026-09-29 with 16 launch partners ([The New Stack](https://thenewstack.io/sign-in-with-chatgpt/), secondary, for the date only).
2. **GPT-Live is GA in the API since 2026-09-10**, as `gpt-live-1` only, on `/v1/live/sessions` only, at $0.05 per voice-minute billed per second ([openai.com/index/introducing-gpt-live-1-in-the-api](https://openai.com/index/introducing-gpt-live-1-in-the-api/), [models/gpt-live-1](https://developers.openai.com/api/docs/models/gpt-live-1), [API changelog](https://developers.openai.com/api/docs/changelog)). It is a full-duplex voice front-end that **delegates** reasoning and tools to a backend (`delegation.type: responses | client`), not a speech-to-speech model ([guides/live-delegation](https://developers.openai.com/api/docs/guides/live-delegation), [guides/voice-agents](https://developers.openai.com/api/docs/guides/voice-agents)). **`gpt-live-1-mini` is not an API model** (its model page returns 404; "mini" is a ChatGPT variant, [openai.com/index/introducing-gpt-live](https://openai.com/index/introducing-gpt-live/)).
3. **Realtime API** (`gpt-realtime-2.1`, `-mini`, older snapshots) keeps its own surface `/v1/realtime`, a 60-minute session cap and **ephemeral client secrets** from `POST /v1/realtime/client_secrets` (TTL 10 s–7200 s, default 600) ([client_secrets create](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create), [guides/realtime-conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)). Session config attached to a secret "can also be overridden by the client connection", so a secret bounds time and project, **not** what the client does ([voice-webrtc](https://developers.openai.com/api/docs/guides/voice-webrtc)). GPT-Live has **no** client-secret mechanism: the server creates the session with the project key ([guides/live](https://developers.openai.com/api/docs/guides/live)).
4. **Workload identity federation** (OIDC GA, X.509 per changelog): a short-lived platform JWT or client certificate is exchanged for a short-lived OpenAI access token of a mapped service account; no refresh token, re-exchange instead ([workload identity federation](https://developers.openai.com/api/docs/guides/workload-identity-federation), [token exchange reference](https://developers.openai.com/api/reference/workload-identity-federation)).
5. **API keys:** project keys can carry an expiry and admins can enforce a maximum lifetime (2026-09-10); key governance can allow only service-account keys (2026-09-15); per-project model allow/deny lists; typed `429 slow_down` / `503 server_is_overloaded` with `Retry-After` (2026-09-02) ([production best practices §API keys](https://developers.openai.com/api/docs/guides/production-best-practices), [admin APIs](https://developers.openai.com/api/docs/guides/admin-apis), [rate limits](https://developers.openai.com/api/docs/guides/rate-limits), [changelog](https://developers.openai.com/api/docs/changelog)).
6. **Codex CLI login** remains the Codex client's own flow with its own hard-coded client ID; OpenAI states verbatim that *"App-server authentication has never been permitted for commercial or hosted services. We launched Sign in with ChatGPT to support these use cases"* and recommends migrating local and open-source apps to Sign in with ChatGPT ([learn.chatgpt.com/docs/app-server §Auth endpoints](https://learn.chatgpt.com/docs/app-server), [learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth)). No document grants third parties the Codex client ID.

**What the repo says today, and why it is now wrong.** ADR-005 and `provider-matrix.md` §4 state that OpenAI "publishes **no** authorization/token endpoints, client ID, scopes or device-code parameters for third parties" and ship ChatGPT/Codex OAuth as ADR-005 amendment D13's third route, `restricted`, "at your own risk", by request-shaping a user-handed token like Codex does. That basis is false as of 2026-09-30, and an official third-party flow exists. Core spec D45 claims `GPT-Live-1-mini` is an API model and files GPT-Live under kind `realtime`.

---

## 2. Decision D110

**The auth engine (ADR-005, M2) supports OpenAI through five documented routes and nothing else: API keys, workload identity, Sign in with ChatGPT with issued-on-authorize client registration, harness-minted Realtime ephemeral secrets, and a server-side session broker for GPT-Live; the Codex CLI stays a spawned, personal/local-only backend. ADR-005 amendment D13's `restricted` "at your own risk" ChatGPT/Codex OAuth route is superseded and imported disabled.** No other app's client ID, no other app's credential file, no ChatGPT `backend-api`, no silent billing fallback, no API key on any client.

### 2.1 Auth kinds and registration modes

ADR-005's kinds become `api_key | oauth_pkce | device_code | adc | federated_token`, plus the derived, never-persisted `minted_ephemeral`, plus one new OAuth registration mode. The session broker is a core capability, not a credential kind.

| Kind / mode | What | Lifecycle | Stored |
|---|---|---|---|
| `oauth_pkce` + **`client_registration: dynamic_on_authorize`** (new mode) | First sign-in sends a registration-entry client ID (`dynamic_agent_client`) with `agent_name_hint` and `ext_agent_host_id`; the user names and approves the agent; the callback returns an **issued client ID bound to that user and workspace**, which every later authorize and refresh uses. This is **not RFC 7591 DCR** (no registration endpoint; the ID comes back on the callback), so it does not touch ADR-008's or D67's DCR exclusion. | Access 1 h; refresh 30 d, rotating, single-use, refreshes serialized by the core's single refresh owner (ADR-005 §"Token lifecycle"); revocation on logout | issued client ID, tokens and the ID token's `sub`/workspace per account registration, in the secret store; the entry client ID is never persisted as a credential |
| **`ext_agent_host_id`** (new field, per install) | A stable per-install host identifier: `urn:ietf:params:oauth:jwk-thumbprint:sha-256:<b64url>` per [RFC 9278](https://www.rfc-editor.org/rfc/rfc9278), computed (RFC 7638) over the public JWK of an Ed25519 key generated once at first use. OpenAI treats it as opaque and does not verify possession ([sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)); the key lets a later version prove possession without changing the ID. | Generated once, never rotated silently; a new install gets a new ID; a paired D51 node gets its own | private key in the secret store; the URN in config (not a secret) |
| **`federated_token`** (new kind) | Exchange a subject token (OIDC JWT from file, env or cloud metadata, or an X.509 client certificate) at the token-exchange endpoint for a short-lived bearer of a mapped service account. Fields: `token_exchange_endpoint`, `subject_token_source` (`file:<path>` \| `env:<name>` \| `metadata:<cloud>`), `subject_token_type`, `audience`, `principal` (mapping id). | No refresh token; re-exchange at `expires_at − refresh_skew_seconds`; headless by nature | nothing persistent beyond the configuration; the bearer lives in memory as a lease |
| **`minted_ephemeral`** (new, derived) | A Realtime client secret the harness mints from a parent `api_key` or `federated_token` profile with the session config the harness chose. Defaults: **TTL 60 s**, harness maximum 600 s (OpenAI allows 7200), **one secret per session request**, delivered only to an authenticated harness surface of trust T2+ (D109 §5: a paired desktop/app device per D35/D51 or an M3 web session, never a group channel). Because the client can override secret-attached config, it is **not a security boundary**: the harness also attaches a **server sideband** (`wss://api.openai.com/v1/realtime?call_id=…`, authenticated with the same project key) to enforce instructions and tool policy, runs tools only server-side under D109, and puts voice in a dedicated project with a model allow-list and spend limit. | Never persisted, never logged; each mint audited (agent, surface, TTL, session id, never the value) | nothing |
| **Session broker** (core capability) | RPC `voice.session.create { provider, transport: webrtc \| websocket \| sip, sdp? }` → `{ sessionId, sdpAnswer? }`. The core creates the session with the project credential (Realtime: posts the SDP to `/v1/realtime/calls`, the "unified interface"; GPT-Live: `POST /v1/live/sessions` with `transport:{type:"webrtc",sdp}`), opens the sideband (`/v1/live/sessions/{id}/attach` or Realtime `?call_id=`) and runs tools there under D109. **No OpenAI credential reaches the client.** This is the default for Realtime and the only mode for GPT-Live. | Session-scoped; the core closes the sideband on `session.closed` | nothing |

`device_code` stays in the engine for other vendors; OpenAI documents no third-party device grant (`auth.openai.com` discovery lists no `device_authorization_endpoint`; Codex's device code is Codex-only, [learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth)).

### 2.2 Profile schema additions (ADR-005 §"Declarative auth profiles")

`kind` gains `federated_token`; `client_registration` gains `dynamic_on_authorize`; new fields: `registration_entry_client_id`, `issued_client_id_ref` (secret-store handle, **per account registration**, never shared across accounts or harness users), `agent_name_hint`, `host_id` (URN), `resource`, `nonce` (required for OIDC), `scope_gate` (scopes that must be granted before use), `billing_path` (`api_key | chatgpt_plan | cli_login | workload`), `region` (`global | us | eu`), `key_expires_at` (API keys), `wire_profile` (request constraints, e.g. `siwc`), `derives_from` (parent profile for voice and minted credentials), `surface_min_trust` (D109 level), `usage_label` (e.g. "personal/local only").

### 2.3 Declarative OpenAI profiles (data, not code)

| Profile id | Kind | Surfaces | `policy_status` | `billing_path` |
|---|---|---|---|---|
| `openai:api-key` (exists) | `api_key` | `oai-resp`, `oai-chat`, embeddings, `/v1/realtime`, `/v1/live/sessions`, `/v1/realtime/client_secrets` | allowed, default | `api_key` |
| `openai:chatgpt-plan` (new, replaces amendment D13's route 3) | `oauth_pkce` + `dynamic_on_authorize` | `oai-resp` only, `wire_profile: siwc` | allowed for the owner's own agents on a local or self-hosted install; not offered to other harness users (§2.7) | `chatgpt_plan` |
| `openai:workload-identity` (new) | `federated_token` | as `openai:api-key` | allowed | `workload` |
| `openai:realtime` (new) | derives from `openai:api-key` or `openai:workload-identity` | `/v1/realtime` (`gpt-realtime-*`) via broker or `minted_ephemeral` | allowed | `api_key` / `workload` |
| `openai:gpt-live` (new) | derives from `openai:api-key` or `openai:workload-identity` | `/v1/live/sessions` (`gpt-live-1`) via broker only | allowed | `api_key` / `workload` |
| `openai:codex-cli` (exists, ADR-005 amendment D13 route 2) | delegated binary | CLI lane | allowed, `usage_label: personal/local only` (§2.4) | `cli_login` |
| `openai:chatgpt-oauth-restricted` (amendment D13 route 3) | — | — | **superseded**: never loadable as usable; an imported one is a visible, disabled entry pointing to `openai:chatgpt-plan` | — |

**`openai:api-key`.** Bearer. Recommend a **service-account key in a dedicated project** (orgs may forbid user-owned keys, key governance 2026-09-15). Record `key_expires_at` when the user enters it or the Admin API reports it; warn 14 and 3 days before expiry in `1staid check` and the UI; an expired key is `auth-required`, never retried. Project model permissions and the typed `slow_down`/`server_is_overloaded` classes feed ADR-005's ambiguous-vs-confirmed cooldown classifier. Send `OpenAI-Safety-Identifier` (a hash of the harness principal, never the raw id) on voice calls ([production best practices](https://developers.openai.com/api/docs/guides/production-best-practices), [rate limits](https://developers.openai.com/api/docs/guides/rate-limits)).

**`openai:chatgpt-plan` (Sign in with ChatGPT).** All values from [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), [models & inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [errors](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) and [UI/UX](https://developers.openai.com/siwc/ui-ux-guidelines):
- **Endpoints from discovery**, not hard-coded: authorize `https://auth.openai.com/api/accounts/authorize`, token `…/api/accounts/oauth/token`, revoke `…/api/accounts/oauth/revoke`, JWKS `…/.well-known/jwks.json`; token-endpoint auth `none` (public client).
- **First sign-in:** `client_id=dynamic_agent_client`, `agent_name_hint="PLUR1BUS"`, `ext_agent_host_id=<host URN>`; persist the returned `oaiapp_…` per ChatGPT account; later sign-ins and refreshes use the issued ID.
- **Request:** `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`, PKCE `S256`, fresh `state` and `nonce`.
- **Redirect:** loopback `http://127.0.0.1:<port>/auth/callback` only; only the port varies; `localhost` is refused by OpenAI and never sent.
- **Validation:** ID token against the JWKS (`iss`, `aud` = issued client ID, `exp`, `nonce`); inference only if the granted scopes contain `chatgpt.tokens.use.direct` (`scope_gate`).
- **Tokens:** access 1 h, refresh 30 d rotating; refresh is `grant_type=refresh_token` + issued client ID + `resource`, serialized.
- **Inference (`wire_profile: siwc`):** `POST https://api.openai.com/v1/responses` with **`store:false` and `stream:true`** forced; model list from `GET /v1/models` with the same token (no hard-coded models). The wire adapter strips or refuses the unsupported fields — `background`, `conversation`, `max_output_tokens`, `metadata`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_p`, `truncation`, `user`, and `previous_response_id` over HTTP — rejects hosted tools (file search, code interpreter, image generation, hosted MCP, `tool_search`), audio in or out and the Files API, and sends instructions as `instructions`, never as a `system` role item. Function tools (the harness's own) work as usual.
- **Not for:** GPT-Live, Realtime, embeddings, Files or hosted tools. Voice always needs an API key or workload identity.
- **Errors:** typed `subscription_sharing_*` codes map to harness errors; `429 subscription_sharing_usage_limit_exceeded` stops the turn and links to `chatgpt.com/settings/usage`. **No automatic failover to another billing path** (§2.5).
- **UI rules (OpenAI's):** a "Continue with ChatGPT" button, a first-use "You're using your ChatGPT plan" notice, a persistent "Using ChatGPT plan" indicator on the agent and in `plur1bus chat` status, and a "Manage usage" link; the CLI prints the same texts.
- `person_bound: true`; revocation on logout; the login page is the person's own browser — the harness never fills a ChatGPT login form (D109 `credential.entry` is `never`).

**`openai:workload-identity`.** For VPS, Kubernetes and CI hosts: no stored OpenAI secret at all. Templates for Kubernetes projected service-account tokens and GitHub Actions OIDC; X.509 behind the same kind. The Codex workspace variant (`OPENAI_IDENTITY_TOKEN_FILE`) is Codex's own and is not used by the harness.

**`openai:realtime`.** Model ids from `/v1/models` at setup (D42 scan), never hard-coded; transports WebRTC (desktop or web with a microphone), WebSocket (the core relaying audio, the fit for Telegram voice notes and the CLI), SIP (`sip:$PROJECT_ID@sip.api.openai.com;transport=tls`, webhook `realtime.call.incoming`, provider URI never carries credentials) ([voice-webrtc](https://developers.openai.com/api/docs/guides/voice-webrtc), [voice-websockets](https://developers.openai.com/api/docs/guides/voice-websockets), [voice-sip](https://developers.openai.com/api/docs/guides/voice-sip)). Client auth: broker by default; `minted_ephemeral` only for the desktop app's direct WebRTC. Tools are declared server-side and executed through the sideband ([voice-server-controls](https://developers.openai.com/api/docs/guides/voice-server-controls)). Usage from `response.done` and `rate_limits.updated`. Tracing off (not EU-compliant on `/v1/realtime`).

**`openai:gpt-live`.** `gpt-live-1` on `/v1/live/sessions` only: WebSocket `wss://api.openai.com/v1/live/sessions` (send `session.start` first), WebRTC `POST /v1/live/sessions` with the SDP (the broker returns the answer), SIP via webhook `live.transport.incoming` and `POST /v1/live/sessions/{id}/accept|reject|refer|hangup`; sideband `…/{id}/attach` ([guides/live](https://developers.openai.com/api/docs/guides/live), [guides/live-conversations](https://developers.openai.com/api/docs/guides/live-conversations)). **Default `delegation.type: client`**: the harness agent's own turn is the backend, so memory, D109 permissions, D30 routing and the agent's tools stay in the harness; `responses` delegation is an opt-in per agent for low-latency agents with no local tools. `model` and `delegation.type` are fixed at start. `store: false` by default (recordings are kept 30 days and have no delete endpoint). Usage from `session.usage.updated` (seconds) plus the backend's own token usage, summed by the harness; `session.closed` gives the final figure. Concurrent-session limits per tier (25–500) are read at setup and enforced as a per-installation cap.

**Data residency.** `region: global | us | eu` on `openai:api-key`, `openai:workload-identity`, `openai:realtime` and `openai:gpt-live` maps the base URL to `api.openai.com`, `us.api.openai.com` or `eu.api.openai.com` (both regional hosts serve `/v1/realtime` and `/v1/live/sessions`); EU needs the org's Modified Retention amendment, which the harness cannot check and states at setup ([your-data](https://developers.openai.com/api/docs/guides/your-data)). `openai:chatgpt-plan` is `global` only (its `resource` is fixed).

### 2.4 The existing Codex CLI route

`openai:codex-cli` stays, **only** as ADR-005's delegated binary: the harness spawns the unmodified `codex` (`codex exec --json`, `codex-acp`, `codex app-server`) and lets Codex run its own login (`account/login/start` type `chatgpt` or `chatgptDeviceCode`). It is labelled **"personal/local only"** in the catalogue, the UI and `--json` (`usage_label`), because OpenAI says app-server authentication "has never been permitted for commercial or hosted services" ([learn.chatgpt.com/docs/app-server](https://learn.chatgpt.com/docs/app-server)); it is offered only to the login holder's own agents. The harness never sends Codex's client ID, never sets `CODEX_APP_SERVER_LOGIN_CLIENT_ID`, never adds Codex-only authorize parameters, and never opens `~/.codex/auth.json`, `$CODEX_HOME/auth.json` or Codex's keychain item. **Preferred variant:** feed Codex app-server the harness's own `openai:chatgpt-plan` access token through the vendor-documented custom provider (`base_url=https://api.openai.com/v1`, `env_key="ACCESS_TOKEN"`, `wire_api="responses"`, `requires_openai_auth=false`; the harness refreshes and restarts app-server), so usage is attributed to PLUR1BUS ([codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)). Enterprise Codex access tokens (`codex login --with-access-token`) are stored by the harness and piped to the unmodified binary only.

### 2.5 Never

1. Never send another app's client ID: not Codex's `app_EMoamEEZ73f0CkXaXp7hrann`, not OpenClaw's or Hermes' issued `oaiapp_…`, not any other; never set `CODEX_APP_SERVER_LOGIN_CLIENT_ID`; never add `codex_cli_simplified_flow` or `originator=codex_*`; never persist or reuse `dynamic_agent_client` as a credential.
2. Never read, copy or refresh another client's credential store. **The D109 (PR #56) credential deny-list gains, by name** (case-folded, per-OS canonical, existence probes only): `~/.codex/auth.json` and `$CODEX_HOME/auth.json`; Codex's OS keychain entry; OpenClaw's auth store (`$OPENCLAW_HOME` or `~/.openclaw`: `agents/*/agent/*.sqlite` auth tables, `agents/*/agent/auth-profiles.json`, `credentials/`); Hermes' credential files (`$HERMES_HOME` or `~/.hermes`, `%LOCALAPPDATA%\hermes`: `.env`, `auth.json`, its Sign in with ChatGPT credential record); and any file holding another app's `oaiapp_…` registration. The M7 importer is a person-run migration, not an agent tool, but it follows the same line for OpenAI OAuth: it reads profile metadata only, never these token values, and imports such profiles disabled (§3, Q11).
3. Never call ChatGPT `backend-api` endpoints and never reproduce Codex's request fingerprint (User-Agent, `originator`) to make a token work; the plan route uses public `/v1/responses` as documented.
4. Never fail over silently from `openai:chatgpt-plan` to a paid profile, or the reverse. D30's failover skips any tier whose `billing_path` differs from the failing one unless the agent's policy names that cross-billing step explicitly (`failover.crossBilling: [ {from, to} ]`), and the turn event records it.
5. Never share a plan registration across harness users (`person_bound`), and never offer plan usage in a paid or remotely hosted multi-tenant deployment without OpenAI's approval.
6. Never ship a project API key or workload bearer to a browser, desktop, phone or channel client; only a `minted_ephemeral` (Realtime) or nothing (broker). Never mint long-TTL or multi-session secrets for channel users. Never rely on secret-attached config as a boundary.
7. Never put tokens, `ek_…` values, issued client IDs or `id_token_hint` in URLs that get logged, in logs, in `--json`, in fixtures or in exports; authorization URLs are redacted before any log line.
8. Never set `store:true` on the plan route, and never on GPT-Live by default.

### 2.6 Voice spend (tied to D109's `money` effect)

Metered voice (GPT-Live $0.05 per minute, Realtime tokens, delegated backend tokens) is budgeted, not approved per call:
- **Per-agent voice budget** in ADR-010 §4's budget layer: minutes per day and per month and a cost ceiling per agent, per user and per installation; checked before `voice.session.create` and on every usage event; the broker closes the session at the ceiling with a spoken and written notice (never a silent cut).
- **Spend-capped voice project:** setup recommends a dedicated OpenAI project for voice with a model allow-list (`gpt-live-1`, `gpt-realtime-*`) and a project spend limit, and a service-account key or workload identity bound to it.
- **D109 mapping** (applied when PR #56 lands): `voice.session.create` is effect `external` with the cost annotation `metered`, surface trust T2+; within budget it is `allowed`. Starting or continuing a session **beyond** the agent's budget, or raising a budget, is a `money.spend` request (approval, `once`, T3). Minting a `minted_ephemeral` is part of the same call and is audited with it.

### 2.7 Multi-user and hosted

Plan usage (`openai:chatgpt-plan`) serves **only the installation owner's own agents** until OpenAI approves PLUR1BUS as a hosted app (the request form, [request a client ID](https://developers.openai.com/siwc/request-client-id) and the cookbook's waitlist). A single-owner self-hosted install (VPS, NAS) counts as "locally hosted" — OpenAI's self-hosted-VM guide describes exactly that ([self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)). On a multi-user install, other users see the profile as unavailable with the reason; API-key and workload profiles are unaffected. The same restriction applies to `openai:codex-cli`.

### 2.8 Headless and self-hosted hosts

Sign in with ChatGPT is loopback-only and has no device grant, so ADR-005's ladder for this profile is: (1) loopback with the printed `ssh -L <port>:127.0.0.1:<port> <host>` hint; (2) **local-then-transfer** per OpenAI's self-hosted-VM guide: the person signs in on their own computer's harness and `plur1bus login openai:chatgpt-plan --transfer <ssh-target>` streams the credential record over their own SSH connection into the remote harness's secret store (no vendor relay, no remote hosting, nothing written to disk in between); the remote keeps **its own** host ID and owns later refreshes; (3) paste-back of the callback URL only behind `--paste-callback` and only after a verification spike, because OpenAI does not document it. A login started from a channel works only for the D24-linked owner in a DM and still completes in the person's own browser.

### 2.9 Interactions

- **D15/D45:** provider kinds become `realtime` (speech-to-speech, `gpt-realtime-*`) and **`live`** (duplex voice front-end with delegated backend, `gpt-live-1`); D45 amended (§3).
- **D16:** `openai:chatgpt-plan` is the first OpenAI template of the generic OAuth client; its registration mode is data.
- **D30:** failover honours `billing_path` (§2.5 item 4).
- **D43 Talk:** prefers `live` with client delegation when the agent has an OpenAI voice profile, then `realtime`, then ASR → agent → TTS.
- **D51/D35:** a paired desktop is the only surface that may receive a `minted_ephemeral`; the pairing token authenticates the request.
- **D67 / ADR-008:** unchanged; SIWC's issued-on-authorize registration is not RFC 7591 DCR, so the MCP no-DCR rule stands. Inbound MCP to ChatGPT (ChatGPT as the OAuth client of the harness's own server, [plugins/build/auth](https://developers.openai.com/plugins/build/auth)) stays with D16's own OAuth server.
- **D109 (PR #56):** deny-list entries (§2.5 item 2), the voice mapping (§2.6), surface trust T2+ for `minted_ephemeral` delivery.
- **ADR-005 action 1:** OpenAI's rows join the 90-day policy re-check with the sources above; the first re-check stays 2026-12-21.

---

## 3. Corrections to existing text (each marked "amended 2026-09-30 (D110)" in place)

| Where | Correction |
|---|---|
| ADR-005 status, Decision, auth-kinds table, profile schema, OpenAI policy rows, amendment D13, Consequences "Revisit when", Conflicts resolution, action item 2b | OpenAI's "no endpoints / client ID / scopes" basis is outdated; amendment D13's route 3 superseded, imported disabled; new kinds `federated_token`, `minted_ephemeral`, mode `dynamic_on_authorize`; new rows for `openai:chatgpt-plan`, workload identity, Realtime and GPT-Live; revisit trigger "OpenAI publishes a third-party OAuth path" met |
| `docs/provider-matrix.md` §1, §2, §4 | new auth-kind codes; OpenAI ChatGPT/Codex subscription row replaced by `openai:chatgpt-plan` with the `siwc` wire constraints; GPT-Live, Realtime and workload identity rows; Codex CLI row labelled personal/local only |
| Core spec D45 | `gpt-live-1-mini` API claim removed; GPT-Live is kind `live`, `gpt-realtime-*` is kind `realtime` |
| `docs/assumptions.md` Q3 | dated note: OpenAI's route 3 superseded by D110 |
| `docs/milestones.md` M2 | auth-engine scope, policy catalogue, acceptance 15–17, effort |

---

## 4. Placement and effort

**M2, the auth engine.** Effort **8–12 ad** on top of M2's current estimate:

| Item | ad |
|---|---|
| Profile schema additions, `dynamic_on_authorize`, host key and RFC 9278 URN, ID-token validation, scope gate | 1.5–2 |
| `siwc` wire profile (forced fields, unsupported-field handling, typed `subscription_sharing_*` errors, UI texts, `billing_path` failover rule) | 1.5–2 |
| `federated_token` kind with Kubernetes and GitHub Actions templates | 1 |
| `minted_ephemeral` + Realtime sideband + audit | 1.5–2 |
| Session broker `voice.session.create` (Realtime unified interface, GPT-Live WebRTC/WebSocket, sideband tool execution, usage summing, voice budgets) | 2–3 |
| Key expiry, region, Codex-CLI label and app-server token feed, deny-list entries, import of the superseded profile, recorded-fixture conformance suite | 0.5–2 |

SIP transports and the desktop's direct WebRTC client ride with M3/D1 (the broker's API is in M2).

---

**Canvas (2026-10-02):** board `V2SignInOpenAI` (desktop spec §13.6) draws §2's routes and the *Sign in with ChatGPT* flow; `V2Settings` and `V2Setup` step 2 link to it. Example values on the board (callback port, account, workspace) are illustrative. Not specified here and therefore not drawn: a *denied* or *workspace not allowed* error, and where the workspace is chosen (the board says "the ones you sign in with").

## 5. Tests and acceptance

No test uses a real OpenAI or ChatGPT account. Live OpenAI calls run **only** in a gated job (`workflow_dispatch` or nightly, environment protection) and only when the owner has provided a secret for it; the job is skipped, not failed, when the secret is absent, and it never runs on pull requests from forks.

1. **Conformance against recorded fixtures** (a local fake of `auth.openai.com` and `api.openai.com` serving recorded, scrubbed responses): discovery, first authorize with `dynamic_agent_client` → issued `oaiapp_…` persisted per account and reused, second account gets its own; ID-token validation rejects wrong `iss`, `aud`, expired `exp` and a wrong `nonce`; a grant without `chatgpt.tokens.use.direct` is refused before inference; `/v1/responses` requests carry `store:false`, `stream:true`, no unsupported field and no `system` item; hosted tools and audio are refused with a typed error; `subscription_sharing_usage_limit_exceeded` stops the turn and does not fail over; a cross-billing failover happens only when the policy names it.
2. **PKCE loopback:** the redirect is exactly `http://127.0.0.1:<port>/auth/callback`, never `localhost`; `S256` verifier/challenge pair checked by the fake; `state` mismatch and a replayed code are refused; the listener binds 127.0.0.1 only and closes after one callback or 10 minutes.
3. **Refresh rotation:** a refresh returns a new refresh token and the old one is refused on reuse; two concurrent turns trigger exactly one refresh (single refresh owner); refresh survives a daemon restart; revocation on logout calls the revoke endpoint and deletes the secret-store entries.
4. **Host ID:** stable across restarts, different across two test homes, a valid RFC 9278 URN whose thumbprint matches the stored key; `--transfer` gives the remote its own host ID.
5. **Ephemeral secret never logged:** a minted `ek_` fixture value, the issued client ID, access and refresh tokens and an `id_token_hint` URL are absent from logs, `--json` output, audit records, exports, backups and fixtures (extends ADR-005 action 8's redaction test); a mint is refused for a T1 surface and a group channel; TTL defaults to 60 s and is capped at 600 s.
6. **Broker:** `voice.session.create` for GPT-Live returns an SDP answer and no credential; the sideband receives a tool call and runs it through the D109 policy fixture; a budget ceiling closes the session with a notice; a request beyond budget produces a `money.spend` approval request.
7. **Workload identity:** exchange against the fake returns a bearer; re-exchange before `expires_at`; a missing subject-token file is `auth-required`.
8. **Never list:** a static test proves the source contains neither Codex's client ID nor `CODEX_APP_SERVER_LOGIN_CLIENT_ID`; the D109 deny-list suite includes the §2.5 paths on every OS; the importer fixture with an OpenClaw OpenAI OAuth profile yields a disabled profile and no token read.
9. **Key expiry:** a key with `key_expires_at` in 3 days raises the `1staid check` warning; an expired key is `auth-required` without a retry.

M2 acceptance gains items 15–17 (`docs/milestones.md`).

---

## 6. Owner questions (defaults the design runs on)

| # | Question | Default if no answer |
|---|---|---|
| Q1 | Replace ADR-005 amendment D13's "ChatGPT/Codex OAuth, restricted, at your own risk" with `openai:chatgpt-plan` via official Sign in with ChatGPT (`allowed`) and retire the Codex-token request-shaping route? | **Yes.** Route 3 retired and imported disabled with a pointer to `openai:chatgpt-plan`; ADR-005 and provider-matrix §4 amended (policy source: the Sign in with ChatGPT docs, checked 2026-09-30). |
| Q2 | Is a harness serving several users (family, team, VPS) "remotely hosted" in OpenAI's sense? | A **single-owner self-hosted** install is covered (OpenAI's self-hosted-VM guide). On multi-user installs plan usage serves only the owner's own agents (`person_bound`); join OpenAI's waitlist before offering it to others. |
| Q3 | `agent_name_hint` and host-ID format | `"PLUR1BUS"`; JWK-thumbprint URN (RFC 9278) of a per-install Ed25519 key in the secret store; one host ID per install; a paired D51 node gets its own. |
| Q4 | GPT-Live delegation default | `client` delegation with the harness agent as backend; `responses` delegation opt-in per agent. |
| Q5 | Is metered voice a D109 `money.spend` event? | No per-call approval: per-agent voice budget (ADR-010 budgets) plus a spend-capped voice project; approval only beyond the budget. |
| Q6 | Realtime client auth mode | Broker (unified interface) by default; `minted_ephemeral` only for the desktop app's direct WebRTC, TTL 60 s, one session. |
| Q7 | Workload identity in M2 or later? | M2 as a profile template (Kubernetes, GitHub Actions); not required for M2 acceptance. |
| Q8 | Keep the Codex-CLI backend `allowed` given "app-server auth never permitted for commercial or hosted services"? | Keep it for the login holder's own local use, labelled "personal/local only"; prefer feeding Codex the harness's plan token so usage is attributed to PLUR1BUS. |
| Q9 | Region | `global` by default; `eu` selectable per profile; Realtime tracing off. |
| Q10 | Fix D45 (no `gpt-live-1-mini` in the API; GPT-Live is a delegating voice front-end)? | Yes: split into kinds `realtime` and `live` (done in this change, marked amended). |
| Q11 (new) | The M7 importer and OpenClaw's/Hermes' OpenAI OAuth profiles | Metadata only; the token values are never read; the profile imports disabled with a "Sign in with ChatGPT again" action. OpenAI API keys keep the existing opt-in secret import (docs/import.md §5.6). |

---

## 7. Risks

- **R1 Preview terms move.** The plan-usage route is documented as a preview with limitations. Mitigation: the profile is data; the 90-day re-check covers it; typed errors surface a change instead of hiding it.
- **R2 Paste-back is undocumented.** Mitigation: loopback + `ssh -L` and local-then-transfer are the supported headless paths; paste-back stays behind a flag after a spike.
- **R3 Voice cost overruns.** Mitigation: budgets checked before and during sessions, spend-capped voice project, the broker closes at the ceiling.
- **R4 Client override of ephemeral-secret config.** Mitigation: broker by default, sideband enforcement, model allow-list and spend limit on the voice project, 60 s TTL.
- **R5 Realtime pricing is inconsistent on the model page** ($5 vs $4 input). Mitigation: prices read at setup and shown with their source, never hard-coded.
- **R6 Merge order with D109 (PR #56).** D110 references D109's deny-list, `money` effect and surface trust; if D110 merges first, those clauses apply when D109 lands, and the core-spec table rows need a trivial reorder.
