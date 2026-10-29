// The HTTP test client accepts complete early replies while retaining transport and truncated-response failures.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http, { type IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { raw, type Harness } from "./helpers.ts";

function requestEvents(t: TestContext, events: (req: EventEmitter, res: EventEmitter, respond: () => void) => void): void {
  t.mock.method(http, "request", (_: unknown, response: (res: IncomingMessage) => void) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 413, headers: { "content-type": "application/json" } });
    const req = Object.assign(new EventEmitter(), {
      write() {}, end() { queueMicrotask(() => events(req, res, () => response(res as IncomingMessage))); },
    });
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
const reset = (code = "ECONNRESET") => Object.assign(new Error(`write ${code}`), { code });
const harness = { port: 1 } as Harness;

for (const code of ["ECONNRESET", "EPIPE"]) test(`a complete early response survives ${code} while the request body is still being written`, async t => {
  requestEvents(t, (req, res, respond) => {
    respond(); req.emit("error", reset(code));
    res.emit("data", Buffer.from('{"error":"E_INVALID_PARAMS"}')); res.emit("end");
  });
  const response = await raw(harness, { method: "POST", path: "/", body: "oversized body" });
  assert.equal(response.status, 413);
  assert.deepEqual(response.json, { error: "E_INVALID_PARAMS" });
});

test("an unrelated upload error after response headers remains a client failure", async t => {
  requestEvents(t, (req, _, respond) => { respond(); req.emit("error", reset("EIO")); });
  await assert.rejects(raw(harness, { path: "/" }), { code: "EIO" });
});

test("a request reset before any response remains a client failure", async t => {
  requestEvents(t, req => req.emit("error", reset()));
  await assert.rejects(raw(harness, { path: "/" }), { code: "ECONNRESET" });
});

test("a failed request identifies its method, route, byte count and transport phase without its body", async t => {
  requestEvents(t, req => { req.emit("finish"); req.emit("error", reset()); });
  const body = "private fixture ü";
  await assert.rejects(raw(harness, { method: "POST", path: "/api/v1/probe", body }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /POST \/api\/v1\/probe/);
    assert.ok(error.message.includes(`${Buffer.byteLength(body)} bytes`));
    assert.match(error.message, /phase=awaiting-response/);
    assert.ok(!error.message.includes(body));
    assert.equal((error as NodeJS.ErrnoException).code, "ECONNRESET");
    return true;
  });
});

test("a truncated response identifies the response-body phase and retains its transport error", async t => {
  requestEvents(t, (_, res, respond) => {
    respond(); res.emit("data", Buffer.from('{"error":')); res.emit("error", reset());
  });
  await assert.rejects(raw(harness, { path: "/api/v1/probe" }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /GET \/api\/v1\/probe.*0 bytes.*phase=response-body/);
    assert.equal((error as NodeJS.ErrnoException).code, "ECONNRESET");
    return true;
  });
});

test("a response that fails after its headers remains a client failure", async t => {
  requestEvents(t, (_, res, respond) => {
    respond(); res.emit("data", Buffer.from('{"error":')); res.emit("error", reset());
  });
  await assert.rejects(raw(harness, { path: "/" }), { code: "ECONNRESET" });
});

test("an aborted early response remains a client failure", async t => {
  requestEvents(t, (_, res, respond) => { respond(); res.emit("aborted"); });
  await assert.rejects(raw(harness, { path: "/" }), /test response aborted/);
});
