// Rollback engine for harness imports (docs/import.md §5.5, §9.6, Batch 4).
// Restores the target state prior to the import, verified via hashes, under withTargetLock.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { layout } from "../paths.ts";
import { withTargetLock } from "./single-writer.ts";
import type { TargetSnapshotManifest } from "./snapshot-target.ts";
import { ImportError, type SourceType } from "./types.ts";
import { cleanEmptyDirs, isInsideDir, writeAtomicSync } from "./fs-atomic.ts";
import type { LedgerEntry } from "./ledger.ts";

export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface RollbackChange {
  path: string;
  change: "remove" | "restore" | "revert" | "unchanged";
}

export interface RollbackReport {
  runId: string;
  sourceType: SourceType;
  mode: "dry-run" | "apply";
  status: "planned" | "completed";
  reportPath: string;
  snapshot: { path: string; existed: boolean; manifestSha256?: string };
  changes: RollbackChange[];
  movedAside: string | null;
  startedAt: string;
  finishedAt?: string;
}

function sha256File(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      results.push(full);
    } else if (ent.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (ent.isFile()) {
      results.push(full);
    }
  }
  return results.sort();
}

function validateManifestKey(relPath: string, home: string): void {
  if (typeof relPath !== "string" || !relPath) {
    throw new ImportError("E_ROLLBACK_INVALID", "snapshot-invalid", "empty manifest path");
  }
  // Reject absolute paths, leading slashes, drive letters
  if (relPath.startsWith("/") || relPath.startsWith("\\") || /^[a-zA-Z]:/.test(relPath)) {
    throw new ImportError("E_ROLLBACK_INVALID", "snapshot-invalid", `absolute manifest key rejected: ${relPath}`);
  }
  // Reject .. or . path segments
  const segments = relPath.split(/[/\\]/);
  if (segments.some((s) => s === ".." || s === "." || s === "")) {
    throw new ImportError("E_ROLLBACK_INVALID", "snapshot-invalid", `path traversal in manifest key: ${relPath}`);
  }
  // Whitelist: config.json or agents/
  if (relPath !== "config.json" && relPath !== "agents" && !relPath.startsWith("agents/")) {
    throw new ImportError("E_ROLLBACK_INVALID", "snapshot-invalid", `manifest key outside allowed targets: ${relPath}`);
  }
  const resolved = resolve(home, relPath);
  if (!isInsideDir(home, resolved)) {
    throw new ImportError("E_ROLLBACK_INVALID", "snapshot-invalid", `manifest key escapes home: ${relPath}`);
  }
}

