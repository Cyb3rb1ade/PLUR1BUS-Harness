import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults, type HarnessConfig } from "@plur1bus/config-schema";
import { composeAuth, type ProviderDefinition } from "../../src/composition/auth.ts";
import { ProviderError } from "../../../providers/src/index.ts";
import { wireFixture, type Wire } from "../integration/wire-fixture.ts";
import { fakeEgress, fakeSecretService, recordingLog } from "./helpers.ts";

type Def = ProviderDefinition;
function definition(wire: Def["wireFormat"], over: { id?: string; secretRef?: string; model?: string; scheme?: string; billingPath?: string; kind?: string } = {}): Def {
  const id = over.id ?? "fixture";
  return {
    wireFormat: wire, defaultModel: over.model ?? "model-a", entries: [],
    ...(over.billingPath ? { billingPath: over.billingPath } : {}),
    profile: { id, display_name: "Fixture", kind: over.kind ?? "api_key", capabilities: ["chat"], auth_header_scheme: over.scheme ?? (wire === "anthropic_messages" || wire === "gemini" ? "x-api-key: {token}" : "Authorization: Bearer {token}"), base_url: "https://fixture.invalid/v1", secret_ref: over.secretRef ?? "fixture.key", policy_status: "allowed", policy_source: "synthetic", policy_checked: "2026-10-08" },
  } as Def;
}
const config = (mutate: (c: HarnessConfig) => void = () => {}) => { const c = defaults(); mutate(c); return c; };
const compose = (definitions: Record<string, Def>, extra: Partial<Parameters<typeof composeAuth>[0]> = {}) =>
  composeAuth({ config: config(), definitions, secrets: fakeSecretService({ "fixture.key": "redact-probe-alpha" }).service, egress: fakeEgress().egress, ...extra });
const userMessage = { model: "model-a", messages: [{ role: "user" as const, content: "hello" }] };
async function drain(it: AsyncIterable<unknown>) { const out: unknown[] = []; for await (const e of it) out.push(e); return out; }

describe("composition/auth composeAuth: what it derives from the definitions", () => {
  it("maps each wire format to its tool-call dialect family", () => {
    const c = compose({ a: definition("chat_completions", { id: "pa" }), b: definition("anthropic_messages", { id: "pb" }), c: definition("codex_responses", { id: "pc" }), d: definition("gemini", { id: "pd" }) });
    try { assert.deepEqual(c.families, { a: "openai-chat", b: "anthropic", c: "openai-responses", d: "gemini" }); } finally { c.close(); }
  });

  it("records a billing class only for definitions that have one (plan vs paid, ADR-005)", () => {
    const c = compose({
      key: definition("chat_completions", { id: "p1" }),
      cli: definition("chat_completions", { id: "p2", kind: "external_cli" }),
      explicit: definition("chat_completions", { id: "p3", billingPath: "plan" }),
      unknown: definition("chat_completions", { id: "p4", billingPath: "enterprise" }),
    });
    try { assert.deepEqual(c.billing, { key: "paid", cli: "plan", explicit: "plan" }); } finally { c.close(); }
  });

  it("without modelProfiles a default profile is made from the providers that name a default model, in definition order", () => {
    const c = compose({ second: definition("chat_completions", { id: "p2", model: "m2" }), first: definition("anthropic_messages", { id: "p1", model: "m1" }) });
    try {
      assert.deepEqual(Object.keys(c.profiles), ["default"]);
      assert.deepEqual(c.profiles.default!.map((x) => [x.provider, x.model]), [["second", "m2"], ["first", "m1"]]);
      assert.equal(c.resolved.defaultProfile, "default");
    } finally { c.close(); }
  });

  it("a configured profile resolves provider/model candidates against the registered providers", () => {
    const cfg = config((x) => { x.modelProfiles = { smart: { strategy: "fallback", candidates: [{ model: "second/m-x", weight: 1 }, { model: "first/m-y", weight: 1 }], params: {}, cache: { hint: "auto" } } }; });
    const c = composeAuth({ config: cfg, definitions: { first: definition("chat_completions", { id: "p1" }), second: definition("chat_completions", { id: "p2" }) }, secrets: fakeSecretService().service, egress: fakeEgress().egress });
    try { assert.deepEqual(c.profiles.smart!.map((x) => [x.provider, x.model]), [["second", "m-x"], ["first", "m-y"]]); } finally { c.close(); }
  });

  it("a profile naming a provider that is not registered fails composition instead of being dropped", () => {
    const cfg = config((x) => { x.modelProfiles = { smart: { strategy: "fallback", candidates: [{ model: "ghost/m", weight: 1 }], params: {}, cache: { hint: "auto" } } }; });
    assert.throws(() => composeAuth({ config: cfg, definitions: { first: definition("chat_completions") }, secrets: fakeSecretService().service, egress: fakeEgress().egress }));
  });

  it("no definitions: no profiles, no families, no billing", () => {
    const c = compose({});
    try { assert.deepEqual([c.profiles, c.families, c.billing], [{}, {}, {}]); } finally { c.close(); }
  });

  it("credentialsForDiscovery hands out the shared owner only for the exact registered definition", () => {
    const def = definition("chat_completions");
    const c = compose({ p: def });
    try {
      const shared = c.credentialsForDiscovery(def);
      assert.ok(shared);
      assert.equal(c.credentialsForDiscovery(structuredClone(def)), shared);
      assert.equal(c.credentialsForDiscovery(definition("chat_completions", { id: "unknown" })), undefined, "an unregistered profile id gets nothing");
      assert.equal(c.credentialsForDiscovery(definition("chat_completions", { secretRef: "other.key" })), undefined, "a different secret reference is a different profile");
      const strategy = { ...structuredClone(def), strategy: "round_robin" } as Def;
      assert.equal(c.credentialsForDiscovery(strategy), undefined, "a changed pool strategy needs a new composition");
    } finally { c.close(); }
  });

  it("close() can be called more than once", () => {
    const c = compose({ p: definition("chat_completions") });
    c.close(); assert.doesNotThrow(() => c.close());
  });
});

