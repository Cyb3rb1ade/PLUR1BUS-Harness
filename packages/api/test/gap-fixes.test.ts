// F3 (rate-limit buckets behind a shared address), F4 (model-backed class and concurrency cap), F7 (malformed percent escapes).
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RATE_CLASSES, EXPENSIVE_RPC_METHODS } from "../src/rate-limit.ts";
import { ROUTES } from "../src/routes.ts";
import { addUser, csrfToken, FIXTURE_PASSWORD, jsonHeaders, login, raw, start, type Harness } from "./helpers.ts";

const HOST = "box.tail1234.ts.net";
const tailnet = { remote: { publish: "tailnet" as const, publicOrigin: `https://${HOST}` }, requireSecondFactor: "never" as const };
const viaGateway = { host: HOST };
const loginT = (h: Harness, username: string, password: string) => raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(viaGateway), body: JSON.stringify({ username, password }) });
const cookieOf = (r: { headers: { "set-cookie"?: string[] | undefined } }) => (r.headers["set-cookie"]?.[0] ?? "").split(";", 1)[0]!;
const whoamiT = (h: Harness, cookie: string) => raw(h, { path: "/api/v1/whoami", headers: { ...viaGateway, cookie } });

test("tailnet mode: five wrong passwords for one name stop that name, not every other client behind the same gateway address", async () => {
  const h = await start({ ...tailnet, lockout: { maxFailures: 1000 } });
  try {
    await addUser(h, { id: "u-alice", username: "alice", role: "member" }); await addUser(h, { id: "u-bob", username: "bob", role: "member" });
    for (let i = 0; i < 5; i++) assert.equal((await loginT(h, "alice", "wrong-password-guess")).status, 401, `attempt ${i + 1}`);
    const stopped = await loginT(h, "alice", "wrong-password-guess");
    assert.equal(stopped.status, 429); assert.equal(stopped.json.reason, "rate-limited"); assert.ok(Number(stopped.headers["retry-after"]) >= 1);
    assert.equal((await loginT(h, "alice", FIXTURE_PASSWORD)).status, 429, "the name stays stopped until its bucket refills, whoever asks");
    assert.equal((await loginT(h, "bob", FIXTURE_PASSWORD)).status, 200, "another account behind the same address is not affected");
    assert.ok(h.audit.events.some(e => e.action === "auth.rate-limited"));
  } finally { await h.close(); }
});

test("tailnet mode: the address bucket stays as an upper bound, so spraying many names from the gateway is still capped", async () => {
  const h = await start({ ...tailnet });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 55; i++) codes.push((await loginT(h, `spray-${i}`, "wrong-password-guess")).status);
    assert.equal(codes.filter(c => c === 401).length, 50, "5 (the auth capacity) x 10 for the shared address");
    assert.deepEqual(codes.slice(50), [429, 429, 429, 429, 429]);
  } finally { await h.close(); }
});

test("tailnet mode: authenticated requests are limited per principal, so one busy person does not drain the address bucket for the others", async () => {
  const h = await start({ ...tailnet });
  try {
    await addUser(h, { id: "u-alice", username: "alice", role: "member" }); await addUser(h, { id: "u-bob", username: "bob", role: "member" });
    const alice = cookieOf(await loginT(h, "alice", FIXTURE_PASSWORD)); const bob = cookieOf(await loginT(h, "bob", FIXTURE_PASSWORD));
    let ok = 0; for (let i = 0; i < DEFAULT_RATE_CLASSES.read.capacity + 5; i++) if ((await whoamiT(h, alice)).status === 200) ok++;
    assert.equal(ok, DEFAULT_RATE_CLASSES.read.capacity, "alice runs into her own bucket");
    assert.equal((await whoamiT(h, alice)).status, 429);
    assert.equal((await whoamiT(h, bob)).status, 200, "bob still answers although alice used up what a single shared address bucket would hold");
  } finally { await h.close(); }
});

test("without a gateway the address bucket stays strict: five failed logins from one address stop the sixth from any name", async () => {
  const h = await start();
  try {
    await addUser(h, { id: "u-bob", username: "bob", role: "member" });
    for (let i = 0; i < 5; i++) assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "alice", password: "wrong-password-guess" }) })).status, 401);
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "bob", password: FIXTURE_PASSWORD }) })).status, 429);
  } finally { await h.close(); }
});

