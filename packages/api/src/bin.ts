#!/usr/bin/env node
import { LoginChallenges } from "./challenge.ts";
import type { PendingWebAuthn } from "./webauthn-routes.ts";
import { ensureBootstrap } from "./bootstrap.ts";
// Harness API entry (`dist/api.js`), standalone or supervised through the stdin lifeline.
// The local listener is always loopback; configured remote TLS publishing stays a separate listener.
import { AccountStore, type CorePerson } from "./account-store.ts";
import { join } from "node:path";
import { createLogger, createSecurePath, runDir } from "@plur1bus/module-api";
import { createBufferedSink } from "./audit-queue.ts";
import { createCoreLink } from "./core-link.ts";
import { randomBytes } from "node:crypto";
import { acquireExclusiveLock } from "@plur1bus/module-api";
import { privateAtomicJson } from "./remote-certificates.ts";
import { createAuditChain } from "./rbac-bridge.ts";
import { createApiServer } from "./server.ts";
import { API_VERSION } from "./routes.ts";
import { SqliteTaskStore } from "./a2a/task-store.ts";
import { createCoreSecretStore } from "../../core/src/secrets/runtime.ts";
import { layout } from "../../core/src/paths.ts";

import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
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
  const supervised = arg("--lifeline") === "stdin";
  mkdirSync(join(home,"run"),{recursive:true,mode:0o700});
  const lock=acquireExclusiveLock(join(home,"run","api.lock"),{instanceId:arg("--instance")??"standalone"});
  if(!lock){console.error("plur1bus-api: another API owns this home");process.exit(3);}
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
  const cleanBootstrap = ensureBootstrap(home, accounts, process.env.PLUR1BUS_OWNER_INSTALLED === "1");
  if (!accounts.bootstrapState()?.consumed) logger.info("Owner bootstrap proof: [REDACTED]; read the private run/api-bootstrap.token file locally");
  const startup = loadRemoteStartup(home), sharedSessions = new SessionStore(systemClock), sharedLoginChallenges = new LoginChallenges(systemClock), sharedWebauthnChallenges = new Map<string, PendingWebAuthn>();
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
  const loadConfig = () => {
    try {
      const file = join(home, "config.json");
      if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // ignore
    }
    return {};
  };
  const wideRates = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS === "1" ? {
    auth: { capacity: 1000, refillPerSec: 100 },
    totp: { capacity: 1000, refillPerSec: 100 },
    read: { capacity: 1000, refillPerSec: 100 },
    write: { capacity: 1000, refillPerSec: 100 },
    rpc: { capacity: 1000, refillPerSec: 100 },
    stream: { capacity: 1000, refillPerSec: 100 },
    expensive: { capacity: 1000, refillPerSec: 100 },
    upload: { capacity: 1000, refillPerSec: 100 },
  } : undefined;
  const oauthStore = accounts.oauth;
  const a2aTaskStores = new Map<string, SqliteTaskStore>();
  const a2aDbPath = join(home, "state", "a2a-tasks.db");
  const taskStore = (agentId: string) => {
    let s = a2aTaskStores.get(agentId);
    if (!s) {
      s = new SqliteTaskStore({ path: a2aDbPath, agentId });
      a2aTaskStores.set(agentId, s);
    }
    return s;
  };
  const secretStore = createCoreSecretStore({ layout: layout(home), securePath: secure, fileFallback: () => false });
  const common = { core, home, bootstrapConsumed: cleanBootstrap, remotePairing, accounts, users: accounts, tokens: accounts.tokens, totp: accounts.totp, resolveBootstrap: () => resolve("local-owner"), ownerToken: randomBytes(32).toString("base64url"), logger, audit, breakGlassAudit: chain, sharedSessions, sharedLoginChallenges, sharedWebauthnChallenges, requireSecondFactor: startup.requireSecondFactor,
    mcpConfig: () => loadConfig(), a2aConfig: () => loadConfig(), taskStore, oauthStore, oauthClients: loadConfig()?.oauth?.clients, secretRedaction: secretStore.redaction,
    ...(wideRates ? { rateClasses: wideRates } : {}),
    remoteCertificates: { importCompany: async (certPem: string, keyPem: string) => { const current = certificates.hasCurrent(), staged = await certificates.stageCompany({ certChainPem: certPem, keyPem }); if (!current) certificates.activateStaged(); return { certPin: staged.certPin, staged: current }; } },
    ...(arg("--web-root") ? { webRoot: arg("--web-root")! } : existsSync(join(home,"runtime","web","index.html")) ? {webRoot:join(home,"runtime","web")} : {}) };
  const api = createApiServer({ ...common, port, ...(arg("--host") ? { host: arg("--host")! } : {}) }), apis = new Set([api]);
  accounts.onChange = id => { for (const endpoint of apis) endpoint.rightsChanged(id); };
  core.subscribePeople(id => { for (const endpoint of apis) endpoint.rightsChanged(id); void accounts.findById(id).catch(() => {}); });
  accounts.startPolling();
  const { url, port: localPort } = await api.listen();
  if(supervised) privateAtomicJson(join(home,"run","api-listen.json"),{address:"127.0.0.1",port:localPort,version:API_VERSION,fingerprint:null,pid:process.pid,instanceId:arg("--instance")});
  remote = await startRemoteRuntime({ home, ...startup, certificates, localPort, createApi: bind => { const endpoint = createApiServer({ ...common, ...bind }); apis.add(endpoint); return endpoint; }, report: status => { for (const check of status.doctor) logger.warn(check.message, { check: check.id }); } });
  console.log(JSON.stringify({ ready: true, url, pid: process.pid, remote: { publish: remote.state.publish, phase: remote.state.phase, ...(remote.state.doctor[0] ? { reason: remote.state.doctor[0].id } : {}) } }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; for (const s of a2aTaskStores.values()) { try { s.close(); } catch {} } await remote?.close().catch(() => logger.error("remote cleanup failed; private backend closed")); await api.close(); await audit.flush(); await core.close(); accounts.close(); await logger.close(); if(supervised) rmSync(join(home,"run","api-listen.json"),{force:true}); lock.release(); process.exit(0); };
  if(supervised) { process.stdin.on("end",()=>void stop()); process.stdin.on("error",()=>void stop()); process.stdin.resume(); }
  process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop());
}

main().catch((e) => { console.error(`plur1bus-api: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
