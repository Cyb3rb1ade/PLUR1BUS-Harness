// Store take-over for Hermes and existing PLUR1BUS stores (docs/import.md §2.3, M7 Batch 3).
// Evaluates store schema and embedding identity via Engine.stores.adopt.
// Order: dry run check -> only if "ok" -> copy-never-move into staging -> adopt -> swap into target layout.
// If any failure occurs, staging directory is deleted and target remains byte-for-byte identical.
// Existing target store is either cleanly replaced (backed up to replaced/lancedb) or skipped (target-store-exists).
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
  action: "taken-over" | "aborted" | "preview-ok";
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
  expectedIdentity: any;
  testInternals?: Record<string, unknown> | undefined;
}): Promise<{
  verdict: "ok" | "incompatible";
  reason?: string | undefined;
  identitySource?: "manifest" | "probe" | undefined;
  schemaVersion?: string | undefined;
}> {
  const { storePath, expectedIdentity, testInternals } = opts;
  const tmpDir = mkdtempSync(join(tmpdir(), "p1b-adopt-probe-"));
  const tmpL = layout(tmpDir);

  const engine = createEngine(
    createTempHost(tmpL.state, async (id: string) => tmpL.workspaceDir(id)),
    buildEngineConfig(defaults(), tmpL) as any,
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
    return {
      verdict: "incompatible",
      reason: err?.code ?? err?.message ?? "store-unreadable",
    };
  } finally {
    try {
      await engine.close({ budgetMs: 1_000 });
    } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function adoptStore(opts: {
  sourceStorePath: string;
  l: Layout;
  expectedIdentity?: any | undefined;
  isApply: boolean;
  runId?: string | undefined;
  repDir?: string | undefined;
  ledger?: ImportLedger | undefined;
  onConflict?: ConflictStrategy | undefined;
  replacedBackupDir?: string | undefined;
  testInternals?: Record<string, unknown> | undefined;
}): Promise<StoreAdoptReport> {
  const {
    sourceStorePath,
    l,
    expectedIdentity,
    isApply,
    runId = "preview",
    repDir,
    ledger,
    onConflict = "skip",
    replacedBackupDir,
    testInternals,
  } = opts;

  const resolvedSource = resolve(sourceStorePath);
  if (!existsSync(resolvedSource) || !isDir(resolvedSource)) {
    throw new ImportError("E_SOURCE_NOT_FOUND", "path-unreadable", `store path not found: ${resolvedSource}`);
  }

  // 1. Dry run inspection on source store (zero writes to target)
  if (!isApply) {
    if (existsSync(l.lancedb)) {
      if (onConflict === "skip") {
        return {
          attempted: true,
          sourcePath: resolvedSource,
          targetPath: l.lancedb,
          verdict: "ok",
          action: "aborted",
          reason: "target-store-exists",
        };
      }
      if (onConflict === "rename") {
        return {
          attempted: true,
          sourcePath: resolvedSource,
          targetPath: l.lancedb,
          verdict: "incompatible",
          action: "aborted",
          reason: "store-rename-unsupported",
        };
      }
    }

    const check = await inspectStoreAdopt({
      storePath: resolvedSource,
      expectedIdentity,
      testInternals,
    });

    if (check.verdict !== "ok") {
      return {
        attempted: true,
        sourcePath: resolvedSource,
        targetPath: l.lancedb,
        verdict: "incompatible",
        action: "aborted",
        reason: check.reason,
        identitySource: check.identitySource,
      };
    }

    return {
      attempted: true,
      sourcePath: resolvedSource,
      targetPath: l.lancedb,
      verdict: "ok",
      action: "preview-ok",
      identitySource: check.identitySource,
      schemaVersion: check.schemaVersion,
    };
  }

  // 2. Apply mode: run under lock BEFORE target engine is opened
  const targetStore = l.lancedb;
  if (existsSync(targetStore)) {
    if (onConflict === "skip") {
      return {
        attempted: true,
        sourcePath: resolvedSource,
        targetPath: targetStore,
        verdict: "ok",
        action: "aborted",
        reason: "target-store-exists",
      };
    }
    if (onConflict === "rename") {
      throw new ImportError("E_STORE_INCOMPATIBLE", "store-rename-unsupported", "cannot rename store directory on conflict");
    }
  }

  // Copy into staging directory first (copy-never-move, leaves target unchanged on any abort)
  const stagingDir = repDir ? join(repDir, "staging-lancedb") : join(l.state, `lancedb.adopt-${runId}`);
  try {
    copyStoreDirectorySafe(resolvedSource, stagingDir);
  } catch (err: any) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (err instanceof ImportError) throw err;
    throw new ImportError("E_STORE_INCOMPATIBLE", "copy-failed", `failed copying store: ${err.message}`);
  }

  // Inspect staging directory
  const check = await inspectStoreAdopt({
    storePath: stagingDir,
    expectedIdentity,
    testInternals,
  });

  if (check.verdict !== "ok") {
    // Delete staging directory so target remains byte-identical
    rmSync(stagingDir, { recursive: true, force: true });
    return {
      attempted: true,
      sourcePath: resolvedSource,
      targetPath: targetStore,
      verdict: "incompatible",
      action: "aborted",
      reason: check.reason,
      identitySource: check.identitySource,
    };
  }

  // Staging is verified compatible: swap into place
  if (existsSync(targetStore)) {
    // onConflict === "replace": move old store aside cleanly
    if (replacedBackupDir) {
      mkdirSync(replacedBackupDir, { recursive: true, mode: 0o700 });
      const bkp = join(replacedBackupDir, "lancedb");
      rmSync(bkp, { recursive: true, force: true });
      renameSync(targetStore, bkp);
    } else {
      rmSync(targetStore, { recursive: true, force: true });
    }
    renameSync(stagingDir, targetStore);

    if (ledger) {
      ledger.record({
        entity: "store",
        idempotencyKey: storeIdempotencyKey(resolvedSource),
        action: "replace",
        sourceRef: resolvedSource,
        targetRef: "state/lancedb",
        details: {
          identitySource: check.identitySource,
          schemaVersion: check.schemaVersion,
        },
      });
    }
  } else {
    renameSync(stagingDir, targetStore);

    if (ledger) {
      ledger.record({
        entity: "store",
        idempotencyKey: storeIdempotencyKey(resolvedSource),
        action: "adopted",
        sourceRef: resolvedSource,
        targetRef: "state/lancedb",
        details: {
          identitySource: check.identitySource,
          schemaVersion: check.schemaVersion,
        },
      });
    }
  }

  return {
    attempted: true,
    sourcePath: resolvedSource,
    targetPath: targetStore,
    verdict: "ok",
    action: "taken-over",
    identitySource: check.identitySource,
    schemaVersion: check.schemaVersion,
  };
}
