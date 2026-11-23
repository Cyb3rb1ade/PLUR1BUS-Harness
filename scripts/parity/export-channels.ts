// W2. Record the production channel clients against local protocol peers.
import { fileURLToPath } from "node:url";
import { DiscordApi, DiscordApiError, type RequestSpec } from "../../packages/channels-discord/src/api.ts";
import { SlackApi, SlackApiError } from "../../packages/channels-slack/src/api.ts";
import { TelegramApi, TelegramApiError } from "../../packages/channels-telegram/src/api.ts";
import { startStub } from "../../packages/providers/test/helpers/stub.ts";
import { discordAdmission, slackAdmission, telegramAdmission } from "./channel-admission.ts";
import { buzzRelay } from "./channel-buzz.ts";
import { imap, mime, smtp } from "./channel-email.ts";
import { telegramWebhook } from "./channel-telegram.ts";
import { signalRpc } from "./channel-signal.ts";
import { discordGateway, slackSocket } from "./channel-sockets.ts";
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

async function discord() {
  const token = "synthetic-discord-marker";
  const tokenRoute = "synthetic-discord-interaction-marker";
  const path = "/channels/123456/messages/654321";
  const sources = [
    { name: "message", input: { method: "PATCH", path, json: '{"content":"Grüße 👋","flags":4,"allowed_mentions":{"parse":[]}}' },
      responses: [{ status: 200, body: { id: "654321", content: "Grüße 👋" } }] },
    { name: "token-route", input: { method: "POST", path: "/interactions/123456/[FIXTURE:INTERACTION]/callback", tokenRoute: true, json: '{"type":5}' },
      responses: [{ status: 204 }] },
    { name: "bad-json", input: { method: "GET", path }, responses: [{ status: 200, chunks: ["["] }] },
    { name: "permission", input: { method: "GET", path }, responses: [{ status: 403,
      body: { code: 50013, message: `permission denied for Bot ${token}` } }] },
    { name: "rate-limited", input: { method: "GET", path }, responses: [{ status: 429, headers: { "retry-after": "0" } }] },
    { name: "retry-limits", input: { method: "GET", path, retries: 2 }, responses: [
      { status: 429, headers: { "x-ratelimit-global": "true" }, body: { retry_after: 1.2345, global: true } },
      { status: 503 }, { status: 200, body: { id: "654321" } },
    ] },
    { name: "manual-redirect", input: { method: "GET", path },
      responses: [{ status: 302, headers: { "location": "/unused-location" } }] },
  ] satisfies Array<Exchange & { input: { method: RequestSpec["method"]; path: string; json?: string; retries?: number; tokenRoute?: boolean } }>;
  const scenarios = [];
  for (const { name, input, responses } of sources) {
    const waits: number[] = [];
    let now = 100_000;
    const scrub = (s: string) => s.replaceAll(token, "[FIXTURE:DISCORD]").replaceAll(tokenRoute, "[FIXTURE:INTERACTION]");
    const recorded = await recordHttp({ name, input, responses }, async (baseUrl) => {
      const api = new DiscordApi({
        baseUrl, token, now: () => now, random: () => 0.5, maxRetries: input.retries ?? 0,
        sleep: async (ms) => { waits.push(ms); now += ms; },
      });
      return api.request({
        method: input.method, path: input.path.replace("[FIXTURE:INTERACTION]", tokenRoute),
        json: input.json ? JSON.parse(input.json) : undefined, signal, tokenRoute: input.tokenRoute,
      });
    }, DiscordApiError, scrub);
    scenarios.push({ ...recorded, waits });
  }
  return { schema, exporter, source: "packages/channels-discord/src/api.ts", transport: "http", scenarios };
}

