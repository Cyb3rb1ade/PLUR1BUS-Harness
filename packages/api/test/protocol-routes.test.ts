import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request as httpRequest, type ServerResponse } from "node:http";
import test from "node:test";
import { ProtocolSseWriter, wwwAuthenticateBearer } from "../src/protocol-routes.ts";
import type { RouteSpec } from "../src/routes.ts";
import { addUser, fakeCore, loginAs, raw, start, write, type Harness } from "./helpers.ts";

const wide = {
  auth: { capacity: 1000, refillPerSec: 100 },
  read: { capacity: 1000, refillPerSec: 100 },
  write: { capacity: 1000, refillPerSec: 100 },
  totp: { capacity: 1000, refillPerSec: 100 },
  stream: { capacity: 1000, refillPerSec: 100 },
};

const setup = async (extraRoutes: NonNullable<Parameters<typeof start>[0]>["extraRoutes"]) => {
  const core = fakeCore();
  core.impl = async (m) => {
    if (m === "agent.list") {
      return { agents: [{ agentId: "main", open: true, activity: { state: "idle", since: 1 } }] };
    }
    if (m === "core.status") {
      return { rpc: "1.8.0", contract: "c", uptimeMs: 1, engine: { ready: true, degraded: null } };
    }
    throw new Error(`unexpected rpc ${m}`);
  };
  const h = await start({ rateClasses: wide, core, extraRoutes });
  await addUser(h, { id: "u-mia", username: "mia", role: "member", agentRights: { main: "use" } });
  return h;
};

const mintBound = async (h: Harness, cookie: string, audience: "mcp" | "a2a", agentId = "main") => {
  const r = await write(h, cookie, {
    path: "/api/v1/tokens",
    body: { name: `bound-${audience}`, scopes: ["agent.use"], binding: { audience, agentId } },
  });
  assert.equal(r.status, 201, r.text);
  return r.json.token as string;
};

test("A1.2: protocol route enforces Bearer-only auth (rejects cookies), WWW-Authenticate, audience binding, Origin (403) and Host (421)", async () => {
  const mcpRoute: RouteSpec = {
    id: "proto.mcp",
    method: "POST",
    path: "/mcp",
    summary: "MCP protocol endpoint",
    tag: "protocol",
    transport: "protocol",
    protocol: {
      audience: "mcp",
      maxBodyBytes: 256,
      handlerTimeoutMs: 500,
      resourceMetadataPath: "/.well-known/oauth-protected-resource",
    },
    auth: "any",
    authz: "authenticated",
    csrf: false,
    rate: "write",
    stability: "experimental",
    since: "1.8.0",
    successStatus: 200,
    success: { description: "ok", schema: {} },
  };

  const h = await setup([
    {
      spec: mcpRoute,
      handler: (i) => ({
        body: {
          ok: true,
          rawBytes: i.rawBody?.toString("utf8") ?? "",
          agentId: i.tokenRecord?.binding?.agentId,
        },
      }),
    },
  ]);

  try {
    const { cookie } = await loginAs(h, "mia");
    const mcpToken = await mintBound(h, cookie, "mcp");
    const a2aToken = await mintBound(h, cookie, "a2a");
    const unboundRes = await write(h, cookie, {
      path: "/api/v1/tokens",
      body: { name: "unbound", scopes: ["agent.use"] },
    });
    const unboundToken = unboundRes.json.token as string;

    // 1. Missing Bearer -> 401 with WWW-Authenticate: Bearer resource_metadata="..."
    const noAuth = await raw(h, { method: "POST", path: "/mcp", body: "hello" });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.json.reason, "bearer-required");
    assert.equal(
      noAuth.headers["www-authenticate"],
      wwwAuthenticateBearer(h.url, "/.well-known/oauth-protected-resource"),
    );

    // 2. Session cookie alone -> rejected with 401 (never accepted on protocol routes)
    const cookieOnly = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: { cookie },
      body: "hello",
    });
    assert.equal(cookieOnly.status, 401);
    assert.equal(cookieOnly.json.reason, "bearer-required");

    // 3. Unbound token -> 403 token-binding-required
    const unbound = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: { authorization: `Bearer ${unboundToken}` },
      body: "hello",
    });
    assert.equal(unbound.status, 403);
    assert.equal(unbound.json.reason, "token-binding-required");

    // 4. Wrong audience token -> 401 invalid-audience with WWW-Authenticate
    const wrongAud = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: { authorization: `Bearer ${a2aToken}` },
      body: "hello",
    });
    assert.equal(wrongAud.status, 401);
    assert.equal(wrongAud.json.reason, "invalid-audience");
    assert.ok(String(wrongAud.headers["www-authenticate"]).includes("resource_metadata="));

    // 5. Foreign Origin -> 403; Foreign Host -> 421
    const badOrigin = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: { authorization: `Bearer ${mcpToken}`, origin: "https://evil.example" },
      body: "hello",
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.json.reason, "origin");

    const badHost = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: { authorization: `Bearer ${mcpToken}`, host: "evil.example" },
      body: "hello",
    });
    assert.equal(badHost.status, 421);
    assert.equal(badHost.json.reason, "host");

    // 6. Valid bound Bearer with raw non-JSON body within per-route limit -> 200
    const ok = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/octet-stream" },
      body: "raw-protocol-payload",
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, {
      ok: true,
      rawBytes: "raw-protocol-payload",
      agentId: "main",
    });

    // 7. Per-route maxBodyBytes (256 bytes) -> 413
    const tooBig = await raw(h, {
      method: "POST",
      path: "/mcp",
      headers: { authorization: `Bearer ${mcpToken}` },
      body: "x".repeat(300),
    });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.json.reason, "body-too-large");
  } finally {
    await h.close();
  }
});

