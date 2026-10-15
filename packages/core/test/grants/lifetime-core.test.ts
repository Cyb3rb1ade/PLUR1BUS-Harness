import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { openTurnComposition, type CompositionDeps } from "../../src/composition/index.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { createAgentRegistry } from "../../src/agents.ts";
import { layout } from "../../src/paths.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { createPermissionRuntime } from "../../src/approvals/runtime.ts";
import { staticKeySource } from "../../src/approvals/keys.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { createCollab } from "../../src/collab/service.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { useTempDirs } from "../composition/helpers.ts";
import { owner, projectWithAgents } from "../collab/helpers.ts";
import { alwaysCap, call, ctx, FakeClock, KEY, HOUR } from "./helpers.ts";
import { abs } from "../helpers/abs.ts";
import { open as openStores } from "./helpers.ts";
import { decide } from "../../src/policy/index.ts";
import type { GrantSource } from "../../src/policy/index.ts";

const T = { timeout: 20_000 };
const tmp = useTempDirs("p1b-grant-life-");
const OUT = { outsideRoots: true, denyListHit: false } as const;
const outRead = () => call({ targets: [abs("/data/x")], flags: OUT });
const pathMatch = { kind: "path" as const, path: abs("/data"), access: "read" as const, recursive: true };

