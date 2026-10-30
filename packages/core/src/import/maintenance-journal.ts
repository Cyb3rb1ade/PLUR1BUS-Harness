/** Durable supervised-import intent precedes every phase and external secret mutation (M-C4/C6). */
import { lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createSecurePath } from "@plur1bus/module-api";
import { isSecretName } from "../secrets/types.ts";
import { writeAtomicSync } from "./fs-atomic.ts";
import { readSourceTextSafe } from "./fs-safe.ts";
import { ImportError } from "./types.ts";
import type { MaintenanceCheckpoint, MaintenanceHistory, MaintenanceJournal, MaintenancePhase,
  MaintenanceReason, MaintenanceSecretIntent } from "./maintenance-types.ts";

const RUN = /^[A-Za-z0-9_-]{1,64}$(?![\s\S])/;
const HASH = /^[a-f0-9]{64}$(?![\s\S])/;
const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_HISTORY = 256;
const MAX_SECRETS = 256;
const PHASES: MaintenancePhase[] = ["prepared", "snapshotting", "snapshot-complete", "applying",
  "committed", "rolling-back", "restored"];
const REASONS: MaintenanceReason[] = ["apply-failed", "aborted", "restore-failed", "source-changed",
  "target-changed", "manual-rollback", "automatic-rollback", "recovered"];
const NEXT: Record<MaintenancePhase, readonly MaintenancePhase[]> = {
  prepared: ["snapshotting", "rolling-back"], snapshotting: ["snapshot-complete", "rolling-back"],
  "snapshot-complete": ["applying", "rolling-back"], applying: ["committed", "rolling-back"],
  committed: ["rolling-back"], "rolling-back": ["restored"], restored: [],
};

function fail(reason = "maintenance-journal-invalid"): never {
  throw new ImportError("E_IMPORT_FAILED", reason, "Import maintenance journal is unavailable");
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) fail();
  return record;
}

function secretName(value: unknown): value is string {
  return isSecretName(value) && value.trim() === value;
}

function checkpoint(value: unknown): MaintenanceCheckpoint {
  const raw = object(value, ["snapshotSha256", "targetSha256", "reason"]);
  for (const key of ["snapshotSha256", "targetSha256"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || !HASH.test(raw[key] as string))) fail();
  }
  if (raw.reason !== undefined && !REASONS.includes(raw.reason as MaintenanceReason)) fail();
  return { ...raw } as MaintenanceCheckpoint;
}

function validate(value: unknown, runId: string): MaintenanceJournal {
  const raw = object(value, ["schema", "runId", "attempt", "phase", "snapshotSha256", "targetSha256", "history", "secrets"]);
  if (raw.schema !== "import.maintenance/1" || raw.runId !== runId || !Number.isSafeInteger(raw.attempt)
    || (raw.attempt as number) < 1 || !PHASES.includes(raw.phase as MaintenancePhase)
    || !Array.isArray(raw.history) || raw.history.length < 1 || raw.history.length > MAX_HISTORY
    || !Array.isArray(raw.secrets) || raw.secrets.length > MAX_SECRETS) fail();
  const metadata = checkpoint({ ...(raw.snapshotSha256 === undefined ? {} : { snapshotSha256: raw.snapshotSha256 }),
    ...(raw.targetSha256 === undefined ? {} : { targetSha256: raw.targetSha256 }) });
  const history = raw.history.map(value => {
    const item = object(value, ["attempt", "phase", "at", "reason"]);
    if (!Number.isSafeInteger(item.attempt) || (item.attempt as number) < 1 || (item.attempt as number) > (raw.attempt as number)
      || !PHASES.includes(item.phase as MaintenancePhase) || typeof item.at !== "string"
      || item.at.length > 32 || !Number.isFinite(Date.parse(item.at))) fail();
    if (item.reason !== undefined && !REASONS.includes(item.reason as MaintenanceReason)) fail();
    return { ...item } as unknown as MaintenanceHistory;
  });
  const last = history.at(-1)!;
  if (last.phase !== raw.phase || last.attempt !== raw.attempt) fail();
  const seen = new Set<string>();
  const secrets = raw.secrets.map(value => {
    const item = object(value, ["name", "absentBefore", "created", "removed"]);
    if (!secretName(item.name) || seen.has(item.name) || item.absentBefore !== true
      || typeof item.created !== "boolean" || typeof item.removed !== "boolean" || (item.removed && !item.created)) fail();
    seen.add(item.name);
    return { ...item } as unknown as MaintenanceSecretIntent;
  });
  if (!["prepared", "snapshotting"].includes(raw.phase as string) && !metadata.snapshotSha256) fail();
  return { schema: "import.maintenance/1", runId, attempt: raw.attempt as number,
    phase: raw.phase as MaintenancePhase, ...metadata, history, secrets };
}

/**
 * Creates only validated private segments; no linked component can redirect a run's journal. With `create: false` (a
 * read) the same segments are validated but nothing is created and no permission is applied again: on Windows each
 * application runs icacls synchronously, which a status request must not pay for every record it reads.
 */
export function maintenanceRunDirectory(home: string, runId: string, options: { create?: boolean } = {}): string {
  if (!isAbsolute(home) || !RUN.test(runId)) fail("maintenance-run-invalid");
  const create = options.create ?? true;
  const secure = create ? createSecurePath({ runDir: join(home, "run") }) : undefined;
  let current = home;
  for (const part of ["", "imports", runId]) {
    if (part) {
      current = join(current, part);
      if (create) {
        try { mkdirSync(current, { mode: 0o700 }); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail();
        }
      }
    }
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.isSymbolicLink()) fail("maintenance-path-unsafe");
    if (part && secure && !secure(current, { mode: 0o700 }).applied) fail("maintenance-permissions-unavailable");
  }
  return current;
}

