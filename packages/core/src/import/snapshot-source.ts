// Validate an existing source snapshot before any importer consumes it.
import { createHash } from "node:crypto";
import { readdirSync, realpathSync } from "node:fs";
import { realpath as trustedRealpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { existsNoFollow, readSourceFileSafe, readSourceTextSafe } from "./fs-safe.ts";
import { ImportError } from "./types.ts";

export interface SnapshotSourceInfo {
  omittedCredentials: string[];
  envKeys: Record<string, string[]>;
  skippedFiles: Array<{ path: string; reason: string }>;
  configKeys?: import("./types.ts").SecretsReport["configKeys"];
}

function configKeys(meta: any): import("./types.ts").SecretsReport["configKeys"] {
  if (!Array.isArray(meta.omittedConfigKeys)) return [];
  return meta.omittedConfigKeys.slice(0, 4096).filter((entry: any) => typeof entry?.path === "string"
    && entry.path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(entry.path) && ["inline", "env-ref", "object"].includes(entry.form))
    .map((entry: { path: string; form: import("./types.ts").SecretsReport["configKeys"][number]["form"] }) =>
      ({ path: entry.path, form: entry.form }));
}

export function verifySourceSnapshot(root: string, home: string): SnapshotSourceInfo | null {
  const manifest = join(root, "snapshot.json");
  if (!existsNoFollow(manifest)) return null;
  const refuse = (reason: string): never => { throw new ImportError("E_SOURCE_UNSUPPORTED", reason, reason); };
  let meta: any;
  try { meta = JSON.parse(readSourceTextSafe(manifest, 8 * 1024 * 1024)); }
  catch { refuse("snapshot-manifest-invalid"); }
  if (meta?.version !== 1 || !Array.isArray(meta.files)) refuse("snapshot-manifest-invalid");
  const realRoot = realpathSync(root);
  let realImport: string;
  try { realImport = realpathSync(join(home, "import")); } catch { refuse("snapshot-location-invalid"); }
  const location = relative(realImport!, realRoot).split(sep);
  if (location.length !== 2 || !location[0] || location[0] === ".." || location[1] !== "snapshot") refuse("snapshot-location-invalid");
  const listed = new Set<string>();
  for (const file of meta.files) {
    const path = file?.path;
    if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)
      || path.split("/").some(s => s === ".." || s === "." || s === "")) refuse("snapshot-path-traversal");
    if (path === "snapshot.json" || listed.has(path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) refuse("snapshot-manifest-invalid");
    listed.add(path);
    const full = resolve(root, path);
    let real: string;
    try { real = realpathSync(full); } catch { refuse("snapshot-content-mismatch"); }
    if (!real!.startsWith(realRoot + sep)) refuse("snapshot-path-traversal");
    const bytes = readSourceFileSafe(full, file.size);
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) refuse("snapshot-content-mismatch");
  }
  // Unlisted files must not become import inputs, including via a substituted directory link.
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) refuse("snapshot-path-traversal");
      if (entry.isDirectory()) walk(full);
      else if (rel !== "snapshot.json" && !listed.has(rel)) refuse("snapshot-unlisted-file");
    }
  };
  walk(root);
  const omittedCredentials = Array.isArray(meta.omittedCredentials) ? meta.omittedCredentials : [];
  for (const path of omittedCredentials) {
    if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) refuse("snapshot-path-traversal");
  }
  const envKeys: Record<string, string[]> = Object.create(null);
  for (const path of omittedCredentials) {
    const keys = meta.envKeys?.[path];
    if (Array.isArray(keys)) envKeys[path] = keys.filter((key: unknown): key is string => typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  }
  const skippedFiles = Array.isArray(meta.skippedFiles) ? meta.skippedFiles.filter((entry: any) => typeof entry?.path === "string" && entry.reason === "invalid-filename-encoding") : [];
  return { omittedCredentials, envKeys, skippedFiles, ...(configKeys(meta).length ? { configKeys: configKeys(meta) } : {}) };
}

export async function verifySourceSnapshotAsync(root: string, home: string, reader: import("./source-reader.ts").SourceReader): Promise<SnapshotSourceInfo | null> {
  if (reader.remote) return null;
  const { join, relative, resolve, sep } = reader.paths;
  const manifest = join(root, "snapshot.json");
  if (!await reader.exists(manifest)) return null;
  const refuse = (reason: string): never => { throw new ImportError("E_SOURCE_UNSUPPORTED", reason, reason); };
  let meta: any;
  try { meta = JSON.parse(await reader.text(manifest, 8 * 1024 * 1024)); }
  catch { refuse("snapshot-manifest-invalid"); }
  if (meta?.version !== 1 || !Array.isArray(meta.files)) refuse("snapshot-manifest-invalid");
  const realRoot = await reader.fs.realpath(root);
  let realImport: string;
  try { realImport = await trustedRealpath(join(home, "import")); } catch { refuse("snapshot-location-invalid"); }
  const location = relative(realImport!, realRoot).split(sep);
  if (location.length !== 2 || !location[0] || location[0] === ".." || location[1] !== "snapshot") refuse("snapshot-location-invalid");
  const listed = new Set<string>();
  for (const file of meta.files) {
    const path = file?.path;
    if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)
      || path.split("/").some(s => s === ".." || s === "." || s === "")) refuse("snapshot-path-traversal");
    if (path === "snapshot.json" || listed.has(path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) refuse("snapshot-manifest-invalid");
    listed.add(path);
    const full = resolve(root, path);
    let real: string;
    try { real = await reader.fs.realpath(full); } catch { refuse("snapshot-content-mismatch"); }
    if (!real!.startsWith(realRoot + sep)) refuse("snapshot-path-traversal");
    const bytes = await reader.read(full, file.size);
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) refuse("snapshot-content-mismatch");
    if (file.sourceMode !== undefined) {
      if (!Number.isInteger(file.sourceMode) || file.sourceMode < 0 || file.sourceMode > 0o777) refuse("snapshot-manifest-invalid");
      reader.snapshotMode(full, file.sourceMode);
    }
  }
  // Unlisted files must not become import inputs, including via a substituted directory link.
  const walk = async (dir: string): Promise<void> => {
    for (const name of await reader.names(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      const entry = await reader.stat(full, false);
      if (entry?.type === "symlink") refuse("snapshot-path-traversal");
      if (entry?.type === "directory") await walk(full);
      else if (rel !== "snapshot.json" && !listed.has(rel)) refuse("snapshot-unlisted-file");
    }
  };
  await walk(root);
  const omittedCredentials = Array.isArray(meta.omittedCredentials) ? meta.omittedCredentials : [];
  for (const path of omittedCredentials) {
    if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) refuse("snapshot-path-traversal");
  }
  const envKeys: Record<string, string[]> = Object.create(null);
  for (const path of omittedCredentials) {
    const keys = meta.envKeys?.[path];
    if (Array.isArray(keys)) envKeys[path] = keys.filter((key: unknown): key is string => typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  }
  const skippedFiles = Array.isArray(meta.skippedFiles) ? meta.skippedFiles.filter((entry: any) => typeof entry?.path === "string" && entry.reason === "invalid-filename-encoding") : [];
  return { omittedCredentials, envKeys, skippedFiles, ...(configKeys(meta).length ? { configKeys: configKeys(meta) } : {}) };
}
