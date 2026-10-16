#!/usr/bin/env node
// Standalone entry of the Harness API (`dist/api.js`): loopback only, a peer client of the core. Wiring it under the
// supervisor (a module manifest, `daemon start`) and the config keys for host/port are later slices.
import { AccountStore, type CorePerson } from "./account-store.ts";
import { join } from "node:path";
import { createLogger, createSecurePath, runDir } from "@plur1bus/module-api";
import { createBufferedSink } from "./audit-queue.ts";
import { createCoreLink } from "./core-link.ts";
import { ensureOwnerToken } from "./owner-token.ts";
import { createAuditChain } from "./rbac-bridge.ts";
import { createApiServer } from "./server.ts";

import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { isIP } from "node:net";
import { SessionStore } from "./session.ts";
import { systemClock } from "./clock.ts";
import { loadRemoteStartup, startRemoteRuntime, type RemoteRuntime } from "./remote-runtime.ts";
import { RemoteCertificates } from "./remote-certificates.ts";

import { RemotePairingController } from "./remote-pairing-controller.ts";
import type { Pin } from "../../remote-access/src/fingerprint.ts";

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
  const resolve = async (userId: string) => (await core.serviceCall!<{ person: CorePerson | null }>("admin.api.person.resolve", { userId })).person;
  const accounts = new AccountStore({ path: join(home, "state", "api", "accounts.db"), resolve });
  const startup = loadRemoteStartup(home), sharedSessions = new SessionStore(systemClock);
  const name = startup.publicOrigin ? new URL(startup.publicOrigin).hostname.replace(/^\[|\]$/g, "") : hostname();
  const certificates = new RemoteCertificates({ home, names: isIP(name) ? { hostnames: [], ips: [name] } : { hostnames: [name] } });
  let remote: RemoteRuntime | undefined;
  mkdirSync(join(home, "state", "remote"), { mode: 0o700, recursive: true });
  const remotePairing = new RemotePairingController({ core, audit: chain, now: Date.now, trustFile: join(home, "state", "remote", "trust.json"),
    publish: () => startup.config.publish, tlsMode: () => startup.config.tls, origin: () => remote?.state.publicOrigin ?? startup.publicOrigin ?? "",
    current: () => { if (remote?.state.phase !== "active") return undefined; if (startup.config.publish === "tailnet") return remote.state.fingerprint ? { certPin: remote.state.fingerprint as Pin } : undefined; const current = certificates.current(); return current ? { certPin: current.certPin, ...(current.caPin ? { caPin: current.caPin } : {}) } : undefined; },
    transport: input => input.remoteTransport,
    stage: async () => { if (startup.config.publish !== "network") throw new Error("Tailscale owns its certificate; local TLS rollover is network-only"); const staged = certificates.staged(); if (!staged && startup.config.tls === "company-ca") throw new Error("Upload the next company certificate before staging rollover"); const next = staged ?? await certificates.stageSelfSigned(); return { certPin: next.certPin, ...(next.caPin ? { caPin: next.caPin } : {}) }; },
    activate: async () => { if (!remote) throw new Error("remote runtime unavailable"); await remote.activateStaged(); }, cancelStage: async () => { certificates.cancelStaged(); },
  });
  const common = { core, home, remotePairing, accounts, users: accounts, tokens: accounts.tokens, totp: accounts.totp, resolveBootstrap: () => resolve("local-owner"), ownerToken: ensureOwnerToken(home), logger, audit, breakGlassAudit: chain, sharedSessions, requireSecondFactor: startup.requireSecondFactor,
    remoteCertificates: { importCompany: async (certPem: string, keyPem: string) => { const current = certificates.hasCurrent(), staged = await certificates.stageCompany({ certChainPem: certPem, keyPem }); if (!current) certificates.activateStaged(); return { certPin: staged.certPin, staged: current }; } },
    ...(arg("--web-root") ? { webRoot: arg("--web-root")! } : {}) };
  const api = createApiServer({ ...common, port, ...(arg("--host") ? { host: arg("--host")! } : {}) }), apis = new Set([api]);
  accounts.onChange = id => { for (const endpoint of apis) endpoint.rightsChanged(id); };
  core.subscribePeople(id => { for (const endpoint of apis) endpoint.rightsChanged(id); void accounts.findById(id).catch(() => {}); });
  accounts.startPolling();
  const { url, port: localPort } = await api.listen();
  remote = await startRemoteRuntime({ home, ...startup, certificates, localPort, createApi: bind => { const endpoint = createApiServer({ ...common, ...bind }); apis.add(endpoint); return endpoint; }, report: status => { for (const check of status.doctor) logger.warn(check.message, { check: check.id }); } });
  console.log(JSON.stringify({ ready: true, url, pid: process.pid, remote: { publish: remote.state.publish, phase: remote.state.phase, ...(remote.state.doctor[0] ? { reason: remote.state.doctor[0].id } : {}) } }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await remote?.close().catch(() => logger.error("remote cleanup failed; private backend closed")); await api.close(); await audit.flush(); await core.close(); accounts.close(); await logger.close(); process.exit(0); };
  process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop());
}

main().catch((e) => { console.error(`plur1bus-api: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
