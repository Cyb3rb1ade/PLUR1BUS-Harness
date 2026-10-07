// The per-hop decision (B4). `beforeResolve` runs on the URL alone, so a name the policy does not allow is never looked
// up; `afterResolve` runs on the one address the connect will be pinned to. The SSRF range check itself stays in
// `tools/web/guard.ts` (`resolveGuarded`); the gate adds scheme, port, host allowlist and the loopback rules.
import { WebFailure } from "../tools/web/failure.ts";
import type { ResolvedAddress } from "../tools/web/guard.ts";
import { classifyAddress, parseAddress } from "../tools/web/ip.ts";
import { hostAllowed, type EgressPolicy } from "./policy.ts";

export type DenyReason = "invalid-url" | "scheme" | "port" | "host-not-allowed" | "loopback" | "private-address" | "not-found";
export type Decision = { allowed: true } | { allowed: false; reason: DenyReason };

export class EgressDenial extends WebFailure {
  readonly reason: DenyReason;
  constructor(reason: DenyReason, message: string) {
    super(reason === "private-address" ? "private-address" : "egress-denied", message);
    this.reason = reason;
  }
}

export interface HopGate {
  beforeResolve(url: URL): void;
  afterResolve(url: URL, pin: ResolvedAddress): void;
}

export interface GateHooks {
  onDecision?: (d: Decision) => void;
}

export const bareHost = (url: URL): string => (url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname).toLowerCase().replace(/\.$/, "");

/** A host that is itself a loopback spelling: `localhost`, `*.localhost`, or an IP literal in 127/8 or ::1 (any spelling). */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const a = parseAddress(host);
  return a !== null && classifyAddress(a).reason === "loopback";
}

export const effectivePort = (url: URL): number => (url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80);

export function createGate(policy: EgressPolicy, hooks: GateHooks = {}): HopGate {
  const deny = (reason: DenyReason, message: string): never => {
    hooks.onDecision?.({ allowed: false, reason });
    throw new EgressDenial(reason, message);
  };
  return {
    beforeResolve(url) {
      const host = bareHost(url);
      const loopbackOk = policy.allowLoopback && isLoopbackHost(host);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackOk)) {
        return deny("scheme", `${url.protocol} to ${host} is not allowed (https only; http only to a listed loopback host when egress.allowLoopback is on)`);
      }
      if (host === "") return deny("invalid-url", "URL has no host");
      const port = effectivePort(url);
      if (!policy.allowPorts.includes(port)) return deny("port", `port ${port} is not in egress.allowPorts`);
      if (!hostAllowed(policy, host)) return deny("host-not-allowed", `${host} is not in egress.allowHosts`);
    },
    afterResolve(url, pin) {
      const host = bareHost(url);
      const a = parseAddress(pin.address);
      const loopbackPin = a !== null && classifyAddress(a).reason === "loopback";
      // RULING: a public name that answers with a loopback address is rebinding-shaped; refused whatever allowLoopback says.
      if (loopbackPin && !isLoopbackHost(host)) return deny("loopback", `${host} resolved to a loopback address`);
      if (url.protocol === "http:" && !loopbackPin) return deny("scheme", `plain http to ${host} is only allowed for loopback`);
      hooks.onDecision?.({ allowed: true });
    },
  };
}
