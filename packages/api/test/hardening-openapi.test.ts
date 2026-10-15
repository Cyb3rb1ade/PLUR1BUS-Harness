// Step 5 of the server hardening sweep: the OpenAPI document and the route table agree, and what the real handlers answer
// agrees with the document. The server runs in-process with a fake core; every route is driven through its success and
// its failure paths and each answer is checked against the response schema the document names for its status.
// Already pinned elsewhere (not repeated): route <-> operation in both directions, handler <-> route, $refs resolve and
// docs/openapi.json equals the generator's output in-process (openapi.test.ts).
import { AccountStore } from "../src/account-store.ts";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ERROR_CODES } from "@plur1bus/rpc-schema";
import { statusOfCode } from "../src/errors.ts";
import { buildOpenApi } from "../src/openapi.ts";
import { ROUTES, type RouteSpec } from "../src/routes.ts";
import { totpCodeAt } from "../src/totp.ts";
import { validate, type Doc } from "./openapi-validate.ts";
import { OWNER_TOKEN, fakeCore, addUser, csrfToken, FIXTURE_PASSWORD, jsonHeaders, login, loginAs, raw, start, write, type FakeCore, type Harness, type Res } from "./helpers.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const doc = buildOpenApi() as unknown as Doc & { paths: Record<string, Record<string, any>> };
const wide = { auth: { capacity: 100_000, refillPerSec: 10_000 }, read: { capacity: 100_000, refillPerSec: 10_000 }, write: { capacity: 100_000, refillPerSec: 10_000 }, totp: { capacity: 100_000, refillPerSec: 10_000 }, stream: { capacity: 100_000, refillPerSec: 10_000 } };
const opOf = (r: RouteSpec) => doc.paths[r.path]![r.method.toLowerCase()]!;

// ---- the checker itself --------------------------------------------------------------------------------------------

test("the test validator rejects what a schema forbids (so a green run below means something)", () => {
  const d: Doc = { components: { schemas: { N: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "integer", minimum: 1 }, b: { const: "x" } } } } } };
  assert.deepEqual(validate({ $ref: "#/components/schemas/N" }, { a: 1, b: "x" }, d), []);
  for (const bad of [{}, { a: 0 }, { a: 1.5 }, { a: "1" }, { a: 1, c: 2 }, { a: 1, b: "y" }, null, [], "s"]) assert.ok(validate({ $ref: "#/components/schemas/N" }, bad, d).length > 0, JSON.stringify(bad));
  assert.ok(validate({ oneOf: [{ type: "string" }, { type: "string", minLength: 2 }] }, "abc", d).length > 0, "two matching branches are not exactly one");
  assert.deepEqual(validate({ type: "string", format: "date-time" }, "2026-10-12T10:00:00.000Z", d), []);
  assert.ok(validate({ type: "string", format: "date-time" }, "yesterday", d).length > 0);
  assert.deepEqual(validate({ type: ["integer", "null"], minimum: 0 }, null, d), []);
  assert.deepEqual(validate({ type: ["integer", "null"], minimum: 0 }, 1, d), []);
  for(const bad of ["1", -1, 1.5, false])assert.ok(validate({ type: ["integer", "null"], minimum: 0 }, bad, d).length>0);
  assert.throws(() => validate({ type: "string", contentEncoding: "base64" } as never, "x", d), /does not know/);
});

// ---- the document against the table --------------------------------------------------------------------------------

