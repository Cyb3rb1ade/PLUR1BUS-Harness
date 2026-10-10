// Declared egress list, the same pattern as packages/embedding-adapters/src/egress.ts (G5). This package never enforces
// egress policy (that is core's job, packages/core/src/egress); it states which hosts a voice configuration will talk
// to, so the integration can feed them into the allowlist. The shapes are restated structurally so the package does not
// depend on core or on embedding-adapters.
import { ELEVENLABS, GEMINI, XAI } from "./constants.ts";
import type { Catalog } from "./local/catalog.ts";
import type { VoiceProvidersConfig } from "./registry.ts";

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
  /** Providers that are enabled but whose host cannot be named from the configuration alone (Polly without a region: the SDK resolves it from the environment). */
  unresolved: string[];
}
/** The shape of core's EgressConfig, restated structurally. */
export interface EgressConfigShape {
  allowHosts: string[];
  allowPorts: number[];
  allowLoopback: boolean;
}

/**
 * Where GitHub release assets are actually served from. A download from github.com answers 302 to one of these, and the
 * model downloader follows redirects, so core's allowlist must see them too. `release-assets` is the current host;
 * `objects` is the older one that mirrors may still redirect to.
 */
export const GITHUB_RELEASE_HOSTS: readonly string[] = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];

function isLoopback(host: string): boolean {
  const h = host.startsWith("[") ? host.slice(1, -1) : host;
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function hostOf(url: string): EgressHost {
  const u = new URL(url);
  const tls = u.protocol === "https:" || u.protocol === "wss:";
  const defaultPort = tls ? 443 : 80;
  return { host: u.hostname.toLowerCase().replace(/\.$/, ""), port: u.port !== "" ? Number(u.port) : defaultPort, tls, loopback: isLoopback(u.hostname) };
}

function merge(list: EgressHost[]): EgressHost[] {
  const seen = new Map<string, EgressHost>();
  for (const h of list) seen.set(`${h.host}:${h.port}:${h.tls}`, h);
  return [...seen.values()].sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port);
}

export interface VoiceEgressInput {
  /** voice.providers.*: only enabled providers contribute. */
  providers?: VoiceProvidersConfig;
  /** The catalog whose model downloads may run (built-in plus voice.local.catalogOverride); omit when local voice is not used. */
  catalog?: Catalog;
}

/** Hosts for the enabled cloud providers and the local model downloads. An invalid baseUrl throws, never yields a partial list. */
export function voiceEgressHosts(input: VoiceEgressInput): EgressDeclaration {
  const list: EgressHost[] = [];
  const unresolved: string[] = [];
  const p = input.providers ?? {};
  if (p.elevenlabs?.enabled) list.push(hostOf(p.elevenlabs.baseUrl ?? `https://${ELEVENLABS.hosts[p.elevenlabs.region ?? "default"] ?? ELEVENLABS.hosts["default"]}`));
  if (p.xai?.enabled) list.push(hostOf(p.xai.baseUrl ?? XAI.baseUrl));
  if (p.gemini?.enabled) list.push(hostOf(p.gemini.baseUrl ?? GEMINI.baseUrl));
  if (p.polly?.enabled) {
    if (p.polly.region) list.push({ host: `polly.${p.polly.region.toLowerCase()}.amazonaws.com`, port: 443, tls: true, loopback: false });
    else unresolved.push("polly");
  }
  if (input.catalog) {
    for (const m of Object.values(input.catalog.models)) {
      for (const d of m.download) {
        if (d.url === null) continue;
        const h = hostOf(d.url);
        list.push(h);
        if (h.host === "github.com") for (const redirect of GITHUB_RELEASE_HOSTS) list.push({ host: redirect, port: 443, tls: true, loopback: false });
      }
    }
  }
  return { hosts: merge(list), unresolved };
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
