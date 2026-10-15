import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolDispatcher, type DispatchContext } from "../../../src/tools/dispatcher.ts";
import { ToolRegistry, type ToolDef } from "../../../src/tools/registry.ts";
import { createExecTool, EXEC_RUN_SCHEMA } from "../../../src/tools/exec/tool.ts";
import { buildEnv, DEFAULT_ENV_ALLOW, envFingerprint } from "../../../src/tools/exec/env.ts";
import { canonicalisePath } from "../../../src/policy/paths.ts";
import { createPolicyAudit } from "../../../src/policy/audit.ts";
import type { Grant } from "../../../src/policy/index.ts";
import { rig as baseRig, tick, type Rig } from "../../approvals/service-helpers.ts";
import { FakePort, FakeTimers, tmpRoot } from "./helpers.ts";

const T = { timeout: 20_000 };
const BASE_ENV = { PATH: "/usr/bin" };

async function classifyExec(args: unknown, root: string, baseEnv: Record<string, string> = BASE_ENV): Promise<{ targets: string[]; hashExtra: string; access: "write"; flags: { outsideRoots: false; denyListHit: false } }> {
  const raw = args && typeof args === "object" && !Array.isArray(args) ? args as { cwd?: unknown; env?: unknown } : undefined;
  if (typeof raw?.cwd !== "string") throw new Error("cwd must be a string");
  const resolved = await canonicalisePath(raw.cwd, { roots: [{ id: "r", path: root }], access: "read", requireRoot: true, platform: process.platform });
  if (!resolved.ok) throw new Error(`cwd refused: ${resolved.reason}`);
  const env = buildEnv({
    allow: DEFAULT_ENV_ALLOW, base: baseEnv,
    requested: raw.env === undefined ? undefined : raw.env as Record<string, string>,
    windows: process.platform === "win32",
  });
  return { flags: { outsideRoots: false, denyListHit: false }, targets: [resolved.canonical], hashExtra: envFingerprint(env), access: "write" };
}

async function setup(root: string, port: FakePort, o: { grants?: { list(q: { person: string; agent: string; capability: string }): readonly Grant[]; get(id: string): Grant | undefined }; rig?: Rig } = {}) {
  const r = o.rig ?? await baseRig();
  const registry = new ToolRegistry();
  const execTimers = new FakeTimers();
  const tool: ToolDef = {
    name: "exec.run",
    description: "Run an enabled, allowlisted program inside a granted root without a shell.",
    inputSchema: EXEC_RUN_SCHEMA,
    capability: "shell.exec",
    effect: "local-write",
    risk: "medium",
    trust: "first-party",
    classify: (args) => classifyExec(args, root),
    execute: async (args, ctx) => {
      const spec = createExecTool({
        config: { mode: "ask", roots: [{ id: "r", path: root }], allowlist: [{ program: "git" }] },
        process: port, timers: execTimers, audit: r.audit,
        policy: { grants: r.stores.grants, clock: r.clock },
        policyContext: {
          principal: { person: ctx.principal }, subject: { kind: "agent", agentId: ctx.agentId },
          surface: ctx.surface ?? 0, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          overrides: { "shell.exec": "allowed" },
        },
        consumeOnce: (id, b) => r.stores.grants.consumeOnce(id, b),
        baseEnv: BASE_ENV, platform: process.platform,
      });
      const out = await spec.execute(args, ctx);
      if (out.isError) throw new Error(out.message);
      return out.value;
    },
  };
  registry.register(tool);
  const d = new ToolDispatcher({
    registry, approvals: r.service, grants: o.grants ?? r.stores.grants, grantUse: r.stores.grants,
    clock: r.clock, timers: r.timers,
    audit: createPolicyAudit({ sink: r.audit, clock: r.clock, host: "h" }),
    policyContext: r.service.policyContext(),
  });
  const ctx = (c: Partial<DispatchContext> = {}): DispatchContext => ({
    agentId: "bernd", principal: "christian", sessionId: "s1", taskId: "t1", surface: 3,
    signal: new AbortController().signal, ...c,
  });
  let n = 0;
  const call = (args: unknown, c: Partial<DispatchContext> = {}) => d.call({ id: `c${++n}`, name: "exec.run", args }, ctx(c));
  return { r, d, call, ctx, port };
}

