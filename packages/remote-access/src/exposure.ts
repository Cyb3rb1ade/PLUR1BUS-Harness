// Exposure model (desktop spec §6.2 "Remote exposure"; ADR-004 amendment 2026-10-02, C8): the configuration types and
// their validation, and `planListeners`, which turns a configuration plus a description of the host into the list of
// sockets the API would open. The plan is pure data. Opening the sockets is the API package's job (follow-up).
//
// The API is never public: there is no Funnel, the parser rejects the word at any depth, and no plan contains it.
import { addressScope, formatCidr, formatIp, parseCidr, parseIp } from "./net-address.ts";
import type { NoticeAck, Note } from "./types.ts";

export type PublishMode = "local" | "tailnet" | "network";
export type TlsMode = "self-signed" | "company-ca";

export interface BindConfig {
  /** Interface address for the TLS listener; absent = all interfaces (`0.0.0.0`). */
  readonly address?: string;
  /** Port for the TLS listener; absent = the port the supervisor reserved for it (`PlanEnv.tlsPort`). */
  readonly port?: number;
  /** The person confirmed that a publicly routable interface may carry the listener. */
  readonly allowPublicInterface?: boolean;
}

export interface RemoteConfig {
  readonly publish: PublishMode;
  readonly tls: TlsMode;
  readonly bind: BindConfig;
  /** Normalised CIDRs; empty = any client (pairing is still required for every device). */
  readonly allowSubnets: readonly string[];
}

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = Object.freeze({
  publish: "tailnet", tls: "self-signed", bind: Object.freeze({}), allowSubnets: Object.freeze([]),
});

export type ConfigIssueCode =
  | "not-an-object" | "unknown-key" | "funnel-forbidden" | "alias-conflict"
  | "invalid-publish" | "invalid-tls" | "invalid-bind" | "invalid-cidr";
