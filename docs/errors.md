# CLI exit codes and error codes

Every failing `plur1bus` command writes one error and exits non-zero. With `--json` the error is a document on stdout
(`schema: "error/1"`, with `error` set to the code below, `message`, and optional `reason`, `detail` and `ids`); without
it, `plur1bus: <message>` goes to stderr (bold red on a colour terminal, see `--color` and `NO_COLOR` in
[cli.md](cli.md)). A script should branch on the exit code or on `error`, never on the message text.

`tests/docs_consistency.rs` keeps this page and the Rust sources in step: every `E_*` code in `crates/*/src` is listed
below and every code listed below exists in the sources. The exit code of an error code is decided in ONE place,
`output::exit_code_for`; `Out::fail`, `ext::Failure::exit` and `BackupError::code` all ask it, `output::tests` keeps the
Exit column in step with it, and `tests/cli_surface.rs` fails when a command passes a literal exit code for a code in
the table.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Success. A `--check`-style command that found nothing wrong also exits 0. |
| 1 | The command ran and failed (any error code not listed with another exit below), or a real write error lost the output (a closed pipe does not count). |
| 2 | The command was refused before it did any work: `E_INVALID_PARAMS` (a usage or input error: an unknown flag, a missing or malformed argument, a missing `--yes`, also a request the core rejected), `E_NOT_AVAILABLE` (not possible here; also every milestone stub), `E_APPROVAL_REQUIRED` (an approval is needed first) or `E_CANCELLED` (a confirmation prompt was answered no). Nothing was changed. clap's own usage errors exit 2 as well, before any command runs. |
| 3 | `E_LOCKED`: the store or the home is held by another process (also `supervise` when a supervisor already runs or the lock is held and no supervisor answers). Retry later. |
| 70 | Internal: the supervisor ended on a panic. Only seen from `plur1bus supervise` (the OS service), never from an interactive command. |
| 130 | Interrupted by a signal or Ctrl-C. `plur1bus login` reports it as `E_CANCELLED`, `reason=login-cancelled` (the login was cancelled and nothing was saved); `acp serve` and `core run` end with 130 when their child process was ended by a signal and left no exit code. |
| 1..255 | `plur1bus import` passes through the exit code of the importer (`E_IMPORT_FAILED` and the importer's own errors), 1 when it names none. |

## Error codes

The RPC codes below are the closed set of the RPC schema ([rpc.md](rpc.md#error-codes)); the CLI reports the code
the core sent. The last two are raised by the CLI itself.

| Code | Exit | Meaning |
|---|---|---|
| `E_UNAUTHORIZED` | 1 | The local endpoint refused the token, or the endpoint is not trusted (wrong owner, writable by others, peer mismatch). |
| `E_RPC_VERSION` | 1 | The core or supervisor speaks an RPC version this CLI does not. |
| `E_NOT_AVAILABLE` | 2 | The command or feature is not available here: a milestone stub, a container-managed install, a missing prerequisite. |
| `E_CORE_UNAVAILABLE` | 1 | The core could not be reached (not running, not ready, socket missing). Start it with `plur1bus daemon start`. |
| `E_INVALID_PARAMS` | 2 | The input was refused: a usage error of the CLI or request parameters the core rejected. Nothing was changed. |
| `E_AGENT_EXISTS` | 1 | The agent name or data directory already exists. Use import `--on-conflict rename`. |
| `E_AGENT_RIGHTS` | 1 | Invalid recipient/right or delegation above the caller; `detail` identifies the field. |
| `E_AGENT_SECRETS_MISSING` | 1 | Required target secrets are absent; `ids` lists names only. Provision them and retry. |
| `E_AGENT_UNKNOWN` | 1 | The named agent is not registered. |
| `E_CONFIG_INVALID` | 1 | A configuration value or file does not validate against the schema. |
| `E_MODULE_UNKNOWN` | 1 | The named module does not exist. |
| `E_VOICE_BUDGET` | 1 | Voice feature budgets exceed `voice.v3.budgetMs`; `detail` and `ids.feature` identify the first overflowing switch, `ids.totalMs` and `ids.budgetMs` give the totals. Nothing is saved. |
| `E_VOICE_LICENSE` | 1 | `voice.models.install` needs explicit `licenseAccepted: true` for the model's current research-only, non-commercial or unconfirmed licence. No download starts. |
| `E_VOICE_LICENCE` | 1 | The canonical UI's `voice.language.set` needs the exact `modelId@licenceId` in `acceptLicences`. No download starts until all selected model licences are accepted. |
| `E_VOICE_UNAVAILABLE` | 1 | A verified model package, realtime provider, capacity or trusted audio transport is unavailable. Raw provider errors are withheld. |
| `E_INTERNAL` | 1 | An unexpected failure inside the CLI or the core. |
| `E_LOCKED` | 3 | The store or a lock is held by another process. |
| `E_NOT_FOUND` | 1 | The named object (entry, session, extension, ...) does not exist. |
| `E_DENIED` | 1 | Policy or permissions refuse the operation. |
| `E_APPROVAL_REQUIRED` | 2 | The operation waits for an approval or an acknowledgement (`reason` says which). A script must not treat it as success. |
| `E_CONFLICT` | 1 | The operation conflicts with the current state (name taken, concurrent change). |
| `E_PROJECT_WIP_LIMIT` | 1 | The active-card count would exceed the target column WIP limit. The whole board mutation rolls back; a human with project manage may explicitly request `overrideWip`. |
| `E_INBOX_CURSOR` | 1 | An `inbox.list` cursor is malformed (`reason: inbox-cursor`). Start again without a cursor. |
| `E_INVITE_INVALID` | 1 | An invitation link cannot be redeemed. It is unknown, expired, revoked, used or malformed, and the answer never says which ([invites.md](invites.md)). |
| `E_STORAGE` | 1 | A storage operation failed; `ids` may carry the ids needed to recover a half-finished step. |
| `E_MEDIA_CAPABILITY` | 1 | The media index's provider or model cannot handle the modality (for example OpenAI embeddings in the media index). |
| `E_MEDIA_LICENSE` | 1 | The licence of the media model has not been confirmed (for example a non-commercial licence). |
| `E_MEDIA_PRIVACY` | 1 | The privacy pin is set and a cloud provider is configured for the media index; no request was sent. |
| `E_MEDIA_UNAVAILABLE` | 1 | The media model is not installed, its key is missing, or the engine has no media index. |
| `E_MEDIA_DIMENSION` | 1 | The query and the indexed documents differ in dimension, or the model does not support the configured dimension. |
| `E_MEDIA_UNSUPPORTED_KIND` | 1 | The medium cannot be processed (decoder or frame extractor missing, format unknown). |
| `E_IMPORT_FAILED` | 1 | `plur1bus import` could not run or finish the importer (`reason`: `importer-missing`, `node-unavailable`, `importer-crashed`). The importer's own errors keep the exit code it reports. |
| `E_CANCELLED` | 2 | The user declined a confirmation prompt (`config apply`, `module`, `secret remove`, `memory forget`, `media reindex`, `ext`, `update apply`: `reason=declined`); nothing was changed. `plur1bus login` ended with Ctrl-C reports it with exit 130 (see above). |

## Sign-in reasons (`plur1bus login`)

`plur1bus login` adds no error code; it reports the closed codes above with a `reason` (see [openai-auth.md](openai-auth.md#cli-and-rpc-login) for the full table). A script should branch on these:

| `reason` | Code | Exit | Meaning |
|---|---|---|---|
| `value-in-argument` | `E_INVALID_PARAMS` | 2 | A key was typed as an argument; it is not echoed. Treat it as exposed and rotate it. |
| `provider-required`, `unknown-provider`, `unsupported-route`, `invalid-name`, `value-from-stdin`, `stdin-unreadable` | `E_INVALID_PARAMS` | 2 | Usage: nothing was sent to the core. |
| `state-mismatch`, `access-denied`, `scope-denied`, `id-token-invalid` | `E_DENIED` | 1 | The sign-in did not verify or was declined; nothing was saved. |
| `login-timeout`, `login-cancelled`, `port-in-use` | `E_CONFLICT` | 1 | The sign-in ended without a credential. |
| `login-cancelled` | `E_CANCELLED` | 130 | Ctrl-C during the sign-in; the login was cancelled in the core. |
| `login-unknown`, `credential-unknown`, `auth-required` | `E_NOT_FOUND` | 1 | No such pending login or saved sign-in. |

## Channel reasons (`plur1bus channel`)

`plur1bus channel` adds no error code; it reports the closed codes above with a `reason`. A script should branch on these:

| `reason` | Code | Exit | Meaning |
|---|---|---|---|
| `secret-value` | `E_INVALID_PARAMS` | 2 | A `*Secret` key was given something other than a secret name: a value that looks like a credential, or any text outside the name format (`[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}`). The CLI refuses it before the core is called, so nothing is sent; the core refuses it too and stores nothing. A value is never echoed, stored or logged. A credential-shaped value is to be treated as exposed: rotate it. Store secrets with `plur1bus secret set <name>` and pass the name. |
| `invalid-id`, `invalid-key`, `unknown-key`, `value-required`, `invalid-params` | `E_INVALID_PARAMS` | 2 | Usage: the id or key is not well formed, the key does not exist for that channel, or the value is missing. Nothing was written. |
| `invalid-value` | `E_INVALID_PARAMS` | 2 | The value does not validate against the config schema; `detail` names the schema complaint (never the value). Nothing was written. |
| `unknown-channel` | `E_NOT_FOUND` | 1 | No such channel in the config schema or the registry. |
| `owner-not-linked` | `E_NOT_FOUND` | 1 | `channel test --send-owner`: you have no linked identity on that channel (see `plur1bus identity link`). |
| `not-configurable` | `E_NOT_AVAILABLE` | 2 | The channel is registered but has no `channels.<id>` configuration in this version. |
| `config-not-writable` | `E_NOT_AVAILABLE` | 2 | No supervisor owns the configuration, so the core cannot write it. |
| `channel-not-running` | `E_NOT_AVAILABLE` | 2 | `--send-owner` needs a running channel. |
| `send-failed` | `E_NOT_AVAILABLE` | 2 | The channel refused or failed the test message; `detail` is its (redacted) error. |
| `config-refused` | `E_CONFIG_INVALID` | 1 | The supervisor refused the change; nothing was written. |

## Media reasons (`plur1bus media ... --wait`)

`plur1bus media generate|edit --wait` follows the job until it ends. Both failures are runtime failures of a command that
did its work (the job was queued), so they are `E_INTERNAL`, exit 1 (they were `E_NOT_AVAILABLE`, exit 2). The job is
not lost: `plur1bus media job <id>` shows it.

| `reason` | Code | Exit | Meaning |
|---|---|---|---|
| `media-job-failed` | `E_INTERNAL` | 1 | The job ended `failed` or `cancelled`; `detail` is the job's error. Nothing was written to `--out`. |
| `media-wait-timeout` | `E_INTERNAL` | 1 | The job was still running after ten minutes. It stays queryable and may still finish. |

## Update reasons (`plur1bus update`)

`plur1bus update` reports `E_NOT_AVAILABLE` (exit 2; `confirmation-required` is `E_INVALID_PARAMS`, also exit 2; a declined prompt is `E_CANCELLED` with `reason=declined`, exit 2) with a `reason`. Nothing was changed for any of them, except where the table says otherwise. See [updates.md](updates.md).

| `reason` | Meaning |
|---|---|
| `release-unverified` | This build has no release key baked in; it will not apply what it cannot verify. |
| `release-signature-invalid` | The manifest signature does not match any key this install trusts (also: malformed, or the baked key is invalid). |
| `release-key-expired` | The release is signed by a rotated key whose expiry has passed. |
| `key-list-invalid` | A key list is not signed by a trusted key, is for another channel, or is malformed. |
| `release-unreachable`, `download-too-large`, `digest-mismatch`, `size-mismatch`, `io` | Fetching or verifying a file failed (a declared `size` must match exactly). |
| `release-malformed`, `min-from-version`, `no-native-release`, `target-unsupported`, `unit-unsupported` | The release cannot be applied to this install (`unit-unsupported`: it also changes the Node runtime or modules, run `plur1bus setup`). |
| `downgrade-refused` | The release is older than the installed version; `--allow-downgrade` overrides. |
| `release-replay` | The release is older than the newest one this install accepted on the channel; `--allow-downgrade` overrides. |
| `release-version-invalid` | A version that is not a semantic version (`major.minor.patch`, optional `-pre-release`) cannot be ordered against the other. |
| `prerelease-on-stable` | The release is a pre-release and this install follows the stable channel; `--channel beta` follows pre-releases. |
| `guard-unreadable`, `addons-unreadable`, `state-unreadable` | A file under `<home>/update/` does not parse; it is never treated as empty. |
| `update-in-progress` | Another `update`, `update --rollback` or `setup` holds `<home>/update/update.lock` (or an interrupted update's process is still alive); nothing was changed, run it again when the other one has finished. `update --plan`, `--check` and `update status` never take the lock. |
| `addon-incompatible` | A required add-on would be incompatible with the new version; `--force` disables it and updates anyway. |
| `addon-disable-failed` | (Outcome `rolled-back`.) An add-on could not be disabled after the swap; the update was rolled back. |
| `bundle-unreadable`, `bundle-invalid`, `archive-unsupported`, `archive-unsafe-entry`, `channel-mismatch` | An offline bundle (`--from`) is missing, lacks `manifest.json`, `manifest.json.minisig` or an artefact, is not a `.tar.zst`/`.zip`, holds an entry that is not a plain file or directory (traversal, absolute name, link, duplicate), or is for another channel. |
| `ca-bundle-invalid` | `--ca-bundle` / `PLUR1BUS_CA_BUNDLE` is unreadable or holds no certificate (`E_INVALID_PARAMS`, exit 2). |

## Voice provider error codes (`@plur1bus/voice-providers`)

Not CLI codes: `VoiceProviderError.code` of the voice package, stable like the ones above. Callers branch on the code, never on the text; messages carry no key and no vendor text.

| Code | Meaning |
|---|---|
| `auth` | 401/403, a missing secret reference, or a socket closed with policy code 1008. Retrying cannot help. |
| `rate_limited` | 429 or a quota frame; `retryAfterMs` when the service said how long. |
| `overloaded` | 5xx/529, transient. |
| `invalid_request` | A 4xx the caller caused (bad voice, model or format). |
| `unsupported` | The provider does not offer this capability or option. |
| `network` | No response, or a socket that ended without a protocol reason. |
| `timeout` | A deadline expired. |
| `aborted` | The caller's `AbortSignal` fired. |
| `bad_response` | An HTTP response or handshake the package refuses to interpret. |
| `upstream_protocol` | New. A socket frame or close code that breaks the WebSocket protocol (reserved bits, bad UTF-8, oversize, bad fragmentation: close codes 1002, 1007, 1009) or the vendor's own message schema. The session is closed cleanly after one error event; nothing is thrown into the process. |
| `closed` | The session is already closed. |
| `unavailable` | The local engine or platform cannot run. |
| `licence_required` | A non-commercial or unconfirmed licence needs the owner's confirmation for this model and licence id. |
| `download_failed` | A model download failed: network, size limit, an archive with links or paths outside its directory, or a swap that could not complete (the previous version is kept). |
| `checksum_mismatch` | Downloaded bytes do not match the catalog sha256. |
| `catalog` | A catalog entry is missing, malformed, or has no verified package. |
| `config` | Provider configuration is invalid. |

## Device management (F44)

Device RPC uses existing `E_*` codes with these additive `reason` values; there
are no new top-level error codes. Messages contain no key material or pairing code.

| Reason | Error | Meaning |
|---|---|---|
| `device-invalid` | `E_INVALID_PARAMS` | Invalid id, name, metadata or public key. |
| `device-not-found` | `E_NOT_FOUND` | No device with that id. |
| `device-owner` | `E_DENIED` | The stored device belongs to another person; rename has no admin override. |
| `device-denied`, `device-revoked` | `E_DENIED` | Pairing proof/handshake refused, or the key has been revoked. |
| `device-conflict` | `E_CONFLICT` | This public key is already enrolled. |
| `device-storage` | `E_STORAGE` | State/ACL/audit could not be read or written; fail closed. A failed revocation write still disconnects and denies the key in memory; retry before restarting. |

The central RBAC gate additionally returns `E_UNAUTHORIZED` for a missing
principal and `E_DENIED` for forbidden role/kind/token scope, using the existing
RBAC reasons. Repeating a completed revocation is idempotent.

## Audit chain repair (`plur1bus audit reanchor`)

Existing `E_*` codes with these additive `reason` values; there are no new top-level error codes. See [audit-chain.md](audit-chain.md#recovery).

| Reason | Error | Exit | Meaning |
|---|---|---|---|
| `nothing-to-repair` | `E_NOT_AVAILABLE` | 2 | Writers accept the chain and its anchor (or there is no `logs/` directory); also the one state a writer heals itself, an anchor one complete line behind. Nothing was changed. |
| `reason-empty` | `E_INVALID_PARAMS` | 2 | `--reason` is empty after trimming (it is required unless `--dry-run`). |
| `not-owner` | `E_UNAUTHORIZED` | 1 | `logs/` does not belong to the calling OS user or is writable by group or others. Nothing was changed. |
| `audit-chain-locked` | `E_LOCKED` | 3 | Another process holds the chain lock for longer than 5 seconds (a running core that is writing). Try again. |
| `audit-reanchor-failed` | `E_STORAGE` | 1 | A file could not be renamed or written. The old files are put back under their names. |

## CLI-Exit-Codes

Which exit code a command ends with, collected from every exit site in `crates/plur1bus/src` by
`scripts/check-cli-exit-codes.mjs` (`node scripts/check-cli-exit-codes.mjs --list` prints each site with its command
context and error code). `node scripts/check-cli-exit-codes.mjs --check`, part of `pnpm docs:check`, fails when the
sources use an exit code that is not in the first column of this table. This section complements the two tables above;
it does not replace them.

| Exit | Meaning | Typical commands | What to do |
|---|---|---|---|
| 0 | Success, or a run that found nothing to do. `repair` and `setup` exit 0 only when their final check is clean. | all | Nothing. |
| 1 | The command ran and failed: `E_CORE_UNAVAILABLE`, `E_INTERNAL`, `E_STORAGE`, `E_CONFIG_INVALID`, `E_AGENT_UNKNOWN`, `E_NOT_FOUND`, `E_CONFLICT`, `E_UNAUTHORIZED`, `E_IMPORT_FAILED` and every other code that is not listed under 2 or 3. Also a supervisor that cannot set up its endpoint or lock, a failed `repair` or `setup` check, a `chat` turn that failed, a `media ... --wait` job that failed or timed out, a verification, run, probe or scan that reports a failure (`audit verify`, `approval verify`, `dreams run`, `model scan`, `memory reembed`, `1staid check`, `admin embedding probe`, `channel test`), and a child process (`acp serve`, `core run`) that exits non-zero, whose own code is passed through. | `agent`, `config`, `daemon start`, `media`, `memory`, `module`, `service`, `update`, `supervise` | Read the message (or `error`/`reason` with `--json`) and the matching row in the error-code table above. `E_CORE_UNAVAILABLE`: `plur1bus daemon start`. |
| 2 | Refused before any work, nothing changed: `E_INVALID_PARAMS` (a bad argument or input, a missing `--yes` outside a terminal, an unknown `--only` step, an unknown or ambiguous `--agent`, a bad key or env value, a request the core rejected), `E_NOT_AVAILABLE` (not possible here or now, also `module start` without a supervisor and `update --rollback` with nothing to roll back), `E_APPROVAL_REQUIRED` (from the core) and `E_CANCELLED` (a prompt answered no, in every command including `update apply`). `supervise` exits 2 for an option that needs `PLUR1BUS_ALLOW_TEST_INTERNALS=1`. clap's own usage errors also exit 2. | `approval`, `budget`, `channel`, `config apply`, `dreams`, `grant`, `login`, `module`, `repair`, `secret`, `service`, `update`, `voice` | Fix the invocation and run it again. A confirmation refused by a script needs `--yes`. For `E_APPROVAL_REQUIRED`, approve the request first. |
| 3 | Another process holds the store or the home: `E_LOCKED`, or a supervisor already running for this home, or the supervisor lock held with no supervisor answering (an offline `module install`). Under launchd the supervisor reports 2 and 3 as 0 so the service is not restarted in a loop; the "held, nobody answered" case is the one exception there and ends with 1, which launchd retries. | `backup`, `ext`, `supervise` | Wait and retry, or stop the other process (`plur1bus daemon stop`). Do not start a second supervisor. |
| 70 | Internal: the supervisor ended on a panic. | `supervise` (the OS service) | Read `logs/supervisor.log` and report it. The OS service restarts it. |
| 130 | Interrupted by a signal or Ctrl-C: `login` (`E_CANCELLED`, `reason=login-cancelled`, nothing was saved), or a child process of `acp serve` or `core run` that a signal ended. | `login`, `acp serve`, `core run` | Run the command again. |
| 137 | Test internals only: `PLUR1BUS_TEST_UPDATE_KILL_AT` kills the updater right after a phase when `PLUR1BUS_ALLOW_TEST_INTERNALS=1`. Never seen in normal use. | `update apply` | Unset both variables. |
| 1..255 | `import` passes the importer's own exit code through (1 when it names none or one outside the range). | `import` | Read the importer's message; the code is the importer's, not the CLI's. |

### Inconsistencies (fixed)

The first collection (#423) found the inconsistencies below. All of them are fixed; `tests/cli_surface.rs` and
`scripts/check-cli-exit-codes.mjs --check` keep them fixed.

- **Fixed:** `E_NOT_AVAILABLE` exited 2 through `output::exit_code_for` but 1 at 16 direct `out.fail(..., 1)` sites. It
  exits 2 everywhere.
- **Fixed:** `E_INVALID_PARAMS` exited 2 at 40 sites and 1 at 15. It exits 2 everywhere (a usage or input error, also a
  request the core rejected), so a script can tell it from a runtime failure.
- **Fixed:** `E_INVALID_PARAMS` was used for runtime problems. A damaged output of `media save` (`invalid output range`,
  `incomplete output`, undecodable data) is `E_STORAGE`, exit 1. A prompt answered no (`not applied`, `not reindexed`)
  is `E_CANCELLED`, exit 2.
- **Fixed:** A declined confirmation exited 2 with `E_INVALID_PARAMS` (`config apply`, `module`, `secret`, `memory forget`,
  `media reindex`, `ext`) but 1 with `E_CANCELLED` for `update apply`. It is `E_CANCELLED`, exit 2, everywhere.
  Ctrl-C and a signal end with 130 (`login`, and the children of `acp serve` and `core run`).
- **Fixed:** The code-to-exit mapping was written three times. It is written once, `output::exit_code_for`;
  `ext::Failure::exit` and `BackupError::code` ask it, and `Out::fail` derives its exit from the code (the exit is no
  longer an argument). `Out::fail_exit` is for the two exits that are not in the table: the importer's own exit code
  and 130. `every_fail_call_takes_its_exit_code_from_the_table` fails when a call passes a literal exit for a code in
  the table.
- **Fixed:** `supervise` exited 3 for "already running" but 1 when the lock was held and no supervisor answered. Both
  exit 3 (under launchd the second keeps 1, see the table).
- **Fixed:** `audit verify`, `dreams run`, `model scan`, `memory reembed`, `1staid check`, `approval verify`,
  `admin embedding probe`, `channel test` and `chat` called
  `std::process::exit(1)` after the normal result, with no `error/1` document. With `--json` the result document now
  carries the failure as a top-level `error` object, itself an `error/1` document, so stdout stays ONE JSON document
  and a result such as `{"schema":"audit.verify/1","ok":false,...}` keeps all its fields:

  | Command | `error.error` | `error.reason` |
  |---|---|---|
  | `audit verify` | `E_STORAGE` | `audit-verify-failed` |
  | `dreams run` (a run that `failed` or was `aborted`) | `E_INTERNAL` | `dream-run-failed` |
  | `model scan` (a provider scan failed) | `E_INTERNAL` | `scan-failed` |
  | `memory reembed --plan` (incompatible model) | `E_CONFLICT` | `incompatible-model` |
  | `memory reembed --run` (the migration did not finish) | `E_INTERNAL` | `reembed-failed` |
  | `1staid check` (a check failed) | `E_INTERNAL` | `checks-failed` (`ids.failed` lists the check ids) |
  | `approval verify` (the chain is broken) | `E_STORAGE` | `approval-chain-broken` (`detail` is the core's reason, e.g. `mac-mismatch`) |
  | `admin embedding probe` (the probe failed) | `E_INTERNAL` | the core's reason: `aborted`, `provider-failed`, `invalid-vector` or `dimension-mismatch` |
  | `channel test` (the check failed) | `E_INTERNAL` | `channel-test-failed` (`detail` is the channel's detail) |
  | `chat` (a turn ended `failed`) | `E_INTERNAL` | `turn-failed` (`detail` is the core's error string) |

  `admin embedding probe` and `chat` already have a string `error` in their result (the core's reason); in a failed
  document that key holds the `error/1` object instead and the string moves to `reason` (probe) or `detail` (chat).
  `chat` prints one document per turn, so with several lines on stdin only the failed turns carry `error`.
  The exit stays 1; without `--json` nothing changes. A success is unchanged, in particular the documents the desktop
  app parses (`1staid.check/1`, `admin.smoke/1`, `daemon.status`, `state.snapshot/1`).

### D106 sandbox adapter diagnostics (2026-10-15 Draft)

Sandbox failure uses the existing tool error envelope (`tool-failed`); the host adapter may supply `sourceCode: sandbox-unavailable`, and exec retains its existing `spawn-failed` diagnostic inside the adapter failure. These are tool-local diagnostics, not new RPC error codes. Missing isolation never changes into a successful unsandboxed result. The trusted Rust limits launcher exits 125 on setup failure; the CLI exit-code checker already documents that code.
