# Workload Identity Federation (WIF) credential kind: implementation plan

**Goal.** A harness running in Kubernetes, on a cloud VM or in CI calls Anthropic and OpenAI with no static key:
a new auth-engine kind `workload_identity` exchanges an IdP identity token (a rotating file or a GitHub Actions OIDC
token) for a short-lived vendor token, owned by the existing `RefreshOwner`, kept in memory, every identity token
presented at most once. Specified in
[`2026-10-29-workload-identity-federation-design.md`](../specs/2026-10-29-workload-identity-federation-design.md)
(cited as "spec §n").
**Architecture.** Closed profile block validated in `auth/profile.ts`; sources and pre-flight in a new
`packages/core/src/auth/workload/`; two exchange adapters with fixed endpoints over a JSON variant of the guarded
OAuth transport; a mint path, a spent-assertion ledger and denial handling inside `RefreshOwner`; a bearer mode for
the Anthropic Messages adapter; a vendor-credential deny set for every child environment; `auth.workload.*` RPC
(validate, test, status, remove; Owner only) reachable from an attached desktop; a full CLI setup in the existing
`plur1bus login` verbs (wizard, non-interactive flags with `--json`, status, list, test, logout) plus a setup step
`auth` and a `1staid check` entry (Rust); a web form; the WIF hook into the desktop SSH install (D113).
**Status.** Owner decisions 2026-10-29: support WIF, not urgent (v0.2 / enterprise track); personal default
unchanged; **Q4 decided: full CLI setup parity**, including headless servers and the remote primary-server path
(spec §12.1, §12.2, §12.5); **all other owner questions (spec §17, Q1–Q3, Q5–Q14) decided as recommended** on the
same day, so no package waits for an owner answer. The remaining gates are WP0 spike results, ADR-005 action 2a and
the D113 packages. WP0 needs owner credentials and the NAS Ubuntu VM.
**Executor.** TypeScript packages: the controller's choice of agent. **Rust packages (WP8a, WP8b, WP13 and the Rust
half of WP12): Claude agent** (owner decision 2026-10-21: Rust by Claude, not Codex). One branch and one ready PR per package
(`claude/wif-wp1-kind`, `…-wp2-sources`, …), each from fresh `origin/main` or stacked with `Stacked on #N`.
**Constraints.** No change to the Claude Code / Agent SDK route, Sign in with ChatGPT, setup-token or API-key
behaviour; `federated_token` untouched (spec W1). No real vendor endpoint, IdP or GitHub token in tests or fixtures;
no network in tests. No token, JWT or request token in any log, error, snapshot, audit record, status payload,
argv, child environment or committed file. Every new outgoing request goes through `egress.request`. Config keys
closed with `x-restart`/`x-tier`. No CI polling, force-push, rebase, amend or stash. Commit identity
`Cyb3rb1ade <cyb3rblade@me.com>` with model and session trailers.

## Review focus

1. **Single use:** no code path presents an identity token whose fingerprint is in the ledger; the ledger is written
   before the request leaves; a timeout or crash never leads to a re-send (spec §9.2). Grep for every caller of the
   adapters' `exchange`.
2. **Single owner:** exchanges happen only inside `RefreshOwner`'s flight map; no adapter, provider or RPC handler
   mints on its own; `auth.workload.test` goes through the same flight.
3. **No secret escapes:** `Sensitive` wrappers, constant `AuthError` messages, redacted `toJSON`/inspection on every
   new object, registration with `secrets.redaction`, the secret-scan tests extended to JWTs and `sk-ant-oat01-`.
4. **Destination pinning:** exchange endpoints are constants; the minted token only reaches the vendor API hosts
   (spec §6.1 `base_url` rule); GitHub request hosts checked against the suffix list before egress.
5. **Child environments:** the deny set is enforced in exec, sandbox, MCP and the delegated-CLI builder, for
   inherited and declared values (spec §6.5).
6. **Classification:** opaque 401s are never retried with the same token, denial backoff stops after the configured
   count, transient failures keep serving until the mandatory moment (spec §9.3, §9.5).
7. **Personal default unchanged:** existing profile, pool, refresh and adapter tests pass without edits.
8. **Remote invariants (spec §12.5):** the identity-token source and the minted token never leave the server (no
   RPC result, CLI document, event, log or bundle carries them); token-file paths are validated only by the server's
   core; no flag carries a token-shaped value; the GUI renders the server's documents verbatim.
9. **One implementation:** `login --workload-identity`, the setup step `auth`, the web form and the desktop's SSH
   commands all go through `auth.workload.validate` → `config.set` → `auth.workload.test`; no second validator.

## Dependencies and order

```text
WP0 spike (owner time; answers U1, U2, U6, U8, U9) ──────────────────────────────┐ (informs WP2 host list, WP10 docs, WP12)
WP1 kind + validation + config keys ──► WP2 sources + pre-flight ──► WP4 mint path, ledger, classification ──► WP5 provider wiring
                                   └──► WP3 exchange adapters + JSON transport ──┘                                   │
WP6 env import + hygiene (after WP1; parallel to WP2–WP5) ───────────────────────────────────────────────────────────┤
                                  WP7 RPC + RBAC + audit (after WP4) ──► WP8a CLI login setup + 1staid (Rust, Claude agent) ──► WP8b setup step `auth` (Rust, Claude agent)
                                                                    └──► WP9 web form + status
WP10 docs + ADR-005 amendment (with WP5; final pass after WP8a/WP8b/WP9)
WP11 nightly turn-eval-live on GitHub OIDC (decided Q8) (after WP5, WP7)
WP12 gated: Claude Code on WIF (after ADR-005 action 2a + WP0, decision tree spec §10.1)
WP13 gated: WIF hook in the desktop SSH install (after WP8a/WP8b + D113 WP3/WP4; Rust, Claude agent)
```

