import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../../src/session/store.ts";
import { createExternalTurnService } from "../../src/external-turn/index.ts";
import { guardMethods, RPC_RULES } from "../../src/rbac/guard.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import type { CallContext } from "../../src/rpc/server.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { ChatChunk, ChatProvider, ChatRequest } from "../../src/session/provider.ts";

function fakeProvider(chunks: ChatChunk[] = [{ type: "delta", text: "Hello from agent" }, { type: "usage", inputTokens: 10, outputTokens: 5 }]): ChatProvider {
  return {
    id: "fake-provider",
    async *stream(_req: ChatRequest) {
      for (const c of chunks) {
        yield c;
      }
    },
  };
}

interface TestRigOptions {
  provider?: ChatProvider | null;
  gate?: () => Promise<void>;
}

function createRig(opts: TestRigOptions = {}) {
  const store = new SessionStore({ path: ":memory:" });
  const recalledCalls: any[] = [];
  const capturedCalls: any[] = [];

  const externalMemory = {
    recall: async (turn: any, query: string) => {
      recalledCalls.push({ turn, query });
      return "recalled memory for test";
    },
    capture: (turn: any, exchange: any) => {
      capturedCalls.push({ turn, exchange });
    },
    idle: async () => {},
  };

  const agents = {
    has: (id: string) => id === "bernd" || id === "alice",
    workspaceOf: (id: string) => (id === "bernd" || id === "alice" ? `/ws/${id}` : null),
  } as any;

  let activeProvider: ChatProvider | null = opts.provider !== undefined ? opts.provider : fakeProvider();

  const service = createExternalTurnService({
    store,
    agents,
    provider: () => activeProvider,
    externalMemory,
  });

  let currentPrincipal: Principal = {
    userId: "user-1",
    role: "owner",
    kind: "person",
  };

  const guarded = guardMethods(service.methods, {
    resolve: () => currentPrincipal,
    now: () => Date.now(),
  });

  const ctx: CallContext = {
    requestId: "r-1",
    connectionId: "conn-1",
    signal: new AbortController().signal,
  };

  const call = async (method: string, params: object, customCtx?: CallContext) => {
    const fn = guarded[method];
    if (!fn) throw new Error(`unknown method ${method}`);
    return fn(params, customCtx ?? ctx);
  };

  return {
    store,
    service,
    externalMemory,
    recalledCalls,
    capturedCalls,
    call,
    setPrincipal: (p: Principal) => {
      currentPrincipal = p;
    },
    setProvider: (p: ChatProvider | null) => {
      activeProvider = p;
    },
  };
}

