# Workload Identity Federation as an auth-engine credential kind — design

**Status:** Draft for owner review. Owner decision of 2026-10-29 is binding (support WIF; not urgent, v0.2 /
enterprise track; the personal default stays unchanged). Open owner questions are in §17 · **Date:** 2026-10-29 ·
**Owner:** Christian (Cyb3rb1ade) · **Track:** auth engine (ADR-005), enterprise ·
**Plan:** [`2026-10-29-workload-identity-federation.md`](../plans/2026-10-29-workload-identity-federation.md)

**Parent documents:** [ADR-005](../../adr/ADR-005-auth-policy-and-secrets.md) (kinds, profiles as data, the single
refresh owner, pools, secret storage), [`docs/auth-engine.md`](../../auth-engine.md),
[`docs/openai-auth.md`](../../openai-auth.md) (D110: `federated_token`, external suppliers), the D110 spec
[`2026-09-30-openai-auth-design.md`](2026-09-30-openai-auth-design.md) §2.1, [`docs/egress.md`](../../egress.md).
This spec changes none of them; §18 lists the amendments the implementation PRs make.

**Inputs read** (`origin/main` @ `abc9fbcbcf`): ADR-005; `docs/auth-engine.md`, `docs/openai-auth.md`,
`docs/egress.md`, `docs/providers.md`, `docs/containers.md`, `docs/doctor.md`, `docs/mcp-client.md`;
`packages/core/src/auth/{profile,credentials,refresh,pool,http,adc,secret-store,redact,env,errors}.ts`;
`packages/core/src/openai-auth/{workload,federated,profiles,provider,runtime}.ts`;
`packages/core/src/composition/{auth,index}.ts`; `packages/core/src/discovery/real-adapters.ts`;
`packages/core/src/voice/runtime.ts`; `packages/core/src/tools/exec/env.ts`; `packages/core/src/mcp/env.ts`;
`packages/core/src/host-tools/denylist.ts`; `packages/providers/src/anthropic/{client,types}.ts`;
`packages/config-schema/schema/config.schema.json` (`auth`, `providers`);
`crates/plur1bus/src/commands/{login,firstaid}.rs`; `packages/web/src/pages/settings/sections/providers.ts`;
`.github/workflows/nightly.yml`. External documentation was read on 2026-10-29; every fact in §4 names its source.

## 1. The decision being designed

Owner, 2026-10-29: Workload Identity Federation (WIF) becomes a supported credential kind of the auth engine,
scheduled for v0.2 on the enterprise track, not urgent. The personal default (Anthropic via the Claude Code headless
backend, Sign in with ChatGPT, API keys) is unchanged and WIF never activates by itself.

What WIF buys: a harness that runs in Kubernetes, on a cloud VM or in CI calls the Anthropic and OpenAI APIs with
**no static key** in config, secret store, container image or CI secret. The workload presents a short-lived JWT
from an identity provider (IdP) it already has; the vendor checks it against operator-configured trust rules and
returns an access token that lives minutes. Revocation is a rule or IdP change, not a key hunt.

## 2. Goal and non-goals

**Goals (v1).**

- **G1** A vendor-neutral profile kind `workload_identity`, configured as data (ADR-005 "profiles as data"), with a
  closed set of per-vendor exchange adapters: Anthropic (RFC 7523 `jwt-bearer`) and OpenAI (RFC 8693
  `token-exchange`).
- **G2** Identity-token sources `file` (Kubernetes projected tokens, spiffe-helper, any rotating file) and
  `github_actions` (OIDC request with an explicit audience), both through the egress gate with fixed rules.
- **G3** Exchange, caching and refresh owned by the existing `RefreshOwner` (one owner per core, one flight per
  credential), minted token in memory, every identity token presented at most once.
- **G4** Failure classification into the existing `AuthError` / pool / router vocabulary, with diagnostics that make
  the vendors' deliberately opaque denials actionable.
- **G5** Surfaces: config, `plur1bus login status` / `login test`, `1staid check`, a read-only web view, docs.
- **G6** Environment hygiene: no stray vendor key or federation variable can change which credential a harness
  provider or a harness-spawned process uses.

**Non-goals.**

- **No identity provider of our own.** The harness never signs identity tokens, never runs an OIDC issuer or JWKS
  endpoint and never verifies identity-token signatures (the vendor does). It only obtains and presents tokens.
- **The personal default is untouched.** No change to the Claude Code / Agent SDK route (ADR-005 D12), Sign in with
  ChatGPT (D110), the Anthropic setup-token route or API keys. Vendor environment variables are ignored unless an
  operator opts in (§6.4).
- **Not a replacement for subscription use.** WIF bills an organisation's API workspace (`billingPath: workload`,
  class `paid`); it is not a way to use a Claude or ChatGPT subscription.
- **No Codex WIF.** Codex's WIF is beta, maps to a ChatGPT principal and is Codex's own (§4.3); the Codex CLI route
  stays "personal/local only" (D110).
- **No admin use.** Minted tokens with `org:admin` (or `workspace:manage_tunnels`) scope are refused (§11). The
  harness does not create or edit issuers, rules or service accounts; that stays with the Console / Admin API.
- **Not in v1:** cloud-metadata sources (GCP metadata server, Azure IMDS, AWS STS `GetWebIdentityToken`), a `command`
  source, Google ADC `external_account`, Azure OpenAI with Entra ID, OpenAI X.509/mTLS, several WIF identities in one
  pool, WIF parents for voice. Each is placed in §5.4 or §7.3 so that adding it later is a new adapter or source, not
  a redesign.

## 3. Decisions at a glance

| # | Topic | Decision | Main alternative, why not |
|---|---|---|---|
| W1 | Kind | New kind **`workload_identity`**: the harness performs the exchange. `federated_token` keeps its D110 production meaning (a trusted external file/program supplies an already-minted bearer). | Overload `federated_token`: it is hard-wired to the OpenAI D110 service (`credentials.ts` refuses it, voice uses it as a parent) and its shipped path is a supplier, not an exchange. |
| W2 | Exchange | Closed adapter set `anthropic` / `openai` with **endpoints fixed in code**; adding a vendor is code plus an ADR row. | A generic URL + body template in config: a configurable credential-forwarding endpoint and an untestable error mapping. |
| W3 | Sources (v1) | `file` (re-read for every exchange) and `github_actions` (a fresh JWT per exchange, audience required). | Cloud metadata now: the egress gate refuses link-local/metadata addresses by design; that needs a named exception (§7.3). |
| W4 | Minted token storage | **Memory only** by default; opt-in `auth.workloadIdentity.restartCache: "secret-store"` (owner Q2). | Always persist: a new at-rest bearer and a stale-state class for a token that is re-derivable in seconds. |
| W5 | Single use | **Spent-assertion ledger:** an identity token's SHA-256 is recorded *before* it is presented and it is never presented again, whatever the outcome; the hash (not the token) survives restart. | Retry the same JWT on timeout: Anthropic answers `jti_reused`, OpenAI requires a new assertion after an unknown outcome. |
| W6 | Refresh | Through `RefreshOwner`, new mint path: advisory at expiry − 120 s (0–30 s early jitter), mandatory at expiry − 30 s, transient backoff 1–60 s; **no exchange while the identity token is unchanged**. | A separate timer per provider adapter: two owners, double-spent assertions. |
| W7 | Failures | Opaque 401 → `workload_denied`, never retried with the same JWT, at most 3 consecutive denials with fresh JWTs, then background attempts stop; 400 → `workload_config_invalid`; 408/429/5xx/network → `refresh_failed` (transient). | Generic 401 handling: the harness cannot tell `jti_reused` from a rule mismatch, so blind retries burn assertions and flood the Console history. |
| W8 | Precedence | The harness has no credential precedence chain: a provider uses exactly its profile. No vendor credential variable is read unless opted in; child processes get an allowlisted environment plus a hard **deny set** of vendor credential names. | Mirror the SDK chain: a leftover `ANTHROPIC_API_KEY` would silently win, the documented SDK pitfall. |
| W9 | Env import | `auth.workloadIdentity.importEnv.{anthropic,openai}`, default `false`, read once at core start, file sources only; a literal token in the environment is refused. | Always import: an operator's SDK env would switch the harness credential without a config change. |
| W10 | Anthropic header | `anthropic_messages` gains a **bearer mode** (`Authorization: Bearer`); the `x-api-key` path is unchanged. | Put the bearer into `x-api-key`: today's composition would send `Bearer …` there, which the API does not document. |
| W11 | Scope | Accept `workspace:inference` and `workspace:developer`; refuse `org:admin` and `workspace:manage_tunnels`; docs recommend `workspace:inference`. | Accept any scope: an admin-scoped token behind a chat provider is an over-privileged bearer in memory. |
| W12 | CLI | **Config-only definition**; `login status` lists workload profiles, `login test <profile>` runs one exchange, `login <vendor> --workload-identity` prints a `config set` command and writes nothing. | A full `login` writer: there is nothing to sign in to or store, it duplicates the config writer, and Kubernetes configs are mounted read-only. |
| W13 | Claude Code headless | Later, gated package: the harness owns the exchange and hands the token to the child through `apiKeyHelper` (bare mode honours it). | Let the child exchange itself: needs non-bare mode and breaks the single owner and single use (§10). |
| W14 | Repo CI | Optional package: the nightly live jobs may swap `secrets.ANTHROPIC_API_KEY` for GitHub OIDC. | Mandatory: PR CI calls no model API; only three nightly jobs do. |