/** Metadata-only startup reader: never creates a run, changes permissions or rewrites an interrupted journal. */
export function readMaintenanceJournal(home: string, runId: string): MaintenanceJournal {
  if (!isAbsolute(home) || !RUN.test(runId)) fail("maintenance-run-invalid");
  let current = home;
  for (const part of ["", "imports", runId]) {
    if (part) current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.isSymbolicLink()) fail("maintenance-path-unsafe");
  }
  const file = join(current, "maintenance.json");
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) fail("maintenance-path-unsafe");
  return validate(JSON.parse(readSourceTextSafe(file, MAX_JOURNAL_BYTES)), runId);
}

/** Opens the durable checkpoint; metadata returned to consumers is a detached copy. */
export function openMaintenanceJournal(home: string, runId: string, now: () => Date = () => new Date()) {
  const file = join(maintenanceRunDirectory(home, runId), "maintenance.json");
  const existing = lstatSync(file, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail("maintenance-path-unsafe");
  let state: MaintenanceJournal;
  if (existing) {
    try { state = validate(JSON.parse(readSourceTextSafe(file, MAX_JOURNAL_BYTES)), runId); } catch { fail(); }
  } else {
    state = { schema: "import.maintenance/1", runId, attempt: 1, phase: "prepared", history: [
      { attempt: 1, phase: "prepared", at: now().toISOString() },
    ], secrets: [] };
    writeAtomicSync(file, `${JSON.stringify(state)}\n`, 0o600);
  }
  function persist(next: MaintenanceJournal): void {
    const checked = validate(next, runId);
    const bytes = `${JSON.stringify(checked)}\n`;
    if (Buffer.byteLength(bytes) > MAX_JOURNAL_BYTES) fail("maintenance-journal-limit");
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info?.isFile() || info.isSymbolicLink()) fail("maintenance-path-unsafe");
    maintenanceRunDirectory(home, runId);
    writeAtomicSync(file, bytes, 0o600);
    state = checked;
  }
  function nextHistory(phase: MaintenancePhase, reason?: MaintenanceReason, attempt = state.attempt) {
    if (state.history.length >= MAX_HISTORY) fail("maintenance-journal-limit");
    return [...state.history, { attempt, phase, at: now().toISOString(), ...(reason ? { reason } : {}) }];
  }
  function secretIndex(name: string): number {
    if (!secretName(name)) fail("maintenance-secret-invalid");
    const index = state.secrets.findIndex(item => item.name === name);
    if (index < 0) fail("maintenance-secret-intent-missing");
    return index;
  }
  return {
    read(): MaintenanceJournal { return structuredClone(state); },
    finalizeCommittedTarget(targetSha256: string): void {
      if (state.phase !== "committed" || !HASH.test(targetSha256)) fail("maintenance-phase-invalid");
      persist({ ...state, targetSha256 });
    },
    advance(phase: MaintenancePhase, metadata: MaintenanceCheckpoint = {}): void {
      if (!NEXT[state.phase].includes(phase)) fail("maintenance-phase-invalid");
      const info = checkpoint(metadata);
      const { reason, ...hashes } = info;
      persist({ ...state, ...hashes, phase, history: nextHistory(phase, reason) });
    },
    secretIntent(name: string): void {
      if (state.phase !== "applying" || !secretName(name) || state.secrets.length >= MAX_SECRETS
        || state.secrets.some(item => item.name === name)) fail("maintenance-secret-invalid");
      persist({ ...state, secrets: [...state.secrets, { name, absentBefore: true, created: false, removed: false }] });
    },
    secretCreated(name: string): void {
      // Recovery observes the backend's exact import:<runId> actor after a crash between set and this receipt.
      if (state.phase !== "applying" && state.phase !== "rolling-back") fail("maintenance-phase-invalid");
      const secrets = structuredClone(state.secrets);
      secrets[secretIndex(name)]!.created = true;
      persist({ ...state, secrets });
    },
    secretRemoved(name: string): void {
      if (state.phase !== "rolling-back") fail("maintenance-phase-invalid");
      const secrets = structuredClone(state.secrets);
      const item = secrets[secretIndex(name)]!;
      if (!item.created) fail("maintenance-secret-intent-missing");
      item.removed = true;
      persist({ ...state, secrets });
    },
    abortBeforeSnapshot(reason: MaintenanceReason): void {
      if (!["prepared", "snapshotting"].includes(state.phase) || state.snapshotSha256 || state.secrets.length) fail();
      if (!["aborted", "recovered", "apply-failed", "source-changed", "target-changed"].includes(reason)) fail();
      persist({ ...state, phase: "prepared", history: nextHistory("prepared", reason) });
    },
    resume(): void {
      const unmutated = state.phase === "prepared" && !state.snapshotSha256
        && ["aborted", "recovered", "apply-failed", "source-changed", "target-changed"].includes(state.history.at(-1)?.reason ?? "");
      if (state.phase !== "restored" && !unmutated
        || state.secrets.some(item => item.created && !item.removed)) fail("maintenance-phase-invalid");
      const next = { ...state, attempt: state.attempt + 1, phase: "prepared" as const, secrets: [],
        history: nextHistory("prepared", undefined, state.attempt + 1) };
      persist(next);
    },
  };
}

export type ImportMaintenanceJournal = ReturnType<typeof openMaintenanceJournal>;
