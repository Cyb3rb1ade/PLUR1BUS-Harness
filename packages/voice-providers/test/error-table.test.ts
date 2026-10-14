// Adapter error table (channels-voice-providers, step 6): the same simulated responses run through every adapter the
// registry (`createVoiceProviders`) hands out, one test per cell. A cell checks the unified error code, `retryable`,
// `retryAfterMs`, and that no secret reaches the error text. Source of truth: docs/errors.md ("Voice provider error
// codes") and docs/voice-providers.md. A cell the docs do not pin is pinned to the current behaviour and carries
// `documented: false`; a cell where the code breaks a documented rule is a `todo` KNOWN GAP.
//
// No network and no real sleep: a loopback HTTP/WebSocket server answers, `sleep` is injected through the registry deps and
// Polly runs on a fake SDK client. The secret is a marker, never a token-shaped literal.
//
// Set ERROR_TABLE_OUT=<file> to write the observed matrix as a markdown table (used for docs/voice-providers.md).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { after, test } from "node:test";
import { inspect } from "node:util";
import { VOICE_ERROR_CODES, isVoiceProviderError, type VoiceErrorCode } from "../src/errors.ts";
import type { PollyClientLike } from "../src/providers/polly.ts";
import { CLOUD_PROVIDER_IDS, createVoiceProviders, type VoiceRegistry } from "../src/registry.ts";

const MARKER = "MARKER_SECRET_ONE";
const VENDOR_TEXT = "VENDOR_FREE_TEXT_ONE";
const RETRIES = 2;
const getSecret = async (name: string): Promise<string | undefined> => (name === "voice.key" ? MARKER : undefined);

// ---- the simulated responses (columns) ----

type SimId = "401" | "403" | "404" | "408" | "413" | "429+RA" | "429" | "500" | "503" | "truncated-json" | "invalid-json" | "abort";
interface Sim { id: SimId; status?: number; headers?: Record<string, string> }
const SIMS: readonly Sim[] = [
  { id: "401", status: 401 },
  { id: "403", status: 403 },
  { id: "404", status: 404 },
  { id: "408", status: 408 },
  { id: "413", status: 413 },
  { id: "429+RA", status: 429, headers: { "retry-after": "7" } },
  { id: "429", status: 429 },
  { id: "500", status: 500 },
  { id: "503", status: 503 },
  { id: "truncated-json" },
  { id: "invalid-json" },
  { id: "abort" },
];
const STATUS_SIMS = SIMS.filter((s) => s.status !== undefined);
const TRUNCATED_JSON = '{"voices":[{"voice_id":"v1","na';
const INVALID_JSON = "<html>this is not json</html>";

