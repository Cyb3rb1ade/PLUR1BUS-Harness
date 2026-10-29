import assert from "node:assert/strict";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { start } from "./helpers.ts";

// A server that refuses a request before it has read the whole upload must not close the socket while the client is
// still sending. Closing a socket that still has unread data (or receives more) makes the kernel answer with an RST, and
// on macOS an RST discards the response the client has not read yet: the client sees ECONNRESET instead of the 413 (CI
// run 40806108757, `POST /rpc (1100011 bytes)`). Linux keeps the queued response readable, so these tests do not wait
// for the symptom. They play the client that cannot lose its response by accident: it uploads in slices, reads nothing
// until the upload is complete, and reports whether the server went away in the meantime.

interface Upload { written: number; writeError: string | undefined; closedEarly: boolean; response: string }

async function slowUpload(port: number, head: string, slices: Buffer[], hold = 0): Promise<Upload> {
  const s = connect(port, "127.0.0.1"); s.pause();
  const out: Upload = { written: 0, writeError: undefined, closedEarly: false, response: "" };
  let finished = false;
  s.on("error", (e: NodeJS.ErrnoException) => { out.writeError ??= e.code ?? e.message; });
  s.on("close", () => { if (!finished) out.closedEarly = true; });
  await new Promise<void>((resolve, reject) => { s.once("connect", resolve); s.once("error", reject); });
  s.write(head);
  for (const slice of slices) {
    if (s.destroyed || out.writeError) break;
    await new Promise<void>((resolve) => s.write(slice, (e) => { if (!e) out.written += slice.length; resolve(); }));
    await delay(2);
  }
  await delay(hold);
  finished = true;
  if (out.writeError || s.destroyed) { s.destroy(); return out; }
  s.resume(); s.setTimeout(5000, () => s.destroy());
  await new Promise<void>((resolve) => { s.on("data", (c) => { out.response += c; }); s.on("close", () => resolve()); s.on("error", () => resolve()); s.end(); });
  return out;
}

const slices = (total: number, size = 16 * 1024): Buffer[] => Array.from({ length: Math.ceil(total / size) }, (_, i) => Buffer.alloc(Math.min(size, total - i * size), 0x61));
const POST = (port: number, path: string, extra: string) => `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n${extra}\r\n`;

test("a body over the declared limit is refused with 413 while the client can still finish its upload", async () => {
  const h = await start();
  try {
    const total = 1_100_011; // the web.rpc limit is 1 MiB; this is the size the OpenAPI contract test sends
    const u = await slowUpload(h.port, POST(h.port, "/rpc", `Content-Length: ${total}\r\n`), slices(total));
    assert.deepEqual([u.writeError, u.closedEarly, u.written], [undefined, false, total], "the server kept the connection until the upload was done");
    assert.match(u.response, /^HTTP\/1\.1 413 /); assert.ok(u.response.includes('"reason":"body-too-large"'));
  } finally { await h.close(); }
});

test("any early answer to a request that will close is held back the same way, not just the 413 (401 for a 300 KB body)", async () => {
  const h = await start({ limits: { maxBodyBytes: 512 * 1024 } });
  try {
    const total = 300_000;
    const u = await slowUpload(h.port, POST(h.port, "/api/v1/me/totp/confirm", `Content-Length: ${total}\r\nConnection: close\r\n`), slices(total));
    assert.deepEqual([u.writeError, u.closedEarly, u.written], [undefined, false, total]);
    assert.match(u.response, /^HTTP\/1\.1 401 /);
  } finally { await h.close(); }
});

test("the same for a body that is only found too large while it is read (chunked, no Content-Length)", async () => {
  const h = await start({ limits: { maxBodyBytes: 4096 } });
  try {
    const total = 60_000; /* under the 4 x limit + 64 KiB the server discards */ const parts = slices(total, 16 * 1024).map((b) => Buffer.concat([Buffer.from(`${b.length.toString(16)}\r\n`), b, Buffer.from("\r\n")]));
    const u = await slowUpload(h.port, POST(h.port, "/api/v1/session", "Transfer-Encoding: chunked\r\n"), [...parts, Buffer.from("0\r\n\r\n")]);
    assert.deepEqual([u.writeError, u.closedEarly], [undefined, false]);
    assert.match(u.response, /^HTTP\/1\.1 413 /); assert.ok(u.response.includes('"reason":"body-too-large"'));
  } finally { await h.close(); }
});

test("a header block over the limit is refused with 431 while the client is still sending", async () => {
  const h = await start();
  try {
    const u = await slowUpload(h.port, `GET /${"a".repeat(40_000)} HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\n`, slices(60_000));
    assert.deepEqual([u.writeError, u.closedEarly], [undefined, false]);
    assert.match(u.response, /^HTTP\/1\.1 431 /);
  } finally { await h.close(); }
});

test("the refusal does not turn into a lever: a client that keeps sending past the cap is cut off", async () => {
  const h = await start({ limits: { maxBodyBytes: 1024 } });
  try {
    const total = 20_000_000; // far beyond the 4 * limit + 64 KiB the server is willing to discard
    const u = await slowUpload(h.port, POST(h.port, "/api/v1/session", `Content-Length: ${total}\r\n`), slices(total, 64 * 1024));
    assert.ok(u.writeError !== undefined || u.closedEarly, "the server stopped listening");
    assert.ok(u.written < total, `only ${u.written} of ${total} bytes were accepted`);
  } finally { await h.close(); }
});

test("the lingering connection is bounded in time: a client that stops sending is closed", async () => {
  const h = await start({ limits: { maxBodyBytes: 1024, requestTimeoutMs: 1000 } });
  try {
    const s = connect(h.port, "127.0.0.1"); let data = "";
    const closed = new Promise<void>((resolve) => { s.on("close", () => resolve()); s.on("error", () => {}); s.on("data", (c) => { data += c; }); });
    s.write(POST(h.port, "/api/v1/session", "Content-Length: 5000000\r\n")); s.write("x".repeat(100));
    await Promise.race([closed, delay(8000).then(() => { s.destroy(); throw new Error("the server never closed the connection"); })]);
    assert.match(data, /^HTTP\/1\.1 413 /);
  } finally { await h.close(); }
});
