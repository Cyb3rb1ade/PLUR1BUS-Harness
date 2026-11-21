// W2. Record the production channel clients against local protocol peers.
import { fileURLToPath } from "node:url";
import { TelegramApi, TelegramApiError } from "../../packages/channels-telegram/src/api.ts";
import { startStub } from "../../packages/providers/test/helpers/stub.ts";
import { exporterMain } from "./lib.mjs";

const schema = "plur1bus.parity-wire/1";
const exporter = "scripts/parity/export-channels.ts";
const signal = new AbortController().signal;
const telegramMarker = "synthetic-telegram-marker";

type Response = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  chunks?: readonly string[];
};
type Exchange = {
  name: string;
  input: Record<string, unknown>;
  responses: Response[];
};

async function recordHttp<E extends Error & { kind: string; status?: number; retryAfterMs?: number; code?: string | number }>(
  { name, input, responses }: Exchange,
  run: (baseUrl: string) => Promise<unknown>,
  errorType: new (...args: never[]) => E,
  scrub: (s: string) => string,
) {
  let received = 0;
  const stub = await startStub((_request, reply) => {
    const response = responses[received++];
    if (!response) throw new Error("unexpected request");
    reply.writeHead(response.status, response.headers);
    if (response.chunks) for (const chunk of response.chunks) reply.write(chunk);
    else if (response.body !== undefined) reply.write(JSON.stringify(response.body));
    reply.end();
  });
  try {
    const normalize = (value: string) => scrub(value.replaceAll(stub.baseUrl, "<fixture-base>"));
    let expected;
    try {
      expected = { result: await run(stub.baseUrl) ?? null };
    } catch (error) {
      if (!(error instanceof errorType)) throw error;
      const { kind, status, retryAfterMs, code, message } = error;
      expected = { error: { kind, status, retryAfterMs, code, message: normalize(message) } };
    }
    if (received !== responses.length || stub.requests.length !== responses.length) {
      throw new Error(`${name}: recorded ${received} requests, expected ${responses.length}`);
    }
    return {
      name, input, expected,
      exchanges: stub.requests.map((request, index) => {
        const { chunks, ...response } = responses[index]!;
        if (response.body !== undefined) response.body = JSON.parse(normalize(JSON.stringify(response.body)));
        const headers = Object.fromEntries(["authorization", "content-type"].flatMap((key) => {
          const value = request.headers[key];
          return typeof value === "string" ? [[key, normalize(value)]] : [];
        }));
        return {
          request: { method: request.method, path: normalize(request.url ?? ""), headers, bodyText: normalize(request.body) },
          response: { ...response, ...(chunks ? { chunksBase64: chunks.map((chunk) => Buffer.from(normalize(chunk)).toString("base64")) } : {}) },
        };
      }),
    };
  } finally {
    await stub.close();
  }
}

async function telegram() {
  const sources = [
    { name: "updates-initial", input: { op: "updates", wait: 25 }, responses: [{ status: 200, body: { ok: true, result: [{ update_id: 8 }] } }] },
    { name: "updates-resume", input: { op: "updates", wait: 3, offset: 9 }, responses: [{ status: 200, body: { ok: true, result: [] } }] },
    { name: "send-message", input: { op: "send", extra: '{"parse_mode":"HTML","message_thread_id":7}', chat: "-1234", text: "Grüße 👋" },
      responses: [{ status: 200, body: { ok: true, result: { message_id: 30 } } }] },
    { name: "send-no-id", input: { op: "send", chat: "42", text: "hello" }, responses: [{ status: 200, body: { ok: true, result: {} } }] },
    { name: "retry-after-body", input: { op: "updates", wait: 0 }, responses: [{ status: 429, headers: { "retry-after": "60" }, body: { parameters: { retry_after: "1.2349" } } }] },
    { name: "retry-after-header", input: { op: "updates", wait: 0 }, responses: [{ status: 429, headers: { "retry-after": "99999" } }] },
    { name: "retry-after-floor", input: { op: "updates", wait: 0 }, responses: [{ status: 429, headers: { "retry-after": "0" } }] },
    { name: "error-redacts-token", input: { op: "updates", wait: 0 }, responses: [{ status: 401, body: { description: `denied ${telegramMarker}` } }] },
    { name: "conflict", input: { op: "updates", wait: 1 }, responses: [{ status: 409, body: { description: "another poll" } }] },
    { name: "download-limit", input: { op: "download", path: "documents/report.txt", limit: 5 },
      responses: [{ status: 200, headers: { "content-type": "TEXT/PLAIN; charset=utf-8" }, chunks: ["ab", "cdef"] }] },
    { name: "download-ok", input: { op: "download", path: "documents/report.txt", limit: 6 },
      responses: [{ status: 200, headers: { "content-type": "TEXT/PLAIN; charset=utf-8" }, chunks: ["ab", "cdef"] }] },
    { name: "download-redirect", input: { op: "download", path: "documents/report.txt", limit: 6 },
      responses: [{ status: 302, headers: { "location": "/unexpected" } }] },
    { name: "unsafe-path", input: { op: "download", path: "documents/../report.txt", limit: 6 }, responses: [] },
  ];
  const scenarios = [];
  for (const { name, input, responses } of sources) {
    scenarios.push(await recordHttp({ name, input, responses }, async (baseUrl) => {
      const api = new TelegramApi({ token: telegramMarker, baseUrl });
      if (input.op === "updates") return api.getUpdates(input.offset, input.wait!, signal);
      if (input.op === "send") return api.sendMessage(input.chat!, input.text!, signal, JSON.parse(input.extra ?? "{}"));
      const file = await api.download(input.path!, input.limit!, signal);
      return { mimeType: file.mimeType, data: Array.from(file.data) };
    }, TelegramApiError, (s) => s.replaceAll(telegramMarker, "[FIXTURE:TELEGRAM]")));
  }
  return { schema, exporter, source: "packages/channels-telegram/src/api.ts", transport: "http", scenarios };
}

export async function buildChannelFixtures(): Promise<Record<string, unknown>> {
  return { "telegram-api": await telegram() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "channels", build: buildChannelFixtures }));
}
