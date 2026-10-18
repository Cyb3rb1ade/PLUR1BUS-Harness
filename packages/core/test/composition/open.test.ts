import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { openTurnComposition, type CompositionDeps } from "../../src/composition/index.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { createAgentRegistry } from "../../src/agents.ts";
import { layout } from "../../src/paths.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("p1b-open-comp-");
const MEDIA_METHODS = ["task.complete", "media.generate", "media.edit", "media.job.get", "media.job.list", "media.job.cancel", "media.output.get", "media.output.list", "media.output.delete", "media.adapters.list", "media.preferences.get", "media.preferences.set"];
const SEARCH_METHODS = ["media.search", "media.index.status", "media.index.pause", "media.index.resume", "media.index.reindex", "media.caption.set"];

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
    home, config: () => cfg, engine: {} as never, agents, logger, secrets: {} as never, egress: { decide: async () => ({ allowed: false }) } as never,
    permissions: { current: () => null, open: async () => { throw new Error("unused"); } } as never, audit: memoryAuditSink(), identity, clock: () => 1_000, signal: new AbortController().signal,
    isStopping: () => false, notify: () => {},
    options: { providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() { /* never called */ } } }] } } },
    ...over,
  };
  try { return { composition: await openTurnComposition(deps), home, lines, identity }; } catch (e) { identity.close(); throw e; }
}

describe("composition openTurnComposition", () => {
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

  it("assembles sessions, collaboration, voice, openai and the media RPC surface", async () => {
    const { composition: c, identity } = await open();
    try {
      assert.deepEqual(Object.keys(c).sort(), ["capabilities", "close", "collab", "discoveryCredentials", "openai", "refusedProviders", "sessions", "surfaceMethods", "voice"]);
      assert.ok(c.collab, "collaboration needs the call budget, which opened");
      assert.equal(typeof c.sessions.close, "function");
      assert.deepEqual(Object.keys(c.surfaceMethods).sort(), [...MEDIA_METHODS, ...SEARCH_METHODS, "models.test"].sort());
      for (const m of Object.values(c.surfaceMethods)) assert.equal(typeof m, "function");
    } finally { await c.close(); identity.close(); }
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
