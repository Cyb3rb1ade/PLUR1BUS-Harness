import { inspect } from "node:util";
import { MatrixChannel, MemorySyncTokenStore } from "../../src/index.ts";
import type { ChannelHost } from "../../../core/src/channels/types.ts";
import { BOT, FAKE_TOKEN, ROOM, type FakeMatrix } from "./fake-matrix.ts";
import { SECRET_NAME, newFake } from "./rig.ts";

// Helpers for redaction-catalogue.test.ts: the leak scanner and a channel rig that can plant the access token into every
// failure a homeserver or the network can produce. Nothing here imports src/redact.ts: that module is the object under test.

// Why the marker is FAKE_TOKEN and not a made-up string: MatrixChannel refuses a token that is not printable ASCII of 8 to 1024
// characters (channel.ts, TOKEN_FORMAT), and the in-process homeserver only answers requests that carry exactly FAKE_TOKEN
// (fake-matrix.ts), so any other marker would turn every scenario into a 401. Scanning for the whole token alone would miss a
// truncated leak, so the scanner also looks for its distinctive middle run and its leading fragment. Both are cut out of
// FAKE_TOKEN at load time, so this file holds no token-shaped literal of its own.
export const TOKEN_INNER = FAKE_TOKEN.split("_")[1] ?? "";
export const NEEDLES: ReadonlyArray<readonly [name: string, needle: string]> = [
  ["full token", FAKE_TOKEN],
  ["distinctive inner run of the token", TOKEN_INNER],
  ["leading fragment of the token", FAKE_TOKEN.slice(0, 12)],
];

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\)]+/gi;
// Header-derived text: an Authorization value ("Bearer <something>") or an access_token query parameter, unless it is already scrubbed.
const BEARER_VALUE = /\bbearer\s+(?!\[redacted\])\S/i;
const QUERY_TOKEN = /access_token=(?!\[redacted\])\S/i;

/** Every absolute URL that appears in `text`. */
export function urlsIn(text: string): string[] {
  return text.match(URL_IN_TEXT) ?? [];
}

/** Plain substring search, no redaction logic. Returns one description per kind of leak found; empty means clean. */
export function leakReport(text: string): string[] {
  const hits: string[] = [];
  for (const [name, needle] of NEEDLES) if (text.includes(needle)) hits.push(`contains the ${name}`);
  if (BEARER_VALUE.test(text)) hits.push("contains Authorization header text (Bearer <value>)");
  if (QUERY_TOKEN.test(text)) hits.push("contains an access_token query parameter");
  for (const url of urlsIn(text)) {
    const carriesToken = NEEDLES.some(([, needle]) => url.includes(needle));
    if (carriesToken || QUERY_TOKEN.test(url) || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url)) hits.push(`contains a URL that carries credentials (${url.split("?")[0]})`);
  }
  return hits;
}

/** The whole observable text of a value: strings as they are, anything else (errors with cause and own properties included) via inspect. */
export function deepText(value: unknown): string {
  if (typeof value === "string") return value;
  return inspect(value, { depth: 12, showHidden: true, maxStringLength: Infinity, maxArrayLength: Infinity, breakLength: Infinity });
}

// ------------------------------------------------------------------------------------------------------------- faults

export interface SeenRequest {
  n: number;
  method: string;
  url: string;
  /** The Authorization request header exactly as the channel sent it. */
  authorization: string | null;
}

/** Returns a Response to answer with, an Error to reject the fetch with, or undefined to let the request through to the homeserver fake. */
export type Fault = (req: SeenRequest) => Response | Error | undefined;

export type Kind = "auth" | "network" | "server-error" | "bad-gateway-html" | "not-json" | "rate-limit" | "wrong-shape";
export const KINDS: readonly Kind[] = ["auth", "network", "server-error", "bad-gateway-html", "not-json", "rate-limit", "wrong-shape"];

const withTokenQuery = (url: string) => `${url}${url.includes("?") ? "&" : "?"}access_token=${FAKE_TOKEN}`;

/** What a careless client or server would echo back: the URL with the token in its query, the Authorization header, the bare token. */
export function echoOf(req: SeenRequest): string {
  return `${req.method} ${withTokenQuery(req.url)} Authorization: ${req.authorization ?? "-"} token=${FAKE_TOKEN}`;
}

function jsonReply(status: number, body: unknown, req: SeenRequest, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-echo-authorization": req.authorization ?? "-", ...extra },
  });
}

