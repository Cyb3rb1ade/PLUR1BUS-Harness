// Audit c16: names that come from config or from a provider are used as table keys. A plain `obj[name]` lookup finds
// inherited members ("constructor", "__proto__", "toString"), so such a name must behave like any other unknown name.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAnthropicStreamError } from "../src/anthropic/errors.ts";
import { classifyGeminiStreamError } from "../src/gemini/errors.ts";
import { resolveModelProfiles } from "../src/profiles/index.ts";
import type { ModelProfilesConfig, ProviderRegistry } from "../src/profiles/index.ts";
import { ProviderRouter, RouterError } from "../src/router/index.ts";
import type { StreamingAdapter } from "../src/router/index.ts";
import type { ChatRequest } from "../src/types.ts";

const T = { timeout: 15_000 };
const NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"];
const REQ: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };
const ok: StreamingAdapter = {
  async *stream() { yield { type: "text_delta", text: "x" }; },
};

test("router: a profile name that is an Object.prototype member is an unknown profile, not a TypeError", T, async () => {
  const router = new ProviderRouter({ profiles: { p: [{ provider: "a", model: "m", adapter: ok }] } });
  for (const name of NAMES) {
    assert.equal(router.hasProfile(name), false, `hasProfile(${name})`);
    await assert.rejects(async () => { for await (const _ of router.stream(name, REQ)) { /* drain */ } },
      (e: unknown) => e instanceof RouterError && e.code === "unknown_profile", name);
  }
});

test("router: inherited members of the unsupported/defaults tables do not mark a real profile unusable", T, async () => {
  const router = new ProviderRouter({ profiles: { constructor: [{ provider: "a", model: "m", adapter: ok }] } });
  // a profile that is genuinely called "constructor" must work like any other
  const seen: string[] = [];
  for await (const ev of router.stream("constructor", REQ)) seen.push(ev.type);
  assert.deepEqual(seen, ["served", "text_delta"]);
  // ...and the empty unsupported table must not claim that other prototype-named profiles are "unsupported"
  const other = new ProviderRouter({ profiles: { p: [{ provider: "a", model: "m", adapter: ok }] }, unsupportedProfiles: {}, profileDefaults: {} });
  await assert.rejects(async () => { for await (const _ of other.stream("toString", REQ)) { /* drain */ } },
    (e: unknown) => e instanceof RouterError && e.code === "unknown_profile");
});

test("profiles: a config key '__proto__' becomes an ordinary profile, in every resolved table", T, async () => {
  const registry: ProviderRegistry = new Map([["a", { adapter: ok }]]);
  const config = JSON.parse('{"__proto__":{"candidates":[{"model":"a/m"}],"params":{"temperature":0.3}},"fast":{"candidates":[{"model":"a/m"}]}}') as ModelProfilesConfig;
  const r = resolveModelProfiles(config, registry);
  assert.equal(Object.hasOwn(r.profiles, "__proto__"), true);
  assert.equal(Object.hasOwn(r.table, "__proto__"), true);
  assert.equal(Object.hasOwn(r.defaults, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(r.profiles), Object.prototype, "the table's prototype is untouched");
  assert.equal(Object.getPrototypeOf(r.table), Object.prototype);
  assert.deepEqual(Object.keys(r.profiles).sort(), ["__proto__", "fast"]);
  const router = new ProviderRouter({ profiles: r.table, profileDefaults: r.defaults, unsupportedProfiles: r.unsupported });
  const seen: string[] = [];
  for await (const ev of router.stream("__proto__", REQ)) seen.push(ev.type);
  assert.deepEqual(seen, ["served", "text_delta"]);
});

test("anthropic: an in-stream error whose type is a prototype member is classified by the shared rules, not by the prototype", T, () => {
  for (const type of NAMES) {
    const e = classifyAnthropicStreamError({ type: "error", error: { type, message: "boom" } }, (s) => s);
    assert.equal(typeof e.kind, "string", `${type}: kind is a taxonomy string`);
    assert.equal(e.kind, "unknown", type);
    assert.equal(e.retryable, false, type);
  }
});

test("gemini: an in-stream error whose gRPC status is a prototype member falls back to the numeric code", T, () => {
  for (const status of NAMES) {
    const e = classifyGeminiStreamError({ error: { code: 429, status, message: "slow down" } }, (s) => s);
    assert.equal(e.kind, "rate_limit", status);
  }
});