export interface ConfigIssue { readonly path: string; readonly code: ConfigIssueCode; readonly message: string }
export type ParseResult =
  | { readonly ok: true; readonly config: RemoteConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

const PUBLISH_MODES: readonly string[] = ["local", "tailnet", "network"];
const TLS_MODES: readonly string[] = ["self-signed", "company-ca"];
const TOP_KEYS = new Set(["publish", "tls", "bind", "allowSubnets", "allowCidrs"]);
const BIND_KEYS = new Set(["address", "port", "allowPublicInterface"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Funnel publishes to the internet; no configuration may ask for it, however it is spelled or nested. */
function findFunnel(value: unknown, path: string, out: ConfigIssue[]): void {
  const fail = (p: string) => out.push({ path: p, code: "funnel-forbidden", message: "Funnel is not supported: the API is never published to the internet" });
  if (typeof value === "string") {
    if (/funnel/i.test(value)) fail(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findFunnel(v, `${path}[${i}]`, out));
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      const p = path === "" ? k : `${path}.${k}`;
      if (/funnel/i.test(k)) fail(p);
      findFunnel(v, p, out);
    }
  }
}

export function parseRemoteConfig(input: unknown): ParseResult {
  if (input === undefined) return { ok: true, config: DEFAULT_REMOTE_CONFIG };
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", code: "not-an-object", message: "remote configuration must be an object" }] };
  const issues: ConfigIssue[] = [];
  findFunnel(input, "", issues);
  for (const key of Object.keys(input)) {
    if (!TOP_KEYS.has(key) && !/funnel/i.test(key)) issues.push({ path: key, code: "unknown-key", message: `unknown key ${key}` });
  }

  let publish: PublishMode = DEFAULT_REMOTE_CONFIG.publish;
  if (input["publish"] !== undefined) {
    if (typeof input["publish"] === "string" && PUBLISH_MODES.includes(input["publish"])) publish = input["publish"] as PublishMode;
    else issues.push({ path: "publish", code: "invalid-publish", message: "publish must be local, tailnet or network" });
  }
  let tls: TlsMode = DEFAULT_REMOTE_CONFIG.tls;
  if (input["tls"] !== undefined) {
    if (typeof input["tls"] === "string" && TLS_MODES.includes(input["tls"])) tls = input["tls"] as TlsMode;
    else issues.push({ path: "tls", code: "invalid-tls", message: "tls must be self-signed or company-ca" });
  }

  const bind: { address?: string; port?: number; allowPublicInterface?: boolean } = {};
  const rawBind = input["bind"];
  if (rawBind !== undefined) {
    if (!isRecord(rawBind)) {
      issues.push({ path: "bind", code: "invalid-bind", message: "bind must be an object" });
    } else {
      for (const key of Object.keys(rawBind)) {
        if (!BIND_KEYS.has(key) && !/funnel/i.test(key)) issues.push({ path: `bind.${key}`, code: "unknown-key", message: `unknown key bind.${key}` });
      }
      const { address, port, allowPublicInterface } = rawBind;
      if (address !== undefined) {
        if (typeof address === "string" && parseIp(address) !== undefined) bind.address = address;
        else issues.push({ path: "bind.address", code: "invalid-bind", message: "bind.address must be an IP address (host names are not accepted)" });
      }
      if (port !== undefined) {
        if (typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535) bind.port = port;
        else issues.push({ path: "bind.port", code: "invalid-bind", message: "bind.port must be an integer from 1024 to 65535" });
      }
      if (allowPublicInterface !== undefined) {
        if (typeof allowPublicInterface === "boolean") bind.allowPublicInterface = allowPublicInterface;
        else issues.push({ path: "bind.allowPublicInterface", code: "invalid-bind", message: "bind.allowPublicInterface must be true or false" });
      }
    }
  }

  let subnetKey: "allowSubnets" | "allowCidrs" | undefined;
  if (input["allowSubnets"] !== undefined && input["allowCidrs"] !== undefined) {
    issues.push({ path: "allowCidrs", code: "alias-conflict", message: "allowCidrs is the spec's name for allowSubnets; give only one" });
  } else {
    subnetKey = input["allowSubnets"] !== undefined ? "allowSubnets" : input["allowCidrs"] !== undefined ? "allowCidrs" : undefined;
  }
  const allowSubnets: string[] = [];
  if (subnetKey !== undefined) {
    const raw = input[subnetKey];
    if (!Array.isArray(raw)) {
      issues.push({ path: subnetKey, code: "invalid-cidr", message: `${subnetKey} must be an array of CIDR strings` });
    } else {
      raw.forEach((entry, i) => {
        const cidr = typeof entry === "string" ? parseCidr(entry) : undefined;
        if (!cidr) issues.push({ path: `${subnetKey}[${i}]`, code: "invalid-cidr", message: "not a valid IPv4 or IPv6 CIDR" });
        else if (!allowSubnets.includes(formatCidr(cidr))) allowSubnets.push(formatCidr(cidr));
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config: { publish, tls, bind, allowSubnets } };
}

// --- listener plan -------------------------------------------------------------------------------------------------

export interface HostInterface {
  readonly name: string;
  readonly address: string;
  readonly internal?: boolean;
}

export interface PlanEnv {
  /** The plain-http loopback port of the API (from the supervisor's registry). */
  readonly apiPort: number;
  /** The reserved port for the TLS listener, used when `bind.port` is not set. */
  readonly tlsPort?: number | undefined;
  readonly hostInterfaces: readonly HostInterface[];
  /** What `detectTailscale` found; absent = unknown / not installed. */
  readonly tailscale?: { readonly loggedIn: boolean; readonly dnsName?: string | undefined } | undefined;
  /** A usable server certificate and key are present (generated or imported and validated). */
  readonly tlsReady?: boolean | undefined;
  /** The recorded confirmation of the *current* security notice (security.ts `noticeNeeded`); callers pass an outdated one as absent. */
  readonly noticeAck?: NoticeAck | undefined;
}

export interface Listener {
  readonly id: "api-loopback" | "api-tls";
  readonly protocol: "http" | "https";
  readonly address: string;
  readonly port: number;
  /** True for the listener that refuses plain http. */
  readonly tlsOnly: boolean;
  /** Present only on the TLS listener and only when a client-subnet allow-list is configured. */
  readonly allowSubnets?: readonly string[];
}

export type PlanResult =
  | {
    readonly ok: true;
    readonly listeners: readonly Listener[];
    /** `tailscale serve` target: HTTPS on the tailnet name → the loopback port. Never a Funnel. */
    readonly tailscaleServe?: { readonly httpsPort: 443; readonly target: string };
    readonly warnings: readonly Note[];
  }
  | { readonly ok: false; readonly refusals: readonly Note[]; readonly warnings: readonly Note[] };

const LOOPBACK_ADDRESS = "127.0.0.1";

export function planListeners(config: RemoteConfig, env: PlanEnv): PlanResult {
  const warnings: Note[] = [];
  const refusals: Note[] = [];
  const loopback: Listener = { id: "api-loopback", protocol: "http", address: LOOPBACK_ADDRESS, port: env.apiPort, tlsOnly: false };

  if (config.publish !== "network") {
    if (config.bind.address !== undefined || config.bind.port !== undefined) {
      warnings.push({ code: "bind-ignored", message: `remote.bind only applies to publish=network; it is ignored at ${config.publish}` });
    }
    if (config.allowSubnets.length > 0) {
      warnings.push({
        code: "allow-subnets-not-enforced",
        message: `the client-subnet allow-list is only enforced on the network listener; at ${config.publish} every request arrives on loopback`,
      });
    }
  }

  if (config.publish === "local") return { ok: true, listeners: [loopback], warnings };

  if (config.publish === "tailnet") {
    if (!env.tailscale?.loggedIn) {
      warnings.push({ code: "tailnet-not-joined", message: "this machine has not joined a tailnet; tailnet reaches no further than local until it does" });
      return { ok: true, listeners: [loopback], warnings };
    }
    return { ok: true, listeners: [loopback], tailscaleServe: { httpsPort: 443, target: `http://${LOOPBACK_ADDRESS}:${env.apiPort}` }, warnings };
  }

  // network
  if (!env.tlsReady) refusals.push({ code: "network-needs-tls", message: "network publishing is TLS-only and no usable server certificate is present" });
  if (!env.noticeAck) refusals.push({ code: "network-needs-notice-confirmation", message: "the security notice for network publishing has not been confirmed" });

  const port = config.bind.port ?? env.tlsPort;
  if (port === undefined) refusals.push({ code: "network-no-port", message: "no port reserved for the TLS listener" });
  else if (port === env.apiPort) refusals.push({ code: "network-port-clash", message: "the TLS listener cannot share the loopback API port" });

  const wanted = config.bind.address ?? "0.0.0.0";
  const ip = parseIp(wanted);
  let address = wanted;
  if (!ip) {
    refusals.push({ code: "network-bind-unknown-interface", message: `${wanted} is not an IP address` });
  } else {
    address = config.bind.address === undefined ? wanted : formatIp(ip);
    const scope = addressScope(ip);
    const external = env.hostInterfaces.filter((i) => !i.internal);
    if (scope === "loopback") {
      refusals.push({ code: "network-bind-loopback", message: "network publishing on a loopback address reaches nobody; use publish=local" });
    } else if (scope === "unspecified") {
      const exposed = external.filter((i) => { const p = parseIp(i.address); return p !== undefined && addressScope(p) === "public"; });
      if (exposed.length > 0) {
        if (config.bind.allowPublicInterface) warnings.push({ code: "network-public-interface-confirmed", message: `all interfaces include publicly routable ${exposed.map((i) => i.address).join(", ")}` });
        else refusals.push({ code: "network-public-interface-unconfirmed", message: `binding all interfaces would include publicly routable ${exposed.map((i) => i.address).join(", ")}; bind a private address or confirm explicitly` });
      }
    } else {
      const known = env.hostInterfaces.some((i) => { const p = parseIp(i.address); return p !== undefined && p.family === ip.family && formatIp(p) === formatIp(ip); });
      if (!known) refusals.push({ code: "network-bind-unknown-interface", message: `${wanted} is not an address of this machine` });
      else if (scope === "public") {
        if (config.bind.allowPublicInterface) warnings.push({ code: "network-public-interface-confirmed", message: `${wanted} is publicly routable` });
        else refusals.push({ code: "network-public-interface-unconfirmed", message: `${wanted} is publicly routable; confirm explicitly to bind it` });
      }
    }
  }

  if (refusals.length > 0 || port === undefined) return { ok: false, refusals, warnings };
  const tlsListener: Listener = config.allowSubnets.length > 0
    ? { id: "api-tls", protocol: "https", address, port, tlsOnly: true, allowSubnets: [...config.allowSubnets] }
    : { id: "api-tls", protocol: "https", address, port, tlsOnly: true };
  return { ok: true, listeners: [loopback, tlsListener], warnings };
}
