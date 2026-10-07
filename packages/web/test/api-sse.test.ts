import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { backoffDelay, createApi, SseParser, type Api, type EventsHandle, type EventsStatus, type SseEvent } from "../src/api/index.ts";
import { HttpSessionApi } from "../src/session.ts";
import { cookieFetch, MockHarnessServer, OWNER_TOKEN } from "./mock-server.ts";

function parseAll(chunks: string[]): SseEvent[] {
  const p = new SseParser();
  return chunks.flatMap((c) => p.push(c));
}

test("parser: event, data and id fields; multi-line data joins with a newline; comments are skipped", () => {
  const out = parseAll([": hello\nevent: session.event\nid: 7\ndata: line one\ndata: line two\n\ndata: {\"a\":1}\n\n"]);
  assert.deepEqual(out, [
    { event: "session.event", data: "line one\nline two", id: "7" },
    { event: "message", data: "{\"a\":1}", id: "7" }, // the last event id persists until a new one is set
  ]);
});

test("parser: any chunk boundary gives the same events, even in the middle of a field name, a value or CRLF", () => {
  const text = "event: a\r\nid: 1\r\ndata: x\r\ndata: y\r\n\r\n: c\n\nevent: b\ndata:z\n\n\u{1F600}";
  const whole = parseAll([text]);
  assert.equal(whole.length, 2);
  assert.deepEqual(whole[0], { event: "a", data: "x\ny", id: "1" });
  assert.deepEqual(whole[1], { event: "b", data: "z", id: "1" });
  for (let i = 1; i < text.length; i++) assert.deepEqual(parseAll([text.slice(0, i), text.slice(i)]), whole, `split at ${i}`);
  assert.deepEqual(parseAll([...text]), whole, "one character at a time");
});

test("parser: a lone CR is a line end, a leading BOM and one space after the colon are dropped, an unknown field is ignored", () => {
  assert.deepEqual(parseAll(["﻿data: a\r\rdata:  b\n\nfoo: bar\ndata\n\n"]), [
    { event: "message", data: "a" },
    { event: "message", data: " b" },
    { event: "message", data: "" },
  ]);
});

test("parser: an event without data is not dispatched; an id with NUL is ignored", () => {
  assert.deepEqual(parseAll(["event: x\n\n", "id: a\u0000b\ndata: 1\n\n"]), [{ event: "message", data: "1" }]);
});

test("backoff: exponential, capped, jittered between half and full", () => {
  const o = { baseMs: 500, maxMs: 4000 };
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((n) => backoffDelay(n, o, () => 1)), [500, 1000, 2000, 4000, 4000, 4000]);
  assert.deepEqual([0, 1, 2].map((n) => backoffDelay(n, o, () => 0)), [250, 500, 1000]);
});

type Ctx = { s: MockHarnessServer; api: Api; delays: number[]; statuses: EventsStatus[]; got: SseEvent[]; start(opts?: { signal?: AbortSignal; lastEventId?: string }): EventsHandle };

async function withEvents(run: (c: Ctx) => Promise<void>, opts: { login?: boolean; onSleep?: (ms: number, n: number) => void } = {}): Promise<void> {
  const s = new MockHarnessServer({ distDir: tmpdir() });
  const base = await s.start();
  const handles: EventsHandle[] = [];
  try {
    const f = cookieFetch();
    if (opts.login !== false) await new HttpSessionApi(base, f).login({ token: OWNER_TOKEN });
    const delays: number[] = [];
    const api = createApi({
      baseUrl: base, fetch: f, random: () => 1,
      sleep: async (ms) => { delays.push(ms); opts.onSleep?.(ms, delays.length); await new Promise<void>((r) => setImmediate(r)); },
    });
    const statuses: EventsStatus[] = [];
    const got: SseEvent[] = [];
    const start = (o: { signal?: AbortSignal; lastEventId?: string } = {}): EventsHandle => {
      const h = api.events({ ...o, onEvent: (e) => { got.push(e); } });
      h.status.subscribe((v) => { if (statuses.at(-1) !== v) statuses.push(v); });
      handles.push(h);
      return h;
    };
    await run({ s, api, delays, statuses, got, start });
  } finally { for (const h of handles) h.close(); await s.stop(); }
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 5000) throw new Error(`timeout waiting for ${what}`);
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

test("events: connects with the session cookie, delivers pushed events, status goes connecting -> open", async () => {
  await withEvents(async ({ s, start, got, statuses }) => {
    s.events.enable();
    const h = start();
    assert.equal(h.status.value, "connecting");
    await s.events.waitForConnections(1);
    await until(() => h.status.value === "open", "open");
    s.events.push({ event: "session.event", data: { sessionId: "s1", n: 1 } });
    s.events.push({ event: "models.changed", data: "multi\nline" });
    await until(() => got.length === 2, "two events");
    assert.deepEqual(got.map((e) => [e.event, e.id]), [["session.event", "1"], ["models.changed", "2"]]);
    assert.deepEqual(JSON.parse(got[0]!.data), { sessionId: "s1", n: 1 });
    assert.equal(got[1]!.data, "multi\nline");
    assert.deepEqual(statuses, ["connecting", "open"]);
    const req = s.requests.find((q) => q.url === "/events")!;
    assert.ok(req.hasCookie);
  });
});

