// External-agent record (ADR-003 Q4): stateless, one connector id, a turn and runtime budget.
// `memoryExposure.acp` is package P's channel. It is stored on the agent and never placed on the ACP wire.

export const CONNECTORS = ["claude-code", "codex", "goose", "agy"] as const;
export type ConnectorId = (typeof CONNECTORS)[number];

export interface ExternalEngineConfig {
  kind: "external";
  connector: ConnectorId;
  maxTurns?: number;
  timeoutMs?: number;
}

/** What an external agent may read once P attaches the harness MCP server. Not serialised into initialize or session/new. */
export interface AcpMemoryExposure {
  read: readonly ["workspace", "user", "project"];
  write: false;
  /** All five personal categories stay filtered. Package P names them; this record only records the filter. */
  personalFiltered: true;
  credentials: "filtered";
}

export function acpMemoryExposure(): AcpMemoryExposure {
  return { read: ["workspace", "user", "project"], write: false, personalFiltered: true, credentials: "filtered" };
}

export interface ResolvedEngine {
  kind: "external";
  connector: ConnectorId;
  maxTurns: number;
  timeoutMs: number;
}

const CONNECTOR_SET = new Set<string>(CONNECTORS);

/** `null` when the agent is not external. An external record with a bad connector still returns `kind`, so the local runner does not take the call. */
export function readEngine(agent: { engine?: Partial<ExternalEngineConfig> } | undefined): ResolvedEngine | { kind: "external"; connector: null } | null {
  const engine = agent?.engine;
  if (!engine || engine.kind !== "external") return null;
  if (typeof engine.connector !== "string" || !CONNECTOR_SET.has(engine.connector)) return { kind: "external", connector: null };
  const maxTurns = engine.maxTurns ?? 20;
  const timeoutMs = engine.timeoutMs ?? 600_000;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200) return { kind: "external", connector: null };
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) return { kind: "external", connector: null };
  return { kind: "external", connector: engine.connector as ConnectorId, maxTurns, timeoutMs };
}

/** B5 fills the real commands. Until then no connector has an argv, so nothing is spawned by accident. */
export function connectorArgv(_connector: ConnectorId): readonly string[] | null {
  return null;
}
