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
  { key: "core.logLevel", type: "enum", tier: "advanced" },
  { key: "core.recall.softBudgetMs", type: "integer", tier: "advanced" },
  { key: "core.recall.hardBudgetMs", type: "integer", tier: "advanced" },
  { key: "core.recall.capChars", type: "integer", tier: "advanced" },
  { key: "core.capture.waitMs", type: "integer", tier: "advanced" },
  { key: "core.shutdownBudgetMs", type: "integer", tier: "advanced" },
  { key: "supervisor.graceMs", type: "integer", tier: "advanced" },
  { key: "supervisor.healthIntervalMs", type: "integer", tier: "advanced" },
  { key: "metrics.enabled", type: "boolean", tier: "advanced", help: "D3: the read-only Prometheus text endpoint `GET /metrics` on a loopback address, protected by a bearer token kept in `state/metrics.token`." },
  { key: "metrics.port", type: "integer", tier: "advanced", help: "D3: the read-only Prometheus text endpoint `GET /metrics` on a loopback address, protected by a bearer token kept in `state/metrics.token`." },
  { key: "logs.maxBytes", type: "integer", tier: "advanced" },
  { key: "logs.keep", type: "integer", tier: "advanced" },
  { key: "agents", type: "object", tier: "basic" },
  { key: "extensions.allowUnsigned", type: "boolean", tier: "advanced", help: "Extension management (X1-R21): whether unsigned packages may be installed, how many days uninstalled items stay in the trash, and the size caps for packages and skill folders." },
  { key: "extensions.trashDays", type: "integer", tier: "advanced", help: "Extension management (X1-R21): whether unsigned packages may be installed, how many days uninstalled items stay in the trash, and the size caps for packages and skill folders." },
  { key: "extensions.limits.packageBytes", type: "integer", tier: "advanced", help: "Extension management (X1-R21): whether unsigned packages may be installed, how many days uninstalled items stay in the trash, and the size caps for packages and skill folders." },
  { key: "extensions.limits.skillBytes", type: "integer", tier: "advanced", help: "Extension management (X1-R21): whether unsigned packages may be installed, how many days uninstalled items stay in the trash, and the size caps for packages and skill folders." },
  { key: "embedding.useClass", type: "enum", tier: "basic" },
  { key: "embedding.acceptedNcLicence", type: "boolean", tier: "advanced" },
  { key: "embedding.acceptedNcLicenceAt", type: "string", tier: "advanced" },
  { key: "engine", type: "object", tier: "advanced", help: "Pass-through to the engine's EngineConfig (57 keys, see docs/config-engine-keys.md). Every key here is class core until the engine declares readAt: live (engine PR E5)." },
  { key: "engine.baseDbPathOverride", type: "string", tier: "advanced", help: "Testing/advanced only; default <home>/state/lancedb" },
  { key: "providers", type: "object", tier: "basic" },
  { key: "oauth", type: "object", tier: "advanced" },
  { key: "decision", type: "object", tier: "advanced" },
  { key: "modelRoles", type: "object", tier: "basic" },
  { key: "modelProfiles", type: "object", tier: "advanced", help: "Named model profiles (C4): an ordered candidate list with weights for fallback or mixture-of-agents (moa) use, plus sampling parameters and cache hints. Data only; selection is the router's job. List order is priority order." },
  { key: "models.scan.enabled", type: "boolean", tier: "advanced" },
  { key: "models.scan.intervalHours", type: "integer", tier: "advanced" },
  { key: "secrets.fileFallback.enabled", type: "boolean", tier: "advanced", help: "Use the encrypted file store (AES-256-GCM, machine-bound key file next to it) when the OS keyring is unavailable. Off until the owner decides ADR-005 Q3." },
  { key: "egress.allowHosts", type: "array", tier: "advanced", help: "Exact names, `*.suffix` (subdomains of any depth, not the apex), `*` (any name, never an IP literal) or an exact canonical IP literal (IPv6 in brackets)." },
  { key: "egress.allowPorts", type: "array", tier: "advanced", help: "Outgoing network policy (B4). Default deny: nothing is reachable until a host is listed. https only (plain http only to a listed loopback host when allowLoopback is on); private, link-local and metadata addresses are refused after name resolution whatever is listed." },
  { key: "egress.allowLoopback", type: "boolean", tier: "advanced", help: "Allow http(s) to loopback hosts (localhost, 127.0.0.0/8, ::1) that are also listed in allowHosts. A public name that resolves to loopback stays refused." },
  { key: "modules", type: "object", tier: "advanced", help: "Per-module settings, keyed by module name (B13). A change restarts only that module; `enabled: false` keeps it stopped." },
];