test("events: chunk boundaries in the middle of a field survive the real stream", async () => {
  await withEvents(async ({ s, start, got }) => {
    s.events.enable();
    start();
    await s.events.waitForConnections(1);
    await s.events.pushRaw(["ev", "ent: x\nda", "ta: hel", "lo\n", "\n"]);
    await until(() => got.length === 1, "event");
    assert.deepEqual(got[0], { event: "x", data: "hello" });
  });
});

test("events: a dropped connection retries with exponential backoff and resumes with Last-Event-ID", async () => {
  await withEvents(async ({ s, start, got, statuses, delays }) => {
    s.events.enable();
    const h = start();
    await s.events.waitForConnections(1);
    s.events.push({ event: "e", data: "1" });
    s.events.push({ event: "e", data: "2" });
    await until(() => got.length === 2, "first two");
    s.events.dropConnections();
    await s.events.waitForConnections(2);
    assert.equal(s.events.connections[1]!.lastEventId, "2");
    assert.equal(s.events.connections[0]!.lastEventId, null);
    s.events.push({ event: "e", data: "3" });
    await until(() => got.length === 3, "third");
    assert.equal(got[2]!.data, "3");
    assert.deepEqual(delays, [500]);
    assert.deepEqual(statuses, ["connecting", "open", "retrying", "open"]);
    h.close();
  });
});

test("events: while the server refuses, the delays double up to the cap; a successful open resets them", async () => {
  await withEvents(async ({ s, start, delays, statuses }) => {
    s.events.enable();
    s.events.refuse(503);
    const h = start();
    await until(() => delays.length >= 7, "seven retries");
    assert.deepEqual(delays.slice(0, 7), [500, 1000, 2000, 4000, 8000, 16000, 30000]);
    assert.ok(statuses.every((v) => v === "connecting" || v === "retrying"));
    s.events.refuse(null);
    await until(() => h.status.value === "open", "open again");
    const n = delays.length;
    s.events.dropConnections();
    await until(() => delays.length > n, "next retry");
    assert.equal(delays[n], 500, "the counter restarted");
  });
});

test("events: close() and an AbortSignal end the stream without a reconnect", async () => {
  await withEvents(async ({ s, start, delays, statuses }) => {
    s.events.enable();
    const ac = new AbortController();
    const h = start({ signal: ac.signal });
    await s.events.waitForConnections(1);
    await until(() => h.status.value === "open", "open");
    ac.abort();
    assert.equal(await h.done, null);
    assert.equal(h.status.value, "closed");
    await new Promise<void>((r) => setTimeout(r, 50));
    assert.equal(s.events.connections.length, 1);
    assert.deepEqual(delays, []);
    assert.deepEqual(statuses.slice(-1), ["closed"]);
    const h2 = start({ signal: AbortSignal.abort() });
    assert.equal(await h2.done, null);
    assert.equal(s.events.connections.length, 1, "no connection for an aborted signal");
    const h3 = start();
    await until(() => s.events.connections.length === 2, "second connection");
    h3.close();
    assert.equal(await h3.done, null);
  });
});

test("events: abort during the backoff sleep stops the loop", async () => {
  const ac = new AbortController();
  await withEvents(async ({ s, start, delays }) => {
    s.events.enable();
    s.events.refuse(503);
    const h = start({ signal: ac.signal });
    assert.equal(await h.done, null);
    assert.equal(delays.length, 2);
    assert.equal(h.status.value, "closed");
  }, { onSleep: (_ms, n) => { if (n === 2) ac.abort(); } });
});

test("events: 401 and 403 end the stream with an error instead of reconnecting forever", async () => {
  await withEvents(async ({ s, start, delays }) => {
    s.events.enable();
    s.events.refuse(401);
    const h = start();
    const err = await h.done;
    assert.equal(err?.kind, "unauthenticated");
    assert.equal(h.status.value, "closed");
    s.events.refuse(403);
    const h2 = start();
    assert.equal((await h2.done)?.kind, "forbidden");
    assert.deepEqual(delays, []);
  });
  await withEvents(async ({ s, start, delays }) => {
    s.events.enable();
    const err = await start().done; // no session at all
    assert.equal(err?.kind, "unauthenticated");
    assert.deepEqual(delays, []);
  }, { login: false });
});

test("events: 404 (no /events on the backend) ends as unavailable, as do a 405 and an HTML answer", async () => {
  await withEvents(async ({ start, delays }) => {
    const h = start(); // the mock has /events disabled: 404
    const err = await h.done;
    assert.equal(err?.kind, "unavailable");
    assert.equal(h.status.value, "unavailable");
    assert.deepEqual(delays, []);
  });
  for (const res of [() => new Response("no", { status: 405 }), () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })]) {
    const api = createApi({ fetch: async () => res(), sleep: async () => {} });
    const h = api.events({ onEvent: () => {} });
    assert.equal((await h.done)?.kind, "unavailable");
    assert.equal(h.status.value, "unavailable");
  }
});

test("events: a failing handler does not kill the stream", async () => {
  const s = new MockHarnessServer({ distDir: tmpdir() });
  const base = await s.start();
  try {
    const f = cookieFetch();
    await new HttpSessionApi(base, f).login({ token: OWNER_TOKEN });
    const api = createApi({ baseUrl: base, fetch: f });
    const seen: string[] = [];
    s.events.enable();
    const h = api.events({ onEvent: (e) => { seen.push(e.data); if (e.data === "1") throw new Error("handler bug"); } });
    await until(() => s.events.connections.length >= 1, "connection");
    s.events.push({ data: "1" });
    s.events.push({ data: "2" });
    await until(() => seen.length === 2, "both events");
    h.close();
  } finally { await s.stop(); }
});
