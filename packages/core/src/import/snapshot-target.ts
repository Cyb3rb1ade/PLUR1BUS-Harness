// Target pre-apply snapshot (docs/import.md §5.1 step 2, §5.5, Batch 4).
// Backs up the harness target state (config.json, agents/) before any mutation.
// Stores file hashes in manifest.json for tamper-evident verification during rollback.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Layout } from "../paths.ts";

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
  now: () => Date = () => new Date(),
): TargetSnapshotResult {
  const snapDir = join(runDir, "snapshot");
  mkdirSync(snapDir, { recursive: true, mode: 0o700 });

  const filesRecord: Record<string, { sha256: string; size: number }> = {};
  const configExisted = existsSync(l.configPath);
  let configSha256: string | null = null;

  if (configExisted) {
    configSha256 = sha256File(l.configPath);
    const snapConfig = join(snapDir, "config.json");
    cpSync(l.configPath, snapConfig);
    const st = statSync(l.configPath);
    filesRecord["config.json"] = { sha256: configSha256, size: st.size };
  }

  const agentsExisted = existsSync(l.agents);
  if (agentsExisted) {
    const snapAgents = join(snapDir, "agents");
    cpSync(l.agents, snapAgents, { recursive: true });
    const allAgentFiles = walkFiles(l.agents);
    for (const af of allAgentFiles) {
      const rel = relative(l.home, af).replaceAll("\\", "/");
      const sha = sha256File(af);
      const st = statSync(af);
      filesRecord[rel] = { sha256: sha, size: st.size };
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
  writeFileSync(manifestPath, manifestJson, { mode: 0o600 });
  const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");

  return {
    path: snapDir,
    existed,
    manifestSha256,
    manifest,
  };
}
