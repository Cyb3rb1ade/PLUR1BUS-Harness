# M3 Phase 3 — WebAuthn, account bootstrap and security UI

## Inventory

`packages/api/src/webauthn.ts` owns bounded CBOR/COSE and WebAuthn verification. `webauthn-routes.ts` owns six explicit route classifications, challenge state and account integration. `bootstrap.ts` owns private startup proof files. AccountStore schema version 2 adds passkeys and the durable bootstrap marker. The standalone API initializes bootstrap before listening. Login, wizard and Settings → Security use genuine HTTP routes, with DE/EN strings and accessible labels.

Generated OpenAPI, API surface and both bundled help catalogues were regenerated. No dependencies, engine source or existing RPC_RULES changed.

## Decisions

Only definite-length canonical CBOR is accepted: 16 KiB input, depth 8, 256 total items, 32 map entries, 64 array entries, no duplicate scalar keys. ES256/P-256 and Ed25519 are the only COSE algorithms. Discoverable credentials are required so public assertion options do not enumerate credential IDs. Requested attestation is `none`; packed self attestation is also verified. Certificate-backed attestation and authenticator extensions are deliberately refused; this feature authenticates the holder, without claiming hardware provenance.

Every assertion requires user presence and user verification, then a signature before checking the counter. Non-zero counter rollback/repetition is refused and audited; zero-counter authenticators remain valid. Successful assertions update counters with compare-and-swap, without invalidating unrelated live sessions. Credential registration, rename and removal do invalidate sessions through account versions.

Challenges expire after five minutes, are bounded to 256 pending ceremonies, and are spent on the first submission, including failed submissions. They bind the account version, exact origin and RP ID. The configured `webauthnOrigin` wins when set; otherwise the options bind the request Origin already checked against the listener allowlist. Local browser passkeys use `localhost`, since Chromium rejects IP literals as RP domains.

Bootstrap uses a distinct random proof, with SHA-256 persisted and a fifteen-minute expiry. Creating the Owner account and consuming the proof form one SQLite transaction. Cleanup occurs after commit; even an interrupted cleanup cannot revive the proof. Startup deletes consumed proof files. Expired unconsumed proofs rotate on local restart. `PLUR1BUS_OWNER_INSTALLED=1` marks the bundled installer path permanently consumed; it does not invent a credential or account. Installer account creation still belongs to Host-Addons. An existing Owner password account disables reusable Owner-token login, including for migrated installations.

## Threat table

| Attack | Protection | Test |
|---|---|---|
| Startup proof stolen by another OS user | Private directory, regular file, ownership, 0600 / secure-path ACL; redacted notice only | bootstrap permission/symlink tests |
| Duplicate bootstrap submission or restart after creation | Atomic account + consumed marker; consumed marker cannot be reinitialized | HTTP concurrent proof submission; durable account-store reopen |
| Origin/RP substitution | Exact ceremony binding, RP hash, UP/UV mandatory | ES256 and Ed25519 signed vectors, wrong-origin and wrong-RP tests |
| Challenge replay | Consume before validation, account version and TTL | HTTP replay |
| Key cloning | Signature checked first, counter must advance when non-zero, audit clone warning | signed rollback vectors and HTTP rollback |
| Parser memory/stack exhaustion | Byte/depth/item/length bounds and controlled rejection | 5,000 deterministic fuzz inputs, malformed UTF-8/null/duplicate-map/indefinite-length cases |
| Forged authenticated route request | Existing authorize()/CSRF/rate/audit path and explicit my.read/my.write classifications | generated deny/auth/minimum-role sweep and real HTTP negatives |
| Old sessions after credential change | Transactional account version bump and server-side revocation hook | durable store versions and real browser registration/sign-out |

## Behavior changes

Native/VPS users can reach the account wizard while anonymous. The one-time proof creates the account; the UI then signs in with its password and clears all sensitive fields. It never stores proof or password in browser storage. Bundled mode skips the account step as before.

Passkeys and TOTP can be managed in Security. Login supports direct UV-required passkey authentication and password → WebAuthn second factor. TOTP backup codes remain visible once in the current component after confirmation, before navigating away. Key changes require signing in again. Reusable Owner-token login stops when an Owner password account exists.

## Owner questions

No dependency exception requested. The fifteen-minute bootstrap expiry and five-minute WebAuthn challenge expiry are implementation defaults. `none`/packed self attestation meets account authentication without certificate provenance; enterprise attestation remains a follow-up. Installer creation of the actual bundled Owner account is outside this repository; only the explicit consumed flag is wired here. OIDC remains after M3.

## Conflict hotspots

API `routes.ts` and `server.ts` wiring, audit action registry, account-store startup, generic auth/OpenAPI route-table tests and generated OpenAPI/API surface. Phase 1 adds chat/WS entries to these same route-table tests; normal merges must retain both explicit classifications. Phase 2 must configure the public HTTPS origin for tailnet/network and use enrolled passkeys for remote MFA.

## Validation

Frozen lockfile installation succeeded. Node 24.21.0 toolchain check passed. Root lint including full build/typecheck, hygiene, i18n and 99 tooling tests passed. The entire API suite ran 671 tests: 662 passed, 0 failed, 5 skipped, 4 pre-existing todos. Subsequent bootstrap collision/status changes passed their 16-test targeted sweep (15 passed, one existing todo). Focused bootstrap, verifier and account persistence tests passed.

Genuine browser bootstrap and navigator.credentials.create/get with a Chrome CTAP2 virtual authenticator passed over real HTTP; it also proves credential-change session expiry, passkey login and counter advancement. Related login, security and wizard regressions ran 44 tests: 43 passed, and an introduced link target-size violation failed the login axe test. The link was corrected with the existing button class; the affected login-hardening suite and real API browser test then passed all ten tests on Node 24.21.0. The final resident-key-required browser flow and final typecheck passed. Physical authenticator interoperability remains an explicit KNOWN GAP todo.

The cached Playwright browser was incomplete; local validation used installed Google Chrome through PLUR1BUS_CHROMIUM. No CI polling. Bundled installer account creation is not claimed by virtual-authenticator tests and belongs to Host-Addons. Existing error-code HTTP mapping todos remain outside this phase. Logs: `/tmp/m3-p3-api-node24.log`, `/tmp/m3-p3-node24-lint.log`, `/tmp/m3-p3-node24-browser.log`, `/tmp/m3-p3-final-targeted.log`, `/tmp/m3-p3-last-browser.log`.