test("A1.2: protocol route enforces per-route handlerTimeoutMs (504) and supports 202 empty responses and SSE streaming", async () => {
  const slowRoute: RouteSpec = {
    id: "proto.slow",
    method: "POST",
    path: "/a2a/slow",
    summary: "Slow protocol route",
    tag: "protocol",
    transport: "protocol",
    protocol: { audience: "a2a", handlerTimeoutMs: 50 },
    auth: "any",
    authz: "authenticated",
    csrf: false,
    rate: "write",
    stability: "experimental",
    since: "1.8.0",
    successStatus: 200,
    success: { description: "ok", schema: {} },
  };
  const notifyRoute: RouteSpec = {
    id: "proto.notify",
    method: "POST",
    path: "/mcp/notify",
    summary: "Notification route",
    tag: "protocol",
    transport: "protocol",
    protocol: { audience: "mcp" },
    auth: "any",
    authz: "authenticated",
    csrf: false,
    rate: "write",
    stability: "experimental",
    since: "1.8.0",
    successStatus: 202,
    success: { description: "accepted", schema: {} },
  };
  const streamRoute: RouteSpec = {
    id: "proto.stream",
    method: "POST",
    path: "/mcp/stream",
    summary: "SSE stream route",
    tag: "protocol",
    transport: "protocol",
    protocol: { audience: "mcp" },
    auth: "any",
    authz: "authenticated",
    csrf: false,
    rate: "stream",
    stability: "experimental",
    since: "1.8.0",
    successStatus: 200,
    success: { description: "stream", schema: {} },
  };

  const h = await setup([
    {
      spec: slowRoute,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 250));
        return { body: { ok: true } };
      },
    },
    {
      spec: notifyRoute,
      handler: () => ({ status: 202 }),
    },
    {
      spec: streamRoute,
      handler: async (i) => {
        const writer = new ProtocolSseWriter({
          res: i.res!,
          headers: i.secHeaders,
          heartbeatMs: 30,
        });
        await writer.writeEvent({ id: "1", event: "progress", data: { step: 1 } });
        await new Promise((r) => setTimeout(r, 45));
        await writer.writeEvent({ id: "2", event: "result", data: { done: true } });
        writer.close();
        return { streamed: true, status: 200 };
      },
    },
  ]);

  try {
    const { cookie } = await loginAs(h, "mia");
    const a2aToken = await mintBound(h, cookie, "a2a");
    const mcpToken = await mintBound(h, cookie, "mcp");

    // 1. Per-route handler timeout -> 504
    const timedOut = await raw(h, {
      method: "POST",
      path: "/a2a/slow",
      headers: { authorization: `Bearer ${a2aToken}` },
      body: "{}",
    });
    assert.equal(timedOut.status, 504);
    assert.equal(timedOut.json.reason, "handler-timeout");

    // 2. 202 empty body response
    const accepted = await raw(h, {
      method: "POST",
      path: "/mcp/notify",
      headers: { authorization: `Bearer ${mcpToken}` },
      body: "{}",
    });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.text, "");

    // 3. SSE stream with heartbeat and ordered events
    const streamedRes = await fetch(`${h.url}/mcp/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpToken}` },
      body: "{}",
    });
    assert.equal(streamedRes.status, 200);
    assert.match(String(streamedRes.headers.get("content-type")), /^text\/event-stream/);
    const streamedText = await streamedRes.text();
    assert.ok(streamedText.includes("id: 1\nevent: progress\ndata: {\"step\":1}\n\n"), streamedText);
    assert.ok(streamedText.includes(": heartbeat\n\n"), streamedText);
    assert.ok(streamedText.includes("id: 2\nevent: result\ndata: {\"done\":true}\n\n"), streamedText);
    assert.ok(streamedText.indexOf("id: 1") < streamedText.indexOf("id: 2"));
  } finally {
    await h.close();
  }
});

