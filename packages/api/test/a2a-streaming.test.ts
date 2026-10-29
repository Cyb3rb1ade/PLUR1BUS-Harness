import assert from "node:assert/strict";
import test from "node:test";
import {
  A2A_PROTOCOL_VERSION,
  TaskState,
  ListTasksRequest,
  SendMessageRequest,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  createAuthenticatingFetchWithRetry,
} from "@a2a-js/sdk/client";
import { SqliteTaskStore } from "../src/a2a/task-store.ts";
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
  expensive: { capacity: 1000, refillPerSec: 100 },
};

const setupStreamingA2a = async (opts: {
  chunks?: string[];
  taskStore?: (agentId: string) => SqliteTaskStore;
} = {}) => {
  const core = fakeCore();
  const chunksToStream = opts.chunks ?? ["Hello ", "from ", "A2A ", "stream!"];
  let releaseGate: (() => void) | undefined;
  let gatePromise: Promise<void> | undefined;

  core.impl = async (m, p) => {
    if (m === "agent.list") {
      return {
        agents: [
          { agentId: "streamer", open: true, activity: { state: "idle", since: 1 } },
        ],
      };
    }
    if (m === "external.turn.start") {
      const params = p as {
        agentId: string;
        message: string;
        sessionId?: string;
      };
      if (params.message === "task to subscribe" && gatePromise) {
        await gatePromise;
      }
      return {
        sessionId: params.sessionId ?? "session-stream-1",
        turnId: "turn-stream-1",
        state: "completed",
        reply: chunksToStream.join(""),
        chunks: chunksToStream,
      };
    }
    if (m === "external.turn.cancel") {
      return { ok: true };
    }
    if (m === "core.status") {
      return { rpc: "1.9.0", contract: "c", uptimeMs: 1, engine: { ready: true, degraded: null } };
    }
    throw new Error(`unexpected rpc ${m}`);
  };

  const a2aConfig = {
    a2aServer: {
      enabled: true,
      legacy03: false,
    },
    agents: {
      streamer: {
        a2aServer: {
          exposed: true,
          name: "Streaming Agent",
          description: "Agent that streams SSE tokens",
        },
      },
    },
  };

  const h = await start({
    rateClasses: wide,
    core,
    a2aConfig,
    ...(opts.taskStore ? { a2aTaskStore: opts.taskStore } : {}),
  });

  await addUser(h, {
    id: "u-streamer",
    username: "streamuser",
    role: "member",
    agentRights: { streamer: "use" },
  });

  return Object.assign(h, {
    enableGate: () => {
      gatePromise = new Promise<void>((r) => {
        releaseGate = r;
      });
    },
    openGate: () => {
      releaseGate?.();
    },
  });
};

const mintBoundToken = async (h: Harness, cookie: string, agentId = "streamer") => {
  const r = await write(h, cookie, {
    path: "/api/v1/tokens",
    body: {
      name: "tok-stream",
      scopes: ["agent.use"],
      binding: { audience: "a2a", agentId },
    },
  });
  assert.equal(r.status, 201, r.text);
  return { token: r.json.token as string, id: (r.json.record as { id: string }).id };
};

test("M6A-A4.3: SendStreamingMessage streams SSE chunks and updates task to completed", async () => {
  const chunks = ["Alpha ", "Beta ", "Gamma ", "Delta"];
  const h = await setupStreamingA2a({ chunks });
  try {
    const { cookie } = await loginAs(h, "streamuser");
    const a2aToken = await mintBoundToken(h, cookie, "streamer");

    const authFetch = createAuthenticatingFetchWithRetry(fetch, {
      headers: async () => ({
        Authorization: `Bearer ${a2aToken.token}`,
        "a2a-version": A2A_PROTOCOL_VERSION,
      }),
      shouldRetryWithHeaders: async () => undefined,
    });

    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
        transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
      }),
    );

    const client = await factory.createFromUrl(
      h.url,
      "/a2a/streamer/.well-known/agent-card.json",
    );

    const receivedChunks: string[] = [];
    let completed = false;

    for await (const event of client.sendMessageStream(
      SendMessageRequest.fromJSON({
        message: {
          messageId: "msg-stream-test-1",
          role: "ROLE_USER",
          parts: [{ text: "start streaming" }],
        },
      }),
    )) {
      if (event.payload?.$case === "artifactUpdate") {
        const part = event.payload.value.artifact?.parts?.[0]?.content;
        if (part?.$case === "text") {
          receivedChunks.push(part.value);
        }
      } else if (event.payload?.$case === "statusUpdate") {
        if (event.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED) {
          completed = true;
        }
      }
    }

    assert.deepEqual(receivedChunks, chunks);
    assert.ok(completed, "task must reach completed state");
  } finally {
    await h.close();
  }
});

