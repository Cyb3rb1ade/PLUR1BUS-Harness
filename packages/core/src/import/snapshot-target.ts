// Target pre-apply snapshot (docs/import.md §5.1 step 2, §5.5, Batch 4).
// Backs up the harness target state (config.json, touched agents/) before any mutation.
// Stores file hashes in manifest.json for tamper-evident verification during rollback.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Layout } from "../paths.ts";
import { copyAtomicSync, writeAtomicSync } from "./fs-atomic.ts";
import { ImportError } from "./types.ts";

export const DEFAULT_MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024; // 100 MiB

export interface TargetSnapshotFile {
  relPath: string;
  sha256: string;
  size: number;
}

export interface TargetSnapshotManifest {
  schema: "import.snapshot/1";
  runId: string;
  createdAt: string;
  targetHome: string;
  configExisted: boolean;
  configSha256: string | null;
  agentsExisted: boolean;
  files: Record<string, { sha256: string; size: number }>;
}

export interface TargetSnapshotResult {
  path: string;
  existed: boolean;
  manifestSha256: string;
  manifest: TargetSnapshotManifest;
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

export function createTargetSnapshot(
  l: Layout,
  runDir: string,
  runId: string,
  touchedAgentIds?: string[],
  now: () => Date = () => new Date(),
  maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
): TargetSnapshotResult {
  const snapDir = join(runDir, "snapshot");
  mkdirSync(snapDir, { recursive: true, mode: 0o700 });

  const filesRecord: Record<string, { sha256: string; size: number }> = {};
  let totalBytes = 0;

  const configExisted = existsSync(l.configPath);
  let configSha256: string | null = null;

  if (configExisted) {
    const st = statSync(l.configPath);
    totalBytes += st.size;
    if (totalBytes > maxSnapshotBytes) {
      throw new ImportError("E_SNAPSHOT_TOO_LARGE", "snapshot-too-large", `snapshot size exceeded ${maxSnapshotBytes} bytes`);
    }
    const snapConfig = join(snapDir, "config.json");
    copyAtomicSync(l.configPath, snapConfig, 0o600);
    configSha256 = sha256File(snapConfig);
    const origSha = sha256File(l.configPath);
    if (configSha256 !== origSha) {
      throw new ImportError("E_SNAPSHOT_CORRUPT", "snapshot-corrupt", "failed to snapshot config.json: hash mismatch");
    }
    filesRecord["config.json"] = { sha256: configSha256, size: st.size };
  }

  const agentsExisted = existsSync(l.agents);
  if (agentsExisted) {
    // Only snapshot touched agent directories if specified, otherwise existing agent dirs
    const agentDirsToSnapshot: string[] = [];
    if (touchedAgentIds && touchedAgentIds.length > 0) {
      for (const id of touchedAgentIds) {
        const ad = l.workspaceDir(id);
        if (existsSync(ad)) {
          agentDirsToSnapshot.push(ad);
        }
      }
    } else {
      agentDirsToSnapshot.push(l.agents);
    }

    for (const ad of agentDirsToSnapshot) {
      const files = walkFiles(ad);
      for (const f of files) {
        const st = statSync(f);
        totalBytes += st.size;
        if (totalBytes > maxSnapshotBytes) {
          throw new ImportError("E_SNAPSHOT_TOO_LARGE", "snapshot-too-large", `snapshot size exceeded ${maxSnapshotBytes} bytes`);
        }
        const rel = relative(l.home, f).replaceAll("\\", "/");
        const snapTarget = join(snapDir, rel);
        copyAtomicSync(f, snapTarget, 0o600);
        const copiedSha = sha256File(snapTarget);
        const origSha = sha256File(f);
        if (copiedSha !== origSha) {
          throw new ImportError("E_SNAPSHOT_CORRUPT", "snapshot-corrupt", `failed to snapshot ${rel}: hash mismatch`);
        }
        filesRecord[rel] = { sha256: copiedSha, size: st.size };
      }
    }
  }

  const existed = configExisted || agentsExisted;
  const manifest: TargetSnapshotManifest = {
    schema: "import.snapshot/1",
    runId,
    createdAt: now().toISOString(),
    targetHome: l.home,
    configExisted,
    configSha256,
    agentsExisted,
    files: filesRecord,
  };

  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  const manifestPath = join(snapDir, "manifest.json");
  writeAtomicSync(manifestPath, manifestJson, 0o600);
  const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");

  return {
    path: snapDir,
    existed,
    manifestSha256,
    manifest,
  };
}
