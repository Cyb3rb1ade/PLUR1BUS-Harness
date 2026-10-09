# D110 OpenAI authentication

The [D110 design](superpowers/specs/2026-09-30-openai-auth-design.md) and ADR-005 define the policy. The Core composition registers `AuthService`, the OpenAI provider binding and voice services. Login remains an in-process API; RPC, CLI and Web login are the follow-up package after AC. No RPC schema or RBAC policy is changed.

## Spec vs. main inventory

Baseline: `origin/main` at `f250d8f5`, including merged #293 and the D110 libraries.

| Gap on main | This change |
|---|---|
| PKCE/OIDC and rotating plan records existed behind ports | Production egress-checked HTTP, actual loopback listener, AuthService, durable metadata index and serialized refresh ownership |
| No UI-facing Core auth API | `startLogin`, `awaitLogin`, `cancelLogin`, `listCredentials`, `logout`, `status`; typed composition registration callbacks |
| Responses adapter had an unused plan switch | Dynamic registration profiles use Responses only, credential-specific model list, forced SIWC fields, `billingPath: plan` and existing #293 budget admission |
| No subscription-unit ledger | Durable `plan_tokens` ledger alongside existing token-budget accounting; no guessed USD prices |
| Workload exchange was a library-only port | External file/binary bearer suppliers with expiry, single-flight, bounded execution and explicit environment |
| Voice broker had no production transport or client delivery binding | Authenticated pinned WebSockets, PCM relay, Live handles, Realtime delivery binding, existing budget admission, voice-seconds ledger and lifecycle cleanup |
| No corrected AE5 handles | Random 256-bit Harness handles, hashed server-side entries, person/session/model/surface binding, TTL/replay/revocation errors and audit |
| No auth config/manual entry | Closed `auth.openai.*` schema, generated config reference and opt-in development script |

Existing Keychain/DPAPI/libsecret and encrypted-file backends are reused. No foreign credential file, including Codex's login, is opened, imported or shared. The superseded `openai:chatgpt-oauth-restricted` ID is refused by the profile loader and points to a fresh plan login. Codex CLI remains an unchanged delegated binary. Optional existence-only Codex login hints are not added.

## Login and account selection

A trusted Core surface obtains the service through `CompositionOptions.onOpenAI` (or `TurnComposition.openai.auth`). It supplies `PlanPrincipal` from its authenticated person and agent ownership, never from an agent message or request body. Plan use is owner-only on local/single-owner self-hosted deployments.

```ts
const principal = { owner, user: owner, agentOwner: owner, deployment: 'local' as const };
const { authorizeUrl, loginId } = await auth.startLogin({ principal });
// Explicit browser delivery only; never log the URL or serialize it to diagnostics.
openBrowser(authorizeUrl.value());
const credential = await auth.awaitLogin(loginId, principal);
const saved = await auth.listCredentials(principal);
await auth.logout(credential.id, principal);
```

`authorizeUrl` is a redacted `Sensitive` value. Every attempt gets a new S256 verifier, state and OIDC nonce. The listener binds only `127.0.0.1` on a random port at `/auth/callback`, checks Host and Origin when present, consumes one callback and closes on callback, cancellation or timeout. Constant errors include `state-mismatch`, `access-denied`, `port-in-use`, `login-timeout` and `login-cancelled`. Callback HTML/text has no external resources and forbids caching/referrers.

