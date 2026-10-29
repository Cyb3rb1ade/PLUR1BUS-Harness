/** Maintenance orchestration only: existing importers keep their business logic and injected Engine ownership. */
import { createHash } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { layout } from "../paths.ts";
import { acquireLock } from "./skills-registry.ts";
import { withTargetLock } from "./single-writer.ts";
import { openMaintenanceJournal, type ImportMaintenanceJournal } from "./maintenance-journal.ts";
import { createColdSnapshot, fingerprintMutationRoots, restoreColdSnapshot, type MutationRoot } from "./maintenance-snapshot.ts";
import { noLinkedSegments, readColdBytes, syncDirectory } from "./maintenance-files.ts";
import type { ImportProgress, MaintenanceReason } from "./maintenance-types.ts";

export interface ImportMaintenanceResult {
  ok: boolean;
  status: "completed" | "aborted" | "failed";
  restored: boolean;
  resumable: boolean;
  error?: { code: string; reason: string };
  report?: { schema: string; sha256: string; bytes: number };
}

export interface ImportMaintenanceOptions {
  home: string;
  runId: string;
  mode: "apply" | "rollback" | "recover";
  roots: readonly MutationRoot[];
  apply: () => Promise<void>;
  restoreConfig: (sha256: string | null) => Promise<void>;
  signal?: AbortSignal;
  maxSnapshotBytes?: number;
  /** Copied from the authenticated, consumed preflight ticket by the private Supervisor job controller. */
  expectedTargetSha256?: string;
  attempt?: number;
  /** Private same-job undo after a late abort or failed restart; never accepted from public import parameters. */
  automaticRollback?: true;
  onProgress?: (event: ImportProgress) => void | Promise<void>;
  verifySource?: () => Promise<void>;
  closeResources?: () => Promise<void>;
  /** Missing-only backend rollback uses durable intent plus this run's backend ownership metadata. */
  rollbackSecrets?: (journal: ImportMaintenanceJournal) => Promise<void>;
}

async function configBytes(home: string): Promise<Buffer | null> {
  const path = join(home, "config.json");
  const exists = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  });
  return exists ? readColdBytes(path, 4 * 1024 * 1024) : null;
}

export async function fingerprintImportTarget(home: string, mutationRoots: readonly MutationRoot[],
  signal?: AbortSignal): Promise<string> {
  const roots = await fingerprintMutationRoots(mutationRoots, signal);
  const config = await configBytes(home);
  return createHash("sha256").update(roots).update(config === null ? "absent" : "present")
    .update(config ?? Buffer.alloc(0)).digest("hex");
}

const targetFingerprint = (options: ImportMaintenanceOptions) => fingerprintImportTarget(options.home, options.roots);

async function resetAppliedReceipts(options: ImportMaintenanceOptions, attempt: number): Promise<void> {
  const run = join(options.home, "imports", options.runId);
  const history = join(run, "attempts");
  await noLinkedSegments(history, true);
  await mkdir(history, { recursive: true, mode: 0o700 });
  for (const name of ["ledger.jsonl", "extensions.json", "runtime.json"]) {
    const path = join(run, name);
    const present = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (!present) continue;
    if (!present.isFile() || present.isSymbolicLink()) throw new Error("unsafe receipt");
    const archived = join(history, `${attempt}-${name}`);
    // Retry after interruption must not replace the original attempt's durable history.
    const prior = await lstat(archived).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (prior) await rm(path);
    else await rename(path, archived);
  }
  await syncDirectory(history);
  await syncDirectory(run);
}

async function emit(options: ImportMaintenanceOptions, phase: ImportProgress["phase"], completed: number) {
  await options.onProgress?.({ runId: options.runId, phase, completed });
}

