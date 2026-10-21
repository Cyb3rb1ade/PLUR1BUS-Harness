// The loopback listener of login() is a one-shot per login, but only a callback that carries the issued state may end it.
// Anything else (forged, stateless, duplicate state, foreign Host) is answered with a constant 400 and leaves the listener open.
import { it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { inspect } from "node:util";
import { login } from "../../src/auth/login.ts";
import { createOAuthHttp } from "../../src/auth/http.ts";
import { InMemorySecretStore } from "../../src/auth/secret-store.ts";
import { mockOAuth } from "./mock-oauth.ts";
import { FakeClock, MARK } from "./helpers.ts";

const desktop = { platform: "darwin" as const, env: {}, stdoutIsTTY: true };
const FIXED = "Sign-in failed. Close this window and try again.";

type Mock = Awaited<ReturnType<typeof mockOAuth>>;
function run(m: Mock, onBrowser: (valid: string, redirect: string) => Promise<void>, over: Record<string, unknown> = {}) {
  const store = new InMemorySecretStore();
  const result = login({ profile: m.profile(), store, clock: new FakeClock(), http: createOAuthHttp({ egress: m.egress }), env: desktop,
    openBrowser: async url => { await onBrowser(await m.callback(url), new URL(url).searchParams.get("redirect_uri")!); }, ...over });
  return { store, result };
}
const withState = (valid: string, mutate: (u: URL) => void) => { const u = new URL(valid); mutate(u); return u.href; };
const tokenCalls = (m: Mock) => m.requests.filter(r => r.path === "/token").length;

it("a forged callback does not consume the listener: constant 400 without echo, then the genuine callback completes the login", async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  const forged: string[] = [];
  const { store, result } = run(m, async valid => {
    for (const bad of [
      withState(valid, u => u.searchParams.set("state", MARK.key)),
      withState(valid, u => u.searchParams.delete("state")),
      withState(valid, u => u.searchParams.append("state", u.searchParams.get("state")!)),
      withState(valid, u => { u.searchParams.set("state", ""); }),
    ]) {
      const res = await fetch(bad); const body = await res.text();
      forged.push(`${res.status}:${body}`);
      assert.ok(!body.includes(MARK.key) && !body.includes("CANARY-CODE"));
    }
    assert.equal(tokenCalls(m), 0);
    const ok = await fetch(valid); assert.equal(ok.status, 200);
  });
  const r = await result;
  assert.equal(r.method, "loopback_pkce");
  assert.deepEqual(forged, [`400:${FIXED}`, `400:${FIXED}`, `400:${FIXED}`, `400:${FIXED}`]);
  assert.ok(await store.get("auth/test"));
  assert.equal(tokenCalls(m), 1);
});

it("a foreign Host header (DNS rebinding) is refused with the same constant 400 and does not consume the listener", async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  let status = 0, body = "";
  const { result } = run(m, async (valid, redirect) => {
    const u = new URL(valid);
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: Number(new URL(redirect).port), path: u.pathname + u.search, headers: { host: "evil.example" } }, res => {
        status = res.statusCode ?? 0; res.setEncoding("utf8"); res.on("data", c => { body += c; }); res.on("end", resolve);
      });
      req.on("error", reject); req.end();
    });
    assert.equal((await fetch(valid)).status, 200);
  });
  await result;
  assert.equal(status, 400); assert.equal(body, FIXED);
});

it("more than ten failed attempts per second are answered 429, and the genuine callback is still accepted during the flood", async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  const statuses: number[] = [];
  const { result } = run(m, async valid => {
    const bad = withState(valid, u => u.searchParams.set("state", MARK.key));
    for (let i = 0; i < 14; i++) { const res = await fetch(bad); statuses.push(res.status); assert.ok(!(await res.text()).includes(MARK.key)); }
    assert.equal((await fetch(valid)).status, 200);
  });
  await result;
  assert.equal(statuses.slice(0, 10).every(s => s === 400), true, statuses.join());
  assert.equal(statuses.slice(10).every(s => s === 429), true, statuses.join());
  assert.equal(tokenCalls(m), 1);
});

it("timeout and cancellation still close the listener after forged callbacks", async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  let redirect = "";
  const { store, result } = run(m, async (valid, r) => {
    redirect = r;
    assert.equal((await fetch(withState(valid, u => u.searchParams.set("state", MARK.key)))).status, 400);
    await new Promise<void>(() => {}); // the UI never finishes
  }, { timeoutMs: 80 });
  await assert.rejects(result, (e: any) => e.code === "login_timeout" && !inspect(e).includes(MARK.key));
  await assert.rejects(fetch(redirect));
  assert.equal(await store.get("auth/test"), undefined);
  assert.equal(tokenCalls(m), 0);

  const controller = new AbortController();
  const second = run(m, async (valid, r) => {
    redirect = r;
    assert.equal((await fetch(withState(valid, u => u.searchParams.set("state", MARK.key)))).status, 400);
    controller.abort();
    await new Promise<void>(() => {});
  }, { signal: controller.signal });
  await assert.rejects(second.result, (e: any) => e.code === "login_timeout");
  await assert.rejects(fetch(redirect));
});

it("a callback with the issued state still ends the listener: provider error and malformed code reject, and nothing is exchanged", async t => {
  const m = await mockOAuth(); t.after(() => m.close());
  for (const [variant, code] of [["error", "access_denied"], ["code", "login_failed"]] as const) {
    let redirect = "";
    const { result } = run(m, async (valid, r) => {
      redirect = r;
      const cb = withState(valid, u => { if (variant === "error") { u.searchParams.delete("code"); u.searchParams.set("error", "access_denied"); } else u.searchParams.append("code", MARK.key); });
      const res = await fetch(cb); assert.equal(res.status, 400); assert.ok(!(await res.text()).includes(MARK.key));
      await assert.rejects(fetch(valid)); // one-shot: the listener is gone
    });
    await assert.rejects(result, (e: any) => e.code === code && !inspect(e).includes(MARK.key));
    await assert.rejects(fetch(redirect));
  }
  assert.equal(tokenCalls(m), 0);
});
