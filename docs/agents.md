# Agents

Agents are registered in `config.json` under `agents.<id>`. Execution state
(open/closed, paused, archived) and per-person object rights have separate
stores. Agent IDs follow the Config Schema's lowercase name rule. Settings are
optional; existing agent configurations remain valid.

## Create and validate

`agent.create` accepts `{ name, persona?, model?, memory?, rights?, channels? }`
and returns `{ agentId }`. The name is the unique agent identifier. `persona`
is plain text, at most 4000 characters, written literally to `SOUL.md` without
template execution. `model` names an existing `modelProfiles` entry; `channels`
contains existing installation channel names. Selection does not enable a
channel or provision credentials. `memory` follows the existing per-agent
Config Schema, including media embedding overrides.

`agent.validate` is a dry-run of that payload (partial payloads are also accepted
for the wizard). It returns `{ valid, errors: [{ step, field, message, code }] }`.
Errors belong to `identity` (name, persona, channels), `model` (profile and memory
settings), or `rights`. Invalid values are not echoed in errors. The same
settings validator and reference checks run before create and import. Validation
creates no files, grants, audit events or agent records.

```sh
plur1bus agent validate agent-payload.json --json
plur1bus agent create assistant --config agent-settings.json --json
```

The validate file contains `name`; the create settings file contains optional
settings and rights, with the positional ID supplying `name`. For example:

```json
{
  "persona": "Keep answers concise.",
  "model": "local",
  "channels": ["telegram"],
  "rights": { "existing-person-id": "use" }
}
```

The current core is required for settings, validation and import. With a current
running core, name-only create also uses the RPC. The earlier name-only offline
bootstrap stays available for setup, older cores and Hermes compatibility;
it retains its existing config-write output/errors and does not assign initial
object rights. Start the core and use `agent rights set` when explicit rights
are needed for an offline-created agent.

## Rights and audit

Only authenticated Owner/Admin **people** may create, validate or import.
Agent principals cannot use these methods even with an Owner-shaped role.
API-token scopes further narrow access: the surface requires `settings.write`;
delegating `use` or `manage` also requires the corresponding `agent.read` or
`agent.manage` action. The caller always receives `manage` on the new agent.

`rights` is a map of existing person IDs to `use` or `manage`. It is an RPC
parameter, never an agent-config field. Rights are written through the same
AdminStore operation as `agent.rights.set`; subsequent rights edits remain
independent of the settings. Unknown recipients and agent IDs are rejected on
create. The runtime export reads current rights from that authoritative store.
`agent.created` is an audit event; submitted persona, memory text and credentials
never appear in its detail. The WebMCP provider blocks the three new methods.

## Import an export

```sh
plur1bus agent export assistant --json > assistant-export.json
plur1bus agent import assistant-export.json --on-conflict rename --json
```

Import accepts the exported CLI document's `bundle` or a raw export bundle.
It verifies `plur1bus.agent-export/1`, every file's size and SHA-256 checksum,
the manifest hash when present (canonical key order, with support for earlier v1 construction-order hashes), and the Ed25519 signature when present before
interpreting settings or writing anything. A partially supplied signature is
refused. The embedded public key proves integrity, not trust in the source
installation. Unknown formats and invalid integrity/path data return
`E_INVALID_PARAMS` with `detail: "bundle"`.

Only the export allow-list is accepted: persona/identity Markdown, memory and
skill Markdown, workspace memory, and the two structured config/card files.
Absolute paths, traversal, device filenames, links, credential paths and
case-insensitive duplicates are refused. Import removes secret-named config
keys and redacts recognized credential patterns in text. Arbitrary unrecognized
secret text cannot be identified automatically: only share exports reviewed
for sensitive free text. No source credential backend or token is transferred.

The export manifest carries required **secret names** and current person rights.
Old v1 exports without that metadata remain supported. Required credentials
are also derived from the target instance's selected channel and model-profile
provider settings. Missing local credentials produce `E_AGENT_SECRETS_MISSING`
with `ids` mapping each missing key name to itself, never a secret value.
Provision those credentials using the secret CLI before retrying.

`onConflict` defaults to `fail` (`E_AGENT_EXISTS`). `rename` chooses the first
free `<name>-2`, `<name>-3`, etc., within the same identifier length limit.
Imported rights keep only local existing persons and cannot exceed the caller;
a scoped caller's `manage` grant may become `use` or be dropped. Unknown or
dropped recipients are reported as `discardedRights` in the result:

```json
{ "agentId": "assistant-2", "discardedRights": ["foreign-person-id"] }
```

Memory cards are ingested through the engine's public finished-card import API
with deterministic keys and owner bindings for the importing person. They
become engine memories rather than copied database files. On config revision
conflict, staged files are removed. If engine ingest or final registration
fails after registration, the recoverable agent remains **paused** and the
`E_STORAGE` error carries its `agentId` in `ids`. Inspect that agent before
resuming; cross-store import is not a crash-atomic backup restore.

## Activity history

`agent.activity.list` returns recent state transitions, newest first, with optional agent, inclusive RFC 3339 time bounds, state kinds and cursor filters. The default page has 50 items and the maximum is 200. `activity.maxEntries` bounds the in-process ring (default 1000); a Core restart clears it. Expired, mismatched or changed-visibility cursors return `E_INVALID_PARAMS` with `reason: bad-cursor`. Start a fresh query to recover. Logs → Activity provides agent and time filters and next-page navigation; the existing audit feed retains its Owner/Admin restriction.
