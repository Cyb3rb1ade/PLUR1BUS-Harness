/** Opens the real remote API edge after the existing library has validated the exposure plan. */
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { networkInterfaces } from "node:os";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { admitSocket, certPin, inspectCertificate, compileAllowlist, confirmSecurityNotice, parseRemoteConfig, detectServe, detectTailscale, firstAidChecks, noticeNeeded, planListeners, planServe, planServeOff, runServePlan, type ExecPort, type FirstAidEntry, type HostInterface, type NoticeAck, type RemoteConfig } from "../../remote-access/src/index.ts";
import { cidrContainsPublic, formatAddress, parseCidr } from "./net-bridge.ts";
import type { ApiServer } from "./server.ts";
import { RemoteCertificates, privateAtomicJson, readPrivateText, type RemoteTlsMaterial } from "./remote-certificates.ts";
export interface RemoteBind {
  host: string; port: number; tls?: { key: string; cert: string };
  remote: { publish: "network" | "tailnet"; publicOrigin: string; allowSubnets: readonly string[]; noticeAck?: NoticeAck & { version: number } };
}
/** The configured ranges that contain public addresses, each with the lowest one as an example (spec §4.5). Feeds the
 *  `remote.allowlist-public` Doctor row; it only informs, the list is enforced as configured. A line `parseCidr` cannot read
 *  is skipped here (`compileAllowlist` is what refuses an invalid list). */
