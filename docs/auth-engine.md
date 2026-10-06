# Auth engine (core)

`packages/core/src/auth/` implements ADR-005's token side: profiles as data, the headless login ladder, one refresh owner and credential pools. It hands provider adapters an `Authorization` header plus expiry and owns no I/O of its own. M2 acceptance 1, 2 and 7 (the part the core can test) live here; the OpenAI-specific D110 flows and the real secret store are separate work.

## Ports

| Port | Purpose | Here |
|---|---|---|
| `SecretStore` (`get/set/delete` by `secret_ref`) | the only place a secret is read or written | `InMemorySecretStore` (fake); the keychain/encrypted-file store is task 2 |
| `Clock` | all expiry and cooldown arithmetic | `systemClock`; `FakeClock` in tests |
| `Refresher` | the token-endpoint call; throws `RefreshRejected("invalid_grant" \| "transient")` | an HTTP adapter is a later task |
| `AdcTokenSource` | ambient Google credential for `adc` profiles | a Vertex adapter implements it |
| `AuthLog` | `(event, fields)` of ids, codes and counts | tokens never reach it |

## Profiles

`validateProfile` / `loadProfiles` (`profile.ts`) take the ADR-005 record. Kinds: `api_key`, `oauth_pkce`, `device_code`, `adc`, and `external_cli` (the delegated-binary pattern: the harness holds no credential and `getAuthorization` answers `delegated_login`). Validation is closed (an unknown field is refused, so a secret cannot ride along), refuses `policy_status: prohibited`, header-injection in `auth_header_scheme`, and non-https endpoints except loopback.

## Login ladder

`planLogin(profile, env, { pasteCallback })` returns the method to start with and the fallbacks, so the CLI can say which was used. `canOpenGraphicalBrowser()` and `isRemoteSession()` read an injected `EnvSnapshot`: a remote marker (`SSH_*`, Codespaces, remote containers, …) always wins over `DISPLAY` (X forwarding must not look local); on Linux a display is required.

| Environment | Profile | Method, then fallbacks |
|---|---|---|
| any | `api_key` / `adc` / `external_cli` | `enter_key` / `adc` / `delegated_cli` |
| any | `device_code` | `device_code` |
| local graphical | `oauth_pkce` | `loopback_pkce`, [`device_code` if documented], `paste_callback` |
| headless, device code documented | `oauth_pkce` | `device_code`, `loopback_ssh`, `paste_callback` |
| headless, none documented | `oauth_pkce` | `loopback_ssh` (with `ssh -L <port>:localhost:<port>` hint), `paste_callback` |
| any, `--paste-callback` | `oauth_pkce` | `paste_callback` |

## Refresh

`RefreshOwner` keeps one in-flight refresh per credential: any number of concurrent turns share it, and a late caller re-reads the store and finds the fresh token. The rotated token is written to the store before any waiter is released; if the store refuses, the record is held in memory and retried on the next access, because the vendor has already spent the old token. A refresh token the vendor rejects (`invalid_grant`) or whose known expiry has passed produces `AuthError("reauth_required")` with `action: "plur1bus login <profile>"`, is remembered in the record (`reauthRequired`), and is never presented again until a new login replaces it. A transient failure keeps the login: inside the skew window the still-valid token is used, after expiry the caller gets a retryable `refresh_failed`. Refresh state lives in the store, so a restarted core continues with the rotated token.

## Pools and cooldowns

`CredentialPool` (one per profile, the single cooldown authority for interactive turns and cron) selects by `fill_first | round_robin | least_used` and classifies failures with our own codes:

| Status | Code | Certainty | Scope |
|---|---|---|---|
| 429 with `hint: quota_exhausted` | `quota_exhausted` | confirmed | credential |
| 429 | `rate_limited` | ambiguous | model if known, else credential |
| 401 | `auth_rejected` | confirmed | credential |
| 403 | `forbidden` | ambiguous | model if known, else credential |
| other | none, no cooldown | | |

Cooldowns (`COOLDOWN_MS`): confirmed 1 h, ambiguous 60 s; the credential left alone in the pool cools 5 min / 15 s. A vendor `Retry-After` replaces the table value (1 s to 24 h) and a cooldown is never shortened. A 401 on an OAuth token believed valid first spends one refresh (`reportResult` invalidates that token generation), and only a 401 on a freshly refreshed token cools the credential. `snapshot()`/`restore()` carry non-secret pool state for a later persistence task.

## Credentials provider

`createCredentialsProvider(...)` returns `getAuthorization({ profileId, model? })` giving an `AuthorizationLease` (`header: {name, value}`, `expiresAt`, `credentialId`) and `reportResult(lease, result)`. A lease prints redacted from `JSON.stringify`, `String` and `util.inspect`. Errors are `AuthError`s built from constants: no token, header or foreign error message is ever copied into one.

## Rulings (open owner questions answered with the document's recommended default or fail-closed)

- Cooldown sizes (above) are ours; ADR-005 prescribes the shape, not the numbers.
- With a local browser, loopback PKCE is preferred over device code (fewer steps); the ADR's ladder order applies when headless.
- `external_cli` is a fifth profile kind for the delegated-binary pattern named in ADR-005; D110's `federated_token`/`minted_ephemeral` are refused until their task.
- ADR-005 Q5 (per-user credentials): pool entries are plain data, so Owner-provisioned and per-user entries share one mechanism; scoping per user is the secret-store task's concern.
