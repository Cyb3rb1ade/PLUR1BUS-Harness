// Declared egress list (G5). This package never enforces egress policy (that is core's job, packages/core/src/egress);
// it only states which hosts a configuration will talk to, so the integration can feed them into the allowlist.
import { resolveEmbeddingSettings, resolveRerankSettings, type EmbeddingConfig, type RerankConfig } from "./config.ts";

export interface EgressHost {
  /** URL hostname, lower-case, IPv6 literals in brackets (the spelling core's allowHosts expects). */
  host: string;
  port: number;
  tls: boolean;
  /** Loopback targets need allowLoopback in core's policy; plain http is only ever accepted for these. */
  loopback: boolean;
}

export interface EgressDeclaration {
  hosts: EgressHost[];
}

/** The shape of core's EgressConfig, restated structurally so this package does not depend on core. */
export interface EgressConfigShape {
  allowHosts: string[];
  allowPorts: number[];
  allowLoopback: boolean;
}

function isLoopback(host: string): boolean {
  const h = host.startsWith("[") ? host.slice(1, -1) : host;
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function hostOf(baseURL: string): EgressHost {
  const u = new URL(baseURL);
  const tls = u.protocol === "https:";
  return { host: u.hostname.toLowerCase().replace(/\.$/, ""), port: u.port !== "" ? Number(u.port) : tls ? 443 : 80, tls, loopback: isLoopback(u.hostname) };
}

function merge(list: EgressHost[]): EgressHost[] {
  const seen = new Map<string, EgressHost>();
  for (const h of list) seen.set(`${h.host}:${h.port}:${h.tls}`, h);
  return [...seen.values()].sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port);
}

export function embeddingEgressHosts(config: EmbeddingConfig): EgressHost[] {
  return [hostOf(resolveEmbeddingSettings(config).baseURL)];
}

export function rerankEgressHosts(config: RerankConfig): EgressHost[] {
  return [hostOf(resolveRerankSettings(config).baseURL)];
}

/** Hosts for any mix of embedding and rerank configs. Invalid configs throw ConfigError, never yield a partial list. */
export function egressHosts(input: { embedding?: EmbeddingConfig | readonly EmbeddingConfig[]; rerank?: RerankConfig | readonly RerankConfig[] }): EgressDeclaration {
  const list: EgressHost[] = [];
  const asArray = <T>(v: T | readonly T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? [...(v as readonly T[])] : [v as T]);
  asArray(input.embedding).forEach((c, i) => list.push(hostOf(resolveEmbeddingSettings(c, `embedding[${i}]`).baseURL)));
  asArray(input.rerank).forEach((c, i) => list.push(hostOf(resolveRerankSettings(c, `rerank[${i}]`).baseURL)));
  return { hosts: merge(list) };
}

/** A ready-to-merge fragment for core's `EgressConfig`. Loopback targets set allowLoopback; other plain-http hosts are not representable and are reported. */
export function toEgressConfig(decl: EgressDeclaration): { config: EgressConfigShape; plaintextNonLoopback: EgressHost[] } {
  const allowHosts = [...new Set(decl.hosts.map((h) => h.host))].sort();
  const allowPorts = [...new Set(decl.hosts.map((h) => h.port))].sort((a, b) => a - b);
  return {
    config: { allowHosts, allowPorts, allowLoopback: decl.hosts.some((h) => h.loopback) },
    plaintextNonLoopback: decl.hosts.filter((h) => !h.tls && !h.loopback),
  };
}
