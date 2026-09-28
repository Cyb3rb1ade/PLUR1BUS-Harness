// Write-side file operations of the importer with retry on transient Windows locks (plugin-distribution spec §B.5, gap
// G8). Windows Defender, the Search indexer, backup agents or an open editor can hold a file the importer just wrote
// or is about to move; rename, copy and rm then fail with EPERM, EBUSY or EACCES for a moment. On Windows those codes
// are retried with growing waits for up to 10 s; on POSIX they are real errors and fail at once. Only ever used on the
// harness side (staging, the skill store, reports); the source is never written.
import { copyFileSync, cpSync, renameSync, rmSync, type CopySyncOptions, type RmOptions } from "node:fs";

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
export const RETRY_TOTAL_MS = 10_000;

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number) => { Atomics.wait(sleeper, 0, 0, ms); };

export interface RetryOptions { platform?: NodeJS.Platform; totalMs?: number; now?: () => number; sleep?: (ms: number) => void }

/** Runs `fn`, retrying transient Windows lock errors (waits 25 ms, doubling up to 1 s, `totalMs` in all). */
export function retrySync<T>(fn: () => T, o: RetryOptions = {}): T {
  const platform = o.platform ?? process.platform;
  const total = o.totalMs ?? RETRY_TOTAL_MS;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? sleepSync;
  const start = now();
  let wait = 25;
  for (;;) {
    try { return fn(); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (platform !== "win32" || !code || !TRANSIENT.has(code)) throw e;
      const left = total - (now() - start);
      if (left <= 0) throw e;
      sleep(Math.min(wait, left));
      wait = Math.min(wait * 2, 1000);
    }
  }
}

export const renameRetry = (from: string, to: string, o?: RetryOptions) => retrySync(() => renameSync(from, to), o);
export const copyFileRetry = (from: string, to: string, o?: RetryOptions) => retrySync(() => copyFileSync(from, to), o);
export const cpRetry = (from: string, to: string, opts: CopySyncOptions, o?: RetryOptions) => retrySync(() => cpSync(from, to, opts), o);
export const rmRetry = (path: string, opts: RmOptions, o?: RetryOptions) => retrySync(() => rmSync(path, opts), o);
