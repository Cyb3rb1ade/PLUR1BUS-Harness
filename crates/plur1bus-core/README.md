# plur1bus-core

The PLUR1BUS core in Rust (Phase 4, ADR-019, owner decisions D129 and D131). Since P4-10 it is the **front door**: it owns
the core's socket, token, run files and lock, starts the TypeScript core behind it as `core-legacy`, and relays every call
it does not serve to it. Opt-in until the flip PR: `core.impl: "rust"` in `config.json`, or `PLUR1BUS_CORE_IMPL=rust`
(tests); the TypeScript core alone stays the default. The crate is `#![forbid(unsafe_code)]`.

```text
plur1bus-core serve --home <dir> [--lifeline stdin --instance <uuid>]
```

The supervisor's `core` slot and `plur1bus core run` start it with `PLUR1BUS_NODE` and `PLUR1BUS_CORE_JS` set to the
located runtime; it spawns `node core.js --home <dir> --behind-front-door supervised|standalone --lifeline stdin
--instance <uuid>` and holds that process's stdin as its lifeline.

## What it owns

| File or endpoint | Mode | Written by |
|---|---|---|
| `run/` | `0700` (user-and-SYSTEM DACL on Windows) | front door |
| `run/core.sock` / `\\.\pipe\plur1bus-<hash>-core` | `0600` / explicit SDDL (closes ADR-012 deviation C2) | front door |
| `run/core-legacy.token`, `run/core-legacy.credentials` | `0600`; the link token, and `{core, api}` for the legacy core alone while it starts (removed once it is ready) | front door, before the legacy core starts |
| `run/core.token`, `run/api-delegation.token` | `0600`, 32 random bytes as hex, fresh per start | front door, once the legacy core is ready, right before the bind (as the TypeScript core writes them right before it listens) |
| `run/core.pid` | `0600`, `<pid> <instanceId>`; the legacy core runs as the same instance | front door |
| `state/core.lock` | the TypeScript core's SQLite byte range | front door |
| `run/core-legacy.sock`, `run/core-legacy.pid`, `run/core-legacy.lock`, `run/engine-models.json` | the legacy core's lock is in `run/`, never in `state/` (a data root for backups, restores and imports) | legacy core |

## Layout

