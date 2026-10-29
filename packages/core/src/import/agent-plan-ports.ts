/** Planning knows only an optional private mutation capability; Core never receives its implementation. */
import type { Layout } from "../paths.ts";

export interface AgentMutations {
  mkdir(path: string, options: { recursive?: boolean; mode?: number }): void;
  writeAtomic(path: string, content: string | Buffer, mode?: number): void;
  writeKnowledge(workspace: string, content: Buffer, home: string): void;
  scaffold(layout: Layout, agentId: string): void;
}
