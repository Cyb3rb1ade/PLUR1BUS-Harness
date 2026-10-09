import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AuthService, LoopbackPkce, OpenAIError, Sensitive, type PkcePort } from "../../src/openai-auth/index.ts";
import { buildAuthSurface } from "../../src/rpc/auth-surface.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import type { CallContext, Handler } from "../../src/rpc/server.ts";
import { FakeOpenAI, MemorySecrets } from "../fixtures/openai/server.ts";

const schema = JSON.parse(readFileSync(new URL("../../../rpc-schema/schema/rpc.schema.json", import.meta.url), "utf8"));
const OWNER = { userId: "local-owner", role: "owner", kind: "person" } as const;

/** A PKCE port that waits until the test delivers the browser's callback, like a person finishing the sign-in. */
class Gate implements PkcePort {
  urls: string[] = [];
  #release!: () => void;
  readonly #opened = new Promise<void>(resolve => { this.#release = resolve; });
  readonly fake: FakeOpenAI;
  constructor(fake: FakeOpenAI) { this.fake = fake; }
  async redirect() { return this.fake.redirect(); }
  async close() {}
  deliver() { this.#release(); }
  authorize(request: Parameters<PkcePort["authorize"]>[0]) {
    this.urls.push(request.url.value());
    return new Promise<string>((resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new OpenAIError(request.signal.reason?.name === "TimeoutError" ? "login-timeout" : "login-cancelled")), { once: true });
      void this.#opened.then(() => this.fake.authorize(request)).then(resolve, reject);
    });
  }
}

