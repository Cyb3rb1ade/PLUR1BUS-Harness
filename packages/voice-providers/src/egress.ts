// Declared egress list (F9). Follows packages/embedding-adapters/src/egress.ts.
// This package never enforces egress policy; it states which hosts a configuration will talk to
// so the core integration can feed them into the allowlist.
import { ELEVENLABS, GEMINI, XAI } from "./constants.ts";
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
}

export interface EgressConfigShape {
  allowHosts: string[];
  allowPorts: number[];
  allowLoopback: boolean;
}

function isLoopback(host: string): boolean {
  const h = host.startsWith("[") ? host.slice(1, -1) : host;
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function hostOf(urlOrHost: string): EgressHost {
  const normalized = /^https?:\/\//i.test(urlOrHost) ? urlOrHost : `https://${urlOrHost}`;
  const u = new URL(normalized);
  const tls = u.protocol === "https:" || u.protocol === "wss:";
  return {
    host: u.hostname.toLowerCase().replace(/\.$/, ""),
    port: u.port !== "" ? Number(u.port) : tls ? 443 : 80,
    tls,
    loopback: isLoopback(u.hostname),
  };
}

function merge(list: EgressHost[]): EgressHost[] {
  const seen = new Map<string, EgressHost>();
  for (const h of list) seen.set(`${h.host}:${h.port}:${h.tls}`, h);
  return [...seen.values()].sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port);
}

export function voiceEgressHosts(config: VoiceProvidersConfig | undefined): EgressHost[] {
  if (!config) return [];
  const list: EgressHost[] = [];

  if (config.elevenlabs?.enabled) {
    if (config.elevenlabs.baseUrl) {
      list.push(hostOf(config.elevenlabs.baseUrl));
    } else {
      const reg = config.elevenlabs.region;
      const host = (reg && ELEVENLABS.hosts[reg]) || ELEVENLABS.hosts.default || "api.elevenlabs.io";
      list.push(hostOf(host));
    }
  }

  if (config.xai?.enabled) {
    list.push(hostOf(config.xai.baseUrl ?? XAI.baseUrl));
  }

  if (config.gemini?.enabled) {
    list.push(hostOf(config.gemini.baseUrl ?? GEMINI.baseUrl));
  }

  if (config.polly?.enabled) {
    const region = config.polly.region ?? "us-east-1";
    list.push(hostOf(`https://polly.${region}.amazonaws.com`));
  }

  return merge(list);
}

export function egressHosts(config: VoiceProvidersConfig | undefined): EgressDeclaration {
  return { hosts: voiceEgressHosts(config) };
}

export function toEgressConfig(decl: EgressDeclaration): { config: EgressConfigShape; plaintextNonLoopback: EgressHost[] } {
  const allowHosts = [...new Set(decl.hosts.map((h) => h.host))].sort();
  const allowPorts = [...new Set(decl.hosts.map((h) => h.port))].sort((a, b) => a - b);
  return {
    config: {
      allowHosts,
      allowPorts,
      allowLoopback: decl.hosts.some((h) => h.loopback),
    },
    plaintextNonLoopback: decl.hosts.filter((h) => !h.tls && !h.loopback),
  };
}
