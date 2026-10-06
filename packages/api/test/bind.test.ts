import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer, loopbackBind } from "../src/server.ts";
import { fakeCore, OWNER_TOKEN } from "./helpers.ts";

test("only loopback hosts are accepted; localhost is pinned to 127.0.0.1", () => {
  assert.equal(loopbackBind("127.0.0.1"), "127.0.0.1"); assert.equal(loopbackBind("127.1.2.3"), "127.1.2.3"); assert.equal(loopbackBind("::1"), "::1"); assert.equal(loopbackBind("localhost"), "127.0.0.1");
  for (const bad of ["0.0.0.0", "::", "192.168.1.5", "10.0.0.1", "8.8.8.8", "example.com", "", "127.0.0.1.evil.example", "::ffff:127.0.0.1", "[::1]", "LOCALHOST", "0", "127"]) assert.throws(() => loopbackBind(bad), /loopback only/, bad);
});

test("createApiServer refuses a non-loopback host, a weak owner token and half a TLS pair at construction", () => {
  const core = fakeCore();
  assert.throws(() => createApiServer({ core, ownerToken: OWNER_TOKEN, host: "0.0.0.0" }), /loopback only/);
  assert.throws(() => createApiServer({ core, ownerToken: "short" }), /owner token/);
  assert.throws(() => createApiServer({ core, ownerToken: OWNER_TOKEN, tls: { key: "", cert: "x" } }), /tls needs both/);
});

test("the listener really is on loopback", async () => {
  const api = createApiServer({ core: fakeCore(), ownerToken: OWNER_TOKEN });
  const { host } = await api.listen();
  try { assert.equal(host, "127.0.0.1"); const a = api.server.address(); assert.ok(a && typeof a !== "string" && a.address === "127.0.0.1"); } finally { await api.close(); }
});

test("an IPv6 loopback listener works and accepts its own Host name", async (t) => {
  const api = createApiServer({ core: fakeCore(), ownerToken: OWNER_TOKEN, host: "::1" });
  let port: number;
  try { ({ port } = await api.listen()); } catch (e) { if (["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes((e as NodeJS.ErrnoException).code ?? "")) { t.skip("no IPv6 loopback"); return; } throw e; }
  try {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => { const r = request({ host: "::1", port, path: "/api/v1/health", headers: { host: `[::1]:${port}` }, agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }); r.on("error", reject); r.end(); });
    assert.equal(status, 401);
  } finally { await api.close(); }
});
