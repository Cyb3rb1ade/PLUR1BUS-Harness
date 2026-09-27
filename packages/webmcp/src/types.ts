// Platform-neutral types shared by the provider (M3 GUI) and the consumer (browser bridge). These are
// the package's own canonical shapes; every difference between WebMCP draft revisions is handled in
// adapter.ts, never here or in the callers.

/** JSON Schema object (2020-12 subset the RPC schema uses). */
export type JsonSchema = Record<string, unknown>;

/** WebMCP ToolAnnotations (CG draft 2026-09-26). All hints default to false in the draft. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  consequentialHint?: boolean;
}

/** MCP-style tool result: what a WebMCP `execute` callback resolves to. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** What `execute` gets as its second argument, normalised across draft revisions by the adapter:
 *  the current draft passes `{ signal }`; the early (Chrome 146 flag) shape passed a client object
 *  with `requestUserInteraction(cb)`. */
export interface ExecuteContext {
  signal?: AbortSignal;
  requestUserInteraction?: <T>(callback: () => Promise<T> | T) => Promise<T>;
}

/** The package's canonical tool shape. `adapter.toNativeTool` turns it into what a browser accepts. */
export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  execute(input: unknown, context?: ExecuteContext): Promise<ToolResult>;
}
