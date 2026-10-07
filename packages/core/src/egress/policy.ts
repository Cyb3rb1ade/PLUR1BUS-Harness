// The egress policy as data (B4): which destinations the core may talk to. Pure, no I/O. Default deny: an empty host
// list allows nothing, an invalid entry never widens the policy (the whole host list becomes deny-all and the error is
// reported by `egress.status`).
import { domainToASCII } from "node:url";
import { canonical, parseAddress } from "../tools/web/ip.ts";
import { formatAddress } from "../tools/web/guard.ts";

export interface EgressConfig {
  /** Exact names, `*.suffix` (subdomains of any depth, not the apex), `*` (any NAME, never an IP literal), or an exact IP literal. */
  readonly allowHosts: readonly string[];
  readonly allowPorts: readonly number[];
  /** Permit plain http and loopback targets, but only for hosts that are themselves loopback spellings and are listed. */
  readonly allowLoopback: boolean;
}

export const DEFAULT_EGRESS_CONFIG: EgressConfig = Object.freeze({ allowHosts: Object.freeze([]), allowPorts: Object.freeze([443]), allowLoopback: false });

type HostRule = { kind: "exact"; host: string } | { kind: "suffix"; suffix: string } | { kind: "any-name" } | { kind: "ip"; address: string };

export interface EgressPolicy {
  readonly hostRules: readonly HostRule[];
  readonly allowPorts: readonly number[];
  readonly allowLoopback: boolean;
  /** Human-readable problems with the configuration; non-empty means the affected list is deny-all. */
  readonly errors: readonly string[];
  /** The entries as normalised, for `egress.status`. */
  readonly allowHosts: readonly string[];
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function normaliseName(raw: string): string | null {
  let n = raw.trim().toLowerCase();
  if (n.endsWith(".")) n = n.slice(0, -1);
  if (n === "" || n.length > 253 || /[^\x21-\x7e\u0080-￿]/.test(n) || /[/\\@:?#%\s]/.test(n)) return null;
  const ascii = domainToASCII(n);
  if (ascii === "" || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (!labels.every((l) => LABEL.test(l))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null; // numeric last label = an IP spelling, not a name
  return ascii;
}

function compileHost(entry: unknown): HostRule | string {
  if (typeof entry !== "string") return "host entry is not a string";
  const e = entry.trim();
  if (e === "*") return { kind: "any-name" };
  const loose = parseAddress(e);
  if (loose) {
    const a = parseAddress(e, { strict: true });
    if (!a || e.startsWith("[") !== (a.family === 6)) return `host entry ${JSON.stringify(e.slice(0, 64))} is not a canonical IP literal (IPv6 in brackets)`;
    return { kind: "ip", address: formatAddress(a) };
  }
  if (e.startsWith("*.")) {
    const s = normaliseName(e.slice(2));
    return s === null || e.slice(2).includes("*") ? `host entry ${JSON.stringify(e.slice(0, 64))} is not a valid wildcard` : { kind: "suffix", suffix: s };
  }
  const n = e.includes("*") ? null : normaliseName(e);
  return n === null ? `host entry ${JSON.stringify(e.slice(0, 64))} is not a valid host name` : { kind: "exact", host: n };
}

export function compileEgressPolicy(cfg: EgressConfig): EgressPolicy {
  const errors: string[] = [];
  const rules: HostRule[] = [];
  for (const entry of cfg.allowHosts) {
    const r = compileHost(entry);
    if (typeof r === "string") errors.push(r);
    else rules.push(r);
  }
  const badPort = cfg.allowPorts.find((p) => !Number.isInteger(p) || p < 1 || p > 65535);
  const portsOk = badPort === undefined;
  if (!portsOk) errors.push(`port ${JSON.stringify(badPort)} is not an integer in 1..65535`);
  // RULING: a configuration error never widens or half-applies the policy: any error empties both lists.
  const failed = errors.length > 0;
  return {
    hostRules: failed ? [] : rules,
    allowPorts: failed || !portsOk ? [] : [...cfg.allowPorts],
    allowLoopback: cfg.allowLoopback === true && !failed,
    errors,
    allowHosts: failed ? [] : rules.map((r) => (r.kind === "exact" ? r.host : r.kind === "suffix" ? `*.${r.suffix}` : r.kind === "any-name" ? "*" : r.address)),
  };
}

/** `host` is a URL hostname (lowercase, brackets on IPv6). */
export function hostAllowed(p: EgressPolicy, host: string): boolean {
  let h = host.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  const lit = parseAddress(h);
  if (lit) {
    const addr = formatAddress(canonical(lit));
    return p.hostRules.some((r) => r.kind === "ip" && r.address === addr);
  }
  return p.hostRules.some((r) => (r.kind === "any-name" ? true : r.kind === "exact" ? r.host === h : r.kind === "suffix" ? h.endsWith(`.${r.suffix}`) : false));
}
