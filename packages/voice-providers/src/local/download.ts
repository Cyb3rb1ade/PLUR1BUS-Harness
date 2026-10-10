// Model download: sha256-verified, resumable, with progress. Bytes land in `<modelsDir>/.downloads/<id>/` as `.part`
// files (kept on failure so the next try resumes with a Range request), are verified, then assembled in a staging
// directory, audited (no links, no escapes, bounded size) and swapped into place: the previous version is renamed
// aside first and removed only once the new one is in place. A model directory only exists when it is complete.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { VoiceProviderError, abortedError } from "../errors.ts";
import type { FetchLike } from "../http.ts";
import { assertSecureTransport } from "../util.ts";
import { assertLicenceAccepted, downloadable, type CatalogModel, type DownloadItem } from "./catalog.ts";

export interface DownloadProgress {
  modelId: string;
  item: number;
  items: number;
  receivedBytes: number;
  /** null when neither the catalog nor the server knows the size. */
  totalBytes: number | null;
}
export type ExtractFn = (archive: string, destDir: string, options: { format: "tar.bz2"; stripComponents: number }) => Promise<void>;

export interface DownloadOptions {
  modelsDir: string;
  fetch?: FetchLike;
  /** Licence keys (see licenceKey) the owner confirmed. */
  acceptedLicences?: ReadonlySet<string> | readonly string[];
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  extract?: ExtractFn;
  /** Largest download for an item whose catalog size is unknown. Default 2 GiB. */
  maxBytes?: number;
  /** Largest number of entries an extracted archive may hold. Default 20000. */
  maxEntries?: number;
  /** Test seam for the final directory moves. */
  rename?: (from: string, to: string) => Promise<void>;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 20_000;
/** Extracted size may be this many times the download cap (compression ratio guard). */
const EXTRACT_FACTOR = 4;

const exec = promisify(execFile);
async function tarBinary(): Promise<string> {
  if (process.platform !== "win32") return "tar";
  // Git-for-Windows puts a GNU tar earlier in PATH that reads "C:\\x" as host:path; the system bsdtar does not.
  const sys = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
  try { await access(sys); return sys; } catch { return "tar"; }
}
async function isGnuTar(bin: string): Promise<boolean> {
  try { return /GNU tar/.test((await exec(bin, ["--version"])).stdout); } catch { return false; }
}
/**
 * Default extractor: the system `tar` (bsdtar on Windows 10+ and macOS, GNU tar on Linux), no shell involved.
 * Owner and permission bits from the archive are not applied. Absolute and parent-directory members are refused by
 * both tars by default; `downloadModel` additionally audits the extracted tree for links and escapes.
 */
export const tarExtract: ExtractFn = async (archive, destDir, o) => {
  await mkdir(destDir, { recursive: true });
  const bin = await tarBinary();
  const args = ["-xjf", archive, "-C", destDir, `--strip-components=${o.stripComponents}`, "--no-same-owner", "--no-same-permissions"];
  if (await isGnuTar(bin)) args.push("--force-local");
  try {
    await exec(bin, args, { maxBuffer: 1024 * 1024 });
  } catch {
    // The raw error carries the command line and tar's stderr; neither is useful to a caller.
    throw new VoiceProviderError("download_failed", "extracting the model archive failed");
  }
};

/**
 * Walk the extracted tree: no symlinks, no multiply-linked files, nothing but files and directories, nothing whose
 * real path leaves `root`, and bounded entry count and total size. Returns the number of unsafe entries and whether a
 * limit was hit; names are never reported.
 */
async function auditTree(root: string, maxBytes: number, maxEntries: number): Promise<{ unsafe: number; entries: number; bytes: number }> {
  const realRoot = await realpath(root);
  let unsafe = 0;
  let entries = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const ent of await readdir(dir)) {
      const p = join(dir, ent);
      entries++;
      if (entries > maxEntries) return { unsafe: unsafe + 1, entries, bytes };
      const st = await lstat(p);
      if (st.isSymbolicLink()) { unsafe++; continue; }
      const real = await realpath(p);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) { unsafe++; continue; }
      if (st.isDirectory()) { stack.push(p); continue; }
      if (!st.isFile() || st.nlink > 1) { unsafe++; continue; }
      bytes += st.size;
      if (bytes > maxBytes) return { unsafe: unsafe + 1, entries, bytes };
    }
  }
  return { unsafe, entries, bytes };
}