Until WP5 lands, composition refuses `workload_identity` providers with `E_CONFIG_INVALID` reason
`workload-identity-unavailable`, so WP1–WP4 can merge without a half-working route.

---

## WP0 — Spike and evidence (≈ 1 agent day + owner time)

**Purpose.** Replace the spec's inferences with observations before code depends on them. No product code.

**Needs (owner).** An Anthropic test organisation with WIF enabled (Console: one issuer, one service account, rules
with `token_lifetime_seconds` 600 and 900); a k3s cluster on the NAS Ubuntu x64 VM (booted on request) with a
public-JWKS-less issuer registered `inline`; a scratch workflow with `id-token: write`.

**Steps.**
- **U8 / U9 (Kubernetes):** project a token with `audience: https://api.anthropic.com` and `expirationSeconds` 3600,
  then 600; record whether it carries `jti`, the file mode and owner seen by uid 10001, and the observed rotation
  times including the kubelet sync lag; exchange the same token twice with `curl` (token read from the file inside
  the pod, never echoed) and record the second answer and the Console history reason.
- **U1 / U2 (Claude Code):** in a scratch home, `claude --bare -p "ping"` with `--settings` naming an `apiKeyHelper`
  script that prints a minted `sk-ant-oat01-` token from a 0600 file; record success or the error class. Repeat with
  `ANTHROPIC_AUTH_TOKEN` in the environment instead.
- **U6 (GitHub):** a `workflow_dispatch` job that prints only the host name of `ACTIONS_ID_TOKEN_REQUEST_URL`.

**Output.** `docs/handoff/status/2026-1x-xx-wif-spike.md`: each unknown marked answered / not answered with evidence;
IDs replaced by placeholders, no token, no JWT, no claim values beyond `iss` and `aud`.

**Acceptance.** The record exists; WP2 adopts the observed GitHub host suffix; WP4's rotation verdict (spec §9.4:
80 % of the token lifetime plus a 60 s sync margin) is confirmed or adjusted against the observed kubelet timing, and
U8 is marked observed or refuted; WP10 adopts the observed Kubernetes numbers; WP12's branch is chosen by the
decision tree of spec §10.1 (dual header accepted → `apiKeyHelper`; else bare mode reads `ANTHROPIC_AUTH_TOKEN` →
per-run variable; else parked pending an owner decision).

## WP1 — Kind, profile block, validation, config keys (≈ 2 agent days)

**Files.**
- `packages/core/src/auth/profile.ts` — `AUTH_KINDS` += `workload_identity`; types `WorkloadIdentityBlock`,
  `IdentityTokenSource` (`file` | `github_actions`), vendor blocks; closed validation per spec §6.1 and §6.3 (vendor
  block matches `exchange`, absolute path / audience rules, `accepted_scopes` subset, refused fields for the kind,
  `auth_header_scheme` must be bearer, `base_url` pinning, token-shaped string refusal `value-looks-like-a-token`);
  `isMinted(profile)`.
- `packages/core/src/auth/errors.ts` — codes `workload_denied`, `workload_config_invalid`, `identity_unavailable`;
  optional constant `reason` on `AuthError`.
- `packages/core/src/composition/auth.ts` — `billingClassOf` maps the kind to `paid`; `classifyProviders` refuses two
  workload providers with the same exchange vendor and token file, warns on cross-vendor sharing, and refuses every
  workload provider with `workload-identity-unavailable` until WP5 removes that line.
- `packages/core/src/openai-auth/profiles.ts` — foreign credential roots += `~/.config/anthropic/credentials`,
  `%APPDATA%\Anthropic\credentials` (used by the path refusal).
- `packages/config-schema/schema/config.schema.json` — `auth.workloadIdentity` exactly as spec §6.2; regenerate the
  schema types and `docs/config.md` (`pnpm docs:gen`).

**Tests (TDD, write first).**
- `packages/core/test/auth/profile-workload.test.ts` — the two spec §6.1 examples validate; one test per refusal
  (unknown field, vendor mismatch, relative path, path under each foreign root, audience with CR/LF, `secret_ref` /
  `refresh` / `tokenUrl` present, `x-api-key` scheme, gateway `base_url` for each vendor, `org:admin` in
  `accepted_scopes`, `workspace_id: "default"`, a JWT pasted into `service_account_id`); messages constant and free of
  the input.
- `packages/core/test/composition/billing.test.ts` — the kind is `paid`; same-vendor file sharing refused for that
  provider only; the unavailability refusal isolates the provider.
- `packages/config-schema` tests — defaults, closed objects, every leaf has `x-restart` and `x-tier`.

**Acceptance.** Core and config-schema tests, `pnpm lint`, `pnpm docs:check` green; existing `profile.test.ts`
unchanged and green.

