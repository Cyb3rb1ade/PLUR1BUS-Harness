# API accounts and person status — 2026-10-14

Branch: `codex/api-accounts-1014`. Foundation: freshly fetched `origin/main` plus an initial normal merge of `origin/codex/web-transport-1014`. PR #468 merged during completion; a subsequent normal merge includes main at `9171bc29`, including the newer security/consistency fixes. The final PR no longer has an unmerged transport dependency.

## Inventory and decisions

- `AdminStore` (`state/admin.sqlite`) owns persisted person role presets and agent rights; `rpc/admin-surface.ts` implements `user.role.set`. Core collaboration resolves project membership from its own project store.
- Shareable invites use `identity/invite-token.ts` and `AdminStore.redeem`; only a SHA-256 token hash persists, and consumption is transactional/audited. Invitation creation already creates the Core human and role row. Redemption links credentials to that existing person. `identity/codes.ts` and `identity/service.ts` retain the independent channel pairing-code flow; channel pairing codes are not web account credentials.
- `module-api` exports no SQLite binding. The existing Node `node:sqlite` binding used throughout Core supplies the API store without dependencies.
- #468 supplies per-session streams, live directory checks, `rightsChanged`, delegated RPC and replay invalidation. A new connection-targeted `api.account.changed` notification reaches only API service connections, including changes made through local IPC. A five-second synchronizer provides reconnection fallback.
- The schema had no `user.disable`, `user.enable` or `user.remove`. This package adds disable/enable only, plus internal API service resolve/validate methods. RPC fixtures and Rust parity tables cover the additions.
- All four confirmed Owner decisions are implemented: accepted same-OS-user boundary; credentials-only account store; authoritative Core status; cookie authentication grants no human trust or browser OS confirmation. WebMCP still excludes user/admin methods.

## Resulting behavior

`state/api/accounts.db` holds normalized usernames, one Core person per password account, Argon2id PHC hashes, TOTP records/backup hashes, personal token hashes, versions and timestamps. It uses WAL/user_version, private modes and the existing platform permission helper. It persists no role, object rights or disabled flag. Core authority is joined per use. Password verification precedes Core status lookup; missing/disabled people receive the ordinary invalid-credentials response.

Registration validates the invitation before disclosing username collisions, reserves pending credentials, consumes the one-time Core invitation, and activates the account. It never logs in automatically. The optional bootstrap account requires the current bootstrap proof, live Owner role, bootstrap session and CSRF; it links exactly once to `local-owner`. TOTP uses existing enrollment/login flows and survives restart; enrollment does not end a session before confirmation, and replay-counter updates do not invalidate fresh login sessions.

Core disable/enable preserve role and rights, enforce the role matrix and last-active-Owner invariant, strip control/bidi characters from bounded reasons, and audit hashed principals. Disabled people resolve to null for recurring jobs; jobs skip and disable as before. API sessions, SSE streams and replay end; old tokens remain revoked after enable. Tokens carry the Core issuance revision, preventing revival even after disable/enable while the API was down. A fresh login is required.

The login page retains bootstrap token sign-in and adds password sign-in plus the existing TOTP/backup-code challenge; credentials and challenge IDs stay out of browser storage. The Join page accepts `#/join`, `?code=` and existing `#/invite/<token>` links; it locks duplicate submission, renders fixed DE/EN errors, removes the code using `history.replaceState`, and links to login after success. Settings → Users confirms status changes, locks duplicate requests and shows the disabled badge. User docs and the Help bundle were regenerated.

## Threat model supplement

See `docs/security.md`, “Browser transport threat model → Known boundary: same OS user.” A same-user process can read the 0600 delegation token and impersonate the API, as with existing local IPC. Separate service OS users are today's operational isolation; stronger API/Core separation, broker or attestation is deferred. Service notifications cannot reach ordinary IPC/browser subscribers through the new exception.

## Owner questions and known limitations

- No mandatory-TOTP configuration exists. TOTP remains optional. A future Owner decision/configuration is needed to mandate it for Owner/Admin; no key was invented.
- KNOWN GAP: channel inbound ignores `person.disabled`. The switchboard belongs to the parallel security package and was not edited; a named TODO test records this.
- If invitation consumption succeeds but account activation fails, the pre-existing Core person remains and an `invitation.account.failed` audit event records the failure. Pending credentials are removed; the consumed one-time invitation is not recovered automatically. An administrator must issue a new invitation. The redeem step creates no orphan person.
- Existing unrelated TODO/skipped tests remain, including the global API session cap and external/native acceptance. No CI polling or merge to main is performed.

## Conflict hotspots and validation

Additive edits touch Core's admin store/surface, resolver and RPC guard, API server/login/delegation, shared notification delivery, RPC schema/parity fixtures, Web auth routing and Users section. Existing security fixes must be preserved during merges; new account logic lives in its own files. Engine pins and committed lockfiles are unchanged.

Focused checks passed for real API/Core invitation-login-disable-enable (including local IPC change notification), permanent token revocation, session/SSE termination, storage uniqueness/modes/corruption, password-before-status ordering, TOTP restart/replay behavior, role matrix/audit, recurring-job inactive behavior, and Chromium Join/Users double-submit guards. The real Chromium acceptance also completes invitation → Join → password login → Users disable/enable against an actual API/Core/Supervisor with the durable store, without HTTP/RPC mocks. Rust workspace tests, Clippy and formatting passed. A broader browser failure in `voice-b20.test.ts` (download completing before the language-set answer applies twice) reproduces on a separate `origin/main` checkout; it is outside this package and is not weakened or changed. Final broad-package/lint/docs results are recorded below.

Final broad validation (after merging `origin/main` at `16998cca`): `pnpm test` ran 15,562 Node tests: 15,311 passed, one failed, 50 skipped and 200 existing/new TODO cases. The single failure is the independently reproduced baseline Voice race above. All other workspace packages passed; Core 8,333 tests and API 653 tests had zero failures. Subsequent focused checks cover the completed password/TOTP UI, the closed user-list response, legacy persons without an explicit preset row, and activation-failure auditing. The forced real Chromium account acceptance passed without mocks. `cargo test --workspace`: 2,067 passed, zero failed, 16 ignored; Clippy, cargo fmt, lint/typecheck and docs checks passed. Engine pins and lockfiles are unchanged. No CI polling.

After the final normal merge of main at `9171bc29`, 1,534 focused tests covering API, Core administration/jobs/RBAC, schema, service notifications, WebMCP and forced Chromium account flows passed with zero failures (1,405 passed, four skipped, 125 TODO). Lint/typecheck and docs checks passed again on that source. The final Rust workspace check against the updated explicit-value type generator passed: 2,087 passed, zero failed, nine ignored; Clippy and cargo fmt passed.
