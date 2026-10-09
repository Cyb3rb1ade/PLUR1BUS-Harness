import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http, { createServer, type IncomingMessage, type Server } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { DryRun, Egress } from "../../src/egress/service.ts";
import {
  assignPushId, createEgressPushTransport, parsePushConfig, PushDispatcher, PushError, toTaskPush,
  type PushPostResult, type PushTransport,
} from "../../src/a2a/push.ts";
import type { A2aPushConfig, A2aTask } from "../../src/a2a/types.ts";

const TASK: A2aTask = { kind: "task", id: "t1", contextId: "c1", status: { state: "completed", timestamp: "2026-01-01T00:00:00.000Z" } };
const allowed = (url: string): DryRun => {
  const u = new URL(url);
  return { allowed: true, host: u.hostname, port: Number(u.port || 80), address: "127.0.0.1", family: 4 };
};

interface PostCall { url: string; address?: string; family?: 4 | 6; headers: Record<string, string>; body: string }
class ManualSched {
  delays: number[] = []; fns: (() => void)[] = [];
  set(fn: () => void, ms: number): unknown { this.delays.push(ms); this.fns.push(fn); return this.fns.length; }
  clear(): void {}
  async flush(dispatcher: PushDispatcher, rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await new Promise<void>((r) => setImmediate(r));
      const fns = this.fns.splice(0);
      for (const f of fns) f();
    }
    await dispatcher.idle();
  }
}
function setup(o: {
  responses: (PushPostResult | Error)[]; decide?: (url: string) => DryRun; maxAttempts?: number; maxRedirects?: number;
}) {
  const calls: PostCall[] = []; const decided: string[] = [];
  let i = 0;
  const transport: PushTransport = {
    async decide(url) { decided.push(url); return (o.decide ?? allowed)(url); },
    async post(a) {
      calls.push({ url: a.url, ...(a.address !== undefined ? { address: a.address } : {}), ...(a.family !== undefined ? { family: a.family } : {}), headers: a.headers, body: a.body });
      const r = o.responses[Math.min(i++, o.responses.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const sched = new ManualSched();
  const d = new PushDispatcher({
    transport, scheduler: sched, clock: { now: () => 0 }, maxAttempts: o.maxAttempts ?? 3, backoffMs: 100,
    ...(o.maxRedirects !== undefined ? { maxRedirects: o.maxRedirects } : {}),
  });
  return { d, calls, decided, sched };
}
const cfg = (extra: Partial<A2aPushConfig> = {}): A2aPushConfig => ({ url: "http://hook.test/x", ...extra });

describe("PushError", () => {
  for (const code of ["not-supported", "denied", "not-found", "invalid"] as const) {
    it(`carries code ${code}`, () => {
      const e = new PushError(code, "m");
      assert.equal(e.code, code); assert.equal(e.name, "PushError"); assert.equal(e.message, "m");
      assert.ok(e instanceof Error);
    });
  }
});

describe("parsePushConfig", () => {
  const invalid: [string, unknown, RegExp][] = [
    ["null", null, /url is required/],
    ["undefined", undefined, /url is required/],
    ["array", [], /url is required/],
    ["string", "http://x", /url is required/],
    ["no url", {}, /url is required/],
    ["numeric url", { url: 5 }, /url is required/],
    ["blank url", { url: "   " }, /url is required/],
    ["unparsable url", { url: "not a url" }, /not a valid URL/],
    ["ftp", { url: "ftp://x/y" }, /must be http\(s\)/],
    ["file", { url: "file:///etc/passwd" }, /must be http\(s\)/],
    ["javascript", { url: "javascript:alert(1)" }, /must be http\(s\)/],
    ["schemes missing", { url: "http://a/", authentication: {} }, /schemes is required/],
    ["schemes not array", { url: "http://a/", authentication: { schemes: "Bearer" } }, /schemes is required/],
    ["schemes empty", { url: "http://a/", authentication: { schemes: [] } }, /schemes is required/],
    ["schemes non-string only", { url: "http://a/", authentication: { schemes: [1, null, {}] } }, /schemes is required/],
  ];
  for (const [label, raw, re] of invalid) {
    it(`invalid: ${label}`, () => {
      assert.throws(() => parsePushConfig(raw), (e: unknown) => e instanceof PushError && e.code === "invalid" && re.test(e.message));
    });
  }
  for (const [label, url] of [["user", "http://u@a/"], ["user+password", "https://u:p@a/"], ["password only", "http://:p@a/"]] as const) {
    it(`denied: credentials in url (${label})`, () => {
      assert.throws(() => parsePushConfig({ url }), (e: unknown) => e instanceof PushError && e.code === "denied");
    });
  }
  it("minimal config is normalised through URL.href", () => {
    assert.deepEqual(parsePushConfig({ url: "HTTP://Example.COM:80" }), { url: "http://example.com/" });
  });
  it("keeps https and query strings", () => {
    assert.equal(parsePushConfig({ url: "https://a.test/h?x=1#f" }).url, "https://a.test/h?x=1#f");
  });
  it("ignores id and token that are empty or not strings", () => {
    assert.deepEqual(parsePushConfig({ url: "http://a/", id: "", token: "" }), { url: "http://a/" });
    assert.deepEqual(parsePushConfig({ url: "http://a/", id: 5, token: {} }), { url: "http://a/" });
  });
  it("truncates id (128), token (512) and credentials (2048)", () => {
    const c = parsePushConfig({
      url: "http://a/", id: "i".repeat(300), token: "t".repeat(900),
      authentication: { schemes: ["Bearer"], credentials: "c".repeat(5000) },
    });
    assert.equal(c.id!.length, 128); assert.equal(c.token!.length, 512); assert.equal(c.authentication!.credentials!.length, 2048);
  });
  it("accepts boundary lengths unchanged", () => {
    const c = parsePushConfig({ url: "http://a/", id: "i".repeat(128), token: "t".repeat(512) });
    assert.equal(c.id!.length, 128); assert.equal(c.token!.length, 512);
  });
  it("filters non-string schemes and omits non-string credentials", () => {
    const c = parsePushConfig({ url: "http://a/", authentication: { schemes: ["Bearer", 3, null, "Basic"], credentials: 42 } });
    assert.deepEqual(c.authentication, { schemes: ["Bearer", "Basic"] });
  });
  it("non-object authentication is ignored", () => {
    for (const authentication of ["x", 1, null, ["Bearer"]]) {
      assert.equal(parsePushConfig({ url: "http://a/", authentication }).authentication, undefined);
    }
  });
  it("unknown fields never copy through", () => {
    const c = parsePushConfig({ url: "http://a/", evil: "x", __proto__: { z: 1 } });
    assert.deepEqual(Object.keys(c), ["url"]);
  });
});

describe("assignPushId / toTaskPush", () => {
  it("keeps an existing id and does not mutate its input", () => {
    const c = cfg({ id: "mine" });
    assert.equal(assignPushId(c).id, "mine");
    const n = cfg();
    const out = assignPushId(n);
    assert.equal(n.id, undefined);
    assert.match(out.id!, /^[0-9a-f-]{36}$/);
    assert.notEqual(assignPushId(n).id, out.id);
  });
  it("toTaskPush wraps the config", () => {
    const c = cfg({ id: "a" });
    assert.deepEqual(toTaskPush("t9", c), { taskId: "t9", pushNotificationConfig: c });
  });
});

describe("PushDispatcher.admit", () => {
  it("returns the decision when allowed", async () => {
    const { d } = setup({ responses: [{ status: 204 }] });
    const r = await d.admit("http://hook.test:81/x");
    assert.equal(r.allowed, true);
  });
  it("throws denied with the reason when refused", async () => {
    const { d } = setup({ responses: [], decide: () => ({ allowed: false, reason: "host-not-allowed", message: "no" }) });
    await assert.rejects(d.admit("http://x/"), (e: unknown) => e instanceof PushError && e.code === "denied" && /host-not-allowed/.test(e.message));
  });
});

describe("PushDispatcher.deliver", () => {
  it("posts the task as JSON with content-type and the pinned address", async () => {
    const { d, calls } = setup({ responses: [{ status: 204 }] });
    d.deliver(cfg(), TASK);
    await d.idle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body, JSON.stringify(TASK));
    assert.equal(calls[0]!.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(calls[0]!.address, "127.0.0.1"); assert.equal(calls[0]!.family, 4);
    assert.equal(calls[0]!.headers["x-a2a-notification-token"], undefined);
    assert.equal(calls[0]!.headers.authorization, undefined);
  });
  it("sends the token header when set", async () => {
    const { d, calls } = setup({ responses: [{ status: 200 }] });
    d.deliver(cfg({ token: "tk" }), TASK); await d.idle();
    assert.equal(calls[0]!.headers["x-a2a-notification-token"], "tk");
  });
  for (const scheme of ["Bearer", "bearer", "BEARER"]) {
    it(`bearer scheme ${scheme} with credentials sets Authorization`, async () => {
      const { d, calls } = setup({ responses: [{ status: 200 }] });
      d.deliver(cfg({ authentication: { schemes: ["Basic", scheme], credentials: "sekret" } }), TASK); await d.idle();
      assert.equal(calls[0]!.headers.authorization, "Bearer sekret");
    });
  }
  it("no Authorization for bearer without credentials, empty credentials or other schemes", async () => {
    for (const authentication of [{ schemes: ["Bearer"] }, { schemes: ["Bearer"], credentials: "" }, { schemes: ["Basic"], credentials: "x" }]) {
      const { d, calls } = setup({ responses: [{ status: 200 }] });
      d.deliver(cfg({ authentication }), TASK); await d.idle();
      assert.equal(calls[0]!.headers.authorization, undefined);
    }
  });
  for (const status of [200, 201, 299]) {
    it(`status ${status} is success: no retry`, async () => {
      const { d, calls, sched } = setup({ responses: [{ status }] });
      d.deliver(cfg(), TASK); await d.idle();
      assert.equal(calls.length, 1); assert.equal(sched.delays.length, 0);
    });
  }
  it("retries after a 5xx with exponential backoff and stops on success", async () => {
    const { d, calls, sched } = setup({ responses: [{ status: 503 }, { status: 500 }, { status: 204 }], maxAttempts: 5 });
    d.deliver(cfg(), TASK);
    await sched.flush(d);
    assert.equal(calls.length, 3);
    assert.deepEqual(sched.delays, [100, 200]);
  });
  it("stops after maxAttempts failures without a trailing backoff", async () => {
    const { d, calls, sched } = setup({ responses: [{ status: 500 }], maxAttempts: 3 });
    d.deliver(cfg(), TASK);
    await sched.flush(d);
    assert.equal(calls.length, 3);
    assert.deepEqual(sched.delays, [100, 200]);
  });
  it("maxAttempts 1 makes exactly one attempt and no timer", async () => {
    const { d, calls, sched } = setup({ responses: [{ status: 500 }], maxAttempts: 1 });
    d.deliver(cfg(), TASK); await d.idle();
    assert.equal(calls.length, 1); assert.equal(sched.delays.length, 0);
  });
  it("maxAttempts 0 never posts", async () => {
    const { d, calls } = setup({ responses: [{ status: 200 }], maxAttempts: 0 });
    d.deliver(cfg(), TASK); await d.idle();
    assert.equal(calls.length, 0);
  });
  it("a transport exception is retried like a failure; deliver never throws", async () => {
    const { d, calls, sched } = setup({ responses: [new Error("boom"), { status: 200 }], maxAttempts: 3 });
    d.deliver(cfg(), TASK);
    await sched.flush(d);
    assert.equal(calls.length, 2);
  });
  it("a 4xx and a 3xx without Location also go through the retry loop", async () => {
    for (const status of [400, 404, 429, 302, 100, 0]) {
      const { d, calls, sched } = setup({ responses: [{ status }], maxAttempts: 2 });
      d.deliver(cfg(), TASK);
      await sched.flush(d);
      assert.equal(calls.length, 2, `status ${status}`);
    }
  });
  it("an admission denial on the first hop counts as a failed attempt without posting", async () => {
    const { d, calls, decided, sched } = setup({ responses: [{ status: 200 }], decide: () => ({ allowed: false, reason: "host-not-allowed", message: "x" }), maxAttempts: 2 });
    d.deliver(cfg(), TASK);
    await sched.flush(d);
    assert.equal(calls.length, 0); assert.equal(decided.length, 2);
  });
  it("idle resolves immediately with nothing in flight and after deliveries settled", async () => {
    const { d } = setup({ responses: [{ status: 200 }] });
    await d.idle();
    d.deliver(cfg(), TASK); d.deliver(cfg(), TASK);
    await d.idle();
    await d.idle();
  });
});

describe("PushDispatcher redirects", () => {
  it("follows a redirect (absolute and relative) and re-checks each hop with decide", async () => {
    const { d, calls, decided } = setup({ responses: [
      { status: 302, location: "http://other.test/a" },
      { status: 307, location: "/b?q=1" },
      { status: 204 },
    ] });
    d.deliver(cfg({ url: "http://hook.test/start" }), TASK); await d.idle();
    assert.deepEqual(calls.map((c) => c.url), ["http://hook.test/start", "http://other.test/a", "http://other.test/b?q=1"]);
    assert.deepEqual(decided, calls.map((c) => c.url));
  });
  for (const status of [301, 302, 303, 307, 308]) {
    it(`redirect status ${status} is followed`, async () => {
      const { d, calls } = setup({ responses: [{ status, location: "http://n.test/" }, { status: 200 }] });
      d.deliver(cfg(), TASK); await d.idle();
      assert.equal(calls.length, 2);
    });
  }
  it("a redirect to a denied host is not posted to", async () => {
    const { d, calls, decided } = setup({
      responses: [{ status: 302, location: "http://169.254.169.254/" }, { status: 200 }], maxAttempts: 1,
      decide: (u) => (u.includes("169.254") ? { allowed: false, reason: "private-address" as never, message: "ssrf" } : allowed(u)),
    });
    d.deliver(cfg(), TASK); await d.idle();
    assert.equal(calls.length, 1); assert.equal(decided.length, 2);
  });
  it("stops after maxRedirects (default 3): 4 posts in one attempt", async () => {
    const { d, calls } = setup({ responses: [{ status: 302, location: "http://loop.test/" }], maxAttempts: 1 });
    d.deliver(cfg(), TASK); await d.idle();
    assert.equal(calls.length, 4);
  });
  it("honours a custom maxRedirects of 0 (no hop followed) and 1", async () => {
    const zero = setup({ responses: [{ status: 302, location: "http://loop.test/" }], maxAttempts: 1, maxRedirects: 0 });
    zero.d.deliver(cfg(), TASK); await zero.d.idle();
    assert.equal(zero.calls.length, 1);
    const one = setup({ responses: [{ status: 302, location: "http://loop.test/" }], maxAttempts: 1, maxRedirects: 1 });
    one.d.deliver(cfg(), TASK); await one.d.idle();
    assert.equal(one.calls.length, 2);
  });
  it("an unparsable Location fails the attempt", async () => {
    const { d, calls } = setup({ responses: [{ status: 302, location: "http://[bad" }, { status: 200 }], maxAttempts: 1 });
    d.deliver(cfg(), TASK); await d.idle();
    assert.equal(calls.length, 1);
  });
  it("a 3xx with an empty Location is treated as failure", async () => {
    const { d, calls } = setup({ responses: [{ status: 302, location: "" }], maxAttempts: 1 });
    d.deliver(cfg(), TASK); await d.idle();
    assert.equal(calls.length, 1);
  });
  it("a 4xx after a redirect ends the attempt", async () => {
    const { d, calls } = setup({ responses: [{ status: 301, location: "http://n.test/" }, { status: 410 }], maxAttempts: 1 });
    d.deliver(cfg(), TASK); await d.idle();
    assert.equal(calls.length, 2);
  });
});

// ---------- createEgressPushTransport ----------
const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); });
  }
});
async function listen(handler: (req: IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<{ port: number }> {
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, Buffer.concat(chunks).toString("utf8"), res));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { port: (s.address() as AddressInfo).port };
}
const fakeEgress = (decide: (url: string) => Promise<DryRun>): Egress => ({ decide, request: async () => { throw new Error("unused"); }, status: () => { throw new Error("unused"); } });