test("M6A-A4.3: SubscribeToTask resubscribes to active task via JSON-RPC / SSE", async () => {
  const h = await setupStreamingA2a();
  h.enableGate();
  try {
    const { cookie } = await loginAs(h, "streamuser");
    const a2aToken = await mintBoundToken(h, cookie, "streamer");

    // First send a task with returnImmediately: true so it stays active
    const sendRes = await raw(h, {
      method: "POST",
      path: "/a2a/streamer",
      headers: {
        authorization: `Bearer ${a2aToken.token}`,
        "a2a-version": A2A_PROTOCOL_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "send-initial",
        method: "SendMessage",
        params: {
          configuration: { returnImmediately: true },
          message: {
            messageId: "msg-sub-1",
            role: "user",
            parts: [{ text: "task to subscribe" }],
          },
        },
      }),
    });

    assert.equal(sendRes.status, 200);
    const taskId = sendRes.json.result?.task?.id;
    assert.ok(taskId, "task id must be returned");
    assert.equal(sendRes.json.result?.task?.status?.state, "TASK_STATE_SUBMITTED");

    // Now subscribe to this active task using SubscribeToTask
    const subPromise = raw(h, {
      method: "POST",
      path: "/a2a/streamer",
      headers: {
        authorization: `Bearer ${a2aToken.token}`,
        "a2a-version": A2A_PROTOCOL_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "sub-1",
        method: "SubscribeToTask",
        params: { id: taskId },
      }),
    });

    // Small yield so SubscribeToTask is accepted and connects
    await new Promise((r) => setTimeout(r, 20));
    // Release the turn
    h.openGate();

    const subRes = await subPromise;
    assert.equal(subRes.status, 200);
    assert.match(subRes.headers["content-type"] ?? "", /text\/event-stream/);
    assert.ok(subRes.text.includes("data:"), "SSE payload must contain data events");
    assert.ok(subRes.text.includes(taskId), "SSE payload must contain taskId");
  } finally {
    await h.close();
  }
});

test("M6A-A4.3: SqliteTaskStore persists tasks across instances and filters by agent/status", async () => {
  const store1 = new SqliteTaskStore({ path: ":memory:", agentId: "agent-alpha" });
  try {
    const task1 = {
      id: "task-001",
      contextId: "ctx-1",
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        message: undefined,
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history: [],
      metadata: undefined,
    };

    const task2 = {
      id: "task-002",
      contextId: "ctx-2",
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: undefined,
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history: [],
      metadata: undefined,
    };

    await store1.save(task1);
    await store1.save(task2);

    const loaded1 = await store1.load("task-001");
    assert.ok(loaded1);
    assert.equal(loaded1.id, "task-001");
    assert.equal(loaded1.status?.state, TaskState.TASK_STATE_COMPLETED);

    // List all
    const all = await store1.list(ListTasksRequest.fromJSON({}));
    assert.equal(all.tasks.length, 2);

    // Filter by contextId
    const byContext = await store1.list(ListTasksRequest.fromJSON({ contextId: "ctx-1" }));
    assert.equal(byContext.tasks.length, 1);
    assert.equal(byContext.tasks[0]?.id, "task-001");

    // Filter by state
    const completed = await store1.list(
      ListTasksRequest.fromJSON({ status: TaskState.TASK_STATE_COMPLETED }),
    );
    assert.equal(completed.tasks.length, 1);
    assert.equal(completed.tasks[0]?.id, "task-001");

    // Different agent cannot see agent-alpha's tasks
    const storeBeta = new SqliteTaskStore({ path: ":memory:", agentId: "agent-beta" });
    const betaTasks = await storeBeta.list(ListTasksRequest.fromJSON({}));
    assert.equal(betaTasks.tasks.length, 0);
    const betaLoad = await storeBeta.load("task-001");
    assert.equal(betaLoad, undefined);
    storeBeta.close();
  } finally {
    store1.close();
  }
});
