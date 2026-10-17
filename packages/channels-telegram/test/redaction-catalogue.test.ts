import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { MemoryOffsetStore, TelegramApiError, TelegramChannel, type TelegramErrorKind } from "../src/index.ts";
import type { ChannelHost } from "../../core/src/channels/types.ts";
import { FakeTelegram, FAKE_TELEGRAM_TOKEN } from "./helpers/fake-telegram.ts";

// Secret redaction catalogue (step 3 of the channel contract work).
//
// Choice of marker: Telegram validates the bot token's shape at start (src/channel.ts TOKEN_FORMAT: digits, a colon, then
// 20+ characters), so a free-text marker such as MARKER_SECRET_ONE would be rejected before any request is made and
// the suite would prove nothing. The fixture token FAKE_TELEGRAM_TOKEN already passes that check, so it is the planted
// secret, and the marker we search for is its distinctive middle part (the text after the bot id). The token is also
// part of every request URL (/bot<token>/method), so URLs in logs and in error text are covered as well.
//
// The scanner below is plain substring search and deliberately does not use the package's own redact.ts: that file is
// the object under test, so it must not decide what counts as a leak.

const MARKER = "AAFakeTokenForTestsOnly";
const SECRET = FAKE_TELEGRAM_TOKEN;
// The part of the token after the bot id. Derived, never retyped, so no second token-shaped literal exists here.
const SECRET_HALF = SECRET.split(":")[1]!;
const CHAT = "42";

// ---------------------------------------------------------------------------------------------------------------------
// Scanner

/** Every string an output exposes: message, stack, String(err), cause chain, own properties, JSON and inspect text. */
function surfaces(value: unknown, seen: Set<unknown> = new Set()): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object" && typeof value !== "function") return [String(value)];
  if (seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  if (value instanceof Error) {
    out.push(value.name, value.message, String(value.stack ?? ""), String(value));
    if ("cause" in value) out.push(...surfaces((value as { cause?: unknown }).cause, seen));
    if (value instanceof AggregateError) out.push(...surfaces(value.errors, seen));
  }
  try {
    out.push(JSON.stringify(value));
  } catch {
    /* circular or non-serialisable: inspect below still covers it */
  }
  out.push(inspect(value, { depth: 8, showHidden: true }));
  for (const [k, v] of Object.entries(value)) out.push(k, ...surfaces(v, seen));
  return out;
}

const contains = (text: string, needle: string = MARKER): boolean => text.includes(needle);
const hitsIn = (value: unknown, needle: string = MARKER): string[] => surfaces(value).filter((s) => contains(s, needle));
const excerpt = (s: string): string => `${s.slice(0, 120)}${s.length > 120 ? "..." : ""}`;

function assertClean(where: string, value: unknown, needle: string = MARKER): void {
  const hits = hitsIn(value, needle);
  assert.equal(hits.length, 0, `${where} contains the marker: ${excerpt(hits[0] ?? "")}`);
}

