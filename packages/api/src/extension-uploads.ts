/** Private staging shared with the supervisor. Browser filenames never select a filesystem path. */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createSecurePath } from "@plur1bus/module-api";
import { ApiError, errors } from "./errors.ts";

export const EXTENSION_UPLOAD_TTL = 600_000;
export const DEFAULT_EXTENSION_PACKAGE_BYTES = 256 * 1024 * 1024;
export interface ExtensionUpload {
  uploadId: string;
  expiresAt: number;
  sha256: string;
}
const HEADER_LIMIT = 8192;
const invalid = () => errors.badRequest("multipart", "one multipart file field is required");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

function boundaryOf(contentType: string): string {
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))\s*$/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 70 || !/^[a-zA-Z0-9'()+_,.\/:=?-]+$/.test(boundary)) throw invalid();
  return boundary;
}

/** Retains only one incoming chunk plus the short boundary tail; writes await disk backpressure. */
async function multipartFile(
  source: AsyncIterable<Uint8Array>,
  contentType: string,
  write: (bytes: Buffer) => Promise<void>,
): Promise<void> {
  const boundary = boundaryOf(contentType);
  const first = Buffer.from(`--${boundary}\r\n`),
    delimiter = Buffer.from(`\r\n--${boundary}`);
  let pending = Buffer.alloc(0),
    state: "headers" | "file" | "closed" = "headers";
  for await (const chunk of source) {
    pending = Buffer.concat([pending, chunk]);
    if (state === "headers") {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) {
        if (pending.length > HEADER_LIMIT) throw invalid();
        continue;
      }
      if (end > HEADER_LIMIT || !pending.subarray(0, first.length).equals(first)) throw invalid();
      const lines = pending.subarray(first.length, end).toString("latin1").split("\r\n");
      const names = new Set<string>();
      let file = false;
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon < 1 || /[\u0000-\u001f\u007f]/.test(line)) throw invalid();
        const name = line.slice(0, colon).toLowerCase(),
          value = line.slice(colon + 1).trim();
        if (names.has(name)) throw invalid();
        names.add(name);
        if (name === "content-disposition")
          file = /^form-data\s*;\s*name="file"\s*;\s*filename="[^"\r\n]*"$/i.test(value);
        else if (name !== "content-type") throw invalid();
      }
      if (!file) throw invalid();
      pending = pending.subarray(end + 4);
      state = "file";
    }
    while (state === "file") {
      const at = pending.indexOf(delimiter);
      if (at < 0) {
        const count = Math.max(0, pending.length - delimiter.length - 4);
        if (count) {
          await write(pending.subarray(0, count));
          pending = pending.subarray(count);
        }
        break;
      }
      if (pending.length < at + delimiter.length + 2) break;
      const suffix = pending.subarray(at + delimiter.length, at + delimiter.length + 2).toString("ascii");
      if (suffix !== "--" && suffix !== "\r\n") {
        await write(pending.subarray(0, at + 2));
        pending = pending.subarray(at + 2);
        continue;
      }
      if (suffix !== "--") throw invalid(); // exactly one file, no additional fields or files
      const end = at + delimiter.length + 2;
      if (pending.length < end + 2) break; // a close must end at EOF or continue with CRLF
      if (!pending.subarray(end, end + 2).equals(Buffer.from("\r\n"))) {
        await write(pending.subarray(0, at + 2));
        pending = pending.subarray(at + 2);
        continue;
      }
      await write(pending.subarray(0, at));
      pending = pending.subarray(at + delimiter.length + 2);
      state = "closed";
    }
    if (state === "closed" && (pending.length > 2 || !Buffer.from("\r\n").subarray(0, pending.length).equals(pending)))
      throw invalid();
  }
  if (
    state === "file" &&
    pending.subarray(-delimiter.length - 2).equals(Buffer.concat([delimiter, Buffer.from("--")]))
  ) {
    await write(pending.subarray(0, pending.length - delimiter.length - 2));
    pending = Buffer.alloc(0);
    state = "closed";
  }
  if (state !== "closed" || (pending.length !== 0 && !pending.equals(Buffer.from("\r\n")))) throw invalid();
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    (typeof process.geteuid === "function" && st.uid !== process.geteuid())
  )
    throw new ApiError(503, "E_NOT_AVAILABLE", "upload storage unavailable");
  await chmod(path, 0o700);
  if (!createSecurePath()(path, { mode: 0o700 }).applied)
    throw new ApiError(503, "E_NOT_AVAILABLE", "private upload storage unavailable");
}
async function writeAll(file: FileHandle, data: Buffer): Promise<void> {
  for (let offset = 0; offset < data.length;) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset);
    if (!bytesWritten) throw new Error("upload write failed");
    offset += bytesWritten;
  }
}