const wide = { auth: { capacity: 1000, refillPerSec: 1000 }, read: { capacity: 1000, refillPerSec: 1000 }, write: { capacity: 1000, refillPerSec: 1000 } };
const rpc = async (h: Harness, cookie: string, method: string, params: object = {}) =>
  raw(h, { method: "POST", path: "/rpc", headers: { "content-type": "application/json", cookie, "x-csrf-token": await csrfToken(h, cookie) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
const RPC_PARAMS: Record<string, object> = { "jobs.run": { job: "models.scan" }, "dreams.run": { agentId: "main", phase: "light" }, "voice.realtime.start": { agentId: "main", chatSessionId: "chat-1" }, "session.submit": { sessionId: "ses_1", text: "hello" } };

test("ADR-004: the model-backed methods and the chat submit are class `expensive`, everything else keeps its class", () => {
  assert.deepEqual([...EXPENSIVE_RPC_METHODS].sort(), ["dreams.run", "jobs.run", "session.submit", "voice.realtime.start"]);
  assert.equal(ROUTES.find(r => r.id === "chats.submit")!.rate, "expensive");
  assert.equal(ROUTES.find(r => r.id === "chats.create")!.rate, "write"); assert.equal(ROUTES.find(r => r.id === "chats.messages")!.rate, "read");
  assert.equal(ROUTES.find(r => r.id === "web.rpc")!.rate, "rpc");
});

test("model-backed RPC methods share one `expensive` bucket per person; other methods and other people are unaffected", async () => {
  const h = await start({ rateClasses: { ...wide, expensive: { capacity: 2, refillPerSec: 0.001 } } });
  try {
    await addUser(h, { id: "u-alice", username: "alice", role: "member" });
    const owner = (await login(h)).cookie;
    const first = await rpc(h, owner, "jobs.run", RPC_PARAMS["jobs.run"]); const second = await rpc(h, owner, "dreams.run", RPC_PARAMS["dreams.run"]);
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    const third = await rpc(h, owner, "voice.realtime.start", RPC_PARAMS["voice.realtime.start"]);
    assert.equal(third.status, 429); assert.equal(third.json.reason, "rate-limited"); assert.ok(Number(third.headers["retry-after"]) >= 1);
    assert.equal((await rpc(h, owner, "session.submit", RPC_PARAMS["session.submit"])).status, 429, "session.submit draws on the same bucket");
    assert.equal((await rpc(h, owner, "core.status")).status, 200, "a cheap method is not counted");
    assert.ok(h.audit.events.some(e => e.action === "auth.rate-limited" && (e.detail as { class?: string }).class === "expensive"));
    const alice = (await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "alice", password: FIXTURE_PASSWORD }) })).headers["set-cookie"]![0]!.split(";", 1)[0]!;
    assert.equal((await rpc(h, alice, "jobs.run", RPC_PARAMS["jobs.run"])).status, 200, "somebody else's bucket is full");
  } finally { await h.close(); }
});

const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(cond(), "condition was not reached"); };

test("the global concurrency cap refuses a second model-backed call while one runs and frees the slot when it ends", async () => {
  const h = await start({ rateClasses: wide, expensiveConcurrency: 1 });
  try {
    let release!: () => void; const gate = new Promise<unknown>(r => { release = () => r({ started: true }); });
    const base = h.core.impl;
    h.core.impl = async (method, params) => method === "jobs.run" ? gate : base(method, params);
    const owner = (await login(h)).cookie;
    const running = rpc(h, owner, "jobs.run", RPC_PARAMS["jobs.run"]);
    await until(() => h.core.calls.some(c => c.method === "jobs.run"));
    const refused = await rpc(h, owner, "dreams.run", RPC_PARAMS["dreams.run"]);
    assert.equal(refused.status, 429); assert.equal(refused.json.reason, "rate-limited"); assert.ok(Number(refused.headers["retry-after"]) >= 1);
    assert.equal((await rpc(h, owner, "core.status")).status, 200, "work that is not model-backed does not need a slot");
    release();
    assert.equal((await running).status, 200);
    assert.equal((await rpc(h, owner, "dreams.run", RPC_PARAMS["dreams.run"])).status, 200, "the slot came back");
    assert.ok(h.audit.events.some(e => e.action === "auth.rate-limited" && (e.detail as { class?: string }).class === "expensive"));
  } finally { await h.close(); }
});

test("a chat submit over REST holds a slot of the same cap while it runs", async () => {
  const h = await start({ rateClasses: wide, expensiveConcurrency: 1 });
  try {
    let release!: () => void; const gate = new Promise<unknown>(r => { release = () => r({}); });
    const base = h.core.impl;
    h.core.impl = async (method, params) => method === "chat.submit" ? gate : base(method, params);
    const owner = (await login(h)).cookie;
    const submit = async () => raw(h, { method: "POST", path: "/api/v1/chats/ses_1/messages", headers: { ...jsonHeaders(), cookie: owner, "x-csrf-token": await csrfToken(h, owner) }, body: JSON.stringify({ text: "hello" }) });
    const running = submit();
    await until(() => h.core.calls.some(c => c.method === "chat.submit"));
    const refused = await submit();
    assert.equal(refused.status, 429); assert.equal(refused.json.reason, "rate-limited");
    release(); await running;
    const after = await submit(); assert.notEqual(after.status, 429, "the slot was released when the first submit ended");
  } finally { await h.close(); }
});

test("F7: a malformed percent escape in a path parameter is a 400 with the shared headers, never a 500, and a valid escape still routes", async () => {
  const h = await start();
  try {
    for (const bad of ["/api/v1/chats/%E0%A4%A", "/api/v1/chats/%", "/api/v1/chats/%zz/messages", "/api/v1/agents/%C0%AF/chats"]) {
      const r = await raw(h, { path: bad });
      assert.equal(r.status, 400, bad); assert.equal(r.json.reason, "path"); assert.equal(r.headers["x-content-type-options"], "nosniff");
    }
    assert.equal((await raw(h, { path: "/api/v1/chats/ses%5F1" })).status, 401, "a well-formed escape reaches the authentication step");
    assert.ok(!h.logs.some(l => /"level":"error"/.test(l)), "no unhandled error was logged");
  } finally { await h.close(); }
});