// Valid JSON that is not what the endpoint promises, with the echo in every field the channel might read or repeat.
function wrongShape(req: SeenRequest): unknown {
  if (req.url.includes("/account/whoami")) return { user_id: echoOf(req), device_id: echoOf(req) };
  if (req.url.includes("/sync")) return { next_batch: "s9", account_data: { events: echoOf(req) }, rooms: { join: echoOf(req) } };
  if (req.url.includes("/profile/")) return { displayname: echoOf(req) };
  return { event_id: echoOf(req), room_id: echoOf(req), content_uri: echoOf(req) };
}

/** One failure of the given kind, built from the request it answers so the echo is as realistic as possible. */
export function planted(kind: Kind, req: SeenRequest): Response | Error {
  switch (kind) {
    case "network":
      // Message and cause both carry the URL and the header; the code is a plain Node code, as a real socket error has.
      return new TypeError(`fetch failed: ${echoOf(req)}`, {
        cause: Object.assign(new Error(`connect ECONNRESET ${echoOf(req)}`), { code: "ECONNRESET" }),
      });
    case "auth":
      return jsonReply(401, { errcode: "M_UNKNOWN_TOKEN", error: `Unrecognised access token: ${echoOf(req)}`, soft_logout: false }, req);
    case "server-error":
      return jsonReply(500, { errcode: "M_UNKNOWN", error: `Internal server error: ${echoOf(req)}`, access_token: FAKE_TOKEN }, req);
    case "rate-limit":
      return jsonReply(429, { errcode: "M_LIMIT_EXCEEDED", error: `Too many requests: ${echoOf(req)}`, retry_after_ms: 2000 }, req, { "retry-after": "2" });
    case "bad-gateway-html":
      return new Response(`<html><body>502 Bad Gateway for ${echoOf(req)}</body></html>`, {
        status: 502,
        headers: { "content-type": "text/html", "x-echo-authorization": req.authorization ?? "-" },
      });
    case "not-json":
      return new Response(`this is not json: ${echoOf(req)}`, { status: 200, headers: { "content-type": "text/plain" } });
    case "wrong-shape":
      return jsonReply(200, wrongShape(req), req);
  }
}

/** A fault that answers requests whose URL matches (and, if given, whose method matches) with a planted failure, `times` times. */
export function faultOn(match: RegExp, kind: Kind, opts: { method?: string; times?: number } = {}): Fault {
  let left = opts.times ?? Number.POSITIVE_INFINITY;
  return (req) => {
    if (left <= 0 || !match.test(req.url)) return undefined;
    if (opts.method !== undefined && req.method !== opts.method) return undefined;
    left -= 1;
    return planted(kind, req);
  };
}

export const WHOAMI = /\/_matrix\/client\/v3\/account\/whoami$/;
export const SYNC = /\/_matrix\/client\/v3\/sync\?/;
export const PROFILE = /\/_matrix\/client\/v3\/profile\//;
export const SEND = /\/_matrix\/client\/v3\/rooms\/[^/]+\/send\//;

// ---------------------------------------------------------------------------------------------------------------- rig

export interface HostLogLine {
  level: "info" | "warn" | "error";
  msg: string;
  fields: unknown;
}
export interface LoggerLine {
  level: string;
  event: string;
  attrs: unknown;
}

export interface RedactionRig {
  readonly channel: MatrixChannel;
  readonly fake: FakeMatrix;
  /** The ChannelHost handed to start(): host.log at every level, host.fail. */
  readonly host: ChannelHost;
  /** The logger passed to the constructor (all four levels). */
  readonly logger: { log(level: "debug" | "info" | "warn" | "error", event: string, attrs: Readonly<Record<string, string | number | boolean>>): void };
  readonly hostLogs: HostLogLine[];
  readonly loggerLines: LoggerLine[];
  /** Everything passed to host.fail. */
  readonly failures: unknown[];
  readonly sleeps: number[];
  /** Every request the channel made, in order, as it left the channel. */
  readonly requests: SeenRequest[];
  setFault(fault: Fault | undefined): void;
  hostLogText(): string;
  loggerText(): string;
  failureText(): string;
  /** host.log, the constructor logger and host.fail, as one text. */
  allOutputText(): string;
  /** Resolves once pred() holds; re-checked every millisecond and on every host call, log line and sleep. Rejects after 5 s. */
  waitFor(pred: () => boolean, what: string): Promise<void>;
  /** channel.start(host), then waits until the sync loop is parked on a long poll. Not usable when the loop ends (fatal errors). */
  startParked(): Promise<void>;
  dispose(): Promise<void>;
}