## WP2 — Identity-token sources and pre-flight (≈ 2.5 agent days)

**Files.**
- `packages/core/src/auth/bounded-file.ts` — new: the bounded, deny-checked file reader extracted from
  `openai-auth/federated.ts` (`supplierFile`), used by both; behaviour of the D110 supplier unchanged.
- `packages/core/src/auth/workload/source-file.ts` — read by path per call (no cached descriptor), regular file
  ≤ 16 KiB, trim, compact-JWS shape, SHA-256 fingerprint, constant failure codes (spec §7.1).
- `packages/core/src/auth/workload/source-github.ts` — runner variables read at call time, URL rules and host-suffix
  check (default `actions.githubusercontent.com`, or the host WP0 observed), `audience` added through
  `URLSearchParams`, bearer header, `getJson`, JSON `value` (spec §7.2).
- `packages/core/src/auth/workload/jwt.ts` — bounded decode without verification; pre-flight refusals and diagnostics
  of spec §7.4; a claims summary type that holds only `iss`, `sub`, `aud`, `exp`, `iat`, `hasJti`.
- `packages/core/src/auth/http.ts` — `getJson(url, headers, signal)` through `egress.request` (no redirects,
  16 KiB cap, deadline, constant errors).

**Tests.**
- `packages/core/test/auth/workload/source-file.test.ts` — kubelet-style `..data` symlink swap between two reads;
  rotation during a read; `chmod 000`; 16 KiB + 1; trailing newline; deleted file; non-JWS content; Windows absolute
  path parsing; a path under a deny root refused before any read.
- `packages/core/test/auth/workload/source-github.test.ts` — fake request endpoint over loopback egress: bearer and
  `audience` checked by the fake, a fresh token per call, 3xx not followed, oversize body, host outside the suffix
  list refused before egress, missing runner variables → `identity_unavailable` / `source_failed`.
- `packages/core/test/auth/workload/jwt-preflight.test.ts` — `alg` none / HS256, missing `kid`, stale `exp`, `iat`
  and `nbf` in the future beyond 30 s, the 30 s boundaries, `aud` mismatch diagnostic, `exp − iat` > 3600 info,
  missing `jti` info, malformed base64url / JSON, 16 KiB.

**Acceptance.** Tests green; `test/egress/post-paths.test.ts` (extended: the new GET path opens no socket) green;
D110 federated-supplier tests unchanged and green.

## WP3 — Exchange adapters and JSON transport (≈ 2 agent days)

**Files.**
- `packages/core/src/auth/http.ts` — `postJson(url, body, signal)` with the guarantees of the form POST; both new
  calls return the response `Date` header.
- `packages/core/src/auth/workload/exchange.ts` — `ExchangeAdapter` / `Minted` types (spec §5.3), the closed registry,
  endpoint constants, a loopback-only test seam.
- `packages/core/src/auth/workload/exchange-anthropic.ts` — spec §8.1 body, validation, scope gate, error table.
- `packages/core/src/auth/workload/exchange-openai.ts` — spec §8.2; the RFC 8693 logic moved from
  `openai-auth/workload.ts`.
- `packages/core/src/openai-auth/workload.ts` — becomes a re-export with a deprecation comment; its test moves to the
  new adapter's test file.

**Tests.**
- `packages/core/test/auth/workload/exchange-anthropic.test.ts` — fake endpoint (built on `test/auth/mock-oauth.ts`):
  exact JSON body with and without `workspace_id`; 400 / 401 (the documented opaque body) / 403 / 404 / 3xx / 429 /
  5xx / timeout / invalid JSON mapped per the table; `org:admin` and `workspace:manage_tunnels` answers refused and the
  token discarded; unexpected prefix → diagnostic only; `expires_in` 59 and 86401 refused; `expiresAt` counted from
  request start under an injected clock.
- `packages/core/test/auth/workload/exchange-openai.test.ts` — body and `subject_token_type` variants; `expires_at`
  minimum rule; skew diagnostic above 60 s; `invalid_grant` → denied; missing parameter → config invalid;
  `expires_in` > 3600 refused; `issued_token_type` mismatch refused.
- `packages/core/test/auth/http-boundary.test.ts` — extended: no response text, URL or body in any error from the JSON
  variants; redacted inspection.

**Acceptance.** Tests green; no import of `node:http(s)`/`fetch` in the new files (static test); the old
`workload.test.ts` cases pass against the new adapter.

## WP4 — Mint path in `RefreshOwner`, ledger, schedule, classification (≈ 4 agent days)

**Files.**
- `packages/core/src/auth/refresh.ts` — record-source abstraction (existing store source; new memory source, optional
  secret-store backing for `restartCache`); `Minter` port beside `Refresher`; advisory / mandatory thresholds and
  their short-lifetime scaling (spec §9.3); never mint per lease; "no fresh token" outcome that keeps serving and
  schedules a poll; denial backoff 30 s / 2 min / 8 min and the stop after `maxConsecutiveDenials`; 429 handling of
  spec §9.7 (`Retry-After` seconds or HTTP date clamped to 1 s … 1 h, then 2 s → 5 min with ≤ 20 % jitter, reason
  `rate_limited`); resume hooks (config change, explicit test).
