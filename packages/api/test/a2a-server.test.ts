import assert from "node:assert/strict";
import test from "node:test";
import { A2A_PROTOCOL_VERSION } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import {
  addUser,
  fakeCore,
  loginAs,
  raw,
  start,
  write,
  type Harness,
} from "./helpers.ts";

const wide = {
  auth: { capacity: 1000, refillPerSec: 100 },
  read: { capacity: 1000, refillPerSec: 100 },
  write: { capacity: 1000, refillPerSec: 100 },
  totp: { capacity: 1000, refillPerSec: 100 },
  stream: { capacity: 1000, refillPerSec: 100 },
  rpc: { capacity: 1000, refillPerSec: 100 },
  expensive: { capacity: 10, refillPerSec: 10 },
};

const setupA2a = async (opts: {
  a2aServerEnabled?: boolean;
  agentExposed?: boolean;
  legacy03?: boolean;
  expensiveCapacity?: number;
  expensiveConcurrency?: number;
} = {}) => {
  const core = fakeCore();
  let releaseCancelGate: (() => void) | undefined;
  const cancelGate = new Promise<void>((r) => {
    releaseCancelGate = r;
  });

  core.impl = async (m, p) => {
    if (m === "agent.list") {
      return { agents: [{ agentId: "main", open: true, activity: { state: "idle", since: 1 } }, { agentId: "agent2", open: true, activity: { state: "idle", since: 1 } }] };
    }
    if (m === "external.turn.start") {
      const params = p as {
        agentId: string;
        message: string;
        sessionId?: string;
        wait?: boolean;
      };
      if (params.message.includes("Turn to cancel")) {
        await cancelGate;
        return {
          sessionId: params.sessionId ?? "session-a2a-cancel",
          turnId: "turn-cancel-1",
          state: "failed",
          error: "cancelled",
        };
      }
      return {
        sessionId: params.sessionId ?? "session-a2a-1",
        turnId: "turn-1",
        state: "completed",
        reply: `Echo: ${params.message}`,
      };
    }
    if (m === "external.turn.cancel") {
      releaseCancelGate?.();
      return { ok: true };
    }
    if (m === "core.status") {
      return { rpc: "1.8.0", contract: "c", uptimeMs: 1, engine: { ready: true, degraded: null } };
    }
    throw new Error(`unexpected rpc ${m}`);
  };

  const rateClasses = {
    ...wide,
    expensive: {
      capacity: opts.expensiveCapacity ?? 10,
      refillPerSec: 1 / 60,
    },
  };

  const a2aConfig = {
    a2aServer: {
      enabled: opts.a2aServerEnabled ?? true,
      legacy03: opts.legacy03 ?? false,
    },
    agents: {
      main: {
        a2aServer: {
          exposed: opts.agentExposed ?? true,
          name: "Main Assistant",
          description: "Primary testing agent",
        },
      },
    },
  };

  const h = await start({
    rateClasses,
    core,
    a2aConfig,
    expensiveConcurrency: opts.expensiveConcurrency ?? 8,
  });

  await addUser(h, { id: "u-a2a", username: "a2auser", role: "member", agentRights: { main: "use", agent2: "use" } });
  return h;
};

const mintBoundToken = async (
  h: Harness,
  cookie: string,
  audience: "mcp" | "a2a",
  agentId = "main",
) => {
  const r = await write(h, cookie, {
    path: "/api/v1/tokens",
    body: { name: `tok-${audience}`, scopes: ["agent.use"], binding: { audience, agentId } },
  });
  assert.equal(r.status, 201, r.text);
  return { token: r.json.token as string, id: (r.json.record as { id: string }).id };
};