export interface RigOptions {
  /** A stored sync position exists (no initial sync). Default true: failures then hit the sync loop; false hits the initial sync. */
  resumed?: boolean;
  fault?: Fault;
  maxSendRetries?: number;
  /** What the secret store answers for the token secret. Default: FAKE_TOKEN. */
  reveal?: () => Promise<string | null>;
}

/**
 * A real MatrixChannel against the in-process homeserver fake, with an injected fetch (records every request, applies the
 * current fault) and an injected sleep that returns at once, so no scenario waits on a wall clock. A fault that never stops
 * would hot-loop the sync loop because backoff is instant: faults that hit the loop must be bounded with `times`.
 */
export async function makeRedactionRig(opts: RigOptions = {}): Promise<RedactionRig> {
  const fake = await newFake();
  const hostLogs: HostLogLine[] = [];
  const loggerLines: LoggerLine[] = [];
  const failures: unknown[] = [];
  const sleeps: number[] = [];
  const requests: SeenRequest[] = [];
  let fault: Fault | undefined = opts.fault;

  const waiters = new Set<() => void>();
  const changed = () => {
    for (const w of [...waiters]) w();
  };
  const waitFor = (pred: () => boolean, what: string) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!pred()) return;
        waiters.delete(check);
        clearInterval(recheck);
        clearTimeout(guard);
        resolve();
      };
      const recheck = setInterval(check, 1);
      // Failure guard only: a healthy run resolves long before this fires.
      const guard = setTimeout(() => {
        waiters.delete(check);
        clearInterval(recheck);
        reject(new Error(`timeout: ${what}`));
      }, 5000);
      waiters.add(check);
      check();
    });

  const realFetch = globalThis.fetch;
  const transport: typeof fetch = async (input, init) => {
    const req: SeenRequest = {
      n: requests.length,
      method: init?.method ?? "GET",
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    };
    requests.push(req);
    const answer = fault?.(req);
    if (answer instanceof Error) throw answer;
    if (answer) return answer;
    return realFetch(input, init);
  };

  const logger: RedactionRig["logger"] = {
    log: (level, event, attrs) => {
      loggerLines.push({ level, event, attrs: { ...attrs } });
      changed();
    },
  };
  const host: ChannelHost = {
    receive: async () => {},
    fail: (err) => {
      failures.push(err);
      changed();
    },
    log: {
      info: (msg, fields) => {
        hostLogs.push({ level: "info", msg, fields });
        changed();
      },
      warn: (msg, fields) => {
        hostLogs.push({ level: "warn", msg, fields });
        changed();
      },
      error: (msg, fields) => {
        hostLogs.push({ level: "error", msg, fields });
        changed();
      },
    },
  };

  const channel = new MatrixChannel({
    homeserverUrl: fake.baseUrl,
    userId: BOT,
    accessTokenSecret: SECRET_NAME,
    allowlist: [ROOM],
    dmAllowlist: [],
    replyPolicy: "always",
    secrets: { reveal: async (n: string) => (n === SECRET_NAME ? (opts.reveal ? opts.reveal() : FAKE_TOKEN) : null) },
    syncStore: new MemorySyncTokenStore((opts.resumed ?? true) ? "s0" : undefined),
    logger,
    fetch: transport,
    sleep: async (ms) => {
      sleeps.push(ms);
      changed();
    },
    random: () => 0.5,
    syncTimeoutMs: 5000,
    ...(opts.maxSendRetries !== undefined ? { maxSendRetries: opts.maxSendRetries } : {}),
  });

  const hostLogText = () => deepText(hostLogs);
  const loggerText = () => deepText(loggerLines);
  const failureText = () => deepText(failures);
  return {
    channel,
    fake,
    host,
    logger,
    hostLogs,
    loggerLines,
    failures,
    sleeps,
    requests,
    setFault: (f) => {
      fault = f;
    },
    hostLogText,
    loggerText,
    failureText,
    allOutputText: () => [hostLogText(), loggerText(), failureText()].join("\n"),
    waitFor,
    startParked: async () => {
      await channel.start(host);
      await fake.waitIdle();
    },
    dispose: async () => {
      await channel.stop().catch(() => {});
      await fake.close();
    },
  };
}
