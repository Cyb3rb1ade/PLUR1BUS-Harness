/** Legacy/full-worker agent migration supplies writes to the shared read planner. */
import { createAgentMutations } from "../agent-mutations.ts";
import { planOpenclawAgent } from "./openclaw-agent-plan.ts";
import type { Layout } from "../../paths.ts";
import type { AgentInfo } from "../types.ts";
import type { SourceReader } from "../source-reader.ts";
import type { ConflictStrategy, ImportLedger } from "../ledger.ts";
export { validateAgentId, MAX_FILE_BYTES } from "./openclaw-agent-plan.ts";
export type { AgentImportReport, ImportedFileReport } from "./openclaw-agent-plan.ts";

export function planAndMigrateAgent(agent: AgentInfo, sourceRoot: string, layout: Layout,
  existingAgentIds: Set<string>, apply: boolean, defaultConflict: ConflictStrategy = "skip", ledger?: ImportLedger,
  replacedBackupDir?: string, sourceReader?: SourceReader, chooseConflict?: (targetFile: string) => ConflictStrategy) {
  return planOpenclawAgent(agent, sourceRoot, layout, existingAgentIds, apply ? createAgentMutations() : undefined,
    defaultConflict, ledger, replacedBackupDir, sourceReader, chooseConflict);
}
