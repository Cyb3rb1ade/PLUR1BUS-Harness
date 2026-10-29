/** Offline full-import file writes. The live Core preview graph never imports this capability. */
import { mkdirSync } from "node:fs";
import { scaffoldFiles } from "../agents.ts";
import { writeImportedKnowledge } from "../knowledge/file.ts";
import { writeAtomicSync } from "./fs-atomic.ts";
import type { AgentMutations } from "./agent-plan-ports.ts";

export function createAgentMutations(): AgentMutations {
  return { mkdir: mkdirSync, writeAtomic: writeAtomicSync, writeKnowledge: writeImportedKnowledge, scaffold: scaffoldFiles };
}
