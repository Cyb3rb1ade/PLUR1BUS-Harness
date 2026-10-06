// ADR-014: the shapes the MCP client layer exchanges with its callers (the 2c turn loop, X2, the RPC handlers).

export type McpScope = { kind: "installation" } | { kind: "agent"; agentId: string };

/** D19 origin trust. RULING: `untrusted` is the default and the only value a server definition gets unless the
 *  installation's configuration says `operator-vetted`; it describes the origin, not the caller (ADR-014 §3). */
export type McpTrust = "untrusted" | "operator-vetted";

export type McpTransportConfig =
  | { type: "stdio"; command: string; args: string[]; cwd?: string; env: Record<string, string>; fromHost: string[] }
  | { type: "http"; url: string; headers: Record<string, string> };

export interface McpTimeouts {
  /** Spawn (or HTTP open) plus `initialize`. */
  connectMs: number;
  listMs: number;
  callMs: number;
  /** After the graceful close or SIGTERM: how long a stdio child may take to exit before SIGKILL. */
  closeGraceMs: number;
}

export const DEFAULT_TIMEOUTS: McpTimeouts = { connectMs: 30_000, listMs: 15_000, callMs: 60_000, closeGraceMs: 2_000 };
export const DEFAULT_IDLE_MS = 15 * 60_000;
export const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;
export const MAX_LIST_PAGES = 50;

export interface McpServerDefinition {
  name: string;
  scope: McpScope;
  transport: McpTransportConfig;
  trust: McpTrust;
  timeouts: McpTimeouts;
}

/** Who a call runs for. `principal` is the opaque principal identity the call runs under (D17). */
export interface McpCaller { agentId: string; principal: string }

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** D17 MCP Apps: set when the tool's metadata names a `ui://` resource. 2b only reports it. */
  uiResourceUri?: string;
}

export interface McpProvenance {
  origin: { system: string; agent: string | null; principal: string; trust: McpTrust };
  hops: number;
  transformedBy: string[];
}

export interface McpToolResult {
  provenance: McpProvenance;
  server: string;
  tool: string;
  isError: boolean;
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
}

export type McpServerState = "stopped" | "starting" | "running";

export interface McpServerStatus {
  name: string;
  scope: McpScope;
  transport: "stdio" | "http";
  trust: McpTrust;
  state: McpServerState;
  /** Lifetime counts, so "never started" and "restarted" are visible. */
  starts: number;
  pid: number | null;
  lastActivityAt: number | null;
  /** Clock time at which the idle timer will stop the server; null when stopped or a call is in flight. */
  idleStopsAt: number | null;
  inFlight: number;
  lastError: { code: string; message: string; at: number } | null;
  /** Tool-schema cache: null until the first listing. Present while the server is stopped. */
  cache: { tools: number; toolNames: string[]; schemaTokensEstimate: number; fetchedAt: number; stale: boolean } | null;
  stderrLines: number;
}

export interface McpLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface McpPolicy {
  /** ADR-014 §7. Empty by default: no stdio server can start. */
  allowedCommands: readonly string[];
  idleTimeoutMs: number;
  maxResultBytes: number;
}
