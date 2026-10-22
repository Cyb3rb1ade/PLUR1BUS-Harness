// Per-chat model and reasoning choice over real HTTP and a real core: GET/PATCH /api/v1/chats/{id}/model, the caller is
// the authenticated person (never a body field), CSRF and roles like every chat write, the chosen level reaches the
// provider adapter as the model's own wire parameter from the next turn on, and incognito keeps the choice in memory.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../core/src/core.ts";
import { flatTestInternals } from "../../core/test/helpers/flat-embedder.ts";
import { layout } from "../../core/src/paths.ts";
import { AdminStore } from "../../core/src/identity/admin-store.ts";
import { memoryAuditSink } from "../src/rbac-bridge.ts";
import { createApiServer } from "../src/server.ts";
import { createCoreLink } from "../src/core-link.ts";
import { MemoryUserDirectory } from "../src/memory-stores.ts";
import { hashPassword } from "../src/password.ts";

type Seen = { model: string; reasoning: unknown };

async function setup(t: import("node:test").TestContext) {
  const home = mkdtempSync(join(tmpdir(), "p1b-http-chat-model-")); const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, reranker: { enabled: false }, duplicateThreshold: 1.01 };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  const people = new AdminStore({ path: join(home, "state", "admin.sqlite"), ownerId: "local-owner" });
  for (const [id, role] of [["alice", "member"], ["bob", "member"], ["viewer", "viewer"]] as const) { people.setRole(id, role, () => {}); people.setRight("bernd", id, "use"); }
  people.close();
  const seen: Seen[] = [];
  const adapter = { async *stream(request: { model: string; reasoning?: unknown }) {
    seen.push({ model: request.model, reasoning: request.reasoning });
    yield { type: "done" as const, result: { text: "ok", toolCalls: [], finishReason: "stop" as const, rawFinishReason: "stop", usage: { inputTokens: 5, outputTokens: 1 }, meta: {} } };
  } };
  // Model ids the curated reasoning table knows (gpt-5: minimal..high; gpt-5.2: off..xhigh) and one it does not.
  const profiles = { default: [{ provider: "fixture", model: "gpt-5", adapter }], thinker: [{ provider: "fixture", model: "gpt-5.2", adapter }], plain: [{ provider: "fixture", model: "my-finetune", adapter }] };
  const audit = memoryAuditSink();
  const core = createCore({ home, testInternals: flatTestInternals(), composition: { providers: { profiles } } as never, rbac: { audit }, discovery: { scheduler: false }, dreams: { scheduler: false } });
  await core.start();
  const link = createCoreLink(home); const users = new MemoryUserDirectory(); const password = "fixture-pass-not-a-real-secret";
  for (const [id, role] of [["alice", "member"], ["bob", "member"], ["viewer", "viewer"]] as const) users.add({ id, username: id, role, agentRights: { bernd: "use" }, passwordHash: await hashPassword(password) });
  const api = createApiServer({ core: link, users, ownerToken: randomBytes(32).toString("hex"), audit }); const { url } = await api.listen();
  t.after(async () => { await api.close(); await link.close(); await core.stop({ budgetMs: 5000 }); rmSync(home, { recursive: true, force: true }); });
  const login = async (name: string) => { const r = await fetch(url + "/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name, password }) }); assert.equal(r.status, 200); await r.text(); return r.headers.get("set-cookie")!.split(";")[0]!; };
  const call = async (cookie: string, path: string, method = "GET", body?: object, csrf = true) => {
    let token: string | undefined;
    if (method !== "GET" && csrf) { const r = await fetch(url + "/api/v1/csrf", { headers: { cookie } }); token = (await r.json() as { token: string }).token; }
    return fetch(url + path, { method, headers: { cookie, ...(token ? { "x-csrf-token": token } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  };
  const json = async (r: Response, status = 200) => { const text = await r.text(); assert.equal(r.status, status, text); return JSON.parse(text); };
  return { home, seen, login, call, json };
}

test("model and reasoning per chat: options, nearest-level substitution, CAS, next-turn wire parameter, isolation", { timeout: 60000 }, async t => {
  const h = await setup(t), alice = await h.login("alice"), bob = await h.login("bob"), viewer = await h.login("viewer");
  const { session } = await h.json(await h.call(alice, "/api/v1/chats", "POST", { agentId: "bernd" }), 201);
  const path = `/api/v1/chats/${session.id}/model`;

  const options = await h.json(await h.call(alice, path));
  assert.deepEqual([options.profile, options.reasoning, options.revision], [null, "default", 0]);
  assert.deepEqual(options.profiles.map((p: { name: string }) => p.name), ["default", "plain", "thinker"]);
  const byName = Object.fromEntries(options.profiles.map((p: { name: string }) => [p.name, p]));
  assert.deepEqual(byName.default.reasoning, { kind: "effort", levels: ["minimal", "low", "medium", "high"], default: "medium", source: "table" });
  assert.deepEqual(byName.thinker.reasoning.levels, ["off", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(byName.plain.reasoning, { kind: "none", levels: [], source: "unknown", note: "reasoning-unknown" });
  assert.equal(byName.default.selectable, true);

  // Before any choice the turn sends no reasoning parameter (provider default).
  await h.json(await h.call(alice, `/api/v1/chats/${session.id}/messages`, "POST", { text: "first", wait: true }));
  assert.deepEqual(h.seen.at(-1), { model: "gpt-5", reasoning: undefined });

  // xhigh is not a gpt-5 level: the nearest (high) applies, visibly.
  const set = await h.json(await h.call(alice, path, "PATCH", { profile: "default", reasoning: "xhigh", expectedRevision: 0 }));
  assert.deepEqual([set.reasoning, set.effectiveReasoning, set.adjusted, set.revision, set.costHint], ["xhigh", "high", true, 1, "reasoning-cost-higher"]);
  const history=await h.json(await h.call(alice,`/api/v1/chats/${session.id}`));
  assert.equal(history.modelChanges.length,1);assert.equal(history.modelChanges[0].type,"session.model.changed");
  assert.equal(history.modelChanges[0].data.person,"alice");assert.equal(history.modelChanges[0].data.model,"gpt-5");
  assert.equal(history.modelChanges[0].data.effectiveReasoning,"high");
  await h.json(await h.call(alice, `/api/v1/chats/${session.id}/messages`, "POST", { text: "second", wait: true }));
  assert.deepEqual(h.seen.at(-1), { model: "gpt-5", reasoning: { vendorParam: "reasoning_effort", value: "high" } });

  // A stale revision is a conflict; the stored choice is unchanged.
  await h.json(await h.call(alice, path, "PATCH", { profile: "thinker", reasoning: "low", expectedRevision: 0 }), 409);
  assert.equal((await h.json(await h.call(alice, path))).reasoning, "xhigh");

  // Switching model: off is a real level of gpt-5.2 and goes out as "none".
  const thinker = await h.json(await h.call(alice, path, "PATCH", { profile: "thinker", reasoning: "off", expectedRevision: 1 }));
  assert.deepEqual([thinker.previousProfile, thinker.effectiveReasoning, thinker.adjusted, thinker.warning], ["default", "off", false, "cache-rebuild-cost-prefixes-preserved"]);
  await h.json(await h.call(alice, `/api/v1/chats/${session.id}/messages`, "POST", { text: "third", wait: true }));
  assert.deepEqual(h.seen.at(-1), { model: "gpt-5.2", reasoning: { vendorParam: "reasoning_effort", value: "none" } });

  // A model without reasoning control: the choice is kept but nothing is sent, and the answer says so.
  const plain = await h.json(await h.call(alice, path, "PATCH", { profile: "plain", reasoning: "medium", expectedRevision: 2 }));
  assert.deepEqual([plain.effectiveReasoning, plain.adjusted], ["default", true]);
  await h.json(await h.call(alice, `/api/v1/chats/${session.id}/messages`, "POST", { text: "fourth", wait: true }));
  assert.deepEqual(h.seen.at(-1), { model: "my-finetune", reasoning: undefined });

  // Identity comes from the session cookie: a caller in the body is refused, another person sees nothing, a viewer cannot write.
  await h.json(await h.call(alice, path, "PATCH", { profile: "default", expectedRevision: 3, caller: { channel: "cli", accountId: "x", userId: "bob" } }), 400);
  await h.json(await h.call(bob, path), 404);
  await h.json(await h.call(bob, path, "PATCH", { profile: "default", expectedRevision: 3 }), 404);
  await h.json(await h.call(viewer, path, "PATCH", { profile: "default", expectedRevision: 3 }), 403);
  // CSRF like every chat write; an unknown profile or level is refused.
  const noCsrf = await h.call(alice, path, "PATCH", { profile: "default", expectedRevision: 3 }, false); assert.equal(noCsrf.status, 403); await noCsrf.text();
  const unknown = await h.call(alice, path, "PATCH", { profile: "nope", expectedRevision: 3 }); assert.notEqual(unknown.status, 200); assert.match(await unknown.text(), /E_NOT_AVAILABLE/);
  await h.json(await h.call(alice, path, "PATCH", { profile: "default", reasoning: "turbo", expectedRevision: 3 }), 400);
  assert.equal((await h.json(await h.call(alice, path))).profile, "plain");
  // A model switch without a level keeps the chat's stored choice.
  const kept = await h.json(await h.call(alice, path, "PATCH", { profile: "default", expectedRevision: 3 }));
  assert.deepEqual([kept.reasoning, kept.effectiveReasoning, kept.adjusted], ["medium", "medium", false]);
});

test("incognito: the choice works and stays in memory; the durable store holds no row for the chat", { timeout: 60000 }, async t => {
  const h = await setup(t), alice = await h.login("alice");
  const { session } = await h.json(await h.call(alice, "/api/v1/chats", "POST", { agentId: "bernd", memoryMode: "incognito" }), 201);
  const set = await h.json(await h.call(alice, `/api/v1/chats/${session.id}/model`, "PATCH", { profile: "thinker", reasoning: "xhigh", expectedRevision: 0 }));
  assert.deepEqual([set.effectiveReasoning, set.adjusted], ["xhigh", false]);
  await h.json(await h.call(alice, `/api/v1/chats/${session.id}/messages`, "POST", { text: "secret", wait: true }));
  assert.deepEqual(h.seen.at(-1), { model: "gpt-5.2", reasoning: { vendorParam: "reasoning_effort", value: "xhigh" } });
  assert.equal((await h.json(await h.call(alice, `/api/v1/chats/${session.id}/model`))).reasoning, "xhigh");
  const history=await h.json(await h.call(alice,`/api/v1/chats/${session.id}`));
  assert.equal(history.modelChanges.length,1);assert.equal(history.modelChanges[0].data.person,"alice");
  const db = new DatabaseSync(join(h.home, "state", "sessions.sqlite"), { readOnly: true });
  try { assert.equal((db.prepare("SELECT count(*) AS n FROM session_model_profiles WHERE session_id = ?").get(session.id) as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM events WHERE session_id=?").get(session.id) as {n:number}).n,0);
  }
  finally { db.close(); }
});