| Module | What |
|---|---|
| `cli` | the command line |
| `run_files` | the run-file names, the address rule of module-api's `unitAddress`, private writes, and the read of a credential file another process wrote (`read_token`: on Unix one open that follows no link and does not wait, judged by its descriptor and bounded; `engine_token_now`: `run/` checked first, before every native answer to the engine) |
| `server` | listener, framing (4 MiB lines), 16 MiB back-pressure, the 30 s handshake deadline, the route table |
| `relay` | the per-client link to `core-legacy` |
| `auth` | credentials (`Secret`, never printed), constant-time compares, the `core.auth` checks |
| `lock` | the single-instance lock on `state/core.lock` |
| `events` | subscriptions and the front door's own `core.state` |
| `lifecycle` | process state, lifeline, drain order, timings |
| `legacy` | spawning the legacy core and its ready line |
| `frame` | NDJSON lines and error frames |
| `front_log` | the front door's own lines in `logs/core.log` (`src: "front-door"`), through the `logs` writer and the role lock the legacy core's writer shares; level and rotation from config.json and then the configuration source (P4D-7). Since P4-20 flip A a line is also masked with the values of `redaction_mirror`, and so is its copy on stderr (`FrontLog::mask`) |
| `native` | P4-12 flip A1: the RBAC guard in front of every method the front door serves itself (the owner connection's principal as `state/admin.sqlite` stores it, the decision of `rbac`, a refusal's audit event to `logs/audit.log` and the hash chain) and the first two native methods, `breakglass.notices` and `identity.principals`. Flip A2: `user.role.set`, `user.disable` and `user.enable`, the first that write `state/admin.sqlite` from here (audited inside the store's transaction, before the row changes), and `LegacyCore`, what such a write asks of the legacy core afterwards. Flip A3: the same five methods for a person the harness API acts for, resolved from the store (never the local owner; the stored role replaces the claimed one). P4-20 flip A: `logs.query`, masked with `redaction_mirror` and served only while that is in step (`serves_now`). Flip B2: the module `secret_methods` (`native_secrets.rs`), six `secret.*` methods (status, list, get, describe, set, delete) over the store of `secrets_owner` and, for the engine's connection alone, `host.secret.get`; served only while the front door owns the store, and after a change the legacy core is told before the caller is answered (`LegacyCore::secret_changed`, `legacy.secret.changed`). In a process started for an import maintenance nothing is served here (`hold_for_import_maintenance`, P4D-38) |
| `route` | the method table: which methods are served here for a person (`NATIVE`), which for the engine's connection alone (`ENGINE_NATIVE`: `host.secret.get`, named singly), which are relayed and completed, and the generated dispatcher over `native` |
| `control` | the front door's own link to the legacy core: its handshake (named `front-door`), `core.shutdown` at stop, and since P4-12 flip A2 the `legacy.*` calls of `docs/phase4/bridge.md` with their answers (five seconds each) |
| `redaction_mirror` | P4-20 flip A: the front door's copy of the legacy core's redaction registry, filled over `legacy.redaction.changes` (asked for before the first client, followed in a long poll, caught up before every native `logs.query`); whether it is in step decides whether `logs.query` is served here or relayed (P4D-33) |
| `logs` | P4-11: the D111 writer and sink (`<role>.log`, rotation, the role lock shared with the TypeScript writer), the core side of the redactor in `plur1bus-log-schema`, log query and the `logs.*` handlers |
| `config` | P4-11: config.json loading and validation, warnings, the disclosure policy, the engine configuration, the configuration source (supervisor `config.watch` through the client in `config::watch`, or the file). `front_log` uses the source; the rest is library only until the flip |
| `metrics` | P4-11, library only until its flip: registry, the core's metrics, the metrics token, the loopback `GET /metrics` endpoint (no HTTP library: one request per connection) |
| `doctor` | P4-11, library only until its flip: the doctor report handlers |
| `rbac` | P4-12, library only until its flip: the policy table and `authorize` (one security decision, two implementations: the TypeScript policy stays in `packages/api`), surface trust levels, the rule table of the RPC methods and the guard's decision with the memory fallback, the break-glass registry, the audit line of `logs/audit.log` |
| `identity` | P4-12, library only until its flip: principals, pairing codes, invite tokens, the limiter; `state/identity.sqlite` (humans, links, pairing, back-fill records) and its service; `state/admin.sqlite` (role presets, last-owner rules, agent rights, invitations and redeem, break-glass notices); `state/desktop-attach.db` (desktop codes and credentials over a `DeviceStore` trait); the back-fill and its engine port (the engine a trait) |
| `exposure` | P4-12, library only until its flip: memory exposure per channel and principal, the sensitivity scanner, `state/memory-sensitivity.sqlite` and the card sensitivity service, the local-only privacy functions and doctor finding |
| `secrets` | P4-20: the secret store over two backends (selection, merge and sync of keyring and file, preload, gates, leases), the encrypted file backend that writes `state/secrets/store.json` byte for byte as TypeScript does, the memory backend, validation and leases. The registry of secret values is `logs::redact::SecretSet`. The keyring backend works over a `Keyring` trait (the index, the undo of a half-written `put`), and `secrets::isolated` runs a backend in a helper process (`plur1bus-core secrets-helper`: frames on its standard input and output, a budget for every call, a killed helper and a raised flag when it runs out). The adapters for the systems' keyrings are `secrets::os_keyring` (PR 2b): the crates `@napi-rs/keyring` wraps, so both implementations read the same items; Linux has the Secret Service only (P4D-34); a test seam keeps every test away from a real keyring, and `tests/keyring_probe.rs` exercises the adapters in CI (`.github/workflows/keyring-probe.yml`) |
| `engine_scope` | P4D-29 (R-20-35 to R-20-38): the secret names the engine may resolve, one definition read from the configuration schema: the values of the `x-secret-reference` fields of `engine`, and the `x-secret-default` names of the blocks that are in it; `fixtures/parity/secrets/engine-scope.json` is what this and `packages/core/src/engine/secret-scope.ts` must both give. `EngineScope` is that set for a home: the one of the last valid `config.json`, kept while the file is the same file (size, modification time, inode), read through one descriptor without waiting and up to the loader's limit. `server` asks it before `host.secret.get` is served here and sends a name outside it on to the legacy core |
| `secrets_owner` | P4-20 flip B1: who owns the secret store of a run (the front door; on macOS with the system's keychain the legacy core, until the items have moved, P4D-35), and what the front door holds when it does: the store, built with `secrets::runtime` and read once before the legacy core starts, its lines in `logs/core.log`, and the bridge endpoint. A keyring seam that is refused stops the start |
| `bridge` | P4-20 flip B1: the endpoint `run/core-bridge.sock`, bound before the legacy core is started, for the holder of the link credential only: `bridge.hello` and the nine `bridge.secret.*` methods (`docs/phase4/bridge.md`, "The secret store"). The principal travels as data, every answer carries the effects for the leases and the snapshot the legacy core holds, and a connection has no method of the store before its preload named the front door's keyring service |
| `home_path` | P4-20 flip B1: `--home` as the TypeScript core spells it (Node's `path.resolve`, by text alone), because the keyring service and the Windows pipe names are derived from the home's text |
| `js` | P4-12: the JavaScript semantics ported code depends on (UTF-16 lengths, `trim`, case mapping, `\s`, `JSON.stringify`, default sort order), with vectors recorded from Node |

Route table: before `core.auth` everything is answered here; `core.auth` is verified here and then opened as a link with
the client's credentials plus `core.auth.frontDoor`; `bridge.hello` is served to the legacy core's own connection only,
and `bridge.secret.*` not on this socket at all (it has its own endpoint, `bridge`);
`core.status`, `core.adopt`, `core.shutdown` and `events.(un)subscribe` are relayed for the legacy core's admission and
RBAC and completed here (the front door's identity and state, its lifeline, its stop, its `core.state`); the native
methods are served here for the local owner and a person behind the harness API; an engine connection is served
`host.secret.get` here, after its token was compared with `run/engine.token` once more, and every other call of it
is relayed; everything else
is relayed byte for byte. The legacy core re-verifies every credential and runs its RBAC on every relayed call until the
cut. See `docs/phase4/bridge.md` for the bridge ledger.

Shared crates of Phase 4: `plur1bus-canon` (canonical JSON, action hash), `plur1bus-store` (SQLite conventions of the
TypeScript stores), `plur1bus-tokens` (token counter, extracted from the engine), `plur1bus-audit` (audit chain and the
core lock, shared with the CLI).

## Tests

```text
cargo test -p plur1bus-core --locked
```

`tests/front_door.rs` (`harness = false`) runs the binary against a fake legacy core that is the test binary itself
(`tests/front_door_support/fake_legacy.rs`): run files and modes, every caller kind, the relay, notifications,
back-pressure, adoption and the lifeline, every stop path, and that no credential leaks. `tests/cli.rs` covers the command
line. `tests/wire.rs` is parity mode W: `tests/support/` is a fake HTTP and WebSocket server on 127.0.0.1 that serves the
exchanges `scripts/parity/export-wire.ts` recorded from the TypeScript fake servers (`fixtures/parity/wire/`). The parity
harness as a whole is described in `tests/core-parity/README.md`. The P4-11 modules replay the mode V vectors of
`fixtures/parity/{logs,config,metrics,doctor}/` (exporters `scripts/parity/export-{logs,config,metrics,doctor}.ts`).

The P4-12 modules replay `fixtures/parity/{rbac,js,exposure,identity,identity-store,identity-admin,rbac-guard,sensitivity}/`
(exporters `scripts/parity/export-<area>.ts`). Pure functions are vectors. Stateful code is recorded as sequences: the
exporter drives the TypeScript store or service against a temporary file with a scripted clock and a scripted random
source and records, per step, the call, the result or error, the audit events, the random draws and every table that
changed; the Rust replay must reproduce all of it, and `sqlite_master`, the pragmas and the column order of every store.
The four stores are opened through the owner mode of `plur1bus-store` (`Store::open_owner`), exactly as their TypeScript
constructors open them. `docs/phase4/defects.md` (P4D-12 and following) lists what was ported as it is.
