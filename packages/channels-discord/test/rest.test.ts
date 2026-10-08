import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordApi, DiscordApiError, clampRetryMs, MAX_RETRY_MS, MIN_RETRY_MS } from "../src/index.ts";
import { FakeClock, drive, settle } from "./helpers/fake-clock.ts";
import { FakeDiscordRest, TOKEN, cdnAwareFetch } from "./helpers/fake-discord.ts";

async function rig(extra: Partial<ConstructorParameters<typeof DiscordApi>[0]> = {}) {
  const rest = new FakeDiscordRest();
  await rest.listen();
  const clock = new FakeClock();
  const api = new DiscordApi({
    token: TOKEN,
    baseUrl: `${rest.baseUrl}/api/v10`,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
    fetch: cdnAwareFetch(rest),
    cdnHosts: ["cdn.discordapp.com"],
    ...extra,
  });
  return { rest, clock, api, close: () => rest.close() };
}
const ac = () => new AbortController().signal;

test("retry-after is clamped in both directions", () => {
  assert.equal(clampRetryMs(0.001), MIN_RETRY_MS);
  assert.equal(clampRetryMs(99_999), MAX_RETRY_MS);
  assert.equal(clampRetryMs("2.5"), 2500);
  assert.equal(clampRetryMs(undefined), MIN_RETRY_MS);
  assert.equal(clampRetryMs(Number.NaN), MIN_RETRY_MS);
});

const retryCases: Array<[string, { retry_after: number }, number]> = [
  ["tiny body retry_after is raised to the floor", { retry_after: 0.01 }, 1000],
  ["normal body retry_after is honoured", { retry_after: 2 }, 2000],
  ["huge body retry_after is capped", { retry_after: 86_400 }, 300_000],
];
for (const [name, body, expectedMs] of retryCases)
  test(`429 body: ${name}`, async () => {
    const r = await rig();
    try {
      r.rest.fail("GET /api/v10/users/@me", { status: 429, body: { ...body, message: "slow down", global: false } });
      const p = r.api.request<{ id: string }>({ method: "GET", path: "/users/@me", signal: ac() });
      await drive(r.clock, p);
      assert.equal((await p).id, "900000000000000001");
      assert.ok(r.clock.slept.includes(expectedMs), `slept ${r.clock.slept.join(",")}`);
      assert.equal(r.rest.callsOf("GET", "/api/v10/users/@me").length, 2);
    } finally {
      await r.close();
    }
  });

test("429 header Retry-After is used when the body has none", async () => {
  const r = await rig();
  try {
    r.rest.fail("GET /api/v10/users/@me", { status: 429, body: { message: "x" }, headers: { "retry-after": "3" } });
    const p = r.api.request({ method: "GET", path: "/users/@me", signal: ac() });
    await drive(r.clock, p);
    await p;
    assert.ok(r.clock.slept.includes(3000));
  } finally {
    await r.close();
  }
});

test("429 with exhausted retries surfaces rate-limited with the clamped delay", async () => {
  const r = await rig({ maxRetries: 1 });
  try {
    r.rest.fail("GET /api/v10/users/@me", { status: 429, body: { retry_after: 9 } });
    r.rest.fail("GET /api/v10/users/@me", { status: 429, body: { retry_after: 9 } });
    const p = r.api.request({ method: "GET", path: "/users/@me", signal: ac() });
    await drive(r.clock, p);
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof DiscordApiError);
      assert.equal(e.kind, "rate-limited");
      assert.equal(e.retryAfterMs, 9000);
      return true;
    });
    assert.equal(r.rest.callsOf("GET").length, 2);
  } finally {
    await r.close();
  }
});

test("global 429 penalises unrelated routes too", async () => {
  const r = await rig();
  try {
    r.rest.fail("GET /api/v10/users/@me", { status: 429, body: { retry_after: 4, global: true } });
    const p = r.api.request({ method: "GET", path: "/users/@me", signal: ac() });
    await settle(r.clock, () => r.clock.slept.includes(4000));
    await r.clock.advance(4000);
    await p;
  } finally {
    await r.close();
  }
});

