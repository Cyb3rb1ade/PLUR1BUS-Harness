/** Six read-only SFTP operations over the authenticated bounded Rust worker, confined to a selected source root. */
import { posix } from "node:path";
import { FsBudget } from "./budget.ts";
import { RemoteFsError, type FsLimits, type FsStat, type ReadonlyFs } from "./types.ts";
import { WorkerConnection, type PrivateKeyLease, type VerifiedWorker, type VettedEndpoint } from "./worker.ts";

export interface ProbeOptions {
  worker: VerifiedWorker;
  endpoint: VettedEndpoint;
  limits?: Partial<FsLimits>;
  signal?: AbortSignal;
}

export interface SftpOptions extends ProbeOptions {
  endpoint: VettedEndpoint & { username: string; hostKeySha256: string };
  root: string;
  leaseKey(signal: AbortSignal): Promise<PrivateKeyLease>;
}

export interface SftpSession {
  fs: ReadonlyFs;
  close(): Promise<void>;
}

function header(options: ProbeOptions, budget: FsBudget): Record<string, unknown> {
  const limits = budget.limits;
  if (limits.maxFileBytes > 1024 ** 3 || limits.maxTotalBytes > 8 * 1024 ** 3 || limits.maxEntries > 100_000
    || limits.maxDepth > 96) throw new RemoteFsError("invalid-limit");
  return { v: 1, mode: "probeHostKey", ip: options.endpoint.ip, port: options.endpoint.port, deadlineMs: budget.deadline,
    limits: { fileBytes: limits.maxFileBytes, readBytes: limits.maxTotalBytes, entries: limits.maxEntries,
      depth: 128, packetBytes: 256 * 1024, metadataBytes: 1024 * 1024, requests: 100_000 } };
}

/** Unauthenticated handshake only. The host must authorize the endpoint; no private-key port is accepted. */
export async function probeSftpHostKey(options: ProbeOptions): Promise<{ hostKeySha256: string; hostKeyAlgorithm?: string }> {
  const budget = new FsBudget(options.limits, options.signal);
  const checkedHeader = header(options, budget);
  const connection = await WorkerConnection.open({ ...options, budget });
  try {
    const reply = await connection.connect(checkedHeader);
    return { hostKeySha256: reply.hostKeySha256 as string,
      ...(typeof reply.hostKeyAlgorithm === "string" ? { hostKeyAlgorithm: reply.hostKeyAlgorithm } : {}) };
  } finally {
    await connection.close();
  }
}

function statView(reply: Record<string, unknown>): FsStat {
  const item = reply.metadata as Record<string, unknown> | undefined;
  if (!item || !["file", "directory", "symlink", "other"].includes(item.kind as string)
    || (item.mode !== undefined && (!Number.isInteger(item.mode) || (item.mode as number) < 0 || (item.mode as number) > 0o777))
    || !Number.isSafeInteger(item.size) || (item.size as number) < 0
    || (item.mtimeMs !== undefined && (typeof item.mtimeMs !== "number" || !Number.isFinite(item.mtimeMs)))) {
    throw new RemoteFsError("remote-protocol");
  }
  return Object.freeze({ type: item.kind as FsStat["type"], size: item.size as number,
    ...(typeof item.mode === "number" ? { mode: item.mode } : {}),
    ...(typeof item.mtimeMs === "number" ? { mtimeMs: item.mtimeMs } : {}) });
}

