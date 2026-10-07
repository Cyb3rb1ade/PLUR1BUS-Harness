# D110 OpenAI auth core library

Contract: [D110 design](superpowers/specs/2026-09-30-openai-auth-design.md), which wins over older ADR language. These are in-process libraries; RPC, CLI, UI and production port wiring are follow-ups. Tests use a synthetic in-process endpoint dispatcher, never network sockets or real credentials.

## Y1: Spec section → implementation → test

Inventory on origin/main at 661ad75f: generic auth, secrets, egress and token budgets exist; no D110 auth or voice implementation. Generic auth's closed validator does not accept D110 kinds. Every row below is implemented through new libraries and explicit ports, without modifying the generic engine.

| Spec / requirement | Implementation | Test |
|---|---|---|
| §2.1–2.3 registration, account isolation, entry ID never stored | `ChatGPTPlan.login`, secret account record | Acceptance 15 |
| §2.1 RFC 9278/7638 stable Ed25519 host, no silent rotation | `HostIdentity.id` under refresh-owner lock | host identity |
| §2.3 discovery, public client, resource, scopes, nonce, S256 | discovery + `PkcePort`, `LoopbackPkce` | Acceptance 15, loopback tests |
| §2.3 iss/aud/exp/nonce, JWKS cache, scope gate | `JwksVerifier`, login gate | OIDC rejection matrix, scope test |
| §2.1/2.3/§5.3 single-use refresh, owner, restart, logout | durable consume marker + `RefreshPort`, revoke | Acceptance 15, refresh failure tests |
| §2.3 responses only, forced fields, unsupported fields/tools/audio/files/system refused | `guardSiwc`, models from `/v1/models` | siwc matrix, Acceptance 15 |
| §2.3 subscription errors, required UI texts and usage link | closed error codes, `UI_TEXT` | Acceptance 15, UI constants |
| §2.1/2.3 workload, no refresh/persistent bearer, headless source | `WorkloadIdentity`, subject port | workload tests |
| §2.3 API key expiry 14/3 days, expired never retried, hashed safety identifier | `keyStatus`, `ApiKeyCredential`, broker headers | expiry tests, voice request tests |
| §2.3 region global/us/eu, plan global only, EU setup notice | `endpoint`, profile data, voice routing | regional tests |
| §2.5.4 billing path policy, recorded cross-billing, usage-limit stop | `chooseFailover` | billing tests, Acceptance 15 |
| §2.4/2.5.1–3 foreign IDs/fingerprints/backend-api/credential stores never used | closed endpoints; canonical deny port; CLI metadata | Acceptance 17 |
| §2.5.5/2.7 person-bound owner-only; hosted approval required | principal gate | owner-only tests |
| §2.5.6–8 no client project credential, no secret logging, store false | `Sensitive`, fixed errors/events, broker DTO | Acceptance 16, redaction |
| §2.1/2.3/2.9 ephemeral desktop WebRTC only, T2+, 60/600 s, one session, no persistence | `VoiceBroker.mint`, `EphemeralSecret` | ephemeral tests |
| §2.1/2.3 Realtime default broker, unified interface; Live client delegation, fixed model, store false | `VoiceBroker.create`, sideband port | Acceptance 16, Realtime broker |
| §2.3 sideband tools, instructions, tracing off, usage + backend, session closure/cap | policy/sideband/session ports, event handling | voice policy, usage/cap/expiry tests |
| §2.6 before/during budgets, notice, beyond-budget money.spend | atomic reservation + accounting BudgetPort, PolicyPort | Acceptance 16, budget tests |
| §2.5/§3/§5 disabled D13 metadata, no token import | `importedProfile`, deny before read | Acceptance 17 |
| §2.8 SSH loopback, transfer keeps destination host, no paste-back without spike | `LoopbackPkce`; transfer uses account records only | loopback, transfer tests |
| §2.9 no MCP DCR/device grant, SIP/desktop integration deferred | no registration/device endpoint, explicit unsupported SIP | profile + transport tests |
| §5 synthetic fixtures, no live tests by default | in-process fake; explicit live gate | Acceptance 15/16/17, gated smoke |

Dedicated voice project model allow-list/spend limit and EU Modified Retention amendment are setup requirements (the library cannot verify org contracts). Concurrent capacity and prices are supplied by setup, never guessed by the library. Tokens are accessible only through explicit sensitive getters at the transport/secret boundary; generic JSON/inspection is redacted. No secret records belong in exports or backups.

## Profiles and ports

`profiles` describes `openai:api-key`, `openai:chatgpt-plan`, `openai:workload-identity`, `openai:realtime`, `openai:gpt-live` and the existing `openai:codex-cli` lane. The plan route is global-only, person-bound, available only to the installation owner's agents on local/single-owner self-hosted installs. Other users and hosted multi-user deployments are refused. Codex is labelled **personal/local only**, spawned unmodified in a follow-up; this library never owns its login or credential files.

`HostIdentity` generates one Ed25519 key in the SecretPort, derives the RFC 7638 canonical public JWK thumbprint and returns the RFC 9278 URN. Corrupt stored identity is refused, never replaced. Configuration wiring stores the non-secret URN in the install config; account transfer never touches the destination key.