test("X-RateLimit-Remaining 0 makes the next call on that bucket wait for the reset", async () => {
  const r = await rig();
  try {
    // First response reports an exhausted bucket with a reset in 2 s.
    r.rest.fail("GET /api/v10/users/@me", {
      status: 200,
      body: { id: "900000000000000001" },
      headers: { "x-ratelimit-bucket": "b", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2" },
    });
    await r.api.request({ method: "GET", path: "/users/@me", signal: ac() });
    let done = false;
    const p = r.api.request({ method: "GET", path: "/users/@me", signal: ac() }).then(() => (done = true));
    await r.clock.flush();
    assert.equal(done, false, "second call waits");
    await r.clock.advance(2000);
    await p;
    assert.equal(done, true);
  } finally {
    await r.close();
  }
});

test("403 and 400 are never retried", async () => {
  for (const status of [400, 403, 404]) {
    const r = await rig();
    try {
      r.rest.fail("POST /api/v10/channels", { status, body: { message: "nope", code: 50007 } });
      await assert.rejects(
        r.api.request({ method: "POST", path: "/channels/555000000000000001/messages", json: { content: "x" }, signal: ac() }),
      );
      assert.equal(r.rest.callsOf("POST").length, 1, `status ${status} attempted once`);
    } finally {
      await r.close();
    }
  }
});

test("403 maps to forbidden with the discord code, no URL in the message", async () => {
  const r = await rig();
  try {
    r.rest.fail("POST /api/v10/channels", { status: 403, body: { message: "Missing Access", code: 50001 } });
    await assert.rejects(
      r.api.request({ method: "POST", path: "/channels/555000000000000001/messages", json: { content: "x" }, signal: ac() }),
      (e: unknown) => {
        assert.ok(e instanceof DiscordApiError);
        assert.equal(e.kind, "forbidden");
        assert.equal(e.code, 50001);
        assert.ok(!e.message.includes("/channels/"));
        return true;
      },
    );
  } finally {
    await r.close();
  }
});

test("5xx is retried a bounded number of times", async () => {
  const r = await rig({ maxRetries: 2 });
  try {
    for (let i = 0; i < 3; i++) r.rest.fail("GET /api/v10/users/@me", { status: 503, body: {} });
    const p = r.api.request({ method: "GET", path: "/users/@me", signal: ac() });
    await drive(r.clock, p);
    await assert.rejects(p, (e: unknown) => e instanceof DiscordApiError && e.kind === "http");
    assert.equal(r.rest.callsOf("GET").length, 3);
  } finally {
    await r.close();
  }
});

test("401 is unauthorized and not retried; the token never appears in the error", async () => {
  const r = await rig();
  try {
    r.rest.fail("GET /api/v10/users/@me", { status: 401, body: { message: `401: Unauthorized ${TOKEN}` } });
    await assert.rejects(r.api.request({ method: "GET", path: "/users/@me", signal: ac() }), (e: unknown) => {
      assert.ok(e instanceof DiscordApiError);
      assert.equal(e.kind, "unauthorized");
      assert.ok(!e.message.includes(TOKEN));
      return true;
    });
    assert.equal(r.rest.callsOf("GET").length, 1);
  } finally {
    await r.close();
  }
});

test("bot authorization header is sent to bot routes and not to token routes", async () => {
  const r = await rig();
  try {
    await r.api.request({ method: "GET", path: "/users/@me", signal: ac() });
    await r.api.request({ method: "POST", path: "/interactions/1/tok_abcdefghij/callback", json: { type: 5 }, signal: ac(), tokenRoute: true });
    assert.equal(r.rest.calls[0]!.auth, `Bot ${TOKEN}`);
    assert.equal(r.rest.calls[1]!.auth, undefined);
  } finally {
    await r.close();
  }
});

test("abort stops the request and throws aborted", async () => {
  const r = await rig();
  try {
    const c = new AbortController();
    c.abort();
    await assert.rejects(r.api.request({ method: "GET", path: "/users/@me", signal: c.signal }), (e: unknown) => e instanceof DiscordApiError && e.kind === "aborted");
    assert.equal(r.rest.calls.length, 0);
  } finally {
    await r.close();
  }
});

test("download: only https discord CDN hosts without credentials or ports", async () => {
  const r = await rig({ cdnHosts: ["cdn.discordapp.com"], fetch: (async () => new Response("x")) as typeof fetch });
  try {
    const bad = [
      "http://cdn.discordapp.com/a.png",
      "https://evil.example/a.png",
      "https://user:pw@cdn.discordapp.com/a.png",
      "https://cdn.discordapp.com:8443/a.png",
      "https://cdn.discordapp.com.evil.example/a.png",
      "not a url",
    ];
    for (const u of bad) await assert.rejects(r.api.download(u, 1000, ac()), (e: unknown) => e instanceof DiscordApiError && e.kind === "protocol", u);
  } finally {
    await r.close();
  }
});

test("download: size limits are enforced on declared and streamed length", async () => {
  const r = await rig();
  try {
    r.rest.cdn.set("/attachments/1/2/big.png", { mime: "image/png", data: Buffer.alloc(2000, 1) });
    r.rest.cdn.set("/attachments/1/2/ok.png", { mime: "image/png", data: Buffer.alloc(500, 1) });
    await assert.rejects(r.api.download("https://cdn.discordapp.com/attachments/1/2/big.png", 1000, ac()), (e: unknown) => e instanceof DiscordApiError && e.message.includes("size"));
    const got = await r.api.download("https://cdn.discordapp.com/attachments/1/2/ok.png", 1000, ac());
    assert.equal(got.data.byteLength, 500);
    assert.equal(got.mimeType, "image/png");
  } finally {
    await r.close();
  }
});

test("download: redirects are not followed", async () => {
  let calls = 0;
  const r = await rig({
    fetch: (async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
    }) as typeof fetch,
  });
  try {
    await assert.rejects(r.api.download("https://cdn.discordapp.com/attachments/1/2/x.png", 1000, ac()));
    assert.equal(calls, 1);
  } finally {
    await r.close();
  }
});