// ---- loopback fake vendor: HTTP responses and WebSocket upgrade refusals, one scenario at a time ----

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function textFrame(text: string): Buffer {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 0xff]);
  return Buffer.concat([head, p]);
}
const lines = (h: Record<string, string> | undefined): string => Object.entries(h ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join("");

interface SimServer {
  url: string;
  counters: { http: number; upgrade: number };
  set(sim: Sim, greeting: readonly unknown[]): void;
  close(): Promise<void>;
}

async function startSimServer(): Promise<SimServer> {
  let current: Sim = SIMS[0]!;
  let greeting: readonly unknown[] = [];
  const counters = { http: 0, upgrade: 0 };
  const sockets = new Set<Duplex>();
  // The vendor echoes the credential it received, as a careless one would: this is what the redaction has to survive.
  const echo = (h: Record<string, string | string[] | undefined>): string => String(h["xi-api-key"] ?? h["authorization"] ?? h["x-goog-api-key"] ?? "");
  const errorBody = (h: Record<string, string | string[] | undefined>): string => JSON.stringify({ detail: `${VENDOR_TEXT} rejected ${echo(h)}` });

  const server = createServer((req, res) => {
    counters.http++;
    req.resume();
    req.on("end", () => {
      const sim = current;
      if (sim.status !== undefined) {
        res.writeHead(sim.status, { "content-type": "application/json", ...sim.headers });
        res.end(errorBody(req.headers));
      } else if (sim.id === "truncated-json" || sim.id === "invalid-json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(sim.id === "truncated-json" ? TRUNCATED_JSON : INVALID_JSON);
      } else {
        // abort: promise 4800 bytes, deliver 480, then end the connection.
        res.writeHead(200, { "content-type": "audio/pcm", "content-length": "4800" });
        res.write(Buffer.alloc(480, 1), () => { res.socket?.end(); });
      }
    });
  });
  server.on("upgrade", (req, sock: Duplex) => {
    counters.upgrade++;
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    const sim = current;
    if (sim.status !== undefined) {
      const body = errorBody(req.headers);
      sock.write(`HTTP/1.1 ${sim.status} Sim\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n${lines(sim.headers)}\r\n${body}`);
      sock.end();
      return;
    }
    const accept = createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}${GUID}`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    for (const f of greeting) sock.write(textFrame(JSON.stringify(f)));
    if (sim.id === "truncated-json") sock.write(textFrame('{"audio":"AAAA","isFi'));
    else if (sim.id === "invalid-json") sock.write(textFrame(INVALID_JSON));
    else if (sim.id === "abort") { sock.end(); return; } // the socket ends with no close frame
    sock.on("data", () => {});
    sock.on("end", () => sock.end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    counters,
    set(sim, g) { current = sim; greeting = g; counters.http = 0; counters.upgrade = 0; },
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.closeAllConnections(); server.close(() => r()); }),
  };
}

const vendor = await startSimServer();
after(() => vendor.close());

// ---- Polly: no HTTP in this package, the AWS SDK sits in between; a fake client throws what the SDK throws ----

const polly = { sim: SIMS[0]!, calls: 0, okCalls: 0 };
function sdkError(sim: Sim): Error {
  // The SDK's default error for a status it does not model: name is the status code, the status is in $metadata, and
  // no response headers are exposed.
  return Object.assign(new Error(`${VENDOR_TEXT} rejected ${MARKER}`), { name: String(sim.status), $metadata: { httpStatusCode: sim.status } });
}
const pollyClient: PollyClientLike = {
  async synthesize() {
    polly.calls++;
    if (polly.sim.status !== undefined) throw sdkError(polly.sim);
    // abort: `okCalls` requests complete, the connection of the next one is reset mid-body.
    if (polly.calls <= polly.okCalls) return new Uint8Array(480);
    return (async function* () {
      yield new Uint8Array(480);
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    })();
  },
  async describeVoices() {
    polly.calls++;
    throw sdkError(polly.sim);
  },
};

// ---- the registry: the adapter list comes from here ----

const waits: number[] = [];
const registry: VoiceRegistry = createVoiceProviders({
  elevenlabs: { enabled: true, apiKeyRef: "voice.key", baseUrl: vendor.url, defaultVoice: "voiceA" },
  xai: { enabled: true, apiKeyRef: "voice.key", baseUrl: vendor.url, defaultModel: "m" },
  gemini: { enabled: true, apiKeyRef: "voice.key", baseUrl: vendor.url, defaultModel: "m" },
  polly: { enabled: true, defaultVoice: "Vicki" },
}, { getSecret, retries: RETRIES, sleep: async (ms) => { waits.push(ms); }, pollyClientFactory: async () => pollyClient });

type CloudId = (typeof CLOUD_PROVIDER_IDS)[number];
type Kind = "tts" | "asr" | "realtime";
const adapters: Array<{ kind: Kind; id: CloudId }> = (["tts", "asr", "realtime"] as const).flatMap((kind) => (Object.keys(registry[kind]) as CloudId[]).map((id) => ({ kind, id })));

// ---- probes: which function of an adapter carries which cells ----

interface Probe {
  adapter: CloudId;
  kind: Kind;
  fn: string;
  label: string;
  transport: "http" | "ws" | "sdk";
  /** What a 200 answer carries: JSON the package parses, socket frames it parses, or opaque audio / SDK output (no JSON cell). */
  body: "json" | "frames" | "opaque";
  /** The audio (or session) arrives over time, so the connection can be cut in the middle of it: gives the `abort` cell. */
  streams: boolean;
  /** Polly only: how many requests complete before the connection of the next one is reset. */
  okCalls?: number;
  /** Frames the fake vendor sends right after the upgrade (session ready, a first audio frame). */
  greeting?: readonly unknown[];
  /** Run the operation and return the error it surfaced: thrown, or an `error` event of a session. */
  run(): Promise<unknown>;
}

const thrown = async (fn: () => Promise<unknown>): Promise<unknown> => { try { await fn(); return undefined; } catch (e) { return e; } };
const drain = async (it: AsyncIterable<unknown>): Promise<unknown> => { try { for await (const _ of it) { /* consume */ } return undefined; } catch (e) { return e; } };
interface EventSession { events: AsyncIterable<{ type: string }>; close(): Promise<void> }
async function sessionError(open: () => Promise<EventSession>): Promise<unknown> {
  let session: EventSession;
  try { session = await open(); } catch (e) { return e; }
  let error: unknown;
  const it = session.events[Symbol.asyncIterator]();
  for (let i = 0; i < 50; i++) {
    const r = await it.next();
    if (r.done) break;
    const ev = r.value as { type: string; error?: unknown };
    if (ev.type === "error" && error === undefined) error = ev.error;
    if (ev.type === "closed") break;
  }
  await session.close();
  return error;
}
const oneSentence = async function* (): AsyncGenerator<string> { yield "Hello there. "; };
const pcm = { data: new Uint8Array(3200), format: "pcm16" as const, sampleRate: 16000 };
const tts = (id: CloudId) => registry.tts[id]!;
const asr = (id: CloudId) => registry.asr[id]!;
const rt = (id: CloudId) => registry.realtime[id]!;

const PROBES: readonly Probe[] = [
  { adapter: "elevenlabs", kind: "tts", fn: "synthesize", label: "ElevenLabs TTS synthesize", transport: "http", body: "opaque", streams: true, run: () => thrown(() => tts("elevenlabs").synthesize("Hello there.")) },
  { adapter: "elevenlabs", kind: "tts", fn: "synthesizeStream[http]", label: "ElevenLabs TTS synthesizeStream (HTTP)", transport: "http", body: "opaque", streams: true, run: () => drain(tts("elevenlabs").synthesizeStream("Hello there.")) },
  { adapter: "elevenlabs", kind: "tts", fn: "synthesizeStream[ws]", label: "ElevenLabs TTS synthesizeStream (WebSocket)", transport: "ws", body: "frames", streams: true, greeting: [{ audio: Buffer.alloc(480, 1).toString("base64") }], run: () => drain(tts("elevenlabs").synthesizeStream(oneSentence())) },
  { adapter: "elevenlabs", kind: "tts", fn: "listVoices", label: "ElevenLabs TTS listVoices", transport: "http", body: "json", streams: false, run: () => thrown(() => tts("elevenlabs").listVoices()) },
  { adapter: "elevenlabs", kind: "asr", fn: "transcribe", label: "ElevenLabs ASR transcribe", transport: "http", body: "json", streams: false, run: () => thrown(() => asr("elevenlabs").transcribe(pcm)) },
  { adapter: "elevenlabs", kind: "asr", fn: "openStream", label: "ElevenLabs ASR openStream (WebSocket)", transport: "ws", body: "frames", streams: true, greeting: [{ message_type: "session_started" }], run: () => sessionError(() => asr("elevenlabs").openStream({ sampleRate: 16000 })) },
  { adapter: "xai", kind: "realtime", fn: "connect", label: "xAI Grok Voice connect (WebSocket)", transport: "ws", body: "frames", streams: true, greeting: [{ type: "session.created" }], run: () => sessionError(() => rt("xai").connect()) },
  { adapter: "xai", kind: "realtime", fn: "listModels", label: "xAI Grok Voice listModels", transport: "http", body: "json", streams: false, run: () => thrown(() => rt("xai").listModels()) },
  { adapter: "gemini", kind: "realtime", fn: "connect", label: "Gemini Live connect (WebSocket)", transport: "ws", body: "frames", streams: true, greeting: [{ setupComplete: {} }], run: () => sessionError(() => rt("gemini").connect()) },
  { adapter: "gemini", kind: "realtime", fn: "listModels", label: "Gemini Live listModels", transport: "http", body: "json", streams: false, run: () => thrown(() => rt("gemini").listModels()) },
  { adapter: "polly", kind: "tts", fn: "synthesize", label: "Polly TTS synthesize", transport: "sdk", body: "opaque", streams: true, run: () => thrown(() => tts("polly").synthesize("Hello there.")) },
  { adapter: "polly", kind: "tts", fn: "synthesizeStream", label: "Polly TTS synthesizeStream", transport: "sdk", body: "opaque", streams: true, okCalls: 1, run: () => drain(tts("polly").synthesizeStream("First sentence here. Second sentence here.")) },
  { adapter: "polly", kind: "tts", fn: "listVoices", label: "Polly TTS listVoices", transport: "sdk", body: "opaque", streams: false, run: () => thrown(() => tts("polly").listVoices()) },
];
const KIND_ORDER: readonly Kind[] = ["tts", "asr", "realtime"];
const probes = adapters.flatMap((a) => PROBES.filter((p) => p.adapter === a.id && p.kind === a.kind))
  .sort((a, b) => (CLOUD_PROVIDER_IDS as readonly string[]).indexOf(a.adapter) - (CLOUD_PROVIDER_IDS as readonly string[]).indexOf(b.adapter) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
const probeKey = (p: Probe): string => `${p.adapter}/${p.kind}/${p.fn}`;

// ---- expectations ----

interface Cell { code: VoiceErrorCode; retryable: boolean; retryAfterMs: number | undefined; documented: boolean }
/** gap: the documented expectation is kept in the Cell and the test is a todo with this text. */
type Override = Partial<Cell> & { gap?: string };

// What docs/errors.md says. `documented: false` marks a mapping the docs do not state (pinned to the code).
const DOC: Record<SimId, Cell> = {
  "401": { code: "auth", retryable: false, retryAfterMs: undefined, documented: true },
  "403": { code: "auth", retryable: false, retryAfterMs: undefined, documented: true },
  "404": { code: "invalid_request", retryable: false, retryAfterMs: undefined, documented: true },
  "408": { code: "timeout", retryable: true, retryAfterMs: undefined, documented: false },
  "413": { code: "invalid_request", retryable: false, retryAfterMs: undefined, documented: true },
  "429+RA": { code: "rate_limited", retryable: true, retryAfterMs: 7000, documented: true },
  "429": { code: "rate_limited", retryable: true, retryAfterMs: undefined, documented: true },
  "500": { code: "overloaded", retryable: true, retryAfterMs: undefined, documented: true },
  "503": { code: "overloaded", retryable: true, retryAfterMs: undefined, documented: true },
  "truncated-json": { code: "bad_response", retryable: false, retryAfterMs: undefined, documented: true },
  "invalid-json": { code: "bad_response", retryable: false, retryAfterMs: undefined, documented: true },
  "abort": { code: "network", retryable: true, retryAfterMs: undefined, documented: true },
};

const OVERRIDES: Record<string, Override> = {};
// Polly goes through mapAwsError, which reads the SDK error's name and `$metadata.httpStatusCode`.
for (const fn of ["synthesize", "synthesizeStream", "listVoices"]) {
  // Not in the docs: the SDK reports a bare 408 with no timeout name, the service's Retry-After never reaches the package.
  OVERRIDES[`polly/tts/${fn}|408`] = { code: "network", retryable: true, documented: false };
  OVERRIDES[`polly/tts/${fn}|429+RA`] = { retryAfterMs: undefined, documented: false };
}
function applicable(p: Probe, s: Sim): boolean {
  if (s.id === "truncated-json" || s.id === "invalid-json") return p.body !== "opaque";
  if (s.id === "abort") return p.streams;
  return true;
}
function expected(p: Probe, s: Sim): Cell & { gap?: string } {
  const base: Cell = { ...DOC[s.id] };
  // A bad frame on a socket breaks the vendor's own message schema: `upstream_protocol` (docs/errors.md).
  if (p.body === "frames" && (s.id === "truncated-json" || s.id === "invalid-json")) base.code = "upstream_protocol";
  return { ...base, ...OVERRIDES[`${probeKey(p)}|${s.id}`] };
}

const observed = new Map<string, { code: string; retryable: boolean | undefined }>();
const gaps = new Set<string>();
const errorText = (e: unknown): string => `${inspect(e, { depth: 6 })}\n${e instanceof Error ? `${e.name}\n${e.message}\n${e.stack ?? ""}` : ""}\n${JSON.stringify(e) ?? ""}`;
const describeError = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// ---- one test per cell ----

function setScenario(p: Probe, s: Sim): void {
  waits.length = 0;
  polly.sim = s;
  polly.calls = 0;
  polly.okCalls = p.okCalls ?? 0;
  vendor.set(s, p.greeting ?? []);
}

for (const p of probes) {
  for (const s of SIMS) {
    if (!applicable(p, s)) continue;
    const exp = expected(p, s);
    const cellKey = `${probeKey(p)}|${s.id}`;
    if (exp.gap !== undefined) gaps.add(cellKey);
    const opts = { timeout: 20_000, ...(exp.gap !== undefined ? { todo: exp.gap } : {}) };
    test(`error-table / ${p.label} / ${s.id}`, opts, async () => {
      setScenario(p, s);
      const err = await p.run();
      assert.notEqual(err, undefined, "no error surfaced");
      if (isVoiceProviderError(err)) observed.set(cellKey, { code: err.code, retryable: err.retryable });
      else observed.set(cellKey, { code: `raw ${err instanceof Error ? err.name : typeof err}`, retryable: undefined });
      assert.ok(!errorText(err).includes(MARKER), "the secret marker appears in the error");
      assert.ok(isVoiceProviderError(err), `expected a VoiceProviderError, got ${describeError(err)}`);
      assert.ok(VOICE_ERROR_CODES.includes(err.code));
      assert.equal(err.code, exp.code, `code (message: ${err.message})`);
      assert.equal(err.retryable, exp.retryable, "retryable");
      assert.equal(err.retryAfterMs, exp.retryAfterMs, "retryAfterMs");
      if (p.transport === "http" && s.status !== undefined) {
        // The HTTP client retries what is retryable and honours Retry-After through the injected sleep.
        assert.equal(vendor.counters.http, exp.retryable ? 1 + RETRIES : 1, "requests made");
        assert.equal(waits.length, vendor.counters.http - 1, "sleeps");
        if (s.id === "429+RA") assert.deepEqual(waits, [7000, 7000], "waits follow Retry-After");
        else assert.ok(waits.every((w) => w > 0 && w <= 30_000), `waits ${waits.join(",")}`);
      }
    });
  }
}

// ---- messages carry no vendor text (docs/errors.md: "messages carry no key and no vendor text") ----

for (const p of probes) {
  test(`error-table / ${p.label} / no vendor text in any status error message`, { timeout: 60_000 }, async () => {
    const leaks: string[] = [];
    for (const s of STATUS_SIMS) {
      setScenario(p, s);
      const err = await p.run();
      assert.ok(isVoiceProviderError(err), `${s.id}: expected a VoiceProviderError, got ${describeError(err)}`);
      assert.ok(!errorText(err).includes(MARKER), `${s.id}: the secret marker appears in the error`);
      if (err.message.includes(VENDOR_TEXT)) leaks.push(s.id);
    }
    assert.deepEqual(leaks, [], "statuses whose message contains the vendor's text");
  });
}

// ---- registry and package files ----

test("error-table / every adapter the registry hands out has probes, and every probe belongs to a registered adapter", () => {
  assert.deepEqual(registry.status.map((s) => s.id), [...CLOUD_PROVIDER_IDS]);
  assert.ok(registry.status.every((s) => s.state === "ready"), "every cloud provider is ready in this configuration");
  for (const s of registry.status) for (const cap of s.capabilities) assert.ok(registry[cap][s.id] !== undefined, `${s.id} lists ${cap} but the registry has none`);
  const registered = new Set(adapters.map((a) => `${a.id}/${a.kind}`));
  const probed = new Set(PROBES.map((p) => `${p.adapter}/${p.kind}`));
  assert.deepEqual([...registered].filter((a) => !probed.has(a)), [], "registered adapters without probes");
  assert.deepEqual([...probed].filter((a) => !registered.has(a)), [], "probes for adapters that are not registered");
});
test("error-table / provider files and registry agree: every create* function in src/providers is wired into createVoiceProviders", () => {
  const dir = new URL("../src/providers/", import.meta.url);
  const registrySource = readFileSync(new URL("../src/registry.ts", import.meta.url), "utf8");
  const created: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts")).sort()) {
    for (const m of readFileSync(new URL(f, dir), "utf8").matchAll(/export (?:async )?function (create[A-Z]\w*)\(/g)) created.push(m[1]!);
  }
  assert.ok(created.length >= CLOUD_PROVIDER_IDS.length, `found ${created.join(", ")}`);
  assert.deepEqual(created.filter((name) => !new RegExp(`\\b${name}\\(`).test(registrySource)), [], "provider files with a create* function the registry never calls");
});

test("error-table / the local adapters are not part of the cloud registry (by design: LocalVoice owns them, they have no vendor HTTP)", () => {
  const local = readFileSync(new URL("../src/local/providers.ts", import.meta.url), "utf8");
  const registrySource = readFileSync(new URL("../src/registry.ts", import.meta.url), "utf8");
  assert.match(local, /export function createLocalAsr\(/);
  assert.match(local, /export function createLocalTts\(/);
  assert.ok(!/createLocal(Asr|Tts)|LocalVoice/.test(registrySource));
  assert.ok(![...Object.keys(registry.tts), ...Object.keys(registry.asr)].includes("local"));
});

// ---- optional: the observed matrix as a markdown table ----

after(() => {
  const out = process.env["ERROR_TABLE_OUT"];
  if (!out) return;
  const cell = (p: Probe, s: Sim): string => {
    if (!applicable(p, s)) return "n/a";
    const key = `${probeKey(p)}|${s.id}`;
    const o = observed.get(key);
    if (!o) return "not run";
    const e = expected(p, s);
    return `${o.code} / ${o.retryable === undefined ? "n/a" : o.retryable ? "yes" : "no"} / ${e.documented ? "yes" : "no"}${gaps.has(key) ? " [KNOWN GAP]" : ""}`;
  };
  const rows = [
    `| Adapter / function | ${SIMS.map((s) => s.id).join(" | ")} |`,
    `|---|${SIMS.map(() => "---").join("|")}|`,
    ...probes.map((p) => `| ${p.label} | ${SIMS.map((s) => cell(p, s)).join(" | ")} |`),
  ];
  writeFileSync(out, `${rows.join("\n")}\n`);
});
