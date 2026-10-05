// Rollback engine for harness imports (docs/import.md §5.5, §9.6, Batch 4).
// Restores the target state prior to the import, verified via hashes, under withTargetLock.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { layout, type Layout } from "../paths.ts";
import { withTargetLock } from "./single-writer.ts";
import type { TargetSnapshotManifest } from "./snapshot-target.ts";
import { ImportError, type SourceType } from "./types.ts";

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
    if (ent.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (ent.isFile()) {
      results.push(full);
    }
  }
  return results.sort();
}

function cleanEmptyDirs(dir: string, stopAt: string): void {
  if (dir === stopAt || !dir.startsWith(stopAt)) return;
  try {
    const entries = readdirSync(dir);
    if (entries.length === 0) {
      rmdirSync(dir);
      cleanEmptyDirs(dirname(dir), stopAt);
    }
  } catch {
    // Ignore cleanup failures on non-empty dirs
  }
}

function writeAtomicFsync(path: string, content: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  import("node:fs").then((fs) => fs.renameSync(tmp, path));
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

  // 1. Read and validate report.json
  let rep: any;
  try {
    rep = JSON.parse(readFileSync(opts.reportPath, "utf8"));
  } catch (e: any) {
    throw invalid("report-unreadable", `${opts.reportPath}: ${e.message}`);
  }

  const runId = rep.runId ?? rep.importId;
  if (typeof runId !== "string" || !runId) {
    throw invalid("run-id-invalid", "the report's runId is missing or invalid");
  }
  if (rep.mode !== "apply") {
    throw invalid("not-an-apply-report", "only an --apply run can be rolled back");
  }
  if (rep.sourceType && rep.sourceType !== opts.sourceType) {
    throw invalid("source-mismatch", `the report is for ${String(rep.sourceType)}, not ${opts.sourceType}`);
  }

  // Check report path location
  const runDir = join(l.home, "imports", runId);
  let realReportPath: string;
  try {
    realReportPath = realpathSync(opts.reportPath);
  } catch {
    throw invalid("report-missing", `the report file was not found at ${opts.reportPath}`);
  }

  const snapPath = join(runDir, "snapshot");
  if (!existsSync(snapPath)) {
    throw invalid("snapshot-missing", `snapshot directory missing at ${snapPath}`);
  }

  const rolledBackMarker = join(runDir, "rolled-back");
  if (existsSync(join(rolledBackMarker, "status.json"))) {
    throw invalid("already-rolled-back", `run ${runId} was already rolled back`);
  }

  // 2. Read and verify snapshot manifest
  const manifestPath = join(snapPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw invalid("snapshot-invalid", `snapshot manifest missing at ${manifestPath}`);
  }

  let manifest: TargetSnapshotManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e: any) {
    throw invalid("snapshot-corrupt", `snapshot manifest is invalid: ${e.message}`);
  }

  // Verify snapshot file integrity
  for (const [relPath, meta] of Object.entries(manifest.files)) {
    const snapFile = join(snapPath, relPath);
    if (!existsSync(snapFile)) {
      throw invalid("snapshot-corrupt", `snapshot file ${relPath} is missing`);
    }
    const actualHash = sha256File(snapFile);
    if (actualHash !== meta.sha256) {
      throw invalid("snapshot-corrupt", `snapshot file ${relPath} hash mismatch`);
    }
  }

  // 3. Compute planned changes
  // Collect all target files under l.home that are part of config or agents
  const currentTargetFiles = new Set<string>();
  if (existsSync(l.configPath)) {
    currentTargetFiles.add("config.json");
  }
  if (existsSync(l.agents)) {
    for (const f of walkFiles(l.agents)) {
      const rel = relative(l.home, f).replaceAll("\\", "/");
      currentTargetFiles.add(rel);
    }
  }

  const allKnownPaths = new Set([...Object.keys(manifest.files), ...currentTargetFiles]);
  const changes: RollbackChange[] = [];

  for (const rel of [...allKnownPaths].sort()) {
    const inSnap = Object.hasOwn(manifest.files, rel);
    const inTarget = currentTargetFiles.has(rel);
    const targetFile = join(l.home, rel);

    if (inSnap && !inTarget) {
      changes.push({ path: rel, change: "restore" });
    } else if (!inSnap && inTarget) {
      changes.push({ path: rel, change: "remove" });
    } else if (inSnap && inTarget) {
      const targetHash = sha256File(targetFile);
      if (targetHash === manifest.files[rel]!.sha256) {
        changes.push({ path: rel, change: "unchanged" });
      } else {
        changes.push({ path: rel, change: "revert" });
      }
    }
  }

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

  // 4. Execute apply under single-writer lock
  return await withTargetLock(l, async () => {
    mkdirSync(rolledBackMarker, { recursive: true, mode: 0o700 });
    const backupDir = join(rolledBackMarker, "replaced");
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });

    for (const c of changes) {
      const targetPath = join(l.home, c.path);
      const snapFilePath = join(snapPath, c.path);

      if (c.change === "remove") {
        if (existsSync(targetPath)) {
          // Backup before removal
          const bkp = join(backupDir, c.path);
          mkdirSync(dirname(bkp), { recursive: true, mode: 0o700 });
          writeFileSync(bkp, readFileSync(targetPath));
          unlinkSync(targetPath);
          cleanEmptyDirs(dirname(targetPath), l.home);
        }
      } else if (c.change === "revert" || c.change === "restore") {
        if (existsSync(targetPath)) {
          // Backup current differing target
          const bkp = join(backupDir, c.path);
          mkdirSync(dirname(bkp), { recursive: true, mode: 0o700 });
          writeFileSync(bkp, readFileSync(targetPath));
        }
        mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
        const snapContent = readFileSync(snapFilePath);
        writeFileSync(targetPath, snapContent, { mode: 0o600 });
      }
    }

    // If config did not exist before apply, ensure it is removed
    if (!manifest.configExisted && existsSync(l.configPath)) {
      unlinkSync(l.configPath);
    }

    // If agents dir did not exist before apply, clean it up if empty or remove
    if (!manifest.agentsExisted && existsSync(l.agents)) {
      try {
        const remaining = walkFiles(l.agents);
        if (remaining.length === 0) {
          rmSync(l.agents, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }

    // Verify post-restore state matches manifest
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

    // Write completion marker
    const finishedDate = opts.now ? opts.now() : new Date();
    const statusData = {
      runId,
      sourceType: opts.sourceType,
      rolledBackAt: finishedDate.toISOString(),
      changesCount: changes.length,
    };
    writeFileSync(join(rolledBackMarker, "status.json"), JSON.stringify(statusData, null, 2) + "\n", { mode: 0o600 });

    out.status = "completed";
    out.movedAside = backupDir;
    out.finishedAt = finishedDate.toISOString();
    return out;
  });
}