test("per operation: method, path, id, tag, security, CSRF parameter, stability and the declared statuses all come from the route table", () => {
  const problems: string[] = [];
  for (const r of ROUTES) {
    const op = opOf(r); const at = `${r.method} ${r.path}`;
    if (op.operationId !== r.id) problems.push(`${at}: operationId ${op.operationId} != ${r.id}`);
    if (JSON.stringify(op.tags) !== JSON.stringify([r.tag])) problems.push(`${at}: tags`);
    if (op["x-rate-class"] !== r.rate || op["x-csrf"] !== r.csrf || op["x-stability"] !== r.stability || op["x-since"] !== r.since) problems.push(`${at}: x- annotations`);
    const declared = Object.keys(op.responses).sort();
    const expected = [String(r.successStatus), ...Object.keys(r.extra ?? {}), "401", "403", "413", "421", "429", ...(r.id === "web.rpc" ? [] : ["504"]), ...(r.requestBody ? ["400", "415"] : [])].filter((s, i, a) => a.indexOf(s) === i).sort();
    if (JSON.stringify(declared) !== JSON.stringify(expected)) problems.push(`${at}: statuses ${declared} != table ${expected}`);
    if (!/^\/api\/v1\//.test(r.path) && !["/rpc", "/events", "/ws"].includes(r.path)) problems.push(`${at}: outside /api/v1`);
    const pathParams = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]); const docParams = ((op.parameters ?? []) as any[]).filter((p) => p.in === "path").map((p) => p.name);
    if (JSON.stringify(pathParams) !== JSON.stringify(docParams)) problems.push(`${at}: path parameters ${pathParams} != documented ${docParams}`);
    if (r.method === "GET" && op.requestBody) problems.push(`${at}: a GET with a request body`);
    if (op.responses[String(r.successStatus)]?.content === undefined) problems.push(`${at}: the success response has no body schema`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the generator's --check passes on this tree: docs/openapi.json and docs/api-surface.md are current", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "scripts/gen-openapi.mjs", "--check"], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepEqual(JSON.parse(readFileSync(path.join(repo, "docs/openapi.json"), "utf8")), JSON.parse(JSON.stringify(doc)));
});

test("the Error schema's code list is the closed ErrorCode enum it says it is", () => {
  const listed = (doc.components.schemas.Error as any).properties.error.enum as string[];
  assert.deepEqual([...listed].sort(), [...ERROR_CODES].sort(), `missing: ${ERROR_CODES.filter((c) => !listed.includes(c)).join(", ")}`);
});

test("KNOWN GAP: every closed error code has its own HTTP status, none falls back to a bare 500", { todo: "KNOWN GAP: statusOfCode has no entry for E_PROJECT_WIP_LIMIT, E_INBOX_CURSOR, E_INVITE_INVALID, E_VOICE_*; see SICHERHEIT in the PR" }, () => {
  const unmapped = ERROR_CODES.filter((c) => statusOfCode(c) === 500 && c !== "E_INTERNAL" && c !== "E_STORAGE");
  assert.deepEqual(unmapped, [], "a core refusal that is the caller's fault would reach the client as a 500");
});

// ---- real answers against the document -----------------------------------------------------------------------------

interface Seen { route: string; label: string; status: number }
const problems: string[] = []; const seen: Seen[] = [];
function rec(id: string, label: string, r: Res): Res {
  const spec = ROUTES.find((x) => x.id === id); if (!spec) throw new Error(`no route ${id}`);
  seen.push({ route: id, label, status: r.status });
  const where = `${id} / ${label} → ${r.status}`; const resp = opOf(spec).responses[String(r.status)];
  if (!resp) { problems.push(`${where}: this status is not in the operation's responses (${Object.keys(opOf(spec).responses).join(", ")})`); return r; }
  if (r.status === 200 && id === "web.events") {
    if (!/^text\/event-stream/.test(String(r.headers["content-type"]))) problems.push(`${where}: wrong stream content type`);
    for (const e of validate(resp.content["text/event-stream"].schema, r.text, doc)) problems.push(`${where}: ${e}`);
    return r;
  }
  if (!/^application\/json/.test(String(r.headers["content-type"]))) problems.push(`${where}: content-type ${r.headers["content-type"]}`);
  if (r.json === undefined) { problems.push(`${where}: the body is not JSON: ${r.text.slice(0, 80)}`); return r; }
  for (const e of validate(resp.content["application/json"].schema, r.json, doc)) problems.push(`${where}: ${e}`);
  return r;
}
const rt = (h: Harness, cookie: string, id: string, label: string, o: { method?: string; path?: string; body?: unknown } = {}) => {
  const spec = ROUTES.find((x) => x.id === id)!;
  return (spec.method === "GET" ? raw(h, { path: o.path ?? spec.path, headers: { cookie } }) : write(h, cookie, { method: spec.method, path: o.path ?? spec.path, ...(o.body !== undefined ? { body: o.body } : {}) })).then((r) => rec(id, label, r));
};
const anon = (h: Harness, id: string, label = "no session") => { const spec = ROUTES.find((x) => x.id === id)!; return raw(h, { method: spec.method, path: spec.path, headers: spec.requestBody ? jsonHeaders() : {}, ...(spec.requestBody ? { body: "{}" } : {}) }).then((r) => rec(id, label, r)); };
const noCsrf = (h: Harness, cookie: string, id: string) => { const spec = ROUTES.find((x) => x.id === id)!; return raw(h, { method: spec.method, path: spec.path, headers: { cookie, ...(spec.requestBody ? jsonHeaders() : {}) }, ...(spec.requestBody ? { body: "{}" } : {}) }).then((r) => rec(id, "no CSRF token", r)); };

async function enrol(h: Harness, cookie: string): Promise<{ secret: string; backup: string[] }> {
  const s = await write(h, cookie, { path: "/api/v1/me/totp/setup" });
  const c = await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code: totpCodeAt(s.json.secret, h.clock.now()) } });
  return { secret: s.json.secret, backup: c.json.backupCodes };
}
const pwLogin = (h: Harness, username: string, extra: Record<string, string> = {}) => raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), ...extra }, body: JSON.stringify({ username, password: FIXTURE_PASSWORD }) });