/** URLs and bot-URL path fragments inside a piece of text. */
const urlsIn = (text: string): string[] => text.match(/https?:\/\/[^\s"'<>\\]+|\/(?:file\/)?bot[^\s"'<>\\/]*/g) ?? [];

// ---------------------------------------------------------------------------------------------------------------------
// Rig: a real TelegramChannel against the in-process Bot API fake, with one fetch wrapper that injects scripted faults.

interface Line {
  level: string;
  args: unknown[];
}
const eventOf = (l: Line): string => String(l.args[0]);

interface Injection {
  /** What the fault feeds into the channel as text (bodies, error messages), for the non-vacuity control. */
  carried: string;
  response?: Response;
  error?: unknown;
}
interface Fault {
  name: string;
  /** The TelegramApiError kind the channel is expected to raise for this fault. */
  kind: TelegramErrorKind;
  /** True when the injected text itself contains the marker (the secret is really offered to the channel). */
  carriesSecret: boolean;
  /** A second credential the injected text carries (the webhook secret), when there is one. */
  echoes?: string;
  make(url: string): Injection;
}

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const htmlRes = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
const injectJson = (status: number, body: Record<string, unknown>): Injection => ({
  carried: JSON.stringify(body),
  response: jsonRes(status, body),
});

const FAULTS: Fault[] = [
  {
    name: "401 unauthorized",
    kind: "unauthorized",
    carriesSecret: false,
    make: () => injectJson(401, { ok: false, error_code: 401, description: "Unauthorized" }),
  },
  {
    name: "401 whose description echoes the request URL and the token",
    kind: "unauthorized",
    carriesSecret: true,
    make: (url) =>
      injectJson(401, { ok: false, error_code: 401, description: `Unauthorized: POST ${url} with token ${SECRET}` }),
  },
  {
    name: "network failure with the URL in message and cause",
    kind: "network",
    carriesSecret: true,
    make: (url) => {
      const cause = Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: "ECONNREFUSED", url });
      const error = new TypeError(`fetch failed: POST ${url}`, { cause });
      return { carried: `${error.message} ${cause.message}`, error };
    },
  },
  {
    name: "network failure whose cause.code is the URL itself",
    kind: "network",
    carriesSecret: true,
    make: (url) => {
      const error = new TypeError(`fetch failed ${url}`, { cause: { code: url, address: url } });
      return { carried: `${error.message} ${url}`, error };
    },
  },
  {
    name: "network failure rejected with a bare string holding URL and token",
    kind: "network",
    carriesSecret: true,
    make: (url) => {
      const error = `ECONNRESET ${url} ${SECRET}`;
      return { carried: error, error };
    },
  },
  {
    name: "502 whose description echoes the token",
    kind: "http",
    carriesSecret: true,
    make: (url) =>
      injectJson(502, { ok: false, error_code: 502, description: `upstream rejected token ${SECRET} (${url.length})` }),
  },
  {
    name: "502 whose description echoes the bot URL",
    kind: "http",
    carriesSecret: true,
    make: (url) => injectJson(502, { ok: false, error_code: 502, description: `Bad Gateway while calling ${url}` }),
  },
  {
    name: "502 with the token straddling the 200 character cut",
    kind: "http",
    carriesSecret: true,
    make: () =>
      injectJson(502, { ok: false, error_code: 502, description: `${"x".repeat(165)}${SECRET} and more text after it` }),
  },
  {
    name: "502 with an HTML body (not JSON) holding URL and token",
    kind: "http",
    carriesSecret: true,
    make: (url) => {
      const body = `<html><body>502 Bad Gateway for ${url} token ${SECRET}</body></html>`;
      return { carried: body, response: htmlRes(502, body) };
    },
  },
  {
    name: "200 with a body that is not JSON",
    kind: "http",
    carriesSecret: true,
    make: (url) => {
      const body = `not json {"url":"${url}","token":"${SECRET}"`;
      return { carried: body, response: htmlRes(200, body) };
    },
  },
  {
    name: "429 whose description echoes the URL and the token",
    kind: "rate-limited",
    carriesSecret: true,
    make: (url) =>
      injectJson(429, {
        ok: false,
        error_code: 429,
        description: `Too Many Requests on ${url} for ${SECRET}`,
        parameters: { retry_after: 2 },
      }),
  },
  {
    name: "429 with an HTML body and only a retry-after header",
    kind: "rate-limited",
    carriesSecret: true,
    make: (url) => {
      const body = `<html>slow down ${url} ${SECRET}</html>`;
      return { carried: body, response: htmlRes(429, body, { "retry-after": "2" }) };
    },
  },
];

