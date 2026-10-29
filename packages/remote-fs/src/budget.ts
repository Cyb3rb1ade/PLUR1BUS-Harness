/** One run's shared deadline and cumulative byte/entry counters; backend details never escape. */
import { DEFAULT_FS_LIMITS, RemoteFsError, type FsLimits } from "./types.ts";

export class FsBudget {
  readonly limits: Readonly<FsLimits>;
  readonly deadline: number;
  private readonly signal: AbortSignal | undefined;
  private bytes = 0;
  private entries = 0;

  constructor(limits: Partial<FsLimits> = {}, signal?: AbortSignal) {
    this.limits = Object.freeze({ ...DEFAULT_FS_LIMITS, ...limits });
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 0 || (key === "timeoutMs" && value === 0)) {
        throw new RemoteFsError("invalid-limit");
      }
    }
    this.deadline = Date.now() + this.limits.timeoutMs;
    this.signal = signal;
    this.check();
  }

  check(): void {
    if (this.signal?.aborted) throw new RemoteFsError("aborted");
    if (Date.now() >= this.deadline) throw new RemoteFsError("timeout");
  }

  fileLimit(maxBytes: number): number {
    this.check();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RemoteFsError("invalid-limit");
    return Math.min(maxBytes, this.limits.maxFileBytes);
  }

  depth(depth: number): void {
    this.check();
    if (depth > this.limits.maxDepth) throw new RemoteFsError("depth-limit");
  }

  addEntry(): void {
    this.check();
    if (++this.entries > this.limits.maxEntries) throw new RemoteFsError("entry-limit");
  }

  addBytes(bytes: number): void {
    this.check();
    if (bytes > this.limits.maxTotalBytes - this.bytes) throw new RemoteFsError("total-limit");
    this.bytes += bytes;
  }

  remainingBytes(): number {
    this.check();
    return this.limits.maxTotalBytes - this.bytes;
  }

  async operation<T>(run: () => Promise<T>): Promise<T> {
    this.check();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        run().then(value => { this.check(); return value; }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new RemoteFsError("timeout")), Math.max(1, this.deadline - Date.now()));
          onAbort = () => reject(new RemoteFsError("aborted"));
          this.signal?.addEventListener("abort", onAbort, { once: true });
          if (this.signal?.aborted) onAbort();
        }),
      ]);
    } catch (error) {
      if (error instanceof RemoteFsError) throw error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      throw new RemoteFsError(code === "ENOENT" ? "not-found" : "unavailable");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onAbort) this.signal?.removeEventListener("abort", onAbort);
    }
  }
}