test("every route, driven through its success and failure paths on the real server, answers as the document says", async () => {
  problems.length = 0; seen.length = 0;
  const accounts = new AccountStore({ path: ":memory:", resolve: async userId => ({ userId, kind: "person", role: "member", disabled: false, version: 1 }) });
  const core = fakeCore(); const inviteCode = randomBytes(32).toString("base64url"); let consumed = false;
  Object.assign(core, { serviceCall: async (method: string, p: { token?: string }) => { if (p.token !== inviteCode || consumed) throw new Error("invalid invitation"); if (method === "user.invite.redeem") consumed = true; return { userId: "invited-person", role: "member" }; } });
  const h = await start({ rateClasses: wide, accounts, core });
  try {
    for (const [id, role] of [["u-alice", "member"], ["u-vera", "viewer"], ["u-ada", "admin"], ["u-dana", "member"], ["u-carol", "member"]] as const) await addUser(h, { id, username: id.slice(2), role });
    const owner = (await login(h)).cookie; const alice = (await loginAs(h, "alice")).cookie; const vera = (await loginAs(h, "vera")).cookie; const ada = (await loginAs(h, "ada")).cookie;

    const registration = (body: object, headers: Record<string, string> = {}) => raw(h, { method: "POST", path: "/api/v1/invitations/redeem", headers: { ...jsonHeaders(), ...headers }, body: JSON.stringify(body) });
    rec("invitation.redeem", "invalid invitation", await registration({ code: randomBytes(32).toString("base64url"), username: "validname", password: FIXTURE_PASSWORD }));
    rec("invitation.redeem", "valid invitation", await registration({ code: inviteCode, username: "validname", password: FIXTURE_PASSWORD }));
    rec("account.bootstrap", "missing session", await raw(h, { method: "POST", path: "/api/v1/accounts/bootstrap", headers: jsonHeaders(), body: "{}" }));
    rec("account.bootstrap", "wrong proof", await write(h, owner, { path: "/api/v1/accounts/bootstrap", body: { proof: "wrong", username: "ownerlogin", password: FIXTURE_PASSWORD } }));
    rec("account.bootstrap", "invalid username", await write(h, owner, { path: "/api/v1/accounts/bootstrap", body: { proof: OWNER_TOKEN, username: "owner", password: FIXTURE_PASSWORD } }));
    rec("account.bootstrap", "current bootstrap proof", await write(h, owner, { path: "/api/v1/accounts/bootstrap", body: { proof: OWNER_TOKEN, username: "ownerlogin", password: FIXTURE_PASSWORD } }));
    // session.create
    rec("session.create", "owner token", (await login(h)).res); rec("session.create", "local account", await pwLogin(h, "alice"));
    const owner2 = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: "f".repeat(64) }) }); rec("session.create", "wrong owner token", owner2);
    rec("session.create", "wrong password", await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "alice", password: "nope-nope" }) }));
    for (const [label, body, ct] of [["no fields", "{}", "application/json"], ["invalid JSON", "{", "application/json"], ["array", "[]", "application/json"], ["extra field", JSON.stringify({ token: "f".repeat(64), x: 1 }), "application/json"]] as const) rec("session.create", label, await raw(h, { method: "POST", path: "/api/v1/session", headers: { "content-type": ct }, body }));
    rec("session.create", "wrong content type", await raw(h, { method: "POST", path: "/api/v1/session", headers: { "content-type": "text/plain" }, body: "x" }));
    rec("session.create", "body too large", await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: "f".repeat(70_000) }) }));
    rec("session.create", "foreign Host", await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), host: "evil.example" }, body: JSON.stringify({ token: "f".repeat(64) }) }));
    rec("session.create", "foreign Origin", await raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), origin: "https://evil.example" }, body: JSON.stringify({ token: "f".repeat(64) }) }));
    let locked: Res | undefined; for (let i = 0; i < 7; i++) { const r = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "nobody-here", password: "nope-nope" }) }); if (r.status === 429) locked = r; }
    rec("session.create", "locked name", locked!);

    // csrf, whoami, health, agents
    rec("csrf.issue", "session", await raw(h, { path: "/api/v1/csrf", headers: { cookie: owner } })); await anon(h, "csrf.issue");
    rec("whoami", "owner session", await raw(h, { path: "/api/v1/whoami", headers: { cookie: owner } })); await anon(h, "whoami");
    const tok = await write(h, owner, { path: "/api/v1/tokens", body: { name: "probe", scopes: ["doctor.read", "agent.list"] } });
    rec("whoami", "personal token", await raw(h, { path: "/api/v1/whoami", headers: { authorization: `Bearer ${tok.json.token}` } }));
    rec("health", "ok", await raw(h, { path: "/api/v1/health", headers: { cookie: owner } })); rec("health", "token", await raw(h, { path: "/api/v1/health", headers: { authorization: `Bearer ${tok.json.token}` } }));
    await anon(h, "health"); rec("health", "role denied", await raw(h, { path: "/api/v1/health", headers: { cookie: alice } }));
    rec("health", "bad token", await raw(h, { path: "/api/v1/health", headers: { authorization: "Bearer plb_nope" } }));
    const impl = h.core.impl;
    h.core.impl = async (m) => { if (m === "core.status") return { rpc: "1.5.0", contract: "7.18.4", uptimeMs: 5, engine: { ready: false, degraded: { reason: "starting" } } }; return impl(m); };
    rec("health", "degraded", await raw(h, { path: "/api/v1/health", headers: { cookie: owner } }));
    h.core.impl = async () => { throw new Error("ECONNREFUSED"); };
    rec("health", "core down", await raw(h, { path: "/api/v1/health", headers: { cookie: owner } }));
    rec("agents.list", "core down", await raw(h, { path: "/api/v1/agents", headers: { cookie: owner } }));
    h.core.impl = async () => { throw Object.assign(new Error("stack /home/me/x.ts:1"), { error: "E_INTERNAL" }); };
    rec("agents.list", "core internal error", await raw(h, { path: "/api/v1/agents", headers: { cookie: owner } }));
    // A core refusal keeps its own code and mapped status (here 404), which no operation can list one by one: checked, not recorded.
    h.core.impl = async () => { throw Object.assign(new Error("no"), { error: "E_AGENT_UNKNOWN", reason: "agent" }); };
    const passthrough = await raw(h, { path: "/api/v1/agents", headers: { cookie: owner } }); assert.deepEqual([passthrough.status, passthrough.json.error], [404, "E_AGENT_UNKNOWN"]);
    h.core.impl = async () => ({ agents: "not a list" });
    rec("agents.list", "core answers garbage", await raw(h, { path: "/api/v1/agents", headers: { cookie: owner } }));
    h.core.impl = impl;
    rec("agents.list", "owner", await raw(h, { path: "/api/v1/agents", headers: { cookie: owner } })); rec("agents.list", "token", await raw(h, { path: "/api/v1/agents", headers: { authorization: `Bearer ${tok.json.token}` } })); await anon(h, "agents.list");
    rec("agents.list", "member without rights", await raw(h, { path: "/api/v1/agents", headers: { cookie: alice } }));

    // tokens
    await rt(h, owner, "tokens.list", "owner"); await rt(h, vera, "tokens.list", "viewer reads"); await anon(h, "tokens.list");
    await rt(h, alice, "tokens.create", "member", { body: { name: "mine", scopes: ["agent.list"], ttlDays: 30 } });
    await rt(h, alice, "tokens.create", "bad scope", { body: { name: "x", scopes: ["no.such.action"] } }); await rt(h, alice, "tokens.create", "bad shape", { body: { name: "x" } });
    await rt(h, alice, "tokens.create", "bad ttl", { body: { name: "x", scopes: ["agent.list"], ttlDays: 0 } }); await rt(h, vera, "tokens.create", "viewer is refused", { body: { name: "x", scopes: ["agent.list"] } });
    await anon(h, "tokens.create"); await noCsrf(h, alice, "tokens.create");
    for (let i = 0; i < 50; i++) { const r = await write(h, ada, { path: "/api/v1/tokens", body: { name: `t${i}`, scopes: ["doctor.read"] } }); if (i === 0) rec("tokens.create", "first of many", r); if (r.status === 409) { rec("tokens.create", "token limit", r); break; } }
    const lim = await write(h, ada, { path: "/api/v1/tokens", body: { name: "one too many", scopes: ["doctor.read"] } }); rec("tokens.create", "token limit", lim);
    const mine = (await raw(h, { path: "/api/v1/tokens", headers: { cookie: alice } })).json.tokens[0].id as string;
    await rt(h, alice, "tokens.revoke", "own token", { body: { id: mine } }); await rt(h, alice, "tokens.revoke", "unknown id", { body: { id: "0".repeat(12) } }); await rt(h, alice, "tokens.revoke", "bad id", { body: { id: "x" } });
    await anon(h, "tokens.revoke"); await noCsrf(h, alice, "tokens.revoke"); await rt(h, vera, "tokens.revoke", "viewer is refused", { body: { id: "0".repeat(12) } });

    // totp
    const dana = (await loginAs(h, "dana")).cookie;
    await rt(h, dana, "totp.status", "off"); await rt(h, owner, "totp.status", "owner has no account"); await anon(h, "totp.status");
    await rt(h, owner, "totp.setup", "owner-token login has no account"); await rt(h, vera, "totp.setup", "viewer is refused"); await anon(h, "totp.setup"); await noCsrf(h, dana, "totp.setup");
    const setup = await rt(h, dana, "totp.setup", "member");
    await rt(h, dana, "totp.confirm", "wrong code", { body: { code: "000000" } }); await rt(h, dana, "totp.confirm", "bad body", { body: { nope: 1 } }); await rt(h, owner, "totp.confirm", "owner has no account", { body: { code: "000000" } });
    await anon(h, "totp.confirm"); await noCsrf(h, dana, "totp.confirm");
    const ok = await rt(h, dana, "totp.confirm", "right code", { body: { code: totpCodeAt(setup.json.secret, h.clock.now()) } });
    await rt(h, dana, "totp.setup", "second factor already on"); await rt(h, dana, "totp.status", "on");
    h.clock.advance(30_000);
    const ch = await pwLogin(h, "dana"); rec("session.create", "challenge instead of a session", ch);
    rec("session.totp", "wrong code", await raw(h, { method: "POST", path: "/api/v1/session/totp", headers: jsonHeaders(), body: JSON.stringify({ challenge: ch.json.challenge, code: "000000" }) }));
    rec("session.totp", "bad body", await raw(h, { method: "POST", path: "/api/v1/session/totp", headers: jsonHeaders(), body: "{}" }));
    rec("session.totp", "right code", await raw(h, { method: "POST", path: "/api/v1/session/totp", headers: jsonHeaders(), body: JSON.stringify({ challenge: ch.json.challenge, code: totpCodeAt(setup.json.secret, h.clock.now()) }) }));
    rec("session.totp", "backup code", await raw(h, { method: "POST", path: "/api/v1/session/totp", headers: jsonHeaders(), body: JSON.stringify({ challenge: (await pwLogin(h, "dana")).json.challenge, code: ok.json.backupCodes[0] }) }));
    rec("session.totp", "wrong content type", await raw(h, { method: "POST", path: "/api/v1/session/totp", headers: { "content-type": "text/plain" }, body: "x" }));
    h.clock.advance(30_000);
    await rt(h, dana, "totp.disable", "wrong code", { body: { code: "000000" } }); await rt(h, owner, "totp.disable", "owner has no account", { body: { code: "000000" } }); await anon(h, "totp.disable"); await noCsrf(h, dana, "totp.disable");
    await rt(h, dana, "totp.disable", "right code", { body: { code: totpCodeAt(setup.json.secret, h.clock.now()) } });

    // break-glass and notices
    const g = await rt(h, owner, "breakglass.request", "owner asks", { body: { targetUserId: "u-alice", reason: "redact-probe-alpha reason text", ttlMinutes: 5 } });
    await rt(h, owner, "breakglass.request", "reason too short", { body: { targetUserId: "u-alice", reason: "short" } }); await rt(h, owner, "breakglass.request", "unknown target", { body: { targetUserId: "u-nobody", reason: "redact-probe-alpha reason text" } });
    await rt(h, owner, "breakglass.request", "self target", { body: { targetUserId: "owner", reason: "redact-probe-alpha reason text" } }); await rt(h, owner, "breakglass.request", "bad shape", { body: { targetUserId: "u-alice" } });
    await rt(h, alice, "breakglass.request", "member is refused", { body: { targetUserId: "u-vera", reason: "redact-probe-alpha reason text" } }); await anon(h, "breakglass.request"); await noCsrf(h, owner, "breakglass.request");
    await rt(h, owner, "breakglass.list", "owner"); await rt(h, alice, "breakglass.list", "member is refused"); await anon(h, "breakglass.list");
    await rt(h, owner, "breakglass.revoke", "unknown grant", { body: { grantId: "nope" } }); await rt(h, owner, "breakglass.revoke", "bad shape", { body: {} }); await anon(h, "breakglass.revoke"); await noCsrf(h, owner, "breakglass.revoke");
    await rt(h, alice, "breakglass.revoke", "member is refused", { body: { grantId: "nope" } });
    await rt(h, owner, "breakglass.revoke", "own grant", { body: { grantId: g.json.grant.id } });
    await rt(h, alice, "notices.list", "member"); await rt(h, vera, "notices.list", "viewer"); await anon(h, "notices.list");

    await anon(h, "web.rpc"); await noCsrf(h, owner, "web.rpc");
    await rt(h, owner, "web.rpc", "RPC envelope", { body: { jsonrpc: "2.0", id: 1, method: "core.status" } });
    rec("web.rpc", "malformed Content-Length", await raw(h, { method: "POST", path: "/rpc", headers: { "content-length": "invalid" } }));
    await anon(h, "web.events"); await rt(h, owner, "web.events", "SSE headers and connected comment");
    await rt(h, owner, "web.events", "query refused", { path: "/events?credential=forbidden" });

    // Direct-chat contracts: the generic server rig uses an explicit fake Core result; true Core lifecycle is tested separately.
    const previousCore = core.impl;
    core.impl = async (method, params) => method.startsWith("chat.") ? JSON.parse(readFileSync(new URL(`../../rpc-schema/fixtures/methods/${method}.json`, import.meta.url), "utf8")).result : previousCore(method, params);
    for (const spec of ROUTES.filter(r => r.id.startsWith("chats."))) {
      const concrete = spec.path.replace("{agentId}", "main").replace("{sessionId}", "contract-chat");
      const body = spec.id === "chats.create" ? { agentId: "main" } : spec.id === "chats.submit" ? { text: "Contract hello" } : spec.requestBody ? {} : undefined;
      await rt(h, alice, spec.id, "owned contract result", { path: concrete, ...(body !== undefined ? { body } : {}) });
      await anon(h, spec.id);
      if (spec.requestBody) await rt(h, alice, spec.id, "unknown fields refused", { path: concrete, body: { unexpected: true } });
      if (spec.csrf) await noCsrf(h, alice, spec.id);
      else await rt(h, owner, spec.id, "unknown query refused", { path: concrete + "?unknown=true" });
    }
    await rt(h, owner, "ws.ticket", "one-use upgrade ticket"); await anon(h, "ws.ticket"); await noCsrf(h, owner, "ws.ticket");
    await rt(h, owner, "ws.reserved", "normal request requires upgrade"); await anon(h, "ws.reserved"); await rt(h, alice, "ws.reserved", "member cannot upgrade");

    // the shared failures, on every route: a foreign Host (421), a foreign Origin (403), and for routes with a body a wrong
    // content type (415), broken JSON (400) and an oversized body (413), each after authentication and the CSRF check
    for (const spec of ROUTES) {
      rec(spec.id, "foreign Host", await raw(h, { method: spec.method, path: spec.path, headers: { host: "evil.example" } }));
      rec(spec.id, "foreign Origin", await raw(h, { method: spec.method, path: spec.path, headers: { origin: "https://evil.example" } }));
      if (!spec.requestBody || spec.auth === "none") continue;
      const attempt = async (label: string, headers: Record<string, string>, body: string) => rec(spec.id, label, await raw(h, { method: spec.method, path: spec.path, headers: { cookie: owner, "x-csrf-token": await csrfToken(h, owner), ...headers }, body }));
      await attempt("wrong content type", { "content-type": "text/plain" }, "x"); await attempt("broken JSON", jsonHeaders(), "{"); await attempt("body too large", jsonHeaders(), JSON.stringify({ code: "x".repeat(spec.id === "web.rpc" ? 1_100_000 : 70_000) }));
    }
    await rt(h, dana, "totp.disable", "bad body", { body: { nope: 1 } });

    // logout (last, they end sessions)
    await anon(h, "session.delete"); await noCsrf(h, ada, "session.delete"); await rt(h, ada, "session.delete", "ends the session");
    const two = (await loginAs(h, "alice")).cookie; await anon(h, "sessions.revoke-all"); await noCsrf(h, two, "sessions.revoke-all"); await rt(h, two, "sessions.revoke-all", "ends every session");
    await rt(h, vera, "sessions.revoke-all", "viewer may sign out");
  } finally { await h.close(); }
  assert.deepEqual(problems, [], `${problems.length} answers differ from the document:\n${problems.join("\n")}`);
});