## 4. External facts (read 2026-10-29)

### 4.1 Anthropic (Claude API)

Sources: [workload-identity-federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation),
[wif-reference](https://platform.claude.com/docs/en/manage-claude/wif-reference),
[wif-admin-api](https://platform.claude.com/docs/en/manage-claude/wif-admin-api), the provider guides under
`wif-providers/` (github-actions, kubernetes, aws, gcp, azure, spiffe) and
[authentication](https://platform.claude.com/docs/en/manage-claude/authentication).

| Topic | Fact |
|---|---|
| Resources | Service account `svac_…`, federation issuer `fdis_…` (issuer URL + JWKS source `discovery` / `explicit_url` / `inline`), federation rule `fdrl_…` (match, target service account, `oauth_scope`, `token_lifetime_seconds`). The client names the rule; there is no implicit rule search. |
| Exchange | `POST https://api.anthropic.com/v1/oauth/token`, JSON body, RFC 7523: `grant_type` = `urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion`, `federation_rule_id`, `organization_id` (UUID), `service_account_id`, `workspace_id` (`wrkspc_…`; required when the rule is enabled for more than one workspace; the literal `default` is deprecated). |
| Response | RFC 6749 §5.1: `access_token` (prefix `sk-ant-oat01-`, sent as `Authorization: Bearer`), `token_type` `Bearer`, `expires_in`, `scope`. No refresh token. |
| Lifetime | min(the rule's `token_lifetime_seconds` (60–86400; API default 3600, the Console wizard pre-fills 600), 2 × the remaining lifetime of the presented JWT), never below 60 s. |
| SDK refresh | Advisory at expiry − 120 s (on failure the cached token is still served), mandatory at expiry − 30 s (failure raises). The SDK re-reads `ANTHROPIC_IDENTITY_TOKEN_FILE` for every exchange. |
| JWT checks | ≤ 16 KiB; asymmetric algorithms only (ES256/384/512, RS256/384/512, PS256/384/512; HS* and `none` rejected); header `kid` required; `sub` required; `iat` present and not in the future; `exp` present and in the future; 30 s leeway on `exp`/`nbf`/`iat`; `exp − iat` ≤ the issuer maximum (default 1 h; Azure managed identity needs `max_jwt_lifetime_seconds: 86400`). |
| Single use | An assertion with `jti` is accepted once per issuer while the issuer's `check_jti` is on (the default); a repeat fails with reason `jti_reused`. GitHub Actions tokens carry `jti` (wif-admin-api). |
| Errors | `400 invalid_request_error` for a malformed rule id, a missing field or a malformed `workspace_id` (no history entry). **Every assertion denial is the same opaque `401 authentication_error`, message `Authentication failed`**; the reason (`jti_reused`, `match_subject_prefix`, `workspace_id_required`, …) appears only in the Console's authentication history. |
| Scopes | `workspace:developer` (default; Messages, Models, Managed Agents, Files, Skills), `workspace:inference` (Messages incl. token counting, Models, OpenAI-compatible chat), `workspace:manage_tunnels`, `org:admin`. A call outside the scope is `403`. |
| SDK variables | `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE` or `ANTHROPIC_IDENTITY_TOKEN` (literal JWT), `ANTHROPIC_PROFILE`, `ANTHROPIC_CONFIG_DIR`. The direct env path activates only with rule + organization + service account + one token variable. An empty variable still occupies its precedence slot. |
| SDK precedence | Constructor → `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_PROFILE` → federation variables → active profile. **A leftover API key silently shadows federation.** |
| Profile files | `<config_dir>/configs/<profile>.json` is non-secret (`authentication.type` `oidc_federation`, `federation_rule_id`, `service_account_id`, `identity_token {source: "file", path}`, `organization_id`, `workspace_id`, `base_url`, `version` `"1.0"`); `<config_dir>/credentials/<profile>.json` is secret (cached `access_token`, `expires_at`, interactive `refresh_token`; mode 0600). `config_dir` = `$ANTHROPIC_CONFIG_DIR`, else `~/.config/anthropic`, else `%APPDATA%\Anthropic`. |
| Token acquisition | GitHub Actions: `permissions: id-token: write`, `ACTIONS_ID_TOKEN_REQUEST_URL` + `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `&audience=https://api.anthropic.com`, JSON `.value`, token valid ~5 min, request URL valid for the whole job. Kubernetes: projected `serviceAccountToken` with `audience: https://api.anthropic.com`; the guide's example uses `expirationSeconds: 3600` and a rule with `token_lifetime_seconds: 600`; private issuers use `inline` JWKS. AWS: STS `GetWebIdentityToken` (regional endpoint, ambient AWS credentials) or an EKS projected token. GCP: metadata server `…/instance/service-accounts/default/identity?audience=…&format=full` with `Metadata-Flavor: Google`, issuer `https://accounts.google.com`, ~1 h. Azure: IMDS `http://169.254.169.254/metadata/identity/oauth2/token` (`Metadata: true`, `api-version=2018-02-01`, `resource=api://<APP_ID>`), App Service `IDENTITY_ENDPOINT` + `X-IDENTITY-HEADER`, AKS two-hop via `AZURE_FEDERATED_TOKEN_FILE`; tokens up to 24 h. SPIFFE: JWT-SVID through spiffe-helper (file) or the Workload API; SPIRE's default SVID TTL is 5 min. |

### 4.2 Claude Code (the default headless Anthropic backend)

Sources: [authentication](https://code.claude.com/docs/en/authentication),
[headless](https://code.claude.com/docs/en/headless),
[settings-reference](https://code.claude.com/docs/en/settings-reference) (`apiKeyHelper`).

- **Documented support:** "Anthropic profile and Workload Identity Federation credentials" are a supported
  authentication type. Claude Code's order: (1) cloud provider (`CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`),
  (2) `ANTHROPIC_AUTH_TOKEN`, (3) `ANTHROPIC_API_KEY`, (4) `apiKeyHelper`, (5) `CLAUDE_CODE_OAUTH_TOKEN`,
  (6) Anthropic profile and federation credentials, (7) subscription OAuth from `/login`. The federation variables
  select source 6 when `ANTHROPIC_FEDERATION_RULE_ID` and `ANTHROPIC_ORGANIZATION_ID` are both set; the other WIF
  variables (`ANTHROPIC_IDENTITY_TOKEN_FILE`, …) are read at exchange time. The WIF reference adds that Claude Code
  and the Agent SDK honour the same profile resolution order.
- **Not in bare mode:** "Claude Code doesn't read profiles or federation variables in bare mode". ADR-005's
  documented invocation is `claude --bare -p …`. Bare mode authenticates with `ANTHROPIC_API_KEY` or an
  `apiKeyHelper` supplied in `--settings`.
- **`apiKeyHelper`:** the command's output is sent as **both** `X-Api-Key` and `Authorization: Bearer`; cached for
  5 min or `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`; re-run after a 401/403 and, for JWT-shaped output, after it expired.
- Consequence: in a Claude Code child, a stray `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` outranks both
  `apiKeyHelper` and federation.

### 4.3 OpenAI

Sources: [guides/workload-identity-federation](https://developers.openai.com/api/docs/guides/workload-identity-federation)
and its GitHub Actions, Kubernetes and X.509 sub-guides, the
[token-exchange reference](https://developers.openai.com/api/reference/workload-identity-federation), the
[Codex federation rule reference](https://developers.openai.com/api/docs/guides/workload-identity-federation/federation-rules)
and [Codex environment variables](https://developers.openai.com/codex/config-file/environment-variables).

| Topic | Fact |
|---|---|
| Exchange (API) | `POST https://auth.openai.com/oauth/token`, JSON: `grant_type` = `urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token_type` (`urn:ietf:params:oauth:token-type:jwt` or `…:id_token`), `subject_token`, `identity_provider_id`, `service_account_id`. A `scope` in the request grants nothing. |
| Response | `access_token`, `issued_token_type` (`urn:ietf:params:oauth:token-type:access_token`), `token_type` `Bearer`, `expires_in`, `expires_at` (Unix seconds, equals the token's `exp`), `scope` (only when the mapping defines permissions). At most 1 h; never outlives the subject token. **No refresh token.** |
| Binding | Workload Identity Provider → service-account mapping in a project; exactly one enabled mapping must match; exchange never creates a principal. |
| Errors | Categories only: missing parameter, unsupported request, provider resolution, JWT verification (an authentication error), X.509 verification (`invalid_subject_token`), mapping resolution (`invalid_grant`). No per-cause JWT codes. |
| Limits | WIF tokens cannot call the Admin API, `DELETE /v1/models/{id}` or `POST /v1/images/request_audit`. |
| X.509 (beta) | `POST https://mtls.auth.openai.com/oauth/token`, `subject_token_type` = `urn:openai:params:oauth:token-type:x509`, no `subject_token`, identity from the TLS client certificate; API calls go to `mtls.api.openai.com` with the same certificate; the bearer is not certificate-bound. The guide's variables: `OPENAI_MTLS_CERT_CHAIN`, `OPENAI_MTLS_KEY`, `OPENAI_IDENTITY_PROVIDER_ID`, `OPENAI_SERVICE_ACCOUNT_ID`. |
| Kubernetes guide | Audience `https://api.openai.com/v1`, mount `/var/run/secrets/tokens/token`; self-hosted clusters support only local JWKS (uploaded with the `keys` wrapper). |
| Codex (beta) | Must be enabled per workspace. Variables `OPENAI_FEDERATION_RULE_ID`, `OPENAI_IDENTITY_TOKEN_FILE` (absolute path to the current OIDC token or JWT-SVID), optional `OPENAI_WORKLOAD_IDENTITY_CONTEXT`. **"The presence of either variable selects WIF ahead of API keys, access tokens, and stored logins."** Maps to a ChatGPT user or service account. Codex rules: lifetime 60–3600 s (10 min suggested); optional "Prevent assertion replay" (each non-empty `jti` once per provider); "obtain a new assertion before every exchange, including retries after an exchange with an unknown outcome". |

### 4.4 Google and Azure (placement only)

- **Google ADC:** `adc.ts` reads `authorized_user` and `service_account` files only; an `external_account` file
  (Google's own WIF configuration) currently fails as `adc_unavailable`. `docs/auth-engine.md` states
  "Metadata-server and external-account ADC are not implemented here."
- **Azure OpenAI with Entra ID:** an Entra token from IMDS, App Service's `IDENTITY_ENDPOINT` or an AKS federated
  client assertion; the harness has no Entra support and no Azure OpenAI wire profile today.

### 4.5 Kubernetes and GitHub facts that shape the design

- Kubernetes service-account tokens carry a `jti` (KEP-4193, feature `ServiceAccountTokenJTI`: alpha 1.29, beta
  1.30, GA 1.32).
- The kubelet replaces a projected token when it is older than 80 % of its TTL or older than 24 h; the minimum
  `expirationSeconds` is 600; projected volumes are updated by an atomic `..data` symlink swap.
- GitHub OIDC tokens live ~5 min, carry a `jti`, and the request URL can mint fresh ones for the whole job.

### 4.6 Explicit unknowns

| # | Unknown | Why it matters | Resolution |
|---|---|---|---|
| U1 | Whether `api.anthropic.com` accepts an `sk-ant-oat01-` WIF token that arrives in **both** `X-Api-Key` and `Authorization: Bearer` (Claude Code's `apiKeyHelper` behaviour) | W13 transport to a bare-mode Claude Code child | Plan WP0 spike (owner credentials); undocumented |
| U2 | Whether bare-mode Claude Code reads `ANTHROPIC_AUTH_TOKEN` | Fallback for W13 | Bare-mode docs name only `ANTHROPIC_API_KEY` and `apiKeyHelper`; WP0 |
| U3 | Whether Claude Code caches a federation-minted token across processes (`credentials/<profile>.json`) | Whether parallel children would each spend an assertion | Undocumented; the `ant` CLI re-exchanges per process when configured by env or flags (wif-admin-api); design does not rely on it |
| U4 | OpenAI's replay policy on the **API** path | Retry behaviour | Only Codex rules document "Prevent assertion replay"; the harness treats every assertion as single-use (W5) |
| U5 | Whether OpenAI SDKs read `OPENAI_IDENTITY_PROVIDER_ID` / `OPENAI_SERVICE_ACCOUNT_ID` themselves | Naming of the opt-in import (§6.4) | The guides' examples read them in application code; the harness uses no SDK |
| U6 | The host of `ACTIONS_ID_TOKEN_REQUEST_URL` | Egress allowlist and host check for `github_actions` | GitHub does not document it; the design assumes `*.actions.githubusercontent.com` on github.com, configurable for GHES; verified in WP0/WP2 |
| U7 | Rate limits of both token endpoints | Backoff tuning | Undocumented; existing 1–60 s backoff and single flight keep the rate at one exchange per profile per lifetime |
| U8 | Anthropic's Kubernetes example (`expirationSeconds: 3600`, rule `token_lifetime_seconds: 600`) with jti-bearing tokens (≥ 1.32) and default `check_jti` | By §4.1 and §4.5 the second refresh (~8 min) re-reads a token the kubelet only replaces after ~48 min → `jti_reused` | **Inferred, not observed.** WP0 checks it on a test cluster; the harness never presents the unrotated token anyway (§9.4) |
| U9 | Mode and owner of a projected token file for the image's non-root uid 10001 | `identity_token_unreadable` | Deployment detail; WP0, documented in `docs/containers.md` |

## 5. Where WIF fits ADR-005

### 5.1 A new kind, as data

`AUTH_KINDS` gains `workload_identity`. A profile of this kind carries no `secret_ref`, no endpoints and no
`refresh` block; it carries one closed `workload_identity` block (§6.1) naming an exchange adapter, an identity-token
source and the vendor's identifiers. Nothing secret is configured or stored: the identity token is read at exchange
time and the minted access token lives in memory (§9.1). `policy_status` is `allowed` (both vendors document the
flow), with `policy_source` pointing at the vendor's WIF page and a `policy_checked` date, like every profile.

The pool model is unchanged: a `workload_identity` profile is a pool of one synthetic entry `workload`, so pool
status, cooldowns and the router's error classes work as for any credential. Several WIF identities in one pool
are a non-goal for v1.

### 5.2 Relationship to D110's `federated_token`

What `main` has today:

- `federated_token` profiles are dispatched to the OpenAI D110 service (`credentials.ts` refuses them with "This
  profile requires the D110 OpenAI service"); the production path is `FederatedCredential`
  (`openai-auth/federated.ts`): a configured file or program returns `{ access_token, expires_at }`, the bearer lives
  in memory. Voice accepts `federated_token` as a Realtime/GPT-Live parent.
- `openai-auth/workload.ts` holds `WorkloadIdentity`, an RFC 8693 exchange client with Kubernetes/GitHub templates
  and X.509 hooks. It is **not wired** anywhere outside its own test.

Decision (W1): `federated_token` keeps exactly its shipped meaning, "a trusted external supplier hands over an
already-minted bearer", and is not changed. The exchange logic of `WorkloadIdentity` moves into the generic engine
as the `openai` adapter (§8.2); `workload.ts` becomes a re-export and is then removed. The ADR-005 amendment states
the split in one sentence per kind. Voice parents accepting `workload_identity` are a follow-up (owner Q9).

### 5.3 Exchange adapters

```ts
interface ExchangeAdapter {
  readonly id: 'anthropic' | 'openai';
  readonly endpoint: string;                 // fixed in code (§8); a test may inject a loopback port only
  exchange(req: { assertion: Sensitive; profile: AuthProfile; signal: AbortSignal }): Promise<Minted>;
}
interface Minted { accessToken: Sensitive; expiresAt: number; scope?: string; serverDate?: number }
```

Each adapter owns its request body, its response validation and its error mapping into the classes of §9.5. Adding
a vendor (for example the Entra adapter of §5.4) is a code change with contract tests and an ADR-005 row, never
configuration.

### 5.4 Later: Google ADC `external_account`, Azure OpenAI with Entra ID, OpenAI X.509

| Item | Fits as | Why not v1 |
|---|---|---|
| Google ADC `external_account` | Stays kind `adc`: `adc.ts` gains an `external_account` branch (Google STS `https://sts.googleapis.com/v1/token`, RFC 8693, optional `service_account_impersonation_url`), reusing the §7 `file` source for `credential_source.file`; `credential_source.url` needs the metadata exception, `executable` the `command` rules | Vertex is not on the enterprise critical path; the ADC kind already covers service-account files |
| Azure OpenAI with Entra ID | A third adapter `entra`: client assertion (`urn:ietf:params:oauth:client-assertion-type:jwt-bearer`) at `login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, scope `https://cognitiveservices.azure.com/.default`, fed by the `file` source (AKS `AZURE_FEDERATED_TOKEN_FILE`); managed identity needs the metadata source | Needs an Azure OpenAI wire profile as well; no owner demand yet |
| OpenAI X.509 / mTLS | Adapter variant `openai` with `subject_token_type` x509 against `mtls.auth.openai.com`, provider base URL `mtls.api.openai.com` | The egress client has no client-certificate support; X.509 WIF is beta |

## 6. Configuration

### 6.1 The profile block

Provider definitions live in `providers.<id>` (the schema's `providers` namespace is open and reserved for D15;
`composition/index.ts` takes every entry with a `wireFormat`), and their `profile` is validated closed by
`validateProfile`. A WIF provider:

```json
{
  "providers": {
    "anthropic-wif": {
      "wireFormat": "anthropic_messages",
      "billingPath": "workload",
      "defaultModel": "claude-opus-5-5",
      "profile": {
        "id": "anthropic:workload-identity",
        "display_name": "Anthropic (workload identity)",
        "kind": "workload_identity",
        "capabilities": ["chat"],
        "auth_header_scheme": "Authorization: Bearer {token}",
        "policy_status": "allowed",
        "policy_source": "https://platform.claude.com/docs/en/manage-claude/workload-identity-federation",
        "policy_checked": "2026-10-29",
        "workload_identity": {
          "exchange": "anthropic",
          "identity_token": { "source": "file", "path": "/var/run/secrets/anthropic.com/token" },
          "anthropic": {
            "federation_rule_id": "fdrl_…",
            "organization_id": "00000000-0000-0000-0000-000000000000",
            "service_account_id": "svac_…",
            "workspace_id": "wrkspc_…"
          }
        }
      }
    },
    "openai-wif": {
      "wireFormat": "codex_responses",
      "billingPath": "workload",
      "profile": {
        "id": "openai:workload-identity-exchange",
        "display_name": "OpenAI (workload identity)",
        "kind": "workload_identity",
        "capabilities": ["chat"],
        "auth_header_scheme": "Authorization: Bearer {token}",
        "policy_status": "allowed",
        "policy_source": "https://developers.openai.com/api/docs/guides/workload-identity-federation",
        "policy_checked": "2026-10-29",
        "workload_identity": {
          "exchange": "openai",
          "identity_token": { "source": "github_actions", "audience": "https://api.openai.com/v1" },
          "openai": { "identity_provider_id": "…", "service_account_id": "…" }
        }
      }
    }
  }
}
```

| Field | Rule |
|---|---|
| `workload_identity.exchange` | Required, `anthropic` \| `openai`; must match the vendor block present. |
| `workload_identity.identity_token` | Required. `{ "source": "file", "path": <absolute path> }` or `{ "source": "github_actions", "audience": <string> }`. Path ≤ 4096 bytes, no NUL; audience 1–512 bytes, no CR/LF. Closed objects. |
| `workload_identity.expected_audience` | Optional; for local diagnostics only (§7.4). Default for `file` + `anthropic`: `https://api.anthropic.com`; no default for `openai` (the audience is operator-defined there). For `github_actions` the requested audience is used. |
| `workload_identity.accepted_scopes` | Optional subset of `workspace:inference`, `workspace:developer` (default both, Anthropic only). `org:admin` and `workspace:manage_tunnels` can never be listed. |
| `workload_identity.anthropic` | Required iff `exchange` = `anthropic`: `federation_rule_id` (`fdrl_…`), `organization_id` (UUID), `service_account_id` (`svac_…`), optional `workspace_id` (`wrkspc_…`; the deprecated literal `default` is refused). |
| `workload_identity.openai` | Required iff `exchange` = `openai`: `identity_provider_id`, `service_account_id`, optional `subject_token_type` `jwt` (default) \| `id_token`. |
| `auth_header_scheme` | Must be `Authorization: Bearer {token}`. |
| `secret_ref`, `refresh`, `tokenUrl`/`authorizeUrl`/`deviceUrl` and legacy aliases, `client_*`, `scopes`, `redirect`, `pkce` | Refused for this kind. |
| `base_url` | Destination pinning (§11): `anthropic` → absent or `https://api.anthropic.com/v1`; `openai` → absent or `https://{api,us.api,eu.api}.openai.com/v1`. A gateway URL is refused: the minted token is a bearer for the vendor, not for a proxy. |
| `billingPath` (provider definition) | `workload` (class `paid`); `billingClassOf` maps the kind to `paid` when absent. The profile's closed key set (`KEYS` in `profile.ts`) gains only `workload_identity`. |

Identifiers (`fdrl_`, `svac_`, `wrkspc_`, organization UUID, OpenAI provider and service-account ids) are not
secrets: they appear in status, audit and docs. The identity token and the minted token never appear in config.
The example's OpenAI profile id differs from D110's `openai:workload-identity`, which stays a `federated_token`
profile (§5.2).

### 6.2 Installation-wide keys: `auth.workloadIdentity`

A closed object next to `auth.openai` in `config.schema.json`:

```json
"workloadIdentity": {
  "description": "Workload identity federation: exchange of an IdP identity token for a short-lived provider token.",
  "type": "object", "default": {}, "additionalProperties": false,
  "properties": {
    "importEnv": {
      "type": "object", "default": {}, "additionalProperties": false,
      "x-restart": "core", "x-tier": "advanced", "x-write-roles": ["owner", "admin"], "x-audit": true,
      "description": "Opt-in: build a workload profile from the vendor's own environment variables at core start.",
      "properties": {
        "anthropic": { "type": "boolean", "default": false },
        "openai": { "type": "boolean", "default": false }
      }
    },
    "restartCache": {
      "type": "string", "enum": ["none", "secret-store"], "default": "none",
      "x-restart": "core", "x-tier": "advanced", "x-write-roles": ["owner", "admin"], "x-audit": true,
      "description": "Keep a minted token across a core restart in the secret store (none: memory only)."
    },
    "maxConsecutiveDenials": {
      "type": "integer", "default": 3, "minimum": 1, "maximum": 10,
      "x-restart": "core", "x-tier": "advanced",
      "description": "Denied exchanges with fresh identity tokens before background attempts stop."
    },
    "rotationPollSeconds": {
      "type": "integer", "default": 5, "minimum": 1, "maximum": 60,
      "x-restart": "core", "x-tier": "advanced",
      "description": "How often an unchanged identity-token file is re-read while a refresh waits for rotation."
    },
    "httpTimeoutMs": {
      "type": "integer", "default": 30000, "minimum": 1000, "maximum": 120000,
      "x-restart": "core", "x-tier": "advanced",
      "description": "Deadline of one exchange or identity-token request."
    },
    "githubActions": {
      "type": "object", "default": {}, "additionalProperties": false, "x-restart": "core", "x-tier": "advanced",
      "properties": {
        "requestHostSuffixes": {
          "type": "array", "maxItems": 8, "default": ["actions.githubusercontent.com"],
          "items": { "type": "string", "pattern": "^[a-z0-9.-]{1,253}$" },
          "description": "Hosts ACTIONS_ID_TOKEN_REQUEST_URL may name (exact host or a subdomain); add a GHES host here."
        }
      }
    }
  }
}
```

The refresh thresholds (advisory 120 s, mandatory 30 s) are constants that match the vendor SDKs, not settings.
Provider definitions follow the existing rule for `providers.*`: a changed profile is picked up when composition is
rebuilt (core restart), as for every other credential kind.

### 6.3 Validation (closed, fail closed)

`validateProfile` refuses, with constant messages:

- unknown fields anywhere in the block; a vendor block that does not match `exchange`; a relative or non-UTF-8 path;
- a token-file path under a foreign credential store (the existing deny roots plus `~/.config/anthropic/credentials`
  and `%APPDATA%\Anthropic\credentials`, §11) or under the harness's own secret-store directory;
- **two `workload_identity` profiles with the same exchange vendor and the same token file**: both would present the
  same JWT to one issuer and the second would always be a replay (two vendors sharing one file is allowed but warned:
  one projected audience rarely matches both rules);
- any string in the profile that looks like a credential (JWT shape `eyJ….….…`, `sk-ant-`, `sk-`), reason
  `value-looks-like-a-token`, so a token pasted into an ID field never lands in config.

A refused provider is isolated exactly like a billing-class refusal today (`classifyProviders`): `E_CONFIG_INVALID`
for that provider, the others keep serving. An older core that does not know the kind refuses the provider the same
way.

### 6.4 Environment import (opt-in, explicit)

Operators coming from the vendor docs already set the vendor variables in their pod spec. With
`auth.workloadIdentity.importEnv.<vendor>: true`, the core reads them **once at start** and synthesises one provider:

| Vendor | Variables read | Synthesised |
|---|---|---|
| `anthropic` | `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID` (optional), `ANTHROPIC_IDENTITY_TOKEN_FILE` | provider `anthropic-workload-env`, profile `anthropic:workload-identity-env`, `wireFormat` `anthropic_messages`, source `file` |
| `openai` | `OPENAI_IDENTITY_PROVIDER_ID`, `OPENAI_SERVICE_ACCOUNT_ID`, `OPENAI_IDENTITY_TOKEN_FILE` | provider `openai-workload-env`, profile `openai:workload-identity-env`, `wireFormat` `codex_responses`, source `file` |

Rules: an explicitly configured provider with the same id wins and the import is skipped (status says so);
an empty or missing required variable refuses the import, naming the variables, never their values;
`ANTHROPIC_IDENTITY_TOKEN` (a literal JWT in the environment) is **refused** with
`E_CONFIG_INVALID reason=identity-token-in-env` (a single-use secret in the process environment cannot rotate and
leaks to anything that dumps the environment); `ANTHROPIC_PROFILE`, `ANTHROPIC_CONFIG_DIR` and the Anthropic profile
files are never read. `OPENAI_IDENTITY_TOKEN_FILE` is Codex's variable name (§4.3); reusing it for the import is a
convenience for operators who already set it, and §6.5 keeps it away from any Codex child (owner Q10). The import is
audited (`auth.workload.env_imported`, variable names only) and visible in `login status` as `origin: env`.

### 6.5 Precedence and child environments

- **P1 — the core reads no vendor credential variable.** Composition passes credentials from profiles and the secret
  store explicitly; no provider code reads `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` or a
  federation variable (verified on `main`: only the turn-evaluation setup in `toolcall/turn-eval-live.ts`, which
  copies the nightly secret into an eval home's secret store, the CLI help text and test fixtures name
  `ANTHROPIC_API_KEY`). WIF keeps this; §6.4 is the only, opt-in exception.
- **P2 — no shadowing.** There is no harness precedence chain to shadow: a provider uses exactly the profile in its
  definition. Because operators expect the SDK behaviour, `1staid check` reports (info) a vendor API key present in
  the core environment while a workload profile for that vendor exists.
- **P3 — children get a sanitised environment.** Exec and the sandbox already build the child environment from an
  allowlist (`DEFAULT_ENV_ALLOW`) and drop inherited secret-looking names (`TOKEN`, `API_KEY`, `AUTH`, …). WIF adds a
  hard **vendor credential deny set** that neither `exec.envAllow` nor an MCP `fromHost` entry can re-admit and that
  is refused as a declared literal value too:

  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_CONFIG_DIR`,
  `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`,
  `ANTHROPIC_WORKSPACE_ID`, `ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_FEDERATION_RULE_ID`,
  `OPENAI_IDENTITY_TOKEN_FILE`, `OPENAI_WORKLOAD_IDENTITY_CONTEXT`, `OPENAI_IDENTITY_PROVIDER_ID`,
  `OPENAI_SERVICE_ACCOUNT_ID`, `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`,
  `AWS_WEB_IDENTITY_TOKEN_FILE`, `AZURE_FEDERATED_TOKEN_FILE`.

  MCP config validation refuses a `fromHost` or `env` entry with one of these names
  (`E_CONFIG_INVALID reason=vendor-credential-env`).
- **P4 — delegated vendor CLIs.** A harness-spawned Claude Code or Codex child gets the allowlist, minus the deny
  set, plus only what its route adds itself (§10). Claude Code's order (§4.2) and Codex's "either variable selects
  WIF" rule therefore see exactly one credential source: the one the harness chose.

## 7. Identity-token sources

### 7.1 `file`

- **Read for every exchange**, by path, never through a cached descriptor: this follows the kubelet's `..data`
  symlink swap and spiffe-helper's rewrites without depending on file-change notifications.
- The resolved target must be a regular file of at most 16 KiB (the Anthropic maximum); surrounding whitespace is
  trimmed; the content must be one compact JWS (three base64url segments). The read uses the bounded reader and the
  foreign-credential deny check that D110's supplier files already use.
- **Change detection** is the SHA-256 of the content; the spent ledger (§9.2) decides whether it may be presented.
  While a refresh waits for rotation (§9.4) the file is re-read every `rotationPollSeconds`, nothing else polls.
- Failures map to constant codes: missing → `identity_token_missing`; permission denied → `identity_token_unreadable`;
  too large or not a JWS → `identity_token_malformed`. The path is configuration (not secret) and is shown in status,
  but it is not put into thrown `AuthError` messages, which stay constant.

### 7.2 `github_actions`

- Needs `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` in the **core's** environment (a job with
  `permissions: id-token: write`). They are read at exchange time, never imported into config, never copied to a
  child (§6.5).
- The URL must be `https`, carry no credentials or fragment, and its host must equal or be a subdomain of an entry
  in `githubActions.requestHostSuffixes` (default `actions.githubusercontent.com`, U6). It then passes the ordinary
  egress gate: the operator lists `*.actions.githubusercontent.com` in `egress.allowHosts`.
- Request: `GET <url>` with `audience=<configured audience>` added through `URLSearchParams` (the URL already has a
  query), `Authorization: Bearer <request token>`, `Accept: application/json`; a 3xx is never followed (egress already
  refuses redirects for requests with sensitive headers); 16 KiB cap; the `httpTimeoutMs` deadline; the JWT is the
  JSON field `value`.
- **One fetch per exchange**: each call yields a fresh `jti`; a fetched JWT is never cached, never reused, never
  retried. The audience is mandatory configuration, never defaulted silently.

### 7.3 Later sources

| Source | Shape | Blocker / reason for later |
|---|---|---|
| `command` | Literal executable + argument array, no shell, explicit environment, 10 s deadline, 16 KiB stdout cap, prints one JWT (the D110 supplier rules) | Covers AWS (`aws sts get-web-identity-token`), `gcloud auth print-identity-token`, `spire-agent api fetch jwt`, Azure CLI with one mechanism; v1.1 candidate (owner Q3) |
| `metadata:gcp`, `metadata:azure-imds`, `metadata:azure-app-service` | Fixed URL and header in code, no redirects | The egress gate refuses link-local and metadata addresses by design (`private-address`). Needs a closed, named exception in the style of `egress.modelDownloads` (for example `egress.workloadMetadata.enabled`, default off) |
| `aws_sts` | STS `GetWebIdentityToken` | Needs SigV4 and ambient AWS credentials; `command` covers it without an AWS SDK in the core |
| SPIFFE Workload API | gRPC over the agent socket | Needs a gRPC client; spiffe-helper + `file` already covers SPIFFE |

### 7.4 Local pre-flight on the identity token (diagnostics, no signature check)

Before an assertion is spent, the core decodes its header and payload (bounded base64url JSON) and **does not present
it** when:

- it is larger than 16 KiB, `alg` is missing, `none` or `HS*`, or `kid` is missing → `identity_token_malformed`
  (the vendor would reject it and the `jti` would be burnt for nothing);
- `exp` ≤ now + 30 s → `identity_token_stale`;
- `iat` or `nbf` > now + 30 s → `clock_skew` (local clock or IdP clock);
- its fingerprint is already spent → wait for rotation (§9.4).

Diagnostics only (never a refusal): `aud` without `expected_audience` → `audience_mismatch` warning; `exp − iat` >
3600 s with `exchange: anthropic` → `lifetime_exceeds_issuer_default` info (issuer maximum, §4.1); no `jti` → info
"replay protection does not apply". Status shows `iss`, `sub`, `aud`, `exp`, `iat` and whether a `jti` is present
(identifiers, Owner/Admin only). The token itself, its signature and any other claim are never logged or returned.

## 8. Exchange adapters

### 8.1 Anthropic

- Endpoint fixed: `https://api.anthropic.com/v1/oauth/token` (a test injects a loopback port through the transport,
  the pattern `WorkloadIdentity` already uses for host pinning). Headers: `content-type: application/json`,
  `accept: application/json`; nothing undocumented is sent.
- Body: `grant_type`, `assertion`, `federation_rule_id`, `organization_id`, `service_account_id`, and `workspace_id`
  when configured.
- Response validation: `token_type` equals `bearer` case-insensitively; `access_token` a non-empty string without
  whitespace or control characters (the documented `sk-ant-oat01-` prefix is checked as a diagnostic, not a gate, so a
  vendor prefix change degrades to a warning); `expires_in` an integer in 60…86400; `scope` a string.
- `expiresAt` = request start + `expires_in` (the round trip is counted against the token, never in its favour).
- Scope gate (W11): a `scope` outside `accepted_scopes` → the token is discarded unused and the profile is
  `workload_config_invalid` reason `scope-refused`.

| Answer | Class (§9.5) |
|---|---|
| 200 with a valid body | minted |
| 400 `invalid_request_error`, 404, unexpected 3xx | `workload_config_invalid` (no automatic retry) |
| 401 `authentication_error` (always "Authentication failed"), 403 | `workload_denied` |
| 408, 429, 5xx, timeout, connection or TLS failure | `refresh_failed` (transient) |
| 200 with an invalid body | `refresh_failed`, reason `invalid_response` |

Only `error.type` is read from an error body for the classification; no response text survives the boundary
(the rule `http.ts` already applies).

### 8.2 OpenAI (JWT subject token)

- Endpoint fixed: `https://auth.openai.com/oauth/token`.
- Body: `grant_type` = `urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token_type`
  (`urn:ietf:params:oauth:token-type:jwt` default, `…:id_token` when configured), `subject_token`,
  `identity_provider_id`, `service_account_id`. No `scope` (it grants nothing).
- Response validation: `token_type` bearer; `issued_token_type`, when present, equals
  `urn:ietf:params:oauth:token-type:access_token`; `expires_in` ≤ 3600; `expiresAt` = min(request start +
  `expires_in`, `expires_at` × 1000). A difference above 60 s between the two raises the `clock_skew` diagnostic.
- Mapping: `invalid_grant` (mapping resolution) and authentication errors → `workload_denied`; missing parameter,
  unsupported request, provider resolution → `workload_config_invalid`; 408/429/5xx/network → `refresh_failed`.

### 8.3 Transport

`createOAuthHttp` posts form-encoded bodies only. It gains `postJson(url, body, signal)` and `getJson(url, headers,
signal)` with identical guarantees: `egress.request` only (no socket of its own, `test/egress/post-paths.test.ts`
extended), no redirects, one deadline, 64 KiB response cap (16 KiB for the GitHub request), constant error codes,
response objects redacted under `toJSON` / inspection. It additionally returns the response `Date` header for the
skew estimate (§9.6).

### 8.4 Using the minted token

- **Anthropic Messages bearer mode (W10).** `createAnthropicAdapter` accepts
  `credentials: { authorization(ctx) }` as an alternative to `apiKey`: it sends `Authorization: Bearer <token>` and no
  `x-api-key`, with the same per-call read, redaction and plain-http refusal. `composeAuth` chooses the mode from the
  profile's `auth_header_scheme`. Today it hands the formatted header *value* to `apiKey`, so a bearer scheme passes
  `Bearer …` as an API key, which the adapter refuses as unusable (whitespace): no bearer-scheme Anthropic profile can
  work on `main`. The mode choice fixes that for every bearer-scheme profile.
- `chat_completions` and `codex_responses` already take an `Authorization` value.
- **Discovery** uses the same lease and follows each wire's existing rule (`anthropic_messages` → `anthropic-models`,
  `chat_completions` → `openai-models`, a non-plan `codex_responses` provider stays manual as for API keys);
  `real-adapters.ts` must not add the new kind to its manual-only kinds, and both Anthropic scopes include Models.
- **Billing:** `billingClassOf` returns `paid` for the kind; `billingPath: workload` is already a paid path.
- **`privacy.localOnly`:** a refused cloud provider never requests a lease, so no exchange happens either.

## 9. Lifecycle: cache, refresh, single owner

### 9.1 The minted token stays in memory (decision W4)

Reasons: the token is short-lived (60 s – 1 h, typically 10 min) and re-derivable from the IdP at any time; there
is no refresh token whose loss would force a person to sign in again; persisting it adds a new at-rest bearer and a
stale-state class (a restored token whose rule was archived in the meantime); container deployments often run the
encrypted-file fallback or no store at all; ADR-005 gives the engine "short-lived leases only"; D110's federated
supplier already keeps its bearer in memory.

Cost: after a core restart the last identity token is spent (§9.2). With `github_actions` there is no gap (a fresh
JWT is fetched). With `file` the core waits for the next rotation: at most 0.8 × `expirationSeconds`, so ≤ 8 min with
the recommended 600 s (§9.4). Core restarts follow every `x-restart: core` change, so an operator for whom that gap
matters can set `restartCache: "secret-store"`: the minted record `{ v: 1, accessToken, expiresAt, generation,
profileHash }` is written under the internal name `auth/workload/<profileId>` through the existing persist-before-
release path, is used after restart only while unexpired and while `profileHash` matches, and is deleted when it
expires or the profile changes (owner Q2).

### 9.2 Spent-assertion ledger ("persist before present")

ADR-005's rotating-refresh rule ("persist before releasing waiters") becomes, for single-use assertions:

1. The core computes `fingerprint = SHA-256(JWT bytes)`.
2. It records `{ exchange, fingerprint, exp }` as spent in memory **and** in `state/auth-workload.json` (0600, atomic
   replace, entries pruned at `exp` + 60 s). Only the hash is written, never the JWT.
3. Only then is the assertion sent. A spent fingerprint is never presented again, whatever happened: success,
   denial, timeout with unknown outcome, crash mid-request.

The ledger key includes the exchange vendor: one JWT may still go once to Anthropic and once to OpenAI (separate
replay domains), never twice to one (and §6.3 already refuses same-vendor sharing of a file). If the ledger cannot be
written, the exchange is not attempted (`persist_failed`, retryable): presenting without a durable mark could replay
after a crash.

### 9.3 Schedule

| Moment | Behaviour |
|---|---|
| expiry − 120 s − jitter (0…30 s, uniform, existing `random` port) | **Advisory.** Mint if a fresh (unspent, pre-flight-clean) identity token is available. On a transient failure or with no fresh token, keep serving the cached one; poll (§9.4) or back off. |
| expiry − 30 s | **Mandatory.** Leases fail with `refresh_failed` (retryable, `retryAfterMs` = next poll or backoff) until a new token exists. |
| expiry | The cached token is dropped. |

For very short tokens the thresholds scale: advisory at expiry − min(120 s, lifetime / 2), mandatory at expiry −
min(30 s, lifetime / 4). Transient failures back off 1 s → 60 s plus ≤ 1 s jitter (the existing owner policy).
Timers are `unref`ed and cancelled by `close()`. One flight per profile: ten parallel turns at the threshold cause
one exchange.

**Implementation shape.** `RefreshOwner` gets a record-source abstraction: the existing store-backed source for
OAuth records, and a memory source (optionally backed by the secret store for `restartCache`) for minted records;
plus a `Minter` port next to `Refresher`. `fresh()`, the single-flight map, timers, backoff and the
generation-guarded `invalidate()` (a 401 on a token believed valid) are shared. `credentials.ts` dispatches
`workload_identity` to this path (an `isMinted(profile)` predicate beside `isRefreshable`).

### 9.4 Waiting for rotation; restart

- At the advisory moment, if the file's content is spent (the kubelet has not rotated yet), **no exchange is sent**;
  status shows `waiting_for_rotation` and the file is re-read every `rotationPollSeconds`; the first new content is
  pre-flighted and exchanged.
- If the mandatory moment passes without rotation, leases fail and status shows `identity_token_not_rotated` with
  computed advice: the observed rotation interval (0.8 × (`exp` − `iat`) of the last token) versus the minted
  lifetime, and the setting that fixes it.
- **Recommended Kubernetes settings:** projected `expirationSeconds: 600` (the minimum; the kubelet replaces the token
  once it is older than ~480 s) and a rule `token_lifetime_seconds` of **900** (at least 600). Reasoning: after an
  exchange with a just-rotated token the minted lifetime is min(900, 2 × 600) = 900 s, so the mandatory moment
  (870 s) lies well after the next rotation (~480 s plus the kubelet's next volume sync, about a minute by default);
  with an older token the minted lifetime shrinks (2 × remaining) but the next rotation comes correspondingly sooner.
  A 600 s rule leaves only ~90 s for that sync. Anthropic's example values (3600 / 600) leave four refreshes per rotation
  (U8); the harness then waits instead of failing silently, and `1staid check` names the fix.
- After a restart, the ledger marks the last file content as spent, so the core waits for rotation instead of
  provoking an opaque 401 and a `jti_reused` entry in the Console.
- `github_actions` always has a fresh token; spiffe-helper rotates at least every few minutes (SVID TTL 5 min).

### 9.5 Failure classification

New `AuthErrorCode`s: `workload_denied`, `workload_config_invalid`, `identity_unavailable` (with a `reason` among
`identity_token_missing|unreadable|malformed|stale|not_rotated`, `clock_skew`, `source_failed`); existing codes are
reused where they fit. Messages stay constant (no token, path, claim or response text).

| Condition | `AuthError` | Retry | Pool / router effect | Status |
|---|---|---|---|---|
| Exchange 401/403, OpenAI `invalid_grant` | `workload_denied` | Only with a **fresh** identity token, after 30 s, 2 min, 8 min; after `maxConsecutiveDenials` (3) background attempts stop | No lease → the router's `auth` class: no fallback, no breaker trip (unchanged semantics); pool `lastError` `auth_rejected` / confirmed | `denied` with the Console hint (authentication history; typical reasons `jti_reused`, `match_subject_prefix`, `workspace_id_required`, `iss` mismatch) |
| Stopped after repeated denials | `workload_denied` (`retryable: false`) | Resumes on a config change (core restart), or on `login test` / `auth.workload.test` once a fresh identity token exists | as above | `blocked` |
| Exchange 400/404/3xx, scope refused, egress refused the exchange host | `workload_config_invalid` | None until config change or explicit test | as above | `config_invalid` + reason |
| Exchange 408/429/5xx/network/invalid body | `refresh_failed` (`retryable`, `retryAfterMs`) | Backoff 1–60 s; cached token served until the mandatory moment | Only after the mandatory moment: no lease, retryable | `degraded` |
| No fresh identity token (file unchanged, missing, stale, skewed) | `identity_unavailable` once the cached token is past the mandatory moment | Poll / next rotation | as above | `waiting_for_rotation` or the reason |
| Ledger not writable | `persist_failed` (`retryable`) | Next lease | as above | `degraded` |
| API 401 with a minted token believed valid | — | `invalidate(generation)`, the next lease mints with a fresh token; a second 401 right after a fresh mint is a confirmed `auth_rejected` (sole-credential cooldown, 300 s) | existing `reportResult` logic, extended from `isRefreshable` to `isMinted` | `denied` |
| API 403 | — | — | pool `forbidden` / ambiguous (existing) | hint "token scope does not cover this endpoint" (`workspace:inference` vs Files/Skills) |
| API 429 | — | — | unchanged | unchanged |

Denials are deliberately conservative: the vendors return one opaque answer for every cause (§4.1, §4.3), and
retrying burns assertions, fills the Console history and cannot fix a rule mismatch. The 30 s first step still covers
the one transient denial cause Anthropic documents (a JWKS cache that lags a key rotation for up to a minute).

### 9.6 Clock skew

Three signals: the JWT's `iat`/`nbf` against the local clock (pre-flight, §7.4); the exchange response's `Date`
header against the local clock (warning above 30 s, the vendor leeway); OpenAI's `expires_at` against the computed
expiry (§8.2). Local expiry is computed from the injected `Clock` at request start and never extended beyond the
vendor's numbers. Skew is a diagnostic and a pre-flight refusal reason, never a reason to shift timers.

## 10. Claude Code headless and other delegated CLIs

- **Today.** ADR-005 D12's default route spawns the unmodified `claude --bare -p …` under the person's own login;
  the harness holds no credential for it. The spawn code is not on `main` yet (ADR-005 action item 2a is open; no
  `--bare` / `stream-json` invocation exists in `packages/` or `crates/`). WIF changes nothing on this personal
  route.
- **"Claude Code on WIF" (enterprise, later package, owner Q7).** For an organisation that wants the Claude Code
  agent loop billed to a WIF service account:
  - The harness owns the exchange (single owner, §9). The child is started with
    `--settings '{"apiKeyHelper":"<absolute path of plur1bus> auth token-helper"}'` (bare mode honours
    `apiKeyHelper` in `--settings`, §4.2) and `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=60000`.
  - The helper asks the core over the local RPC socket for the current minted token of the profile bound to that
    session, presenting a random 256-bit session handle from its environment (`PLUR1BUS_TOKEN_HELPER_HANDLE`). The
    handle is bound to one session and one profile, rate-limited, returns only the short-lived token, and is revoked
    when the session ends. The token travels over a pipe: never argv, never a file, never the child's environment.
  - Accepted residual risk, stated in the docs: code running inside the Claude Code process tree (its own tools) can
    read the handle and obtain the current token for the session's lifetime — the same exposure as the token Claude
    Code holds anyway.
  - The child environment is built by §6.5 P4, so `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` (which outrank
    `apiKeyHelper`) cannot be present.
  - **Gates:** ADR-005 action 2a (the backend exists) and the WP0 spike: U1 (the API accepts the WIF token arriving in
    both `X-Api-Key` and `Authorization: Bearer`). If U1 fails, the fallback is `ANTHROPIC_AUTH_TOKEN` per one-shot
    `-p` run whose deadline is shorter than the token's remaining lifetime, and only if U2 confirms bare mode reads
    it; resident sessions would then be recycled before expiry.
  - **Rejected:** forwarding the federation variables or an Anthropic profile file to the child. That needs non-bare
    mode (which loads hooks, `CLAUDE.md` and project MCP servers), lets every child exchange on its own (several
    owners) and makes the child and the harness spend the same token file's `jti` (U3).
- **Codex CLI.** Stays "personal/local only" (D110). Codex WIF (beta, ChatGPT principal) is out of scope. Because
  "either variable selects WIF", §6.5 strips `OPENAI_FEDERATION_RULE_ID` and `OPENAI_IDENTITY_TOKEN_FILE` from every
  Codex child, so a variable meant for the harness's own import can never switch a personal Codex login.

## 11. Security

- **No static secret.** Nothing is stored except, opt-in, a minted token in the existing encrypted secret store
  (§9.1). The identity token is a secret: it is never written to config, logs, audit, argv, a child's environment
  or the ledger (hash only); it is held in a `Sensitive` value for the duration of one exchange and registered with
  the secret redaction registry as a transient value.
- **Minted token.** Registered with `secrets.redaction` under `workload:<profileId>` (pinned while current, retired
  on re-mint, the registry's existing bounded behaviour); leases keep their redacted `toJSON` / inspection.
  Backstops: the log redactor's `jwt` and vendor-key patterns; `auth/redact.ts` `scrub()` gains the JWT shape and
  `sk-ant-oat01-`; the 1staid bundle redactor already covers JWTs and `sk-` keys.
- **Audience binding.** The vendor rule's `audience` matcher is the binding (operator configuration). The harness
  requests an explicit audience for `github_actions` and warns locally when a file token's `aud` lacks the expected
  value. Docs carry the vendor guidance: always set an audience on the rule and on the projection.
- **Destination pinning.** Exchange endpoints are fixed in code (§8); the minted token goes only to the vendor's own
  API hosts (§6.1 `base_url` rule).
- **Scope.** `org:admin` and `workspace:manage_tunnels` tokens are refused; docs recommend a rule with
  `workspace:inference` for chat-only providers (Messages, token counting, Models) and a dedicated workspace with a
  spend limit.
- **Tools cannot read the identity token.** The configured token paths are added to the host-tools and fs-tool deny
  lists at composition time: an agent that reads `/var/run/secrets/anthropic.com/token` could spend it first (a
  denial-of-service through `jti`) or exchange it elsewhere. `~/.config/anthropic/credentials` and
  `%APPDATA%\Anthropic\credentials` (minted tokens and `user_oauth` refresh tokens of the vendor SDK and `ant` CLI)
  join the foreign credential store roots and the host-tools denylist, next to `~/.claude`. The GitHub request token
  never reaches a child (§6.5).
- **Egress.** Required `egress.allowHosts`: `api.anthropic.com` (already needed for inference), `auth.openai.com`
  and the OpenAI API host, `*.actions.githubusercontent.com` for `github_actions`. `1staid check` dry-runs
  `egress.decide` for each configured exchange endpoint and source host.
- **What WIF does not protect against.** A compromised or over-permissive IdP (whoever can mint a matching JWT — the
  cluster's service-account signing key, write access to a workflow on a matching ref, cloud IAM — gets tokens);
  over-broad rules (`repo:org/*` matches fork pull requests, `system:serviceaccount:*` every pod); a long-lived secret
  one step earlier (static cloud credentials that can mint IdP tokens); a compromised harness host (it can read the
  token file anyway); theft of a minted token within its lifetime (bearer, not sender-constrained); an issuer with
  `check_jti` disabled (no replay protection).
- **Audit** (`audit.append`, values never included):

| Action | Detail |
|---|---|
| `auth.workload.exchange` | `profileId`, `exchange`, `result` (`ok`/`denied`/`config_invalid`/`transient`), `expiresAt`, `scope`, rule / service-account / workspace ids, `iss`, `sub`, the first 12 hex digits of the assertion fingerprint |
| `auth.workload.blocked` | `profileId`, consecutive denials |
| `auth.workload.rotation_wait` | `profileId`, `exchange`, seconds waited (once per episode) |
| `auth.workload.env_imported` | vendor, variable names |
| `auth.workload.cache_restored` | `profileId`, `expiresAt` (only with `restartCache`) |
| `auth.workload.test` | `profileId`, principal, result |

- **RBAC.** Status: `auth.credentials.read`. `auth.workload.test`: `auth.credentials.write` (Owner/Admin). The
  token-helper handle of §10 is never available over the public RPC surface.

## 12. Surfaces

### 12.1 CLI (Rust)

Decision W12: **the definition is configuration only** (`config.json`, `plur1bus config set providers.<id> …`, or a
mounted file). A WIF profile has nothing to sign in to and nothing to store, so a `login` writer would only duplicate
the config writer, and Kubernetes deployments mount config read-only. The CLI verifies and explains:

| Command | Behaviour |
|---|---|
| `plur1bus login status` | Adds a `workload` table (and the `workload` array in `--json`): profile, vendor, origin (`config` / `env`), source (`file <path>` / `github_actions`), state (`valid until …`, `waiting_for_rotation`, `degraded`, `denied`, `blocked`, `config_invalid`), last exchange, last error code and hint, granted scope. Never a token, never a JWT. |
| `plur1bus login test <profile-id>` | Calls `auth.workload.test`: one exchange if a fresh identity token exists (a spent one is never re-presented: the answer is then `waiting_for_rotation` with the expected wait); prints the class, expiry and scope; exit code from the existing `E_*` table. |
| `plur1bus login <anthropic\|openai> --workload-identity [--from-env] [--rule … --org … --service-account … --workspace … --token-file …] [--github-actions --audience …]` | Prints the `plur1bus config set providers.<id> '<json>'` command and the `egress.allowHosts` entries it needs; writes nothing. `--from-env` reads the vendor variables of the CLI's own environment once (§6.4 names). A JWT- or key-shaped value in any argument is refused with the existing `value-in-argument` rule and never echoed. |
| `plur1bus 1staid check` | New check `auth.workload` (after `models.warm`, fixed table order), reading `auth.workload.status` from the core; OK / WARN / FAIL per profile with repair hints; `doctor.report` shows it automatically (it projects the 1staid report). |

`1staid check` findings:

| Finding | Level | Hint |
|---|---|---|
| Token file missing / unreadable / malformed | FAIL | mount path, projection `audience`, file mode for uid 10001 (U9) |
| Token stale (`exp` passed) or not rotated before the mandatory moment | FAIL | the computed `expirationSeconds` / `token_lifetime_seconds` advice of §9.4 |
| Rotation slower than the minted lifetime (predicted) | WARN | same advice, before it fails |
| Clock skew (pre-flight or `Date` header) | WARN/FAIL | NTP |
| Last exchange denied / blocked | FAIL | Console → Workload identity → Authentication history; `jti_reused`, `match_subject_prefix`, `workspace_id_required`, `iss` byte-for-byte |
| Config invalid (400, scope refused, gateway `base_url`) | FAIL | the field |
| Egress refuses an exchange or source host | FAIL | the `egress.allowHosts` entry |
| `aud` lacks the expected audience | WARN | projection or GitHub audience |
| `github_actions` source without the two runner variables | FAIL | `permissions: id-token: write` |
| Vendor API key in the core environment while a workload profile exists | INFO | it is ignored by the harness (§6.5) |

### 12.2 RPC (TypeScript core)

- `auth.status` and `auth.credentials.list`: additive `workload: WorkloadStatus[]` (experimental surface).
- `auth.workload.status` (read, `auth.credentials.read`): per profile the state, timestamps (`expiresAt`, last
  exchange, next refresh), last error code, granted scope, the identity-token summary of §7.4, ledger counts.
- `auth.workload.test` (write, `auth.credentials.write`): one attempt as in §12.1; at most one per profile per 10 s.
- Both are documented in `docs/rpc.md` (generated) and `docs/rbac.md`; no token or JWT is ever a field.

### 12.3 Web (read-only in v1)

Settings → Providers gets a **Workload identity** group: per profile the vendor, the identifiers, the source, a state
badge (text, not colour alone), "valid until", last exchange, last error with its hint, granted scope; a **Test**
button for Owner/Admin (`auth.workload.test`). No sign-in, no logout, no secret field. Texts in German (*du*) and
English.

### 12.4 Docs

`docs/auth-engine.md` (new section), `docs/providers.md` (Anthropic bearer mode), `docs/egress.md` (hosts),
`docs/containers.md` (a Kubernetes example with the recommended projection), `docs/mcp-client.md` (deny set),
generated `docs/config.md`, `docs/cli.md`, `docs/rpc.md`, the ADR-005 amendment; user-guide text (DE/EN) goes into
the PR body as a template because `docs/user/` has its own owner.

## 13. The repository's own CI

PR CI calls no model API. Three **nightly** jobs call Anthropic live with `secrets.ANTHROPIC_API_KEY`:
`host-tool-eval-live` (the script reads the key from its environment), `turn-eval-live` (the key is stored into the
eval home's secret store, the evaluation resolves it through the harness provider) and `b5-provider-cache` (the
test reads the key from its environment).

Optional package (owner Q8): `turn-eval-live` switches to a `workload_identity` profile with the `github_actions`
source — no secret, and a real end-to-end run of this feature every night. Anthropic side: a GitHub issuer
(`https://token.actions.githubusercontent.com`, discovery), a rule with `subject_prefix`
`repo:Cyb3rb1ade/PLUR1BUS-Harness:ref:refs/heads/main` (exact, no wildcard: a wildcard also matches pull requests
from forks), `claims` `repository_owner: Cyb3rb1ade` and the nightly workflow pinned through a CEL `condition` on
`job_workflow_ref` or `workflow`, `audience` `https://api.anthropic.com`, `oauth_scope` `workspace:inference`,
`token_lifetime_seconds` 600, a dedicated workspace with a spend limit. Workflow side: `permissions: id-token: write`
on that job only (should the job ever move into a reusable workflow, the existing comment in `harness-release.yml`
about callers that do not grant `id-token: write` applies), egress hosts in the eval home. The two script-level
jobs keep the key until their scripts use the harness provider; the repository secret is deleted only after two
green nightlies without it.

## 14. Test strategy

- **No network.** Exchange tests run against local fake endpoints through the egress client (loopback allowed in the
  test config) or the injected transport fake; the vendor hosts are never contacted; a static test asserts the fixed
  endpoints exist only as adapter constants.
- **Fake Anthropic endpoint:** checks the JSON shape and grant type; enforces single use per `jti` and issuer with the
  documented opaque `401 {"type":"error","error":{"type":"authentication_error","message":"Authentication failed"}}`;
  applies min(rule lifetime, 2 × remaining JWT lifetime) with the 60 s floor; `workspace_id_required`; the 400 cases;
  429/5xx; slow answers; a skewed `Date` header; an `org:admin` scope answer.
- **Fake OpenAI endpoint:** the token-exchange shape, `expires_at`, `invalid_grant`, missing parameter, the 1 h cap.
- **Fake GitHub request endpoint:** bearer check, `audience` parameter, a fresh `jti` per call, 3xx, oversize body.
- **Identity tokens:** well-formed but unsigned test JWS strings (random signature bytes, `alg` RS256, a `kid`); no
  IdP and no JWKS are needed because the harness only presents tokens.
- **Rotating token file:** a temp directory with a kubelet-style `..data` symlink swap; rotation during an exchange;
  `chmod 000`; oversize; trailing newline; deleted mid-run; Windows absolute paths.
- **Races and expiry:** ten parallel leases → one exchange; advisory with an unchanged file → no exchange, polling;
  rotation between advisory and mandatory → one exchange; no rotation → mandatory failure with advice; timeout with
  unknown outcome → the assertion stays spent; restart with the ledger → wait; ledger write failure → no exchange;
  expiry while an exchange is in flight; a generation-guarded 401; denial backoff and the stop after three; injected
  clock, timer and random for the jitter boundaries.
- **Security:** every error, log line, snapshot, audit record and status payload is scanned for JWTs,
  `sk-ant-oat01-`, the GitHub request token and fake minted tokens; child-environment tests (exec, sandbox, MCP,
  delegated-CLI builder) prove no deny-set name reaches a child; MCP `fromHost` refusal; token-shaped config values
  refused; gateway `base_url` refused; tool deny of configured token paths.
- **Rust:** `login status` / `login test` / snippet golden JSON; the `auth.workload` check table; the existing
  secret-scan tests over CLI output.
- **Web:** unit tests and Playwright against the mock server.
- **Live:** only the owner-run WP0 spike and, optionally, the nightly job of §13.

## 15. Rollout and compatibility

Everything is additive and off by default: a new kind, new keys with `false` / `none` defaults, no change to existing
profiles, `federated_token` untouched. An older core refuses a provider with the new kind as `E_CONFIG_INVALID` for
that provider only. Removing a WIF provider leaves nothing behind but ledger entries that expire within the hour.

## 16. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Slow rotation plus single-use `jti` → outages after the first refresh (U8) | Never present a spent token (§9.2), wait and poll (§9.4), predictive WARN and computed advice in `1staid check`, recommended settings in docs |
| R2 | Opaque vendor denials make support slow | Pre-flight refusals before spending, ledger (no self-inflicted `jti_reused`), Console pointer with the typical reasons, audit with `iss`/`sub`/fingerprint for correlation |
| R3 | Vendor drift (prefix, fields, endpoints) | Constant mapping, prefix as diagnostic, contract fixtures from the documented shapes, `policy_checked` re-check as for every profile |
| R4 | Claude Code route unknowns (U1–U3) | Separate gated package (§10); the personal route is untouched |
| R5 | Over-broad vendor rules (operator side) | Docs with narrow rule recipes per source; the harness cannot see rules |
| R6 | Restart gap with `file` sources | Recommended 600 s projection; `restartCache` opt-in (Q2) |
| R7 | Egress friction (hosts must be listed) | `1staid check` names the missing entry; the snippet printer prints it |
| R8 | Projected token not readable for uid 10001 (U9) | Explicit FAIL with the fix; `docs/containers.md` example sets the security context |
| R9 | Confusing `federated_token` with `workload_identity` | ADR-005 amendment, distinct validation messages, docs table |
| R10 | One identity token file shared by two profiles of one vendor | Refused by validation (§6.3) |

## 17. Open owner questions

| # | Question | Recommendation |
|---|---|---|
| Q1 | A new kind `workload_identity`, or extend `federated_token`? | New kind; keep `federated_token` as D110's external supplier (W1, §5.2). |
| Q2 | May a minted token survive a core restart? | Memory only by default; offer `restartCache: "secret-store"` as an opt-in in v1 (§9.1). |
| Q3 | Which sources in v1? | `file` + `github_actions`; `command` in v1.1; metadata sources later behind a named egress exception (§7.3). |
| Q4 | CLI: config-only or a `login --workload-identity` writer? | Config-only plus `login status`, `login test` and the snippet printer (W12). |
| Q5 | Env import of the vendor variables? | Opt-in per vendor, file sources only, a literal token in the environment refused (§6.4). |
| Q6 | Scope policy? | Accept `workspace:inference` and `workspace:developer`, refuse `org:admin` and `workspace:manage_tunnels`, document `workspace:inference` as the recommendation (W11). |
| Q7 | Claude Code on WIF in v0.2? | No: a separate package after ADR-005 action 2a and the WP0 spike (§10). |
| Q8 | Move the nightly live jobs to GitHub OIDC? | Only `turn-eval-live`, after the core packages; keep the secret until two green nightlies (§13). |
| Q9 | `workload_identity` as a voice parent (Realtime / GPT-Live)? | Later; `federated_token` keeps serving voice. |
| Q10 | Reuse `OPENAI_IDENTITY_TOKEN_FILE` (Codex's name) for the opt-in OpenAI import? | Yes, with the Codex-child strip of §6.5; the alternative is a harness-specific name operators must learn. |

## 18. Documents the implementation amends

| Document | Change |
|---|---|
| ADR-005 | Amendment: kind `workload_identity` (harness-performed exchange, adapters `anthropic` / `openai`), the one-sentence split from `federated_token`, policy rows `anthropic:workload-identity` (`allowed`, wif page, 2026-10-29) and the OpenAI exchange profile; "Revisit when" for metadata sources, Google `external_account`, Entra, X.509 |
| `docs/auth-engine.md` | Kind, sources, ledger, schedule, error table |
| `docs/openai-auth.md` | `federated_token` (supplier) vs `workload_identity` (exchange); `workload.ts` moved |
| `docs/providers.md` | Anthropic bearer mode |
| `docs/egress.md` | Exchange and source hosts |
| `docs/containers.md` | Kubernetes projection example (600 s, audience, security context) |
| `docs/mcp-client.md` | Vendor credential deny set |
| `docs/config.md`, `docs/cli.md`, `docs/rpc.md` | Regenerated |
| `docs/rbac.md`, `docs/doctor.md` | New methods; check `auth.workload` |
