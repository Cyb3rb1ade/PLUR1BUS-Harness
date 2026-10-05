// Store take-over for Hermes and existing PLUR1BUS stores (docs/import.md §2.3, M7 Batch 3).
// Evaluates store schema and embedding identity via Engine.stores.adopt.
// Order: dry run check -> only if "ok" -> copy-never-move -> adopt.
// Any mismatch or unreadable state cleanly aborts without touching target.
// NEVER writes directly to LanceDB or imports external vector store libraries.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Layout } from "../../paths.ts";
import { isDir, isFile } from "../readonly.ts";
import { storeIdempotencyKey, type ImportLedger } from "../ledger.ts";
import { writeAtomicSync } from "../fs-atomic.ts";
import { ImportError } from "../types.ts";
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

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

function copyDirectoryRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    const srcPath = join(src, ent.name);
    const dstPath = join(dst, ent.name);
    const st = lstatSync(srcPath);
    if (st.isSymbolicLink()) {
      continue; // Skip symlinks for safety
    }
    if (ent.isDirectory()) {
      copyDirectoryRecursive(srcPath, dstPath);
    } else if (ent.isFile()) {
      const buf = readFileSync(srcPath);
      writeAtomicSync(dstPath, buf, 0o600);
    }
  }
}

export async function adoptStore(opts: {
  sourceStorePath: string;
  l: Layout;
  engine: Engine;
  isApply: boolean;
  ledger?: ImportLedger | undefined;
  onConflict?: "skip" | "rename" | "replace" | undefined;
  replacedBackupDir?: string | undefined;
}): Promise<StoreAdoptReport> {
  const { sourceStorePath, l, engine, isApply, ledger, onConflict = "skip", replacedBackupDir } = opts;

  if (!existsSync(sourceStorePath) || !isDir(sourceStorePath)) {
    throw new ImportError("E_SOURCE_NOT_FOUND", "path-unreadable", `store path not found: ${sourceStorePath}`);
  }

  // 1. Get target expected identity from engine
  const identities = engine.embedding.identities();
  const expectedIdentity = identities[0];
  if (!expectedIdentity) {
    throw new ImportError("E_IMPORT_FAILED", "identity-unverifiable", "target engine has no configured embedding identity");
  }

  // 2. Dry-run inspection on source store
  let dryCheck;
  try {
    dryCheck = await engine.stores.adopt({
      path: sourceStorePath,
      expectedIdentity,
      dryRun: true,
    });
  } catch (err: any) {
    return {
      attempted: true,
      sourcePath: sourceStorePath,
      targetPath: l.lancedb,
      verdict: "incompatible",
      action: "aborted",
      reason: err?.code ?? err?.message ?? "store-unreadable",
    };
  }

  if (dryCheck.verdict !== "ok") {
    return {
      attempted: true,
      sourcePath: sourceStorePath,
      targetPath: l.lancedb,
      verdict: "incompatible",
      action: "aborted",
      reason: dryCheck.reason ?? "identity-mismatch",
      identitySource: dryCheck.identitySource,
    };
  }

  // If dry-run, stop here with preview-ok
  if (!isApply) {
    return {
      attempted: true,
      sourcePath: sourceStorePath,
      targetPath: l.lancedb,
      verdict: "ok",
      action: "preview-ok",
      identitySource: dryCheck.identitySource,
      schemaVersion: dryCheck.storeSchema?.current ?? undefined,
    };
  }

  // 3. Apply: Copy-never-move into target layout (l.lancedb)
  const targetStore = l.lancedb;
  if (existsSync(targetStore)) {
    if (onConflict === "replace") {
      if (replacedBackupDir) {
        const bkp = join(replacedBackupDir, "lancedb");
        copyDirectoryRecursive(targetStore, bkp);
      }
    } else if (onConflict === "skip") {
      return {
        attempted: true,
        sourcePath: sourceStorePath,
        targetPath: targetStore,
        verdict: "ok",
        action: "preview-ok",
        reason: "target-store-already-exists",
        identitySource: dryCheck.identitySource,
      };
    }
  }

  // Copy directory recursively (source remains completely untouched)
  copyDirectoryRecursive(sourceStorePath, targetStore);

  // 4. Adopt target store in engine
  let adoptResult;
  try {
    adoptResult = await engine.stores.adopt({
      path: targetStore,
      expectedIdentity,
      dryRun: false,
    });
  } catch (err: any) {
    return {
      attempted: true,
      sourcePath: sourceStorePath,
      targetPath: targetStore,
      verdict: "incompatible",
      action: "aborted",
      reason: err?.code ?? err?.message ?? "store-unreadable",
    };
  }

  if (adoptResult.verdict !== "ok") {
    return {
      attempted: true,
      sourcePath: sourceStorePath,
      targetPath: targetStore,
      verdict: "incompatible",
      action: "aborted",
      reason: adoptResult.reason ?? "identity-mismatch",
      identitySource: adoptResult.identitySource,
    };
  }

  // Record in ledger
  if (ledger) {
    ledger.record({
      entity: "store",
      idempotencyKey: storeIdempotencyKey(sourceStorePath),
      action: "adopted",
      sourceRef: sourceStorePath,
      targetRef: "lancedb",
      details: {
        identitySource: adoptResult.identitySource,
        schemaVersion: adoptResult.storeSchema?.current,
      },
    });
  }

  return {
    attempted: true,
    sourcePath: sourceStorePath,
    targetPath: targetStore,
    verdict: "ok",
    action: "taken-over",
    identitySource: adoptResult.identitySource,
    schemaVersion: adoptResult.storeSchema?.current ?? undefined,
  };
}
