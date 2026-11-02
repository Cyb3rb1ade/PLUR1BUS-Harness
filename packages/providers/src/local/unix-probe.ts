/** D122 AF1: one bounded health/models probe over the managed transport; it never offers cloud or custom models. */
import { isRecord, ProviderError } from "../errors.ts";
import { boundMs, parseModelList } from "./probe.ts";
import type { LocalModel } from "./types.ts";
import { APPLE_FM_BASE_URL, createUnixFetch } from "./unix.ts";
import type { ManagedUnixSocket, UnixFetchOptions, UnixRefusalReason } from "./unix.ts";

const PROBE_TIMEOUT_MS = 2000;
const MAX_REASON_CHARS = 200;

/** One deadline covers trust, both requests and both bodies. Cancellation from the caller still throws. */
export interface UnixProbeOptions extends UnixFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A usable adapter endpoint or a fixed unavailable reason; optional health detail is bounded to 200 chars. */
export interface UnixProbeResult {
  state: "ok" | "unavailable";
  baseUrl: string;
  socket: "managed:apple-fm";
  models: LocalModel[];
  reason?: UnixRefusalReason | "model-unavailable" | "timeout" | "unreachable" | "protocol";
  detail?: string;
}

class BadHealth extends Error {}

function systemHealth(value: unknown): { available: boolean; reason?: string } {
  if (!isRecord(value) || !Array.isArray(value["models"])) throw new BadHealth();
  const entries = value["models"].filter((entry): entry is Record<string, unknown> =>
    isRecord(entry) && entry["name"] === "system");
  const system = entries[0];
  if (entries.length !== 1 || !system || typeof system["available"] !== "boolean") throw new BadHealth();
  const reason = typeof system["reason"] === "string" ? system["reason"].slice(0, MAX_REASON_CHARS) : undefined;
  return { available: system["available"], ...(reason === undefined ? {} : { reason }) };
}

async function jsonText(fetch: typeof globalThis.fetch, url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal, redirect: "manual" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new BadHealth();
  }
  return response.text();
}

/**
 * Check system.available, then /v1/models under the same two-second default budget. Only system is returned;
 * pcc availability cannot make a provider usable. No egress policy, credentials or real fm command is involved.
 */
export async function probeUnixEndpoint(
  socket: ManagedUnixSocket, options: UnixProbeOptions,
): Promise<UnixProbeResult> {
  const base = { baseUrl: APPLE_FM_BASE_URL, socket: "managed:apple-fm" as const };
  const fail = (reason: NonNullable<UnixProbeResult["reason"]>, detail?: string): UnixProbeResult => ({
    ...base, state: "unavailable", models: [], reason, ...(detail === undefined ? {} : { detail }),
  });
  const timeout = AbortSignal.timeout(Math.ceil(boundMs(options.timeoutMs, PROBE_TIMEOUT_MS)));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const fetch = createUnixFetch(socket, options);
    const health: unknown = JSON.parse(await jsonText(fetch, "http://apple-fm.invalid/health", signal));
    const system = systemHealth(health);
    if (!system.available) return fail("model-unavailable", system.reason);
    const models = parseModelList("openai", await jsonText(fetch, `${APPLE_FM_BASE_URL}/models`, signal))
      .filter((model) => model.id === "system");
    if (models.length === 0) return fail("model-unavailable");
    return { ...base, state: "ok", models };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (timeout.aborted) return fail("timeout");
    if (error instanceof ProviderError) {
      for (const reason of ["platform", "socket-untrusted", "socket-path-too-long"] as const) {
        if (error.code === reason) return fail(reason);
      }
      if (error.kind === "network") return fail("unreachable");
    }
    return fail("protocol");
  }
}