async function slack() {
  const bot = "synthetic-slack-marker";
  const app = "synthetic-slack-app-marker";
  const first = "/private/first";
  const last = "/private/last";
  const sources = [
    { name: "open", input: { op: "open" }, responses: [{ status: 200, body: { ok: true, url: "wss://fixture.invalid/socket" } }] },
    { name: "call", input: { op: "call", method: "chat.postMessage", json: '{"channel":"C123","text":"Grüße 👋","unfurl_links":false}' },
      responses: [{ status: 200, body: { ok: true, ts: "1.23" } }] },
    { name: "upload-ticket", input: { op: "form", method: "files.getUploadURLExternal", json: '{"filename":"a b+ü.txt","length":12}' },
      responses: [{ status: 200, body: { ok: true, file_id: "F123" } }] },
    { name: "invalid-auth", input: { op: "call", method: "auth.test" }, responses: [{ status: 200, body: { ok: false, error: "invalid_auth" } }] },
    { name: "invalid-scope", input: { op: "call", method: "auth.test" }, responses: [{ status: 200, body: { ok: false, error: "missing_scope" } }] },
    { name: "bad-code", input: { op: "call", method: "auth.test" }, responses: [{ status: 400, body: { ok: false, error: "untrusted mixed case" } }] },
    { name: "limit", input: { op: "call", method: "auth.test" }, responses: [{ status: 200, headers: { "retry-after": "1.2349" }, body: { ok: false, error: "ratelimited" } }] },
    { name: "download-hop", input: { op: "download", path: first, limit: 6 }, responses: [
      { status: 302, headers: { location: last } },
      { status: 200, headers: { "content-type": "TEXT/PLAIN; charset=utf-8" }, chunks: ["ab", "cdef"] },
    ] },
    { name: "download-foreign", input: { op: "download", path: first, limit: 6 },
      responses: [{ status: 302, headers: { location: "https://fixture.invalid/file" } }] },
    { name: "download-sign-in", input: { op: "download", path: first, limit: 6 },
      responses: [{ status: 200, headers: { "content-type": "text/html" }, chunks: ["<form>"] }] },
    { name: "download-cap", input: { op: "download", path: first, limit: 5 },
      responses: [{ status: 200, headers: { "content-type": "text/plain" }, chunks: ["ab", "cdef"] }] },
    { name: "upload-bytes", input: { op: "bytes", path: last, text: "file content 👋" }, responses: [{ status: 200 }] },
  ];
  const scenarios = [];
  for (const { name, input, responses } of sources) {
    scenarios.push(await recordHttp({ name, input, responses }, async (baseUrl) => {
      const api = new SlackApi({ baseUrl, botToken: bot, appToken: app });
      if (input.op === "open") return api.openSocketUrl(signal);
      if (input.op === "call" || input.op === "form") return api.call(
        input.method!, JSON.parse(input.json ?? "{}"), signal, { form: input.op === "form" },
      );
      const target = new URL(input.path!, baseUrl).href;
      if (input.op === "bytes") return api.uploadBytes(target, Buffer.from(input.text!), signal);
      const file = await api.download(target, input.limit!, signal);
      return { mimeType: file.mimeType, data: Array.from(file.data) };
    }, SlackApiError, (s) => s.replaceAll(app, "[FIXTURE:SLACK_APP]").replaceAll(bot, "[FIXTURE:SLACK_BOT]")));
  }
  return { schema, exporter, source: "packages/channels-slack/src/api.ts", transport: "http", scenarios };
}

export async function buildChannelFixtures(): Promise<Record<string, unknown>> {
  return {
    "telegram-api": await telegram(), "discord-api": await discord(), "slack-api": await slack(),
    "channel-admission": {
      schema, exporter, source: "packages/channels-{discord,slack,telegram}/src/channel.ts",
      discord: await discordAdmission(), slack: await slackAdmission(), telegram: await telegramAdmission(),
    },
    "discord-identify": { schema, exporter, ...await discordGateway(false) },
    "discord-resume": { schema, exporter, ...await discordGateway(true) },
    "slack-socket": { schema, exporter, ...await slackSocket() },
    "signal-rpc": { schema, exporter, ...await signalRpc(false) },
    "signal-oversize": { schema, exporter, ...await signalRpc(true) },
    "smtp-send": { schema, exporter, ...await smtp(true) },
    "smtp-deferred": { schema, exporter, ...await smtp(true, true) },
    "smtp-no-starttls": { schema, exporter, ...await smtp(false) },
    "imap-fetch": { schema, exporter, ...await imap(true) },
    "imap-no-starttls": { schema, exporter, ...await imap(false) },
    "email-mime": { exporter, ...mime() },
    "buzz-relay": { schema, exporter, ...await buzzRelay() },
    "telegram-webhook": { exporter, ...await telegramWebhook() },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "channels", build: buildChannelFixtures }));
}
