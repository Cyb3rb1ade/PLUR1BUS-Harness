import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatRequest, ChatStreamEvent } from "../../src/types.ts";
import { RouterError } from "../../src/router/router.ts";
import type { StreamingAdapter } from "../../src/router/types.ts";
import {
  ProfileConfigError, createRouterFromProfiles, profileNameOrDefault, resolveModelProfiles,
  type ModelProfilesConfig, type ProviderRegistry, type ProviderRegistryEntry,
} from "../../src/profiles/index.ts";
import { FakeClock, REQ, cand, collector, down, drain, result } from "../router/helpers.ts";

const T = { timeout: 15_000 };
const noop: StreamingAdapter = { async *stream() { throw new Error("must not be called"); } };
const reg = (entries: Record<string, Partial<ProviderRegistryEntry>>): ProviderRegistry =>
  new Map(Object.entries(entries).map(([k, v]) => [k, { adapter: noop, ...v }]));

function issuesOf(config: ModelProfilesConfig, registry: ProviderRegistry) {
  try { resolveModelProfiles(config, registry); } catch (e) {
    assert.ok(e instanceof ProfileConfigError);
    return e;
  }
  assert.fail("expected ProfileConfigError");
}

test("unknown provider: path-bearing error listing known providers sorted", T, () => {
  const e = issuesOf({ fast: { candidates: [{ model: "a/m" }, { model: "zzz/m" }] } }, reg({ b: {}, a: {} }));
  assert.equal(e.issues.length, 1);
  assert.equal(e.issues[0]!.path, "modelProfiles.fast.candidates[1].model");
  assert.equal(e.issues[0]!.code, "unknown_provider");
  assert.match(e.issues[0]!.message, /known: a, b/);
  assert.match(e.message, /^modelProfiles\.fast\.candidates\[1\]\.model: /);
});

test("unknown model only when the registry lists models", T, () => {
  const e = issuesOf({ p: { candidates: [{ model: "a/nope" }] } }, reg({ a: { models: ["m1", "m2"] } }));
  assert.equal(e.issues[0]!.code, "unknown_model");
  assert.match(e.issues[0]!.message, /m1, m2/);
  const ok = resolveModelProfiles({ p: { candidates: [{ model: "a/anything" }] } }, reg({ a: {} }));
  assert.equal(ok.table.p![0]!.model, "anything");
});

test("malformed refs", T, () => {
  for (const ref of ["openai", "/x", "x/"]) {
    const e = issuesOf({ p: { candidates: [{ model: ref }] } }, reg({ openai: {}, x: {} }));
    assert.equal(e.issues[0]!.code, "malformed_model_ref", ref);
    assert.equal(e.issues[0]!.path, "modelProfiles.p.candidates[0].model");
  }
});

test("several issues are collected into one error", T, () => {
  const e = issuesOf({
    a: { candidates: [{ model: "bad" }, { model: "q/m" }] },
    b: { candidates: [] },
    c: { strategy: "moa", candidates: [{ model: "a/m" }], aggregator: "nope/x" },
  }, reg({ a: {} }));
  assert.deepEqual(e.issues.map((i) => i.code), ["malformed_model_ref", "unknown_provider", "empty_candidates", "unknown_provider", "moa_needs_two_candidates"]);
  assert.equal(e.issues[3]!.path, "modelProfiles.c.aggregator");
  assert.match(e.message, /\(\+4 more\)$/);
});

test("model ids containing '/' split at the first slash", T, () => {
  const r = resolveModelProfiles({ p: { candidates: [{ model: "openrouter/anthropic/claude-x", weight: 3 }] } }, reg({ openrouter: {} }));
  assert.deepEqual(r.profiles.p!.candidates, [{ provider: "openrouter", model: "anthropic/claude-x", weight: 3 }]);
});

test("duplicate candidate, invalid strategy, aggregator without moa", T, () => {
  const e = issuesOf({
    d: { candidates: [{ model: "a/m" }, { model: "a/m" }] },
    s: { strategy: "weird" as "moa", candidates: [{ model: "a/m" }] },
    g: { candidates: [{ model: "a/m" }], aggregator: "a/m" },
  }, reg({ a: {} }));
  assert.deepEqual(e.issues.map((i) => [i.code, i.path]), [
    ["duplicate_candidate", "modelProfiles.d.candidates[1].model"],
    ["invalid_strategy", "modelProfiles.s.strategy"],
    ["aggregator_without_moa", "modelProfiles.g.aggregator"],
  ]);
});

