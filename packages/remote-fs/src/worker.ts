/** Bounded private worker transport. Only the separate key frame contains credentials; diagnostics are discarded. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { FsBudget } from "./budget.ts";
import { RemoteFsError } from "./types.ts";

const FRAME_BYTES = 1024 * 1024;
const KEY_BYTES = 64 * 1024;

/** Produced by the trusted host installer/launcher; arguments are fixed by the selected implementation. */
export interface VerifiedWorker {
  path: string;
  sha256: string;
  mode: "harness" | "standalone";
}

/** The host's egress service must authorize and pin this numeric destination before calling the transport. */
export interface VettedEndpoint {
  ip: string;
  port: number;
}

/** Lease values stay in private pipes and are cleared/revoked after transfer or cancellation. */
export interface PrivateKeyLease {
  key: Buffer;
  release(): void | Promise<void>;
}

export interface WorkerOptions {
  worker: VerifiedWorker;
  endpoint: VettedEndpoint;
  budget: FsBudget;
  signal?: AbortSignal;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RemoteFsError("remote-protocol");
  return value as Record<string, unknown>;
}

function failure(reply: Record<string, unknown>): never {
  const known: readonly RemoteFsError["reason"][] = ["timeout", "host-key-mismatch", "authentication-failed",
    "limit-exceeded", "path-denied", "not-found", "permission-denied", "unsupported-type", "remote-protocol"];
  throw new RemoteFsError(known.includes(reply.reason as RemoteFsError["reason"])
    ? reply.reason as RemoteFsError["reason"] : "unavailable");
}

async function verifyWorker(worker: VerifiedWorker): Promise<string> {
  if (!isAbsolute(worker.path) || !/^[a-f0-9]{64}$/.test(worker.sha256)
    || !["harness", "standalone"].includes(worker.mode)) throw new RemoteFsError("worker-untrusted");
  const before = await lstat(worker.path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024 * 1024
    || (process.platform !== "win32" && ((before.mode & 0o022) !== 0
      || before.uid !== 0 && before.uid !== process.getuid?.()))) {
    throw new RemoteFsError("worker-untrusted");
  }
  const path = await realpath(worker.path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path);
  if (hash.digest("hex") !== worker.sha256 || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new RemoteFsError("worker-untrusted");
  return path;
}

class Frames {
  private readonly iterator: AsyncIterator<Buffer>;
  private readonly ended: () => RemoteFsError;
  private buffered = Buffer.alloc(0);

  constructor(stream: Readable, ended: () => RemoteFsError) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.ended = ended;
  }

  async read(maximum = FRAME_BYTES): Promise<Buffer> {
    for (;;) {
      if (this.buffered.length >= 4) {
        const length = this.buffered.readUInt32BE();
        if (length > maximum) throw new RemoteFsError("remote-protocol");
        if (this.buffered.length >= length + 4) {
          const frame = Buffer.from(this.buffered.subarray(4, length + 4));
          this.buffered = this.buffered.subarray(length + 4);
          return frame;
        }
      }
      const chunk = await this.iterator.next();
      if (chunk.done) throw this.ended();
      if (!Buffer.isBuffer(chunk.value) || this.buffered.length + chunk.value.length > 2 * FRAME_BYTES + 8) {
        throw new RemoteFsError("remote-protocol");
      }
      this.buffered = Buffer.concat([this.buffered, chunk.value]);
    }
  }

  async json(): Promise<Record<string, unknown>> {
    try {
      return object(JSON.parse((await this.read()).toString("utf8")));
    } catch (error) {
      if (error instanceof RemoteFsError) throw error;
      throw new RemoteFsError("remote-protocol");
    }
  }
}

