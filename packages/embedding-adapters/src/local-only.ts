// privacy.localOnly for the adapters (audit C15, owner decision 2026-10-18 "Nur lokal"). This package never reads the
// harness configuration; the integration injects the switch as a function, which is read on every decision so a switch
// turned on after an adapter was built still stops it before any request. Fail-closed: a switch that throws or answers
// anything but `false` counts as on, and an endpoint that cannot be parsed is not local.
import type { LocalOnlyPolicy } from "./types.ts";

function isLoopbackHost(hostname: string): boolean {
  const h = (hostname.startsWith("[") ? hostname.slice(1, -1) : hostname).replace(/\.$/, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function parse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function switchedOn(policy: LocalOnlyPolicy): boolean {
  try {
    return policy.localOnly() !== false;
  } catch {
    return true;
  }
}

function listedOrigins(policy: LocalOnlyPolicy): readonly string[] {
  try {
    const list = policy.localEndpoints?.();
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

/** Loopback by spelling (a name is never resolved), or the exact origin of one entry of `localEndpoints`. A LAN address is not local by itself. */
function isLocalEndpoint(baseURL: string, listed: readonly string[]): boolean {
  const url = parse(baseURL);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") return false;
  if (isLoopbackHost(url.hostname)) return true;
  return listed.some((entry) => parse(entry)?.origin === url.origin);
}

/** Why `baseURL` may not be used right now, or undefined when it may. Origin only: a path never reaches a message. */
export function localOnlyDenial(policy: LocalOnlyPolicy | undefined, baseURL: string): string | undefined {
  if (policy === undefined || !switchedOn(policy)) return undefined;
  if (isLocalEndpoint(baseURL, listedOrigins(policy))) return undefined;
  const origin = parse(baseURL)?.origin ?? "an invalid endpoint";
  return `privacy.localOnly is on and ${origin} is not a local endpoint (loopback or listed in privacy.localEndpoints); no request is sent and no other model is used`;
}
