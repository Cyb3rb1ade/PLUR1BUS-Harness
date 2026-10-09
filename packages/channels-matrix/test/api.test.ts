import assert from "node:assert/strict";
import { test } from "node:test";
import { MatrixApi, MatrixApiError, clampRetryAfter, multipartPart, parseMxc, validateHomeserverUrl } from "../src/index.ts";

test("homeserverUrl: https, or http only on loopback; no credentials, query or fragment", () => {
  const ok = ["https://matrix.example.org", "https://matrix.example.org/", "http://127.0.0.1:8008", "http://localhost:8008", "http://[::1]:8008"];
  for (const u of ok) assert.doesNotThrow(() => validateHomeserverUrl(u), u);
  const bad = ["http://matrix.example.org", "ftp://matrix.example.org", "https://user:pw@matrix.example.org", "https://matrix.example.org/?a=1", "https://matrix.example.org/#x", "not a url", "http://127.0.0.2:8008"];
  for (const u of bad) assert.throws(() => validateHomeserverUrl(u), RangeError, u);
  assert.equal(validateHomeserverUrl("https://matrix.example.org/base/"), "https://matrix.example.org/base");
});

test("mxc URIs: only well-formed server and media id pass", () => {
  assert.deepEqual(parseMxc("mxc://hs.test/AbC_-1"), { server: "hs.test", mediaId: "AbC_-1" });
  assert.deepEqual(parseMxc("mxc://hs.test:8448/x"), { server: "hs.test:8448", mediaId: "x" });
  for (const bad of ["https://hs.test/x", "mxc://hs.test/../x", "mxc://hs.test/a/b", "mxc:///x", "mxc://hs.test/", 5, undefined]) assert.equal(parseMxc(bad), undefined, String(bad));
});

test("retry-after is clamped to [1 s, 5 min]", () => {
  const cases: [number | undefined, number][] = [[undefined, 1000], [0, 1000], [-5, 1000], [NaN, 1000], [1500, 1500], [999_999_999, 300_000]];
  for (const [input, want] of cases) assert.equal(clampRetryAfter(input), want, String(input));
});

test("multipart/mixed: the second part is the media with its own content type", () => {
  const body = Buffer.from("--B\r\nContent-Type: application/json\r\n\r\n{}\r\n--B\r\nContent-Type: image/png\r\n\r\nPNGDATA\r\n--B--\r\n");
  const p = multipartPart(body, "B", 1);
  assert.equal(p?.contentType, "image/png");
  assert.equal(Buffer.from(p!.body).toString(), "PNGDATA");
  assert.equal(multipartPart(body, "B", 2), undefined);
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("errors: 401 is unauthorized, 403 forbidden, 404 not-found, 400 bad-request, 5xx http; body text is never carried", async () => {
  const cases: [number, string][] = [[401, "unauthorized"], [403, "forbidden"], [404, "not-found"], [400, "bad-request"], [502, "http"]];
  for (const [status, kind] of cases) {
    const api = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_secret_token_value_x", fetch: fakeFetch(() => json(status, { errcode: "M_X", error: "syt_secret_token_value_x leaked" })) });
    await assert.rejects(api.whoami(new AbortController().signal), (e: MatrixApiError) => {
      assert.equal(e.kind, kind);
      assert.ok(!e.message.includes("syt_"));
      assert.equal(e.errcode, "M_X");
      return true;
    });
  }
});

test("429 with retry_after_ms is clamped; M_LIMIT_EXCEEDED without a hint uses the 1 s default", async () => {
  const a = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_tokentokentoken", fetch: fakeFetch(() => json(429, { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 0 })) });
  await assert.rejects(a.whoami(new AbortController().signal), (e: MatrixApiError) => e.kind === "rate-limited" && e.retryAfterMs === 1000);
  const b = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_tokentokentoken", fetch: fakeFetch(() => json(429, { errcode: "M_LIMIT_EXCEEDED" }, { "retry-after": "7" })) });
  await assert.rejects(b.whoami(new AbortController().signal), (e: MatrixApiError) => e.retryAfterMs === 7000);
});

test("the token travels only in the Authorization header, and redirects are refused", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const api = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_tokentokentoken", fetch: fakeFetch((url, init) => {
    seen = { url, init };
    return json(200, { user_id: "@bot:hs.example.org" });
  }) });
  await api.whoami(new AbortController().signal);
  assert.ok(!seen!.url.includes("syt_"));
  assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer syt_tokentokentoken");
  assert.equal(seen!.init.redirect, "error");
});

test("room ids are percent-encoded in paths", async () => {
  let url = "";
  const api = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_tokentokentoken", fetch: fakeFetch((u) => { url = u; return json(200, {}); }) });
  await api.joinRoom("!abc:hs.example.org", new AbortController().signal);
  assert.ok(url.endsWith("/rooms/!abc%3Ahs.example.org/join"), url);
});

test("a response over the size bound is refused while streaming", async () => {
  const big = new Response(new Uint8Array(5 * 1024 * 1024), { status: 200, headers: { "content-type": "application/json" } });
  const api = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_tokentokentoken", fetch: fakeFetch(() => big) });
  await assert.rejects(api.whoami(new AbortController().signal), (e: MatrixApiError) => e.kind === "too-large");
});

test("media download: v1 multipart is used; a v1 404 falls back to v3; an unsafe reference never reaches the network", async () => {
  const seen: string[] = [];
  const api = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_tokentokentoken", fetch: fakeFetch((u) => {
    seen.push(u);
    if (u.includes("/client/v1/")) return json(404, { errcode: "M_UNRECOGNIZED" });
    return new Response(Buffer.from("RAW"), { status: 200, headers: { "content-type": "image/gif" } });
  }) });
  const r = await api.downloadMedia("mxc://hs.example.org/abc", 100, new AbortController().signal);
  assert.equal(Buffer.from(r.data).toString(), "RAW");
  assert.equal(r.mimeType, "image/gif");
  assert.equal(seen.length, 2);
  await assert.rejects(api.downloadMedia("https://evil.example/x", 100, new AbortController().signal), /unsafe media reference/);
  assert.equal(seen.length, 2);
});

test("media download refuses a declared length above the bound before reading", async () => {
  const api = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_tokentokentoken", fetch: fakeFetch(() => new Response(Buffer.alloc(10), { status: 200, headers: { "content-type": "image/png", "content-length": "9000000" } })) });
  await assert.rejects(api.downloadMedia("mxc://hs.example.org/abc", 100, new AbortController().signal), (e: MatrixApiError) => e.kind === "too-large");
});

test("a v1 redirect part is refused rather than followed", async () => {
  const body = '--B\r\nContent-Type: application/json\r\n\r\n{"location":"https://elsewhere"}\r\n--B\r\nContent-Type: image/png\r\n\r\nX\r\n--B--\r\n';
  const api = new MatrixApi({ homeserverUrl: "https://hs.example.org", accessToken: "syt_tokentokentoken", fetch: fakeFetch(() => new Response(body, { status: 200, headers: { "content-type": "multipart/mixed; boundary=B" } })) });
  await assert.rejects(api.downloadMedia("mxc://hs.example.org/abc", 10000, new AbortController().signal), /redirect refused/);
});
