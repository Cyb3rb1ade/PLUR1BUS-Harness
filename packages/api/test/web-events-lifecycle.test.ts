import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApiServer } from "../src/server.ts";
import { fakeCore } from "./helpers.ts";
import { DEFAULT_RATE_CLASSES } from "../src/rate-limit.ts";

test("eight streams per person, ninth refused; idle expiration closes streams without heartbeats extending it", { timeout: 10000 }, async t => {
  const ownerToken = randomBytes(32).toString("hex");
  const api = createApiServer({ core: fakeCore(), ownerToken, rateClasses: { ...DEFAULT_RATE_CLASSES, stream: { capacity: 100, refillPerSec: 10 } }, sessionLimits: { idleMs: 200, absoluteMs: 2000, maxSessions: 64, csrfTtlMs: 1000, maxCsrfPerSession: 16 } });
  const { url } = await api.listen(); t.after(() => api.close());
  const login = await fetch(url + "/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ownerToken }) }); await login.text();
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const streams = await Promise.all(Array.from({ length: 8 }, async () => { const r = await fetch(url + "/events", { headers: { cookie } }); assert.equal(r.status, 200); return r; }));
  const overflow = await fetch(url + "/events", { headers: { cookie } }); assert.equal(overflow.status, 429); await overflow.text();
  const data = await Promise.all(streams.map(r => r.text()));
  assert.ok(data.every(text => text === ": connected\n\n"));
  const expired = await fetch(url + "/events", { headers: { cookie } }); assert.equal(expired.status, 401); await expired.text();
});
