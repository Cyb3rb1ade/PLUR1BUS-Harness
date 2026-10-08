# Konfigurationsschlüssel (config.json, schemaVersion 1)

Diese Referenz wurde erzeugt, indem die Schema-Datei manuell gelesen wurde. Die Quelle der Wahrheit ist `packages/config-schema/schema/config.schema.json`. Bei Abweichungen gilt das Schema.

Legende: `–` bedeutet im Schema kein `default` bzw. keine `x-restart`-Angabe. `geerbt: X` bedeutet, dass die Klasse vom nächsten Vorfahren mit `x-restart` übernommen wird. `module:$key` wird je nach Modulname zu `module:<name>`.

| Schlüssel | Typ | Default | Restart-Klasse | Beschreibung | Quelle |
|---|---|---|---|---|---|
| $schema | string | – | live | URI identifying the JSON Schema used to validate this configuration. | packages/config-schema/schema/config.schema.json:10 |
| schemaVersion | const 1 | – | core | Configuration format version; this schema supports version 1. | …json:11 |
| core | object | {} | – | Settings for the core process, including logging, memory operation budgets, and shutdown. | …json:12 |
| core.logLevel | enum: debug, info, warn, error | info | live | Minimum severity written to the core log. | …json:16 |
| core.recall | object | {} | – | Time and response-size limits for memory recall. | …json:17 |
| core.recall.softBudgetMs | integer, min 50 | 400 | core | Soft target duration for a recall, in milliseconds. | …json:21 |
| core.recall.hardBudgetMs | integer, min 100 | 600 | live | Maximum duration allowed for a recall before it is aborted, in milliseconds. | …json:22 |
| core.recall.capChars | integer, min 1000 | 17000 | core | Maximum number of characters returned by a recall. | …json:23 |
| core.capture | object | {} | – | Limits for waiting on memory capture after a turn. | …json:26 |
| core.capture.waitMs | integer, min 1000 | 60000 | live | Maximum time to wait for a memory capture, in milliseconds. | …json:29 |
| core.shutdownBudgetMs | integer, min 1000 | 30000 | live | Maximum time the core spends on graceful shutdown, in milliseconds. | …json:31 |
| supervisor | object | {} | – | Timing settings used by the process supervisor. | …json:34 |
| supervisor.graceMs | integer, min 1000 | 60000 | live | Grace period given to a child process to exit during shutdown, in milliseconds. | …json:38 |
| supervisor.healthIntervalMs | integer, min 1000 | 5000 | live | Interval between child-process health checks, in milliseconds. | …json:39 |
| metrics | object | {} | – | D3: the read-only Prometheus text endpoint `GET /metrics` on a loopback address, protected by a bearer token kept in `state/metrics.token`. | …json:42 |
| metrics.enabled | boolean | false | core | Whether to expose the read-only Prometheus metrics endpoint. | …json:46 |
| metrics.port | integer, 1024–65535 | 9464 | core | Loopback port used by the metrics endpoint. | …json:47 |
| logs | object | {} | – | Retention limits for rotating harness log files. | …json:50 |
| logs.maxBytes | integer, min 1048576 | 20971520 | live | Maximum size of each log file before rotation, in bytes. | …json:54 |
| logs.keep | integer, min 1 | 5 | live | Number of rotated log files to retain. | …json:55 |
| agents | object (open map) | {} | live | Per-agent settings keyed by a lowercase agent identifier. | …json:58 |
| agents.<id> | object (open map entry) | – | geerbt: live (agents) | Settings for one agent. | …json:62 |
| agents.<id>.createdAt | string, date-time | – | geerbt: live (agents) | Timestamp when the agent was created, in date-time format. | …json:66 |
| agents.<id>.displayName | string, maxLength 128 | – | geerbt: live (agents) | Optional human-readable name for the agent. | …json:67 |
| agents.<id>.skills | object | – | live | Per-agent skill selection (X1-R11): `blocked` names skills this agent does not get although they are enabled installation-wide; `pinned` is stored and shown, not interpreted before D69; `applyAt` says when a change reaches a running agent. | …json:68 |
| agents.<id>.skills.blocked | array of string | [] | geerbt: live (skills) | Skill names this agent must not receive, even when enabled installation-wide. | …json:72 |
| agents.<id>.skills.pinned | array of string | [] | geerbt: live (skills) | Skill names pinned for this agent; currently stored and displayed but not interpreted. | …json:73 |
| agents.<id>.skills.applyAt | enum: next-turn, next-session | next-turn | geerbt: live (skills) | When a changed skill selection takes effect for a running agent. | …json:74 |
| extensions | object | {} | – | Extension management (X1-R21): whether unsigned packages may be installed, how many days uninstalled items stay in the trash, and the size caps for packages and skill folders. | …json:80 |
| extensions.allowUnsigned | boolean | true | live | Whether unsigned extension packages may be installed. | …json:84 |
| extensions.trashDays | integer, 1–365 | 14 | live | Number of days uninstalled extensions are retained in the trash. | …json:85 |
| extensions.limits | object | {} | – | Maximum unpacked sizes for extension packages and skill folders. | …json:86 |
| extensions.limits.packageBytes | integer, 1048576–1073741824 | 268435456 | live | Maximum size of an extension package, in bytes. | …json:90 |
| extensions.limits.skillBytes | integer, 1048576–1073741824 | 16777216 | live | Maximum size of an installed skill folder, in bytes. | …json:91 |
| embedding | object | {} | – | Embedding model use classification and non-commercial licence acknowledgement. | …json:96 |
| embedding.useClass | enum: general, research, commercial | general | core | Intended use of the embedding model: general, research, or commercial. | …json:100 |
| embedding.acceptedNcLicence | boolean | false | core | Whether the owner has accepted the model's non-commercial licence terms. | …json:101 |
| embedding.acceptedNcLicenceAt | string, date-time | – | core | Date-time when the non-commercial licence was accepted. | …json:102 |
| engine | object (pass-through) | {} | core | Pass-through to the engine's EngineConfig (57 keys, see docs/config-engine-keys.md). Every key here is class core until the engine declares readAt: live (engine PR E5). | …json:105 |
| engine.baseDbPathOverride | string | – | core | Testing/advanced only; default <home>/state/lancedb | …json:109 |
| providers | object (reserved, M2 D15) | {} | live | Reserved namespace for model-provider configuration. | …json:113 |
| oauth | object (reserved, M2 D16) | {} | live | Reserved namespace for OAuth configuration. | …json:114 |
| decision | object (reserved, M2 D18) | {} | live | Reserved namespace for decision model configuration. | …json:115 |
| modelRoles | object (map, reserved M2 D15/D18) | {} | live | Model identifiers assigned to the supported functional roles. | …json:116 |
| modelRoles.chat | string | – | geerbt: live (modelRoles) | Model identifier assigned to the role. | …json:119–120 |
| modelRoles.reasoning | string | – | geerbt: live (modelRoles) | Model identifier assigned to the role. | …json:119–120 |
| modelRoles.capture | string | – | geerbt: live (modelRoles) | Model identifier assigned to the role. | …json:119–120 |
| modelRoles.dream | string | – | geerbt: live (modelRoles) | Model identifier assigned to the role. | …json:119–120 |
| modelRoles.embedding | string | – | geerbt: live (modelRoles) | Model identifier assigned to the role. | …json:119–120 |
| modelRoles.rerank | string | – | geerbt: live (modelRoles) | Model identifier assigned to the role. | …json:119–120 |
| modelRoles.decision | string | – | geerbt: live (modelRoles) | Model identifier assigned to the role. | …json:119–120 |
| modelProfiles | object (open map) | {} | live | Named model profiles (C4): an ordered candidate list with weights for fallback or mixture-of-agents (moa) use, plus sampling parameters and cache hints. Data only; selection is the router's job. List order is priority order. | …json:122 |
| modelProfiles.<name> | object, requires `candidates` | – | geerbt: live (modelProfiles) | Configuration for one named model profile. | …json:127 |
| modelProfiles.<name>.displayName | string, 1–120 chars | – | geerbt: live (modelProfiles) | Optional human-readable profile name. | …json:130 |
| modelProfiles.<name>.strategy | enum: fallback, moa | fallback | geerbt: live (modelProfiles) | How candidates are used: try in priority order (fallback) or combine them (moa). | …json:131 |
| modelProfiles.<name>.candidates | array, 1–16 items | – | geerbt: live (modelProfiles) | Ordered model candidates; the first candidate has the highest priority. | …json:132 |
| modelProfiles.<name>.candidates[].model | string, 1–200 chars | – | geerbt: live (modelProfiles) | Model identifier for this candidate. | …json:139 |
| modelProfiles.<name>.candidates[].weight | number, >0 and ≤100 | 1 | geerbt: live (modelProfiles) | Relative contribution of this candidate when the moa strategy is used. | …json:140 |
| modelProfiles.<name>.aggregator | string, 1–200 chars | – | geerbt: live (modelProfiles) | Model identifier used to aggregate moa candidate outputs. | …json:144 |
| modelProfiles.<name>.params | object | {} | geerbt: live (modelProfiles) | Sampling and output-size parameters for this profile. | …json:145 |
| modelProfiles.<name>.params.temperature | number, 0–2 | – | geerbt: live (modelProfiles) | Sampling temperature, from 0 to 2. | …json:149 |
| modelProfiles.<name>.params.topP | number, >0 and ≤1 | – | geerbt: live (modelProfiles) | Nucleus-sampling probability threshold, greater than 0 and at most 1. | …json:150 |
| modelProfiles.<name>.params.maxTokens | integer, 1–2000000 | – | geerbt: live (modelProfiles) | Maximum number of output tokens. | …json:151 |
| modelProfiles.<name>.cache | object | {} | geerbt: live (modelProfiles) | Provider prompt-cache preference and optional time-to-live. | …json:154 |
| modelProfiles.<name>.cache.hint | enum: auto, none, prefer | auto | geerbt: live (modelProfiles) | Whether to use prompt caching automatically, never, or when preferred. | …json:158 |
| modelProfiles.<name>.cache.ttlSeconds | integer, 0–86400 | – | geerbt: live (modelProfiles) | Maximum cache lifetime, in seconds. | …json:159 |
| models | object | {} | – | Model discovery settings. | …json:171 |
| models.scan | object | {} | – | Schedule for periodic local model discovery scans. | …json:175 |
| models.scan.enabled | boolean | true | live | Whether periodic model discovery scans are enabled. | …json:179 |
| models.scan.intervalHours | integer, 1–168 | 24 | live | Hours between periodic model discovery scans. | …json:180 |
| secrets | object | {} | – | Secret store (M2, ADR-005). The OS keyring is always tried first. | …json:185 |
| secrets.fileFallback | object | {} | – | Settings for the encrypted-file secret-store fallback. | …json:189 |
| secrets.fileFallback.enabled | boolean | false | live | Use the encrypted file store (AES-256-GCM, machine-bound key file next to it) when the OS keyring is unavailable. Off until the owner decides ADR-005 Q3. | …json:193–195 |
| egress | object | {} | – | Outgoing network policy (B4). Default deny: nothing is reachable until a host is listed. https only (plain http only to a listed loopback host when allowLoopback is on); private, link-local and metadata addresses are refused after name resolution whatever is listed. | …json:201 |
| egress.allowHosts | array of string, max 256, unique | [] | live | Exact names, `*.suffix` (subdomains of any depth, not the apex), `*` (any name, never an IP literal) or an exact canonical IP literal (IPv6 in brackets). | …json:205–209 |
| egress.allowPorts | array of integer 1–65535, 1–64 items, unique | [443] | live | Destination ports allowed for outgoing requests. | …json:211–215 |
| egress.allowLoopback | boolean | false | live | Allow http(s) to loopback hosts (localhost, 127.0.0.0/8, ::1) that are also listed in allowHosts. A public name that resolves to loopback stays refused. | …json:217 |
| modules | object (open map) | {} | live | Per-module settings, keyed by module name (B13). A change restarts only that module; `enabled: false` keeps it stopped. | …json:223 |
| modules.<name> | object, additionalProperties true | – | module:$key | Settings for one installed module; unknown module-specific keys are retained. | …json:226–228 |
| modules.<name>.enabled | boolean | true | geerbt: module:<name> | Whether the module is allowed to run. | …json:229 |

