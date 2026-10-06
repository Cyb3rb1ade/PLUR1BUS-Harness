# M2 Auth engine (core) Implementation Plan

**Goal:** A data-driven auth engine in `packages/core/src/auth/` that hands provider adapters an `Authorization` header plus expiry, with a headless login ladder, exactly one refresh per credential, and credential pools with cooldown failover, storing secrets only through a `SecretStore` port.

**Spec:** ADR-005 ("Auth kinds", "Declarative auth profiles", "Headless / SSH", "Token lifecycle and credential pools", action items 3, 4, 6, 7, 8); `docs/milestones.md` M2 scope "Auth engine" and acceptance 1, 2, 7; `docs/phase0/research/providers-chat-auth-caching.md`. The OpenAI-specific D110 flows (`federated_token`, `minted_ephemeral`, `dynamic_on_authorize`, `billing_path`, wire profiles) are out of scope; profile validation is closed, so those fields are refused until their task adds them.

## Architecture

Pure TypeScript on Node built-ins, no new dependency, no I/O of its own. Everything outside reaches the engine through ports: `SecretStore` (task 2 builds the real one; here an in-memory fake), `Clock`, `Refresher` (the token-endpoint call; an HTTP adapter is a later task), `EnvProbe`, `AdcTokenSource`, an optional log sink. The engine never writes a token anywhere except `SecretStore.set`.

## Files (all new)

| File | Purpose |
|---|---|
| `src/auth/errors.ts` | `AuthError` with a closed code set; messages built from constants, never from a token or a foreign error message |
| `src/auth/redact.ts` | `scrub()` and a registry of known secret values, for the marker test and last-line defence |
| `src/auth/profile.ts` | profile type, closed validator, `loadProfiles` (refuses `policy_status: prohibited`), header-scheme parsing |
| `src/auth/secret-store.ts` | `SecretStore` port, `InMemorySecretStore`, credential record codec |
| `src/auth/clock.ts` | `Clock` port, `systemClock` |
| `src/auth/env.ts` | `canOpenGraphicalBrowser()`, `isRemoteSession()` over an injected env snapshot |
| `src/auth/ladder.ts` | `planLogin(profile, env, opts)`: ordered login methods, ssh hint, which was used |
| `src/auth/refresh.ts` | `RefreshOwner`: single-flight per credential, skew, rotation persisted before release, typed re-auth |
| `src/auth/pool.ts` | `CredentialPool`: `fill_first|round_robin|least_used`, failure classifier (confirmed vs ambiguous), per-credential and per-model cooldowns, one authority |
| `src/auth/credentials.ts` | `CredentialsProvider` interface, `AuthorizationLease`, `createCredentialsProvider` |
| `src/auth/index.ts` | public surface |
| `docs/auth-engine.md` | what it is, the ports, the RULINGs |
| `test/auth/*.test.ts`, `test/auth/helpers.ts` | tests with `FakeClock`, scripted `Refresher`, marker tokens |

## Tasks

1. Errors, redaction, clock, secret store, profile schema and validator. Tests: `profile.test.ts` (valid profiles for each kind; unknown key refused; `prohibited` refused; CR/LF in header scheme refused), `store.test.ts`.
2. Environment predicates and the headless ladder. Test: `ladder.test.ts` (table).
3. Refresh owner. Tests: `refresh.test.ts` (concurrent refresh calls the refresher once; restart reuses the rotated token; expired refresh token is a re-auth error; transient failure retried later; persist failure keeps the rotated token).
4. Credential pool. Test: `pool.test.ts` (fake clock: failover, cooldown expiry, sole-credential shorter cooldown, per-model scope, strategies, Retry-After).
5. Credentials provider and the no-token-in-output marker test. Tests: `credentials.test.ts`, `redaction.test.ts`.
6. Docs, full gates, PR.

## Acceptance to test

| Acceptance | Test |
|---|---|
| Concurrent refresh yields exactly 1 refresh call (M2 acc. 2) | `refresh.test.ts` "N concurrent callers share one refresh"; `credentials.test.ts` "ten concurrent leases, one refresh" |
| Refresh survives a daemon restart, rotating token single-use (acc. 2) | `refresh.test.ts` "a new owner over the same store continues with the rotated token" |
| Pool failover with cooldown, fake clock | `pool.test.ts` |
| Headless ladder table-tested (acc. 1) | `ladder.test.ts` |
| Expired refresh token gives a clear re-auth error | `refresh.test.ts` "invalid_grant", "known refresh expiry" |
| No token value in logs or errors | `redaction.test.ts` marker test over errors, log sink, lease JSON/inspect |
| No `prohibited` profile loadable (acc. 7) | `profile.test.ts` |

## Rulings and open points

Recorded in the PR body and `docs/auth-engine.md`.
