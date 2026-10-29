/** Live-Core preflight collects independent refusals. It has no stop/restart or target-mutation port. */
import { ImportError } from "./types.ts";

export interface ImportPreflightPlan {
  planId: string;
  runId: string;
  sourceSha256: string;
  unresolvedConflicts: number;
  migrateSecrets: boolean;
  importBytes: number;
  coldBytes: number;
  entities: number;
  reembed?: { model: string; licenceId?: string };
}

export interface ImportPreflightPorts {
  sourceFingerprint(): Promise<string>;
  /** Existing importer dry-run plus Supervisor config.set(dryRun:true), through the running Core's ports. */
  dryRun(): Promise<{ readable: boolean; parsed: boolean; configValid: boolean }>;
  /** Coverage comes from validated target configuration, including every configured external mutation root. */
  storage(): Promise<{ availableBytes: number; writable: boolean; foreignLock: boolean;
    completeCoverage: boolean; exclusiveWriter: boolean }>;
  /** Implemented by the running Core's existing Engine owner; never opens a second target Engine. */
  store(): Promise<{ supported: boolean }>;
  model(model: string, licenceId?: string): Promise<{ present: boolean; licenceAccepted: boolean }>;
  secrets(): Promise<{ available: boolean }>;
}

export interface ImportPreflightIssue { code: string; reason: string }
export interface ImportPreflightResult {
  planId: string;
  runId: string;
  ok: boolean;
  issues: ImportPreflightIssue[];
  estimatedDowntimeMs: number;
  requiredBytes: number;
  availableBytes: number;
  automaticRollback: boolean;
  /** Attached by the service only after durably binding a successful check to its immutable plan and Owner. */
  preflightId?: string;
  expiresAt?: string;
}

const RESERVE_BYTES = 64 * 1024 * 1024;
const ESTIMATED_COPY_BYTES_PER_MS = 64 * 1024;

function estimate(plan: ImportPreflightPlan) {
  const sizes = [plan.importBytes, plan.coldBytes, plan.entities, plan.unresolvedConflicts];
  if (sizes.some(size => !Number.isSafeInteger(size) || size < 0)
    || !Number.isSafeInteger(plan.importBytes + plan.coldBytes)) {
    throw new ImportError("E_INVALID_PARAMS", "plan-invalid", "Import plan is invalid");
  }
  const requiredBytes = Math.ceil((plan.importBytes + plan.coldBytes) * 1.2) + RESERVE_BYTES;
  if (!Number.isSafeInteger(requiredBytes)) {
    throw new ImportError("E_INVALID_PARAMS", "plan-invalid", "Import plan is invalid");
  }
  const estimatedDowntimeMs = Math.min(31 * 24 * 60 * 60 * 1000,
    Math.max(5000, Math.ceil((plan.importBytes + plan.coldBytes * 2) / ESTIMATED_COPY_BYTES_PER_MS)
      + plan.entities * (plan.reembed ? 1000 : 25) + 5000));
  return { requiredBytes, estimatedDowntimeMs };
}

/** The caller persists a short-lived, owner-bound ticket only if this complete result is ok. */
export async function preflightImport(plan: ImportPreflightPlan,
  ports: ImportPreflightPorts, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ImportPreflightResult> {
  const estimates = estimate(plan);
  const timeout = options.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) {
    throw new ImportError("E_INVALID_PARAMS", "preflight-limit-invalid", "Import preflight limit is invalid");
  }
  const deadline = Date.now() + timeout;
  const stage = async <T>(run: () => Promise<T>): Promise<T> => {
    options.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("Import preflight deadline");
    let timer: NodeJS.Timeout | undefined;
    let detach = () => {};
    try {
      return await Promise.race([Promise.resolve().then(run), new Promise<never>((_resolve, reject) => {
        const stop = () => reject(new Error("Import preflight stopped"));
        timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
        options.signal?.addEventListener("abort", stop, { once: true });
        detach = () => options.signal?.removeEventListener("abort", stop);
        if (options.signal?.aborted) stop();
      })]);
    } finally { clearTimeout(timer); detach(); }
  };
  const issues: ImportPreflightIssue[] = [];
  const issue = (reason: string, code = "E_IMPORT_FAILED") => {
    if (!issues.some(item => item.reason === reason)) issues.push({ code, reason });
  };
  if (estimates.estimatedDowntimeMs > 60 * 60 * 1000) issue("maintenance-time-limit", "E_LIMIT_EXCEEDED");
  const [source, dryRun, storage, store] = await Promise.allSettled([
    stage(ports.sourceFingerprint), stage(ports.dryRun), stage(ports.storage), stage(ports.store),
  ]);
  if (source.status === "rejected") issue("source-unreadable");
  else if (source.value !== plan.sourceSha256) issue("source-changed", "E_CONFLICT");
  if (plan.unresolvedConflicts) issue("unanswered-conflicts", "E_CONFLICT");
  if (dryRun.status === "rejected") {
    issue("source-parse-failed");
  } else {
    if (!dryRun.value.readable) issue("source-unreadable");
    if (!dryRun.value.parsed) issue("source-parse-failed");
    if (!dryRun.value.configValid) issue("config-invalid", "E_CONFIG_INVALID");
  }
  const capacity = storage.status === "fulfilled" ? storage.value : {
    availableBytes: 0, writable: false, foreignLock: true, completeCoverage: false, exclusiveWriter: false,
  };
  const availableBytes = Number.isSafeInteger(capacity.availableBytes) && capacity.availableBytes >= 0
    ? capacity.availableBytes : 0;
  if (availableBytes < estimates.requiredBytes) issue("insufficient-disk");
  if (!capacity.writable) issue("target-permissions");
  if (capacity.foreignLock) issue("busy", "E_CONFLICT");
  if (!capacity.completeCoverage) issue("incomplete-rollback-coverage");
  if (!capacity.exclusiveWriter) issue("exclusive-writer-unproven");
  if (store.status === "rejected" || !store.value.supported) issue("store-schema-unsupported");
  if (plan.reembed) {
    try {
      const model = await stage(() => ports.model(plan.reembed!.model, plan.reembed!.licenceId));
      if (!model.present) issue("embedding-model-unavailable", "E_NOT_AVAILABLE");
      if (!model.licenceAccepted) issue("model-licence-required", "E_DENIED");
    } catch {
      issue("embedding-model-unavailable", "E_NOT_AVAILABLE");
      issue("model-licence-required", "E_DENIED");
    }
  }
  if (plan.migrateSecrets) {
    try {
      if (!(await stage(ports.secrets)).available) issue("secret-store-unavailable", "E_NOT_AVAILABLE");
    } catch {
      issue("secret-store-unavailable", "E_NOT_AVAILABLE");
    }
  }
  return { planId: plan.planId, runId: plan.runId, ok: issues.length === 0, issues, ...estimates, availableBytes,
    automaticRollback: capacity.completeCoverage && capacity.exclusiveWriter };
}
