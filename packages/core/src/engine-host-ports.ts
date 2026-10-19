import type { HostFetch, SecretStore as EngineSecrets } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { Egress } from "./egress/service.ts";
import type { SecretStore } from "./secrets/store.ts";
import type { HttpMethod } from "./tools/web/http.ts";

const REQUEST_CAP = 20 * 1024 * 1024;
// ONNX artifacts can exceed a gigabyte. They stay streamed and bounded; the engine also checks pinned artifact sizes.
const RESPONSE_CAP = 2 * 1024 * 1024 * 1024;

/** WHATWG surface over the harness's pinned-IP transport; no global-fetch fallback. */
export function createEngineFetch(egress: Pick<Egress, "request">): HostFetch {
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
    const result = await egress.request(request.url, {
      method: request.method as HttpMethod, headers: headersIn, ...(body ? { body } : {}),
      signal, redirect: request.redirect, userAgent: "PLUR1BUS/engine", accept: "*/*",
      streamResponse: true, maxBytes: RESPONSE_CAP, maxRequestBytes: REQUEST_CAP, timeoutMs: 300_000,
    });
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
export function createEngineSecrets(store: SecretStore): EngineSecrets {
  return {
    async resolve(ref, purpose) {
      const principal = { kind: "core" } as const;
      const lease = await store.lease(principal, ref, { purpose, profileId: "memory-engine", ttlMs: 5000 });
      try { return lease.value; } finally { store.revokeLease(principal, lease.leaseId); }
    },
  };
}
