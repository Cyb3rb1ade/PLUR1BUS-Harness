/** Private supervised-import metadata. None of these records carries source contents or credential values. */
export type MaintenancePhase = "prepared" | "snapshotting" | "snapshot-complete" | "applying"
  | "committed" | "rolling-back" | "restored";
export type MaintenanceReason = "apply-failed" | "aborted" | "restore-failed" | "source-changed"
  | "target-changed" | "manual-rollback" | "automatic-rollback" | "recovered";

export interface MaintenanceHistory {
  attempt: number;
  phase: MaintenancePhase;
  at: string;
  reason?: MaintenanceReason;
}

export interface MaintenanceSecretIntent {
  name: string;
  absentBefore: true;
  created: boolean;
  removed: boolean;
}

export interface MaintenanceJournal {
  schema: "import.maintenance/1";
  runId: string;
  attempt: number;
  phase: MaintenancePhase;
  snapshotSha256?: string;
  targetSha256?: string;
  history: MaintenanceHistory[];
  secrets: MaintenanceSecretIntent[];
}

export interface MaintenanceCheckpoint {
  snapshotSha256?: string;
  targetSha256?: string;
  reason?: MaintenanceReason;
}

/** Progress counts and closed labels can be relayed without inspecting or printing imported data. */
export interface ImportProgress {
  runId: string;
  phase: "detect" | "plan" | "preflight" | "snapshot" | "apply" | "rollback" | "verify" | "complete";
  completed: number;
  total?: number;
  entity?: "agent" | "skill" | "memory" | "store" | "config" | "secret" | "extension";
}
