// The settings catalogue behind the palette's "Settings" group: a static subset of `packages/config-schema/schema/config.schema.json`
// (the schema of config.json, `config.get` / `config.set` in docs/rpc.md; docs/config.md for the tiers). The schema package is NOT
// imported: it pulls ajv and Node code, and the bundle must not. test/palette-index.test.ts reads the schema file and fails when
// this list drifts from it (a key added, removed, or its tier or help changed), so regenerate the rows when it does.
//
// What is real: key, type, tier and help text, all copied from the schema. A key is listed when it is a leaf or carries an
// `x-tier` (objects such as `agents` or `modules` are edited as a whole). `help` is the node's own `description`, else its nearest
// ancestor's (so `metrics.port` carries the description of `metrics`). `$schema` and `schemaVersion` are not settings.
// What is NOT available: localised labels. The schema has no titles, so the label is derived from the last key segment
// (`softBudgetMs` -> "Soft budget ms") and help stays in the schema's English. A localised catalogue needs schema titles or an
// owner-approved UI catalogue (follow-up).
export type SettingSpec = { readonly key: string; readonly type: string; readonly tier: "basic" | "advanced"; readonly help?: string };

export const SETTINGS: readonly SettingSpec[] = [
  { key: "core.logLevel", type: "enum", tier: "advanced", help: "Minimum severity written to the core log." },
  { key: "core.recall.softBudgetMs", type: "integer", tier: "advanced", help: "Soft target duration for a recall, in milliseconds." },
  { key: "core.recall.hardBudgetMs", type: "integer", tier: "advanced", help: "Maximum duration allowed for a recall before it is aborted, in milliseconds." },
  { key: "core.recall.capChars", type: "integer", tier: "advanced", help: "Maximum number of characters returned by a recall." },
  { key: "core.capture.waitMs", type: "integer", tier: "advanced", help: "Maximum time to wait for a memory capture, in milliseconds." },
  { key: "core.shutdownBudgetMs", type: "integer", tier: "advanced", help: "Maximum time the core spends on graceful shutdown, in milliseconds." },
  { key: "supervisor.graceMs", type: "integer", tier: "advanced", help: "Grace period given to a child process to exit during shutdown, in milliseconds." },
  { key: "supervisor.healthIntervalMs", type: "integer", tier: "advanced", help: "Interval between child-process health checks, in milliseconds." },
  { key: "metrics.enabled", type: "boolean", tier: "advanced", help: "Whether to expose the read-only Prometheus metrics endpoint." },
  { key: "metrics.port", type: "integer", tier: "advanced", help: "Loopback port used by the metrics endpoint." },
  { key: "logs.maxBytes", type: "integer", tier: "advanced", help: "Maximum size of each log file before rotation, in bytes." },
  { key: "logs.keep", type: "integer", tier: "advanced", help: "Number of rotated log files to retain." },
  { key: "agents", type: "object", tier: "basic", help: "Per-agent settings keyed by a lowercase agent identifier." },
  { key: "extensions.allowUnsigned", type: "boolean", tier: "advanced", help: "Whether unsigned extension packages may be installed." },
  { key: "extensions.trashDays", type: "integer", tier: "advanced", help: "Number of days uninstalled extensions are retained in the trash." },
  { key: "extensions.limits.packageBytes", type: "integer", tier: "advanced", help: "Maximum size of an extension package, in bytes." },
  { key: "extensions.limits.skillBytes", type: "integer", tier: "advanced", help: "Maximum size of an installed skill folder, in bytes." },
  { key: "embedding.useClass", type: "enum", tier: "basic", help: "Intended use of the embedding model: general, research, or commercial." },
  { key: "embedding.acceptedNcLicence", type: "boolean", tier: "advanced", help: "Whether the owner has accepted the model's non-commercial licence terms." },
  { key: "embedding.acceptedNcLicenceAt", type: "string", tier: "advanced", help: "Date-time when the non-commercial licence was accepted." },
  { key: "engine", type: "object", tier: "advanced", help: "Pass-through to the engine's EngineConfig (57 keys, see docs/config-engine-keys.md). Every key here is class core until the engine declares readAt: live (engine PR E5)." },
  { key: "engine.baseDbPathOverride", type: "string", tier: "advanced", help: "Testing/advanced only; default <home>/state/lancedb" },
  { key: "providers", type: "object", tier: "basic", help: "Reserved namespace for model-provider configuration." },
  { key: "oauth", type: "object", tier: "advanced", help: "Reserved namespace for OAuth configuration." },
  { key: "decision", type: "object", tier: "advanced", help: "Reserved namespace for decision model configuration." },
  { key: "modelRoles", type: "object", tier: "basic", help: "Model identifiers assigned to the supported functional roles." },
  { key: "modelProfiles", type: "object", tier: "advanced", help: "Named model profiles (C4): an ordered candidate list with weights for fallback or mixture-of-agents (moa) use, plus sampling parameters and cache hints. Data only; selection is the router's job. List order is priority order." },
  { key: "models.scan.enabled", type: "boolean", tier: "advanced", help: "Whether periodic model discovery scans are enabled." },
  { key: "models.scan.intervalHours", type: "integer", tier: "advanced", help: "Hours between periodic model discovery scans." },
  { key: "secrets.fileFallback.enabled", type: "boolean", tier: "advanced", help: "Use the encrypted file store (AES-256-GCM, machine-bound key file next to it) when the OS keyring is unavailable. Off until the owner decides ADR-005 Q3." },
  { key: "egress.allowHosts", type: "array", tier: "advanced", help: "Exact names, `*.suffix` (subdomains of any depth, not the apex), `*` (any name, never an IP literal) or an exact canonical IP literal (IPv6 in brackets)." },
  { key: "egress.allowPorts", type: "array", tier: "advanced", help: "Destination ports allowed for outgoing requests." },
  { key: "egress.allowLoopback", type: "boolean", tier: "advanced", help: "Allow http(s) to loopback hosts (localhost, 127.0.0.0/8, ::1) that are also listed in allowHosts. A public name that resolves to loopback stays refused." },
  { key: "modules", type: "object", tier: "advanced", help: "Per-module settings, keyed by module name (B13). A change restarts only that module; `enabled: false` keeps it stopped." },
];