/** Reads only the trusted installation config; no request value influences this path. Invalid limits fail closed. */
export async function extensionPackageLimit(home: string): Promise<number> {
  let raw: string;
  try {
    const file = await open(join(home, "config.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if ((await file.stat()).size > 4 * 1024 * 1024) throw invalid();
      raw = await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (missing(error)) return DEFAULT_EXTENSION_PACKAGE_BYTES;
    throw new ApiError(503, "E_NOT_AVAILABLE", "upload configuration unavailable");
  }
  try {
    const config = JSON.parse(raw) as { extensions?: { limits?: { packageBytes?: unknown } } };
    const value = config.extensions?.limits?.packageBytes ?? DEFAULT_EXTENSION_PACKAGE_BYTES;
    if (!Number.isSafeInteger(value) || (value as number) < 1048576 || (value as number) > 1073741824) throw invalid();
    return value as number;
  } catch {
    throw new ApiError(503, "E_NOT_AVAILABLE", "upload configuration unavailable");
  }
}

interface PrivateUploadOptions {
  home: string;
  now?: () => number;
  maxBytes?: () => number | Promise<number>;
}
class PrivateUploads {
  readonly #dir: string;
  readonly #now: () => number;
  readonly #maxBytes: () => number | Promise<number>;
  readonly #ready: Promise<void>;
  readonly #sweep: NodeJS.Timeout;
  readonly #timers = new Set<NodeJS.Timeout>();
  #active = 0;
  constructor(options: PrivateUploadOptions & { namespace: "extensions" | "imports" }) {
    this.#dir = join(options.home, "run", options.namespace === "imports" ? "import-snapshots" : "uploads");
    this.#now = options.now ?? Date.now;
    this.#maxBytes =
      options.maxBytes ??
      (options.namespace === "imports" ? () => 1073741824 : () => extensionPackageLimit(options.home));
    this.#ready = privateDirectory(this.#dir);
    void this.#ready.catch(() => {});
    this.#sweep = setInterval(() => {
      void this.cleanup().catch(() => {});
    }, 30_000);
    this.#sweep.unref();
    void this.cleanup().catch(() => {});
  }
  close(): void {
    clearInterval(this.#sweep);
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
  async receive(source: AsyncIterable<Uint8Array>, contentType: string, userId: string): Promise<ExtensionUpload> {
    boundaryOf(contentType);
    await this.#ready;
    if (!userId || userId.length > 512) throw errors.forbidden("upload-person");
    if (this.#active >= 4) throw errors.rateLimited(10);
    this.#active++;
    const id = randomBytes(32).toString("base64url"),
      path = join(this.#dir, id),
      partial = join(this.#dir, `.part-${id}`),
      metadata = path + ".json",
      tempMetadata = join(this.#dir, `.meta-${id}`);
    let file: FileHandle | undefined,
      published = false;
    try {
      const maxBytes = await this.#maxBytes();
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new ApiError(503, "E_NOT_AVAILABLE", "upload limit unavailable");
      file = await open(partial, "wx", 0o600);
      if (!createSecurePath()(partial, { mode: 0o600 }).applied)
        throw new ApiError(503, "E_NOT_AVAILABLE", "private upload storage unavailable");
      const hash = createHash("sha256");
      let size = 0;
      await multipartFile(source, contentType, async (bytes) => {
        size += bytes.length;
        if (size > maxBytes) throw errors.tooLarge(maxBytes);
        hash.update(bytes);
        await writeAll(file!, bytes);
      });
      await file.sync();
      await file.close();
      file = undefined;
      const sha256 = hash.digest("hex"),
        expiresAt = this.#now() + EXTENSION_UPLOAD_TTL;
      await rename(partial, path);
      const meta = await open(tempMetadata, "wx", 0o600);
      try {
        if (!createSecurePath()(tempMetadata, { mode: 0o600 }).applied)
          throw new ApiError(503, "E_NOT_AVAILABLE", "private upload storage unavailable");
        await meta.writeFile(JSON.stringify({ version: 1, userId, expiresAt, sha256, size }) + "\n");
        await meta.sync();
      } finally {
        await meta.close();
      }
      await rename(tempMetadata, metadata);
      published = true;
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        void this.cleanup().catch(() => {});
      }, EXTENSION_UPLOAD_TTL);
      timer.unref();
      this.#timers.add(timer);
      return { uploadId: id, expiresAt, sha256 };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "E_NOT_AVAILABLE", "upload storage unavailable");
    } finally {
      this.#active--;
      await file?.close().catch(() => {});
      await rm(partial, { force: true }).catch(() => {});
      await rm(tempMetadata, { force: true }).catch(() => {});
      if (!published) {
        await rm(path, { force: true }).catch(() => {});
        await rm(metadata, { force: true }).catch(() => {});
      }
    }
  }
  async cleanup(): Promise<void> {
    await this.#ready;
    const entries = await readdir(this.#dir);
    const claimPattern = /^\.([A-Za-z0-9_-]{43})\.(?:claim|expired)-[a-f0-9]{32}\.json$/;
    const claimed = new Set(entries.flatMap((entry) => claimPattern.exec(entry)?.[1] ?? []));
    for (const entry of entries) {
      const live = /^([A-Za-z0-9_-]{43})\.json$/.exec(entry),
        priorClaim = claimPattern.exec(entry);
      const orphan = /^(?:\.part-|\.meta-)?([A-Za-z0-9_-]{43})$/.exec(entry);
      if (!live && !priorClaim && !orphan) continue;
      const id = (live ?? priorClaim ?? orphan)![1]!,
        path = join(this.#dir, entry);
      try {
        const st = await lstat(path);
        if (!st.isFile()) continue;
        if (orphan) {
          if (entries.includes(id + ".json") || claimed.has(id) || st.mtimeMs + 2 * EXTENSION_UPLOAD_TTL > this.#now())
            continue;
          await rm(path, { force: true });
          continue;
        }
        let expiry = st.mtimeMs + 2 * EXTENSION_UPLOAD_TTL;
        if (st.size <= 4096) {
          try {
            const metadata = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; expiresAt?: unknown };
            if (
              metadata.version === 1 &&
              Number.isSafeInteger(metadata.expiresAt) &&
              (metadata.expiresAt as number) >= 0
            )
              expiry = (metadata.expiresAt as number) + (priorClaim ? EXTENSION_UPLOAD_TTL : 0);
          } catch {
            /* corrupt private staging is collected by its bounded age, never interpreted as a path */
          }
        }
        if (expiry > this.#now()) continue;
        const claim = join(this.#dir, `.${id}.expired-${randomBytes(16).toString("hex")}.json`);
        await rename(path, claim); // competes atomically with the supervisor's one-use claim
        try {
          await rm(join(this.#dir, id), { force: true });
        } finally {
          await rm(claim, { force: true });
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
}
/** Extension IDs are resolved only by ext.inspect within run/uploads. */
export class ExtensionUploads extends PrivateUploads {
  constructor(options: PrivateUploadOptions) {
    super({ ...options, namespace: "extensions" });
  }
}
/** Import capabilities occupy a different directory and use the separately approved fixed 1 GiB compressed cap. */
export class ImportSnapshotUploads extends PrivateUploads {
  constructor(options: Pick<PrivateUploadOptions, "home" | "now">) {
    super({ ...options, namespace: "imports" });
  }
}
