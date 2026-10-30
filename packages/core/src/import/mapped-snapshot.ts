/** Explicit host path mappings become another immutable sealed source before maintenance can begin. */
import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createLocalFs } from "@plur1bus/remote-fs";
import { createSnapshot, DEFAULT_SNAPSHOT_MAX_BYTES, DEFAULT_SNAPSHOT_MAX_FILES, type SnapshotMetadata } from "./snapshot.ts";
import type { SourceRegistry } from "./source-registry.ts";
import type { SourceReaderOptions } from "./source-reader.ts";
import { readColdBytes } from "./maintenance-files.ts";
import { writeAtomicSync } from "./fs-atomic.ts";
import { verifySourceSnapshot } from "./snapshot-source.ts";
import { ImportError } from "./types.ts";

type Captured = Awaited<ReturnType<SourceRegistry["get"]>>;
const refused = () => new ImportError("E_INVALID_PARAMS", "source-map-invalid", "Import source map is invalid");

async function metadata(root: string): Promise<SnapshotMetadata> {
  return JSON.parse((await readColdBytes(join(root, "snapshot.json"), 8 * 1024 * 1024)).toString("utf8"));
}

/** Caller already proved Owner or a trusted local administrator for every additional local authority. */
export async function createMappedSnapshot(options: {
  home: string;
  source: Captured;
  maps: readonly { from: string; to: string; reader?: SourceReaderOptions }[];
  signal?: AbortSignal;
}): Promise<{ snapshotId: string; root: string; metadata: SnapshotMetadata; sha256: string;
  maps: { from: string; to: string }[] }> {
  if (!options.maps.length || options.maps.length > 64) throw refused();
  const destinations = new Set<string>();
  for (const mapping of options.maps) {
    if (!mapping.from || !mapping.to || !(mapping.reader?.remote ? mapping.to.startsWith("/") : isAbsolute(mapping.to)) || destinations.has(mapping.from)
      || !/^(?:\/|\\\\|[A-Za-z]:[\\/])/.test(mapping.from)
      || mapping.from.includes("\0") || mapping.to.includes("\0")) throw refused();
    destinations.add(mapping.from);
  }
  const signal = AbortSignal.any([AbortSignal.timeout(600_000), ...(options.signal ? [options.signal] : [])]);
  const snapshotId = randomBytes(32).toString("base64url");
  const root = join(options.home, "import", snapshotId, "snapshot");
  let kept = false;
  try {
    await createSnapshot({ sourceType: options.source.record.sourceType, sourceRoot: options.source.root,
      home: options.home, stagingDir: root, reader: options.source.reader, signal, timeoutMs: 600_000 });
    const base = await metadata(root);
    const sourceModes = new Map(options.source.metadata.files.map(file => [file.path, file.sourceMode]));
    for (const file of base.files) {
      const mode = sourceModes.get(file.path);
      if (mode !== undefined) file.sourceMode = mode;
    }
    const output: SnapshotMetadata = { ...base,
      source: options.source.metadata.source, sourceRoot: options.source.metadata.sourceRoot,
      sourceHome: options.source.metadata.sourceHome, origin: options.source.metadata.origin,
      flavour: options.source.metadata.flavour, envKeys: { ...options.source.metadata.envKeys },
      omittedCredentials: [...options.source.metadata.omittedCredentials ?? []],
      omittedConfigKeys: (options.source.metadata.omittedConfigKeys ?? []).map(({ path, form }) => ({ path, form })) };
    const prefix = `_maps_${randomBytes(16).toString("hex")}`;
    const maps: { from: string; to: string }[] = [];
    let bytes = output.files.reduce((sum, file) => sum + file.size, 0);
    for (const [index, mapping] of options.maps.entries()) {
      signal.throwIfAborted();
      if (output.files.length >= DEFAULT_SNAPSHOT_MAX_FILES || bytes >= DEFAULT_SNAPSHOT_MAX_BYTES) throw refused();
      const selected = mapping.reader ? mapping.to : resolve(mapping.to);
      if (!mapping.reader?.remote) {
        const nested = relative(selected, root);
        const reverse = relative(root, selected);
        if (nested === "" || nested !== ".." && !nested.startsWith(".." + sep) && !isAbsolute(nested)
          || reverse === "" || reverse !== ".." && !reverse.startsWith(".." + sep) && !isAbsolute(reverse)) throw refused();
      }
      let reader = mapping.reader;
      if (!reader) {
        const fs = await createLocalFs({ root: selected, signal,
          limits: { timeoutMs: 600_000, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: DEFAULT_SNAPSHOT_MAX_BYTES,
            maxEntries: DEFAULT_SNAPSHOT_MAX_FILES, maxDepth: 32 } });
        reader = { fs, root: await fs.realpath(".") };
      }
      const partPath = `${prefix}/${index}`;
      const partRoot = join(root, partPath);
      await createSnapshot({ sourceType: options.source.record.sourceType, sourceRoot: selected, home: options.home,
        selectedTree: true,
        timeoutMs: 600_000,
        stagingDir: partRoot, reader, signal, maxDepth: 30,
        maxFiles: DEFAULT_SNAPSHOT_MAX_FILES - output.files.length, maxBytes: DEFAULT_SNAPSHOT_MAX_BYTES - bytes });
      const part = await metadata(partRoot);
      await rm(join(partRoot, "snapshot.json"));
      for (const file of part.files) output.files.push({ ...file, path: `${partPath}/${file.path}` });
      for (const [path, names] of Object.entries(part.envKeys)) output.envKeys[`${partPath}/${path}`] = [...names];
      output.omittedCredentials!.push(...(part.omittedCredentials ?? []).map(path => `${partPath}/${path}`));
      output.omittedConfigKeys!.push(...(part.omittedConfigKeys ?? []).map(({ path, form }) => ({ path, form })));
      for (const [path, info] of Object.entries(part.sqlite)) output.sqlite[`${partPath}/${path}`] = info;
      bytes += part.files.reduce((sum, file) => sum + file.size, 0);
      maps.push({ from: mapping.from, to: partPath });
    }
    output.files.sort((a, b) => a.path.localeCompare(b.path));
    const encoded = JSON.stringify(output, null, 2) + "\n";
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024 || output.omittedConfigKeys!.length > 4096) throw refused();
    writeAtomicSync(join(root, "snapshot.json"), encoded, 0o600);
    if (!verifySourceSnapshot(root, options.home)) throw refused();
    kept = true;
    return { snapshotId, root, metadata: output, sha256: createHash("sha256").update(encoded).digest("hex"), maps };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw refused();
  } finally {
    if (!kept) await rm(join(options.home, "import", snapshotId), { recursive: true, force: true });
  }
}