test("the same, for the paths that need another server: audit down, a hung core, an empty login bucket", async () => {
  problems.length = 0;
  const noAudit = await start({ rateClasses: wide, noAudit: true });
  try {
    await addUser(noAudit, { id: "u-alice", username: "alice", role: "member" }); const owner = (await login(noAudit)).cookie;
    await rt(noAudit, owner, "breakglass.request", "no audit sink, no grant", { body: { targetUserId: "u-alice", reason: "redact-probe-alpha reason text" } });
  } finally { await noAudit.close(); }
  const hung = await start({ rateClasses: wide, limits: { handlerTimeoutMs: 60 } });
  try {
    const owner = (await login(hung)).cookie; hung.core.impl = () => new Promise(() => {});
    rec("agents.list", "core never answers", await raw(hung, { path: "/api/v1/agents", headers: { cookie: owner } }));
    rec("health", "core never answers", await raw(hung, { path: "/api/v1/health", headers: { cookie: owner } }));
  } finally { await hung.close(); }
  const noFeed = await start({ rateClasses: wide });
  try {
    const owner = (await login(noFeed)).cookie;
    noFeed.core.subscribeAs = async () => { throw new Error("event backend failed"); };
    await rt(noFeed, owner, "web.events", "feed unavailable");
  } finally { await noFeed.close(); }
  const tight = await start({ rateClasses: { ...wide, auth: { capacity: 1, refillPerSec: 0.0001 }, read: { capacity: 3, refillPerSec: 0.0001 }, write: { capacity: 2, refillPerSec: 0.0001 } } });
  try {
    const first = await login(tight); rec("session.create", "first within the bucket", first.res);
    rec("session.create", "bucket empty", await raw(tight, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token: "f".repeat(64) }) }));
    for (let i = 0; i < 3; i++) await raw(tight, { path: "/api/v1/whoami", headers: { cookie: first.cookie } });
    const dry = rec("whoami", "read bucket empty", await raw(tight, { path: "/api/v1/whoami", headers: { cookie: first.cookie } }));
    assert.match(String(dry.headers["retry-after"]), /^\d+$/, "a 429 names its Retry-After");
  } finally { await tight.close(); }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("every route was exercised on its success status and on each failure status its operation lists as its own", () => {
  const byRoute = (id: string) => new Set(seen.filter((s) => s.route === id).map((s) => s.status));
  const missing: string[] = [];
  for (const r of ROUTES) {
    const got = byRoute(r.id);
    const want = [r.successStatus, ...Object.keys(r.extra ?? {}).map(Number), ...(r.id === "invitation.redeem" ? [] : [401]), ...(r.requestBody ? [400] : []), ...(r.csrf || typeof r.authz === "object" ? [403] : [])];
    for (const s of want) if (!got.has(s)) missing.push(`${r.id}: ${s} was never observed (saw ${[...got].sort().join(",") || "nothing"})`);
  }
  for (const s of [413, 415, 421, 429, 504]) if (!seen.some((x) => x.status === s)) missing.push(`no route answered ${s} in this run`);
  assert.deepEqual(missing, [], missing.join("\n"));
});