describe("exec.run once-grant replay (D109 §9.3)", () => {
  it("a once grant allows exactly one call: consumeOnce at execution start; a stale list cannot reuse it", T, async () => {
    const { root, sub } = tmpRoot();
    const args = { program: "git", cwd: sub, args: ["status"] };

    const hashOf = async () => {
      const probe = await setup(root, new FakePort());
      let settled: Awaited<ReturnType<typeof probe.call>> | undefined;
      const p = probe.call(args).then((res) => { settled = res; return res; });
      while (probe.r.service.list().length === 0 && settled === undefined) await tick();
      const listed = probe.r.service.list()[0];
      if (!listed) throw new Error(`probe did not ask; result=${JSON.stringify(settled)}`);
      const h = listed.actionHash;
      probe.r.service.dispose();
      await p;
      return h;
    };
    const actionHash = await hashOf();

    const port = new FakePort();
    port.onSpawn = (p) => p.exit(0);
    const s = await setup(root, port);
    const g = s.r.stores.grants.create({
      capability: "shell.exec", person: "christian", agent: "bernd", scope: "once",
      match: { kind: "action" }, actionHash, createdBy: "christian", surface: 3,
    });
    const snapshot = s.r.stores.grants.get(g.id)!;
    const stale = { list: () => [snapshot] as readonly Grant[], get: (id: string) => s.r.stores.grants.get(id) };
    const s2 = await setup(root, port, { rig: s.r, grants: stale });

    const first = await s2.call(args);
    assert.equal(first.isError, false);
    assert.equal(first.meta.decision, "allow");
    assert.equal(s.r.stores.grants.get(g.id)!.consumedAt !== undefined, true);

    const second = await s2.call(args);
    assert.equal(second.isError && second.error.code, "tool-not-approved");
    assert.match(second.isError ? second.error.message : "", /already used|one-time|consum/i);
    assert.equal(port.spawned.length, 1);
  });

  it("a task grant for exec.run matches the cwd path only (env is hashExtra, not a target)", T, async () => {
    const { root, sub } = tmpRoot();
    const args = { program: "git", cwd: sub, args: ["status"] };
    const port = new FakePort();
    port.onSpawn = (p) => p.exit(0);
    const s = await setup(root, port);
    const resolved = await canonicalisePath(sub, { roots: [{ id: "r", path: root }], access: "read", requireRoot: true, platform: process.platform });
    assert.equal(resolved.ok, true);
    s.r.stores.grants.create({
      capability: "shell.exec", person: "christian", agent: "bernd", scope: "task", taskId: "t1",
      match: { kind: "path", path: resolved.ok ? resolved.canonical : sub, access: "write", recursive: true },
      createdBy: "christian", surface: 3,
    });
    const classified = await classifyExec(args, root);
    assert.equal(classified.targets.length, 1);
    assert.equal(classified.targets[0], resolved.ok ? resolved.canonical : sub);
    assert.equal(typeof classified.hashExtra, "string");
    const first = await s.call(args);
    assert.equal(first.isError, false, first.isError ? first.error.message : "");
    assert.equal(first.meta.decision, "allow");
    assert.equal(port.spawned.length, 1);
    s.r.service.dispose();
  });

  it("a once grant bound to one env is refused when PATH (hashExtra) changes", T, async () => {
    const { root, sub } = tmpRoot();
    const args = { program: "git", cwd: sub, args: ["status"] };
    const hashOf = async () => {
      const probe = await setup(root, new FakePort());
      let settled: Awaited<ReturnType<typeof probe.call>> | undefined;
      const p = probe.call(args).then((res) => { settled = res; return res; });
      while (probe.r.service.list().length === 0 && settled === undefined) await tick();
      const listed = probe.r.service.list()[0];
      if (!listed) throw new Error(`probe did not ask; result=${JSON.stringify(settled)}`);
      const h = listed.actionHash;
      probe.r.service.dispose();
      await p;
      return h;
    };
    const actionHash = await hashOf();
    const port = new FakePort();
    port.onSpawn = (p) => p.exit(0);
    const s = await setup(root, port);
    s.r.stores.grants.create({
      capability: "shell.exec", person: "christian", agent: "bernd", scope: "once",
      match: { kind: "action" }, actionHash, createdBy: "christian", surface: 3,
    });
    const replay = s.call({ ...args, env: { PATH: "/tmp/other-bin" } });
    let settled: Awaited<ReturnType<typeof s.call>> | undefined;
    const p = replay.then((res) => { settled = res; return res; });
    while (s.r.service.list().length === 0 && settled === undefined) await tick();
    assert.equal(s.r.service.list().length, 1, "a different env is a different action; the once grant does not cover it");
    s.r.service.dispose();
    const out = await p;
    assert.equal(out.isError, true);
    assert.equal(port.spawned.length, 0);
  });

  it("spawn is refused when live env fingerprint no longer matches classified.hashExtra", T, async () => {
    const { root, sub } = tmpRoot();
    const args = { program: "git", cwd: sub, args: ["status"] };
    const live = { PATH: "/usr/bin" };
    const classified = await classifyExec(args, root, live);
    live.PATH = "/tmp/mutated";
    const port = new FakePort();
    port.onSpawn = (p) => p.exit(0);
    const r = await baseRig();
    const inner = createExecTool({
      config: { mode: "ask", roots: [{ id: "r", path: root }], allowlist: [{ program: "git" }] },
      process: port, timers: new FakeTimers(), audit: r.audit,
      policy: { grants: r.stores.grants, clock: r.clock },
      policyContext: {
        principal: { person: "christian" }, subject: { kind: "agent", agentId: "bernd" },
        surface: 3, overrides: { "shell.exec": "allowed" },
      },
      baseEnv: live, platform: process.platform,
    });
    const refused = await inner.execute(args, { signal: new AbortController().signal, classified });
    assert.equal(refused.isError, true);
    assert.match(refused.isError ? refused.message : "", /environment no longer matches|env/i);
    assert.equal(port.spawned.length, 0);
    r.service.dispose();
  });
});