export async function rollbackImport(opts: {
  home: string;
  reportPath: string;
  apply: boolean;
  sourceType: SourceType;
  now?: () => Date;
}): Promise<RollbackReport> {
  const home = resolve(opts.home);
  const l = layout(home);
  const startDate = opts.now ? opts.now() : new Date();
  const startedAt = startDate.toISOString();

  const invalid = (reason: string, msg: string) =>
    new ImportError("E_ROLLBACK_INVALID", reason, msg);

  // Core execution block
  const runOperation = async (): Promise<RollbackReport> => {
    // 1. Read and validate report.json
    let rep: any;
    try {
      rep = JSON.parse(readFileSync(opts.reportPath, "utf8"));
    } catch (e: any) {
      throw invalid("report-unreadable", `${opts.reportPath}: ${e.message}`);
    }

    const runId = rep.runId ?? rep.importId;
    if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
      throw invalid("run-id-invalid", `the report's runId is missing or invalid: ${String(runId)}`);
    }
    if (rep.mode !== "apply") {
      throw invalid("not-an-apply-report", "only an --apply run can be rolled back");
    }
    if (rep.sourceType && rep.sourceType !== opts.sourceType) {
      throw invalid("source-mismatch", `the report is for ${String(rep.sourceType)}, not ${opts.sourceType}`);
    }

    // Verify anchor containment
    const runDir = join(l.home, "imports", runId);
    if (!isInsideDir(join(l.home, "imports"), runDir)) {
      throw invalid("run-id-invalid", "runId escapes imports directory");
    }

    let realReportPath: string;
    let expectedReportPath: string;
    try {
      realReportPath = realpathSync(opts.reportPath);
      expectedReportPath = realpathSync(join(runDir, "report.json"));
    } catch {
      throw invalid("report-missing", `the report file was not found at ${join(runDir, "report.json")}`);
    }
    if (realReportPath !== expectedReportPath) {
      throw invalid("report-outside-home", `report path must match ${join(runDir, "report.json")}`);
    }

    const snapPath = join(runDir, "snapshot");
    if (!existsSync(snapPath)) {
      throw invalid("snapshot-missing", `snapshot directory missing at ${snapPath}`);
    }

    const rolledBackMarker = join(runDir, "rolled-back");
    if (existsSync(join(rolledBackMarker, "status.json"))) {
      throw invalid("already-rolled-back", `run ${runId} was already rolled back`);
    }

    // 2. Read and verify snapshot manifest and its tamper hash
    const manifestPath = join(snapPath, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw invalid("snapshot-invalid", `snapshot manifest missing at ${manifestPath}`);
    }

    const manifestRaw = readFileSync(manifestPath, "utf8");
    const actualManifestSha = createHash("sha256").update(manifestRaw).digest("hex");
    if (!rep.snapshot?.manifestSha256 || rep.snapshot.manifestSha256 !== actualManifestSha) {
      throw invalid("snapshot-corrupt", "snapshot manifest sha256 does not match report");
    }

    let manifest: TargetSnapshotManifest;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch (e: any) {
      throw invalid("snapshot-corrupt", `snapshot manifest is invalid: ${e.message}`);
    }

    if (manifest.schema !== "import.snapshot/1" || manifest.runId !== runId) {
      throw invalid("snapshot-corrupt", "manifest schema or runId mismatch");
    }
    if (!manifest.files || typeof manifest.files !== "object") {
      throw invalid("snapshot-corrupt", "manifest files mapping missing");
    }

    // Validate every manifest key against traversal, absolute paths, and allowed boundaries
    for (const [relPath, meta] of Object.entries(manifest.files)) {
      validateManifestKey(relPath, l.home);
      const snapFile = join(snapPath, relPath);
      if (!isInsideDir(snapPath, snapFile)) {
        throw invalid("snapshot-invalid", `snapshot file escapes snapshot directory: ${relPath}`);
      }
      if (!existsSync(snapFile)) {
        throw invalid("snapshot-corrupt", `snapshot file ${relPath} is missing`);
      }
      const actualHash = sha256File(snapFile);
      if (actualHash !== meta.sha256) {
        throw invalid("snapshot-corrupt", `snapshot file ${relPath} hash mismatch`);
      }
    }

    // 3. Read ledger to determine which files were created by this import (B4)
    const ledgerPath = join(runDir, "ledger.jsonl");
    const createdFiles = new Map<string, string>(); // relPath -> sha256
    const renamedFiles = new Map<string, string>(); // relPath -> sha256
    const createdAgents = new Set<string>();

    if (existsSync(ledgerPath)) {
      try {
        const text = readFileSync(ledgerPath, "utf8");
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed) as LedgerEntry;
            if (entry.entity === "file" && entry.targetRef) {
              const normTarget = entry.targetRef.replaceAll("\\", "/");
              if (entry.action === "created") {
                createdFiles.set(normTarget, entry.sha256 ?? "");
              } else if (entry.action === "rename") {
                renamedFiles.set(normTarget, entry.sha256 ?? "");
              }
            } else if (entry.entity === "agent" && entry.action === "created") {
              const parts = entry.idempotencyKey.split(":");
              const agentId = parts[2] || (entry.targetRef ? entry.targetRef.split("/")[1] ?? "" : "");
              if (agentId) createdAgents.add(agentId);
            }
          } catch {
            // Torn line gracefully ignored
          }
        }
      } catch {
        // Unreadable ledger handled gracefully
      }
    }

    // 4. Compute planned changes
    const changes: RollbackChange[] = [];

    // Files that existed before import (in snapshot manifest)
    for (const [relPath, meta] of Object.entries(manifest.files)) {
      const targetFile = join(l.home, relPath);
      const lst = lstatSync(targetFile, { throwIfNoEntry: false });
      if (lst && lst.isSymbolicLink()) {
        throw invalid("unsafe-symlink", `symlink detected at target path: ${relPath}`);
      }
      if (!lst) {
        changes.push({ path: relPath, change: "restore" });
      } else {
        const targetHash = sha256File(targetFile);
        if (targetHash === meta.sha256) {
          changes.push({ path: relPath, change: "unchanged" });
        } else {
          changes.push({ path: relPath, change: "revert" });
        }
      }
    }

    // Check if any file recorded as created or renamed by this run has been replaced with a symlink
    for (const rel of [...createdFiles.keys(), ...renamedFiles.keys()]) {
      const targetPath = join(l.home, rel);
      const lst = lstatSync(targetPath, { throwIfNoEntry: false });
      if (lst && lst.isSymbolicLink()) {
        throw invalid("unsafe-symlink", `symlink detected at target path: ${rel}`);
      }
    }

    // Files that did NOT exist in snapshot:
    // Only remove if this run created or renamed them! User-created files are preserved.
    if (existsSync(l.agents)) {
      for (const f of walkFiles(l.agents)) {
        const rel = relative(l.home, f).replaceAll("\\", "/");
        if (Object.hasOwn(manifest.files, rel)) continue; // Already handled above

        const isCreatedByRun = createdFiles.has(rel) || renamedFiles.has(rel);
        if (isCreatedByRun) {
          const lst = lstatSync(f, { throwIfNoEntry: false });
          if (lst && lst.isSymbolicLink()) {
            throw invalid("unsafe-symlink", `symlink detected at target path: ${rel}`);
          }
          changes.push({ path: rel, change: "remove" });
        }
        // If not created by run, do NOT add to changes: it survives!
      }
    }

    // If config.json did not exist in snapshot but exists now and this run created it
    if (!manifest.configExisted && existsSync(l.configPath)) {
      changes.push({ path: "config.json", change: "remove" });
    }

    changes.sort((a, b) => a.path.localeCompare(b.path));

    const out: RollbackReport = {
      runId,
      sourceType: opts.sourceType,
      mode: opts.apply ? "apply" : "dry-run",
      status: "planned",
      reportPath: realReportPath,
      snapshot: {
        path: snapPath,
        existed: manifest.configExisted || manifest.agentsExisted,
        manifestSha256: rep.snapshot?.manifestSha256,
      },
      changes,
      movedAside: null,
      startedAt,
    };

    if (!opts.apply) {
      return out;
    }

    // 5. Execute apply atomically
    mkdirSync(rolledBackMarker, { recursive: true, mode: 0o700 });
    const backupDir = join(rolledBackMarker, "replaced");
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });

    for (const c of changes) {
      const targetPath = join(l.home, c.path);
      const snapFilePath = join(snapPath, c.path);

      const lst = lstatSync(targetPath, { throwIfNoEntry: false });
      if (lst && lst.isSymbolicLink()) {
        throw invalid("unsafe-symlink", `refusing to touch symlink at target path: ${c.path}`);
      }

      if (c.change === "remove") {
        if (existsSync(targetPath)) {
          // Backup before removal
          const bkp = join(backupDir, c.path);
          writeAtomicSync(bkp, readFileSync(targetPath), 0o600);
          unlinkSync(targetPath);
          cleanEmptyDirs(dirname(targetPath), l.home);
        }
      } else if (c.change === "revert" || c.change === "restore") {
        if (existsSync(targetPath)) {
          // Backup current differing target
          const bkp = join(backupDir, c.path);
          writeAtomicSync(bkp, readFileSync(targetPath), 0o600);
        }
        const snapContent = readFileSync(snapFilePath);
        writeAtomicSync(targetPath, snapContent, 0o600);
      }
    }

    // If config did not exist before apply, ensure it is removed
    if (!manifest.configExisted && existsSync(l.configPath)) {
      unlinkSync(l.configPath);
    }

    // Clean up created agent directories if empty
    for (const agentId of createdAgents) {
      const ws = l.workspaceDir(agentId);
      cleanEmptyDirs(ws, l.agents);
      const ad = l.agentDir(agentId);
      cleanEmptyDirs(ad, l.agents);
    }
    if (!manifest.agentsExisted && existsSync(l.agents)) {
      cleanEmptyDirs(l.agents, l.home);
    }

    // Verify post-restore state matches manifest exactly
    for (const [relPath, meta] of Object.entries(manifest.files)) {
      const targetPath = join(l.home, relPath);
      if (!existsSync(targetPath)) {
        throw invalid("rollback-verification-failed", `restored file missing: ${relPath}`);
      }
      const actualHash = sha256File(targetPath);
      if (actualHash !== meta.sha256) {
        throw invalid("rollback-verification-failed", `restored file hash mismatch: ${relPath}`);
      }
    }

    // Write completion marker atomically
    const finishedDate = opts.now ? opts.now() : new Date();
    const statusData = {
      runId,
      sourceType: opts.sourceType,
      rolledBackAt: finishedDate.toISOString(),
      changesCount: changes.length,
    };
    writeAtomicSync(join(rolledBackMarker, "status.json"), JSON.stringify(statusData, null, 2) + "\n", 0o600);

    out.status = "completed";
    out.movedAside = backupDir;
    out.finishedAt = finishedDate.toISOString();
    return out;
  };

  // Lock order (S1): acquire single-writer lock BEFORE reading report/manifest and planning on apply
  if (opts.apply) {
    return await withTargetLock(l, async () => {
      return await runOperation();
    });
  }

  return await runOperation();
}
