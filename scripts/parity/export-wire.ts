// Parity mode W (wire): HTTP and WebSocket exchanges of the TypeScript fake servers, recorded into fixtures that the Rust
// fake server (`crates/plur1bus-wire-fixtures`) serves, so Rust tests never need Node (P4-03). Recorded, never
// edited by hand.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-wire.ts [--check]
//
// `openai-sse`: the real chat completions adapter against the provider tests' loopback SSE stub.
// `openai-http`: `FakeOpenAI` (packages/core/test/fixtures/openai/server.ts), driven through its in-process `HttpPort`.
// `voice-ws`: `localVoiceSocket` (packages/core/test/voice/local-socket.ts), driven over a real loopback WebSocket, plus its
// answer to an upgrade with a fixed key (`handshake`), so the Rust server's Sec-WebSocket-Accept is checked against Node's.
// Secrets are redacted the way the P4-02 transcript recorder does it: every value under a secret-looking key, and every
// value the fake minted as a secret, becomes `[REDACTED:secret]`. Only exchanges whose bytes are deterministic are recorded.
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";
import { FakeOpenAI } from "../../packages/core/test/fixtures/openai/server.ts";
import { localVoiceSocket } from "../../packages/core/test/voice/local-socket.ts";

import { createChatCompletionsAdapter } from "../../packages/providers/src/index.ts";
import { basicRequest, startStub, writeAll } from "../../packages/providers/test/helpers/stub.ts";

const SCHEMA = "plur1bus.parity-wire/1";
const REDACTED = "[REDACTED:secret]";
const SECRET_KEY = /token|secret|password|passphrase|api[-_]?key|authorization|cookie|ticket|credential|private[-_]?key|pin$/i;

/** Copies `value` with secret-looking keys and minted secrets replaced. */
function redact(value: unknown, minted: ReadonlySet<string>, key = ""): unknown {
  if (typeof value === "string") return SECRET_KEY.test(key) || minted.has(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((v) => redact(v, minted, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? REDACTED : redact(v, minted, k)]));
  return value;
}

interface HttpCase { name: string; method: "GET" | "POST"; path: string; json?: Record<string, unknown>; form?: Record<string, string>; rateLimited?: string }
const httpCases: HttpCase[] = [
  { name: "discovery", method: "GET", path: "/.well-known/openid-configuration" },
  { name: "models", method: "GET", path: "/v1/models" },
  { name: "models-wrong-method", method: "POST", path: "/v1/models" },
  { name: "responses", method: "POST", path: "/v1/responses", json: { model: "fixture-model", input: "hello" } },
  { name: "responses-rate-limited", method: "POST", path: "/v1/responses", json: { model: "fixture-model", input: "hello" }, rateLimited: "rate_limit_exceeded" },
  { name: "refresh-unknown-grant", method: "POST", path: "/token", form: { grant_type: "refresh_token", refresh_token: "never-issued" } },
  { name: "revoke", method: "POST", path: "/revoke", form: { token_type_hint: "refresh_token" } },
  { name: "unknown-path", method: "GET", path: "/v1/no-such-endpoint" },
];

async function recordHttp(): Promise<Record<string, unknown>> {
  const exchanges = [];
  for (const c of httpCases) {
    const fake = new FakeOpenAI();
    if (c.rateLimited) fake.errorCode = c.rateLimited;
    const response = await fake.request({ method: c.method, url: fake.issuer + c.path, ...(c.json ? { json: c.json } : {}), ...(c.form ? { form: c.form } : {}) });
    const minted = new Set(fake.secrets);
    exchanges.push({
      name: c.name,
      request: redact({ method: c.method, path: c.path, ...(c.json ? { json: c.json } : {}), ...(c.form ? { form: c.form } : {}) }, minted),
      response: redact({ status: response.status, body: response.body }, minted),
    });
  }
  return { schema: SCHEMA, source: "packages/core/test/fixtures/openai/server.ts#FakeOpenAI", exporter: "scripts/parity/export-wire.ts", transport: "http", exchanges };
}

