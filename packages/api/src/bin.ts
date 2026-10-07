#!/usr/bin/env node
// Standalone entry of the Harness API (`dist/api.js`): loopback only, a peer client of the core. Wiring it under the
// supervisor (a module manifest, `daemon start`) and the config keys for host/port are later slices.
import { join } from "node:path";
import { createLogger, createSecurePath, runDir } from "@plur1bus/module-api";
import { createBufferedSink } from "./audit-queue.ts";
import { createCoreLink } from "./core-link.ts";
import { ensureOwnerToken } from "./owner-token.ts";
import { createAuditChain } from "./rbac-bridge.ts";
import { createApiServer } from "./server.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const home = arg("--home");
  if (!home) { console.error("usage: plur1bus-api --home <path> [--host <loopback address>] [--port <n>] [--web-root <dir>]"); process.exit(2); }
  const portArg = arg("--port"); const port = portArg === undefined ? 0 : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error("--port must be an integer between 0 and 65535"); process.exit(2); }
  const logger = createLogger({ file: join(home, "logs", "api.log"), level: "info", role: "api" });
  const core = createCoreLink(home, { log: logger });
  // The core's hash-chained audit log (docs/audit-chain.md): the API is one more writer, serialised by the chain's OS lock.
  // A short lock timeout, and auth events go through a queue, so the core holding the lock never stalls a request.
  const secure = createSecurePath({ runDir: runDir(home) });
  const chain = createAuditChain({ dir: join(home, "logs"), lockTimeoutMs: 250, securePath: (p) => { const r = secure(p); if (!r.applied && process.platform === "win32") throw new Error(`could not restrict ${p} to this user (${r.reason})`); } });
  const audit = createBufferedSink(chain, { log: logger });
  const api = createApiServer({ core, ownerToken: ensureOwnerToken(home), logger, audit, breakGlassAudit: chain, port, ...(arg("--host") ? { host: arg("--host")! } : {}), ...(arg("--web-root") ? { webRoot: arg("--web-root")! } : {}) });
  const { url } = await api.listen();
  console.log(JSON.stringify({ ready: true, url, pid: process.pid }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await api.close(); await audit.flush(); await core.close(); await logger.close(); process.exit(0); };
  process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop());
}

main().catch((e) => { console.error(`plur1bus-api: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