describe("M6A-A1.3: External turns service in core", () => {
  it("external.turn.start with wait: true runs complete turn with recall and capture", async () => {
    const rig = createRig();
    rig.setPrincipal({
      userId: "mcp-user",
      role: "owner",
      tokenId: "tok-1",
    });

    const res: any = await rig.call("external.turn.start", {
      agentId: "bernd",
      message: "What is my task?",
      audience: "mcp",
      tokenId: "tok-1",
      wait: true,
    });

    assert.equal(res.state, "completed");
    assert.equal(res.reply, "Hello from agent");
    assert.ok(res.sessionId.startsWith("ses_"));
    assert.ok(res.turnId.startsWith("trn_"));

    // Verify session origin and owner in store
    const session = rig.store.getSession(res.sessionId);
    assert.ok(session);
    assert.equal(session.origin, "mcp");
    assert.equal(session.owner, "ext:mcp:tok-1");
    assert.equal(session.agentId, "bernd");

    // Verify externalMemory calls
    assert.equal(rig.recalledCalls.length, 1);
    assert.equal(rig.recalledCalls[0].turn.channel, "mcp");
    assert.equal(rig.recalledCalls[0].turn.agentId, "bernd");
    assert.equal(rig.recalledCalls[0].query, "What is my task?");

    assert.equal(rig.capturedCalls.length, 1);
    assert.equal(rig.capturedCalls[0].turn.channel, "mcp");
    assert.equal(rig.capturedCalls[0].turn.agentId, "bernd");
    assert.deepEqual(rig.capturedCalls[0].exchange, {
      question: "What is my task?",
      answer: "Hello from agent",
    });
  });

  it("external.turn.start with wait: false returns state running, events and get can query it", async () => {
    const rig = createRig();
    rig.setPrincipal({
      userId: "mcp-user",
      role: "owner",
      tokenId: "tok-1",
    });

    const startRes: any = await rig.call("external.turn.start", {
      agentId: "bernd",
      message: "Process asynchronously",
      audience: "mcp",
      wait: false,
    });

    assert.equal(startRes.state, "running");
    assert.ok(startRes.sessionId);
    assert.ok(startRes.turnId);

    // Wait for async processing to finish
    await rig.service.idle();

    // Query events
    const evRes: any = await rig.call("external.turn.events", {
      sessionId: startRes.sessionId,
      agentId: "bernd",
      audience: "mcp",
    });

    assert.equal(evRes.sessionId, startRes.sessionId);
    assert.ok(evRes.events.length >= 2); // turn.started, delta, turn.completed
    assert.equal(evRes.running, false);

    // Query session details
    const getRes: any = await rig.call("external.turn.get", {
      sessionId: startRes.sessionId,
      agentId: "bernd",
      audience: "mcp",
      messages: 10,
    });

    assert.equal(getRes.sessionId, startRes.sessionId);
    assert.equal(getRes.session.id, startRes.sessionId);
    assert.equal(getRes.runningTurnId, null);
    assert.ok(getRes.messages);
    assert.equal(getRes.messages.length, 2); // user and assistant messages
    assert.equal(getRes.messages[0].role, "user");
    assert.equal(getRes.messages[1].role, "assistant");
  });

  it("can continue an existing session with multiple turns", async () => {
    const rig = createRig();
    rig.setPrincipal({
      userId: "mcp-user",
      role: "owner",
      tokenId: "tok-multi",
    });

    const turn1: any = await rig.call("external.turn.start", {
      agentId: "bernd",
      message: "First message",
      audience: "mcp",
      tokenId: "tok-multi",
      wait: true,
    });

    const turn2: any = await rig.call("external.turn.start", {
      agentId: "bernd",
      sessionId: turn1.sessionId,
      message: "Second message",
      audience: "mcp",
      tokenId: "tok-multi",
      wait: true,
    });

    assert.equal(turn2.sessionId, turn1.sessionId);
    assert.notEqual(turn2.turnId, turn1.turnId);

    const getRes: any = await rig.call("external.turn.get", {
      sessionId: turn1.sessionId,
      agentId: "bernd",
      audience: "mcp",
      messages: 10,
    });

    assert.equal(getRes.messages.length, 4); // 2 user messages, 2 assistant messages
  });

  it("enforces session origin: calling a2a on an mcp session is denied", async () => {
    const rig = createRig();
    rig.setPrincipal({
      userId: "user-1",
      role: "owner",
      tokenId: "tok-1",
    });

    const turn: any = await rig.call("external.turn.start", {
      agentId: "bernd",
      message: "Initial mcp turn",
      audience: "mcp",
      tokenId: "tok-1",
      wait: true,
    });

    // Attempting to access with audience: "a2a" fails
    await assert.rejects(
      async () => {
        await rig.call("external.turn.start", {
          agentId: "bernd",
          sessionId: turn.sessionId,
          message: "Attempt crossover",
          audience: "a2a",
          tokenId: "tok-1",
          wait: true,
        });
      },
      (e: any) => e instanceof RpcError && e.error === "E_DENIED",
    );
  });

  it("enforces owner isolation: token B cannot see or access session of token A", async () => {
    const rig = createRig();

    rig.setPrincipal({
      userId: "user-a",
      role: "owner",
      tokenId: "tok-a",
    });

    const turn: any = await rig.call("external.turn.start", {
      agentId: "bernd",
      message: "Token A message",
      audience: "mcp",
      tokenId: "tok-a",
      wait: true,
    });

    rig.setPrincipal({
      userId: "user-b",
      role: "owner",
      tokenId: "tok-b",
    });

    // Token B querying Token A's session gets E_NOT_FOUND
    await assert.rejects(
      async () => {
        await rig.call("external.turn.get", {
          sessionId: turn.sessionId,
          agentId: "bernd",
          audience: "mcp",
          tokenId: "tok-b",
        });
      },
      (e: any) => e instanceof RpcError && e.error === "E_NOT_FOUND",
    );
  });

  it("enforces agent-bound tokens: token bound to agent-A cannot run turns for agent-B", async () => {
    const rig = createRig();
    rig.setPrincipal({
      userId: "user-bound",
      role: "operator",
      tokenId: "tok-bound",
      binding: {
        audience: "mcp",
        agentId: "bernd",
      },
      agentRights: {
        bernd: "use",
      },
    });

    // Allowed on bound agent bernd
    const turn: any = await rig.call("external.turn.start", {
      agentId: "bernd",
      message: "Allowed on bernd",
      audience: "mcp",
      wait: true,
    });
    assert.equal(turn.state, "completed");

    // Denied on different agent alice
    await assert.rejects(
      async () => {
        await rig.call("external.turn.start", {
          agentId: "alice",
          message: "Not allowed on alice",
          audience: "mcp",
          wait: true,
        });
      },
      (e: any) => e instanceof RpcError && e.error === "E_DENIED",
    );
  });

  it("enforces audience-bound tokens: token bound to mcp cannot run a2a turns", async () => {
    const rig = createRig();
    rig.setPrincipal({
      userId: "user-bound",
      role: "owner",
      tokenId: "tok-mcp-only",
      binding: {
        audience: "mcp",
        agentId: "bernd",
      },
    });

    await assert.rejects(
      async () => {
        await rig.call("external.turn.start", {
          agentId: "bernd",
          message: "Try a2a with mcp token",
          audience: "a2a",
          wait: true,
        });
      },
      (e: any) => e instanceof RpcError && e.error === "E_DENIED",
    );
  });

  it("token with a2a.task scope is authorized for external turns", async () => {
    const rig = createRig();
    rig.setPrincipal({
      userId: "a2a-peer",
      role: "member",
      tokenId: "tok-a2a",
      tokenScopes: ["a2a.task"],
      agentRights: {
        bernd: "use",
      },
      binding: {
        audience: "a2a",
        agentId: "bernd",
      },
    });

    const res: any = await rig.call("external.turn.start", {
      agentId: "bernd",
      message: "Inbound A2A task message",
      audience: "a2a",
      wait: true,
    });

    assert.equal(res.state, "completed");
    assert.equal(res.reply, "Hello from agent");
  });

  it("external.turn.cancel aborts running turn and marks it failed with cancelled", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });

    const blockedProvider: ChatProvider = {
      id: "blocked-provider",
      async *stream(_req: ChatRequest) {
        yield { type: "delta", text: "Starting..." };
        await gate;
        yield { type: "delta", text: "Finished." };
      },
    };

    const rig = createRig({ provider: blockedProvider });
    rig.setPrincipal({
      userId: "mcp-user",
      role: "owner",
      tokenId: "tok-cancel",
    });

    const startRes: any = await rig.call("external.turn.start", {
      agentId: "bernd",
      message: "Long running task",
      audience: "mcp",
      tokenId: "tok-cancel",
      wait: false,
    });

    assert.equal(startRes.state, "running");

    // Cancel the running turn
    const cancelRes: any = await rig.call("external.turn.cancel", {
      sessionId: startRes.sessionId,
      agentId: "bernd",
      audience: "mcp",
      tokenId: "tok-cancel",
    });

    assert.equal(cancelRes.cancelled, true);
    assert.equal(cancelRes.turnId, startRes.turnId);

    // Release gate and wait for completion
    releaseGate();
    await rig.service.idle();

    // Check session status: turn should be failed with cancelled
    const turn = rig.store.getTurn(startRes.turnId);
    assert.ok(turn);
    assert.equal(turn.state, "failed");
    assert.equal(turn.error, "cancelled");
  });

  it("error cases: invalid params, missing provider, unknown agent", async () => {
    const rig = createRig();
    rig.setPrincipal({
      userId: "user-1",
      role: "owner",
      tokenId: "tok-1",
    });

    // 1. Empty message text
    await assert.rejects(
      async () => {
        await rig.call("external.turn.start", {
          agentId: "bernd",
          message: "",
          audience: "mcp",
          wait: true,
        });
      },
      (e: any) => e instanceof RpcError && e.error === "E_INVALID_PARAMS",
    );

    // 2. Invalid audience
    await assert.rejects(
      async () => {
        await rig.call("external.turn.start", {
          agentId: "bernd",
          message: "hello",
          audience: "invalid" as any,
          wait: true,
        });
      },
      (e: any) => e instanceof RpcError && e.error === "E_INVALID_PARAMS",
    );

    // 3. Unknown agent
    await assert.rejects(
      async () => {
        await rig.call("external.turn.start", {
          agentId: "nonexistent-agent",
          message: "hello",
          audience: "mcp",
          wait: true,
        });
      },
      (e: any) => e instanceof RpcError && e.error === "E_AGENT_UNKNOWN",
    );

    // 4. Missing provider throws E_NOT_AVAILABLE
    rig.setProvider(null);
    await assert.rejects(
      async () => {
        await rig.call("external.turn.start", {
          agentId: "bernd",
          message: "hello with no provider",
          audience: "mcp",
          wait: true,
        });
      },
      (e: any) => e instanceof RpcError && e.error === "E_NOT_AVAILABLE",
    );
  });
});