function setup(o: { timeoutMs?: number; loopback?: boolean } = {}) {
  const fake = new FakeOpenAI(), store = new MemorySecrets(), events: unknown[] = [], gate = new Gate(fake);
  const service = new AuthService({ http: fake, store, clock: { now: () => fake.now }, audit: e => { events.push(e); }, ...(o.loopback ? { pkce: () => new LoopbackPkce(async () => {}) } : { pkce: () => gate }), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
  const raw = buildAuthSurface(() => service);
  const methods = guardMethods(raw, { resolve: () => OWNER, now: () => 1 });
  const ctx = (signal = new AbortController().signal): CallContext => ({ requestId: "r", connectionId: "c", signal });
  const call = (m: string, p: unknown = {}, signal?: AbortSignal) => methods[m]!(p, ctx(signal));
  const reason = async (promise: Promise<unknown>) => promise.then(() => assert.fail("expected a refusal"), (e: unknown) => { assert.ok(e instanceof RpcError, String(e)); return { error: e.error, reason: e.reason, message: e.message }; });
  /** Everything a client, a log or an audit sink could ever see. */
  const leaks = (...seen: unknown[]) => { const text = JSON.stringify([seen, events]); for (const secret of fake.secrets) assert.equal(text.includes(secret), false, "secret leaked"); };
  return { fake, store, events, gate, service, methods, call, reason, leaks, ctx };
}

test("the auth surface declares exactly the six schema methods, all core and closed", () => {
  const names = Object.keys(buildAuthSurface(() => null)).sort();
  assert.deepEqual(names, ["auth.credentials.list", "auth.login.await", "auth.login.cancel", "auth.login.start", "auth.logout", "auth.status"]);
  for (const n of names) { assert.equal(schema.$defs.methods[n]["x-server"], "core"); assert.equal(schema.$defs.methods[n].params.additionalProperties, false); }
});

test("login start → deliver callback → await → list/status → logout; results are metadata only", async () => {
  const s = setup();
  const started = await s.call("auth.login.start", { provider: "openai" }) as { attemptId: string; authorizeUrl: string; callbackPort: number };
  assert.deepEqual(Object.keys(started).sort(), ["attemptId", "authorizeUrl", "callbackPort"]);
  assert.equal(started.callbackPort, 49152);
  assert.equal(new URL(started.authorizeUrl).searchParams.get("code_challenge_method"), "S256");
  assert.equal(((await s.call("auth.status")) as { pendingLogins: number }).pendingLogins, 1);
  const waiting = s.call("auth.login.await", { attemptId: started.attemptId });
  s.gate.deliver();
  const credential = await waiting as Record<string, unknown>;
  assert.deepEqual(Object.keys(credential).sort(), ["billingPath", "expiresAt", "id", "kind", "needsLogin", "person", "workspace"]);
  assert.match(String(credential.id), /^[a-f0-9]{64}$/);
  assert.equal(credential.person, "local-owner"); assert.equal(credential.needsLogin, false);
  const listed = await s.call("auth.credentials.list") as { credentials: unknown[] };
  assert.deepEqual(listed.credentials, [credential]);
  const status = await s.call("auth.status") as { credentials: unknown[]; pendingLogins: number };
  assert.deepEqual(status, { credentials: [credential], pendingLogins: 0 });
  assert.deepEqual(await s.call("auth.logout", { id: credential.id }), { id: credential.id, loggedOut: true });
  assert.deepEqual(await s.call("auth.credentials.list"), { credentials: [] });
  assert.equal(s.store.data.size > 0, true); // host key stays; no account record
  assert.equal([...s.store.data.keys()].some(k => k.startsWith("openai.plan.")), false);
  s.leaks(started, credential, listed, status);
});

test("cancel: a waiting await fails with login-cancelled; a second cancel is unknown; nothing is stored", async () => {
  const s = setup();
  const { attemptId } = await s.call("auth.login.start") as { attemptId: string };
  const waiting = s.reason(s.call("auth.login.await", { attemptId }));
  assert.deepEqual(await s.call("auth.login.cancel", { attemptId }), { cancelled: true });
  assert.deepEqual(await waiting, { error: "E_CONFLICT", reason: "login-cancelled", message: "login refused (login-cancelled)" });
  assert.deepEqual((await s.reason(s.call("auth.login.cancel", { attemptId }))).error, "E_NOT_FOUND");
  assert.deepEqual(await s.call("auth.status"), { credentials: [], pendingLogins: 0 });
});

test("cancel with nobody waiting settles the attempt", async () => {
  const s = setup();
  const { attemptId } = await s.call("auth.login.start") as { attemptId: string };
  await s.call("auth.login.cancel", { attemptId });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(((await s.call("auth.status")) as { pendingLogins: number }).pendingLogins, 0);
});

test("timeout surfaces login-timeout", async () => {
  const s = setup({ timeoutMs: 20 });
  const { attemptId } = await s.call("auth.login.start") as { attemptId: string };
  const keepAlive = setInterval(() => {}, 10); // AbortSignal.timeout timers are unref'd
  const refusal = await s.reason(s.call("auth.login.await", { attemptId })).finally(() => clearInterval(keepAlive));
  assert.equal(refusal.reason, "login-timeout"); assert.equal(refusal.error, "E_CONFLICT");
});

test("state mismatch is a distinct, constant refusal and stores nothing", async () => {
  const s = setup(); s.fake.badState = true;
  const { attemptId } = await s.call("auth.login.start") as { attemptId: string };
  const waiting = s.reason(s.call("auth.login.await", { attemptId })); s.gate.deliver();
  const refusal = await waiting;
  assert.deepEqual([refusal.error, refusal.reason], ["E_DENIED", "state-mismatch"]);
  assert.deepEqual(await s.call("auth.credentials.list"), { credentials: [] });
  s.leaks(refusal);
});

test("paste-callback: replaying the redirected URL against the real loopback listener completes the login", async () => {
  const s = setup({ loopback: true });
  const started = await s.call("auth.login.start") as { attemptId: string; authorizeUrl: string; callbackPort: number };
  const url = new URL(started.authorizeUrl);
  assert.equal(new URL(url.searchParams.get("redirect_uri")!).port, String(started.callbackPort));
  const waiting = s.call("auth.login.await", { attemptId: started.attemptId });
  // What the browser ends up showing on a remote machine, and what the CLI replays locally after the person pastes it.
  const callback = await s.fake.authorize({ url: new Sensitive(started.authorizeUrl), redirectUri: url.searchParams.get("redirect_uri")!, signal: new AbortController().signal });
  assert.equal((await fetch(callback)).status, 200);
  const credential = await waiting as { id: string };
  assert.match(credential.id, /^[a-f0-9]{64}$/);
  // The callback is single use.
  assert.notEqual((await fetch(callback).catch(() => ({ status: 0 }))).status, 200);
  s.leaks(credential);
});

test("a dropped awaiting connection cancels the login instead of holding the listener", async () => {
  const s = setup();
  const { attemptId } = await s.call("auth.login.start") as { attemptId: string };
  const gone = new AbortController();
  const waiting = s.reason(s.call("auth.login.await", { attemptId }, gone.signal));
  gone.abort(new Error("connection closed"));
  assert.equal((await waiting).reason, "login-cancelled");
  assert.equal(((await s.call("auth.status")) as { pendingLogins: number }).pendingLogins, 0);
});

test("refusals: unknown provider, malformed ids, unknown credential, no service", async () => {
  const s = setup();
  assert.deepEqual((await s.reason(s.call("auth.login.start", { provider: "anthropic" }))).error, "E_INVALID_PARAMS");
  assert.deepEqual((await s.reason(s.call("auth.logout", { id: "../etc" }))).error, "E_INVALID_PARAMS");
  assert.deepEqual((await s.reason(s.call("auth.logout", { id: "a".repeat(64) }))).error, "E_NOT_FOUND");
  assert.deepEqual((await s.reason(s.call("auth.login.await", { attemptId: "nope" }))).reason, "login-unknown");
  const none = guardMethods(buildAuthSurface(() => null), { resolve: () => OWNER, now: () => 1 }) as Record<string, Handler>;
  for (const m of Object.keys(none)) await assert.rejects(() => none[m]!({ attemptId: "x", id: "a".repeat(64) }, s.ctx()), { error: "E_NOT_AVAILABLE" });
});

test("a handler never runs without the guard's authenticated principal", async () => {
  const s = setup();
  for (const [name, handler] of Object.entries(buildAuthSurface(() => s.service))) await assert.rejects(() => handler({}, s.ctx()), { error: "E_UNAUTHORIZED" }, name);
});

test("foreign failures are reduced to constant text", async () => {
  const s = setup(); s.fake.failPath = "/.well-known/openid-configuration";
  const refusal = await s.reason(s.call("auth.login.start"));
  assert.equal(refusal.error, "E_NOT_AVAILABLE");
  s.leaks(refusal);
});