async function restore(options: ImportMaintenanceOptions, journal: ImportMaintenanceJournal,
  reason: MaintenanceReason): Promise<ImportMaintenanceResult> {
  const successful = reason === "manual-rollback" || reason === "automatic-rollback";
  const status = reason === "aborted" ? "aborted" : successful ? "completed" : "failed";
  try {
    const state = journal.read();
    if (state.phase !== "rolling-back") journal.advance("rolling-back", { reason });
    // A broken progress pipe must not stop restoration of an already mutated target.
    await emit(options, "rollback", 0).catch(() => {});
    await restoreColdSnapshot({ home: options.home, runId: options.runId, roots: options.roots,
      sha256: journal.read().snapshotSha256!, restoreConfig: options.restoreConfig });
    await options.rollbackSecrets?.(journal);
    if (journal.read().secrets.some(secret => secret.created && !secret.removed)) throw new Error("secret restore pending");
    await resetAppliedReceipts(options, state.attempt);
    journal.advance("restored", { reason, targetSha256: await targetFingerprint(options) });
    await emit(options, "complete", 1).catch(() => {});
    return { ok: successful, status, restored: true, resumable: reason !== "manual-rollback",
      ...successful ? {} : { error: { code: "E_IMPORT_FAILED", reason } } };
  } catch {
    return { ok: false, status: "failed", restored: false, resumable: true,
      error: { code: "E_IMPORT_FAILED", reason: "restore-failed" } };
  }
}

