/** Private sealed snapshots from either six-operation reader; live paths are never opened by native parsers. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createSecurePath } from "@plur1bus/module-api";
import { SourceReader } from "./source-reader.ts";
import { isSecretFileName } from "./readonly.ts";
import { ImportError } from "./types.ts";
import { sealSourceConfiguration, sourceConfigurationKeys } from "./source-seal.ts";
import type { CreateSnapshotOptions, SnapshotMetadata, SnapshotResult } from "./snapshot.ts";
import { locateSource } from "./paths.ts";

const refuse = (reason: string) => new ImportError("E_IMPORT_FAILED", reason, "Source snapshot could not be prepared", 3);

async function privateDirectory(path: string, recursive = false): Promise<void> {
  await mkdir(path, { recursive, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !createSecurePath()(path, { mode: 0o700 }).applied) throw refuse("private-staging-unavailable");
}

async function privateFile(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    if (!createSecurePath()(path, { mode: 0o600 }).applied) throw refuse("private-staging-unavailable");
    await file.writeFile(bytes);
    await file.sync();
  } finally { await file.close(); }
}

export async function createReaderSnapshot(options: CreateSnapshotOptions): Promise<SnapshotResult> {
  if (!options.reader) throw refuse("reader-required");
  const selected = options.sourceRoot ?? options.source;
  if (!selected) throw refuse("source-missing");
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 10_000;
  const maxDepth = options.maxDepth ?? 32;
  const maxFile = options.maxFileBytes ?? 32 * 1024 * 1024;
  const timeout = options.timeoutMs ?? 60_000;
  for (const value of [maxBytes, maxFiles, maxDepth, maxFile, timeout]) {
    if (!Number.isSafeInteger(value) || value < 1) throw refuse("invalid-limit");
  }
  const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])]);
  const reader = new SourceReader({ ...options.reader, signal });
  const root = await reader.select(selected);
  const markers = options.sourceType === "openclaw" ? ["openclaw.json", "clawdbot.json", "state/openclaw.sqlite"]
    : ["config.yaml", "state.db"];
  if (!options.selectedTree && !(await Promise.all(markers.map(name => reader.isFile(reader.paths.join(root, name))))).some(Boolean)) {
    throw new ImportError("E_SOURCE_NOT_FOUND", "source-marker-missing", "Selected directory is not a supported source home");
  }
  const deadline = Date.now() + timeout;
  const check = () => {
    if (options.signal?.aborted) throw refuse("aborted");
    if (Date.now() >= deadline) throw refuse("timeout");
  };
  const run = join(options.home, "import", `snap-${randomUUID()}`);
  let destination = resolve(options.stagingDir ?? join(run, "snapshot"));
  const hostHome = resolve(options.home);
  const location = relative(hostHome, destination).split(sep);
  if (!location.length || location.length > 16 || location.some(part => !part || part === "." || part === "..")
    || !destination.startsWith(hostHome + sep)) throw refuse("snapshot-location-invalid");
  let owned = false;
  let total = 0;
  const provenance = reader.remote ? { sourceRoot: root, sourceHome: null, origin: "network", flavour: "posix" }
    : locateSource({ accessRoot: selected, platform: options.platform ?? process.platform, env: options.env ?? {},
      home: options.homedir ?? null, harnessHome: options.home, skipSnapshotCheck: true });
  const metadata: SnapshotMetadata = { version: 1, source: selected, sourceRoot: provenance.sourceRoot, sourceHome: provenance.sourceHome,
    origin: provenance.origin, flavour: provenance.flavour,
    timestamp: new Date().toISOString(), files: [], sqlite: {}, envKeys: {}, omittedCredentials: [], skippedLinks: [] };
  try {
    let parent = hostHome;
    const actualHome = await realpath(hostHome);
    for (const part of location.slice(0, -1)) {
      parent = join(parent, part);
      await mkdir(parent, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      if ((await lstat(parent)).isSymbolicLink()) throw refuse("snapshot-location-invalid");
      if (!createSecurePath()(parent, { mode: 0o700 }).applied) throw refuse("private-staging-unavailable");
    }
    const actualParent = await realpath(dirname(destination));
    if (relative(actualHome, actualParent) !== location.slice(0, -1).join(sep)) throw refuse("snapshot-location-invalid");
    destination = join(actualParent, basename(destination));
    if (!reader.remote) {
      const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
      if (inside(root, destination) || inside(destination, root)) throw refuse("snapshot-overlap");
    }
    await privateDirectory(destination);
    owned = true;
    const copy = async (source: string, relative: string, depth: number): Promise<void> => {
      check();
      if (depth > maxDepth) throw refuse("depth-limit");
      for (const name of await reader.names(source)) {
        check();
        const path = reader.paths.join(source, name);
        const rel = relative ? `${relative}/${name}` : name;
        if (name === ".git" || !relative && name === "snapshot.json") continue;
        const info = await reader.stat(path, false);
        if (info?.type === "symlink") { metadata.skippedLinks!.push(rel); continue; }
        const sensitive = isSecretFileName(name) || name.toLowerCase() === "auth-profiles.json" || name === "openclaw-agent.sqlite" || name.startsWith("openclaw-agent.sqlite-");
        if (sensitive || name.toLowerCase() === "credentials") {
          metadata.omittedCredentials!.push(info?.type === "directory" ? rel + "/" : rel);
          if (info?.type === "file" && (name === ".env" || name.startsWith(".env."))) metadata.envKeys[rel] = await reader.envKeys(path);
          continue;
        }
        if (info?.type === "directory") {
          const canonical = await reader.fs.realpath(path);
          const delta = reader.paths.relative(root, canonical);
          if (delta === ".." || delta.startsWith("../") || reader.paths.isAbsolute(delta)) throw refuse("source-path-denied");
          await privateDirectory(join(destination, rel));
          await copy(path, rel, depth + 1);
        } else if (info?.type === "file") {
          if (metadata.files.length >= maxFiles) throw refuse("file-limit");
          if (info.size > maxFile || total + info.size > maxBytes) throw refuse("byte-limit");
          const sourceBytes = await reader.read(path, maxFile);
          const found = sourceConfigurationKeys(rel, sourceBytes);
          if (found.length) {
            metadata.omittedConfigKeys ??= [];
            metadata.omittedConfigKeys.push(...found);
            if (metadata.omittedConfigKeys.length > 4096) throw refuse("source-key-limit");
          }
          const bytes = sealSourceConfiguration(rel, sourceBytes);
          if (bytes.length > maxFile || total + bytes.length > maxBytes) throw refuse("byte-limit");
          await privateFile(join(destination, rel), bytes);
          total += bytes.length;
          metadata.files.push({ path: rel, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
            ...(info.mode === undefined ? {} : { sourceMode: info.mode }),
            ...(info.mtimeMs === undefined ? {} : { mtimeMs: info.mtimeMs }) });
          if (/\.(db|sqlite|sqlite3)$/.test(name)) metadata.sqlite[rel] = { status: "copy", attempts: 1 };
        } else throw refuse("unsupported-source-entry");
      }
    };
    await copy(root, "", 0);
    check();
    await reader.verify();
    check();
    metadata.files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = Buffer.from(JSON.stringify(metadata, null, 2) + "\n");
    if (manifest.length > 8 * 1024 * 1024) throw refuse("metadata-limit");
    await privateFile(join(destination, "snapshot.json"), manifest);
    return { stagingDir: destination, metadata };
  } catch (error) {
    if (owned) await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
