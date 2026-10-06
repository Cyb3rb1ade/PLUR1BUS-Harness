# M2 Secret store — implementation plan

**Goal.** One secret store for the core: OS keyring first (`@napi-rs/keyring`, dynamically loaded), an encrypted-file
fallback behind a config flag, short-lived revocable leases for the engine, an audit event per access, `secret.*` RPC
for the owner only, and `plur1bus secret status|set|get|rm|ls`. No secret value ever reaches a log, a `--json`
document (other than an explicit `get --reveal`), an error message or the audit log.

**Authority.** ADR-005 §"Secret storage" and action items 5, 6, 8; ADR-004 (secret writes owner/admin only); `docs/milestones.md`
M2 scope "Secret store" and acceptance 8; `docs/phase0/decisions-for-owner.md` B19 (ADR-005 Q3); `docs/platform-matrix.md` §2.

**Out of scope.** The auth engine (profiles, OAuth, pools), per-user credentials (ADR-005 Q5), the desktop shell's own
`secrets.rs` (apps/desktop, hands off), importer `--migrate-secrets` (M7 consumes this API later), a passphrase key mode,
GUI. D111 log-schema events (the package is another session's) — the audit line is the record for now.

## Design

```
packages/core/src/secrets/
  types.ts           SecretName rules, SecretPrincipal, SecretMeta, SecretError (closed code set, no values in messages)
  backend.ts         SecretBackend interface + probe result
  memory-backend.ts  in-memory test backend (ADR-005 action 5: "in-memory-test backend")
  keyring-backend.ts @napi-rs/keyring behind an injected loader; names index kept as one keyring entry (keyring cannot enumerate)
  file-backend.ts    AES-256-GCM, per-entry 96-bit random nonce, AAD binds schema+name, atomic write, 0600 / private ACL
  leases.ts          lease table: id, TTL (cap 5 min), revocable, revoked on set/delete of the same name, injected clock
  audit.ts           AuditSink; file sink appends the same line shape as crates/plur1bus/src/audit.rs to logs/audit.log
  store.ts           createSecretStore: selection, status, set/get/delete/list, leases, audit-before-release
  rpc.ts             secret.status|set|get|delete|list handlers (owner only)
  index.ts
```

* **Selection.** `keyring` when its probe succeeds; else `file` when `secrets.fileFallback.enabled` is true; else `none`
  (every value operation answers `E_NOT_AVAILABLE`, reason `no-backend`, with the remedy in the message). Reads look in the
  selected backend first and then in the other available one, so a keyring that appears later does not hide file entries;
  writes go to the selected one; delete removes from every available backend. Status reports which and why.
* **Principals.** `owner`, `core` (in-process, the engine lease path) and `agent`. Value operations and `secret.*`: owner
  only. Leases: owner or core. Anything else, and any unknown kind, is `denied` (fail closed), and the attempt is audited.
* **Audit before release.** `set|get|delete|lease|list|denied` write the audit line first; when it cannot be written the
  operation fails and no value is released (RULING R4).
* **Redaction.** Backend and OS errors are reduced to a code before they leave the backend; the store never interpolates a
  value; the file backend's decrypt failure carries no ciphertext. A marker-value test covers every output.
* **Tamper.** Any GCM failure, malformed entry, wrong schema, or key file that is missing while entries exist is
  `corrupt` and never returns a partial or empty value; the key is never regenerated over existing entries.

## Rulings (taken from the docs, listed in the PR)

* R1 (ADR-005 Q3 / B19): the encrypted file's key is a **machine-bound key file** (`state/secrets/store.key`, 32 random
  bytes, 0600/private ACL, created once with `wx`); the passphrase mode named by B19 is not built. The fallback is behind
  `secrets.fileFallback.enabled`, **default `false`** until the owner decides.
* R2 (ADR-004 "write-only through the API" vs the task's `get --reveal`): value release is owner-only, explicit
  (`reveal: true`), audited, and the only RPC that returns a value; there is no `secret.lease` over RPC.
* R3: `secret.*` is additive and carries `x-since: 1.5.0` with no RPC version bump (no version bumps in this task); the
  owner bumps to 1.6.0 at merge if 1.5.0 has been released.
* R4: no audit line, no value.
* R5: test seam `PLUR1BUS_SECRETS_KEYRING=off|memory` (only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`) so no test can reach a
  real keychain; the real loader runs only when the seam is absent.

## Tasks

1. This plan (first commit).
2. `secrets/` core: types, memory backend, file backend, leases, audit, store — tests first.
3. Keyring backend with an injected fake module; the `@napi-rs/keyring` optional dependency (MIT, exact pin).
4. RPC schema (`secret.*`, `$defs`), `pnpm gen`, `rpc.ts`, core wiring, config key `secrets.fileFallback.enabled`
   (`x-restart: live`, `x-tier: advanced`), principal hook, owner-only tests.
5. Rust CLI `secret status|set|get|rm|ls` (`commands/secret.rs`, `--json` ids `secret.status/1`, `secret.set/1`,
   `secret.get/1`, `secret.rm/1`, `secret.ls/1`), value from stdin only, `docs:gen`, AGENTS.md/CHANGELOG/docs.
6. System test over the real core and CLI (file backend, keyring seam off), including the redaction sweep.
7. Full gate, PR.

## Acceptance → test

| Acceptance | Test |
|---|---|
| Round trip in both backends | `test/secrets/backend-contract.test.ts` (one contract run over memory, file, keyring-with-fake-module) |
| Lease expiry with a fake clock; revocable; TTL cap; revoked on rotate/delete | `test/secrets/leases.test.ts` |
| Fallback selection and status | `test/secrets/store.test.ts` (keyring up / down × flag on / off, read-through, status text) |
| Tampered ciphertext fails closed | `test/secrets/file-backend.test.ts` (flip a byte of ct/tag/nonce, swap two entries, drop the key file, truncate) |
| Redaction: marker value in no log, no `--json`, no error | `test/secrets/redaction.test.ts` (unit, every sink and error path) and `tests/system/secrets.test.ts` (real core and CLI; sweeps `logs/`, `state/`, every CLI output but the explicit reveal) |
| Agent principal refused | `test/secrets/rpc.test.ts` (every `secret.*` method and the store API with an agent and an unknown principal; audited) |
| Audit per access, no values | `test/secrets/audit.test.ts`; audit-failure blocks release in `store.test.ts` |
| Atomic write, private mode | `file-backend.test.ts` (no partial file after an injected rename failure, mode 0600 on POSIX) |
| CLI surface and docs | `crates/plur1bus/tests/secret_cli.rs`, `pnpm docs:check` |
