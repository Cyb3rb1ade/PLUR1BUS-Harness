import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLogger } from "@plur1bus/module-api";
import { FakeClock } from "../src/clock.ts";
import { createApiServer } from "../src/server.ts";
import { redactFields } from "../src/redact.ts";
import { csrfToken, fakeCore, jsonHeaders, OWNER_TOKEN, raw, type Harness } from "./helpers.ts";

// Marker test: a secret that passes through the API (the owner token, a wrong guess, the session cookie, a CSRF token,
// the whole Cookie header) must appear in no log line, whatever the request did and however it ended.

test("tokens never appear in logs: owner token, wrong guesses, session ids, CSRF tokens, cookie headers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "api-log-"));
  const file = join(dir, "api.log");
  const logger = createLogger({ file, level: "debug", role: "api" });
  const GUESS = "guess-" + "9".repeat(58);
  const core = fakeCore(); core.impl = async (m) => { if (m === "agent.list") throw Object.assign(new Error("boom"), { error: "E_INTERNAL" }); return { process: "ready", contract: "c", rpc: "r", instanceId: "i", pid: 1, uptimeMs: 1, engine: { ready: true, degraded: null }, agents: [] }; };
  const api = createApiServer({ core, ownerToken: OWNER_TOKEN, logger, clock: new FakeClock(), limits: { maxBodyBytes: 512 } });
  const { port } = await api.listen();
  const h = { port, clock: new FakeClock() } as unknown as Harness;
  const secrets: string[] = [OWNER_TOKEN, GUESS];
  try {
    // wrong guess, right login, reads, a core failure, a write with and without CSRF, an oversized body, a foreign origin, logout
    await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: GUESS }) });
    const login = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: OWNER_TOKEN }) });
    const cookie = login.headers["set-cookie"]![0]!.split(";", 1)[0]!; secrets.push(cookie, cookie.split("=")[1]!);
    const csrf1 = await csrfToken(h, cookie); secrets.push(csrf1);
    await raw(h, { path: "/api/v1/whoami", headers: { cookie } });
    await raw(h, { path: "/api/v1/agents", headers: { cookie } });
    await raw(h, { path: "/api/v1/health", headers: { cookie, authorization: `Bearer ${GUESS}` } });
    await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie, "x-csrf-token": "wrong-" + "8".repeat(40) } }); secrets.push("wrong-" + "8".repeat(40));
    await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: OWNER_TOKEN, pad: "x".repeat(2000) }) });
    await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), origin: "https://evil.example" }, body: JSON.stringify({ token: OWNER_TOKEN }) });
    await raw(h, { path: "/api/v1/whoami?token=" + OWNER_TOKEN, headers: { cookie } });
    await raw(h, { path: "/api/v1/" + OWNER_TOKEN, headers: { cookie } });
    await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie, "x-csrf-token": csrf1 } });
  } finally { await api.close(); await logger.close(); }
  const text = readFileSync(file, "utf8");
  rmSync(dir, { recursive: true, force: true });
  assert.ok(text.includes('"msg":"request"') && text.includes('"login"'), "the scenario did log requests");
  for (const s of secrets) assert.ok(!text.includes(s), `a secret of ${s.length} chars (starting ${JSON.stringify(s.slice(0, 6))}) appears in the log`);
});

test("the request log carries the route id, never the raw URL, so a token in a path or query cannot reach it", async () => {
  const logs: string[] = [];
  const sink = (m: string, f?: object) => { logs.push(JSON.stringify({ m, ...f })); };
  const api = createApiServer({ core: fakeCore(), ownerToken: OWNER_TOKEN, logger: { debug: sink, info: sink, warn: sink, error: sink } });
  const { port } = await api.listen();
  try {
    const h = { port } as unknown as Harness;
    await raw(h, { path: `/api/v1/secret-path-${OWNER_TOKEN}?token=${OWNER_TOKEN}` });
    assert.ok(logs.some((l) => l.includes('"route":"-"') && l.includes('"status":404')));
    assert.ok(!logs.join("\n").includes(OWNER_TOKEN));
  } finally { await api.close(); }
});

test("credential-named fields are redacted even if a call site passes them", () => {
  const out = JSON.stringify(redactFields({ ownerToken: OWNER_TOKEN, nested: { Cookie: "plur1bus_session=abc", csrfToken: "t" }, sessionId: "s" }));
  for (const s of [OWNER_TOKEN, "plur1bus_session=abc", '"t"', '"s"']) assert.ok(!out.includes(s), s);
});
