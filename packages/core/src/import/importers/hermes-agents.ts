/** Legacy/full-worker profile migration supplies writes to the shared read planner. */
import { createAgentMutations } from "../agent-mutations.ts";
import { planHermesAgent } from "./hermes-agent-plan.ts";
import type { Layout } from "../../paths.ts";
import type { SourceReader } from "../source-reader.ts";
import type { ConflictStrategy, ImportLedger } from "../ledger.ts";

export function planAndMigrateHermesAgent(agentId: string, profileDir: string, sourceRoot: string, layout: Layout,
  existingAgentIds: Set<string>, apply: boolean, defaultConflict: ConflictStrategy = "skip", ledger?: ImportLedger,
  replacedBackupDir?: string, userBound = false, sourceReader?: SourceReader,
  chooseConflict?: (targetFile: string) => ConflictStrategy) {
  return planHermesAgent(agentId, profileDir, sourceRoot, layout, existingAgentIds,
    apply ? createAgentMutations() : undefined, defaultConflict, ledger, replacedBackupDir, userBound, sourceReader, chooseConflict);
}
