// Packaged host-side snapshot producer. Stdin/stdout are private native pipes; no path or source error reaches stdout.
// This entry bundles only the shared read-only snapshot copier and Node builtins, never the memory engine.
import { isAbsolute, join, relative } from "node:path";
import { chmodSync, statSync } from "node:fs";
import { createLocalFs } from "../../../packages/remote-fs/src/local.ts";
import { createSnapshot } from "../../../packages/core/src/import/snapshot.ts";
import { isSourceType, type SourceType } from "../../../packages/core/src/import/types.ts";
import { writeTarGz } from "../../../scripts/release/archive.mjs";

interface SnapshotJob {
  schema: "desktop.import-snapshot/1";
  sourceType: SourceType;
  sourceRoot: string;
  home: string;
  stagingDir: string;
  allowLiveCopy: false;
}

function validate(input: unknown): SnapshotJob {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid");
  const job = input as Record<string, unknown>;
  const fields = ["schema", "sourceType", "sourceRoot", "home", "stagingDir", "allowLiveCopy"];
  if (Object.keys(job).length !== fields.length || Object.keys(job).some(key => !fields.includes(key))
    || job.schema !== "desktop.import-snapshot/1" || !isSourceType(job.sourceType)
    || job.allowLiveCopy !== false) throw new Error("invalid");
  for (const key of ["sourceRoot", "home", "stagingDir"]) {
    const value = job[key];
    if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || !isAbsolute(value)) throw new Error("invalid");
  }
  const rel = relative(job.home as string, job.stagingDir as string);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid");
  return job as unknown as SnapshotJob;
}

async function run(): Promise<void> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const next = Buffer.from(chunk);
    bytes += next.length;
    if (bytes > 16 * 1024) throw new Error("invalid");
    chunks.push(next);
  }
  const job = validate(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const fs = await createLocalFs({ root: job.sourceRoot, limits: { timeoutMs: 60_000,
    maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 1024 ** 3, maxDepth: 32, maxEntries: 100_000 } });
  const result = await createSnapshot({ ...job, reader: { fs, root: job.sourceRoot }, env: {}, homedir: undefined });
  const fileCount = result.metadata.files.length;
  const totalBytes = result.metadata.files.reduce((total, file) => total + file.size, 0);
  const archive = join(job.home, "snapshot.tar.gz");
  const sha256 = await writeTarGz(result.stagingDir, archive);
  chmodSync(archive, 0o600);
  process.stdout.write(`${JSON.stringify({ schema: "desktop.import-snapshot-result/1", ok: true, fileCount, bytes: totalBytes,
    archiveBytes: statSync(archive).size, sha256 })}\n`);
}

void run().catch(() => {
  process.stdout.write(`${JSON.stringify({ schema: "desktop.import-snapshot-result/1", ok: false, reason: "snapshot-failed" })}\n`);
  process.exitCode = 1;
});