/** Authenticates only after exact host-key comparison; closing the session aborts all pending operations. */
export async function createSftpFs(options: SftpOptions): Promise<SftpSession> {
  const budget = new FsBudget(options.limits, options.signal);
  if (!options.root.startsWith("/") || options.root.includes("\0") || options.root.includes("\\")
    || !options.endpoint.username || options.endpoint.username.length > 256 || /[\x00-\x1f\x7f]/.test(options.endpoint.username)
    || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(options.endpoint.hostKeySha256)) throw new RemoteFsError("path-denied");
  const checkedHeader = header(options, budget);
  const connection = await WorkerConnection.open({ ...options, budget });
  try {
    await connection.connect({ ...checkedHeader, mode: "connect", username: options.endpoint.username,
      hostKeySha256: options.endpoint.hostKeySha256 }, options.leaseKey);
    const rootReply = await connection.request("realpath", { path: posix.normalize(options.root) });
    if (typeof rootReply.path !== "string" || !rootReply.path.startsWith("/")) throw new RemoteFsError("remote-protocol");
    const root = posix.normalize(rootReply.path);
    const within = (path: string): string => {
      const rel = posix.relative(root, path);
      if (rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) throw new RemoteFsError("path-denied");
      budget.depth(rel ? rel.split("/").length : 0);
      return path;
    };
    const lexical = (path: string): string => {
      budget.check();
      if (typeof path !== "string" || path.length > 8192 || path.includes("\0") || path.includes("\\")) {
        throw new RemoteFsError("path-denied");
      }
      return within(posix.resolve(root, path));
    };
    const target = async (path: string): Promise<string> => {
      const reply = await connection.request("realpath", { path: lexical(path) });
      if (typeof reply.path !== "string" || !reply.path.startsWith("/")) throw new RemoteFsError("remote-protocol");
      return within(posix.normalize(reply.path));
    };
    const entry = async (path: string): Promise<string> => {
      const full = lexical(path);
      return full === root ? root : posix.join(await target(posix.dirname(full)), posix.basename(full));
    };
    const fs: ReadonlyFs = Object.freeze({
      stat: (path: string) => budget.operation(async () => statView(await connection.request("stat", { path: await target(path) }))),
      lstat: (path: string) => budget.operation(async () => {
        return statView(await connection.request("lstat", { path: await entry(path) }));
      }),
      realpath: (path: string) => budget.operation(() => target(path)),
      readlink: (path: string) => budget.operation(async () => {
        const full = await entry(path);
        const reply = await connection.request("readlink", { path: full });
        if (typeof reply.path !== "string") throw new RemoteFsError("remote-protocol");
        await target(posix.resolve(posix.dirname(full), reply.path));
        return reply.path;
      }),
      readdir: (path: string) => budget.operation(async () => {
        const reply = await connection.request("readdir", { path: await target(path) });
        if (!Array.isArray(reply.entries)) throw new RemoteFsError("remote-protocol");
        const entries: string[] = [];
        for (const entry of reply.entries) {
          budget.addEntry();
          if (typeof entry !== "string" || !entry || entry === "." || entry === ".." || /[\x00/\\]/.test(entry)
            || Buffer.byteLength(entry) > 1024) throw new RemoteFsError("remote-protocol");
          entries.push(entry);
        }
        return Object.freeze(entries.sort());
      }),
      readFile: (path: string, maxBytes: number) => budget.operation(async () => {
        const cap = budget.fileLimit(maxBytes);
        const full = await target(path);
        const initial = statView(await connection.request("stat", { path: full }));
        if (initial.type !== "file") throw new RemoteFsError("unsupported-type");
        if (initial.size > cap) throw new RemoteFsError("file-limit");
        if (initial.size > budget.remainingBytes()) throw new RemoteFsError("total-limit");
        const chunks: Buffer[] = [];
        let size = 0;
        while (size < cap && budget.remainingBytes() > 0) {
          const length = Math.min(65_536, cap - size, budget.remainingBytes());
          const reply = await connection.request("read", { path: full, offset: size, length }, length);
          const data = reply.data as Buffer;
          if (!data.length) break;
          budget.addBytes(data.length);
          chunks.push(data);
          size += data.length;
        }
        const final = statView(await connection.request("stat", { path: await target(path) }));
        if (final.size > cap) throw new RemoteFsError("file-limit");
        if (final.size > size && budget.remainingBytes() === 0) throw new RemoteFsError("total-limit");
        return Buffer.concat(chunks, size);
      }),
    });
    return Object.freeze({ fs, close: () => connection.close() });
  } catch (error) {
    await connection.close();
    throw error;
  }
}
