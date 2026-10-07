// Pure logic of the Models page: tolerant parsing, secret masking, scan totals, filters, routes.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { filterModels, groupByProvider, isSecretKey, maskSecrets, modelKey, normalizeList, parseModelRoute, routeFor, scanTotals } from "../src/pages/models/model.ts";

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: "openai", id: "gpt-5", displayName: "GPT-5", kind: "chat", contextWindow: 400000, capabilities: ["tools"], aliases: [],
  status: "available", firstSeen: "2026-10-03T07:12:44.120Z", lastSeen: "2026-10-03T07:12:44.120Z", source: "scan", overrides: {}, ...over,
});

describe("normalizeList", () => {
  test("keeps documented fields and turns unknown or missing values into 'unknown' / absent", () => {
    const r = normalizeList({ models: [entry(), entry({ id: "x", kind: "weird", contextWindow: "big", status: 7, capabilities: ["tools", "teleport"] })], providers: [{ provider: "openai", lastResult: "ok" }], newCount: 1, warnings: [{ code: "empty_list", provider: "openai" }] });
    assert.equal(r.models.length, 2);
    assert.equal(r.models[0]!.kind, "chat");
    assert.equal(r.models[1]!.kind, "unknown");
    assert.equal(r.models[1]!.contextWindow, undefined);
    assert.equal(r.models[1]!.status, "unavailable");
    assert.deepEqual(r.models[1]!.capabilities, ["tools"]);
    assert.equal(r.newCount, 1);
  });
  test("drops entries without provider or id and survives garbage", () => {
    assert.deepEqual(normalizeList(null).models, []);
    assert.equal(normalizeList({ models: [{ id: "a" }, 3, entry()] }).models.length, 1);
  });
  test("extra fields are kept for display but masked when their name ends in key/token/secret/credential", () => {
    const r = normalizeList({ models: [entry({ apiKey: "sk-live-123", note: "hello", authToken: "t", client_secret: "s", credential: "c", keyboard: "kept" })] });
    const extra = r.models[0]!.extra;
    assert.equal(extra.note, "hello");
    assert.equal(extra.keyboard, "kept");
    for (const k of ["apiKey", "authToken", "client_secret", "credential"]) assert.equal(extra[k], "••••", k);
  });
});

describe("maskSecrets", () => {
  test("masks nested values by key suffix and never leaves the value", () => {
    const out = JSON.stringify(maskSecrets({ a: { accessToken: "abc", list: [{ apiKey: "k" }] }, ok: 1 }));
    assert.ok(!out.includes("abc") && !out.includes('"k"'));
    assert.ok(out.includes('"ok":1'));
  });
  test("isSecretKey", () => {
    for (const k of ["key", "apiKey", "API_KEY", "token", "refreshToken", "secret", "clientSecret", "credential", "credentials"]) assert.ok(isSecretKey(k), k);
    for (const k of ["keyboard", "tokens", "displayName", "monkeys"]) assert.equal(isSecretKey(k), false, k);
  });
});

describe("scanTotals", () => {
  const p = (over: Record<string, unknown>): Record<string, unknown> => ({ provider: "a", result: "ok", new: [], reappeared: [], unavailable: [], unchanged: 0, duplicates: 0, warnings: [], nextScanAt: null, ...over });
  test("sums new and unavailable over providers and lists failures and running scans", () => {
    const r = scanTotals({ startedAt: "s", finishedAt: "f", providers: [p({ new: ["m1", "m2"], unavailable: ["o"] }), p({ provider: "b", result: "failed:auth" }), p({ provider: "c", result: "already_running" }), p({ provider: "d", new: ["z"], unavailable: ["q", "r"] })] });
    assert.equal(r.added, 3);
    assert.equal(r.gone, 3);
    assert.deepEqual(r.failed.map((f) => f.provider), ["b"]);
    assert.deepEqual(r.running, ["c"]);
  });
  test("garbage gives zeros", () => { assert.deepEqual(scanTotals(undefined), { added: 0, gone: 0, reappeared: 0, failed: [], running: [], skipped: [] }); });
});

describe("filter, group and routes", () => {
  const models = normalizeList({ models: [entry(), entry({ id: "old", status: "unavailable" }), entry({ provider: "anthropic", id: "claude", status: "available", source: "manual" })] }).models;
  const isNew = new Set([modelKey(models[0]!)]);
  test("filters by provider, status and new", () => {
    assert.equal(filterModels(models, { provider: "anthropic", status: "", newOnly: false }, isNew).length, 1);
    assert.equal(filterModels(models, { provider: "", status: "unavailable", newOnly: false }, isNew).length, 1);
    assert.deepEqual(filterModels(models, { provider: "", status: "", newOnly: true }, isNew).map((m) => m.id), ["gpt-5"]);
  });
  test("groups by provider in first-seen order", () => {
    assert.deepEqual(groupByProvider(models).map((g) => [g.provider, g.models.length]), [["openai", 2], ["anthropic", 1]]);
  });
  test("route round trip with slashes and colons in ids", () => {
    const sub = routeFor("my provider", "meta/llama:3 8b");
    assert.ok(!sub.slice(sub.indexOf("/") + 1).includes("/"));
    assert.deepEqual(parseModelRoute(sub), { provider: "my provider", id: "meta/llama:3 8b" });
    assert.equal(parseModelRoute(undefined), null);
    assert.equal(parseModelRoute("onlyone"), null);
    assert.equal(parseModelRoute("%E0%A4%A/x"), null);
  });
});
