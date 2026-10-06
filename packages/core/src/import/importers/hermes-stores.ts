// Store take-over for Hermes and existing PLUR1BUS stores (docs/import.md §2.3, M7 Batch 3).
// Evaluates store schema and embedding identity via Engine.stores.adopt.
// Apply order (all under withTargetLock, BEFORE any engine opens or initialises the target store):
//   prepareStoreAdopt: copy-never-move the source into a staging dir on the target filesystem
//     (state/lancedb.adopt-<runId>), then Engine.stores.adopt({dryRun:true}) inspects that COPY;
//   commitStoreAdopt (after the snapshot/ledger exist): move an existing state/lancedb aside into
//     imports/<runId>/replaced/lancedb (only with --conflict replace) and rename staging into place;
//   abortStoreAdopt: delete the staging dir. Any failure before commit leaves the target byte-identical.
// Existing target store: skip -> store-exists-skipped (left untouched, never merged); rename -> refused;
// replace -> backed up and replaced as a whole, never merged.
// Identity source: a generation manifest (`generations/<id>/generation.json`) when the store has one, else the
// sample cosine probe the engine runs for legacy stores (report field identitySource: "manifest" | "probe").
// NEVER writes directly to LanceDB or imports external vector store libraries.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Layout } from "../../paths.ts";
import { isDir } from "../readonly.ts";
import { storeIdempotencyKey, type ImportLedger, type ConflictStrategy } from "../ledger.ts";
import { isInsideDir, writeAtomicSync } from "../fs-atomic.ts";
import { ImportError } from "../types.ts";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { defaults } from "@plur1bus/config-schema";
import { buildEngineConfig } from "../../engine-config.ts";
import { layout } from "../../paths.ts";
import { platformCapabilities } from "../../platform.ts";
import type { Engine, HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

export interface StoreAdoptReport {
  attempted: boolean;
  sourcePath: string;
  targetPath: string;
  verdict: "ok" | "incompatible";
  action: "taken-over" | "aborted" | "preview-ok" | "skipped";
  reason?: string | undefined;
  identitySource?: "manifest" | "probe" | undefined;
  schemaVersion?: string | undefined;
}

function createTempHost(stateDir: string, workspaceDir: (id: string) => Promise<string>): HostServices {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    stateDir,
    configPath: () => join(stateDir, "config.json"),
    workspaceDir: async (id: string) => workspaceDir(id),
    config: () => ({} as any),
    platform: {
      os: process.platform,
      arch: process.arch,
      memoryTotalBytes: () => 0,
      memoryFreeBytes: () => 0,
      ...platformCapabilities,
    },
    runtime: null,
  } as unknown as HostServices;
}

export function copyStoreDirectorySafe(src: string, dst: string): void {
  const normSrc = resolve(src);
  const normDst = resolve(dst);

  if (normSrc === normDst || isInsideDir(normDst, normSrc) || isInsideDir(normSrc, normDst)) {
    throw new ImportError("E_STORE_INCOMPATIBLE", "overlapping-store-paths", "source and destination store paths overlap");
  }

  mkdirSync(dst, { recursive: true, mode: 0o700 });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    const srcPath = join(src, ent.name);
    const dstPath = join(dst, ent.name);
    const st = lstatSync(srcPath);

    if (st.isSymbolicLink()) {
      throw new ImportError("E_STORE_INCOMPATIBLE", "unsafe-store-entry", `store contains symlink: ${ent.name}`);
    }
    if (ent.isDirectory()) {
      copyStoreDirectorySafe(srcPath, dstPath);
    } else if (ent.isFile()) {
      const buf = readFileSync(srcPath);
      writeAtomicSync(dstPath, buf, 0o600);
    } else {
      throw new ImportError("E_STORE_INCOMPATIBLE", "unsafe-store-entry", `store contains non-regular entry: ${ent.name}`);
    }
  }
}