// Beyond the stated scenario: shapes of an echo that the exact-token and bot-URL forms do not cover. They run through
// three representative operations only, because every Bot API call shares one error builder (TelegramApi.#call).
const ECHO_VARIANTS: Fault[] = [
  {
    name: "502 whose description echoes only the part of the token after the bot id",
    kind: "http",
    carriesSecret: true,
    make: () => injectJson(502, { ok: false, error_code: 502, description: `bad credential ${SECRET_HALF}` }),
  },
  {
    name: "502 whose description echoes the percent-encoded token",
    kind: "http",
    carriesSecret: true,
    make: () => injectJson(502, { ok: false, error_code: 502, description: `rejected ${encodeURIComponent(SECRET)}` }),
  },
];

// Second credential: the webhook secret_token sent by setWebhook. It matches /^[A-Za-z0-9_-]{1,256}$/, which is all the
// channel checks, and it is not shaped like any real token.
const WEBHOOK_SECRET = "WEBHOOK_SECRET_MARKER_ONE";
const WEBHOOK_ECHO: Fault = {
  name: "502 whose description echoes the webhook secret_token",
  kind: "http",
  carriesSecret: false,
  echoes: WEBHOOK_SECRET,
  make: () => injectJson(502, { ok: false, error_code: 502, description: `invalid secret_token ${WEBHOOK_SECRET}` }),
};

type Op = "start(host) getMe" | "start(host) setMyCommands" | "start(host) deleteWebhook" | "start() standalone getMe" | "send sendMessage" | "send attachment sendDocument" | "poll getUpdates" | "inbound file download";

interface Slot {
  fault: Fault;
  left: number;
}

interface Rig {
  readonly fake: FakeTelegram;
  readonly channel: TelegramChannel;
  readonly host: ChannelHost;
  readonly hostLogs: Line[];
  readonly ctorLogs: Line[];
  readonly failures: unknown[];
  readonly errors: unknown[];
  readonly healths: unknown[];
  readonly sleeps: number[];
  readonly requested: string[];
  readonly injected: string[];
  readonly bodies: string[];
  readonly hits: Map<string, number>;
  arm(method: string, fault: Fault, times?: number): void;
  probeHealth(): Promise<{ ok: boolean; detail?: unknown }>;
  attempt<T>(run: () => Promise<T>): Promise<{ value?: T; error?: unknown }>;
  waitFor(pred: () => boolean, what: string): Promise<void>;
  dispose(): Promise<void>;
}

