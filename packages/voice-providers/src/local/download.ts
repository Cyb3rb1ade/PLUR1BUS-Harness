// Model download: sha256-verified, resumable, with progress. Bytes land in `<modelsDir>/.downloads/<id>/` as `.part`
// files (kept on failure so the next try resumes with a Range request), are verified, then assembled in a staging
// directory and moved into place atomically. A model directory only exists when it is complete.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { VoiceProviderError, abortedError } from "../errors.ts";
import type { FetchLike } from "../http.ts";
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
  acceptNcLicence?: boolean;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  extract?: ExtractFn;
}

const exec = promisify(execFile);
/** Default extractor: the system `tar` (bsdtar on Windows 10+ and macOS, GNU tar on Linux), no shell involved. */
export const tarExtract: ExtractFn = async (archive, destDir, o) => {
  await mkdir(destDir, { recursive: true });
  await exec("tar", ["-xjf", archive, "-C", destDir, `--strip-components=${o.stripComponents}`]);
};

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

/** Download and install one model. Idempotent: an installed model returns immediately. */
export async function downloadModel(model: CatalogModel, o: DownloadOptions): Promise<string> {
  assertLicenceAccepted(model, o.acceptNcLicence === true);
  const dir = modelDir(o.modelsDir, model.id);
  if (await isInstalled(o.modelsDir, model)) return dir;
  const ok = downloadable(model);
  if (!ok.ok) throw new VoiceProviderError("catalog", `${model.displayName} cannot be downloaded: ${ok.reason}`);
  const fetchFn: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
  const staging = join(o.modelsDir, `.staging-${model.id}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const partDir = join(o.modelsDir, ".downloads", model.id);
  await mkdir(partDir, { recursive: true });
  for (let i = 0; i < model.download.length; i++) {
    const item = model.download[i]!;
    const part = join(partDir, `${i}.part`);
    await fetchItem(model, item, i, part, fetchFn, o);
    if (item.archive) await (o.extract ?? tarExtract)(part, staging, { format: item.archive, stripComponents: item.stripComponents ?? 0 });
    else {
      const target = join(staging, item.path!);
      await mkdir(dirname(target), { recursive: true });
      await rename(part, target).catch(async () => { await writeFile(target, await readFile(part)); });
    }
  }
  await writeFile(join(staging, ".complete.json"), JSON.stringify({ id: model.id, sha256: model.download.map((d) => d.sha256!.toLowerCase()) }));
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
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

async function fetchItem(model: CatalogModel, item: DownloadItem, index: number, part: string, fetchFn: FetchLike, o: DownloadOptions): Promise<void> {
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
    if (res.status !== 416) {
      const len = Number(res.headers.get("content-length"));
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
          progress(received);
        }
      } catch (e) {
        await new Promise<void>((r) => out.end(() => r()));
        await reader.cancel().catch(() => {});
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