test("default profile is synthesised in registry order; absent without defaultModel", T, () => {
  const r = resolveModelProfiles(undefined, reg({ x: { defaultModel: "mx" }, y: {}, z: { defaultModel: "mz" } }));
  assert.equal(r.defaultProfile, "default");
  assert.deepEqual(r.table.default!.map((c) => `${c.provider}/${c.model}`), ["x/mx", "z/mz"]);
  const none = resolveModelProfiles({}, reg({ x: {} }));
  assert.equal(none.defaultProfile, undefined);
  assert.deepEqual(none.table, {});
});

test("an explicit 'default' profile wins", T, () => {
  const r = resolveModelProfiles({ default: { candidates: [{ model: "y/my" }] } }, reg({ x: { defaultModel: "mx" }, y: {} }));
  assert.deepEqual(r.table.default!.map((c) => c.provider), ["y"]);
});

test("moa: unsupported + warning; router throws unsupported_strategy without calling an adapter", T, async () => {
  const { router, resolved } = createRouterFromProfiles(
    { panel: { strategy: "moa", candidates: [{ model: "a/m" }, { model: "a/n" }], aggregator: "a/m", displayName: "Panel", cache: { hint: "prefer", ttlSeconds: 60 } } },
    reg({ a: {} }),
  );
  assert.equal(resolved.warnings.length, 1);
  assert.equal(resolved.warnings[0]!.code, "moa_not_executable");
  assert.match(resolved.unsupported.panel!, /moa/);
  assert.deepEqual(resolved.profiles.panel!.aggregator, { provider: "a", model: "m" });
  assert.equal(resolved.profiles.panel!.displayName, "Panel");
  assert.deepEqual(resolved.profiles.panel!.cache, { hint: "prefer", ttlSeconds: 60 });
  assert.ok(router.hasProfile("panel"));
  await assert.rejects(router.complete("panel", REQ), (e: unknown) => e instanceof RouterError && e.code === "unsupported_strategy");
});

test("params reach the adapter; a request's own value wins", T, async () => {
  const seen: ChatRequest[] = [];
  const adapter: StreamingAdapter = {
    async *stream(request): AsyncGenerator<ChatStreamEvent, void, void> {
      seen.push(request);
      yield { type: "done", result: result("ok") };
    },
  };
  const { router } = createRouterFromProfiles(
    { p: { candidates: [{ model: "a/m" }], params: { temperature: 0.2, topP: 0.9, maxTokens: 100 } } },
    new Map([["a", { adapter }]]),
  );
  await router.complete("p", REQ);
  await router.complete("p", { ...REQ, temperature: 0.7 });
  assert.deepEqual([seen[0]!.temperature, seen[0]!.topP, seen[0]!.maxTokens, seen[0]!.model], [0.2, 0.9, 100, "m"]);
  assert.deepEqual([seen[1]!.temperature, seen[1]!.topP, seen[1]!.maxTokens], [0.7, 0.9, 100]);
});

test("end to end: A fails with down(), B answers, fallback event; breakers keyed per provider+model", T, async () => {
  const a = cand("A", "m1", [{ err: down() }]);
  const b = cand("B", "m2", [{ text: "from b" }]);
  const { events, sink } = collector();
  const { router } = createRouterFromProfiles(
    { fast: { candidates: [{ model: "A/m1" }, { model: "B/m2" }] } },
    new Map([["A", { adapter: a.adapter }], ["B", { adapter: b.adapter }]]),
    { clock: new FakeClock(), random: () => 0.5, onEvent: sink, breaker: { failureThreshold: 1, openMs: 1000 } },
  );
  const out = await router.complete("fast", REQ);
  assert.equal(out.result.text, "from b");
  assert.deepEqual(out.served, { provider: "B", model: "m2" });
  assert.equal(a.adapter.calls, 1);
  assert.deepEqual(a.adapter.models, ["m1"]);
  const fb = events.find((e) => e.type === "provider.fallback");
  assert.deepEqual(fb && fb.type === "provider.fallback" && [fb.profile, fb.from, fb.to], ["fast", { provider: "A", model: "m1" }, { provider: "B", model: "m2" }]);
  assert.equal(router.breakerState("A", "m1"), "open");
  assert.equal(router.breakerState("A", "m2"), "closed");
  assert.equal(router.breakerState("B", "m2"), "closed");
  assert.equal((await drain(router.stream("fast", REQ))).at(-1)?.type, "done");
  assert.equal(a.adapter.calls, 1, "open breaker skips A");
});

test("profileNameOrDefault", T, () => {
  const r = resolveModelProfiles({ default: { candidates: [{ model: "a/m" }] } }, reg({ a: {} }));
  assert.equal(profileNameOrDefault(r, "x"), "x");
  assert.equal(profileNameOrDefault(r), "default");
  const none = resolveModelProfiles(undefined, reg({}));
  assert.throws(() => profileNameOrDefault(none), (e: unknown) => e instanceof RouterError && e.code === "unknown_profile");
});
