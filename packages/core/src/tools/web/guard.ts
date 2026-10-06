// The SSRF guard's decision point (D94 "Safety"): resolve a host, refuse anything that is not positively public,
// and hand back ONE address to pin for the connect. Used for the first request and for every redirect hop.
import { lookup } from "node:dns/promises";
import { WebFailure } from "./failure.ts";
import { canonical, classifyAddress, inCidr, parseAddress, parseCidr, type Cidr, type ParsedAddress } from "./ip.ts";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable so tests (and a future egress profile) control name resolution. Must return every address. */
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (host) => {
  const all = await lookup(host, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

export interface AddressPolicy {
  readonly allow: readonly Cidr[];
}

/** The explicit per-installation allowlist (D94). An invalid entry throws: a typo must not silently widen or narrow it. */
export function makeAddressPolicy(allowCidrs: readonly string[]): AddressPolicy {
  const allow = allowCidrs.map((c) => {
    const parsed = parseCidr(c);
    if (!parsed) throw new Error(`invalid web.allowPrivate entry: ${JSON.stringify(c)}`);
    return parsed;
  });
  return { allow };
}

export function formatAddress(a: ParsedAddress): string {
  const c = canonical(a);
  if (c.family === 4) return Array.from(c.bytes).join(".");
  const g: string[] = [];
  for (let i = 0; i < 16; i += 2) g.push(((c.bytes[i]! << 8) | c.bytes[i + 1]!).toString(16));
  return g.join(":");
}

function admit(a: ParsedAddress, policy: AddressPolicy, host: string): ResolvedAddress {
  const c = canonical(a);
  const verdict = classifyAddress(c);
  if (!verdict.public && !policy.allow.some((cidr) => inCidr(c, cidr))) {
    throw new WebFailure("private-address", `${host} resolves to a non-public address (${verdict.reason})`);
  }
  return { address: formatAddress(c), family: c.family };
}

/**
 * Resolve `host` and return the single address the connection must use. Refuses if ANY answer is non-public, so a
 * name that mixes a public and an internal record cannot be used to reach the internal one.
 */
export async function resolveGuarded(host: string, resolver: Resolver, policy: AddressPolicy): Promise<ResolvedAddress> {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name === "" || name.length > 253 || /[\s/\\@]/.test(name)) throw new WebFailure("invalid-url", `invalid host ${JSON.stringify(host)}`);

  const literal = parseAddress(name);
  if (literal) return admit(literal, policy, name);

  if (name === "localhost" || name.endsWith(".localhost")) {
    const loop = parseAddress("127.0.0.1")!;
    return admit(loop, policy, name); // refused unless 127.0.0.0/8 is allowlisted
  }

  let answers: ResolvedAddress[];
  try {
    answers = await resolver(name);
  } catch (err) {
    throw new WebFailure("not-found", `could not resolve ${name}: ${(err as { code?: string }).code ?? "lookup failed"}`);
  }
  if (answers.length === 0) throw new WebFailure("not-found", `could not resolve ${name}: no addresses`);
  const admitted = answers.map((r) => {
    const parsed = parseAddress(r.address);
    if (!parsed) throw new WebFailure("private-address", `${name} resolved to an unparseable address`);
    return admit(parsed, policy, name);
  });
  return admitted[0]!;
}