First authorization uses `dynamic_agent_client`. The callback-issued registration belongs to the verified subject and workspace; it is stored only in the secret service. Returning login selects a saved `credentialId`, reuses that registration and refuses a different subject/workspace. New workspace selection happens in OpenAI's browser flow; the Core's returned metadata lists saved workspace registrations for subsequent selection. No invented workspace-selection endpoint is called. See [OpenAI registration/sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

The per-install Ed25519 key and its RFC 9278 host identifier survive restart. OIDC verification checks signature, issuer, issued-client audience, expiry and nonce; inference additionally requires `chatgpt.tokens.use.direct`.

## Storage, refresh and logout

Tokens, issued client IDs and refresh state are encrypted/keyring records. The separate secret-store index contains credential IDs, person/workspace metadata and expiry, never tokens. Public lists/status and object inspection contain no token or issued client ID. The existing secret service supplies auditing, atomic encrypted-file writes and owner-only permissions/Windows ACL handling. File fallback remains opt-in through `secrets.fileFallback.enabled`; `auth.openai.storeBackend: keyring` refuses fallback. `auto` reuses the secret service's configured selection.

Refresh happens on demand before expiry, with configurable lead time and up to 15 seconds of jitter. One Core owner serializes login, refresh and logout for each credential; ten parallel turns share one rotation. Before exchange, a durable spent marker prevents refresh-token reuse after an ambiguous failure or crash. Failure requires a new login rather than an endless retry loop. Login/refresh/logout/refresh_failed events contain fixed kinds/codes only. Logout removes local state even if discovery or provider revocation fails; provider revoke failure is still reported.

## Provider and billing

A configured provider definition uses `wireFormat: codex_responses`, profile kind `oauth_pkce`, `client_registration: dynamic_on_authorize`, `billingPath: plan`, and `openai: { credentialId, person, deployment? }`. The profile must belong to the authenticated turn person. Each model is checked using `/v1/models` with the same credential; configured API-key adapters retain their existing behavior.

Plan inference uses public `/v1/responses`, forces `store:false` and `stream:true`, hoists instructions and refuses unsupported sampling options/hosted tools/audio. The harness's `maxTokens` admission estimate is omitted from SIWC's wire body. Chat Completions is rejected explicitly. `subscription_sharing_usage_limit_exceeded` preserves Retry-After and stops retries/fallback. Other rate limits retain normal bounded router handling.

The existing turn budget still admits and settles each attempt, including retries and fallback; #293's `allowCrossBilling` policy remains unchanged. Plan input/output counts additionally enter `state/openai-plan-usage.sqlite`, exposed as `plan_tokens` through `TurnComposition.openai.usage.total(person)`. Unknown counts remain unknown. There is no fabricated subscription USD price: the shipped price table leaves plan calls unpriced, so an applicable hard cost limit retains the existing fail-closed `unpriced-model` behavior. The separate ledger is not a new `budget.*` RPC field.

## Federated suppliers

Kind `federated_token` uses `openai.federated` on the provider binding. The supplier is either a file or an executable plus literal argument array. It returns `{ "access_token": "…", "expires_at": <epoch seconds> }`. The bearer lives in memory; expiry triggers a single new supplier invocation. Binary execution has no shell, inherits no ambient environment, uses only configured environment entries, caps output at 64 KiB and has a deadline. File suppliers check the existing foreign-store deny roots before opening contents, including canonical aliases; reads are bounded to 64 KiB. Missing, expired, oversized or failed output yields a constant `auth-required` error. The existing `WorkloadIdentity` exchange library and its Kubernetes/GitHub/X.509 ports remain available; production cloud-metadata/mTLS wiring is separate from this external-supplier path.

## Configuration and manual test

The generated [config reference](config.md) contains client registration, login/HTTP deadlines, refresh lead time, backend selection, Live handle TTL, voice daily seconds/capacity and federated supplier defaults. Auth config changes restart Core. Source-generated config fixtures are deliberately excluded from this PR as requested; they belong to package AD.

The development-only script uses a dedicated home and the existing keyring. It prints only the explicit first-registration URL and safe credential/model metadata. It never runs in tests or installers:

```sh
PLUR1BUS_OPENAI_LOGIN_LIVE=1 node --experimental-strip-types --conditions=source scripts/dev/openai-login.ts /absolute/path/to/test-home
```

`auth-required`: sign in again. `scope-denied`: authorize plan-use scope or select an allowed model. `owner-only`: check the authenticated person/deployment and configured credential. Plan exhaustion: show the plan limit/reset instead of switching billing. Keyring unavailable: enable the existing encrypted fallback explicitly or restore the keyring.

## Tests and remaining delivery work

The library conformance tests remain, extended with local HTTP OAuth/Responses and WebSocket Live servers. A started Core performs AuthService login → authenticated `session.submit` → Responses → durable plan/budget usage, with token-free logs. Tests cover ten-way refresh, failure/restart/logout, supplier execution, callback rejection, handle binding/replay/expiry/revoke and Realtime single-use delivery.

Follow-ups after AC: auth RPC/CLI/Web UI, model/usage presentation, desktop media client, SIP, cloud metadata/mTLS transports and setup-provided vendor price/capacity discovery. Owner questions Q1–Q11 use D110's documented defaults; corrected AE5 explicitly chooses the Live Harness-handle relay. Local synthetic acceptance is not real-provider or native Windows/Linux acceptance. No CI result is claimed.