/** Internal transport; the public filesystem exposes none of its process or protocol controls. */
export class WorkerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly frames: Frames;
  private readonly budget: FsBudget;
  private readonly stop = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly processClosed: Promise<void>;
  private detach: (() => void) | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private closed = false;
  private ended: RemoteFsError["reason"] = "unavailable";

  private constructor(child: ChildProcessWithoutNullStreams, options: WorkerOptions) {
    this.child = child;
    this.frames = new Frames(child.stdout, () => this.lost());
    this.budget = options.budget;
    child.stderr.resume();
    child.on("error", () => this.destroy());
    child.stdin.on("error", () => {});
    this.processClosed = new Promise(resolve => child.once("close", () => { this.destroy(); resolve(); }));
    this.timer = setTimeout(() => this.destroy("timeout"), Math.max(1, options.budget.deadline - Date.now()));
    this.timer.unref();
    const abort = () => this.destroy("aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    this.detach = () => options.signal?.removeEventListener("abort", abort);
    if (options.signal?.aborted) this.destroy("aborted");
  }

  static async open(options: WorkerOptions): Promise<WorkerConnection> {
    if (!isIP(options.endpoint.ip) || !Number.isInteger(options.endpoint.port)
      || options.endpoint.port < 1 || options.endpoint.port > 65535
      || options.budget.limits.timeoutMs > 300_000) throw new RemoteFsError("invalid-limit");
    const path = await options.budget.operation(() => verifyWorker(options.worker));
    options.budget.check();
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(path, options.worker.mode === "harness" ? ["__remote-fs-worker"] : [], {
      stdio: "pipe", env, windowsHide: true,
    });
    return new WorkerConnection(child, options);
  }

  /**
   * Why the worker is gone. This connection's deadline timer can fire, and the native worker can end at the same
   * absolute deadline, a moment before the operation's own deadline timer; the lost pipe then reports the deadline.
   */
  private lost(): RemoteFsError {
    if (this.ended === "unavailable") {
      try { this.budget.check(); } catch (error) { return error as RemoteFsError; }
    }
    return new RemoteFsError(this.ended);
  }

  private async frame(body: Buffer, sensitive = false): Promise<void> {
    if (this.closed) throw this.lost();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    const bytes = Buffer.concat([header, body]);
    try {
      await new Promise<void>((resolve, reject) => this.child.stdin.write(bytes, error => {
        if (error) reject(this.lost());
        else resolve();
      }));
    } finally {
      if (sensitive) bytes.fill(0);
    }
  }

  private async identity(phase?: string): Promise<Record<string, unknown>> {
    const reply = await this.frames.json();
    if (reply.ok !== true) failure(reply);
    if (reply.v !== 1 || typeof reply.hostKeySha256 !== "string"
      || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(reply.hostKeySha256)
      || (phase !== undefined && reply.phase !== phase)) throw new RemoteFsError("remote-protocol");
    return reply;
  }

  async connect(header: Record<string, unknown>, leaseKey?: (signal: AbortSignal) => Promise<PrivateKeyLease>): Promise<Record<string, unknown>> {
    try {
      return await this.budget.operation(async () => {
        await this.frame(Buffer.from(JSON.stringify(header)));
        if (!leaseKey) return this.identity();
        // The same native SSH connection confirms the expected host before requesting any credential.
        const host = await this.identity("host-key-verified");
        if (host.hostKeySha256 !== header.hostKeySha256) throw new RemoteFsError("host-key-mismatch");
        const lease = await leaseKey(this.stop.signal);
        try {
          this.budget.check();
          if (this.closed) throw new RemoteFsError("aborted");
          if (!Buffer.isBuffer(lease.key) || lease.key.length === 0 || lease.key.length > KEY_BYTES) {
            throw new RemoteFsError("invalid-limit");
          }
          await this.frame(lease.key, true);
        } finally {
          // This continuation owns cleanup even when the outer budget race has already returned.
          if (Buffer.isBuffer(lease.key)) lease.key.fill(0);
          try { void Promise.resolve(lease.release()).catch(() => {}); } catch { /* Fixed errors never include provider details. */ }
        }
        const ready = await this.identity();
        if (ready.hostKeySha256 !== host.hostKeySha256) throw new RemoteFsError("host-key-mismatch");
        return ready;
      });
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  request(op: string, fields: Record<string, unknown> = {}, readMaximum?: number): Promise<Record<string, unknown>> {
    const action = () => this.budget.operation(async () => {
      if (this.closed) throw this.lost();
      const id = this.nextId++;
      await this.frame(Buffer.from(JSON.stringify({ id, op, ...fields })));
      const reply = await this.frames.json();
      if (reply.id !== id || reply.v !== 1) throw new RemoteFsError("remote-protocol");
      if (reply.ok !== true) failure(reply);
      if (readMaximum !== undefined) {
        if (!Number.isSafeInteger(reply.bytes) || (reply.bytes as number) < 0 || (reply.bytes as number) > readMaximum) {
          throw new RemoteFsError("remote-protocol");
        }
        const data = await this.frames.read(readMaximum);
        if (data.length !== reply.bytes) throw new RemoteFsError("remote-protocol");
        return { data };
      }
      return reply;
    });
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result.catch(error => {
      if (error instanceof RemoteFsError && ["timeout", "aborted", "remote-protocol", "unavailable"].includes(error.reason)) this.destroy();
      throw error;
    });
  }

  destroy(reason: "unavailable" | "timeout" | "aborted" = "unavailable"): void {
    if (this.closed) return;
    this.closed = true;
    this.ended = reason;
    clearTimeout(this.timer);
    this.detach?.();
    this.stop.abort();
    this.child.stdin.destroy();
    this.child.kill("SIGKILL");
  }

  async close(): Promise<void> {
    this.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.processClosed, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