describe("D109 §9.9 core ends task and session grants (not the 24h bound)", () => {
  it("a session-scoped grant ends on session archive via composition onSessionEnd", T, async () => {
    const clock = new FakeClock();
    const home = tmp.make();
    mkdirSync(join(home, "state"), { recursive: true });
    const cfg = defaults(); cfg.agents.bernd = {};
    const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; }, async close() {} } as never;
    const identity = createIdentityService({ dbPath: join(home, "identity.sqlite"), clock: () => clock.now(), audit: () => {} });
    const agents = createAgentRegistry({ config: () => cfg }, layout(home), logger);
    const permissions = createPermissionRuntime({
      dbPath: join(home, "state", "approvals.sqlite"), keys: staticKeySource(KEY), clock,
      audit: createPolicyAudit({ sink: memoryAuditSink(), clock, host: "h" }),
    });
    const opened = await permissions.open();
    const deps: CompositionDeps = {
      home, config: () => cfg, engine: {} as never, agents, logger, secrets: {} as never,
      egress: { decide: async () => ({ allowed: false }) } as never,
      permissions, audit: memoryAuditSink(), identity, clock: () => clock.now(),
      signal: new AbortController().signal, isStopping: () => false, notify: () => {},
      options: { providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() { /* unused */ } } }] } } },
    };
    const composition = await openTurnComposition(deps);
    try {
      const session = composition.sessions.store.createSession({ kind: "direct", agentId: "bernd", owner: "christian" });
      opened.grants.create(alwaysCap({
        scope: "session", sessionId: session.id, match: pathMatch, id: "s-grant",
      }));
      const x = ctx({ sessionId: session.id });
      assert.deepEqual(evalGrant(opened.grants, clock, x), { kind: "allow", via: "grant", grantId: "s-grant" });
      composition.sessions.store.archiveSession(session.id);
      clock.advance(HOUR); // well under the 7-day session idle bound
      assert.equal(evalGrant(opened.grants, clock, x).kind, "ask");
      assert.equal(opened.grants.get("s-grant")!.revoked, true);
      assert.equal((opened.grants.get("s-grant") as { endReason?: string }).endReason, "session-ended");
    } finally {
      await composition.close();
      await permissions.close();
      identity.close();
    }
  });

  it("archiving a session ends its grant even when the permission runtime was not yet open", T, async () => {
    const clock = new FakeClock();
    const home = tmp.make();
    mkdirSync(join(home, "state"), { recursive: true });
    const cfg = defaults(); cfg.agents.bernd = {};
    const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; }, async close() {} } as never;
    const identity = createIdentityService({ dbPath: join(home, "identity.sqlite"), clock: () => clock.now(), audit: () => {} });
    const agents = createAgentRegistry({ config: () => cfg }, layout(home), logger);
    const dbPath = join(home, "state", "approvals.sqlite");
    const audit = createPolicyAudit({ sink: memoryAuditSink(), clock, host: "h" });
    const seed = createPermissionRuntime({ dbPath, keys: staticKeySource(KEY), clock, audit });
    const openedSeed = await seed.open();
    const compositionA = await openTurnComposition({
      home, config: () => cfg, engine: {} as never, agents, logger, secrets: {} as never,
      egress: { decide: async () => ({ allowed: false }) } as never,
      permissions: seed, audit: memoryAuditSink(), identity, clock: () => clock.now(),
      signal: new AbortController().signal, isStopping: () => false, notify: () => {},
      options: { providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() { /* unused */ } } }] } } },
    });
    const session = compositionA.sessions.store.createSession({ kind: "direct", agentId: "bernd", owner: "christian" });
    openedSeed.grants.create(alwaysCap({ scope: "session", sessionId: session.id, match: pathMatch, id: "s-grant-late" }));
    await compositionA.close();
    await seed.close();

    const permissions = createPermissionRuntime({ dbPath, keys: staticKeySource(KEY), clock, audit });
    const composition = await openTurnComposition({
      home, config: () => cfg, engine: {} as never, agents, logger, secrets: {} as never,
      egress: { decide: async () => ({ allowed: false }) } as never,
      permissions, audit: memoryAuditSink(), identity, clock: () => clock.now(),
      signal: new AbortController().signal, isStopping: () => false, notify: () => {},
      options: { providers: { profiles: { default: [{ provider: "fixture", model: "gpt-4.1", adapter: { async *stream() { /* unused */ } } }] } } },
    });
    try {
      assert.equal(permissions.current(), null);
      composition.sessions.store.archiveSession(session.id);
      const opened = await permissions.open();
      clock.advance(HOUR);
      assert.equal(evalGrant(opened.grants, clock, ctx({ sessionId: session.id })).kind, "ask");
      assert.equal(opened.grants.get("s-grant-late")!.revoked, true);
      assert.equal((opened.grants.get("s-grant-late") as { endReason?: string }).endReason, "session-ended");
    } finally {
      await composition.close();
      await permissions.close();
      identity.close();
    }
  });

  it("a task-scoped grant ends when the collab task ends, not after 24h", T, async () => {
    const stores = await openStores();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const provider = new FakeChatProvider({ gate: async () => { await gate; } });
    const collab = createCollab({
      path: ":memory:", clock: () => stores.clock.now(), provider,
      grants: stores.grants,
    });
    try {
      const p = await projectWithAgents({ collab, events: [], clock: stores.clock as never, provider, seen: [] }, ["lead", "worker"]);
      const handle = collab.delegate({
        principal: owner(), projectId: p.id, fromAgent: "lead", toAgent: "worker",
        task: "do the thing", acceptanceCriteria: "done",
      });
      stores.grants.create(alwaysCap({
        scope: "task", taskId: handle.task.id, match: pathMatch, id: "t-grant",
      }));
      const x = ctx({ taskId: handle.task.id });
      assert.deepEqual(evalGrant(stores.grants, stores.clock, x), { kind: "allow", via: "grant", grantId: "t-grant" });
      release();
      const done = await handle.done;
      assert.equal(done.status, "succeeded");
      stores.clock.advance(HOUR); // well under the 24h task bound
      assert.equal(evalGrant(stores.grants, stores.clock, x).kind, "ask");
      assert.equal(stores.grants.get("t-grant")!.revoked, true);
      assert.equal((stores.grants.get("t-grant") as { endReason?: string }).endReason, "task-ended");
    } finally {
      collab.close();
      stores.close?.();
    }
  });
});

function evalGrant(grants: GrantSource, clock: FakeClock, x: ReturnType<typeof ctx>) {
  return decide(outRead(), x, { grants, clock });
}
