# Configuration disclosure (SH2)

The configuration schema owns disclosure policy. Public views apply this policy before selecting a key, a parent
object or a tier; a narrow read cannot expose a value hidden by a whole-config read. This applies to both Supervisor
`config.get` and the CLI fallback when no Core or Supervisor is running. Existing RPC envelopes, revisions and JSON
types remain intact. See the generated [key reference](reference/config-keys.md).

`x-sensitive` remains boolean. It masks literal strings, including string leaves in annotated objects, maps and arrays.
A value matching a marked reference subschema remains readable as reference metadata; it is not a secret value. A nonempty sensitive string becomes `••••`; empty strings stay empty. Malformed numeric or boolean
values in opaque sensitive slots become `0` or `false`, preserving their JSON types. Unknown, unmarked members remain
public; their names do not add a classification.

`x-url-credentials` identifies endpoint URLs. Views hide userinfo and every query parameter value, including repeated
parameters; parameter names, host, path and fragment remain visible. Whole webhook URLs with secret paths instead
carry `x-sensitive`. Literal, normalized and decoded credential parts feed log registration; an endpoint's full URL,
host or public path is never registered merely because the value is a URL.

`x-value-schema` supplies nonvalidating metadata for supported opaque Engine members and the existing `providers`
consumers: auth-profile headers, pool and legacy provisioning references, endpoint URLs, media references/URLs and MCP transport
headers, environment values, arguments, references and URLs. The provider namespace remains open. This metadata
also protects retired OTLP headers and endpoints in diagnostic copies; those settings remain invalid configuration.
`x-secret-reference` marks reference subschemas; existing field links identify the local reference definition. Names
remain readable in configuration, provisioning metadata, audit and logs. They are never added to the global text
registry merely because their field is sensitive. Classification never reads an environment variable, file, command
or secret store. Plain Engine strings are literals; only the pinned resolver's supported reference objects and legacy
placeholders are references. See [reference safety](secrets.md#reference-names-and-pasted-keys).

## Output inventory

| Boundary | Behavior |
|---|---|
| Supervisor `config.get`; offline `config get`, JSON and human output | Whole/key/tier views share the schema projection. |
| Web Settings JSON, current values and review cells | Apply the full configuration prefix; public numeric limits remain visible. |
| Web replacement inputs | Literal-secret and URL inputs start empty; safe references remain readable. Untouched inputs send no write. |
| Switchboard channel editor | Literal/URL fields and parents containing them require an explicit replacement; safe reference names remain readable. |
| Command palette, both value inputs | Keep safe reference names; omit literal secrets and mask URL parts before final list rendering. |
| Config audit old/new values | Apply declarations, retaining role checks, chain behavior and public policy values. |
| Root and module validation diagnostics | Report paths and constraints without interpolating rejected instances. |
| Core logs, audit/doctor/protocol sinks using the shared registry | Learn declared configuration values before queued startup logs and accepted-change listeners. |
| Supervisor persisted log and captured child stdout/stderr | Register coherent config snapshots before dependent output; see [logging](logging.md#supervisor-configuration-values-sh2). |
| `1staid bundle` | Project config, register declared values before cleaning every other text, retain pattern backstops and rescan refusal. |
| Agent export `config.json` and companion files | Project the agent config; shared registered config values and store canaries protect files and memories. |
| Channel config views and write results | Preserve safe reference names, existing object keys and presence facts; mask literals and URL credentials. |
| Regular backup/restore | Preserve reference data, replace literals/URL parts, record names and report required re-entry; see [backup/restore](ops/backup-restore.md). |
| Portable encrypted backup | Keep its separate documented behavior; see [portable backups](portable-backup.md). |

The JSON-type guarantee above applies to public configuration views. Regular archives deliberately replace literal
secret scalars with the documented string placeholder, including malformed numeric/boolean values in opaque slots;
the names-only inventory makes required re-entry explicit. Archive traversal therefore differs from display projection
while sharing reference safety and URL primitives.

Agent export manifests still name required secrets for target provisioning. If metadata independently matches a
registered secret value, export refuses before signing rather than publishing that value or an invalid replacement
name. Grant views apply the same exact-value backstop while retaining their existing shape. File allow-lists,
inbound foreign-agent sanitization and free-text credential-pattern backstops
remain separate from configuration classification.

## Private runtime snapshots

Local authenticated `config.watch` and `config.changed` snapshots retain the original configuration. The API's
Supervisor delegation does not expose `config.watch`. Internal agent provisioning/removal, compensation and repair
use these private snapshots and keep revision checks. Public masked snapshots must never be written back as if they
were complete runtime configuration.

Web settings keep the current value separate from a replacement draft. Unrelated saves cannot submit a placeholder.
Review cells conceal both old and newly entered secrets; endpoints show their masked public host/path. Clearing a
required value may still fail normal server validation; sensitivity metadata does not relax validation.

## Startup and live changes

Core creates a configuration registration group before it creates its output sinks or flushes queued start messages.
The store, diagnostic writers, audit, doctor and outgoing-protocol redactors share that registry. Injected loggers
receive the same live filtering, including child context and Error fields.

Current configuration values are pinned. Removed or rotated values enter the existing newest-256 retired-value
budget; one group cannot collide with a user-created store name. The initial composition snapshot remains pinned
until Core exits, because the Engine and provider composition can still hold it after configuration advances.
Supervisor captured-output generations retain the corresponding start snapshot until the stream ends.

Installed modules contribute their own `configSchema` declarations at `modules.<name>`. Direct properties, maps,
items and supported metadata are interpreted consistently in Rust and TypeScript. Conditional/reference privacy the
projection cannot interpret, missing manifests for installed configured modules and unavailable metadata refuse
public disclosure. Unconfigured invalid manifests do not block unrelated values. Unregistered opaque namespaces do
not gain an invented name-based policy.

Core loads module metadata in bulk before startup disclosure and before publishing a module-configuration change.
While preparation is pending, the previous accepted snapshot remains visible and only the latest waiting candidate
is retained. An unavailable policy keeps that snapshot and reports the failure without candidate values. Repair a
changed module manifest and restart to replace the policy snapshot; ordinary configuration updates require no
manual registry refresh.

## Existing unstructured-text limits

Structured configuration projections conceal every marked value, including short strings. Global exact-value
registration retains the existing minimum of eight units (UTF-16 units in Core, UTF-8 bytes in Rust), so a short substring does not disappear
from unrelated public hosts or prose. A short bare value is outside that registry guarantee. Existing free-text
pattern/URL rules may still mask it in a recognized context; the Rust captured-byte stream adds no generic URL parser.
Store values not yet read at startup, additional escaped forms, clipping and form-cache work are handled separately
by SH3. This document does not claim those gaps are closed by SH2.

The persisted Supervisor logger and child pumps are the scoped Rust sinks. Direct stderr and the default panic hook
are separate paths; no new general panic/service-journal capture is introduced. Secrets in arbitrary unmarked free
text cannot be classified from configuration metadata alone.

Validation: run Config Schema tests, full Core and Web suites, affected backup/system tests, `cargo fmt --all -- --check`,
`cargo clippy -p plur1bus --all-targets -- -D warnings`, `cargo test -p plur1bus`, `pnpm lint` and `pnpm docs:check`.
The SH2 PR records the exact commands, source revision and results.
