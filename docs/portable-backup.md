# Portable encrypted backup / portables verschlüsseltes Backup

The ordinary `plur1bus backup` archive never reads the secret store (keyring, encrypted fallback file, `run/`) and replaces a
webhook secret kept in `config.json` by a placeholder (a restore draws a fresh one). It does contain the API account database
`state/api/accounts.db`, with password hashes, TOTP seeds and token hashes, and it is not encrypted. For M8 full-state recovery,
`scripts/release/portable-backup.mjs` wraps that verified archive and owner-readable vault values in
one encrypted `.p1backup` file. Release payloads also ship `portable-backup.mjs` beside `core.js`.
No engine or secret-backend changes are required. Node 24.21 and the candidate CLI are required.

```sh
node scripts/release/portable-backup.mjs create \
  --bin /absolute/path/to/plur1bus --home /absolute/source-home \
  --file /absolute/backup.p1backup --passphrase-file /absolute/private-passphrase
node scripts/release/portable-backup.mjs verify \
  --bin /absolute/path/to/plur1bus --home /absolute/source-home \
  --file /absolute/backup.p1backup --passphrase-file /absolute/private-passphrase
node scripts/release/portable-backup.mjs restore --dry-run \
  --bin /absolute/path/to/plur1bus --home /absolute/installed-target-home \
  --file /absolute/backup.p1backup --passphrase-file /absolute/private-passphrase
```

Remove `--dry-run` to restore. **The target must already be installed and running**, including a usable
secret backend. Stores/config/users/API accounts/sessions/dream ledger come from the ordinary archive;
vault values are reinserted through owner-only `secret set` using stdin. Target-only secrets are removed,
so the vault has the backed-up names and values. Existing owner authorization remains mandatory.

Passphrase input is a regular non-symlink file, 0600 on POSIX, at least 16 bytes; exact bytes count,
including a trailing newline. Keep it separately from the archive. On Windows use a private user/SYSTEM
ACL for that file; the script does not itself verify Windows ACLs. Values are never command arguments,
environment variables, plan fields or logs. The encrypted artifact uses AES-256-GCM, random salt and
nonce, scrypt N=32768/r=8/p=1, and authenticated format headers. State bytes stream to/from disk; the
vault (up to 16 MiB) is held in memory. This is not a new backup retention or scheduling service.

The complete ciphertext must authenticate before the target home is changed. A restore first creates
an encrypted `<file>.rollback-<random>` backup of the target; failures attempt to restore its ordinary
state and vault. Keep that recovery artifact, including after success, until recovery is accepted.
A failed rollback requires recovery from that artifact; the CLI deliberately suppresses raw child output.
An interrupted process during a portable restore still needs operator recovery from that artifact;
portable orchestration is not a crash-atomic transaction over the OS keyring and all databases.

Create dry-run computes a real verified snapshot in private temporary storage and reads the vault;
it emits the same units/secret-name plan without publishing an encrypted archive. Restore dry-run
authenticates/verifies the archive and emits that plan without stopping the target or changing its data.
Both can produce normal owner/audit read events. Quiesce application writes during backup/restore:
individual SQLite snapshots are WAL-safe, but there is no global transaction across the app databases
and an external OS keyring. Concurrent vault changes during create fail closed.

**Nachweis:** `tests/system/portable-backup.test.ts` prüft Memory-Store, Config, verschlüsselte Vault-Werte,
Identity/Admin-Users, den API-Kontospeicher aus #490, Sessions und Dream-Ledger, inklusive identischem
Dry-Run-Plan. Die Crypto-Tests prüfen falsche Passphrasen, Manipulationen, Überschreiben und Rückrollen
nach fehlgeschlagenem Vault-Import. Lokal wurde der Fallback unter macOS getestet; echte Keyring- und
native Windows/Linux-Nachweise bleiben offen. Audit- und Lizenz-Gates bleiben unabhängig davon nötig.
