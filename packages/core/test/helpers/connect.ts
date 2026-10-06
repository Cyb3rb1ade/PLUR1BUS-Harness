// `connect` for tests. On Windows the client refuses a pipe unless it is told which pid must serve it (audit M1, ruling
// S11), and the server's hello must name that pid. Most core tests run the core in this very process, so by default the
// expected pid is ours; a test that spawns a core passes the child's (`expectedServerPid`, or `connectRun` below).
// POSIX ignores the option, so nothing changes there.
import { readFileSync } from "node:fs";
import { connect as rawConnect, readRecordedPid, type ConnectOptions, type CoreClient } from "@plur1bus/module-api";
import type { Layout } from "../../src/paths.ts";

export function connect(opts: ConnectOptions): Promise<CoreClient> {
  return rawConnect(process.platform === "win32" && opts.expectedServerPid === undefined ? { ...opts, expectedServerPid: process.pid } : opts);
}

/** Connects to a core that runs as its own process: the pid is the one it recorded in `run/core.pid`. */
export async function connectRun(l: Layout, address: string, opts: Partial<ConnectOptions> = {}): Promise<CoreClient> {
  const pid = readRecordedPid(l.corePid);
  return rawConnect({ address, token: readFileSync(l.coreToken, "utf8"), ...(pid === undefined ? {} : { expectedServerPid: pid }), ...opts });
}
