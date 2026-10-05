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
  change: "remove" | "restore" | "revert" | "unchanged" | "kept-modified";
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
  memoryCardsNotReverted?: number | undefined;
  memoryUndoStatus?: "not-reverted (engine has no undo)" | undefined;
  startedAt: string;
  finishedAt?: string;
}

function sha256File(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

function walkFiles(dir: string): string[] {
  const lst = lstatSync(dir, { throwIfNoEntry: false });
  if (!lst || lst.isSymbolicLink() || !lst.isDirectory()) return [];
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      results.push(full);
    } else if (ent.isDirectory()) {
      const childLst = lstatSync(full, { throwIfNoEntry: false });
      if (childLst && childLst.isSymbolicLink()) {
        results.push(full);
      } else {
        results.push(...walkFiles(full));
      }
    } else if (ent.isFile()) {
      results.push(full);
    }
  }
  return results.sort();
}

export function checkPathComponentsForSymlinks(home: string, relPath: string): void {
  const normHome = resolve(home);
  const parts = relPath.split(/[/\\]/).filter(Boolean);
  let curr = normHome;
  for (const part of parts) {
    curr = join(curr, part);
    const lst = lstatSync(curr, { throwIfNoEntry: false });
    if (!lst) {
      break;
    }
    if (lst.isSymbolicLink()) {
      throw new ImportError("E_ROLLBACK_INVALID", "unsafe-symlink", `symlink detected along path: ${relPath}`);
    }
  }
}

export function verifyAncestorContainment(home: string, targetPath: string): void {
  const normHome = resolve(home);
  let homeReal = normHome;
  try { homeReal = realpathSync(normHome); } catch {}

  let curr = resolve(targetPath);
  while (!existsSync(curr) && curr !== dirname(curr)) {
    curr = dirname(curr);
  }
  let currReal = curr;
  try { currReal = realpathSync(curr); } catch {}

  if (!isInsideDir(homeReal, currReal)) {
    throw new ImportError("E_ROLLBACK_INVALID", "snapshot-invalid", `target path escapes home: ${targetPath}`);
  }
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
  // Whitelist: config.json or files under agents/
  if (relPath !== "config.json" && (!relPath.startsWith("agents/") || relPath.length <= "agents/".length)) {
    throw new ImportError("E_ROLLBACK_INVALID", "snapshot-invalid", `manifest key outside allowed targets: ${relPath}`);
  }
  const resolved = resolve(home, relPath);
  if (!isInsideDir(home, resolved)) {
    throw new ImportError("E_ROLLBACK_INVALID", "snapshot-invalid", `manifest key escapes home: ${relPath}`);
  }
}

export interface RollbackOptions {
  home: string;
  reportPath: string;
  apply: boolean;
  sourceType: SourceType;
  force?: boolean;
  now?: () => Date;
}

