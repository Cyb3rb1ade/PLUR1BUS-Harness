import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addUser, csrfToken, fakeCore, login, loginAs, raw, start } from "./helpers.ts";
import { ROUTES } from "../src/routes.ts";
import { DEFAULT_RATE_CLASSES } from "../src/rate-limit.ts";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const path = "/api/v1/extensions/upload",
  type = "multipart/form-data; boundary=fixture-boundary";
const bytes = (value = Buffer.from("package-bytes")) =>
  Buffer.concat([
    Buffer.from('--fixture-boundary\r\nContent-Disposition: form-data; name="file"; filename="test.p1x"\r\n\r\n'),
    value,
    Buffer.from("\r\n--fixture-boundary--\r\n"),
  ]);
async function fixture(t: import("node:test").TestContext, productionRate = false) {
  const home = await mkdtemp(join(tmpdir(), "extensions-http-"));
  const core = fakeCore(),
    h = await start({
      home,
      core,
      ...(!productionRate
        ? { rateClasses: { ...DEFAULT_RATE_CLASSES, upload: { capacity: 100, refillPerSec: 100 } } }
        : {}),
    });
  t.after(async () => {
    await h.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, h, core };
}
test("upload attempts consume the dedicated production bucket without draining ordinary reads", async (t) => {
  const { h } = await fixture(t, true);
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await raw(h, { method: "POST", path, headers: { "content-type": type }, body: bytes() })).status,
      401,
    );
  assert.equal((await raw(h, { method: "POST", path, headers: { "content-type": type }, body: bytes() })).status, 429);
  assert.equal((await raw(h, { path: "/api/v1/health" })).status, 401);
});
test("real HTTP upload declares a separate rate class and requires human role, session CSRF and same origin", async (t) => {
  const { h, home } = await fixture(t);
  assert.equal(ROUTES.find((r) => r.id === "extensions.upload")?.rate, "upload");
  const post = (headers: Record<string, string>) =>
    raw(h, { method: "POST", path, headers: { "content-type": type, ...headers }, body: bytes() });
  assert.equal((await post({})).status, 401);
  const { cookie } = await login(h);
  assert.equal((await post({ cookie })).status, 403);
  assert.equal(
    (await post({ cookie, origin: "https://hostile.invalid", "x-csrf-token": await csrfToken(h, cookie) })).status,
    403,
  );
  const res = await post({ cookie, "x-csrf-token": await csrfToken(h, cookie) });
  assert.equal(res.status, 200);
  assert.match(res.json.uploadId, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await readFile(join(home, "run", "uploads", res.json.uploadId)), Buffer.from("package-bytes"));
  assert.equal(
    JSON.parse(await readFile(join(home, "run", "uploads", res.json.uploadId + ".json"), "utf8")).userId,
    "local-owner",
  );
  assert.ok(!res.text.includes(home));
  for (const role of ["admin", "operator", "member", "viewer"] as const) {
    await addUser(h, { id: role, username: role, role });
    const who = await loginAs(h, role);
    const response = await post({ cookie: who.cookie, "x-csrf-token": await csrfToken(h, who.cookie) });
    assert.equal(response.status, role === "admin" ? 200 : 403, role);
  }
});
test("live configured byte limit and interrupted multipart leave no upload behind", async (t) => {
  const { h, home } = await fixture(t),
    { cookie } = await login(h);
  await writeFile(join(home, "config.json"), JSON.stringify({ extensions: { limits: { packageBytes: 1048576 } } }));
  const send = async (body: Buffer) =>
    raw(h, {
      method: "POST",
      path,
      headers: { cookie, "x-csrf-token": await csrfToken(h, cookie), "content-type": type },
      body,
    });
  assert.equal((await send(bytes(Buffer.alloc(1048577)))).status, 413);
  assert.equal((await send(bytes().subarray(0, -8))).status, 400);
  assert.deepEqual(await readdir(join(home, "run", "uploads")), []);
});
test("only this route's enrolled, live person-bound device bearer can upload or inspect; PAT authority stays agent", async (t) => {
  const { h, home, core } = await fixture(t);
  const token = "D".repeat(43);
  let role: "owner" | "member" = "owner",
    scopes = ["extensions.manage", "extensions.read"];
  core.serviceCall = async (method, params) => {
    if (method === "admin.api.desktop.token") {
      if ((params as { token: string }).token !== token) throw new Error("invalid credential");
      return { deviceId: "device", userId: "native", scopes, expiresAt: h.clock.now() + 100_000 } as never;
    }
    if (method === "admin.api.person.resolve")
      return { person: { userId: "native", kind: "person", role, disabled: false, version: 1 } } as never;
    throw new Error("unexpected service call");
  };
  const post = (credential: string) =>
    raw(h, {
      method: "POST",
      path,
      headers: { authorization: `Bearer ${credential}`, "content-type": type },
      body: bytes(),
    });
  const upload = await post(token);
  assert.equal(upload.status, 200);
  assert.equal(
    JSON.parse(await readFile(join(home, "run", "uploads", upload.json.uploadId + ".json"), "utf8")).userId,
    "native",
  );
  let got: unknown;
  core.callAs = async (method, params, principal, endpoint) => {
    got = { method, params, principal, endpoint };
    return { inspectionId: "inspection" } as never;
  };
  const inspected = await raw(h, {
    method: "POST",
    path: "/api/v1/extensions/inspect",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ source: { upload: upload.json.uploadId } }),
  });
  assert.equal(inspected.status, 200);
  assert.deepEqual(got, {
    method: "ext.inspect",
    params: { source: { upload: upload.json.uploadId } },
    principal: { userId: "native", kind: "person", role: "owner", tokenScopes: scopes },
    endpoint: "supervisor",
  });
  scopes = [];
  assert.equal((await post(token)).status, 403);
  scopes = ["extensions.manage"];
  role = "member";
  assert.equal((await post(token)).status, 403);
  assert.equal((await post("invalid")).status, 401);
  assert.equal((await post("plb_invalid")).status, 401);
});

