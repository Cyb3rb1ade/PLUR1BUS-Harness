// ADR-014 §2: the tool-schema cache survives the idle stop of the process it came from. Memory-only in 2b
// (RULING: persisting it across core restarts is a follow-up).
import type { McpToolDescriptor } from "./types.ts";

export interface CacheSummary { tools: number; toolNames: string[]; schemaTokensEstimate: number; fetchedAt: number; stale: boolean }

/** RULING: a visible estimate, not a count: characters / 4 of the serialised descriptors (ADR-008 asks for a per-server
 *  schema cost; the model-specific token count is a 2c concern). */
export const estimateSchemaTokens = (tools: readonly McpToolDescriptor[]): number => Math.ceil(JSON.stringify(tools).length / 4);

export class SchemaCache {
  private tools: McpToolDescriptor[] = [];
  private fetchedAt = 0;
  private isStale = false;
  private filled = false;

  get present(): boolean { return this.filled; }
  /** Usable without asking the server. */
  get fresh(): boolean { return this.filled && !this.isStale; }
  get(): readonly McpToolDescriptor[] { return this.tools; }
  has(name: string): boolean { return this.tools.some((t) => t.name === name); }

  set(tools: McpToolDescriptor[], now: number): void { this.tools = tools; this.fetchedAt = now; this.isStale = false; this.filled = true; }
  /** `notifications/tools/list_changed`: keep the entry (status still shows it) but refetch before the next use. */
  markStale(): void { this.isStale = true; }

  summary(): CacheSummary | null {
    if (!this.filled) return null;
    return { tools: this.tools.length, toolNames: this.tools.map((t) => t.name), schemaTokensEstimate: estimateSchemaTokens(this.tools), fetchedAt: this.fetchedAt, stale: this.isStale };
  }
}