export async function rollbackImport(opts: RollbackOptions): Promise<RollbackReport> {
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

    // 3. Read ledger to determine which files were created by this import (B4, N2)
    const ledgerPath = join(runDir, "ledger.jsonl");
    if (!existsSync(ledgerPath)) {
      throw invalid("ledger-corrupt", `import ledger missing at ${ledgerPath}`);
    }

    let ledgerText: string;
    try {
      ledgerText = readFileSync(ledgerPath, "utf8");
    } catch (e: any) {
      throw invalid("ledger-corrupt", `import ledger unreadable: ${e.message}`);
    }

    const createdFiles = new Map<string, string>(); // relPath -> sha256
    const renamedFiles = new Map<string, string>(); // relPath -> sha256
    const createdAgents = new Set<string>();
    let memoryCardsImported = 0;

    const lines = ledgerText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as LedgerEntry;
        if (!entry || typeof entry.idempotencyKey !== "string" || !entry.entity) {
          throw invalid("ledger-corrupt", `corrupt entry in ledger at line ${i + 1}`);
        }
        if (entry.entity === "system" && entry.action === "repaired") {
          continue;
        }
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
        } else if (entry.entity === "memory") {
          const count = (entry.details?.created as number ?? entry.details?.count as number ?? 1);
          memoryCardsImported += count;
        }
      } catch (err: any) {
        // If this line was followed by a repair marker, it is a repaired torn line: ignore it
        const nextNonEmpty = lines.slice(i + 1).find((l) => l && l.trim().length > 0);
        if (nextNonEmpty) {
          try {
            const nextEntry = JSON.parse(nextNonEmpty.trim());
            if (nextEntry?.entity === "system" && nextEntry?.action === "repaired") {
              continue;
            }
          } catch {}
        }
        if (err instanceof ImportError) throw err;
        throw invalid("ledger-corrupt", `corrupt entry in ledger at line ${i + 1}: ${err.message}`);
      }
    }

    // 4. Compute planned changes
    const changes: RollbackChange[] = [];

    // Files that existed before import (in snapshot manifest)
    for (const [relPath, meta] of Object.entries(manifest.files)) {
      validateManifestKey(relPath, l.home);
      checkPathComponentsForSymlinks(l.home, relPath);
      const targetFile = join(l.home, relPath);
      verifyAncestorContainment(l.home, targetFile);

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

    // Check if any file recorded as created or renamed by this run has ancestor symlinks
    for (const rel of [...createdFiles.keys(), ...renamedFiles.keys()]) {
      checkPathComponentsForSymlinks(l.home, rel);
      const targetPath = join(l.home, rel);
      verifyAncestorContainment(l.home, targetPath);
      const lst = lstatSync(targetPath, { throwIfNoEntry: false });
      if (lst && lst.isSymbolicLink()) {
        throw invalid("unsafe-symlink", `symlink detected at target path: ${rel}`);
      }
    }

    // Files that did NOT exist in snapshot:
    // Only remove if this run created or renamed them! User-created files are preserved.
    if (existsSync(l.agents)) {
      checkPathComponentsForSymlinks(l.home, "agents");
      for (const f of walkFiles(l.agents)) {
        const rel = relative(l.home, f).replaceAll("\\", "/");
        if (Object.hasOwn(manifest.files, rel)) continue; // Already handled above

        checkPathComponentsForSymlinks(l.home, rel);
        verifyAncestorContainment(l.home, f);

        const isCreatedByRun = createdFiles.has(rel) || renamedFiles.has(rel);
        if (isCreatedByRun) {
          const lst = lstatSync(f, { throwIfNoEntry: false });
          if (lst && lst.isSymbolicLink()) {
            throw invalid("unsafe-symlink", `symlink detected at target path: ${rel}`);
          }

          // B4 rest: Check if user modified the file since import!
          // Fail-safe: missing sha or unhashable file is treated as kept-modified
          const expectedSha = createdFiles.get(rel) || renamedFiles.get(rel);
          let currentSha = "";
          try {
            currentSha = sha256File(f);
          } catch {
            // unreadable
          }
          const isUserModified = Boolean(!expectedSha || !currentSha || currentSha !== expectedSha);

          if (isUserModified && !opts.force) {
            changes.push({ path: rel, change: "kept-modified" });
          } else {
            changes.push({ path: rel, change: "remove" });
          }
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
      memoryCardsNotReverted: memoryCardsImported > 0 ? memoryCardsImported : undefined,
      memoryUndoStatus: memoryCardsImported > 0 ? "not-reverted (engine has no undo)" : undefined,
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

      checkPathComponentsForSymlinks(l.home, c.path);
      verifyAncestorContainment(l.home, targetPath);

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
      } else if (c.change === "kept-modified") {
        if (existsSync(targetPath)) {
          // Backup modified target without unlinking (best-effort if unreadable)
          try {
            const bkp = join(backupDir, c.path);
            writeAtomicSync(bkp, readFileSync(targetPath), 0o600);
          } catch {
            // Unreadable file kept on disk, backup best-effort
          }
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

    // If config did not exist before apply, back it up and ensure it is removed
    if (!manifest.configExisted && existsSync(l.configPath)) {
      try {
        const bkp = join(backupDir, "config.json");
        writeAtomicSync(bkp, readFileSync(l.configPath), 0o600);
      } catch {}
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