test("A1.2: ProtocolSseWriter awaits drain under backpressure and aborts signal on client disconnect", async () => {
  const chunks: string[] = [];
  let backpressured = true;
  let closed = false;
  const fakeRes = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(_status: number, _headers: Record<string, string>) {
      this.headersSent = true;
    },
    flushHeaders() {},
    write(chunk: string) {
      chunks.push(chunk);
      return !backpressured;
    },
    end() {
      this.writableEnded = true;
    },
  }) as unknown as ServerResponse;

  const writer = new ProtocolSseWriter({
    res: fakeRes,
    heartbeatMs: 10_000,
    onClose: () => {
      closed = true;
    },
  });

  let writeResolved = false;
  const pendingWrite = writer.writeEvent({ id: "bp-1", data: "payload" }).then((ok) => {
    writeResolved = true;
    return ok;
  });

  // Still waiting for drain
  await new Promise((r) => setImmediate(r));
  assert.equal(writeResolved, false);

  // Emit drain -> write resolves true
  backpressured = false;
  fakeRes.emit("drain");
  assert.equal(await pendingWrite, true);
  assert.equal(writeResolved, true);
  assert.ok(chunks.some((c) => c.includes("id: bp-1\ndata: payload\n\n")));

  // Simulate client disconnect -> signal aborted and onClose called
  assert.equal(writer.closed, false);
  assert.equal(writer.signal.aborted, false);
  fakeRes.emit("close");
  assert.equal(writer.closed, true);
  assert.equal(writer.signal.aborted, true);
  assert.equal(closed, true);
  assert.equal(await writer.writeEvent({ data: "after-close" }), false);
});

test("A1.2: protocol route enforces per-route bodyTimeoutMs (408) on stalled uploads", async () => {
  const bodyTimeoutRoute: RouteSpec = {
    id: "proto.body-timeout",
    method: "POST",
    path: "/mcp/stalled",
    summary: "Body timeout test route",
    tag: "protocol",
    transport: "protocol",
    protocol: { audience: "mcp", bodyTimeoutMs: 60 },
    auth: "any",
    authz: "authenticated",
    csrf: false,
    rate: "write",
    stability: "experimental",
    since: "1.8.0",
    successStatus: 200,
    success: { description: "ok", schema: {} },
  };
  const h = await setup([{ spec: bodyTimeoutRoute, handler: () => ({ body: { ok: true } }) }]);
  try {
    const { cookie } = await loginAs(h, "mia");
    const mcpToken = await mintBound(h, cookie, "mcp");
    const u = new URL("/mcp/stalled", h.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: "POST",
          headers: {
            host: u.host,
            authorization: `Bearer ${mcpToken}`,
            "content-length": "100",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on("error", reject);
      req.write("part"); // stall without sending remaining 96 bytes
    });
    assert.equal(status, 408);
  } finally {
    await h.close();
  }
});