- `packages/core/src/auth/workload/ledger.ts` — `state/auth-workload.json`, 0600, atomic replace, vendor-scoped keys
  on the fingerprint **and** `SHA-256(iss ‖ jti)` (spec §9.2), prune at `exp` + 60 s, fail closed on write errors.
- `packages/core/src/auth/workload/rotation.ts` — the rotation-versus-lifetime verdict of spec §9.4 (Kubernetes
  tokens by their `kubernetes.io` claim: `iat + 0.8 × (exp − iat)` + 60 s; other files: observed interval) compared
  with exchange time + minted lifetime − 30 s; the computed fix (rule lifetime and/or `expirationSeconds`, minimum
  600).
- `packages/core/src/auth/workload/minter.ts` — source → pre-flight → ledger → adapter; registers the identity token
  as a transient redaction value for the duration of the call.
- `packages/core/src/auth/credentials.ts` — dispatch `isMinted` profiles to the mint path with the synthetic pool
  entry `workload`; `reportResult` 401 handling extended from `isRefreshable` to `isMinted`.
- `packages/core/src/auth/secret-store.ts` — encode/decode of the minted record `{ v, accessToken, expiresAt,
  generation, profileHash }` for `restartCache`.

**Tests.**
- `packages/core/test/auth/refresh-workload.test.ts` — ten parallel leases → one exchange; advisory with an unchanged
  file → no exchange and a poll scheduled; rotation between advisory and mandatory → exactly one exchange; no
  rotation → leases fail after the mandatory moment with `identity_unavailable` / `not_rotated`; jitter boundaries
  (random 0 and 1); lifetimes 60 s and 200 s scale the thresholds; transient backoff and serving until the mandatory
  moment; denial backoff and stop after 3; resume after a config change and after an explicit test with a fresh token;
  `close()` cancels timers.
- `packages/core/test/auth/workload/ledger.test.ts` — the ledger entry exists before the fake endpoint sees the
  request; a request that times out leaves the token spent and the next attempt waits for new content; a restart
  (new owner, same state dir) waits instead of re-sending; ledger write failure → no request, `persist_failed`;
  pruning; the same token allowed once per vendor; a re-encoded token with an already used `jti` refused locally
  (no request reaches the fake endpoint).
- `packages/core/test/auth/workload/rotation.test.ts` — Kubernetes-shaped 3600 s token with a 600 s minted lifetime →
  `rotation_slower_than_refresh` naming both fixes; 600 s token with 900 s → OK; 600 s with 600 s → OK with the sync
  margin; a plain file before and after two observed rotations; a minted lifetime capped by 2 × remaining.
- 429 cases in `refresh-workload.test.ts` — `Retry-After` in seconds, as an HTTP date, missing, out of range; backoff
  bounds; the token stays spent; status `rate_limited`; one audit record per episode.
- `packages/core/test/auth/credentials-workload.test.ts` — generation-guarded 401 re-mints with a fresh token; a second
  401 right after a fresh mint cools the credential (sole, 300 s); 403 → `forbidden` ambiguous; lease JSON redacted.
- `restartCache` cases — a stored record is used after restart only while unexpired and with a matching
  `profileHash`; a changed profile deletes it; with `none` nothing is written to the secret store (the fake store's
  `setCalls` stays 0).

**Acceptance.** Tests green; `refresh.test.ts`, `refresh-schedule.test.ts`, `credentials.test.ts`, `pool.test.ts`
unchanged and green.

## WP5 — Provider wiring (≈ 2 agent days)

**Files.**
- `packages/providers/src/anthropic/types.ts`, `client.ts` — `AnthropicCredentials` becomes `{ apiKey }` or
  `{ authorization }` (exactly one); bearer mode sends `Authorization: Bearer …` and no `x-api-key`, the
  `authorization` header joins the adapter-managed header set, the value is scrubbed like the key, plain-http refusal
  unchanged.
- `packages/core/src/composition/auth.ts` — pick the Anthropic credential mode from `auth_header_scheme` (today a
  bearer value reaches `apiKey` and is refused as unusable); extend `registerSecret` with an optional name so the
  minted token is pinned under `workload:<profileId>` (`secrets.redaction.register(value, name)` already supports
  it) and retired on re-mint; remove WP1's `workload-identity-unavailable` refusal.
- `packages/core/src/composition/index.ts` — hand `auth.workloadIdentity` and the state directory to the
  credentials provider.
- `packages/core/src/discovery/real-adapters.ts` — no manual-only rule for the kind (test-pinned).
- `docs/providers.md` — Anthropic bearer mode.

**Tests.**
- `packages/providers/test/anthropic/*` — bearer mode header set; both credentials given → `TypeError`; secret scans
  (`test/secrets.test.ts`, `test/secrets-wires.test.ts`) extended to the bearer value.
- `packages/core/test/composition/auth-workload.test.ts` — fake exchange + fake Messages endpoint over loopback egress:
  a turn carries `Authorization: Bearer <minted>` and no `x-api-key`; a Responses provider with the OpenAI adapter
  carries the bearer; discovery `GET /v1/models` carries it; billing `paid`; `privacy.localOnly` → no exchange request
  at all; a gateway `base_url` provider is refused while others compose.

**Acceptance.** Core and providers tests green; the existing Anthropic API-key tests unchanged and green; one manual
run on the owner's Mac with a fake endpoint documented in the PR.

## WP6 — Env import and environment hygiene (≈ 2 agent days)

