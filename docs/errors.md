# CLI exit codes and error codes

Every failing `plur1bus` command writes one error and exits non-zero. With `--json` the error is a document on stdout
(`schema: "error/1"`, with `error` set to the code below, `message`, and optional `reason`, `detail` and `ids`); without
it, `plur1bus: <message>` goes to stderr (bold red on a colour terminal, see `--color` and `NO_COLOR` in
[cli.md](cli.md)). A script should branch on the exit code or on `error`, never on the message text.

`tests/docs_consistency.rs` keeps this page and the Rust sources in step: every `E_*` code in `crates/*/src` is listed
below and every code listed below exists in the sources. `output::tests` keeps the Exit column in step with the code
that maps an error to an exit code.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Success. A `--check`-style command that found nothing wrong also exits 0. |
| 1 | The command failed (any error code not listed with another exit below), or a real write error lost the output (a closed pipe does not count). |
| 2 | The command cannot run here: `E_NOT_AVAILABLE` (also every milestone stub), or it needs an approval first (`E_APPROVAL_REQUIRED`). Usage errors (an unknown flag, a missing argument) also exit 2, before any command runs. |
| 3 | `E_LOCKED`: the store is locked by another process. Retry later. |
| 70 | Internal: the supervisor ended on a panic. Only seen from `plur1bus supervise` (the OS service), never from an interactive command. |
| 130 | `plur1bus login` was interrupted with Ctrl-C (`E_CANCELLED`, `reason=login-cancelled`); the login was cancelled and nothing was saved. |
| 1..255 | `plur1bus import` passes through the exit code of the importer (`E_IMPORT_FAILED` and the importer's own errors), 1 when it names none. |

## Error codes

The first fifteen codes are the closed set of the RPC schema ([rpc.md](rpc.md#error-codes)); the CLI reports the code
the core sent. The last two are raised by the CLI itself.

| Code | Exit | Meaning |
|---|---|---|
| `E_UNAUTHORIZED` | 1 | The local endpoint refused the token, or the endpoint is not trusted (wrong owner, writable by others, peer mismatch). |
| `E_RPC_VERSION` | 1 | The core or supervisor speaks an RPC version this CLI does not. |
| `E_NOT_AVAILABLE` | 2 | The command or feature is not available here: a milestone stub, a container-managed install, a missing prerequisite. |
| `E_CORE_UNAVAILABLE` | 1 | The core could not be reached (not running, not ready, socket missing). Start it with `plur1bus daemon start`. |
| `E_INVALID_PARAMS` | 1 | The core rejected the request parameters. |
| `E_AGENT_UNKNOWN` | 1 | The named agent is not registered. |
| `E_CONFIG_INVALID` | 1 | A configuration value or file does not validate against the schema. |
| `E_MODULE_UNKNOWN` | 1 | The named module does not exist. |
| `E_INTERNAL` | 1 | An unexpected failure inside the CLI or the core. |
| `E_LOCKED` | 3 | The store or a lock is held by another process. |
| `E_NOT_FOUND` | 1 | The named object (entry, session, extension, ...) does not exist. |
| `E_DENIED` | 1 | Policy or permissions refuse the operation. |
| `E_APPROVAL_REQUIRED` | 2 | The operation waits for an approval or an acknowledgement (`reason` says which). A script must not treat it as success. |
| `E_CONFLICT` | 1 | The operation conflicts with the current state (name taken, concurrent change). |
| `E_STORAGE` | 1 | A storage operation failed; `ids` may carry the ids needed to recover a half-finished step. |
| `E_IMPORT_FAILED` | 1 | `plur1bus import` could not run or finish the importer (`reason`: `importer-missing`, `node-unavailable`, `importer-crashed`). The importer's own errors keep the exit code it reports. |
| `E_CANCELLED` | 1 | The user declined a confirmation prompt; nothing was changed. |

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
