// The egress service (B4): one object the rest of the core asks before it talks to the network. It compiles the live
// configuration on each call (so `egress.*` config changes apply without a restart), owns the decision counters and
// wraps the one guarded HTTP client with the gate, so redirects are re-checked and the connect is pinned to the vetted IP.
import { WebFailure } from "../tools/web/failure.ts";
import { makeAddressPolicy, resolveGuarded, systemResolver, type Resolver } from "../tools/web/guard.ts";
import { guardedRequest, type HttpOptions, type HttpResponse } from "../tools/web/http.ts";
import { createGate, bareHost, isLoopbackHost, effectivePort, type DenyReason, type Decision } from "./gate.ts";
import { compileEgressPolicy, type EgressConfig, type EgressPolicy } from "./policy.ts";

export interface EgressStatus {
  policy: { allowHosts: string[]; allowPorts: number[]; allowLoopback: boolean; valid: boolean; errors: string[] };
  decisions: { allowed: number; denied: number; byReason: Record<string, number> };
  since: string;
}

export type DryRun =
  | { allowed: true; host: string; port: number; address: string; family: 4 | 6 }
  | { allowed: false; reason: DenyReason; message: string };

export interface Egress {
  /** The guarded request: every hop (first and redirects) passes the gate and the SSRF range check, then connects to the pinned IP. */
  request(url: string, options: Omit<HttpOptions, "resolver" | "policy" | "gate">): Promise<HttpResponse>;
  /** Judge one URL without connecting. */
  decide(url: string): Promise<DryRun>;
  status(): EgressStatus;
}

export interface EgressOptions {
  config: () => EgressConfig;
  resolver?: Resolver;
  now?: () => number;
}

export function createEgress(o: EgressOptions): Egress {
  const resolver = o.resolver ?? systemResolver;
  const since = new Date((o.now ?? Date.now)()).toISOString();
  let allowed = 0;
  const denied: Record<string, number> = {};
  const record = (d: Decision): void => {
    if (d.allowed) allowed++;
    else denied[d.reason] = (denied[d.reason] ?? 0) + 1;
  };
  // RULING: the SSRF range check never relaxes through egress config; loopback is admitted below only via allowLoopback.
  const loopback = makeAddressPolicy(["127.0.0.0/8", "::1/128"]).allow;
  // Only a host that is itself a loopback spelling may resolve to loopback: a public name answering 127.0.0.1 (alone or
  // beside a public record) is a private-address refusal, so allowLoopback cannot be used for rebinding.
  const addressPolicy = (p: EgressPolicy) => ({ allow: [], forHost: (h: string) => (p.allowLoopback && isLoopbackHost(h) ? loopback : []) });

  return {
    async request(url, options) {
      const policy = compileEgressPolicy(o.config());
      try {
        return await guardedRequest(url, { ...options, resolver, policy: addressPolicy(policy), gate: createGate(policy, { onDecision: record }) });
      } catch (err) {
        if (err instanceof WebFailure && err.code === "private-address") record({ allowed: false, reason: "private-address" });
        throw err;
      }
    },
    async decide(raw) {
      const policy = compileEgressPolicy(o.config());
      const gate = createGate(policy, { onDecision: record });
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        record({ allowed: false, reason: "invalid-url" });
        return { allowed: false, reason: "invalid-url", message: "not a valid URL" };
      }
      try {
        gate.beforeResolve(url);
        const pin = await resolveGuarded(url.hostname, resolver, addressPolicy(policy));
        gate.afterResolve(url, pin);
        return { allowed: true, host: bareHost(url), port: effectivePort(url), address: pin.address, family: pin.family };
      } catch (err) {
        if (err instanceof WebFailure) {
          const reason = (err as { reason?: DenyReason }).reason ?? (err.code === "private-address" ? "private-address" : err.code === "not-found" ? "not-found" : "invalid-url");
          if (reason === "private-address") record({ allowed: false, reason });
          return { allowed: false, reason, message: err.message };
        }
        throw err;
      }
    },
    status() {
      const p = compileEgressPolicy(o.config());
      return {
        policy: { allowHosts: [...p.allowHosts], allowPorts: [...p.allowPorts], allowLoopback: p.allowLoopback, valid: p.errors.length === 0, errors: [...p.errors] },
        decisions: { allowed, denied: Object.values(denied).reduce((a, b) => a + b, 0), byReason: { ...denied } },
        since,
      };
    },
  };
}