**Files.**
- `packages/core/src/auth/workload/env-import.ts` — spec §6.4: read once, explicit config wins, missing names listed,
  empty = missing, `ANTHROPIC_IDENTITY_TOKEN` refused (`identity-token-in-env`), audit `auth.workload.env_imported`.
- `packages/core/src/composition/index.ts` — synthesise the provider at core start when opted in.
- `packages/core/src/tools/exec/env.ts` — exported `VENDOR_CREDENTIAL_ENV` (spec §6.5 P3), enforced in `buildEnv`
  for inherited names regardless of `allow`, and refused for requested values (`env-refused`).
- `packages/core/src/mcp/config.ts`, `mcp/env.ts` — refuse `fromHost` and declared `env` names from the deny set
  (`E_CONFIG_INVALID reason=vendor-credential-env`).
- `packages/core/src/host-tools/denylist.ts` and the fs tools' deny list (`packages/core/src/tools/fs/`) — add the
  configured identity-token paths at composition, `~/.config/anthropic/credentials`,
  `%APPDATA%\Anthropic\credentials`.
- `packages/core/src/auth/redact.ts` — `scrub()` gains the JWT shape and `sk-ant-oat01-`.
- `docs/mcp-client.md` — the deny set.

**Tests.** env-import table tests (all variables, each missing one, literal token, explicit provider wins, audit
names only); exec / sandbox / MCP child-environment tests proving no deny-set name reaches a child, inherited or
requested; MCP config refusal; host-tools and fs-tool refusal of a configured token path and of the Anthropic
credentials directory; `redaction.test.ts` extended.

**Acceptance.** Tests green; `packages/core/test/mcp/secrets.test.ts` and exec env tests unchanged and green.

## WP7 — RPC, RBAC, audit, status (≈ 3 agent days)

