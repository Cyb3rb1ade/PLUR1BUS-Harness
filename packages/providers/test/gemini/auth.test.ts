import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError, createGeminiAdapter, secretStoreKey } from "../../src/index.ts";
import { startStub } from "../helpers/stub.ts";
import { KEY, MemStore, T, adapterFor, basic, candidate, json } from "./helpers.ts";

const ok = (_q: unknown, res: import("node:http").ServerResponse) => json(res, candidate([{ text: "ok" }], "STOP"));
const neverFetch = (async () => { throw new Error("fetch must not be called"); }) as unknown as typeof fetch;

test("the key comes from the secret store on every call, goes only in x-goog-api-key, never in URL or body", T, async () => {
  const stub = await startStub(ok);
  try {
    const { adapter, store } = adapterFor(stub);
    await adapter.complete(basic);
    store.put("gemini:test", "AIzaSyROTATED-synthetic-1111111111111");
    await adapter.complete(basic);
    assert.equal(store.gets, 2, "read per call, not cached");
    assert.deepEqual(stub.requests.map((r) => r.headers["x-goog-api-key"]), [KEY, "AIzaSyROTATED-synthetic-1111111111111"]);
    for (const r of stub.requests) {
      assert.equal(r.headers["authorization"], undefined);
      assert.equal(r.url?.includes("key="), false);
      assert.equal(r.url?.includes("AIza"), false);
      assert.equal(r.body.includes("AIza"), false);
    }
  } finally { await stub.close(); }
});

test("no key stored, empty key, key with whitespace or control characters: auth error and no request is sent", T, async () => {
  const stub = await startStub(ok);
  try {
    for (const key of [null, "", "has space", "line\nbreak", "tab\there"]) {
      const { adapter } = adapterFor(stub, {}, key);
      await assert.rejects(adapter.complete(basic), (e: unknown) => e instanceof ProviderError && e.kind === "auth" && e.retryable === false);
      await assert.rejects((async () => { for await (const _ of adapter.stream(basic)) void _; })(), (e: unknown) => e instanceof ProviderError && e.kind === "auth");
    }
    assert.equal(stub.requests.length, 0);
  } finally { await stub.close(); }
});

test("a failing secret store is an auth error whose cause is the store's own error", T, async () => {
  const stub = await startStub(ok);
  try {
    const failing = { get: async () => { throw new Error("keyring locked"); } };
    const adapter = createGeminiAdapter({ baseUrl: stub.baseUrl, credentials: secretStoreKey(failing, "gemini:test") });
    await assert.rejects(adapter.complete(basic), (e: unknown) => e instanceof ProviderError && e.kind === "auth" && (e.cause as Error).message === "keyring locked");
    assert.equal(stub.requests.length, 0);
  } finally { await stub.close(); }
});

test("plain http to a non-loopback host is refused before any I/O; the key store is the only door", T, async () => {
  const store = new MemStore();
  store.put("k", KEY);
  const adapter = createGeminiAdapter({ baseUrl: "http://gemini.example.invalid/v1beta", credentials: secretStoreKey(store, "k"), fetch: neverFetch });
  await assert.rejects(adapter.complete(basic), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request" && /plain http/.test(e.message));
  const allowed = createGeminiAdapter({ baseUrl: "http://gemini.example.invalid/v1beta", credentials: secretStoreKey(store, "k"), allowInsecureHttp: true, fetch: (async () => new Response(JSON.stringify(candidate([{ text: "x" }], "STOP")), { headers: { "content-type": "application/json" } })) as typeof fetch });
  assert.equal((await allowed.complete(basic)).text, "x");
});

test("configuration that could put the key somewhere else is refused at construction", () => {
  const credentials = { apiKey: () => KEY };
  for (const baseUrl of ["https://u:p@generativelanguage.googleapis.com/v1beta", "https://generativelanguage.googleapis.com/v1beta?key=abc", "https://generativelanguage.googleapis.com/v1beta#x", "ftp://example.invalid", "not a url"]) {
    assert.throws(() => createGeminiAdapter({ baseUrl, credentials }), TypeError, baseUrl);
  }
  for (const h of ["x-goog-api-key", "X-Goog-Api-Key", "authorization", "content-type", "host"]) {
    assert.throws(() => createGeminiAdapter({ credentials, headers: { [h]: "v" } }), TypeError, h);
  }
  assert.throws(() => createGeminiAdapter({ credentials, headers: { "x-extra": "a\r\nx-goog-api-key: b" } }), TypeError);
  assert.doesNotThrow(() => createGeminiAdapter({ credentials }));
});

test("model names that could change the URL path are refused before any I/O", T, async () => {
  const store = new MemStore();
  store.put("k", KEY);
  const adapter = createGeminiAdapter({ credentials: secretStoreKey(store, "k"), fetch: neverFetch });
  for (const model of ["../../v1/files", "gemini/../x", "gemini?key=1", "gemini#x", "gemini x", "models/", "a:b", "gemini\n"]) {
    await assert.rejects(adapter.complete({ ...basic, model }), (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request", model);
  }
});

test("`models/` prefix and the default base URL: the request goes to .../v1beta/models/{id}:generateContent", T, async () => {
  const seen: string[] = [];
  const adapter = createGeminiAdapter({
    credentials: { apiKey: () => KEY },
    fetch: (async (u: URL | string) => { seen.push(String(u)); return new Response(JSON.stringify(candidate([{ text: "x" }], "STOP")), { headers: { "content-type": "application/json" } }); }) as typeof fetch,
  });
  await adapter.complete({ ...basic, model: "models/gemini-2.5-pro" });
  await adapter.complete(basic);
  assert.deepEqual(seen, [
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    `https://generativelanguage.googleapis.com/v1beta/models/${basic.model}:generateContent`,
  ]);
});
