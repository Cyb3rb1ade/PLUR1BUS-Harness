// The one HTTP path every adapter goes through (G2): JSON POST with a per-attempt deadline that also covers the body,
// caller abort, no redirect following (a redirect with a credential is refused, never replayed), a hard cap on the
// response size and strict status-to-taxonomy mapping. Pure Node: global fetch, AbortController, web streams.
import { AdapterError, errorSummary, type AdapterErrorKind } from "./errors.ts";
import { redactSecrets, redactUrl } from "./redact.ts";

export interface PostJsonRequest {
  provider: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  body: unknown;
  /** Deadline for one attempt, request and body read together. */
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  /** Resolved secret values, scrubbed from every message this call produces. */
  secrets: readonly string[];
}

export interface HttpDeps {
  fetch: typeof fetch;
  now?: () => number;
}

const ERROR_BODY_LIMIT = 2048;
const SNIPPET_CHARS = 200;
const TOO_LARGE_HINT =
  /maximum context length|context length|too many tokens|token limit|too long|input\b.*\bexceed|exceeds? (?:the )?(?:maximum|max|limit)|too many (?:inputs|texts|documents)|batch size/i;

export function statusToKind(status: number, bodySnippet: string): AdapterErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "overloaded";
  if (status === 400 || status === 422) return TOO_LARGE_HINT.test(bodySnippet) ? "too_large" : "invalid_request";
  if (status >= 400) return "invalid_request";
  return "bad_response";
}

/** Retry-After in milliseconds from delta-seconds or an HTTP date; undefined for anything else. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(v)) {
    const ms = Math.round(Number(v) * 1000);
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (/^[-+]/.test(v) || /^\d/.test(v)) return undefined; // malformed number, not a date
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : undefined;
}

function retryAfterFrom(res: Response, nowMs: number): number | undefined {
  const std = parseRetryAfter(res.headers.get("retry-after"), nowMs);
  if (std !== undefined) return std;
  const ms = res.headers.get("retry-after-ms");
  if (ms !== null && /^\d+$/.test(ms.trim())) return Number(ms.trim());
  return undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

function buildHeaders(r: PostJsonRequest): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  for (const [name, value] of Object.entries(r.headers)) {
    if (/[\r\n\0]/.test(value) || /[\r\n\0:\s]/.test(name)) {
      throw new AdapterError("invalid_request", `header ${JSON.stringify(name.slice(0, 40))} contains a control character`, { provider: r.provider, secrets: r.secrets });
    }
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

async function readBounded(res: Response, limit: number, onOverflow: () => never): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      onOverflow();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** Up to ERROR_BODY_LIMIT bytes of an error body, for the message only. Never throws. */
async function readErrorSnippet(res: Response): Promise<string> {
  try {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    while (total < ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
  } catch {
    return "";
  }
}

export async function postJson(r: PostJsonRequest, deps: HttpDeps): Promise<unknown> {
  const ctx = { provider: r.provider, secrets: r.secrets };
  const headers = buildHeaders(r);
  if (r.signal?.aborted) throw new AdapterError("aborted", "request aborted by caller", ctx);

  const ctrl = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => ctrl.abort();
  r.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, r.timeoutMs);
  const interruption = (): AdapterError | undefined =>
    r.signal?.aborted ? new AdapterError("aborted", "request aborted by caller", ctx)
      : timedOut ? new AdapterError("timeout", `request to ${hostOf(r.url)} timed out after ${r.timeoutMs} ms`, ctx)
      : undefined;
  const nowMs = (deps.now ?? Date.now)();

  try {
    let res: Response;
    try {
      res = await deps.fetch(r.url, { method: "POST", headers, body: JSON.stringify(r.body), redirect: "manual", signal: ctrl.signal });
    } catch (e) {
      throw interruption() ?? new AdapterError("network", `request to ${hostOf(r.url)} failed: ${errorSummary(e, r.secrets)}`, ctx);
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      let target = "an unspecified location";
      if (location) {
        try { target = redactUrl(new URL(location, r.url).toString()); } catch { target = redactSecrets(location, r.secrets).slice(0, 120); }
      }
      throw new AdapterError("bad_response", `refused redirect (HTTP ${res.status}) to ${target}; credentials are never sent to a redirect target`, { ...ctx, status: res.status });
    }

    if (res.status < 200 || res.status >= 300) {
      const snippet = await readErrorSnippet(res);
      const retryAfterMs = retryAfterFrom(res, nowMs);
      throw new AdapterError(statusToKind(res.status, snippet), `HTTP ${res.status} from ${r.provider}${snippet ? `: ${snippet}` : ""}`, {
        ...ctx,
        status: res.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }

    const overflow = (): never => {
      throw new AdapterError("bad_response", `response from ${r.provider} is too large (limit ${r.maxResponseBytes} bytes)`, { ...ctx, status: res.status });
    };
    const declared = res.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > r.maxResponseBytes) {
      await res.body?.cancel().catch(() => undefined);
      overflow();
    }
    const bytes = await readBounded(res, r.maxResponseBytes, overflow);
    if (bytes.byteLength === 0) throw new AdapterError("bad_response", `empty response body from ${r.provider} (HTTP ${res.status})`, { ...ctx, status: res.status });
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes)) as unknown;
    } catch {
      throw new AdapterError("bad_response", `response from ${r.provider} is not valid JSON`, { ...ctx, status: res.status });
    }
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    throw interruption() ?? new AdapterError("network", `reading the response from ${hostOf(r.url)} failed: ${errorSummary(e, r.secrets)}`, ctx);
  } finally {
    clearTimeout(timer);
    r.signal?.removeEventListener("abort", onCallerAbort);
  }
}
