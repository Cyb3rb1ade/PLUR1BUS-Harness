import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { openTurnComposition, type CompositionDeps } from "../../src/composition/index.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { createAgentRegistry } from "../../src/agents.ts";
import { layout } from "../../src/paths.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { useTempDirs } from "./helpers.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createHash } from "node:crypto";
import { MEDIA_OUTPUT_RETENTION_MS } from "../../src/media-output-store.ts";
import { createImportMaintenanceHold } from "../../src/import/maintenance-admission.ts";
import { loadConfigDisclosurePolicy } from "../../src/config-disclosure.ts";

const tmp = useTempDirs("p1b-open-comp-");
const MEDIA_METHODS = ["chat.promote.links", "chat.promote.preview", "chat.promote.commit", "task.complete", "media.generate", "media.edit", "media.job.get", "media.job.list", "media.job.cancel", "media.output.get", "media.output.list", "media.output.delete", "media.adapters.list", "media.preferences.get", "media.preferences.set"];
const SEARCH_METHODS = ["media.search", "media.index.status", "media.index.pause", "media.index.resume", "media.index.reindex", "media.caption.set"];
const EXTENSION_METHODS = ["admin.extensions.setup.get", "admin.extensions.setup.set",
  "admin.extensions.runtime.hold", "admin.extensions.runtime.release",
  "admin.extensions.runtime.status", "admin.extensions.auth.start", "admin.extensions.auth.status",
  "admin.extensions.auth.submit", "admin.extensions.auth.cancel"];
const SSH_METHODS = ["key.status", "key.generate", "key.rotate", "key.delete", "connections.list", "connections.set",
  "connections.delete", "hostKey.probe", "hostKey.trust"].map(method => `admin.import.ssh.${method}`);
const EXTERNAL_TURN_METHODS = ["external.turn.start", "external.turn.events", "external.turn.get", "external.turn.cancel"];

function recordingLogger() {
  const lines: [string, string, Record<string, unknown> | undefined][] = [];
  const mk = (level: string) => (message: string, fields?: Record<string, unknown>) => { lines.push([level, message, fields]); };
  const logger = { debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error"), child: () => logger, async close() { /* nothing */ } };
  return { logger: logger as never, lines };
}

async function open(over: Partial<CompositionDeps> = {}, prepare: (home: string) => void = () => {}, configure: (cfg: ReturnType<typeof defaults>) => void = () => {}) {
  const home = tmp.make(); const cfg = defaults(); cfg.agents.bernd = {}; configure(cfg);
  prepare(home);
  const { logger, lines } = recordingLogger();
  const identity = createIdentityService({ dbPath: join(home, "identity.sqlite"), clock: Date.now, audit: () => {} });
  const agents = createAgentRegistry({ config: () => cfg }, layout(home), logger);
  const deps: CompositionDeps = {
    home, config: () => cfg, engine: {} as never, agents, logger,
    secrets: createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(),
      fileFallback: () => false, audit: createMemoryAuditSink() }),
    egress: { decide: async () => ({ allowed: false }) } as never,
    permissions: { current: () => null, open: async () => { throw new Error("unused"); } } as never, audit: memoryAuditSink(), identity, clock: () => 1_000, signal: new AbortController().signal,
    isStopping: () => false, notify: () => {},
    options: { providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() { /* never called */ } } }] } } },
    ...over,
  };
  try { return { composition: await openTurnComposition(deps), home, lines, identity }; } catch (e) { identity.close(); throw e; }
}