export async function inspectStoreAdopt(opts: {
  storePath: string;
  expectedIdentity?: any;
  /** Target harness config: the identity a copied store must match is the TARGET engine's identity. */
  targetConfig?: unknown;
  testInternals?: Record<string, unknown> | undefined;
}): Promise<{
  verdict: "ok" | "incompatible";
  reason?: string | undefined;
  identitySource?: "manifest" | "probe" | undefined;
  schemaVersion?: string | undefined;
}> {
  const { storePath, expectedIdentity, targetConfig, testInternals } = opts;
  const tmpDir = mkdtempSync(join(tmpdir(), "p1b-adopt-probe-"));
  const tmpL = layout(tmpDir);

  const engine = createEngine(
    createTempHost(tmpL.state, async (id: string) => tmpL.workspaceDir(id)),
    buildEngineConfig((targetConfig ?? defaults()) as any, tmpL) as any,
    testInternals ? { internals: testInternals } : undefined,
  );

  try {
    const identities = engine.embedding.identities();
    const identity = expectedIdentity || identities[0];
    if (!identity) {
      return { verdict: "incompatible", reason: "identity-unverifiable" };
    }
    const res = await engine.stores.adopt({
      path: resolve(storePath),
      expectedIdentity: identity,
      dryRun: true,
    });
    return {
      verdict: res.verdict === "ok" ? "ok" : "incompatible",
      reason: res.reason ?? (res.verdict === "ok" ? undefined : "identity-mismatch"),
      identitySource: res.identitySource,
      schemaVersion: res.storeSchema?.current ?? undefined,
    };
  } catch (err: any) {
    const code = typeof err?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(err.code) ? err.code : "store-unreadable";
    return { verdict: "incompatible", reason: code };
  } finally {
    try {
      await engine.close({ budgetMs: 1_000 });
    } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface PreparedStoreAdopt {
  report: StoreAdoptReport;
  resolvedSource: string;
  /** Present only in apply mode after a verified copy: the staged store waiting for commit. */
  stagingDir?: string | undefined;
  /** state/lancedb existed when the copy was verified (only with --conflict replace). */
  replacesExisting: boolean;
}

/**
 * Validates, stages and inspects. Dry run: inspects the source read-only and writes nothing to the target.
 * Apply: copies into a staging dir and inspects the copy; on any failure the staging dir is removed again.
 * Never touches an existing state/lancedb.
 */
export async function prepareStoreAdopt(opts: {
  sourceStorePath: string;
  l: Layout;
  isApply: boolean;
  runId: string;
  onConflict?: ConflictStrategy | undefined;
  expectedIdentity?: any | undefined;
  targetConfig?: unknown;
  testInternals?: Record<string, unknown> | undefined;
  /** Ledger of the run being resumed (if any); a recorded take-over of the same source is not repeated. */
  resumeLedgerText?: string | undefined;
}): Promise<PreparedStoreAdopt> {
  const { sourceStorePath, l, isApply, runId, onConflict = "skip", expectedIdentity, targetConfig, testInternals, resumeLedgerText } = opts;
  const resolvedSource = resolve(sourceStorePath);
  const targetStore = l.lancedb;
  const alreadyAdoptedInRun = typeof resumeLedgerText === "string"
    && resumeLedgerText.split("\n").some((line) => {
      try {
        const e = JSON.parse(line);
        return e?.entity === "store" && e?.idempotencyKey === storeIdempotencyKey(resolvedSource);
      } catch {
        return false;
      }
    });
  if (!existsSync(resolvedSource) || !isDir(resolvedSource)) {
    throw new ImportError("E_SOURCE_NOT_FOUND", "path-unreadable", `store path not found: ${resolvedSource}`);
  }
  if (resolvedSource === resolve(targetStore) || isInsideDir(resolve(targetStore), resolvedSource) || isInsideDir(resolvedSource, resolve(targetStore))) {
    throw new ImportError("E_STORE_INCOMPATIBLE", "overlapping-store-paths", "source store overlaps the target store");
  }

  const base = { attempted: true, sourcePath: resolvedSource, targetPath: targetStore };
  const replacesExisting = existsSync(targetStore);
  // --resume of a run whose ledger already records this take-over: never re-copy (with replace that would discard
  // every card the first attempt wrote into the adopted store).
  if (alreadyAdoptedInRun) {
    return { report: { ...base, verdict: "ok", action: "skipped", reason: "already-adopted-in-run" }, resolvedSource, replacesExisting };
  }
  if (replacesExisting) {
    if (onConflict === "skip") {
      return {
        report: { ...base, verdict: "ok", action: "skipped", reason: "store-exists-skipped" },
        resolvedSource,
        replacesExisting,
      };
    }
    if (onConflict === "rename") {
      throw new ImportError("E_STORE_INCOMPATIBLE", "store-rename-unsupported", "a store cannot be renamed on conflict; use --conflict skip or replace");
    }
  }

  if (!isApply) {
    const check = await inspectStoreAdopt({ storePath: resolvedSource, expectedIdentity, targetConfig, testInternals });
    return {
      report: check.verdict === "ok"
        ? { ...base, verdict: "ok", action: "preview-ok", identitySource: check.identitySource, schemaVersion: check.schemaVersion }
        : { ...base, verdict: "incompatible", action: "aborted", reason: check.reason, identitySource: check.identitySource },
      resolvedSource,
      replacesExisting,
    };
  }

  // Same filesystem as state/lancedb so the final step is a rename. state/ exists: withTargetLock holds state/core.lock.
  const stagingDir = join(l.state, `lancedb.adopt-${runId}`);
  rmSync(stagingDir, { recursive: true, force: true });
  try {
    copyStoreDirectorySafe(resolvedSource, stagingDir);
  } catch (err: any) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (err instanceof ImportError) throw err;
    throw new ImportError("E_STORE_INCOMPATIBLE", "copy-failed", `failed copying store: ${err?.code ?? "io"}`);
  }

  let check: Awaited<ReturnType<typeof inspectStoreAdopt>>;
  try {
    check = await inspectStoreAdopt({ storePath: stagingDir, expectedIdentity, targetConfig, testInternals });
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
  if (check.verdict !== "ok") {
    rmSync(stagingDir, { recursive: true, force: true });
    return {
      report: { ...base, verdict: "incompatible", action: "aborted", reason: check.reason, identitySource: check.identitySource },
      resolvedSource,
      replacesExisting,
    };
  }
  return {
    report: { ...base, verdict: "ok", action: "preview-ok", identitySource: check.identitySource, schemaVersion: check.schemaVersion },
    resolvedSource,
    stagingDir,
    replacesExisting,
  };
}

/** Removes a staged copy that was never committed. Idempotent. */
export function abortStoreAdopt(prepared: PreparedStoreAdopt | undefined): void {
  if (prepared?.stagingDir) {
    rmSync(prepared.stagingDir, { recursive: true, force: true });
    prepared.stagingDir = undefined;
  }
}

/** Swaps a verified staged copy into state/lancedb (apply mode, after snapshot + ledger exist). */
export function commitStoreAdopt(
  prepared: PreparedStoreAdopt,
  opts: { l: Layout; ledger?: ImportLedger | undefined; replacedBackupDir?: string | undefined },
): StoreAdoptReport {
  const { l, ledger, replacedBackupDir } = opts;
  const stagingDir = prepared.stagingDir;
  if (!stagingDir) return prepared.report;
  const targetStore = l.lancedb;
  const replacing = existsSync(targetStore);
  if (replacing) {
    if (!replacedBackupDir) {
      throw new ImportError("E_STORE_INCOMPATIBLE", "store-backup-unavailable", "cannot replace a store without a backup location");
    }
    mkdirSync(replacedBackupDir, { recursive: true, mode: 0o700 });
    const bkp = join(replacedBackupDir, "lancedb");
    rmSync(bkp, { recursive: true, force: true });
    renameSync(targetStore, bkp);
  }
  renameSync(stagingDir, targetStore);
  prepared.stagingDir = undefined;

  ledger?.record({
    entity: "store",
    idempotencyKey: storeIdempotencyKey(prepared.resolvedSource),
    action: replacing ? "replace" : "adopted",
    sourceRef: prepared.resolvedSource,
    targetRef: "state/lancedb",
    details: {
      identitySource: prepared.report.identitySource,
      schemaVersion: prepared.report.schemaVersion,
    },
  });

  prepared.report = { ...prepared.report, action: "taken-over" };
  return prepared.report;
}