export function allowlistPublic(subnets: readonly string[]): { cidr: string; example: string }[] {
  const out: { cidr: string; example: string }[] = [];
  for (const cidr of subnets) {
    const range = parseCidr(cidr.trim()); const witness = range && cidrContainsPublic(range);
    if (witness) out.push({ cidr: cidr.trim(), example: formatAddress(witness) });
  }
  return out;
}
export interface RemoteRuntimeState {
  publish: RemoteConfig["publish"]; phase: "inactive" | "active" | "failed"; publicOrigin?: string; fingerprint?: string;
  tailnetTarget?: string; doctor: readonly FirstAidEntry[];
}
export interface RemoteRuntime {
  readonly state: RemoteRuntimeState; readonly api?: ApiServer | undefined; readonly certificates?: RemoteCertificates | undefined;
  /** Network only; the trust controller must announce next before invoking this hook. */
  activateStaged(): Promise<void>; close(): Promise<void>;
}
export function loadRemoteStartup(home: string): { config: RemoteConfig; publicOrigin?: string; noticeAck?: NoticeAck & { version: number }; requireSecondFactor: "remote" | "always" | "never" } {
  let raw: Record<string, unknown> = {};
  try { const file = join(home, "config.json"); if (statSync(file).size > 1024 * 1024) throw new Error("config size"); raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("remote configuration could not be read safely"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid remote configuration");
  const remote = raw.remote; if (remote !== undefined && (!remote || typeof remote !== "object" || Array.isArray(remote))) throw new Error("invalid remote configuration");
  const { publicOrigin, noticeAck, ...exposure } = (remote ?? {}) as Record<string, unknown>;
  const parsed = parseRemoteConfig(exposure); if (!parsed.ok) throw new Error("invalid remote exposure configuration");
  if (publicOrigin !== undefined && typeof publicOrigin !== "string") throw new Error("invalid remote publicOrigin");
  let ack: NoticeAck & { version: number } | undefined;
  if (noticeAck !== undefined) { const confirmed = confirmSecurityNotice({ ...(noticeAck as object), confirmed: true }); if (!confirmed.ok) throw new Error("invalid persisted network notice confirmation"); ack = confirmed.ack; }
  const factor = (raw.auth as { requireSecondFactor?: unknown } | undefined)?.requireSecondFactor ?? "remote";
  if (!["remote", "always", "never"].includes(factor as string)) throw new Error("invalid second-factor policy");
  return { config: parsed.config, ...(publicOrigin ? { publicOrigin: publicOrigin as string } : {}), ...(ack ? { noticeAck: ack } : {}), requireSecondFactor: factor as "remote" | "always" | "never" };
}
export interface EdgeCertificate { fingerprint: string; caPin?: string; notAfter: number }
/** Verifies Web PKI and the exact Tailscale DNS name before reporting the leaf. No proxy header participates. */
export function probeTailnetCertificate(host: string): Promise<EdgeCertificate> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const socket = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => socket.destroy(new Error("tailnet certificate probe timed out")), 4000);
    const done = (error?: Error, result?: EdgeCertificate) => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); if (error || !result) reject(new Error("tailnet certificate probe unavailable")); else resolve(result); };
    socket.once("error", () => done(new Error("tailnet certificate probe unavailable")));
    socket.once("secureConnect", () => {
      try {
        const peer = socket.getPeerCertificate(true); if (!socket.authorized || !peer.raw?.length) throw new Error("untrusted tailnet certificate");
        let issuer = peer; const visited = new Set<string>(); let caPin: string | undefined;
        for (let depth = 0; depth < 10 && issuer.raw?.length; depth++) {
          const pin = certPin(issuer.raw); if (visited.has(pin)) break; visited.add(pin);
          const info = inspectCertificate(issuer.raw, new Date()); if (info.isCa && info.selfSigned) { caPin = pin; break; }
          if (!issuer.issuerCertificate) break; issuer = issuer.issuerCertificate;
        }
        done(undefined, { fingerprint: certPin(peer.raw), notAfter: Date.parse(peer.valid_to), ...(caPin ? { caPin } : {}) });
      } catch { done(new Error("tailnet certificate probe unavailable")); }
    });
  });
}
export const nativeRemoteExec: ExecPort = {
  run(file, args, opts) {
    return new Promise((resolve, reject) => {
      execFile(file, [...args], { timeout: opts?.timeoutMs ?? 8000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error && typeof error.code === "string") { reject(error); return; }
        resolve({ code: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr });
      });
    });
  },
};
const safeOrigin = (value: string, scheme: "https:"): URL => {
  const u = new URL(value); if (u.protocol !== scheme || u.username || u.password || u.pathname !== "/" || u.search || u.hash || ["0.0.0.0", "[::]"].includes(u.hostname)) throw new Error("remote publicOrigin must be a credential-free HTTPS origin"); return u;
};
function interfaces(): HostInterface[] { return Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).map(i => ({ name, address: i.address, internal: i.internal }))); }
export async function startRemoteRuntime(o: {
  home: string; config: RemoteConfig; localPort: number; publicOrigin?: string; noticeAck?: NoticeAck & { version: number };
  createApi: (bind: RemoteBind) => ApiServer; exec?: ExecPort; now?: () => number; hostInterfaces?: readonly HostInterface[];
  certificates?: RemoteCertificates; probeEdge?: (host: string) => Promise<EdgeCertificate>; report?: (state: RemoteRuntimeState) => void;
}): Promise<RemoteRuntime> {
  const parsed = parseRemoteConfig(o.config); if (!parsed.ok) throw new Error("invalid remote exposure configuration");
  const config = parsed.config;
  const now = o.now ?? Date.now, exec = o.exec ?? nativeRemoteExec, statusPath = join(o.home, "state", "remote-status.json");
  mkdirSync(join(o.home, "state"), { recursive: true, mode: 0o700 });
  let previousTarget: unknown; try { previousTarget = (JSON.parse(readPrivateText(statusPath) ?? "null") as RemoteRuntimeState).tailnetTarget; } catch { /* absent/corrupt history never authorizes replacing someone else's serve */ }
  let state: RemoteRuntimeState = { publish: config.publish, phase: "inactive", doctor: [] }, api: ApiServer | undefined, certificates: RemoteCertificates | undefined, tailnetCli: string | undefined, published = false;
  const record = (next: RemoteRuntimeState) => { state = next; privateAtomicJson(statusPath, state); o.report?.({ ...state }); };
  const result: RemoteRuntime = {
    get state() { return { ...state }; }, get api() { return api; }, get certificates() { return certificates; },
    async activateStaged() {
      if (config.publish !== "network" || !api || !certificates) throw new Error("no network TLS listener to rotate");
      const staged = certificates.staged(); if (!staged) throw new Error("no staged TLS material");
      const server = api.server as unknown as { setSecureContext: (material: { key: string; cert: string }) => void };
      try {
        server.setSecureContext({ key: staged.key, cert: staged.cert }); const activated = certificates.activateStaged();
        record({ ...state, fingerprint: activated.certPin, doctor: firstAidChecks(config, { now: now(), noticeAck: o.noticeAck, certNotAfter: activated.notAfter, tlsReady: true, allowlistPublic: allowlistPublic(config.allowSubnets) }) });
      } catch { await api.close(); api = undefined; record({ publish: config.publish, phase: "failed", doctor: [{ id: "remote.rotation-failed", severity: "warn", message: "TLS rotation failed; the remote listener closed safely." }] }); throw new Error("remote TLS rotation failed"); }
    },
    async close() {
      let cleanupFailed = false;
      try { if (published && tailnetCli) { const off = await runServePlan(exec, planServeOff({ cli: tailnetCli })); cleanupFailed = off.some(r => r.code !== 0); if (!cleanupFailed) published = false; } } catch { cleanupFailed = true; }
      await api?.close(); api = undefined;
      record({ publish: config.publish, phase: cleanupFailed ? "failed" : "inactive", doctor: cleanupFailed ? [{ id: "remote.tailnet-cleanup-failed", severity: "warn", message: "The private backend closed, but its Tailscale Serve rule could not be removed." }] : [] });
      if (cleanupFailed) throw new Error("could not stop the harness tailnet serve rule");
    },
  };
  const fail = async (id: string, message: string): Promise<RemoteRuntime> => {
    if (published && tailnetCli) { try { const off = await runServePlan(exec, planServeOff({ cli: tailnetCli })); if (off.every(r => r.code === 0)) published = false; } catch { /* backend still closes; close() retries owned Serve cleanup */ } }
    await api?.close(); api = undefined; record({ publish: config.publish, phase: "failed", doctor: [{ id, severity: "warn", message }] }); return result; };
  if (config.publish === "local") { record(state); return result; }
  if (config.publish === "tailnet") {
    if (config.allowSubnets.length) return fail("remote.tailnet-allowlist-unavailable", "Tailscale Serve hides client addresses; use Tailscale ACLs or network TLS for subnet allowlists. No proxy-header workaround is trusted.");
    try {
      const detected = await detectTailscale(exec);
      if (!detected.loggedIn || !detected.cliPath || !detected.magicDnsName) return fail(`remote.tailnet-${detected.state}`, "Tailscale is missing, stopped or not signed in; remote tailnet access stays unavailable. Install/sign in to Tailscale and restart the API.");
      tailnetCli = detected.cliPath; const publicOrigin = safeOrigin(`https://${detected.magicDnsName}`, "https:").origin;
      if (o.publicOrigin && safeOrigin(o.publicOrigin, "https:").origin !== publicOrigin) return fail("remote.tailnet-origin", "Configured tailnet origin does not match this machine's Tailscale DNS name.");
      const served = await detectServe(exec, tailnetCli);
      if (!served || served.funnelActive) return fail("remote.tailnet-public-refused", "Tailscale Serve status is unavailable or public publishing is active; the harness refuses publication.");
      if (served.proxies.some(target => target !== previousTarget)) return fail("remote.tailnet-serve-conflict", "An existing Tailscale Serve proxy belongs to another service; the harness does not overwrite it.");
      api = o.createApi({ host: "127.0.0.1", port: 0, remote: { publish: "tailnet", publicOrigin, allowSubnets: [] } });
      const bound = await api.listen(), target = `http://127.0.0.1:${bound.port}`;
      const applied = await runServePlan(exec, planServe({ cli: tailnetCli, port: bound.port }));
      if (!applied.length || applied.some(r => r.code !== 0)) { await runServePlan(exec, planServeOff({ cli: tailnetCli })); return fail("remote.tailnet-serve-failed", "Tailscale Serve failed; the remote backend closed. No wider listener was opened."); }
      published = true;
      let edge: EdgeCertificate;
      try { edge = await (o.probeEdge ?? probeTailnetCertificate)(detected.magicDnsName); }
      catch { await runServePlan(exec, planServeOff({ cli: tailnetCli })); published = false; return fail("remote.tailnet-certificate-unavailable", "The Tailscale HTTPS certificate could not be verified; the private remote backend closed. No wider listener opened."); }
      record({ publish: "tailnet", phase: "active", publicOrigin, fingerprint: edge.fingerprint, tailnetTarget: target, doctor: [] }); return result;
    } catch { return fail("remote.tailnet-unavailable", "Tailscale detection or publication failed; tailnet access stays unavailable. No network fallback was opened."); }
  }
  try {
    if (noticeNeeded(config, o.noticeAck)) return fail("remote.notice-unconfirmed", "Confirm the current network security notice before enabling the TLS listener.");
    if (!o.publicOrigin) return fail("remote.origin-required", "Network access needs an explicit HTTPS publicOrigin for Host, Origin and pairing checks.");
    const origin = safeOrigin(o.publicOrigin, "https:"), host = origin.hostname.replace(/^\[|\]$/g, ""), addresses = o.hostInterfaces ?? interfaces();
    const names = isIP(host) ? { hostnames: [] as string[], ips: [host] } : { hostnames: [host], ips: [] as string[] };
    certificates = o.certificates ?? new RemoteCertificates({ home: o.home, names, now });
    let material: RemoteTlsMaterial | undefined;
    if (config.tls === "self-signed") material = await certificates.ensureSelfSigned();
    else { material = certificates.current(); if (!material || material.kind !== "company-ca") return fail("remote.company-ca-missing", "Upload and activate matching company certificate/key material before opening network TLS."); }
    const plan = planListeners(config, { apiPort: o.localPort, tlsPort: origin.port ? Number(origin.port) : 443, hostInterfaces: addresses, tlsReady: true, noticeAck: o.noticeAck });
    if (!plan.ok) return fail(plan.refusals[0]?.code ?? "remote.network-plan", "Network listener plan refused the configured interface, port or notice. Review the remote configuration.");
    const bind = plan.listeners.find(l => l.id === "api-tls")!;
    if (bind.port !== (origin.port ? Number(origin.port) : 443)) return fail("remote.origin-port", "The HTTPS public origin and network listener port must match; no remote listener opened.");
    const allowed = compileAllowlist(config.allowSubnets); if (!allowed.ok) return fail("remote.allowlist-invalid", "Client subnet allowlist contains an invalid CIDR; no remote listener opened.");
    api = o.createApi({ host: bind.address, port: bind.port, tls: { key: material.key, cert: material.cert }, remote: { publish: "network", publicOrigin: origin.origin, allowSubnets: config.allowSubnets, ...(o.noticeAck ? { noticeAck: o.noticeAck } : {}) } });
    api.server.on("connection", socket => { if (!admitSocket(allowed.list, socket)) socket.destroy(); }); await api.listen();
    record({ publish: "network", phase: "active", publicOrigin: origin.origin, fingerprint: material.certPin, doctor: firstAidChecks(config, { now: now(), noticeAck: o.noticeAck, certNotAfter: material.notAfter, tlsReady: true, allowlistPublic: allowlistPublic(config.allowSubnets) }) }); return result;
  } catch { return fail("remote.tls-unavailable", "Remote TLS material or listener is unavailable; network access stays closed. Check certificate validity and permissions."); }
}
