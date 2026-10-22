// Shared plumbing for tests that run a real RPC server in the test process and connect to it with the real client.
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Where an in-process test server listens: a unique named pipe on Windows (a socket file in a directory does not exist
 *  there), `rpc.sock` inside `dir` elsewhere. */
export function rpcAddress(dir: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\p1b-${randomUUID()}` : join(dir, "rpc.sock");
}

/** The test server lives in this process. On Windows `connect` refuses a pipe whose server pid it was not told (ruling
 *  S11, audit M1: any account can create a pipe of a free name), so a test names its own pid. Unused on POSIX. */
export const selfServer = { expectedServerPid: process.pid } as const;
