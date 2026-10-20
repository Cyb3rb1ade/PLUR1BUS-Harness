// privacy.localOnly (owner decision 2026-10-18) at every model-provider selection point that does not run in the engine:
// chat/role routing (incl. compaction summaries, which use the same turn provider), discovery, media generation, the
// media index and the doctor report. No network: scripted adapters, fake egress, in-memory catalogs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "@plur1bus/config-schema";
import { TurnToolError } from "../../src/composition/provider.ts";
import { createSessionRoleProvider } from "../../src/session/role-routing.ts";
import { createTurnProvider } from "../../src/composition/provider.ts";
import { composeMedia, type MediaDefinition } from "../../src/composition/media.ts";
import { turnContext } from "../../src/composition/context.ts";
import { createDiscoveryService } from "../../src/discovery/service.ts";
import { FakeClock, InMemoryProfileSource, RecordingEvents, StaticCredentialResolver } from "../../src/discovery/testing.ts";
import { loadMetadataTable } from "../../src/discovery/metadata.ts";
import { localOnlyCheck, localOnlyFindings } from "../../src/privacy/doctor.ts";
import { buildDoctorMethods } from "../../src/doctor-report.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { collect, fakeEgress, fakeSecretService, scriptedAdapter, turnFixture, turnRequest, useTempDirs } from "../composition/helpers.ts";

const tmp = useTempDirs("p1b-local-only-");

describe("privacy.localOnly: chat and role models", () => {
  const twoProviders = () => {
    const cloud = scriptedAdapter([{ text: "from the cloud" }]), local = scriptedAdapter([{ text: "from the local model" }]);
    return { cloud, local, profiles: { default: [{ provider: "openai", model: "gpt-x", adapter: cloud.adapter }, { provider: "ollama", model: "llama", adapter: local.adapter }], localfirst: [{ provider: "ollama", model: "llama", adapter: local.adapter }, { provider: "openai", model: "gpt-x", adapter: cloud.adapter }] } };
  };
  const isLocalProvider = (p: string) => p === "ollama";

  it("refuses a turn whose chosen model is a cloud model with local-only, before anything is sent, never falling back silently", async () => {
    const { cloud, local, profiles } = twoProviders();
    const f = turnFixture(cloud.adapter, { profiles, localOnly: (agent) => agent === "a1", isLocalProvider }, tmp.make());
    try {
      await assert.rejects(collect(f.provider, turnRequest()), (e) => e instanceof TurnToolError && e.code === "local-only" && /privacy\.localOnly/.test(JSON.stringify(e.detail)));
      assert.equal(cloud.requests.length, 0); assert.equal(local.requests.length, 0);
      // Another agent without the switch keeps its cloud model.
      const chunks = await collect(f.provider, turnRequest({ agentId: "a2" }));
      assert.ok(chunks.some(c => c.type === "delta" && c.text.includes("cloud")));
    } finally { f.close(); }
  });

  it("a local model answers under local-only, and a cloud fallback is never tried", async () => {
    const failing = scriptedAdapter([{ text: "x" }]);
    const broken = { async *stream() { const { ProviderError } = await import("../../../providers/src/index.ts"); throw new ProviderError("overloaded", "busy"); } };
    const { cloud, profiles } = twoProviders();
    const f = turnFixture(failing.adapter, { profiles: { default: [{ provider: "ollama", model: "llama", adapter: broken as never }, profiles.default[0]!] }, localOnly: () => true, isLocalProvider, router: { retry: { maxAttempts: 1 } } as never }, tmp.make());
    try {
      await assert.rejects(collect(f.provider, turnRequest()));
      assert.equal(cloud.requests.length, 0, "the cloud candidate was refused by admission");
    } finally { f.close(); }
    const ok = twoProviders();
    const g = turnFixture(ok.local.adapter, { profiles: { default: ok.profiles.localfirst }, localOnly: () => true, isLocalProvider }, tmp.make());
    try {
      const chunks = await collect(g.provider, turnRequest());
      assert.ok(chunks.some(c => c.type === "delta" && c.text.includes("local")));
      assert.equal(ok.cloud.requests.length, 0);
    } finally { g.close(); }
  });

  it("the summarize role (compaction summaries) is held to the same rule", async () => {
    const { cloud, profiles } = twoProviders();
    const f = turnFixture(cloud.adapter, {}, tmp.make());
    try {
      const options = { registry: undefined as never, budget: f.budget, profiles, approval: { request: async () => ({ approved: false }) }, grants: { get: () => undefined, list: () => [] }, log: () => {}, resultStore: { put: async () => "x" }, localOnly: () => true, isLocalProvider } as never;
      const provider = createSessionRoleProvider(createTurnProvider, options, { summarize: "openai/gpt-x" }, 256);
      await assert.rejects(collect(provider, turnRequest({ role: "summarize" })), (e) => e instanceof TurnToolError && e.code === "local-only");
      assert.equal(cloud.requests.length, 0);
    } finally { f.close(); }
  });
});