**Files.**
- `packages/core/src/rpc/auth-surface.ts` — additive `workload: WorkloadStatus[]` on `auth.status` and
  `auth.credentials.list`; new methods (spec §12.3): `auth.workload.validate` (closed params; §6.1/§6.3 rules and the
  token-file stat + pre-flight on the core's own filesystem as its own OS user; returns `{ definition, preflight,
  egress.missing, conflicts }`, writes nothing, exchanges nothing), `auth.workload.test` (one per profile per 10 s,
  through the owner's flight, result incl. rotation verdict), `auth.workload.status` (read), `auth.workload.remove`
  (drops ledger entries and the `restartCache` record after the supervisor removed the definition).
- RBAC: the methods declared in `RPC_RULES` as human-only, mapped to the existing `auth.credentials.read` (status) and
  `auth.credentials.write` (validate, test, remove), **Owner only** (spec §11, decided Q11); `docs/rbac.md` rows.
- `packages/api/src/rpc-route.ts` — the four methods join the API's RPC allowlist next to `auth.status` and
  `auth.login.*`, so the web UI and an attached desktop reach them; `config.set` stays as admitted today in
  `crates/plur1bus/src/supervisor/api_transport.rs` (no change there).
- `packages/core/src/auth/credentials.ts` / `refresh.ts` — the status projection per minted profile (state incl.
  `rate_limited` and `rotation_slower_than_refresh`, timestamps, last error code, scope, claims summary, ledger
  counts); never a token.
- RPC schema (`packages/rpc-schema`), regenerated `docs/rpc.md`, `docs/api-surface.md` and `docs/openapi.json`.
- Audit actions of spec §11 (`auth.workload.exchange`, `.validated`, `.removed`, `.blocked`, `.rate_limited`,
  `.rotation_wait`, `.env_imported`, `.cache_restored`, `.test`, each with `origin`) through `audit.append`.

**Tests.** RPC tests for every method and the additive fields: role matrix (Owner allowed; Admin, Operator, Member,
Viewer, agents, unauthenticated refused), the rate limit, unknown profile, `validate` with a path that does not exist
on the core host, a symlinked projected-volume path, a token-shaped value in an id field, same-file sharing; the full
sequence validate → `config.set` (fake supervisor) → test → status → remove; through the API route with a session
cookie; an audit test that every action carries only the listed fields; a payload secret scan over every result.

**Acceptance.** Core and API tests, `pnpm docs:check` and the RPC schema check green.

## WP8a — CLI setup in `plur1bus login` and `1staid check` (Rust, **Claude agent**) (≈ 4.5 agent days)

**Files.**
- `crates/plur1bus/src/commands/login.rs` —
  - `Route::WorkloadIdentity` next to `ApiKey` / `Oauth`, selected by `--workload-identity` for `anthropic` /
    `openai` (other providers: `E_INVALID_PARAMS reason=workload-identity-unsupported-provider`);
  - `WorkloadIdentityArgs` (one clap struct, flattened into `LoginArgs` here and into `SetupArgs` by WP8b) with the
    flags of spec §12.1 (`--wif-provider-id`, `--wif-source`, `--wif-token-file`, `--wif-audience`, `--wif-rule-id`,
    `--wif-organization-id`, `--wif-service-account-id`, `--wif-workspace-id`, `--wif-identity-provider-id`,
    `--wif-subject-token-type`, `--wif-scope`, `--wif-from-env`, `--wif-allow-egress`, `--wif-replace`,
    `--wif-test`) and `--non-interactive`;
  - the interactive wizard (spec §12.1 order, validation per answer through `auth.workload.validate`, re-ask on
    error, summary, confirm, write through the existing config route, wait for the core restart, offer the test) on a
    `Prompter`-style seam shared with setup;
  - the non-interactive path with `missing-<flag>` refusals, `provider-exists` without `--wif-replace`, the exit-code
    table of spec §12.1 (existing codes only), document `login.workload/1` (`written` stays true when only the test
    failed);
  - `login status` / `login list` workload rows (additive fields of `login.status/1`, `login.list/1`), new
    `login test <id>` (`login.test/1`), `login logout <id>` for workload profiles (config route removal, then
    `auth.workload.remove`; confirmation, `--yes`; `login.logout/1` with `kind`); the visible `remove` alias of `logout`
    for every kind (decided Q12);
  - token-shaped values refused in every flag (`value-in-argument`, never echoed).
- `crates/plur1bus/src/commands/firstaid.rs` — check `auth.workload` after `models.warm` in `CHECK_IDS`, reading
  `auth.workload.status` over the existing core connection, the findings table of spec §12.1 including
  `rotation_slower_than_refresh` and `rate_limited`; `skip` when no workload profile exists or the core is down.
- `docs/errors.md` (the WIF reasons), `docs/cli.md` regenerated (`pnpm docs:gen`), `docs/doctor.md`.

**Tests.** On the existing `FakeCore` / `FakeRpc` harness: the wizard through the prompt seam (every question, re-ask,
decline → `E_CANCELLED`/2, Ctrl-C → 130); the non-interactive matrix (each missing flag, token-shaped values in each
flag, replace, test, `--from-env` with an injected environment, core down → `E_CORE_UNAVAILABLE`); golden JSON for
all five documents; exit codes checked against the table; firstaid vectors for every finding in the fixed order; a
recorded-argv test; the existing CLI secret-scan tests extended to JWTs and `sk-ant-oat01-`.

**Acceptance.** `cargo fmt --all -- --check`, `cargo clippy --workspace -- -D warnings`, `cargo test -p plur1bus`,
`node scripts/check-cli-exit-codes.mjs --check`, `pnpm docs:check` green; manual pass on the owner's Mac and on the
NAS Ubuntu VM (headless, over SSH) against a core with a fake exchange endpoint.

## WP8b — `plur1bus setup` step `auth` and the headless server path (Rust, **Claude agent**) (≈ 2 agent days)

**Files.**
- `crates/plur1bus/src/install/setup.rs` — `STEP_IDS` gains `auth` between `start` and `check` (decided Q13); the step
  offers `skip` (default) / `workload-identity` / `api-key` / `chatgpt`, runs the WP8a wizard or flag path for
  `workload-identity` and hands `api-key` / `chatgpt` to the existing interactive login routes; `detail` per spec
  §12.2; a refused configuration fails the step, a denied / rate-limited / rotation-wait test is `done` with a warning;
  `already-installed` when the stored definition equals the flags.
- `crates/plur1bus/src/cli.rs` (`SetupArgs`) — `--auth <skip|workload-identity|api-key|chatgpt>`, `--auth-provider`,
  the flattened `WorkloadIdentityArgs`; `api-key` / `chatgpt` refused with `--non-interactive`
  (`E_INVALID_PARAMS reason=auth-needs-terminal`, hint `plur1bus login`).
- `crates/plur1bus/src/commands/setup.rs` — `NoPrompts` answers the `auth` step from the flags; `describe` renders it.
- `setup_asks_only_basic_tier_questions` scoped to the `config` step with the documented HB11 exception for `auth`.
- `docs/module-guide.md` §12 and the D113 spec's step list (pointer only).

**Tests.** Step order and ids; `--auth skip` keeps today's `setup/1` apart from one skipped step; `workload-identity`
done / failed / done-with-warning; idempotent re-run; headless run without a TTY (`--non-interactive` on Linux without
`DISPLAY`) end to end against a fake core and fake exchange; the profile-upgrade re-exec path keeps the flags.

**Acceptance.** Rust gates as in WP8a; an existing `setup --non-interactive` script produces the same exit code and
the same steps plus `auth: skipped`.

## WP9 — Web: Workload identity form and status (≈ 3 agent days)

**Files.** `packages/web/src/pages/settings/sections/providers.ts` (a **Workload identity** group fed by
`auth.status`'s `workload` array and `auth.workload.status`; for the Owner an Add / Edit form with the wizard's fields
validated live through `auth.workload.validate`, written with `config.set`, then **Test** and **Remove**; every value
shown is the server's answer; no local file picker for the token path; no secret field),
`packages/web/src/i18n/providers.ts` (DE with *du*, EN), the mock server's `auth.*` and `config.set` fixtures,
`packages/web/scripts/gen-settings-index.mjs` output. This is the surface an attached remote desktop shows (spec §12.5).

**Tests.** Component tests (states incl. `rate_limited` and the rotation verdict, badges with text, Owner-only gating,
server errors shown as localized sentences, no token-shaped strings rendered); Playwright against the mock server in
DE/EN light/dark: add, validate error, test, remove; `node scripts/check-i18n.mjs`.

**Acceptance.** Web unit and browser tests green; settings index check green.

## WP10 — Docs and ADR-005 amendment (≈ 2 agent days)

**Files.** ADR-005 amendment (spec §18 row 1); `docs/auth-engine.md` (kind, sources, ledger, schedule, error table,
rate limits); `docs/openai-auth.md` (`federated_token` vs `workload_identity`, `workload.ts` moved); `docs/egress.md`
(hosts); `docs/containers.md` (Kubernetes example: projection `audience`, `expirationSeconds: 600`, a security context
that makes the token readable for uid 10001 per WP0, the env-import variant, "one token source per host");
pointers in the D113 spec (§6.3, §6.4, §6.6, step `auth`); narrow rule recipes per source (GitHub exact ref,
Kubernetes exact service account with audience); a DE/EN user-guide template in the PR body (`docs/user/` has its own
owner), including the headless CLI walkthrough.

**Acceptance.** `node scripts/check-doc-links.mjs`, `node scripts/lint-hygiene.mjs`, `pnpm docs:check` green.

## WP11 — Nightly `turn-eval-live` on GitHub OIDC (≈ 1.5 agent days; decided Q8, after the core packages)

**Files.** `.github/workflows/nightly.yml` (`permissions: id-token: write` on `turn-eval-live` only; the secrets step
replaced by writing a `workload_identity` profile with the `github_actions` source and the egress hosts into the
eval home), `scripts/eval/turn-eval-secrets.ts` (profile writer instead of key import, keeping the OpenAI refusal),
`docs/turn-eval.md`.
**Owner steps.** Console: GitHub issuer, rule per spec §13 (exact ref, owner claim, workflow pin, audience,
`workspace:inference`, 600 s), a dedicated workspace with a spend limit; repository variables for the IDs.
**Acceptance.** `actionlint` and the workflow-pin gate green; two green scheduled runs without the secret before
`ANTHROPIC_API_KEY` is removed from that job (the other two live jobs keep it).

## WP12 — Gated: Claude Code on WIF (≈ 3 agent days; Rust half by **Claude agent**)

**Gate.** ADR-005 action item 2a (the Claude Code backend exists on `main`) and the WP0 result, applied through the
decision tree of spec §10.1: dual header accepted → `apiKeyHelper` (below); rejected but bare mode reads
`ANTHROPIC_AUTH_TOKEN` → the per-run variable variant (no helper; recycling of resident sessions before expiry);
neither → **parked**, and any non-bare variant needs an owner decision recorded as an ADR-005 amendment first. U1/U2
affect only this package; the harness's own Anthropic calls (WP5 bearer mode) ship regardless. Not part of the v0.2
core scope (decided Q7).

**Files (apiKeyHelper branch).** The Claude Code backend's child builder (deny set, `--settings` with
`apiKeyHelper`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=60000`); `crates/plur1bus/src/commands/auth.rs` (new hidden
`auth token-helper`: reads `PLUR1BUS_TOKEN_HELPER_HANDLE`, asks the core over the local socket, prints the token to
stdout only); `packages/core/src/rpc/` internal method for session-bound handles (create on session start, revoke on
end, rate limit, never on the public RPC list); docs of the accepted residual risk (spec §10).