## Zählung

Insgesamt **80** Schlüssel-Zeilen. Davon sind 7 feste Schlüssel unter `modelRoles` (aus der propertyNames-Enum), 3 offene Map-Platzhalter (`agents.<id>`, `modelProfiles.<name>`, `modules.<name>`) und 70 weitere feste Pfade. Die Engine-Pass-Through-Keys (`engine.*`, laut Schema 57 Keys in docs/config-engine-keys.md) sind hier nicht enumeriert, weil sie nicht im Schema stehen.

## Hinweise

- unklar – prüfen: `engine` verweist auf 57 Keys in docs/config-engine-keys.md. Diese Datei wurde nicht gelesen und ist nicht Teil dieser Liste.
- unklar – prüfen: `engine.baseDbPathOverride` nennt den Default nur im Beschreibungstext (`<home>/state/lancedb`). Ein Schema-`default` fehlt, deshalb steht `–` in der Default-Spalte.
- unklar – prüfen: Container ohne eigene `x-restart`-Angabe (`core`, `core.recall`, `core.capture`, `supervisor`, `metrics`, `logs`, `extensions`, `extensions.limits`, `embedding`, `models`, `models.scan`, `secrets`, `secrets.fileFallback`, `egress`) haben keine Klasse. Die Code-Logik fällt dann auf `core` zurück (crates/plur1bus-config/src/lib.rs:369). Die Spalte zeigt deshalb `–`.
- unklar – prüfen: `providers`, `oauth`, `decision` sind reserviert, haben keine benannten Properties und `additionalProperties: true`. Es gibt keine dokumentierten Unterschlüssel.
- unklar – prüfen: `modules.<name>` hat `additionalProperties: true`. Unbekannte modulspezifische Keys bleiben erhalten, deshalb sind sie hier nicht vollständig auflistbar.
- unklar – prüfen: `agents.<id>` und `modelProfiles.<name>` haben das propertyNames-Muster `^[a-z0-9][a-z0-9_-]{0,63}$`. Die `modelProfiles`-Constraints per allOf (aggregator erfordert strategy=moa, moa erfordert mindestens 2 candidates) sind hier nicht als eigene Zeilen aufgeführt.
- unklar – prüfen: `agents.<id>.skills.pinned` ist laut Beschreibung nur gespeichert, nicht interpretiert (vor D69).
- unklar – prüfen: `engine.baseDbPathOverride` ist `core`-Klasse, aber das `engine`-Objekt ist insgesamt als core markiert. Ob sich das nach E5 ändert, ist nicht ersichtlich.