const methodOf = (url: string): string => (/\/file\/bot[^/]+\//.test(url) ? "download" : (url.split("/").at(-1) ?? ""));

async function makeRig(over: { webhook?: { url: string; secret: string } } = {}): Promise<Rig> {
  const fake = new FakeTelegram();
  await fake.listen();
  const hostLogs: Line[] = [];
  const ctorLogs: Line[] = [];
  const failures: unknown[] = [];
  const errors: unknown[] = [];
  const healths: unknown[] = [];
  const sleeps: number[] = [];
  const requested: string[] = [];
  const injected: string[] = [];
  const bodies: string[] = [];
  const hits = new Map<string, number>();
  const armed = new Map<string, Slot[]>();
  const waiters = new Set<() => void>();
  const changed = () => {
    for (const w of [...waiters]) w();
  };

  const scripted: typeof fetch = async (input, init) => {
    const url = String(input);
    requested.push(url);
    if (typeof init?.body === "string") bodies.push(init.body);
    const key = methodOf(url);
    const slot = armed.get(key)?.find((s) => s.left > 0);
    if (slot) {
      slot.left -= 1;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      const made = slot.fault.make(url);
      injected.push(made.carried);
      if (made.error !== undefined) throw made.error;
      return made.response!;
    }
    return fetch(input, init);
  };
  // No real waiting: the injected seam records the delay and resolves at once.
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    changed();
    return Promise.resolve();
  };
  const hostLog =
    (level: string) =>
    (...args: unknown[]) => {
      hostLogs.push({ level, args });
      changed();
    };
  const host: ChannelHost = {
    receive: async () => {},
    fail: (err) => {
      failures.push(err);
      changed();
    },
    log: { info: hostLog("info"), warn: hostLog("warn"), error: hostLog("error") },
  };
  const channel = new TelegramChannel({
    tokenSecret: "telegram/bot",
    secrets: { reveal: async () => SECRET },
    allowlist: [Number(CHAT)],
    offsetStore: new MemoryOffsetStore(),
    logger: {
      log: (level, event, attrs) => {
        ctorLogs.push({ level, args: [event, { ...attrs }] });
        changed();
      },
    },
    baseUrl: fake.baseUrl,
    fetch: scripted,
    sleep,
    random: () => 0.5,
    pollTimeoutSec: 1,
    maxSendRetries: 2,
    ...(over.webhook ? { mode: "webhook" as const, webhook: over.webhook } : {}),
  });

  const rig: Rig = {
    fake,
    channel,
    host,
    hostLogs,
    ctorLogs,
    failures,
    errors,
    healths,
    sleeps,
    requested,
    injected,
    bodies,
    hits,
    arm: (method, fault, times = Infinity) => {
      const queue = armed.get(method) ?? [];
      queue.push({ fault, left: times });
      armed.set(method, queue);
    },
    probeHealth: async () => {
      const h = await channel.health();
      healths.push(h);
      const keys = Object.keys(h);
      assert.ok(keys.every((k) => k === "ok" || k === "detail"), `health keys: ${keys.join(",")}`);
      assert.equal(typeof h.ok, "boolean");
      return h as { ok: boolean; detail?: unknown };
    },
    attempt: async (run) => {
      try {
        return { value: await run() };
      } catch (error) {
        errors.push(error);
        return { error };
      }
    },
    waitFor: (pred, what) =>
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
      }),
    dispose: async () => {
      await channel.stop();
      await fake.close();
    },
  };
  return rig;
}

/** The same assertions after every path: nothing the channel emitted may contain the marker. */
function assertNothingLeaked(rig: Rig, label: string, needle: string = MARKER): void {
  const lines = (name: string, ls: Line[]) =>
    ls.forEach((l, i) => {
      assertClean(`${label}: ${name}[${i}] ${l.level} ${eventOf(l)}`, l, needle);
      for (const text of surfaces(l)) for (const u of urlsIn(text)) assert.ok(!contains(u, needle), `${label}: URL in ${name} line leaks`);
    });
  lines("host.log", rig.hostLogs);
  lines("constructor logger", rig.ctorLogs);
  rig.errors.forEach((e, i) => assertClean(`${label}: error[${i}] (message, stack, cause)`, e, needle));
  rig.failures.forEach((e, i) => assertClean(`${label}: host.fail[${i}]`, e, needle));
  rig.healths.forEach((h, i) => assertClean(`${label}: health()[${i}] (incl. detail)`, h, needle));
}

