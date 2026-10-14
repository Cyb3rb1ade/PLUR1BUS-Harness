import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcServer, createLogger, coreAddress } from "@plur1bus/module-api";
import { createCoreLink } from "../src/core-link.ts";
import { createApiServer } from "../src/server.ts";

async function until(f: () => boolean) { const end = Date.now() + 2000; while (!f()) { if (Date.now() > end) throw new Error("SSE did not arrive"); await new Promise(r => setTimeout(r, 5)); } }
test("real HTTP and local sockets keep connection-private events and replay separate across two sessions of one person", { timeout: 10000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "p1b-two-web-sessions-")); mkdirSync(join(home, "run"));
  const token = randomBytes(32).toString("hex"), apiToken = randomBytes(32).toString("hex"), ownerToken = randomBytes(32).toString("hex");
  writeFileSync(join(home, "run", "api-delegation.token"), apiToken, { mode: 0o600 });
  const logger = createLogger({ file: join(home, "core.log"), role: "core", level: "error" });
  const core = createRpcServer({ address: coreAddress(home), token, apiToken, logger, methods: {}, hello: () => ({ rpc: "1.6.0", pid: process.pid, instanceId: "two-sessions" }), apiPrincipalOf: p => p, apiPersonOfConnection: async (_id, p) => p.userId }); await core.listen();
  const link = createCoreLink(home, { readToken: () => token, readPid: () => process.pid });
  const api = createApiServer({ core: link, ownerToken }); const { url } = await api.listen();
  const controllers: AbortController[] = [];
  t.after(async () => { for (const c of controllers) c.abort(); await api.close(); await link.close(); await core.close(); await logger.close(); rmSync(home, { recursive: true, force: true }); });
  const login = async () => { const r = await fetch(url + "/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ownerToken }) }); assert.equal(r.status, 200); await r.text(); return r.headers.get("set-cookie")!.split(";")[0]!; };
  const open = async (cookie: string, lastId?: string) => {
    const ctl = new AbortController(); controllers.push(ctl);
    const r = await fetch(url + "/events", { headers: { cookie, ...(lastId ? { "last-event-id": lastId } : {}) }, signal: ctl.signal }); assert.equal(r.status, 200);
    const events: { id: string; name: string; data: string }[] = [];
    void (async () => { let buffer = ""; const decoder = new TextDecoder(); const reader = r.body!.getReader(); try { for (;;) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let at: number; while ((at = buffer.indexOf("\n\n")) !== -1) { const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2); const name = /^event: (.+)$/m.exec(frame)?.[1]; if (name) events.push({ id: /^id: (.+)$/m.exec(frame)?.[1] ?? "", name, data: /^data: (.+)$/m.exec(frame)?.[1] ?? "" }); } } } catch { /* test cleanup */ } })();
    return events;
  };
  const firstCookie = await login(), secondCookie = await login();
  const first = await open(firstCookie), second = await open(secondCookie);
  const subscriptions = core.subscriptions(); assert.equal(subscriptions.length, 2); assert.notEqual(subscriptions[0]!.connectionId, subscriptions[1]!.connectionId);
  core.notify("inbox.changed", { change: "created", kinds: ["approval"] }, { audience: [{ connectionId: subscriptions[0]!.connectionId }] });
  await until(() => first.length === 1); await new Promise(r => setTimeout(r, 30)); assert.equal(second.length, 0);
  const resumed = await open(secondCookie, first[0]!.id); await until(() => resumed.length === 1);
  assert.equal(resumed[0]!.name, "restart"); assert.ok(!resumed.some(event => event.name === "inbox.changed"));
  core.notify("inbox.changed", { change: "read", kinds: ["approval"] }, { audience: [{ personId: "local-owner" }] });
  await until(() => first.length === 2 && second.length === 1 && resumed.length === 2);
  assert.equal(JSON.parse(second[0]!.data).change, "read");
});
