// "Nur lokal" (owner decision 2026-10-18): when privacy.localOnly is on, no model or inference call leaves this machine.
// One place decides what counts as local, so every provider selection (chat and role models, compaction summaries,
// embedding, reranker, engine LLM features, voice, captioning, media generation, discovery) answers the same way.
// Local is loopback (localhost, 127.0.0.0/8, ::1) or an exact origin the owner listed in privacy.localEndpoints (a
// self-hosted Ollama/vLLM server in the home network). A LAN address is never local by itself. A refused provider is
// never replaced by another model: the caller gets E_DENIED reason local-only with a hint to the switch.
// Web tools (web.fetch, web.search) are not model calls and are not governed here; egress governs them.
import type { HarnessConfig } from "@plur1bus/config-schema";
import { RpcError } from "../rpc/errors.ts";

export const LOCAL_ONLY_REASON = "local-only";
export const LOCAL_ONLY_HINT = "privacy.localOnly is on (Settings > Privacy): only local models may be used; turn the switch off, choose a local model, or list your own model server in privacy.localEndpoints";

type PrivacyView = { privacy?: { localOnly?: unknown; localEndpoints?: unknown }; agents?: Record<string, { privacy?: { localOnly?: unknown } } | undefined> };
const view = (cfg: unknown): PrivacyView => (cfg && typeof cfg === "object" ? cfg as PrivacyView : {});

/** The installation-wide switch. */
export function localOnlyInstallation(cfg: Pick<HarnessConfig, "privacy"> | unknown): boolean {
  return view(cfg).privacy?.localOnly === true;
}

/**
 * Effective switch for one agent: its own `agents.<id>.privacy.localOnly` overrides the installation value in both
 * directions; unset, it inherits. Without an agent (an installation-level call) only the installation value counts.
 */
export function localOnlyFor(cfg: unknown, agentId?: string): boolean {
  const v = view(cfg);
  const own = agentId === undefined ? undefined : v.agents?.[agentId]?.privacy?.localOnly;
  return typeof own === "boolean" ? own : v.privacy?.localOnly === true;
}

/**
 * For the shared services every agent writes into (memory engine, media index): local-only while the installation is,
 * or while any agent is. An agent that lifts the switch for itself never opens a shared store to a cloud model.
 */
export function localOnlyShared(cfg: unknown): boolean {
  const v = view(cfg);
  if (v.privacy?.localOnly === true) return true;
  return Object.values(v.agents ?? {}).some((a) => a?.privacy?.localOnly === true);
}

export function localEndpoints(cfg: unknown): readonly string[] {
  const list = view(cfg).privacy?.localEndpoints;
  return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string") : [];
}

function parse(raw: string | URL): URL | null {
  if (raw instanceof URL) return raw;
  try { return new URL(raw); } catch { return null; }
}

/** Loopback by spelling: `localhost`, an IPv4 literal in 127.0.0.0/8, or `::1`. A name is never resolved here. */
export function isLoopbackEndpoint(raw: string | URL): boolean {
  const url = parse(raw);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m !== null && m.slice(1).every((n) => Number(n) <= 255) && m[1] === "127";
}

/** Loopback, or the exact origin of one entry in `privacy.localEndpoints`. A malformed entry never matches. */
export function isLocalEndpoint(raw: string | URL, listed: readonly string[] = []): boolean {
  const url = parse(raw);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return false;
  if (isLoopbackEndpoint(url)) return true;
  return listed.some((entry) => { const e = parse(entry); return e !== null && e.origin === url.origin; });
}

/** The refusal every enforcement point throws: E_DENIED, reason local-only, never a substitute model. */
export function localOnlyDenied(what: string, endpoint?: string): RpcError {
  return new RpcError("E_DENIED", `${what} is not a local model${endpoint ? ` (${redactEndpoint(endpoint)})` : ""}; ${LOCAL_ONLY_HINT}`, { reason: LOCAL_ONLY_REASON });
}

/** Origin only: a path or query of a configured endpoint never reaches an error message. */
export function redactEndpoint(raw: string): string {
  const url = parse(raw);
  return url ? `${url.protocol}//${url.host}` : "an invalid endpoint";
}

/** Throws the local-only refusal when the switch is on and `endpoint` is not local; `endpoint` undefined means a cloud default. */
export function assertLocalEndpoint(o: { active: boolean; what: string; endpoint: string | undefined; listed: readonly string[] }): void {
  if (!o.active) return;
  if (o.endpoint !== undefined && isLocalEndpoint(o.endpoint, o.listed)) return;
  throw localOnlyDenied(o.what, o.endpoint);
}