test("a multipart stream can outlast the ordinary request body deadline and an interrupted stream is cleaned", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "extensions-slow-"));
  const h = await start({ home, limits: { requestTimeoutMs: 200, headersTimeoutMs: 200 } });
  t.after(async () => {
    await h.close();
    await rm(home, { recursive: true, force: true });
  });
  const { cookie } = await login(h),
    csrf = await csrfToken(h, cookie),
    body = bytes();
  const result = await new Promise<number>((resolve, reject) => {
    const req = request(
      h.url + path,
      {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf, "content-type": type, "content-length": body.length },
        agent: false,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("test request deadline")));
    req.write(body.subarray(0, body.length - 12));
    void delay(600).then(() => req.end(body.subarray(-12)));
  });
  assert.equal(result, 200);
  assert.equal(h.api.server.requestTimeout, 600000);
});

test("native file credentials do not substitute for mandatory MFA", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "extensions-mfa-")),
    core = fakeCore();
  const h = await start({ home, core, requireSecondFactor: "always" });
  t.after(async () => {
    await h.close();
    await rm(home, { recursive: true, force: true });
  });
  core.serviceCall = async (method) =>
    method === "admin.api.desktop.token"
      ? ({
          deviceId: "device",
          userId: "native",
          scopes: ["extensions.manage"],
          expiresAt: h.clock.now() + 100000,
        } as never)
      : ({ person: { userId: "native", role: "owner", disabled: false, version: 1 } } as never);
  const response = await raw(h, {
    method: "POST",
    path,
    headers: { authorization: `Bearer ${"D".repeat(43)}`, "content-type": type },
    body: bytes(),
  });
  assert.equal(response.status, 403);
  assert.equal(response.json.reason, "second-factor-required");
  assert.deepEqual(await readdir(join(home, "run", "uploads")), []);
});
