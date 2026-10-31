export const MEMORY_EXPORT_CATEGORIES = [
  "Instructions",
  "Identity",
  "Career",
  "Projects",
  "Preferences",
  "Other",
] as const;

export type MemoryExportCategory = (typeof MEMORY_EXPORT_CATEGORIES)[number];

export type SourceType = "memory" | "chat" | "unknown";

export interface ParsedEntry {
  category: MemoryExportCategory;
  sourceType: SourceType;
  recordedAt?: string | undefined;
  text: string;
  warnings: string[];
  idempotencyKey: string;
}

export interface ParsedMemoryExport {
  entries: ParsedEntry[];
  status: "complete" | "more" | "unrecognized";
  warnings: string[];
}

export type TargetKind = "skip" | "user" | "agent" | "workspace" | "propose-rule";

export interface EntryTarget {
  target: TargetKind;
  agentIds?: string[] | undefined;
  workspaceId?: string | undefined;
  reason?: string | undefined;
}

export interface RecommendContext {
  availableAgents: string[];
  currentAgentId?: string;
  hasUserBinding: boolean;
}

export interface PromptImportResult {
  runId: string;
  imported: number;
  linked: number;
  proposedRules: number;
  skipped: number;
  reportPath: string;
}

export interface PromptRollbackResult {
  rolledBack: number;
  discardedProposals: number;
  unhandledProposals: number;
}