describe("privacy.localOnly: discovery lists cloud models as locked instead of hiding them", () => {
  const model = (provider: string, id: string) => ({ provider, id, displayName: id, kind: "chat", capabilities: [], aliases: [], status: "available", firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-01T00:00:00Z", source: "scan", overrides: {} });
  const service = (locked: (provider: string, baseUrl: string | undefined) => boolean) => createDiscoveryService({
    store: { read: () => ({ schema: "plur1bus.model-catalog/1", revision: 1, tableRevision: "x", providers: {}, models: [model("openai", "gpt-x"), model("ollama", "llama")] }) } as never,
    profiles: new InMemoryProfileSource([{ id: "openai", discovery: "openai", baseUrl: "https://api.openai.com/v1" }, { id: "ollama", discovery: "ollama", baseUrl: "http://127.0.0.1:11434" }] as never),
    credentials: new StaticCredentialResolver({}), events: new RecordingEvents(), clock: new FakeClock(0), rng: () => 0.5, table: loadMetadataTable(),
    roles: () => ({}), settings: () => ({ enabled: false, intervalHours: 24 }), logger: { debug() {}, info() {}, warn() {} },
    modelLocked: (provider, profile) => locked(provider, profile?.baseUrl),
  });
  it("marks exactly the cloud models locked: local-only and keeps every model in the list", () => {
    const list = service((_p, base) => !(base ?? "").startsWith("http://127.0.0.1")).list({});
    assert.equal(list.models.length, 2);
    assert.equal(list.models.find(m => m.provider === "openai")!.locked, "local-only");
    assert.equal("locked" in list.models.find(m => m.provider === "ollama")!, false);
    const off = service(() => false).list({});
    assert.ok(off.models.every(m => !("locked" in m)));
  });
});

describe("privacy.localOnly: media generation", () => {
  const openai = { id: "openai", model: "image-model-1" } as MediaDefinition;
  const privacy = (on: (agent?: string) => boolean, listed: string[] = []) => ({ localOnly: on, localEndpoints: () => listed });
  it("refuses a cloud media adapter before egress, secrets or I/O, per agent inside a turn", async () => {
    const egress = fakeEgress(); const secrets = fakeSecretService({ k: "v" });
    const media = await composeMedia(tmp.make(), [{ ...openai, secretRef: "k" } as MediaDefinition], secrets.service, egress.egress, undefined, privacy(agent => agent === "bernd"));
    assert.equal(media!.local(), false);
    await assert.rejects(turnContext.run(turnRequest({ agentId: "bernd" }), () => media!.adapter.generate({ prompt: "a cat" })), (e: any) => e.error === "E_DENIED" && e.reason === "local-only");
    assert.deepEqual(egress.asked, []); assert.deepEqual(secrets.leases, []);
  });
  it("a loopback adapter stays usable; a LAN one only when listed", async () => {
    const home = tmp.make();
    assert.equal((await composeMedia(home, [{ id: "draw-things", model: "m" } as MediaDefinition], fakeSecretService().service, fakeEgress().egress, undefined, privacy(() => true)))!.local(), true);
    const lan = { id: "draw-things", model: "m", baseUrl: "http://192.168.1.30:7860", allowLan: true } as MediaDefinition;
    assert.equal((await composeMedia(home, [lan], fakeSecretService().service, fakeEgress().egress, undefined, privacy(() => true)))!.local(), false);
    assert.equal((await composeMedia(home, [lan], fakeSecretService().service, fakeEgress().egress, undefined, privacy(() => true, ["http://192.168.1.30:7860"])))!.local(), true);
  });
});

describe("privacy.localOnly: doctor report", () => {
  const cloudy = () => {
    const cfg = defaults() as any;
    cfg.providers = { openai: { wireFormat: "chat_completions", profile: { id: "openai", kind: "api_key" } }, ollama: { wireFormat: "chat_completions", profile: { id: "ollama", kind: "api_key", base_url: "http://127.0.0.1:11434/v1" } }, media: { adapters: [{ id: "openai", model: "m" }, { id: "coreml-local", model: "m" }] } };
    cfg.voice.providers.elevenlabs = { ...cfg.voice.providers.elevenlabs, enabled: true, apiKeyRef: "el" };
    cfg.engine.embedding = { provider: "openai", model: "m", dimensions: 8, apiKeyEnv: "K" };
    cfg.engine.merging = { baseUrl: "https://llm.example.com/v1", model: "m" };
    return cfg;
  };
  it("lists every configured cloud model provider while the switch is on", () => {
    const findings = localOnlyFindings(cloudy());
    assert.deepEqual(findings.sort(), ["chat provider openai", "engine embedding", "engine merging", "media adapter openai", "voice provider elevenlabs"]);
  });
  it("fails with the findings when local-only is on, passes when off or clean", async () => {
    const cfg = cloudy();
    assert.equal(localOnlyCheck(cfg).status, "ok");
    cfg.privacy = { localOnly: true, localEndpoints: [] };
    const check = localOnlyCheck(cfg);
    assert.equal(check.status, "fail"); assert.match(check.summary, /chat provider openai/); assert.ok(check.repair);
    const clean = defaults() as any; clean.agents = { bernd: { privacy: { localOnly: true } } };
    assert.deepEqual([localOnlyCheck(clean).status, /at least one agent/.test(localOnlyCheck(clean).summary)], ["ok", true]);
    const methods = guardMethods(buildDoctorMethods({ home: "/fixture", clock: () => 1000, check: async () => ({ schema: "1staid.check/1", checks: [] }), scheduleInitial: () => {}, coreChecks: () => [check] }), { resolve: () => ({ kind: "person", role: "owner", userId: "person-alice" }), now: () => 1000 });
    const report = await methods["doctor.report"]!({ refresh: true }, { requestId: "r", connectionId: "c", signal: new AbortController().signal }) as any;
    const row = report.groups[0].checks.find((c: any) => c.id === "privacy.local-only");
    assert.equal(row.status, "fail"); assert.equal(row.repair.kind, "hint");
  });
});

describe("privacy.localOnly: media index and captioning (shared, pinned while any agent is local-only)", () => {
  const compose = async (provider: string, pinned: boolean) => {
    const { composeMediaSearch } = await import("../../src/composition/media-search.ts");
    const home = tmp.make();
    const cfg = defaults(); cfg.memory.mediaEmbedding = { ...cfg.memory.mediaEmbedding, enabled: true, provider } as typeof cfg.memory.mediaEmbedding;
    let built = 0;
    const noop = async () => { throw new Error("unused"); };
    const engine = { media: { index: noop, search: noop, remove: noop, setCaption: noop, status: noop, backfill: { start: noop, pause: noop, resume: noop, cancel: noop }, attachHost: () => { built++; } } };
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    // This composition fixture represents the future media-capable Engine with a bound
    // trusted HostFetch; absent-Fetch refusal has its own real-host regression.
    const c = await composeMediaSearch({ home, config: () => cfg, engine, hostFetchReady: true, agents: { workspaceOf: () => home }, logger, store: null, budget: null, privacyPinned: () => pinned } as never);
    return { c, built: () => built };
  };
  it("a cloud media embedding provider is not started; the index is disabled with the reason, never switched to another model", async () => {
    const { c, built } = await compose("openai", true);
    try {
      assert.equal(c.kind, "disabled"); assert.equal(built(), 0);
      await assert.rejects(c.port.search({ text: "x", limit: 1, scope: { agentId: "a1", workspace: "w" } as never }), (e: any) => e.error === "E_MEDIA_UNAVAILABLE" && /privacy\.localOnly/.test(e.message));
    } finally { await c.close(); }
  });
  it("a local media provider keeps working under the pin", async () => {
    const local = await compose("local", true);
    try { assert.equal(local.c.kind, "engine"); } finally { await local.c.close(); }
  });
});