/** Non-vacuity: the secret was really in play (in the URLs the channel built and in the text the fault injected). */
function assertSecretWasInPlay(rig: Rig, fault: Fault, label: string): void {
  assert.ok(
    rig.requested.some((u) => contains(u)),
    `${label}: the channel never put the marker into a request URL`,
  );
  if (fault.carriesSecret)
    assert.ok(
      rig.injected.some((t) => contains(t)),
      `${label}: the injected fault did not carry the marker`,
    );
  if (fault.echoes !== undefined) {
    const echoed = fault.echoes;
    assert.ok(
      rig.injected.some((t) => contains(t, echoed)),
      `${label}: the injected fault did not carry the second credential`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Positive controls: the search cannot pass vacuously.

test("control: the marker is part of the planted secret and of the URL the channel builds", () => {
  assert.ok(contains(SECRET), "marker must be a substring of FAKE_TELEGRAM_TOKEN");
  assert.ok(contains(SECRET_HALF));
  assert.ok(contains(`https://api.telegram.org/bot${SECRET}/getMe`));
});

test("control: the scanner finds the marker wherever an output can carry it, and only there", () => {
  const url = `http://127.0.0.1:1/bot${SECRET}/getMe`;
  // plain strings and URLs
  assert.equal(hitsIn(`prefix ${MARKER} suffix`).length > 0, true);
  assert.equal(hitsIn(url).length > 0, true);
  assert.deepEqual(urlsIn(`GET ${url} failed`).filter((u) => contains(u)).length, 1);
  // errors: message, nested cause (Error, string, plain object), AggregateError
  assert.equal(hitsIn(new Error(`boom ${MARKER}`)).length > 0, true);
  assert.equal(hitsIn(new Error("outer", { cause: new Error(`inner ${MARKER}`) })).length > 0, true);
  assert.equal(hitsIn(new Error("outer", { cause: `text ${MARKER}` })).length > 0, true);
  assert.equal(hitsIn(new Error("outer", { cause: { code: url } })).length > 0, true);
  assert.equal(hitsIn(new AggregateError([new Error(MARKER)], "agg")).length > 0, true);
  assert.equal(hitsIn(Object.assign(new Error("x"), { detail: MARKER })).length > 0, true);
  // structured values: attrs values, keys, arrays, health detail
  assert.equal(hitsIn({ url }).length > 0, true);
  assert.equal(hitsIn({ [MARKER]: 1 }).length > 0, true);
  assert.equal(hitsIn([["a", { b: MARKER }]]).length > 0, true);
  assert.equal(hitsIn({ ok: false, detail: `down: ${url}` }).length > 0, true);
  // negative controls: clean values and a near miss are not flagged
  assert.equal(hitsIn("a clean line").length, 0);
  assert.equal(hitsIn(new Error("clean", { cause: new Error("also clean") })).length, 0);
  assert.equal(hitsIn({ ok: true }).length, 0);
  assert.equal(hitsIn("AAFakeToken ForTestsOnly").length, 0);
  assert.throws(() => assertClean("synthetic", new Error(`x ${MARKER}`)), /contains the marker/);
});

test("control: the rig scans both loggers and the host.fail channel (a planted marker is caught in each)", async () => {
  const rig = await makeRig();
  try {
    rig.host.log.info("probe", { url: `http://x/bot${SECRET}/getMe` });
    assert.throws(() => assertNothingLeaked(rig, "planted host.log"), /host\.log/);
    rig.hostLogs.length = 0;
    // The constructor logger is reached only through the channel, so provoke a real line and then plant into the capture.
    await rig.channel.start(rig.host);
    assert.ok(rig.ctorLogs.some((l) => eventOf(l) === "channel.telegram.started"), "ctor logger is wired");
    rig.ctorLogs.push({ level: "error", args: ["probe", { url: `http://x/bot${SECRET}/getMe` }] });
    assert.throws(() => assertNothingLeaked(rig, "planted ctor log"), /constructor logger/);
    rig.ctorLogs.pop();
    rig.failures.push(new Error(`planted ${MARKER}`));
    assert.throws(() => assertNothingLeaked(rig, "planted fail"), /host\.fail/);
    rig.failures.pop();
    rig.errors.push(new Error("outer", { cause: new Error(`planted ${MARKER}`) }));
    assert.throws(() => assertNothingLeaked(rig, "planted error"), /error\[0\]/);
    rig.errors.pop();
    rig.healths.push({ ok: false, detail: `planted ${MARKER}` });
    assert.throws(() => assertNothingLeaked(rig, "planted health"), /health\(\)/);
    rig.healths.pop();
    assertNothingLeaked(rig, "clean start"); // and the rig itself is clean again
  } finally {
    await rig.dispose();
  }
});

test("control: every fault that claims to carry the secret feeds the marker into the channel", () => {
  const url = `http://127.0.0.1:1/bot${SECRET}/getMe`;
  for (const f of [...FAULTS, ...ECHO_VARIANTS, WEBHOOK_ECHO]) {
    const made = f.make(url);
    assert.equal(contains(made.carried), f.carriesSecret, `fault carry flag: ${f.name}`);
    if (f.echoes !== undefined) assert.ok(contains(made.carried, f.echoes), `fault echo flag: ${f.name}`);
  }
});

test("control: a healthy run exposes the marker nowhere, and the info/warn/error levels of both loggers all occur", async () => {
  const rig = await makeRig();
  try {
    assert.deepEqual(await rig.probeHealth(), { ok: false });
    // warn from a poll failure, then error from a poll-time 401, with info from start and stop around them
    rig.arm("getUpdates", FAULTS[2]!, 1);
    rig.arm("getUpdates", FAULTS[0]!, 1);
    await rig.channel.start(rig.host);
    // No health assertion here: the faulted polls can finish (as microtasks) before start() resumes the caller.
    await rig.waitFor(() => rig.failures.length === 1, "host.fail after the poll-time 401");
    assert.deepEqual(await rig.probeHealth(), { ok: false });
    await rig.channel.stop();
    assert.deepEqual(await rig.probeHealth(), { ok: false });
    for (const [name, lines] of [
      ["host.log", rig.hostLogs],
      ["constructor logger", rig.ctorLogs],
    ] as const)
      for (const level of ["info", "warn", "error"])
        assert.ok(
          lines.some((l) => l.level === level),
          `${name} never saw a ${level} line`,
        );
    assert.ok(rig.ctorLogs.some((l) => l.level === "warn" && eventOf(l) === "channel.telegram.poll-failed"));
    assert.ok(rig.hostLogs.some((l) => l.level === "error" && eventOf(l) === "channel.telegram.auth-failed"));
    assertSecretWasInPlay(rig, FAULTS[2]!, "levels");
    assertNothingLeaked(rig, "levels");
  } finally {
    await rig.dispose();
  }
});

test("health(): shape is exactly {ok} before start, after start, after a failed start and after stop", async () => {
  const rig = await makeRig();
  try {
    assert.deepEqual(await rig.channel.health(), { ok: false });
    rig.arm("getMe", FAULTS[5]!, 1);
    await assert.rejects(rig.channel.start(rig.host));
    assert.deepEqual(await rig.channel.health(), { ok: false });
    await rig.channel.start(rig.host);
    assert.deepEqual(await rig.channel.health(), { ok: true });
    await rig.channel.stop();
    assert.deepEqual(await rig.channel.health(), { ok: false });
    assert.ok(!("detail" in (await rig.channel.health())), "no detail field is exposed");
  } finally {
    await rig.dispose();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Failure paths: operation x fault.

const RETRYABLE: TelegramErrorKind[] = ["rate-limited", "network", "timeout"];

async function runOp(op: Op, fault: Fault, rig: Rig): Promise<void> {
  const label = `${op} x ${fault.name}`;
  switch (op) {
    case "start(host) getMe":
    case "start(host) setMyCommands":
    case "start(host) deleteWebhook":
    case "start() standalone getMe": {
      const method = op.split(" ").at(-1)!;
      rig.arm(method, fault);
      assert.deepEqual(await rig.probeHealth(), { ok: false });
      const standalone = op.startsWith("start() ");
      const { error } = await rig.attempt(() => (standalone ? rig.channel.start() : rig.channel.start(rig.host)));
      if (standalone && fault.kind === "unauthorized") {
        // #157 compatibility: standalone auth failure resolves and is only logged (error level, constructor logger).
        assert.equal(error, undefined, "standalone start swallows an auth failure");
        assert.ok(rig.ctorLogs.some((l) => l.level === "error" && eventOf(l) === "channel.telegram.auth-failed"));
      } else {
        assert.ok(error instanceof TelegramApiError, `${label}: start must reject with a TelegramApiError`);
        assert.equal(error.kind, fault.kind);
      }
      assert.equal(rig.hits.get(method), 1, `${label}: the fault fired once`);
      assert.deepEqual(await rig.probeHealth(), { ok: false });
      break;
    }
    case "send sendMessage":
    case "send attachment sendDocument": {
      await rig.channel.start(rig.host);
      assert.deepEqual(await rig.probeHealth(), { ok: true });
      const method = op === "send sendMessage" ? "sendMessage" : "sendDocument";
      rig.arm(method, fault);
      const turn = { chatId: CHAT, text: "hello" };
      const { error } =
        method === "sendMessage"
          ? await rig.attempt(() => rig.channel.send(turn))
          : await rig.attempt(() =>
              rig.channel.sendTurn({
                ...turn,
                attachments: [{ kind: "document", data: new Uint8Array([1, 2, 3]), mimeType: "application/pdf", filename: "a.pdf" }],
              }),
            );
      assert.ok(error instanceof TelegramApiError, `${label}: send must reject with a TelegramApiError`);
      assert.equal(error.kind, fault.kind);
      // 5xx answers (kind "http") are retried like transport faults; other 4xx and protocol faults are final.
      const attempts = RETRYABLE.includes(fault.kind) || (fault.kind === "http" && (error.status ?? 0) >= 500) ? 3 : 1;
      assert.equal(rig.hits.get(method), attempts, `${label}: attempts`);
      if (attempts > 1)
        assert.equal(rig.ctorLogs.filter((l) => eventOf(l) === "channel.telegram.request-retry").length, attempts - 1);
      await rig.probeHealth();
      break;
    }
    case "poll getUpdates": {
      // Finite: with an immediate sleep seam an endless transport failure would be a pure microtask loop.
      const times = fault.kind === "unauthorized" ? 1 : 3;
      rig.arm("getUpdates", fault, times);
      await rig.channel.start(rig.host);
      if (fault.kind === "unauthorized") {
        await rig.waitFor(() => rig.failures.length === 1, `${label}: host.fail`);
        assert.ok(rig.hostLogs.some((l) => l.level === "error" && eventOf(l) === "channel.telegram.auth-failed"));
        assert.deepEqual(await rig.probeHealth(), { ok: false });
      } else {
        await rig.waitFor(
          () => rig.ctorLogs.filter((l) => eventOf(l) === "channel.telegram.poll-failed").length === times,
          `${label}: poll-failed lines`,
        );
        assert.ok(rig.hostLogs.some((l) => l.level === "warn" && eventOf(l) === "channel.telegram.poll-failed"));
        // Contract: health is false while polling fails at transport/server level; a 429 proves the connection is up.
        assert.deepEqual(await rig.probeHealth(), { ok: fault.kind === "rate-limited" });
      }
      assert.equal(rig.hits.get("getUpdates"), times, `${label}: the fault fired ${times} times`);
      break;
    }
    case "inbound file download": {
      rig.fake.files.set("f1", { path: "docs/a.pdf", mime: "application/pdf", data: Buffer.from("x") });
      rig.arm("download", fault);
      await rig.channel.start(rig.host);
      rig.fake.push({
        update_id: 500,
        message: {
          message_id: 5000,
          date: 1_700_000_000,
          caption: "see attached",
          chat: { id: Number(CHAT), type: "private" },
          from: { id: Number(CHAT) },
          document: { file_id: "f1", mime_type: "application/pdf", file_name: "a.pdf", file_size: 1 },
        },
      });
      await rig.waitFor(
        () => rig.ctorLogs.some((l) => eventOf(l) === "channel.telegram.media-rejected"),
        `${label}: media-rejected`,
      );
      assert.ok((rig.hits.get("download") ?? 0) >= 1, `${label}: the download fault fired`);
      assert.ok(rig.hostLogs.some((l) => l.level === "warn" && eventOf(l) === "channel.telegram.media-rejected"));
      assert.deepEqual(await rig.probeHealth(), { ok: true });
      break;
    }
  }
  await rig.channel.stop();
  assertSecretWasInPlay(rig, fault, label);
  assertNothingLeaked(rig, label);
}

const OPS: Op[] = [
  "start(host) getMe",
  "start(host) setMyCommands",
  "start(host) deleteWebhook",
  "start() standalone getMe",
  "send sendMessage",
  "send attachment sendDocument",
  "poll getUpdates",
  "inbound file download",
];

const title = (op: string, fault: Fault) => `${op} x ${fault.name}: the marker appears in no log line, error, cause, health or URL`;

for (const op of OPS)
  for (const fault of FAULTS) {
    test(title(op, fault), async () => {
      const rig = await makeRig();
      try {
        await runOp(op, fault, rig);
      } finally {
        await rig.dispose();
      }
    });
  }

// Echo shapes beyond the stated scenario. poll and download never put a Telegram description into any output, so they
// are here as the passing side of the same check.
const ECHO_OPS: Op[] = ["start(host) getMe", "send sendMessage", "poll getUpdates"];
for (const op of ECHO_OPS)
  for (const fault of ECHO_VARIANTS) {
    test(title(op, fault), async () => {
      const rig = await makeRig();
      try {
        await runOp(op, fault, rig);
      } finally {
        await rig.dispose();
      }
    });
  }

// ---------------------------------------------------------------------------------------------------------------------
// Second credential: the webhook secret that is part of the configuration in webhook mode.

const WEBHOOK_FAULTS: Fault[] = [
  FAULTS.find((f) => f.name.startsWith("401 unauthorized"))!,
  FAULTS.find((f) => f.name.startsWith("network failure with the URL"))!,
  FAULTS.find((f) => f.name.startsWith("502 with an HTML body"))!,
  FAULTS.find((f) => f.name.startsWith("429 whose description"))!,
  WEBHOOK_ECHO,
];

test("webhook mode: a healthy start sends the webhook secret and neither credential shows up in any output", async () => {
  const rig = await makeRig({ webhook: { url: "https://hooks.example.invalid/telegram", secret: WEBHOOK_SECRET } });
  try {
    await rig.channel.start(rig.host);
    assert.deepEqual(await rig.probeHealth(), { ok: true });
    const sent = rig.fake.callsOf("setWebhook");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.body.secret_token, WEBHOOK_SECRET, "the credential really travels to Telegram");
    await rig.channel.stop();
    assert.deepEqual(await rig.probeHealth(), { ok: false });
    assert.ok(rig.ctorLogs.some((l) => eventOf(l) === "channel.telegram.started"));
    assertNothingLeaked(rig, "webhook start");
    assertNothingLeaked(rig, "webhook start", WEBHOOK_SECRET);
  } finally {
    await rig.dispose();
  }
});

for (const fault of WEBHOOK_FAULTS) {
  test(title("start(host) webhook setWebhook", fault), async () => {
    const label = `webhook setWebhook x ${fault.name}`;
    const rig = await makeRig({ webhook: { url: "https://hooks.example.invalid/telegram", secret: WEBHOOK_SECRET } });
    try {
      rig.arm("setWebhook", fault);
      const { error } = await rig.attempt(() => rig.channel.start(rig.host));
      assert.ok(error instanceof TelegramApiError, `${label}: start must reject with a TelegramApiError`);
      assert.equal(error.kind, fault.kind);
      assert.equal(rig.hits.get("setWebhook"), 1);
      assert.ok(
        rig.bodies.some((b) => contains(b, WEBHOOK_SECRET)),
        `${label}: the webhook secret was sent in the request body`,
      );
      assert.deepEqual(await rig.probeHealth(), { ok: false });
      await rig.channel.stop();
      assertSecretWasInPlay(rig, fault, label);
      assertNothingLeaked(rig, label);
      assertNothingLeaked(rig, label, WEBHOOK_SECRET);
    } finally {
      await rig.dispose();
    }
  });
}