export function modelDir(modelsDir: string, id: string): string {
  return join(modelsDir, id);
}

export async function isInstalled(modelsDir: string, model: CatalogModel): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(modelDir(modelsDir, model.id), ".complete.json"), "utf8")) as { sha256?: unknown };
    const want = model.download.map((d) => d.sha256?.toLowerCase() ?? null);
    return Array.isArray(marker.sha256) && marker.sha256.length === want.length && marker.sha256.every((h, i) => h === want[i]);
  } catch {
    return false;
  }
}

/** A crashed swap can leave `<id>.old-*` behind: put it back when the model directory is gone, else delete it. */
async function recoverOldDirs(modelsDir: string, id: string): Promise<void> {
  let names: string[];
  try { names = await readdir(modelsDir); } catch { return; }
  const dir = modelDir(modelsDir, id);
  for (const n of names.filter((x) => x.startsWith(`${id}.old-`))) {
    const old = join(modelsDir, n);
    const present = await stat(dir).then(() => true, () => false);
    if (!present) await rename(old, dir).catch(() => {});
    else await rm(old, { recursive: true, force: true });
  }
}

/** Download and install one model. Idempotent: an installed model returns immediately. */
export async function downloadModel(model: CatalogModel, o: DownloadOptions): Promise<string> {
  assertLicenceAccepted(model, o.acceptedLicences ?? []);
  const dir = modelDir(o.modelsDir, model.id);
  await recoverOldDirs(o.modelsDir, model.id);
  if (await isInstalled(o.modelsDir, model)) return dir;
  const ok = downloadable(model);
  if (!ok.ok) throw new VoiceProviderError("catalog", `${model.displayName} cannot be downloaded: ${ok.reason}`);
  for (const item of model.download) assertSecureTransport(item.url!, "local");
  const fetchFn: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
  const move = o.rename ?? rename;
  const staging = join(o.modelsDir, `.staging-${model.id}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const partDir = join(o.modelsDir, ".downloads", model.id);
  await mkdir(partDir, { recursive: true });
  const cap = o.maxBytes ?? DEFAULT_MAX_BYTES;
  try {
    for (let i = 0; i < model.download.length; i++) {
      const item = model.download[i]!;
      const part = join(partDir, `${i}.part`);
      await fetchItem(model, item, i, part, fetchFn, o, item.sizeBytes ?? cap);
      if (item.archive) await (o.extract ?? tarExtract)(part, staging, { format: item.archive, stripComponents: item.stripComponents ?? 0 });
      else {
        const target = join(staging, item.path!);
        await mkdir(dirname(target), { recursive: true });
        await rename(part, target).catch(async () => { await writeFile(target, await readFile(part)); });
      }
    }
    const audit = await auditTree(staging, cap * EXTRACT_FACTOR, o.maxEntries ?? DEFAULT_MAX_ENTRIES);
    if (audit.unsafe > 0) {
      await rm(partDir, { recursive: true, force: true });
      throw new VoiceProviderError("download_failed", `${model.displayName}: the archive contained ${audit.unsafe} unsafe or oversized entr${audit.unsafe === 1 ? "y" : "ies"}; nothing was installed`);
    }
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
  await writeFile(join(staging, ".complete.json"), JSON.stringify({ id: model.id, sha256: model.download.map((d) => d.sha256!.toLowerCase()) }));
  // Swap: the previous version stays on disk until the new one is in place.
  const aside = `${dir}.old-${process.pid}`;
  let movedAside = false;
  try { await move(dir, aside); movedAside = true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") { await rm(staging, { recursive: true, force: true }); throw new VoiceProviderError("download_failed", `${model.displayName}: the installed version could not be replaced`); }
  }
  try {
    await move(staging, dir);
  } catch {
    if (movedAside) await move(aside, dir).catch(() => {});
    await rm(staging, { recursive: true, force: true });
    throw new VoiceProviderError("download_failed", `${model.displayName}: the new version could not be moved into place; the previous one was kept`);
  }
  if (movedAside) await rm(aside, { recursive: true, force: true });
  await rm(partDir, { recursive: true, force: true });
  return dir;
}

async function hashFile(path: string, h: ReturnType<typeof createHash>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve());
    s.on("error", reject);
  });
}

async function fetchItem(model: CatalogModel, item: DownloadItem, index: number, part: string, fetchFn: FetchLike, o: DownloadOptions, cap: number): Promise<void> {
  const expected = item.sha256!.toLowerCase();
  let have = 0;
  try { have = (await stat(part)).size; } catch { have = 0; }
  if (item.sizeBytes !== null && have > item.sizeBytes) { await rm(part, { force: true }); have = 0; }
  let hash = createHash("sha256");
  if (have > 0) await hashFile(part, hash);
  let total: number | null = item.sizeBytes;
  const progress = (received: number) => o.onProgress?.({ modelId: model.id, item: index, items: model.download.length, receivedBytes: received, totalBytes: total });

  const alreadyComplete = item.sizeBytes !== null && have === item.sizeBytes;
  if (!alreadyComplete) {
    if (o.signal?.aborted) throw abortedError("local");
    let res: Response;
    try {
      res = await fetchFn(item.url!, { headers: have > 0 ? { range: `bytes=${have}-` } : {}, ...(o.signal ? { signal: o.signal } : {}) });
    } catch {
      if (o.signal?.aborted) throw abortedError("local");
      throw new VoiceProviderError("download_failed", `download of ${model.displayName} failed (network)`);
    }
    if (res.status === 200) {
      // Fresh start, or the server ignored Range: begin again from byte 0.
      have = 0;
      hash = createHash("sha256");
      await rm(part, { force: true });
    } else if (res.status !== 206 && res.status !== 416) {
      throw new VoiceProviderError("download_failed", `download of ${model.displayName} failed (HTTP ${res.status})`, { status: res.status });
    }
    if (res.url) { try { assertSecureTransport(res.url, "local"); } catch { throw new VoiceProviderError("download_failed", `download of ${model.displayName} was redirected to an insecure URL`); } }
    if (res.status !== 416) {
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > 0 && have + len > cap) { await res.body?.cancel().catch(() => {}); throw new VoiceProviderError("download_failed", `download of ${model.displayName} exceeds size limit`); }
      if (total === null && Number.isFinite(len) && len > 0) total = len + have;
      if (!res.body) throw new VoiceProviderError("download_failed", `download of ${model.displayName} failed (no body)`);
      const out = createWriteStream(part, { flags: have > 0 ? "a" : "w" });
      const reader = res.body.getReader();
      let received = have;
      try {
        for (;;) {
          if (o.signal?.aborted) throw abortedError("local");
          const { value, done } = await reader.read();
          if (done) break;
          hash.update(value);
          if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
          received += value.byteLength;
          if (received > cap) throw new VoiceProviderError("download_failed", `download of ${model.displayName} exceeds size limit`);
          progress(received);
        }
      } catch (e) {
        await new Promise<void>((r) => out.end(() => r()));
        await reader.cancel().catch(() => {});
        if (e instanceof VoiceProviderError && e.code === "download_failed") await rm(part, { force: true });
        if (e instanceof VoiceProviderError) throw e;
        throw new VoiceProviderError("download_failed", `download of ${model.displayName} was interrupted; the partial file is kept so the next try resumes`);
      }
      await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())));
      if (total !== null && received < total) throw new VoiceProviderError("download_failed", `download of ${model.displayName} ended early; the partial file is kept so the next try resumes`);
    }
  } else progress(have);
  if (hash.digest("hex") !== expected) {
    await rm(part, { force: true });
    throw new VoiceProviderError("checksum_mismatch", `${model.displayName}: downloaded file does not match the catalog sha256; it was discarded`);
  }
}