async function recordSse(): Promise<Record<string, unknown>> {
  const source = "packages/providers/test/fixtures/stream-tool-call.sse";
  const body = Buffer.from(readFileSync(new URL(`../../${source}`, import.meta.url), "utf8").replaceAll("\r\n", "\n"));
  const utf8Start = body.indexOf(Buffer.from("ü"));
  if (utf8Start < 4) throw new Error("SSE test input must contain the split UTF-8 character");
  // The cuts are between bytes of the SSE field name and of a UTF-8 character.
  const chunks = [body.subarray(0, 3), body.subarray(3, utf8Start + 1), body.subarray(utf8Start + 1)];
  const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" };
  const written: string[] = [];
  const stub = await startStub(async (_request, response) => {
    response.writeHead(200, headers);
    await writeAll(response, chunks);
    written.push(...chunks.map((chunk) => chunk.toString("base64")));
    response.end();
  });
  try {
    const adapter = createChatCompletionsAdapter({
      baseUrl: stub.baseUrl,
      credentials: { authorization: () => undefined },
    });
    const events = [];
    for await (const event of adapter.stream(basicRequest)) events.push(event);
    const sent = stub.requests[0];
    if (!sent || stub.requests.length !== 1 || events.at(-1)?.type !== "done" || written.length !== chunks.length) {
      throw new Error("chat-completions SSE recording did not finish");
    }
    return {
      schema: SCHEMA,
      source,
      exporter: "scripts/parity/export-wire.ts",
      transport: "http",
      exchanges: [{
        name: "chat-completions-stream",
        request: {
          method: sent.method, path: sent.url, bodyText: sent.body,
          headers: { "content-type": sent.headers["content-type"], accept: sent.headers.accept },
        },
        response: {
          status: 200,
          headers,
          chunksBase64: written,
        },
      }],
    };
  } finally {
    await stub.close();
  }
}

const wsSteps: Array<{ name: string; send: Record<string, unknown> }> = [
  { name: "start", send: { type: "session.start", model: "fixture-voice" } },
  { name: "audio", send: { type: "session.input_audio.append", audio: Buffer.from([1, 2]).toString("base64") } },
  { name: "close", send: { type: "session.close" } },
];

/** The fake's answer to an upgrade with a fixed `Sec-WebSocket-Key` (16 fixed bytes), read off a raw loopback socket: the
 *  `Sec-WebSocket-Accept` it computes with node:crypto, which the Rust side checks its own computation against. */
async function recordHandshake(url: string): Promise<{ key: string; accept: string }> {
  const key = Buffer.from("p4a-wire-fixture").toString("base64");
  const { port } = new URL(url);
  const head = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) }, () => {
      socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let text = "";
    socket.on("data", (chunk) => { text += chunk.toString("latin1"); if (text.includes("\r\n\r\n")) { socket.destroy(); resolve(text); } });
    socket.on("error", reject);
  });
  const accept = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(head)?.[1];
  if (!head.startsWith("HTTP/1.1 101") || !accept) throw new Error(`unexpected upgrade answer: ${head.split("\r\n")[0]}`);
  return { key, accept };
}

/** Sends each step as one text frame over a loopback WebSocket and records the frames the fake answers with. */
async function recordWs(serverFirst = false): Promise<Record<string, unknown>> {
  const server = await localVoiceSocket();
  const handshake = await recordHandshake(server.url);
  const socket = new WebSocket(server.url);
  const inbox: unknown[] = [];
  let wake: (() => void) | undefined;
  socket.addEventListener("message", (event) => { inbox.push(JSON.parse(String(event.data))); wake?.(); });
  const exchanges = [];
  async function receive() {
    // Each step of this fake answers with exactly one frame.
    while (inbox.length === 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve, reject) => {
        wake = resolve;
        timer = setTimeout(() => reject(new Error("no answer from the voice recording fixture")), 5000);
      }).finally(() => { clearTimeout(timer); wake = undefined; });
    }
    return inbox.splice(0);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
    });
    if (serverFirst) {
      server.usage(2);
      exchanges.push({ name: "unsolicited-usage", send: [], receive: await receive() });
    }
    for (const step of wsSteps) {
      socket.send(JSON.stringify(step.send));
      exchanges.push({ name: step.name, send: [step.send], receive: await receive() });
    }
  } finally {
    socket.close();
    await server.close();
  }
  return { schema: SCHEMA, source: "packages/core/test/voice/local-socket.ts#localVoiceSocket", exporter: "scripts/parity/export-wire.ts", transport: "websocket", handshake, exchanges };
}

export async function buildWireFixtures(): Promise<Record<string, unknown>> {
  return {
    "openai-http": await recordHttp(),
    "openai-sse": await recordSse(),
    "voice-ws": await recordWs(),
    "voice-ws-server-first": await recordWs(true),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "wire", build: buildWireFixtures }));
}