async function execute(options: ImportMaintenanceOptions): Promise<ImportMaintenanceResult> {
  if (options.automaticRollback && options.mode !== "rollback") {
    return { ok: false, status: "failed", restored: false, resumable: false,
      error: { code: "E_INVALID_PARAMS", reason: "automatic-rollback-invalid" } };
  }
  const journal = openMaintenanceJournal(options.home, options.runId);
  let closed = false;
  const close = async () => {
    if (closed) return;
    await options.closeResources?.();
    closed = true;
  };
  let initial = journal.read();
  const canResume = () => initial.phase === "restored" || initial.phase === "prepared" && !initial.snapshotSha256
    && ["aborted", "recovered", "apply-failed", "source-changed", "target-changed"]
      .includes(initial.history.at(-1)?.reason ?? "");
  let resumed = false;
  if (options.attempt !== undefined && options.attempt !== initial.attempt) {
    if (options.attempt !== initial.attempt + 1 || !canResume()) {
      return { ok: false, status: "failed", restored: false, resumable: false,
        error: { code: "E_CONFLICT", reason: "attempt-changed" } };
    }
    if (options.mode === "apply" && initial.targetSha256 && await targetFingerprint(options) !== initial.targetSha256) {
      return { ok: false, status: "failed", restored: false, resumable: false,
        error: { code: "E_CONFLICT", reason: "target-changed" } };
    }
    journal.resume();
    initial = journal.read();
    resumed = true;
  }
  const dirty = ["applying", "rolling-back", "snapshot-complete"].includes(initial.phase)
    || !!initial.snapshotSha256 && ["prepared", "snapshotting"].includes(initial.phase)
      && (!resumed || options.mode === "recover");
  if (options.mode !== "recover" && !options.automaticRollback && !dirty && options.expectedTargetSha256
    && await targetFingerprint(options) !== options.expectedTargetSha256) {
    if (["prepared", "snapshotting"].includes(initial.phase) && !initial.snapshotSha256) {
      journal.abortBeforeSnapshot("target-changed");
    }
    return { ok: false, status: "failed", restored: false, resumable: true,
      error: { code: "E_CONFLICT", reason: "target-changed" } };
  }
  if (options.mode === "rollback") {
    if (options.automaticRollback) {
      if (initial.phase === "restored") return { ok: true, status: "completed", restored: true, resumable: true };
      if (initial.snapshotSha256 && (initial.phase === "committed" || dirty)) {
        await close();
        return restore(options, journal, "automatic-rollback");
      }
      return { ok: false, status: "failed", restored: false, resumable: true,
        error: { code: "E_CONFLICT", reason: "automatic-rollback-invalid" } };
    }
    if (initial.phase !== "committed" || await targetFingerprint(options) !== initial.targetSha256) {
      return { ok: false, status: "failed", restored: false, resumable: false,
        error: { code: "E_CONFLICT", reason: "target-changed" } };
    }
    await close();
    return restore(options, journal, "manual-rollback");
  }
  if (dirty) {
    await close();
    return restore(options, journal, "recovered");
  }
  if (options.mode === "recover") {
    if (["prepared", "snapshotting"].includes(initial.phase) && !initial.snapshotSha256) {
      journal.abortBeforeSnapshot("recovered");
      return { ok: true, status: "completed", restored: true, resumable: true };
    }
    return { ok: initial.phase === "committed" || initial.phase === "restored", status: "completed",
      restored: initial.phase === "restored", resumable: initial.phase !== "committed" };
  }
  if (initial.phase === "committed") {
    return { ok: false, status: "failed", restored: false, resumable: false,
      error: { code: "E_CONFLICT", reason: "already-completed" } };
  }
  if (canResume() && initial.targetSha256
    && await targetFingerprint(options) !== initial.targetSha256) {
    return { ok: false, status: "failed", restored: false, resumable: false,
      error: { code: "E_CONFLICT", reason: "target-changed" } };
  }
  if (canResume() && !resumed) journal.resume();
  try {
    options.signal?.throwIfAborted();
    await options.verifySource?.();
    const baselineTargetSha256 = await targetFingerprint(options);
    if (journal.read().phase === "prepared") journal.advance("snapshotting", { targetSha256: baselineTargetSha256 });
    await emit(options, "snapshot", 0);
    const snapshot = await createColdSnapshot({ home: options.home, runId: options.runId, roots: options.roots,
      config: await configBytes(options.home), ...(options.signal ? { signal: options.signal } : {}),
      ...(journal.read().snapshotSha256 ? { expectedSha256: journal.read().snapshotSha256! } : {}),
      ...(options.maxSnapshotBytes === undefined ? {} : { maxBytes: options.maxSnapshotBytes }) });
    journal.advance("snapshot-complete", { snapshotSha256: snapshot.sha256, targetSha256: baselineTargetSha256 });
    options.signal?.throwIfAborted();
    await options.verifySource?.();
    journal.advance("applying");
    await emit(options, "apply", 0);
    await options.apply();
    options.signal?.throwIfAborted();
    await close();
    await emit(options, "verify", 0);
    journal.advance("committed", { targetSha256: await targetFingerprint(options) });
    await emit(options, "complete", 1).catch(() => {});
    return { ok: true, status: "completed", restored: false, resumable: false };
  } catch {
    const reason = options.signal?.aborted ? "aborted" : "apply-failed";
    try {
      await close();
    } catch {
      return { ok: false, status: "failed", restored: false, resumable: true,
        error: { code: "E_IMPORT_FAILED", reason: "restore-failed" } };
    }
    if (journal.read().snapshotSha256) return restore(options, journal, reason);
    journal.abortBeforeSnapshot(reason);
    return { ok: false, status: reason === "aborted" ? "aborted" : "failed", restored: true, resumable: true,
      error: { code: "E_IMPORT_FAILED", reason } };
  }
}

/** Invoked only after Supervisor has stopped Core; both locks remain held through rollback and Engine teardown. */
export async function runImportMaintenance(options: ImportMaintenanceOptions): Promise<ImportMaintenanceResult> {
  try {
    return await withTargetLock(layout(options.home), async () => {
      const release = acquireLock(options.home);
      try {
        return await execute(options);
      } finally {
        release();
      }
    }, { maintenanceRunId: options.runId });
  } catch {
    return { ok: false, status: "failed", restored: false, resumable: true,
      error: { code: "E_CONFLICT", reason: "busy" } };
  }
}
