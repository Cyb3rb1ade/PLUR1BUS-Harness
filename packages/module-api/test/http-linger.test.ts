import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { lingerLimits, lingerSocket, lingerUnread } from "../src/index.ts";

async function serve(onRequest: (req: IncomingMessage) => Promise<void>): Promise<{ port: number; done: Promise<void>; close(): Promise<void> }> {
  let settle!: () => void; const done = new Promise<void>((resolve) => { settle = resolve; });
  const server = createServer((req, res) => { void onRequest(req).then(() => { res.end("x"); settle(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, done, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
const head = (port: number, length: number) => `POST / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: ${length}\r\n\r\n`;

test("lingerLimits: four times the body limit plus a header's worth, five seconds unless told otherwise", () => {
  assert.deepEqual(lingerLimits(1000), { capBytes: 4000 + 65_536, maxMs: 5000 });
  assert.deepEqual(lingerLimits(1000, 250), { capBytes: 69_536, maxMs: 250 });
});

test("lingerUnread resolves when the upload has been read to its end, and the request is complete", async () => {
  let ended = false;
  const s = await serve(async (req) => { await lingerUnread(req, lingerLimits(10, 2000)); ended = req.readableEnded; });
  try {
    const c = connect(s.port, "127.0.0.1"); c.on("error", () => {});
    c.write(head(s.port, 3000)); await delay(20); c.write("a".repeat(3000));
    await s.done; assert.equal(ended, true); c.destroy();
  } finally { await s.close(); }
});

test("lingerUnread resolves at once for a request that is already complete", async () => {
  const s = await serve(async (req) => { await new Promise<void>((resolve) => { req.resume(); req.on("end", resolve); }); await lingerUnread(req, lingerLimits(10, 60_000)); });
  try { const c = connect(s.port, "127.0.0.1"); c.on("error", () => {}); c.write(head(s.port, 2) + "ab"); await s.done; c.destroy(); } finally { await s.close(); }
});

test("lingerUnread destroys the request once the cap is passed", async () => {
  let destroyed = false;
  const s = await serve(async (req) => { await lingerUnread(req, { capBytes: 10_000, maxMs: 5000 }); destroyed = req.destroyed; });
  try {
    const c = connect(s.port, "127.0.0.1"); c.on("error", () => {});
    c.write(head(s.port, 1_000_000)); c.write("a".repeat(200_000));
    await s.done; assert.equal(destroyed, true); c.destroy();
  } finally { await s.close(); }
});

test("lingerUnread destroys the request after maxMs, however little the client sends", async () => {
  let destroyed = false; const t0 = Date.now(); let took = 0;
  const s = await serve(async (req) => { await lingerUnread(req, { capBytes: 1_000_000, maxMs: 150 }); destroyed = req.destroyed; took = Date.now() - t0; });
  try {
    const c = connect(s.port, "127.0.0.1"); c.on("error", () => {});
    c.write(head(s.port, 1000) + "a");
    await s.done; assert.equal(destroyed, true); assert.ok(took >= 140 && took < 3000, `took ${took} ms`); c.destroy();
  } finally { await s.close(); }
});

test("lingerSocket keeps a half-closed socket reading until the cap or the time is up, and refuses a destroyed one", async () => {
  const sockets: Socket[] = [];
  const { createServer: net } = await import("node:net");
  const server = net((s) => { sockets.push(s); s.on("error", () => {}); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const c = connect(port, "127.0.0.1"); c.on("error", () => {}); await new Promise<void>((resolve) => c.once("connect", resolve)); await delay(20);
    const s = sockets[0]!; s.end("bye");
    assert.equal(lingerSocket(s, { capBytes: 100, maxMs: 5000 }, 10), true);
    assert.equal(lingerSocket(s, { capBytes: 100, maxMs: 5000 }, 50), true); assert.equal(s.destroyed, false);
    assert.equal(lingerSocket(s, { capBytes: 100, maxMs: 5000 }, 50), false); assert.equal(s.destroyed, true);
    assert.equal(lingerSocket(s, { capBytes: 100, maxMs: 5000 }), false);
    const c2 = connect(port, "127.0.0.1"); c2.on("error", () => {}); await new Promise<void>((resolve) => c2.once("connect", resolve)); await delay(20);
    const s2 = sockets[1]!; assert.equal(lingerSocket(s2, { capBytes: 1_000_000, maxMs: 100 }), true);
    await new Promise<void>((resolve) => s2.once("close", () => resolve())); assert.equal(s2.destroyed, true);
    c.destroy(); c2.destroy();
  } finally { server.close(); }
});
