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
the Anthropic Messages adapter; a vendor-credential deny set for every child environment; `auth.workload.*` RPC; CLI
status/test/snippet and a `1staid check` entry (Rust); a read-only web group.
**Status.** Owner decision 2026-10-29: support WIF, not urgent (v0.2 / enterprise track); personal default
unchanged. Ten owner questions (spec §17) carry recommendations; WP1–WP4 do not depend on any answer except Q1 (kind
name) and Q2 (`restartCache`, a small part of WP4). WP0 needs owner credentials and the NAS Ubuntu VM.
**Executor.** TypeScript packages: the controller's choice of agent. **Rust packages (WP8, the Rust half of WP12):
Claude agent** (owner decision 2026-10-21: Rust by Claude, not Codex). One branch and one ready PR per package
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

## Dependencies and order

```text
WP0 spike (owner time; answers U1, U2, U6, U8, U9) ──────────────────────────────┐ (informs WP2 host list, WP10 docs, WP12)
WP1 kind + validation + config keys ──► WP2 sources + pre-flight ──► WP4 mint path, ledger, classification ──► WP5 provider wiring
                                   └──► WP3 exchange adapters + JSON transport ──┘                                   │
WP6 env import + hygiene (after WP1; parallel to WP2–WP5) ───────────────────────────────────────────────────────────┤
                                                                     WP7 RPC + audit (after WP4) ──► WP8 CLI + 1staid (Rust, Claude agent)
                                                                                                └──► WP9 web read-only status
WP10 docs + ADR-005 amendment (with WP5; final pass after WP8/WP9)
WP11 optional: nightly turn-eval-live on GitHub OIDC (after WP5, WP7)
WP12 gated: Claude Code on WIF (after ADR-005 action 2a + WP0 U1/U2)
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

**Acceptance.** The record exists; WP2 adopts the observed GitHub host suffix; WP10 adopts the observed Kubernetes
numbers; WP12's gate is decided.

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

## WP4 — Mint path in `RefreshOwner`, ledger, schedule, classification (≈ 3.5 agent days)

**Files.**
- `packages/core/src/auth/refresh.ts` — record-source abstraction (existing store source; new memory source, optional
  secret-store backing for `restartCache`); `Minter` port beside `Refresher`; advisory / mandatory thresholds and
  their short-lifetime scaling (spec §9.3); "no fresh token" outcome that keeps serving and schedules a poll; denial
  backoff 30 s / 2 min / 8 min and the stop after `maxConsecutiveDenials`; resume hooks (config change, explicit test).
- `packages/core/src/auth/workload/ledger.ts` — `state/auth-workload.json`, 0600, atomic replace, vendor-scoped keys,
  prune at `exp` + 60 s, fail closed on write errors.
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
  pruning; the same token allowed once per vendor.
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

## WP7 — RPC, audit, status (≈ 2 agent days)

**Files.**
- `packages/core/src/rpc/auth-surface.ts` — additive `workload: WorkloadStatus[]` on `auth.status` and
  `auth.credentials.list`; new `auth.workload.status` (read) and `auth.workload.test` (write, one per profile per
  10 s, through the owner's flight).
- `packages/core/src/auth/credentials.ts` / `refresh.ts` — a status projection per minted profile (state, timestamps,
  last error code, scope, claims summary, ledger counts); never a token.
- RPC schema (`packages/rpc-schema`), `docs/rbac.md` (`auth.credentials.read` / `write`), regenerated `docs/rpc.md`
  and `docs/openapi.json`.
- Audit actions of spec §11 (`auth.workload.exchange`, `.blocked`, `.rotation_wait`, `.env_imported`,
  `.cache_restored`, `.test`) through `audit.append`; logs `auth.workload.*` with ids and codes.

**Tests.** RPC tests for both methods and the additive fields (role matrix, rate limit, unknown profile); an audit
test that every action carries only the listed fields; a status-payload secret scan.

**Acceptance.** Core tests and `pnpm docs:check` green; RPC schema check green.

## WP8 — CLI and `1staid check` (Rust, **Claude agent**) (≈ 3 agent days)

**Files.**
- `crates/plur1bus/src/commands/login.rs` — `login status` renders the `workload` table and passes the array through
  in `login.status/1` (additive field); new subcommand `login test <profile-id>` (`auth.workload.test`, document
  `login.test/1`, existing exit-code mapping); `--workload-identity` route for `anthropic` / `openai` with
  `--from-env`, `--rule`, `--org`, `--service-account`, `--workspace`, `--token-file`, `--github-actions`,
  `--audience`, `--provider-id`: prints the `plur1bus config set providers.<id> '<json>'` command and the needed
  `egress.allowHosts` entries, writes nothing; JWT- or key-shaped argument values refused with `value-in-argument`
  and never echoed.
- `crates/plur1bus/src/commands/firstaid.rs` — check `auth.workload` after `models.warm` in `CHECK_IDS`, reading
  `auth.workload.status` over the existing core connection, the findings table of spec §12.1 with repair hints;
  `skip` when no workload profile exists or the core is down.
- `docs/cli.md` regenerated (`pnpm docs:gen`); `docs/doctor.md` names the check.

**Tests.** Unit tests on the existing `FakeCore` / `FakeRpc` harness: status table and JSON golden output (no token
fields), `login test` result classes and exit codes, snippet output for file and GitHub sources and `--from-env`
(env injected), refusal of a JWT in `--rule`; firstaid table vectors for every finding and the fixed order; the
existing CLI secret-scan tests extended to JWTs and `sk-ant-oat01-`.

**Acceptance.** `cargo fmt --all -- --check`, `cargo clippy --workspace -- -D warnings`, `cargo test -p plur1bus`,
`node scripts/check-cli-exit-codes.mjs --check`, `pnpm docs:check` green; manual pass on the owner's Mac against a
core with a fake exchange endpoint.

## WP9 — Web: read-only status (≈ 2 agent days)

**Files.** `packages/web/src/pages/settings/sections/providers.ts` (a **Workload identity** group fed by
`auth.status`'s `workload` array and `auth.workload.status`; a **Test** button for Owner/Admin calling
`auth.workload.test`; no sign-in, logout or secret field), `packages/web/src/i18n/providers.ts` (DE with *du*, EN),
the mock server's `auth.*` fixtures, `packages/web/scripts/gen-settings-index.mjs` output.

**Tests.** Component tests (states, badges with text, role gating of the button, no token-shaped strings rendered);
Playwright against the mock server in DE/EN light/dark; `node scripts/check-i18n.mjs`.

**Acceptance.** Web unit and browser tests green; settings index check green.

## WP10 — Docs and ADR-005 amendment (≈ 1.5 agent days)

**Files.** ADR-005 amendment (spec §18 row 1); `docs/auth-engine.md` (kind, sources, ledger, schedule, error table);
`docs/openai-auth.md` (`federated_token` vs `workload_identity`, `workload.ts` moved); `docs/egress.md` (hosts);
`docs/containers.md` (Kubernetes example: projection `audience`, `expirationSeconds: 600`, a security context that
makes the token readable for uid 10001 per WP0, the env-import variant); narrow rule recipes per source (GitHub
exact ref, Kubernetes exact service account with audience); a DE/EN user-guide template in the PR body
(`docs/user/` has its own owner).

**Acceptance.** `node scripts/check-doc-links.mjs`, `node scripts/lint-hygiene.mjs`, `pnpm docs:check` green.

## WP11 — Optional: nightly `turn-eval-live` on GitHub OIDC (≈ 1.5 agent days, owner Q8)

**Files.** `.github/workflows/nightly.yml` (`permissions: id-token: write` on `turn-eval-live` only; the secrets step
replaced by writing a `workload_identity` profile with the `github_actions` source and the egress hosts into the
eval home), `scripts/eval/turn-eval-secrets.ts` (profile writer instead of key import, keeping the OpenAI refusal),
`docs/turn-eval.md`.
**Owner steps.** Console: GitHub issuer, rule per spec §13 (exact ref, owner claim, workflow pin, audience,
`workspace:inference`, 600 s), a dedicated workspace with a spend limit; repository variables for the IDs.
**Acceptance.** `actionlint` and the workflow-pin gate green; two green scheduled runs without the secret before
`ANTHROPIC_API_KEY` is removed from that job (the other two live jobs keep it).

## WP12 — Gated: Claude Code on WIF (≈ 3 agent days; Rust half by **Claude agent**)

**Gate.** ADR-005 action item 2a (the Claude Code backend exists on `main`) and WP0 answering U1 (or U2 for the
fallback). Not part of the v0.2 core scope (owner Q7).

**Files.** The Claude Code backend's child builder (deny set, `--settings` with `apiKeyHelper`,
`CLAUDE_CODE_API_KEY_HELPER_TTL_MS=60000`); `crates/plur1bus/src/commands/auth.rs` (new hidden `auth token-helper`:
reads `PLUR1BUS_TOKEN_HELPER_HANDLE`, asks the core over the local socket, prints the token to stdout only);
`packages/core/src/rpc/` internal method for session-bound handles (create on session start, revoke on end, rate
limit, never on the public RPC list); docs of the accepted residual risk (spec §10).

**Tests.** Child-environment test (no `ANTHROPIC_*` credential variable present); handle lifecycle (revoked after
session end, wrong profile refused, rate limit); helper output never logged; an integration test with a fake
`claude` binary that runs the helper and records the header it would send.

**Acceptance.** Tests green; owner manual run against the test organisation.

## Test matrix

| Area | Linux CI (x64, arm64) | macOS CI | Windows CI | Owner Mac (aarch64) | NAS Ubuntu VM (k3s) |
|---|---|---|---|---|---|
| Profile validation, adapters, ledger, schedule (WP1–WP4) | gate (unit) | — | unit (paths) | `pnpm test` | — |
| File source rotation (symlink swap) | gate | — | skipped (POSIX symlink semantics), absolute-path parsing tested | real swap with a script | real projected volume (WP0) |
| GitHub source | fake endpoint | — | — | fake endpoint | — |
| Provider wiring (WP5) | gate | — | — | fake exchange + fake Messages | — |
| Child environments (WP6) | gate | — | exec / MCP env on Windows | — | — |
| CLI + 1staid (WP8) | gate (Rust) | Rust tests | Rust tests | manual pass | — |
| Web (WP9) | gate (unit, browser) | — | — | visual DE/EN light/dark | — |
| Live exchange | never | never | never | WP0 / WP12 only (owner credentials) | WP0 |
| Nightly OIDC (WP11) | scheduled job only | — | — | — | — |

## Effort and gates

| Package | Est. (agent days) | Executor | Gate |
|---|---|---|---|
| WP0 | 1 (+ owner time) | controller + owner | owner credentials, NAS VM booted |
| WP1 | 2 | TS agent | Q1 |
| WP2 | 2.5 | TS agent | WP1 (WP0 for the GitHub host, may land with the assumed default) |
| WP3 | 2 | TS agent | WP1 |
| WP4 | 3.5 | TS agent | WP2, WP3; Q2 for `restartCache` |
| WP5 | 2 | TS agent | WP4 |
| WP6 | 2 | TS agent | WP1 |
| WP7 | 2 | TS agent | WP4 |
| WP8 | 3 | **Claude agent** (Rust) | WP7 |
| WP9 | 2 | TS agent | WP7 |
| WP10 | 1.5 | TS agent / controller | WP5; final pass after WP8, WP9 |
| **v1 total (WP0–WP10)** | **≈ 23.5** | | |
| WP11 (optional) | 1.5 | TS agent + owner | WP5, WP7; Q8 |
| WP12 (gated) | 3 | TS agent + **Claude agent** (Rust half) | ADR-005 action 2a, WP0 U1/U2; Q7 |

Total ≈ 23.5 agent days for v1, ≈ 28 with WP11 and WP12.

## Later packages (not estimated into the totals)

| Package | Rough size | Trigger |
|---|---|---|
| `command` identity-token source (spec §7.3) | 1.5 days | owner Q3 → v1.1 |
| Metadata sources + named egress exception (GCP, Azure IMDS / App Service) | 3 days | first cloud-VM deployment |
| Google ADC `external_account` (spec §5.4) | 2.5 days | Vertex on WIF requested |
| Entra adapter + Azure OpenAI wire profile | 4 days | Azure OpenAI requested |
| OpenAI X.509 (needs client certificates in the egress client) | 4 days | X.509 WIF leaves beta and is requested |
| `workload_identity` as a voice parent | 1 day | owner Q9 |

## Open points

- Owner questions Q1–Q10 (spec §17) are open; the recommendations are the plan's defaults.
- U8 (Anthropic's Kubernetes example vs. jti-bearing tokens) is an inference until WP0; nothing in WP1–WP5 depends
  on its answer, only the docs numbers in WP10.
- The Claude Code backend itself (ADR-005 action 2a) is outside this plan; WP12 waits for it.