describe("composition/auth composeAuth: the provider adapters it builds", () => {
  const wires: [Wire, string, (h: Headers) => string | null][] = [
    ["chat_completions", "Bearer redact-probe-alpha", (h) => h.get("authorization")],
    ["anthropic_messages", "redact-probe-alpha", (h) => h.get("x-api-key")],
    ["codex_responses", "Bearer redact-probe-alpha", (h) => h.get("authorization")],
    ["gemini", "redact-probe-alpha", (h) => h.get("x-api-key") ?? h.get("x-goog-api-key")],
  ];
  for (const [wire, expected, read] of wires) {
    it(`${wire}: the credential is leased per attempt and sent in the auth header only`, async () => {
      const w = wireFixture(wire, [{ text: "hi" }]);
      const headers: Headers[] = [];
      const fetch = (async (url: unknown, init?: RequestInit) => { headers.push(new Headers(init?.headers)); return w.fetch(url as never, init); }) as typeof globalThis.fetch;
      const secrets = fakeSecretService({ "fixture.key": "redact-probe-alpha" });
      const c = composeAuth({ config: config(), definitions: { fixture: definition(wire) }, secrets: secrets.service, egress: fakeEgress().egress, fetch });
      try {
        await drain(c.profiles.default![0]!.adapter.stream(userMessage));
        assert.equal(w.calls, 1);
        assert.equal(read(headers[0]!), expected);
        assert.equal(JSON.stringify(w.bodies[0]).includes("redact-probe-alpha"), false, "the key never travels in the body");
        assert.ok(secrets.leases.length >= 1);
        assert.equal(secrets.leases.every((l) => (l.principal as { kind: string }).kind === "core"), true);
        assert.equal(secrets.leases.length, secrets.revoked.length, "every lease is revoked again");
      } finally { c.close(); }
    });
  }

  it("a missing credential becomes an auth ProviderError and no request is made", async () => {
    const w = wireFixture("chat_completions", [{ text: "hi" }]);
    const c = composeAuth({ config: config(), definitions: { fixture: definition("chat_completions") }, secrets: fakeSecretService({}).service, egress: fakeEgress().egress, fetch: w.fetch });
    try {
      await assert.rejects(() => drain(c.profiles.default![0]!.adapter.stream(userMessage)), (e) => e instanceof ProviderError && e.kind === "auth");
      assert.equal(w.calls, 0);
    } finally { c.close(); }
  });

  it("the auth stage is logged around the credential lookup", async () => {
    const w = wireFixture("chat_completions", [{ text: "hi" }]); const { records, log } = recordingLog();
    const c = composeAuth({ config: config(), definitions: { fixture: definition("chat_completions") }, secrets: fakeSecretService({ "fixture.key": "redact-probe-alpha" }).service, egress: fakeEgress().egress, fetch: w.fetch, log });
    try {
      await drain(c.profiles.default![0]!.adapter.stream(userMessage));
      assert.deepEqual(records.filter((r) => r.stage === "auth").map((r) => r.phase), ["start", "end"]);
      assert.equal(JSON.stringify(records).includes("redact-probe-alpha"), false, "the pipeline log never contains the credential");
    } finally { c.close(); }
  });

  it("an already aborted signal stops before any credential is read", async () => {
    const w = wireFixture("chat_completions", [{ text: "hi" }]); const secrets = fakeSecretService({ "fixture.key": "redact-probe-alpha" });
    const c = composeAuth({ config: config(), definitions: { fixture: definition("chat_completions") }, secrets: secrets.service, egress: fakeEgress().egress, fetch: w.fetch });
    try {
      const ac = new AbortController(); const reason = new Error("cancelled"); ac.abort(reason);
      await assert.rejects(() => drain(c.profiles.default![0]!.adapter.stream(userMessage, { signal: ac.signal })), (e) => e === reason);
      assert.deepEqual(secrets.leases, []); assert.equal(w.calls, 0);
    } finally { c.close(); }
  });

  it("an HTTP 401 from the provider surfaces as an auth error", async () => {
    const w = wireFixture("chat_completions", [{ status: 401 }]);
    const c = composeAuth({ config: config(), definitions: { fixture: definition("chat_completions") }, secrets: fakeSecretService({ "fixture.key": "redact-probe-alpha" }).service, egress: fakeEgress().egress, fetch: w.fetch });
    try {
      await assert.rejects(() => drain(c.profiles.default![0]!.adapter.stream(userMessage)), (e) => e instanceof ProviderError && e.kind === "auth" && e.status === 401);
    } finally { c.close(); }
  });
});
