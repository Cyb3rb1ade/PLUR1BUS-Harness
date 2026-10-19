import { isModelArtifactRequest } from "./egress/model-downloads.ts";
import type { HostFetch, SecretStore as EngineSecrets } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { Egress } from "./egress/service.ts";
import type { SecretStore } from "./secrets/store.ts";
import type { HttpMethod } from "./tools/web/http.ts";

const REQUEST_CAP = 20 * 1024 * 1024;
// ONNX artifacts can exceed a gigabyte. They stay streamed and bounded; the engine also checks pinned artifact sizes.
const RESPONSE_CAP = 2 * 1024 * 1024 * 1024;

export interface EnginePortFailure { errorClass: "egress" | "key" | "download" | "provider"; code: string; host?: string }
export interface EnginePortOptions { onFailure?: (failure: EnginePortFailure) => void }
function observed(o: EnginePortOptions, failure: EnginePortFailure): void { try { o.onFailure?.(failure); } catch { /* diagnostics never change the operation */ } }

/** WHATWG surface over the harness's pinned-IP transport; no global-fetch fallback. */
export function createEngineFetch(egress: Pick<Egress, "request">, options: EnginePortOptions = {}): HostFetch {
  return async (input, init) => {
    const request = new Request(input, init);
    // Include request-body buffering in the deadline, not just the socket and response.
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]);
    let body: Uint8Array | undefined;
    if (request.body) {
      const reader = request.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      const abortBody = () => { void reader.cancel(signal.reason).catch(() => {}); };
      signal.addEventListener("abort", abortBody, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          size += next.value.length;
          if (size > REQUEST_CAP) throw new RangeError("engine HTTP request body exceeds 20 MiB");
          chunks.push(next.value);
        }
        body = Buffer.concat(chunks, size);
      } finally { signal.removeEventListener("abort", abortBody); await reader.cancel(); reader.releaseLock(); }
    }
    const headersIn: Record<string, string> = {};
    request.headers.forEach((value, name) => { headersIn[name] = value; });
    const modelDownload = isModelArtifactRequest(request);
    let result;
    try { result = await egress.request(request.url, {
      method: request.method as HttpMethod, headers: headersIn, ...(body ? { body } : {}),
      signal, redirect: request.redirect, userAgent: "PLUR1BUS/engine", accept: "*/*",
      streamResponse: true, modelDownload, safeRedirectHeaders: true, maxBytes: RESPONSE_CAP, maxRequestBytes: REQUEST_CAP, timeoutMs: 300_000,
    }); } catch (cause) {
      const code = (cause as { code?: string })?.code;
      const safeCode = ["egress-denied", "private-address", "timeout", "too-large", "tls-error", "not-found", "invalid-url", "network-error"].includes(code ?? "") ? code! : "provider-failed";
      const deniedHost = (cause as { host?: unknown })?.host;
      const host = typeof deniedHost === "string" && /^[A-Za-z0-9.[\]:-]{1,253}$/.test(deniedHost) ? deniedHost : new URL(request.url).hostname;
      const failure: EnginePortFailure = { errorClass: ["egress-denied", "private-address"].includes(safeCode) ? "egress" : modelDownload ? "download" : "provider", code: safeCode, host };
      observed(options, failure);
      throw Object.assign(new Error(`engine HTTP ${failure.errorClass} failure (${safeCode}) for ${failure.host}; check egress.modelDownloads for model files and egress.allowHosts for providers`, { cause }), failure);
    }
    if (result.status >= 400) observed(options, { errorClass: modelDownload ? "download" : [401, 403].includes(result.status) ? "key" : "provider", code: `http-${result.status}`, host: new URL(request.url).hostname });
    // The transport decodes content-encoding; forwarding the original length/encoding would describe different bytes.
    const headers = new Headers();
    for (const [name, value] of Object.entries(result.headers)) {
      if (value === undefined || name === "content-encoding" || name === "content-length" || name === "transfer-encoding") continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
    const empty = request.method === "HEAD" || [204, 205, 304].includes(result.status);
    const response = new Response(empty ? null : result.stream ?? new Uint8Array(result.body), { status: result.status, headers });
    Object.defineProperties(response, { url: { value: result.url }, redirected: { value: result.redirects.length > 0 } });
    return response;
  };
}

/** Resolve using a fresh audited core lease. The engine owns its bounded in-memory credential cache. */
export function createEngineSecrets(store: SecretStore, options: EnginePortOptions = {}): EngineSecrets {
  return {
    async resolve(ref, purpose) {
      const principal = { kind: "core" } as const;
      try {
        const lease = await store.lease(principal, ref, { purpose, profileId: "memory-engine", ttlMs: 5000 });
        try { return lease.value; } finally { store.revokeLease(principal, lease.leaseId); }
      } catch (cause) {
        const failure: EnginePortFailure = { errorClass: "key", code: "secret-unresolved" };
        observed(options, failure);
        throw Object.assign(new Error("engine provider secret could not be resolved", { cause }), failure);
      }
    },
  };
}