test("M6A-A4.1: /a2a/{agentId} enforces Bearer-only auth and audience binding", async () => {
  const h = await setupA2a();
  try {
    const { cookie } = await loginAs(h, "a2auser");
    const a2aToken = await mintBoundToken(h, cookie, "a2a", "main");
    const mcpToken = await mintBoundToken(h, cookie, "mcp", "main");

    // 1. Unauthenticated request -> 401
    const unauth = await raw(h, {
      method: "POST",
      path: "/a2a/main",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/list", params: {} }),
    });
    assert.equal(unauth.status, 401);

    // 2. Audience mismatch: MCP token used on A2A endpoint -> 401 invalid-audience
    const audMismatch = await raw(h, {
      method: "POST",
      path: "/a2a/main",
      headers: {
        authorization: `Bearer ${mcpToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ListTasks", params: {} }),
    });
    assert.equal(audMismatch.status, 401);
    assert.equal(audMismatch.json.reason, "invalid-audience");

    // 3. Agent mismatch: token bound to agent2 called on agent main -> 403
    const otherToken = await mintBoundToken(h, cookie, "a2a", "agent2");
    const agentMismatch = await raw(h, {
      method: "POST",
      path: "/a2a/main",
      headers: {
        authorization: `Bearer ${otherToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ListTasks", params: {} }),
    });
    assert.equal(agentMismatch.status, 403);
    assert.equal(agentMismatch.json.reason, "token-agent-mismatch");

    // 4. Valid token succeeds
    const valid = await raw(h, {
      method: "POST",
      path: "/a2a/main",
      headers: {
        authorization: `Bearer ${a2aToken.token}`,
        "a2a-version": A2A_PROTOCOL_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ListTasks", params: {} }),
    });
    assert.equal(valid.status, 200);
    assert.equal(valid.json.jsonrpc, "2.0");
    assert.equal(valid.json.id, 4);
    assert.ok(Array.isArray(valid.json.result?.tasks));
  } finally {
    await h.close();
  }
});

test("M6A-A4.1: unexposed agent returns 403 and audits a2a.server.denied", async () => {
  const h = await setupA2a({ agentExposed: false });
  try {
    const { cookie } = await loginAs(h, "a2auser");
    const a2aToken = await mintBoundToken(h, cookie, "a2a", "main");

    const res = await raw(h, {
      method: "POST",
      path: "/a2a/main",
      headers: {
        authorization: `Bearer ${a2aToken.token}`,
        "a2a-version": A2A_PROTOCOL_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "agent-not-exposed");

    const deniedEvent = h.audit.events.find(
      (e) => e.action === "a2a.server.denied" && (e.detail as { reason?: string }).reason === "agent-not-exposed",
    );
    assert.ok(deniedEvent, "a2a.server.denied event must be emitted");
    assert.equal((deniedEvent.detail as { tokenId?: string }).tokenId, a2aToken.id);
    assert.equal((deniedEvent.detail as { agentId?: string }).agentId, "main");
  } finally {
    await h.close();
  }
});

test("M6A-A4.1: tasks/send executes external turn and audits a2a.server.call", async () => {
  const h = await setupA2a();
  try {
    const { cookie } = await loginAs(h, "a2auser");
    const a2aToken = await mintBoundToken(h, cookie, "a2a", "main");

    const res = await raw(h, {
      method: "POST",
      path: "/a2a/main",
      headers: {
        authorization: `Bearer ${a2aToken.token}`,
        "a2a-version": A2A_PROTOCOL_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "send-1",
        method: "SendMessage",
        params: {
          message: {
            messageId: "msg-send-1",
            role: "user",
            parts: [
              {
                text: "Hello over A2A 1.0",
              },
            ],
          },
        },
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.jsonrpc, "2.0");
    assert.equal(res.json.id, "send-1");

    const task = res.json.result?.task;
    assert.ok(task);
    assert.equal(task.status?.state, "TASK_STATE_COMPLETED");
    assert.ok(Array.isArray(task.artifacts));
    assert.equal(task.artifacts.length, 1);
    assert.equal(task.artifacts[0].parts[0].text, "Echo: Hello over A2A 1.0");

    // Verify external.turn.start was called on core
    const turnCall = h.core.calls.find((c) => c.method === "external.turn.start");
    assert.ok(turnCall, "core external.turn.start must be invoked");
    assert.equal((turnCall.params as { agentId: string }).agentId, "main");
    assert.equal((turnCall.params as { audience: string }).audience, "a2a");
    assert.equal((turnCall.params as { message: string }).message, "Hello over A2A 1.0");

    // Verify audit event
    const callEvent = h.audit.events.find(
      (e) => e.action === "a2a.server.call" && (e.detail as { method?: string }).method === "SendMessage",
    );
    assert.ok(callEvent, "a2a.server.call must be emitted");
    assert.equal((callEvent.detail as { tokenId?: string }).tokenId, a2aToken.id);
    assert.equal((callEvent.detail as { agentId?: string }).agentId, "main");
  } finally {
    await h.close();
  }
});

test("M6A-A4.1: tasks/cancel requests cancellation and returns cancelled task", async () => {
  const h = await setupA2a();
  try {
    const { cookie } = await loginAs(h, "a2auser");
    const a2aToken = await mintBoundToken(h, cookie, "a2a", "main");

    // Send task first
    const sendRes = await raw(h, {
      method: "POST",
      path: "/a2a/main",
      headers: {
        authorization: `Bearer ${a2aToken.token}`,
        "a2a-version": A2A_PROTOCOL_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "send-to-cancel",
        method: "SendMessage",
        params: {
          configuration: { returnImmediately: true },
          message: {
            messageId: "msg-cancel-1",
            role: "user",
            parts: [{ text: "Turn to cancel" }],
          },
        },
      }),
    });
    assert.equal(sendRes.status, 200);
    const taskId = sendRes.json.result?.task?.id;
    assert.ok(taskId);

    // Cancel task
    const cancelRes = await raw(h, {
      method: "POST",
      path: "/a2a/main",
      headers: {
        authorization: `Bearer ${a2aToken.token}`,
        "a2a-version": A2A_PROTOCOL_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "cancel-1",
        method: "CancelTask",
        params: { id: taskId },
      }),
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.json.id, "cancel-1");
    assert.equal(cancelRes.json.result?.status?.state, "TASK_STATE_CANCELED");

    const cancelCall = h.core.calls.find((c) => c.method === "external.turn.cancel");
    assert.ok(cancelCall, "core external.turn.cancel must be called");
  } finally {
    await h.close();
  }
});

test("M6A-A4.1: tasks/send draws on expensive rate class and audits rate-limited denial", async () => {
  const h = await setupA2a({ expensiveCapacity: 1 });
  try {
    const { cookie } = await loginAs(h, "a2auser");
    const a2aToken = await mintBoundToken(h, cookie, "a2a", "main");

    const makeSend = () =>
      raw(h, {
        method: "POST",
        path: "/a2a/main",
        headers: {
          authorization: `Bearer ${a2aToken.token}`,
          "a2a-version": A2A_PROTOCOL_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "send-rate",
          method: "SendMessage",
          params: {
            message: {
              messageId: "msg-rate-1",
              role: "user",
              parts: [{ text: "Rate limit test" }],
            },
          },
        }),
      });

    // 1st request succeeds
    const first = await makeSend();
    assert.equal(first.status, 200);

    // 2nd request exhausts expensive capacity -> 429
    const second = await makeSend();
    assert.equal(second.status, 429);

    const rateLimitedDenied = h.audit.events.find(
      (e) => e.action === "a2a.server.denied" && (e.detail as { reason?: string }).reason === "rate-limited",
    );
    assert.ok(rateLimitedDenied, "a2a.server.denied with reason rate-limited must be emitted");
    assert.equal((rateLimitedDenied.detail as { method?: string }).method, "SendMessage");
    assert.equal((rateLimitedDenied.detail as { tokenId?: string }).tokenId, a2aToken.id);
  } finally {
    await h.close();
  }
});

test("M6A-A4.5: rejects 0.3 incoming requests with -32009 by default without legacy03 opt-in", async () => {
  const h = await setupA2a({ legacy03: false });
  try {
    const { cookie } = await loginAs(h, "a2auser");
    const a2aToken = await mintBoundToken(h, cookie, "a2a", "main");

    // 1. Explicit A2A-Version: 0.3 -> -32009
    const v03Res = await raw(h, {
      method: "POST",
      path: "/a2a/main",
      headers: {
        authorization: `Bearer ${a2aToken.token}`,
        "a2a-version": "0.3",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "v03-1",
        method: "message/send",
        params: { message: { messageId: "m1", role: "user", parts: [{ text: "hi" }] } },
      }),
    });
    assert.equal(v03Res.status, 200);
    assert.equal(v03Res.json.id, "v03-1");
    assert.equal(v03Res.json.error?.code, -32009);

    // 2. Missing A2A-Version header -> -32009
    const noHeaderRes = await raw(h, {
      method: "POST",
      path: "/a2a/main",
      headers: {
        authorization: `Bearer ${a2aToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "no-hdr-1",
        method: "SendMessage",
        params: { message: { messageId: "m2", role: "user", parts: [{ text: "hi" }] } },
      }),
    });
    assert.equal(noHeaderRes.status, 200);
    assert.equal(noHeaderRes.json.id, "no-hdr-1");
    assert.equal(noHeaderRes.json.error?.code, -32009);
  } finally {
    await h.close();
  }
});

test("M6A-A4.5: enables 0.3 compatibility when legacy03 is true and handles legacy message/send", async () => {
  const h = await setupA2a({ legacy03: true });
  try {
    const { cookie } = await loginAs(h, "a2auser");
    const a2aToken = await mintBoundToken(h, cookie, "a2a", "main");

    // Legacy card contains 0.3 supportedInterfaces
    const cardRes = await raw(h, {
      method: "GET",
      path: "/a2a/main/.well-known/agent-card.json",
    });
    assert.equal(cardRes.status, 200);
    const versions = cardRes.json.supportedInterfaces?.map((i: { protocolVersion: string }) => i.protocolVersion);
    assert.ok(versions.includes("1.0"));
    assert.ok(versions.includes("0.3"));

    // Legacy message/send succeeds
    const legacyRes = await raw(h, {
      method: "POST",
      path: "/a2a/main",
      headers: {
        authorization: `Bearer ${a2aToken.token}`,
        "a2a-version": "0.3",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "legacy-msg-1",
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "m-leg-1",
            role: "user",
            parts: [{ kind: "text", text: "Hello over 0.3" }],
          },
        },
      }),
    });

    assert.equal(legacyRes.status, 200);
    assert.equal(legacyRes.json.id, "legacy-msg-1");
    assert.ok(legacyRes.json.result);
    // Legacy result should return a completed task or message
    const resTask = legacyRes.json.result;
    assert.ok(resTask.id || resTask.task?.id);
  } finally {
    await h.close();
  }
});