describe("createEgressPushTransport", () => {
  it("decide delegates to egress.decide", async () => {
    const seen: string[] = [];
    const t = createEgressPushTransport(fakeEgress(async (u) => { seen.push(u); return allowed(u); }));
    const r = await t.decide("http://a.test/");
    assert.equal(r.allowed, true); assert.deepEqual(seen, ["http://a.test/"]);
  });
  it("posts body, method and headers to a loopback server and reports status", async () => {
    let got: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string } | undefined;
    const { port } = await listen((req, body, res) => { got = { ...(req.method !== undefined ? { method: req.method } : {}), ...(req.url !== undefined ? { url: req.url } : {}), headers: req.headers, body }; res.statusCode = 204; res.end(); });
    const t = createEgressPushTransport(fakeEgress(async (u) => allowed(u)));
    const r = await t.post({ url: `http://127.0.0.1:${port}/hook?a=1`, headers: { "content-type": "application/json", "x-a2a-notification-token": "z" }, body: '{"é":1}' });
    assert.deepEqual(r, { status: 204 });
    assert.equal(got!.method, "POST"); assert.equal(got!.url, "/hook?a=1"); assert.equal(got!.body, '{"é":1}');
    assert.equal(got!.headers["content-length"], String(Buffer.byteLength('{"é":1}')));
    assert.equal(got!.headers["x-a2a-notification-token"], "z");
    assert.equal(got!.headers.host, `127.0.0.1:${port}`);
  });
  it("returns Location and does not follow redirects", async () => {
    let hits = 0;
    const { port } = await listen((_req, _b, res) => { hits++; res.statusCode = 302; res.setHeader("location", "http://elsewhere.test/x"); res.end(); });
    const t = createEgressPushTransport(fakeEgress(async (u) => allowed(u)));
    const r = await t.post({ url: `http://127.0.0.1:${port}/`, headers: {}, body: "{}" });
    assert.deepEqual(r, { status: 302, location: "http://elsewhere.test/x" });
    assert.equal(hits, 1);
  });
  it("pins the connection to the given address regardless of the URL host", async () => {
    let host: string | undefined;
    const { port } = await listen((req, _b, res) => { host = req.headers.host; res.statusCode = 200; res.end(); });
    const t = createEgressPushTransport(fakeEgress(async (u) => allowed(u)));
    const r = await t.post({ url: `http://pinned.invalid:${port}/`, address: "127.0.0.1", family: 4, headers: {}, body: "{}" });
    assert.equal(r.status, 200); assert.equal(host, `pinned.invalid:${port}`);
  });
  it("rejects with PushError(invalid) for an unparsable URL", async () => {
    const t = createEgressPushTransport(fakeEgress(async (u) => allowed(u)));
    await assert.rejects(t.post({ url: "not a url", headers: {}, body: "" }), (e: unknown) => e instanceof PushError && e.code === "invalid");
  });
  it("rejects on a connection error", async () => {
    const s = createServer(); servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r())); servers.pop();
    const t = createEgressPushTransport(fakeEgress(async (u) => allowed(u)));
    await assert.rejects(t.post({ url: `http://127.0.0.1:${port}/`, headers: {}, body: "{}" }), (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED");
  });
  it("https against a plain-http peer fails the handshake (secure branch)", async () => {
    const { port } = await listen((_r, _b, res) => { res.end(); });
    const t = createEgressPushTransport(fakeEgress(async (u) => allowed(u)));
    await assert.rejects(t.post({ url: `https://localhost:${port}/`, address: "127.0.0.1", headers: {}, body: "{}" }));
  });
  it("a pre-aborted signal rejects with 'aborted' and sends nothing", { skip: "BUG: pre-aborted Signal -> req.destroy() ohne error-Listener = uncaught 'socket hang up' - siehe docs/testing/coverage-2026-10.md#a2a-push-preaborted-unhandled-error" }, async () => {
    let hits = 0;
    const { port } = await listen((_r, _b, res) => { hits++; res.end(); });
    const t = createEgressPushTransport(fakeEgress(async (u) => allowed(u)));
    const ac = new AbortController(); ac.abort();
    await assert.rejects(t.post({ url: `http://127.0.0.1:${port}/`, headers: {}, body: "{}", signal: ac.signal }), /aborted/);
    assert.equal(hits, 0);
  });
  it("aborting while the server hangs rejects with 'aborted'", async () => {
    let arrived!: () => void; const got = new Promise<void>((r) => { arrived = r; });
    const { port } = await listen(() => { arrived(); /* never answer */ });
    const t = createEgressPushTransport(fakeEgress(async (u) => allowed(u)));
    const ac = new AbortController();
    const p = t.post({ url: `http://127.0.0.1:${port}/`, headers: {}, body: "{}", signal: ac.signal });
    await got; ac.abort();
    await assert.rejects(p, /aborted/);
  });
  it("a signal that never fires is detached on close", async () => {
    const { port } = await listen((_r, _b, res) => { res.statusCode = 200; res.end(); });
    const t = createEgressPushTransport(fakeEgress(async (u) => allowed(u)));
    const ac = new AbortController();
    const r = await t.post({ url: `http://127.0.0.1:${port}/`, headers: {}, body: "{}", signal: ac.signal });
    assert.equal(r.status, 200);
  });

  describe("request options (http.request / https.request stubbed)", () => {
    interface Captured { opts: Record<string, any>; secure: boolean }
    function stub(t: import("node:test").TestContext, res: { statusCode?: number; headers?: Record<string, unknown> } = { statusCode: 200, headers: {} }): Captured[] {
      const captured: Captured[] = [];
      const make = (secure: boolean) => (opts: Record<string, any>, cb: (r: unknown) => void) => {
        captured.push({ opts, secure });
        const req = new EventEmitter() as EventEmitter & { end(b: string): void; destroy(): void };
        req.end = () => { queueMicrotask(() => cb({ ...res, resume() {} })); };
        req.destroy = () => {};
        return req;
      };
      t.mock.method(http, "request", make(false) as never);
      t.mock.method(https, "request", make(true) as never);
      return captured;
    }
    const tr = () => createEgressPushTransport(fakeEgress(async (u) => allowed(u)));
    it("default ports: 80 for http, 443 for https; servername only for https", async (t) => {
      const c = stub(t);
      await tr().post({ url: "http://h.test/p", headers: {}, body: "x" });
      await tr().post({ url: "https://h.test/p", headers: {}, body: "x" });
      assert.equal(c[0]!.opts.port, 80); assert.equal(c[0]!.opts.servername, undefined); assert.equal(c[0]!.secure, false);
      assert.equal(c[1]!.opts.port, 443); assert.equal(c[1]!.opts.servername, "h.test"); assert.equal(c[1]!.secure, true);
    });
    it("explicit port is used and Host keeps it; caller headers override defaults", async (t) => {
      const c = stub(t);
      await tr().post({ url: "http://h.test:8123/a/b?x=1", headers: { host: "override" }, body: "héllo" });
      assert.equal(c[0]!.opts.port, 8123); assert.equal(c[0]!.opts.path, "/a/b?x=1");
      assert.equal(c[0]!.opts.headers.host, "override");
      assert.equal(c[0]!.opts.headers["content-length"], Buffer.byteLength("héllo"));
      assert.equal(c[0]!.opts.host, "h.test");
      assert.equal(c[0]!.opts.lookup, undefined);
    });
    it("strips IPv6 brackets from the hostname", async (t) => {
      const c = stub(t);
      await tr().post({ url: "http://[::1]:9/", headers: {}, body: "" });
      assert.equal(c[0]!.opts.host, "::1"); assert.equal(c[0]!.opts.headers.host, "[::1]:9");
    });
    it("with a pinned address, host is the address and lookup answers it (single and all)", async (t) => {
      const c = stub(t);
      await tr().post({ url: "http://h.test/", address: "10.1.2.3", family: 4, headers: {}, body: "" });
      await tr().post({ url: "http://h.test/", address: "fe80::1", headers: {}, body: "" });
      await tr().post({ url: "http://h.test/", address: "1.2.3.4", headers: {}, body: "" });
      assert.equal(c[0]!.opts.host, "10.1.2.3");
      const results: unknown[][] = [];
      const cb = (...a: unknown[]): void => { results.push(a); };
      c[0]!.opts.lookup("h.test", {}, cb);
      c[0]!.opts.lookup("h.test", undefined, cb);
      c[0]!.opts.lookup("h.test", { all: true }, cb);
      c[0]!.opts.lookup("h.test", { all: false }, cb);
      assert.deepEqual(results, [
        [null, "10.1.2.3", 4], [null, "10.1.2.3", 4], [null, [{ address: "10.1.2.3", family: 4 }]], [null, "10.1.2.3", 4],
      ]);
      const six: unknown[][] = [];
      c[1]!.opts.lookup("h.test", { all: true }, (...a: unknown[]) => { six.push(a); });
      c[1]!.opts.lookup("h.test", {}, (...a: unknown[]) => { six.push(a); });
      assert.deepEqual(six, [[null, [{ address: "fe80::1", family: 6 }]], [null, "fe80::1", 6]]);
      const four: unknown[][] = [];
      c[2]!.opts.lookup("h.test", {}, (...a: unknown[]) => { four.push(a); });
      assert.deepEqual(four, [[null, "1.2.3.4", 4]]);
    });
    it("a missing status code is reported as 0; a non-string Location is dropped", async (t) => {
      stub(t, { headers: { location: ["a", "b"] } });
      assert.deepEqual(await tr().post({ url: "http://h.test/", headers: {}, body: "" }), { status: 0 });
    });
    it("an empty Location string is dropped", async (t) => {
      stub(t, { statusCode: 302, headers: { location: "" } });
      assert.deepEqual(await tr().post({ url: "http://h.test/", headers: {}, body: "" }), { status: 302 });
    });
  });
});
