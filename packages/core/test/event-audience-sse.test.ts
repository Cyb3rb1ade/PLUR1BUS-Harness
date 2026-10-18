import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaults } from "@plur1bus/config-schema";
import { connect } from "@plur1bus/module-api";
import { createCore } from "../src/core.ts";
import { AdminStore } from "../src/identity/admin-store.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { createCoreLink } from "../../api/src/core-link.ts";
import { createApiServer } from "../../api/src/server.ts";
import { MemoryUserDirectory } from "../../api/src/memory-stores.ts";
import { hashPassword } from "../../api/src/password.ts";

async function until(f: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!f()) { if (Date.now() > deadline) throw new Error("event did not arrive"); await delay(5); }
}

test("real core → delegated IPC → HTTP/SSE: viewer without agent rights sees no recall or activity; owner still sees recall", { timeout: 30000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "p1b-agent-sse-"));
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  const people = new AdminStore({ path: join(home, "state", "admin.sqlite"), ownerId: "local-owner" });
  people.setRole("viewer", "viewer", () => {}); people.close();
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false }, dreams: { scheduler: false } });
  t.after(async () => { await core.stop({ budgetMs: 5000 }); rmSync(home, { recursive: true, force: true }); });
  await core.start();
  const local = await connect({ address: core.address, token: core.token }); t.after(() => local.close());
  const link = createCoreLink(home); t.after(() => link.close());
  const users = new MemoryUserDirectory();
  const password = "fixture-pass-not-a-real-secret";
  users.add({ id: "viewer", username: "viewer", role: "viewer", passwordHash: await hashPassword(password) });
  const ownerToken = randomBytes(32).toString("hex");
  const api = createApiServer({ core: link, users, ownerToken });
  t.after(() => api.close()); const { url } = await api.listen();
  const login = await fetch(url + "/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "viewer", password }) });
  assert.equal(login.status, 200); await login.text();
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const ctl = new AbortController(); t.after(() => ctl.abort());
  const stream = await fetch(url + "/events", { headers: { cookie }, signal: ctl.signal });
  assert.equal(stream.status, 200);
  const ownerLogin = await fetch(url + "/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ownerToken }) });
  assert.equal(ownerLogin.status, 200); await ownerLogin.text();
  const ownerStream = await fetch(url + "/events", { headers: { cookie: ownerLogin.headers.get("set-cookie")!.split(";")[0]! }, signal: ctl.signal });
  assert.equal(ownerStream.status, 200);
  const wires = { viewer: "", owner: "" };
  const read = async (response: Response, who: keyof typeof wires) => {
    const reader = response.body!.getReader(); const decoder = new TextDecoder();
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; wires[who] += decoder.decode(value, { stream: true }); } } catch { /* test cleanup abort */ }
  };
  const reading = Promise.all([read(stream, "viewer"), read(ownerStream, "owner")]);
  const got: string[] = []; local.onNotification(m => got.push(m));
  await local.call("events.subscribe", {});
  await local.call("memory.recall", { caller: { channel: "cli", accountId: "fixture", userId: "local-owner" }, agentId: "bernd", query: "redact-probe-alpha" });
  await until(() => got.includes("recall.completed"));
  await until(() => wires.owner.includes("event: recall.completed"));
  await until(() => wires.viewer.includes(": connected")); await delay(50);
  assert.ok(!wires.viewer.includes("recall.completed") && !wires.viewer.includes("agent.activity"), wires.viewer);
  // Explicitly naming an inaccessible agent also fails at subscription time.
  const viewer = await connect({ address: core.address, token: core.token, api: { clientId: "harness-api", token: readFileSync(join(home, "run", "api-delegation.token"), "utf8"), principal: { userId: "viewer", kind: "person", role: "viewer" } } });
  t.after(() => viewer.close());
  await assert.rejects(viewer.call("events.subscribe", { agentId: "bernd" }), (e: any) => e.error === "E_DENIED");
  const service = await connect({ address: core.address, token: core.token, api: { clientId: "harness-api", token: readFileSync(join(home, "run", "api-delegation.token"), "utf8") } });
  t.after(() => service.close());
  await service.call("events.subscribe", { names: ["api.account.changed"] });
  await assert.rejects(service.call("events.subscribe", {}), (e: any) => e.error === "E_UNAUTHORIZED");
  await assert.rejects(service.call("events.subscribe", { names: ["recall.completed"] }), (e: any) => e.error === "E_UNAUTHORIZED");
  ctl.abort(); await reading;
});