**Tests.** Child-environment test (no `ANTHROPIC_*` credential variable present, except the route's own variable in
the second branch); handle lifecycle (revoked after session end, wrong profile refused, rate limit); helper output
never logged; an integration test with a fake `claude` binary that runs the helper and records the header it would
send.

**Acceptance.** Tests green; owner manual run against the test organisation.

## WP13 — Gated: WIF hook in the desktop SSH install (Rust, **Claude agent**) (≈ 1.5 agent days)

**Gate.** WP8a and WP8b merged; the D113 packages it extends (`2026-10-18-desktop-ssh-remote.md` WP3 native commands,
WP4 remote install/manage) exist on `main`. Built as a stacked follow-up to D113 WP4, or folded into it if WP4 is
still open. The "SSH host becomes the primary server, the desktop instance a client" flow is **not** in scope here
(decided Q14: a D113 follow-up spec of the desktop track); it will call the same commands.

**Files.**
- `apps/desktop/src-tauri/src/ssh_remote/setup.rs` — the install plan's optional WIF answers become `--auth
  workload-identity --auth-provider <vendor> --wif-…` on `setup --non-interactive --json`; every value checked
  against D113's charset `[A-Za-z0-9._/:=@+-]` before anything is sent.
- `apps/desktop/src-tauri/src/ssh_remote/manage.rs` and the `RemoteCommand` enum — `WorkloadValidate`,
  `WorkloadConfigure`, `WorkloadTest`, `WorkloadStatus`, `WorkloadList`, `WorkloadRemove` (spec §12.5), rendering to
  the fixed `login …` command lines; `ssh_manage`'s closed action enum gains the actions
  (`apps/desktop/desktop-contract`).
- `apps/desktop/ui/src/views/ssh-hosts/install.ts`, `manage.ts` — a WIF section (vendor, source, server path or
  audience, identifiers, scope; no local file picker) that renders the server's `login.workload/1`, `login.test/1`
  and `login.status/1` verbatim; DE/EN strings.

**Tests.** With D113's `test-bins/fake-plur1bus` scenarios: each `Workload*` command renders inside the charset, an
out-of-charset value is refused before sending, recorded argv contains no token-shaped value; the UI shows the server
document verbatim (status, hints, exit reason); browser suite for the WIF section; a scan proving no command output
stored by the desktop contains a token or JWT.

**Acceptance.** Desktop Green gate (`cargo test --locked --workspace`, desktop UI tests, `check-i18n`); manual run
against the NAS Ubuntu VM: install with WIF over SSH, test, status, remove.

## Test matrix

| Area | Linux CI (x64, arm64) | macOS CI | Windows CI | Owner Mac (aarch64) | NAS Ubuntu VM (k3s) |
|---|---|---|---|---|---|
| Profile validation, adapters, ledger, schedule, rate limits, rotation verdict (WP1–WP4) | gate (unit) | — | unit (paths) | `pnpm test` | — |
| File source rotation (symlink swap) | gate | — | skipped (POSIX symlink semantics), absolute-path parsing tested | real swap with a script | real projected volume (WP0) |
| GitHub source | fake endpoint | — | — | fake endpoint | — |
| Provider wiring (WP5) | gate | — | — | fake exchange + fake Messages | — |
| Child environments (WP6) | gate | — | exec / MCP env on Windows | — | — |
| RPC sequence and RBAC (WP7) | gate | — | — | — | — |
| CLI wizard, flags, status/test/logout, 1staid (WP8a) | gate (Rust) | Rust tests | Rust tests | manual pass | headless run over SSH |
| Setup step `auth`, headless server (WP8b) | gate (Rust) | Rust tests | Rust tests | manual `setup` | `setup --non-interactive --auth workload-identity` over SSH |
| Web form (WP9) | gate (unit, browser) | — | — | visual DE/EN light/dark | — |
| Desktop SSH hook (WP13) | desktop workflow | desktop workflow | desktop workflow | install with WIF from the app | target host |
| Live exchange | never | never | never | WP0 / WP12 only (owner credentials) | WP0 |
| Nightly OIDC (WP11) | scheduled job only | — | — | — | — |

## Effort and gates

| Package | Est. (agent days) | Executor | Gate |
|---|---|---|---|
| WP0 | 1 (+ owner time) | controller + owner | owner credentials, NAS VM booted |
| WP1 | 2 | TS agent | — |
| WP2 | 2.5 | TS agent | WP1 (WP0 for the GitHub host, may land with the assumed default) |
| WP3 | 2 | TS agent | WP1 |
| WP4 | 4 (was 3.5: rate limits, `jti` key, rotation verdict) | TS agent | WP2, WP3 |
| WP5 | 2 | TS agent | WP4 |
| WP6 | 2 | TS agent | WP1 |
| WP7 | 3 (was 2: validate/remove, RBAC, API route) | TS agent | WP4 |
| WP8a | 4.5 (was WP8, 3) | **Claude agent** (Rust) | WP7 |
| WP8b | 2 (new) | **Claude agent** (Rust) | WP8a |
| WP9 | 3 (was 2: form instead of read-only) | TS agent | WP7 |
| WP10 | 2 (was 1.5) | TS agent / controller | WP5; final pass after WP8a, WP8b, WP9 |
| **v1 total (WP0–WP10)** | **≈ 30** (was ≈ 23.5) | | |
| WP11 (decided Q8, after core) | 1.5 | TS agent + owner | WP5, WP7 |
| WP12 (gated) | 3 | TS agent + **Claude agent** (Rust half) | ADR-005 action 2a, WP0 → spec §10.1 (outside v0.2 core, Q7) |
| WP13 (gated) | 1.5 | **Claude agent** (Rust, desktop) | WP8a, WP8b, D113 WP3/WP4 |

Total ≈ 30 agent days for v1, ≈ 36 with WP11, WP12 and WP13.

## Later packages (not estimated into the totals)

| Package | Rough size | Trigger |
|---|---|---|
| `command` identity-token source (spec §7.3) | 1.5 days | v1.1 (decided Q3) |
| Metadata sources + named egress exception (GCP, Azure IMDS / App Service) | 3 days | first cloud-VM deployment |
| Google ADC `external_account` (spec §5.4) | 2.5 days | Vertex on WIF requested |
| Entra adapter + Azure OpenAI wire profile | 4 days | Azure OpenAI requested |
| OpenAI X.509 (needs client certificates in the egress client) | 4 days | X.509 WIF leaves beta and is requested |
| `workload_identity` as a voice parent | 1 day | after v1 (decided Q9) |
| Primary-server role switch (desktop track, D113 follow-up spec) | own spec | desktop track (decided Q14) |

## Open points

- All owner questions are decided (2026-10-29): Q4 as full CLI setup parity, Q1–Q3 and Q5–Q14 as recommended
  (spec §17). No package waits for an owner answer; WP0-dependent gates (U1/U2 for WP12, U6, U8, U9) remain.
- U8 (Anthropic's Kubernetes example vs. jti-bearing tokens) is an inference until WP0; the rotation verdict and the
  local `jti` refusal (WP4) mitigate it whatever WP0 finds, only the docs numbers in WP10 depend on it.
- U7 (token-endpoint rate limits) stays undocumented; WP4 implements the defensive behaviour of spec §9.7.
- The Claude Code backend itself (ADR-005 action 2a) is outside this plan; WP12 waits for it. The primary-server role
  switch is outside this plan; WP13 provides the SSH hook it will use.
