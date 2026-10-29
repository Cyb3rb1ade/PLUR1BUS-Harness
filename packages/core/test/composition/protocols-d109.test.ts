import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../../src/session/store.ts";
import { SessionError } from "../../src/session/types.ts";
import { subjectForOrigin } from "../../src/composition/protocols.ts";
import { approvalPolicyContext } from "../../src/composition/index.ts";
import { ToolDispatcher } from "../../src/tools/dispatcher.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { openPermissionStores } from "../../src/grants/open.ts";
import { createApprovalService } from "../../src/approvals/service.ts";
import { staticKeySource } from "../../src/approvals/keys.ts";

describe("M6A-A1.4: session origin and D109 subject binding", () => {
  it("stores nullable immutable origin in sessions.sqlite and maps it with subjectForOrigin", () => {
    const dir = join(tmpdir(), `m6a-a14-origin-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const store = new SessionStore({ path: ":memory:" });
    try {
      const internal = store.createSession({ kind: "direct", agentId: "main", owner: "user:v1:alice" });
      assert.equal(internal.origin, undefined);
      assert.equal(subjectForOrigin(internal.origin), "agent");
      assert.equal(subjectForOrigin(null), "agent");

      const mcpSession = store.createSession({
        kind: "direct",
        agentId: "main",
        owner: "ext:mcp:tok-1",
        origin: "mcp",
      });
      assert.equal(mcpSession.origin, "mcp");
      assert.equal(subjectForOrigin(mcpSession.origin), "mcp-client");

      const a2aSession = store.createSession({
        kind: "direct",
        agentId: "main",
        owner: "ext:a2a:tok-2",
        origin: "a2a",
      });
      assert.equal(a2aSession.origin, "a2a");
      assert.equal(subjectForOrigin(a2aSession.origin), "a2a-peer");

      const acpSession = store.createSession({
        kind: "acp",
        agentId: "main",
        owner: "user:v1:alice",
        origin: "acp-agent",
      });
      assert.equal(acpSession.origin, "acp-agent");
      assert.equal(subjectForOrigin(acpSession.origin), "acp-agent");

      assert.throws(
        () => store.createSession({ kind: "direct", agentId: "main", owner: "user:v1:alice", origin: "bad" as never }),
        (err: unknown) => err instanceof SessionError && err.code === "invalid" && err.reason === "origin",
      );
      assert.throws(
        () => store.updateSession(mcpSession.id, { origin: "a2a" } as never),
        (err: unknown) => err instanceof SessionError && err.code === "immutable",
      );
    } finally {
      store.close();
      void rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("enforces origin immutability and CHECK constraint in SQLite triggers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "m6a-a14-sql-"));
    const dbPath = join(dir, "sessions.sqlite");
    try {
      const store = new SessionStore({ path: dbPath });
      const created = store.createSession({
        kind: "direct",
        agentId: "main",
        owner: "ext:a2a:tok-1",
        origin: "a2a",
      });
      store.close();

      const raw = new DatabaseSync(dbPath);
      try {
        assert.throws(
          () => raw.prepare("UPDATE sessions SET origin = 'mcp' WHERE id = ?").run(created.id),
          /I1/,
        );
        assert.throws(
          () => raw.prepare("UPDATE sessions SET origin = NULL WHERE id = ?").run(created.id),
          /I1/,
        );
      } finally {
        raw.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("denies tool calls in A2A turns with surface-untrusted, parks MCP approvals with mcp-client, and keeps internal turns unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "m6a-a14-d109-"));
    const sessionStore = new SessionStore({ path: ":memory:" });
    const permStores = await openPermissionStores({
      path: join(dir, "approvals.sqlite"),
      keys: staticKeySource(Buffer.alloc(32, 7)),
      clock: { now: () => 1_700_000_000_000 },
    });
    const timers: Array<() => void> = [];
    const approvalService = createApprovalService({
      stores: permStores,
      clock: { now: () => 1_700_000_000_000 },
      timers: {
        set(fn) {
          timers.push(fn);
          return () => {};
        },
      },
    });
    try {
      const a2aSession = sessionStore.createSession({
        kind: "direct",
        agentId: "main",
        owner: "ext:a2a:tok-a2a",
        origin: "a2a",
      });
      const mcpSession = sessionStore.createSession({
        kind: "direct",
        agentId: "main",
        owner: "ext:mcp:tok-mcp",
        origin: "mcp",
      });
      const internalSession = sessionStore.createSession({
        kind: "direct",
        agentId: "main",
        owner: "user:v1:alice",
      });

      const registry = new ToolRegistry();
      registry.register({
        name: "file.read",
        description: "Read a file inside workspace",
        capability: "fs.read",
        effect: "read",
        risk: "low",
        trust: "first-party",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        classify: (args) => {
          const p = (args as { path?: string })?.path ?? "";
          return { flags: { outsideRoots: p.startsWith("/outside"), denyListHit: false }, targets: [p || "/workspace/a.txt"], access: "read" };
        },
        execute: async () => ({ content: "ok" }),
      });

      const policyCtx = approvalPolicyContext(
        { current: () => ({ service: approvalService, grants: permStores.grants, stores: permStores }) },
        (sessionId) => sessionStore.getSession(sessionId)?.origin,
      );

      const audits: Array<{ action: string; fields: Record<string, unknown> }> = [];
      const dispatcher = new ToolDispatcher({
        registry,
        approvals: approvalService,
        grants: permStores.grants,
        grantUse: permStores.grants,
        clock: { now: () => 1_700_000_000_000 },
        audit: {
          record(action, fields) {
            audits.push({ action, fields: fields as unknown as Record<string, unknown> });
          },
        },
        policyContext: (ctx) => policyCtx(ctx, { sessionId: ctx.sessionId ?? "", agentId: ctx.agentId, summaries: [], memory: "", messages: [], signal: ctx.signal }),
      });

      // 1. A2A turn: even an inside-roots read tool is denied with surface-untrusted (rule: a2a-peer).
      const a2aOut = await dispatcher.call(
        { id: "call-a2a", name: "file.read", args: { path: "/workspace/a.txt" } },
        {
          agentId: "main",
          principal: "user:v1:alice",
          sessionId: a2aSession.id,
          turnId: "turn-a2a",
          surface: 0,
          signal: new AbortController().signal,
        },
      );
      assert.equal(a2aOut.isError, true);
      if (a2aOut.isError) {
        assert.equal(a2aOut.error.code, "tool-denied");
      }
      const a2aDecisionAudit = audits.find((a) => a.action === "policy.decision" && a.fields.sessionId === a2aSession.id);
      assert.ok(a2aDecisionAudit);
      assert.equal(a2aDecisionAudit.fields.subjectKind, "a2a-peer");
      assert.equal(a2aDecisionAudit.fields.reason, "surface-untrusted");
      assert.equal(a2aDecisionAudit.fields.rule, "a2a-peer");

      // 2. MCP turn: outside-roots read requires approval, parks with subjectKind: "mcp-client".
      const mcpPromise = dispatcher.call(
        { id: "call-mcp", name: "file.read", args: { path: "/outside/secret.txt" } },
        {
          agentId: "main",
          principal: "user:v1:alice",
          sessionId: mcpSession.id,
          turnId: "turn-mcp",
          surface: 0,
          signal: new AbortController().signal,
        },
      );
      // Trigger foreground park timer
      await new Promise((r) => setImmediate(r));
      assert.ok(timers.length >= 1);
      timers[0]!();
      const mcpOut = await mcpPromise;
      assert.equal(mcpOut.isError, true);
      if (mcpOut.isError) {
        assert.equal(mcpOut.error.code, "tool-not-approved");
      }
      const pendingApprovals = approvalService.list({ sessionId: mcpSession.id });
      assert.equal(pendingApprovals.length, 1);
      assert.deepEqual(pendingApprovals[0]!.subject, { kind: "mcp-client", id: "main" });

      // 3. Internal turn: inside-roots read succeeds with subjectKind: "agent", and outside-roots approval uses subject "agent".
      const internalAllowed = await dispatcher.call(
        { id: "call-int-1", name: "file.read", args: { path: "/workspace/a.txt" } },
        {
          agentId: "main",
          principal: "user:v1:alice",
          sessionId: internalSession.id,
          turnId: "turn-int-1",
          surface: 2,
          signal: new AbortController().signal,
        },
      );
      assert.equal(internalAllowed.isError, false);

      const intTimerStart = timers.length;
      const internalAskPromise = dispatcher.call(
        { id: "call-int-2", name: "file.read", args: { path: "/outside/other.txt" } },
        {
          agentId: "main",
          principal: "user:v1:alice",
          sessionId: internalSession.id,
          turnId: "turn-int-2",
          surface: 2,
          signal: new AbortController().signal,
        },
      );
      await new Promise((r) => setImmediate(r));
      timers[intTimerStart]!();
      await internalAskPromise;
      const internalApprovals = approvalService.list({ sessionId: internalSession.id });
      assert.equal(internalApprovals.length, 1);
      assert.deepEqual(internalApprovals[0]!.subject, { kind: "agent", id: "main" });
    } finally {
      approvalService.dispose();
      permStores.close();
      sessionStore.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