`ChatGPTPlan.login(account, principal)` reads OIDC discovery, requests the full documented scopes/resource with S256/state/nonce through the PKCE port, validates the callback and cryptographic ID-token signature/claims through cached JWKS, checks direct-use scope, and stores the issued client ID with that account's tokens/subject/workspace only. The entry ID is used only at first authorization. Reauthorization cannot silently switch an existing account slot's identity. `LoopbackPkce` binds an ephemeral port on 127.0.0.1, closes after one callback/abort, and is injectable for socket-free tests. The caller's browser port may print an SSH forwarding hint `ssh -L <port>:127.0.0.1:<port> <host>`; no credential entry is automated and no paste-callback fallback is enabled.

`RefreshPort.exclusive` is a mutex with per-key serialization, **not** a result-sharing cache across arbitrary login/logout/lease operations. The core must supply one authority shared by all library instances. Lease calls reread durable state under this mutex; two concurrent turns cause one rotating refresh. A durable spent marker precedes token exchange. After unknown network outcomes or failed persistence the old token is never retried, including after restart; reauthentication restores availability. Logout revokes remotely and deletes the local record. Transfer is a person-run authenticated SSH move through a sensitive port, never a disk export or an agent tool.

`WorkloadIdentity` exchanges OIDC subjects from file/env/metadata via a source port. `audience` and `principal` describe the configured external identity/mapping; `identity_provider_id` and `service_account_id` are the explicit OpenAI mapping identifiers. The wire uses JSON at `https://auth.openai.com/oauth/token` with the documented grant and subject type. Regional API hosts apply to later API calls, not the auth endpoint. The bearer is in memory only, has no refresh token and is re-exchanged before expiration; absolute expiry is honoured. Kubernetes and GitHub Actions source templates are included. X.509 uses the same kind with an explicitly configured certificate HTTP port at `https://mtls.auth.openai.com/oauth/token`, omits the subject token and never falls back to OIDC. Production certificate transport wiring remains a follow-up; this library does not read certificate/private-key files. Later X.509 API calls also require the configured mTLS transport. Wire reference: [OpenAI workload token exchange](https://developers.openai.com/api/reference/workload-identity-federation).

`ApiKeyCredential` checks expiry before reading a secret, reports 14-day and 3-day warning states, and refuses expired keys without retry. `endpoint` selects global/us/eu API hosts. Setup must state the EU Modified Retention requirement; it cannot be inferred from a bearer. Dedicated service-account keys and voice project limits are recommended.

## SIWC, errors, billing and Never list

`guardSiwc` forces `store:false`/`stream:true`, refuses every unknown or unsupported top-level field, system items, hosted tools and audio, and admits only function tools. There is no Files, embedding, voice or backend-api entry point on the plan client. Models come from `/v1/models` using the same lease. Inference payloads have explicit sensitive in-process access and redacted generic JSON/inspection; never export a raw transport payload.

Subscription-sharing errors use closed typed codes and constant messages, never vendor-provided diagnostic text. Usage-limit errors stop the turn and expose the usage link through `UI_TEXT`. `chooseFailover` skips differing billing paths unless policy explicitly names `from`/`to`, and never turns usage-limit exhaustion into key failover. Selected decisions are audit events. UI constants and their source are [OpenAI UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines).

Never send another app's client ID or fingerprint; never set a vendor login-client override; never read/copy/refresh Codex, OpenClaw or Hermes credentials, including OS keychain entries, custom HOME roots, Windows local app data and another app's issued registration. `FOREIGN_CREDENTIAL_STORES` supplies deny metadata; `createCredentialDenyPort` checks platform-canonical roots/items and foreign-registration metadata before any read. Production D109 owns canonicalization including home/env aliases and symlinks. Imported D13 route-3 metadata is visibly disabled and points to a new plan sign-in; no token value enters that API.

Neither tokens, issued client IDs, ephemeral values nor ID-token hints belong in logs, events, errors, generic JSON, exports, backups or fixtures. Authorization URLs and token-bearing requests redact generic serialization/inspection. Fixtures generate sensitive markers at runtime only; tests inspect all observable audit/error/output boundaries. No foreign credential path is opened by this library.

## Follow-ups and verification

RPC/schema exposure, CLI `plur1bus login openai`, automatic background refresh scheduling, real auth/secret/egress/D109/budget port wiring, install-config URN storage, SSH transfer endpoint authentication, preferred Codex app-server plan-token feed, Desktop WebRTC, SIP with M3/D1, web UI texts, setup/recheck UX and real vendor acceptance are separate integration work. The library is not advertised as an already wired login command.

Run with Node 24.21:

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 packages/core/test/openai-auth/*.test.ts packages/core/test/voice/*.test.ts
pnpm typecheck
pnpm lint
```

The optional read-only live model smoke requires both `PLUR1BUS_LIVE_OPENAI=1` and an owner-supplied `PLUR1BUS_LIVE_OPENAI_KEY`; otherwise it is skipped. It was not enabled for local verification. No workflow change enables it.

Local verification (2026-10-08, Node 24.21.0): 43 D110 tests passed; 1 explicitly gated live smoke skipped. Named Acceptance 15, 16 and 17 passed. Full workspace typecheck and lint passed, including hygiene and all 94 lint-script tests. This is library/port acceptance against synthetic fixtures; no real OpenAI acceptance, RPC/CLI integration, CI result or merge is claimed.
