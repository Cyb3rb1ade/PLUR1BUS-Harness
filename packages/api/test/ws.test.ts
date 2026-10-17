import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { FakeClock } from "../src/clock.ts";
import { DEFAULT_RATE_CLASSES, RateLimiter } from "../src/rate-limit.ts";
import { SessionStore, type Session } from "../src/session.ts";
import { createWsRoute, WS_PROTOCOL, type WsLimits } from "../src/ws.ts";
import type { RbacPrincipal } from "../src/rbac-bridge.ts";

function masked(op: number, data: Buffer, fin = true): Buffer {
  const mask = randomBytes(4); const h = Buffer.alloc(data.length < 126 ? 2 : 4);
  h[0] = (fin ? 128 : 0) | op; h[1] = 128 | (data.length < 126 ? data.length : 126);
  if (data.length >= 126) h.writeUInt16BE(data.length, 2);
  const b = Buffer.from(data); for (let i = 0; i < b.length; i++) b[i] = b[i]! ^ mask[i % 4]!;
  return Buffer.concat([h, mask, b]);
}
async function fixture(limits: Partial<WsLimits> = {}, streamCapacity = 100) {
  const clock = new FakeClock(); const sessions = new SessionStore(clock);
  let resolveHook: (() => Promise<void>) | undefined; let version = 0; let role: RbacPrincipal["role"] = "owner";
  const events: object[] = []; const sockets = new Set<Socket>();
  const server = createServer((_q, res) => { res.writeHead(426); res.end(); });
  let authority = "";
  const ws = createWsRoute({ sessions, cookieName: "session", clock,
    limiter: new RateLimiter(clock, { ...DEFAULT_RATE_CLASSES, stream: { capacity: streamCapacity, refillPerSec: 100 } }),
    audit: { emit(action, actor, target, detail) { events.push({ action, actor, target, detail }); } },
    resolve: async (s: Session) => { await resolveHook?.(); return { rbac: { userId: s.principal.id, role, kind: "person" }, version }; },
    allowedHost: h => h === authority, allowedOrigin: o => o === `http://${authority}`, limits,
  });
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  server.on("upgrade", (q, s, h) => { void ws.upgrade(q, s, h); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const port = address.port; authority = `127.0.0.1:${port}`;
  const login = sessions.create({ kind: "user", id: "person", role: "owner" });
  const ticket = () => ws.issue(login.id)!.ticket;
  async function open(overrides: Record<string, string | undefined> = {}, path = "/ws", issued = ticket()) {
    const sock = connect(port, "127.0.0.1"); const chunks: Buffer[] = [];
    sock.on("error", () => {}); sock.on("data", chunk => chunks.push(chunk));
    const wait = async (predicate: (data: Buffer) => boolean) => {
      const end = Date.now() + 1500;
      while (!predicate(Buffer.concat(chunks))) { if (Date.now() > end) throw new Error(`socket wait timed out (${Buffer.concat(chunks).toString()})`); await new Promise(r => setTimeout(r, 5)); }
      return Buffer.concat(chunks);
    };
    await new Promise<void>(r => sock.once("connect", r));
    const headers = { Host: authority, Origin: `http://${authority}`, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), Cookie: `session=${login.id}`, "Sec-WebSocket-Protocol": `${WS_PROTOCOL}, csrf.${issued}`, ...overrides };
    sock.write(`GET ${path} HTTP/1.1\r\n${Object.entries(headers).filter(([,v]) => v !== undefined).map(([k,v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    const data = await wait(b => b.includes("\r\n\r\n"));
    const boundary = data.indexOf("\r\n\r\n") + 4;
    return { sock, data, issued, wait, body: () => Buffer.concat(chunks).subarray(boundary), closeCode: async () => {
      const all = await wait(b => b.length >= boundary + 4 && (b[boundary]! & 15) === 8);
      return all.readUInt16BE(boundary + 2);
    } };
  }
  return { ws, clock, sessions, login, open, ticket, events, setResolveHook(hook: () => Promise<void>) { resolveHook = hook; }, setRole(r: RbacPrincipal["role"]) { role = r; }, setVersion(v: number) { version = v; }, async close() { ws.close(); for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); } };
}

test("real upgrade consumes ticket once and echoes only the reserved protocol", async () => {
  const f = await fixture(); try {
    const a = await f.open(); assert.match(a.data.toString(), /HTTP\/1.1 101/); assert.ok(!a.data.includes(a.issued));
    assert.match(a.data.toString(), /Sec-WebSocket-Protocol: plur1bus-reserved/);
    const replay = await f.open({}, "/ws", a.issued); assert.match(replay.data.toString(), /HTTP\/1.1 403/);
    assert.ok(!JSON.stringify(f.events).includes(a.issued));
  } finally { await f.close(); }
});
for (const [name, overrides, path, status] of [
  ["no cookie", { Cookie: undefined }, "/ws", 401],
  ["no origin", { Origin: undefined }, "/ws", 403],
  ["wrong origin", { Origin: "https://hostile.invalid" }, "/ws", 403],
  ["wrong host", { Host: "hostile.invalid" }, "/ws", 421],
  ["cross-site", { "Sec-Fetch-Site": "cross-site" }, "/ws", 403],
  ["bearer with cookie", { Authorization: `Bearer ${randomBytes(32).toString("base64url")}` }, "/ws", 403],
  ["query", {}, "/ws?channel=reserved", 400],
  ["missing ticket", { "Sec-WebSocket-Protocol": WS_PROTOCOL }, "/ws", 403],
  ["unsupported version", { "Sec-WebSocket-Version": "12" }, "/ws", 400],
] as const) test(`upgrade refuses ${name} before 101`, async () => {
  const f = await fixture(); try { const a = await f.open(overrides, path); assert.match(a.data.toString(), new RegExp(`HTTP/1.1 ${status}`)); } finally { await f.close(); }
});
for (const role of ["viewer", "member", "operator"] as const) test(`reserved PTY gate refuses ${role}`, async () => {
  const f = await fixture(); try { f.setRole(role); const a = await f.open(); assert.match(a.data.toString(), /HTTP\/1.1 403/); } finally { await f.close(); }
});
test("ticket is session-bound, expires and is distinct from ordinary CSRF", async () => {
  const f = await fixture(); try {
    const foreign = f.sessions.create({ kind: "user", id: "other", role: "owner" });
    const a = await f.open({}, "/ws", f.ws.issue(foreign.id)!.ticket); assert.match(a.data.toString(), /HTTP\/1.1 403/);
    const csrf = f.sessions.issueCsrf(f.login.id)!; const b = await f.open({}, "/ws", csrf.token); assert.match(b.data.toString(), /HTTP\/1.1 403/);
    assert.ok(f.sessions.consumeCsrf(f.login.id, csrf.token));
    const stale = f.ticket(); f.clock.advance(30_001); const c = await f.open({}, "/ws", stale); assert.match(c.data.toString(), /HTTP\/1.1 403/);
  } finally { await f.close(); }
});
test("logout closes an upgraded connection immediately", async () => {
  const f = await fixture(); try { const a = await f.open(); f.sessions.destroy(f.login.id); assert.equal(await a.closeCode(), 1008); } finally { await f.close(); }
});
test("rightsChanged explicitly closes an upgraded connection", async () => {
  const f = await fixture(); try { const a = await f.open(); f.ws.revoke("person"); assert.equal(await a.closeCode(), 1008); } finally { await f.close(); }
});
for (const change of ["role", "version", "expiry"] as const) test(`periodic live authorization closes on ${change}`, async () => {
  const f = await fixture({ checkIntervalMs: 5 }); try {
    const a = await f.open(); if (change === "role") f.setRole("viewer"); else if (change === "version") f.setVersion(1); else f.clock.advance(31 * 60_000);
    assert.equal(await a.closeCode(), 1008);
  } finally { await f.close(); }
});
test("oversized advertised frame is refused without buffering its payload", async () => {
  const f = await fixture({ maxFrameBytes: 256 }); try {
    const a = await f.open(); const h = Buffer.from([0x82, 0xfe, 0x10, 0]); a.sock.write(h); assert.equal(await a.closeCode(), 1009);
  } finally { await f.close(); }
});
test("fragmented message has an independent aggregate cap", async () => {
  const f = await fixture({ maxFrameBytes: 256, maxMessageBytes: 300 }); try {
    const a = await f.open(); a.sock.write(masked(2, Buffer.alloc(200), false)); a.sock.write(masked(0, Buffer.alloc(200), false)); assert.equal(await a.closeCode(), 1009);
  } finally { await f.close(); }
});
test("buffer cap and unmasked frames fail closed", async () => {
  const f = await fixture({ maxBufferedBytes: 128 }); try {
    const a = await f.open(); a.sock.write(Buffer.alloc(129)); assert.equal(await a.closeCode(), 1009);
    const b = await f.open(); b.sock.write(Buffer.from([0x81, 0])); assert.equal(await b.closeCode(), 1002);
  } finally { await f.close(); }
});
test("reserved channel rejects application content", async () => {
  const f = await fixture(); try { const a = await f.open(); a.sock.write(masked(1, Buffer.from("hello"))); assert.equal(await a.closeCode(), 1003); } finally { await f.close(); }
});
test("ping gets pong and missing pong times out", async () => {
  const f = await fixture({ pingIntervalMs: 20, pongTimeoutMs: 10, checkIntervalMs: 5 }); try {
    const a = await f.open(); a.sock.write(masked(9, Buffer.from("check")));
    await a.wait(b => b.includes(Buffer.from([0x8a, 5]))); assert.equal(a.body()[0], 0x8a);
    f.clock.advance(21); await a.wait(b => b.includes(Buffer.from([0x89, 8])));
    const pongBytes = a.body().subarray(7 + 2, 7 + 10); a.sock.write(masked(10, pongBytes));
    await new Promise(r => setTimeout(r, 15)); f.clock.advance(11); await new Promise(r => setTimeout(r, 15)); assert.ok(!a.sock.destroyed);
    f.clock.advance(21); await new Promise(r => setTimeout(r, 15)); f.clock.advance(11);
    await a.wait(b => b.includes(Buffer.from([0x88, 2, 3, 240])));
  } finally { await f.close(); }
});
test("connection cap refuses additional sockets and pending tickets are bounded", async () => {
  const f = await fixture({ maxConnections: 1, maxTicketsPerSession: 2 }); try {
    const evicted = f.ticket(); f.ticket(); f.ticket(); const a = await f.open({}, "/ws", evicted); assert.match(a.data.toString(), /HTTP\/1.1 403/);
    const b = await f.open(); assert.match(b.data.toString(), /HTTP\/1.1 101/);
    const c = await f.open(); assert.match(c.data.toString(), /HTTP\/1.1 429/);
  } finally { await f.close(); }
});

test("upgrade attempts consume the stream rate-limit class", async () => {
  const f = await fixture({}, 1); try {
    const a = await f.open({ Cookie: undefined }); assert.match(a.data.toString(), /HTTP\/1.1 401/);
    const b = await f.open(); assert.match(b.data.toString(), /HTTP\/1.1 429/);
  } finally { await f.close(); }
});
for (const [name, payload, code] of [
  ["fragmented ping", Buffer.from([0x09, 0x80, 0, 0, 0, 0]), 1002],
  ["unknown opcode", Buffer.from([0x83, 0x80, 0, 0, 0, 0]), 1002],
  ["extension bits", Buffer.from([0xc1, 0x80, 0, 0, 0, 0]), 1002],
  ["nonminimal length", Buffer.from([0x82, 0xfe, 0, 1]), 1002],
  ["64-bit oversize", Buffer.from([0x82, 0xff, 0, 0, 0, 1, 0, 0, 0, 0]), 1009],
  ["64-bit high bit", Buffer.from([0x82, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0]), 1002],
  ["unexpected continuation", masked(0, Buffer.alloc(0)), 1002],
] as const) test(`bounded parser rejects ${name}`, async () => {
  const f = await fixture(); try { const a = await f.open(); a.sock.write(payload); assert.equal(await a.closeCode(), code); } finally { await f.close(); }
});
test("rotation invalidates a connected socket and its pending ticket", async () => {
  const f = await fixture(); try {
    const pending = f.ticket(); const a = await f.open(); const rotated = f.sessions.rotate(f.login.id)!;
    assert.equal(await a.closeCode(), 1008);
    const b = await f.open({ Cookie: `session=${rotated.id}` }, "/ws", pending); assert.match(b.data.toString(), /HTTP\/1.1 403/);
  } finally { await f.close(); }
});

test("authorization timeout refuses upgrade before 101", async () => {
  const f = await fixture({ authorizationTimeoutMs: 15 }); try {
    f.setResolveHook(() => new Promise(() => {})); const a = await f.open();
    assert.match(a.data.toString(), /HTTP\/1.1 503/); assert.ok(!a.data.includes("101 Switching"));
  } finally { await f.close(); }
});
test("logout while authorization is pending refuses upgrade", async () => {
  const f = await fixture(); try {
    f.setResolveHook(async () => { f.sessions.destroy(f.login.id); }); const a = await f.open();
    assert.match(a.data.toString(), /HTTP\/1.1 401/);
  } finally { await f.close(); }
});
test("authorization backend timeout closes a connected socket", async () => {
  const f = await fixture({ authorizationTimeoutMs: 15, checkIntervalMs: 5 }); try {
    const a = await f.open(); f.setResolveHook(() => new Promise(() => {})); assert.equal(await a.closeCode(), 1008);
  } finally { await f.close(); }
});

test("unauthenticated floods are rate-limited and rejection audit is bounded", async () => {
  const f = await fixture({}, 1); try {
    for (let i = 0; i < 8; i++) { const a = await f.open({ Cookie: undefined }); assert.match(a.data.toString(), new RegExp(`HTTP/1.1 ${i ? 429 : 401}`)); }
    assert.equal(f.events.length, 2);
  } finally { await f.close(); }
});

for (const [name, payload, code] of [
  ["one-byte close", Buffer.from([1]), 1002],
  ["reserved close status", Buffer.from([3, 237]), 1002],
  ["malformed close reason", Buffer.from([3, 232, 255]), 1007],
] as const) test(`parser validates ${name}`, async () => {
  const f = await fixture(); try { const a = await f.open(); a.sock.write(masked(8, payload)); assert.equal(await a.closeCode(), code); } finally { await f.close(); }
});