describe("composition openTurnComposition", () => {
  it("runs deferred retention before the actual import hold opens public admission", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const runId = "33333333-3333-4333-8333-333333333333";
    const hold = createImportMaintenanceHold(runId);
    const { composition: c, home, identity } = await open({ maintenance: { held: () => hold.held, onRelease: fn => hold.onRelease(fn) } }, home => {
      const data = Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVE"), Buffer.alloc(32)]);
      const directory = join(home, "media", "outputs", ".uploads", id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      mkdirSync(join(home, "media", "owners"), { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, "0.wav"), data, { mode: 0o600 });
      writeFileSync(join(directory, "manifest.json"), JSON.stringify({ schema: "media.upload/1", id,
        createdAt: Date.now() - MEDIA_OUTPUT_RETENTION_MS - 1, kind: "audio", mimeType: "audio/wav",
        file: { path: "0.wav", format: "wav", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") },
      }), { mode: 0o600 });
      writeFileSync(join(home, "media", "owners", `${id}.json`), JSON.stringify({ agentId: "bernd", userId: "private-person" }), { mode: 0o600 });
    });
    try {
      const owner = join(home, "media", "owners", `${id}.json`);
      assert.equal(existsSync(owner), true);
      await hold.release(runId);
      assert.equal(hold.held, false);
      assert.equal(existsSync(join(home, "media", "outputs", ".uploads", id)), false);
      assert.equal(existsSync(owner), false);
    } finally { await c.close(); identity.close(); }
  });
  it("applies production retention at startup and removes expired upload owners", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const { composition: c, home, identity } = await open({}, home => {
      const data = Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVE"), Buffer.alloc(32)]);
      const directory = join(home, "media", "outputs", ".uploads", id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      mkdirSync(join(home, "media", "owners"), { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, "0.wav"), data, { mode: 0o600 });
      writeFileSync(join(directory, "manifest.json"), JSON.stringify({
        schema: "media.upload/1", id, createdAt: Date.now() - MEDIA_OUTPUT_RETENTION_MS - 1,
        kind: "audio", mimeType: "audio/wav", file: { path: "0.wav", format: "wav", bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex") },
      }), { mode: 0o600 });
      writeFileSync(join(home, "media", "owners", `${id}.json`), JSON.stringify({ agentId: "bernd", userId: "private-person" }), { mode: 0o600 });
    });
    try {
      assert.equal(existsSync(join(home, "media", "outputs", ".uploads", id)), false);
      assert.equal(existsSync(join(home, "media", "owners", `${id}.json`)), false);
    } finally { await c.close(); identity.close(); }
  });
  it("recovers unpublished upload state without a generation provider", async () => {
    const stage = ".stage-11111111-1111-1111-1111-111111111111";
    const { composition: c, home, identity } = await open({}, home => {
      const outputs = join(home, "media", "outputs");
      mkdirSync(join(outputs, ".lock"), { recursive: true });
      mkdirSync(join(outputs, stage));
      writeFileSync(join(outputs, stage, "partial"), "unpublished");
    });
    try {
      assert.equal(existsSync(join(home, "media", "outputs", ".lock")), false);
      assert.equal(existsSync(join(home, "media", "outputs", stage)), false);
    } finally {
      await c.close();
      identity.close();
    }
  });
  it("actual collaboration replay masks live Store and config-policy values while keeping declared public module controls", async () => {
    const stored = randomUUID(), configured = randomUUID(), publicRegion = "public-eu-region", publicPath = "/public/report.txt";
    const secrets = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() });
    let config!: ReturnType<typeof defaults>;
    const text = `${stored} ${configured} ${publicRegion} ${publicPath} 2026.11 user@example.com`;
    const { composition: c, home, identity } = await open({ secrets, options: {
      providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() {} } }] } },
      createTurnProvider: () => ({ id: "fixture", telemetry: {} as never, async *stream() { yield { type: "delta", text }; } }) as never,
    } }, home => {
      mkdirSync(join(home, "modules/fixture"), { recursive: true });
      writeFileSync(join(home, "modules/fixture/module.json"), JSON.stringify({ name: "fixture", version: "0.1.0", apiVersion: "1", entry: "index.js", scope: "installation", priority: 500,
        configSchema: { type: "object", properties: { private: { type: "string", "x-sensitive": true }, region: { type: "string" }, path: { type: "string" }, version: { type: "string" } } } }));
    }, cfg => {
      config = cfg; cfg.agents.worker = {};
      cfg.modules.fixture = { enabled: false, private: configured, region: publicRegion, path: publicPath, version: "2026.11" };
    });
    try {
      await secrets.set({ kind: "owner", id: "fixture" }, "fixture.store", stored);
      secrets.redaction.replaceGroup(Symbol("config-policy"), (await loadConfigDisclosurePolicy(home)).values(config));
      const principal = { userId: "owner", kind: "person" as const, role: "owner" as const };
      assert.ok(c.collab);
      const project = c.collab.createProject(principal, { name: "fixture" });
      for (const agent of ["bernd", "worker"]) c.collab.addAgent(principal, project.id, agent);
      const result = await c.collab.consult({ principal, projectId: project.id, fromAgent: "bernd", toAgent: "worker", question: "Check public controls", context: "" });
      const trace = c.collab.getTrace(principal, result.traceId), span = trace.spans[0]!;
      const seen = JSON.stringify({ trace, replay: c.collab.replay(principal, result.traceId, span.spanId) });
      for (const privateValue of [stored, configured, "user@example.com"]) assert.ok(!seen.includes(privateValue), "private collaboration data escaped the composed redaction source");
      for (const publicValue of [publicRegion, publicPath, "2026.11"]) assert.ok(seen.includes(publicValue), publicValue);
      assert.ok(seen.includes("[REDACTED:secret]") && seen.includes("[REDACTED:pii]"));
    } finally { await c.close(); identity.close(); }
  });

  it("D105: the bounded decision call is required only when modelRoles.decision is configured; without one the rule triage keeps the tool shortlist", async () => {
    for (const role of [undefined, "triage"]) {
      const seen: { requireTriage?: boolean; classifier: boolean }[] = [];
      const providers = { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() { /* unused */ } } }] } };
      const { composition: c, identity } = await open({ options: { providers, createTurnProvider: (o) => { seen.push({ ...(o.requireTriage === undefined ? {} : { requireTriage: o.requireTriage }), classifier: typeof o.classifyMessage === "function" }); return { id: "fixture", telemetry: {} as never, async *stream() { /* unused */ } } as never; } } }, () => {}, (cfg) => { if (role) cfg.modelRoles.decision = role; });
      try {
        const main = seen.find((o) => o.classifier || o.requireTriage !== undefined) ?? seen[0];
        assert.ok(main, "the foreground provider was created");
        assert.equal(main.requireTriage === true, role !== undefined, `requireTriage with decision role ${role ?? "(none)"}`);
        assert.equal(main.classifier, role !== undefined, `classifier with decision role ${role ?? "(none)"}`);
      } finally { await c.close(); identity.close(); }
    }
  });

  it("the turn provider's secret source holds every value of the secret store's redaction registry, not only leased credentials", async () => {
    const secrets = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() });
    const sources: (() => Iterable<string>)[] = [];
    const providers = { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() { /* unused */ } } }] } };
    const { composition: c, identity } = await open({ secrets, options: { providers, createTurnProvider: (o) => { if (o.secrets) sources.push(o.secrets); return { id: "fixture", telemetry: {} as never, async *stream() { /* unused */ } } as never; } } });
    try {
      assert.ok(sources.length > 0, "the foreground provider was created with a secret source");
      const value = `fixture-store-${"v".repeat(12)}`;
      await secrets.set({ kind: "owner", id: "t" }, "web.key", value);
      for (const source of sources) assert.ok([...source()].includes(value), "a value set in the store is redacted from tool results");
    } finally { await c.close(); identity.close(); }
  });

  it("assembles sessions, collaboration, voice, openai and the media RPC surface", async () => {
    const { composition: c, identity } = await open();
    try {
      assert.deepEqual(Object.keys(c).sort(), ["a2a", "budget", "cacheTelemetry", "capabilities", "chatModels", "close", "codeSessions", "collab", "discoveryCredentials", "engineComplete", "importSsh", "ingestChannelAttachments", "mining", "openai", "refusedProviders", "sessions", "skillReview", "surfaceMethods", "voice"]);
      assert.equal(c.skillReview.status().state, "engine-unavailable");
      assert.equal(c.mining.status().state, "engine-unavailable");
      assert.ok(c.collab, "collaboration needs the call budget, which opened");
      assert.equal(typeof c.sessions.close, "function");
      assert.ok(c.codeSessions, "coding session binding must be composed");
      assert.equal(typeof c.codeSessions.connectionClosed, "function", "coding grants must follow connection lifetime");
      assert.deepEqual(Object.keys(c.surfaceMethods).sort(), [...MEDIA_METHODS, ...SEARCH_METHODS, ...EXTENSION_METHODS, ...SSH_METHODS, ...EXTERNAL_TURN_METHODS, "a2a.peer.add", "a2a.peer.list", "a2a.peer.remove", "a2a.peer.trust", "code.session.open", "code.session.diff", "code.session.check", "decision.status", "decision.test", "models.test"].sort());
      for (const m of Object.values(c.surfaceMethods)) assert.equal(typeof m, "function");
    } finally { await c.close(); identity.close(); }
  });

  it("privacy.localOnly: the models.test probe of a cloud model is refused (E_DENIED local-only) and never builds a probe provider; switched off it probes", async () => {
    const { guardMethods, LOCAL_OWNER } = await import("../../src/rbac/guard.ts");
    for (const localOnly of [true, false]) {
      let probes = 0; let streamed = 0;
      const providers = { profiles: { default: [{ provider: "cloudvendor", model: "big", adapter: { async *stream() { /* unused */ } } }] } };
      const createTurnProvider = (o: { profile?: string }) => ({ id: "fixture", telemetry: {} as never, async *stream() { if (o.profile === "probe") { streamed++; yield { type: "delta", text: "OK" }; } } }) as never;
      const wrapped = (o: { profile?: string }) => { if (o.profile === "probe") probes++; return createTurnProvider(o); };
      const { composition: c, identity } = await open({ options: { providers, createTurnProvider: wrapped as never } }, () => {}, (cfg) => { cfg.privacy.localOnly = localOnly; });
      try {
        const methods = guardMethods({ "models.test": c.surfaceMethods["models.test"]! }, { now: Date.now, resolve: () => LOCAL_OWNER });
        const call = () => methods["models.test"]!({ model: "cloudvendor/big" }, { signal: new AbortController().signal } as never);
        if (localOnly) {
          await assert.rejects(call, (e: unknown) => (e as { error?: string; reason?: string }).error === "E_DENIED" && (e as { reason?: string }).reason === "local-only");
          assert.equal(probes, 0); assert.equal(streamed, 0);
        } else {
          assert.equal(((await call()) as { ok: boolean }).ok, true);
          assert.equal(streamed, 1);
        }
      } finally { await c.close(); identity.close(); }
    }
  });

  it("composeVoice: the voice runtime exposes the v2/v3 entry points and is handed to the onVoice hook exactly once", async () => {
    const seen: unknown[] = [];
    const { composition: c, identity } = await open({ options: { providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() { /* unused */ } } }] } }, onVoice: (v) => seen.push(v) } });
    try {
      assert.equal(seen.length, 1);
      assert.equal(seen[0], c.voice);
      for (const key of ["v3", "openTalk", "metrics", "renderMetrics", "close", "setDelegate"] as const) assert.ok(key in c.voice, key);
      assert.equal(typeof c.voice.openTalk, "function");
      assert.equal(typeof c.voice.v3.methods, "object");
    } finally { await c.close(); identity.close(); }
  });

  it("creates its stores under <home>/state", async () => {
    const { composition: c, home, identity } = await open();
    try {
      for (const f of ["budget.sqlite", "sessions.sqlite", "collab.sqlite"]) assert.ok(existsSync(join(home, "state", f)), f);
    } finally { await c.close(); identity.close(); }
  });

  it("close() releases the stores, and a second close() is a no-op", async () => {
    const { composition: c, home, identity } = await open();
    try {
      assert.ok(existsSync(join(home, "state", "budget.sqlite-wal")), "budget store open");
      await c.close();
      assert.equal(existsSync(join(home, "state", "budget.sqlite-wal")), false, "budget store closed");
      await assert.doesNotReject(() => c.close());
    } finally { identity.close(); }
  });

  it("discoveryCredentials has nothing for a provider that is not part of the composition", async () => {
    const { composition: c, identity } = await open();
    try {
      const unknown = { wireFormat: "chat_completions", entries: [], profile: { id: "ghost", display_name: "g", kind: "api_key", capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}", secret_ref: "g.key", policy_status: "allowed", policy_source: "s", policy_checked: "2026-10-08" } };
      assert.equal(c.discoveryCredentials(unknown as never), undefined);
    } finally { await c.close(); identity.close(); }
  });

  it("one provider without a billing class is refused and reported; the good one stays composed (no all-or-nothing)", async () => {
    const def = (id: string, over: Record<string, unknown> = {}) => ({ wireFormat: "chat_completions", defaultModel: "m", entries: [], ...over,
      profile: { id, display_name: id, kind: "api_key", capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}", base_url: "https://fixture.invalid/v1", secret_ref: `${id}.key`, policy_status: "allowed", policy_source: "s", policy_checked: "2026-10-08" } });
    const { composition: c, identity, lines } = await open({ options: { definitions: { good: def("good"), bad: def("bad", { billingPath: "enterprise" }) } as never } });
    try {
      assert.deepEqual(c.refusedProviders.map(r => [r.provider, r.code]), [["bad", "E_CONFIG_INVALID"]]);
      const logged = lines.find(l => l[0] === "error" && /refused/.test(l[1]));
      assert.ok(logged, "the refusal is logged");
      assert.equal(logged![2]?.provider, "bad");
      assert.equal(logged![2]?.code, "E_CONFIG_INVALID");
      assert.equal(lines.some(l => /turn providers unavailable/.test(l[1])), false, "the composition root no longer disables every provider");
    } finally { await c.close(); identity.close(); }
  });

  it("exposes an engine completion over the composed router with budget and privacy admission", async () => {
    let calls = 0;
    const adapter = { async *stream() { calls++; yield { type: "done", result: { text: "ok", toolCalls: [], finishReason: "stop", usage: { inputTokens: 2, outputTokens: 1 }, meta: {} } } as const; } };
    const { composition: c, identity } = await open({ options: { providers: { profiles: { default: [{ provider: "cloud", model: "m", adapter: adapter as never }] } } } });
    try {
      const params = { messages: [{ role: "user" as const, content: "hello" }] };
      assert.equal((await c.engineComplete("bernd", params)).text, "ok");
      assert.equal(calls, 1);
      c.budget!.setLimit({ scope: "agent", id: "bernd", period: "day", metric: "tokens", hard: 0 });
      await assert.rejects(() => c.engineComplete("bernd", params), { error: "E_NOT_AVAILABLE", reason: "budget-exceeded" });
      assert.equal(calls, 1);
    } finally { await c.close(); identity.close(); }
    const denied = await open({ options: { providers: { profiles: { default: [{ provider: "cloud", model: "m", adapter: adapter as never }] } } } }, () => {}, cfg => { cfg.privacy.localOnly = true; });
    try {
      await assert.rejects(() => denied.composition.engineComplete("bernd", { messages: [] }), { error: "E_DENIED", reason: "local-only" });
      assert.equal(calls, 1);
    } finally { await denied.composition.close(); denied.identity.close(); }
  });

  it("without any provider the composition still opens (turns then answer no-provider)", async () => {
    const { composition: c, identity } = await open({ options: {} });
    try { assert.ok(c.sessions); } finally { await c.close(); identity.close(); }
  });

  it("an unusable budget store disables the budget and everything that needs it, but not the rest", async () => {
    const { composition: c, lines, identity } = await open({}, (home) => { mkdirSync(join(home, "state", "budget.sqlite"), { recursive: true }); });
    try {
      assert.equal(c.collab, null, "collaboration needs the budget");
      assert.ok(lines.some(([level, msg]) => level === "error" && msg === "turn budget unavailable"), "the failure is logged, not thrown");
      assert.ok(c.sessions);
    } finally { await c.close(); identity.close(); }
  });

  it("an unusable session store is a hard failure of the composition (the Core then runs without sessions)", async () => {
    await assert.rejects(() => open({}, (home) => { mkdirSync(join(home, "state", "sessions.sqlite"), { recursive: true }); }));
  });

  it("a provider factory that throws closes what was already opened, and the error surfaces", async () => {
    const home = tmp.make();
    let walWhileOpen = false;
    await assert.rejects(() => open({ home, options: { providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() { /* unused */ } } }] } }, createTurnProvider: () => { walWhileOpen = existsSync(join(home, "state", "budget.sqlite-wal")); throw new Error("synthetic provider failure"); } } }), /synthetic provider failure/);
    assert.equal(walWhileOpen, true);
    assert.equal(existsSync(join(home, "state", "budget.sqlite-wal")), false);
  });
});
