// A deterministic stand-in for global fetch. No sockets, no timers beyond what a step asks for.
// Steps come either inline or from synthetic JSON fixtures under test/fixtures (never real data, never real keys).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface RecordedRequest {
  url: string;
  method: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  /** Parsed JSON body, or undefined when there was none. */
  body: any;
  redirect: string | undefined;
  hasSignal: boolean;
}

export type Step =
  | { status: number; headers?: Record<string, string>; json?: unknown; text?: string; delayMs?: number; cancelled?: { value: boolean } }
  | { hang: true }
  | { bodyHang: true; status?: number; headers?: Record<string, string> }
  | { endless: true; status?: number; headers?: Record<string, string>; cancelled?: { value: boolean } }
  | { throws: string };

export interface FixtureFile {
  description: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

export function loadFixture(relativePath: string): FixtureFile {
  const parsed = JSON.parse(readFileSync(`${FIXTURES_DIR}${relativePath}`, "utf8")) as FixtureFile;
  if (typeof parsed.status !== "number") throw new Error(`fixture ${relativePath} has no status`);
  return parsed;
}

/** A recorded response as a step. */
export function fromFixture(relativePath: string): Step {
  const f = loadFixture(relativePath);
  const step: { status: number; headers?: Record<string, string>; json?: unknown } = { status: f.status };
  if (f.headers) step.headers = f.headers;
  if (f.body !== undefined) step.json = f.body;
  return step;
}

export type StepSource = Step | Step[] | ((req: RecordedRequest, callNumber: number) => Step);

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

export function fixtureFetch(source: StepSource): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const req: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: headerRecord(init?.headers),
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      redirect: init?.redirect,
      hasSignal: init?.signal != null,
    };
    requests.push(req);
    const n = requests.length;
    const step: Step = typeof source === "function" ? source(req, n) : Array.isArray(source) ? source[Math.min(n - 1, source.length - 1)]! : source;
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortError();

    if ("throws" in step) throw new TypeError(`fetch failed: ${step.throws}`);
    if ("hang" in step) {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    }
    if ("bodyHang" in step) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(abortError()), { once: true });
        },
      });
      return new Response(body, { status: step.status ?? 200, headers: step.headers ?? { "content-type": "application/json" } });
    }
    if ("endless" in step) {
      const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(chunk); },
        cancel() { if (step.cancelled) step.cancelled.value = true; },
      });
      return new Response(body, { status: step.status ?? 200, headers: step.headers ?? { "content-type": "application/json" } });
    }
    if (step.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, step.delayMs);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
      });
    }
    const headers: Record<string, string> = { ...(step.headers ?? {}) };
    let payload: string | undefined;
    if (step.json !== undefined) { payload = JSON.stringify(step.json); headers["content-type"] ??= "application/json"; }
    else if (step.text !== undefined) payload = step.text;
    const noBody = step.status === 204 || step.status === 205 || step.status === 304;
    if (step.cancelled && payload !== undefined) {
      const bytes = new TextEncoder().encode(payload);
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(bytes); },
        cancel() { step.cancelled!.value = true; },
      });
      return new Response(body, { status: step.status, headers });
    }
    return new Response(noBody ? null : payload ?? "", { status: step.status, headers });
  }) as typeof fetch;
  return { fetch: fakeFetch, requests };
}
