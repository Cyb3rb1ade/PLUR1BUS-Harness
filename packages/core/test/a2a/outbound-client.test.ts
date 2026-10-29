import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  A2A_PROTOCOL_VERSION,
  CancelTaskRequest,
  ListTasksRequest,
  StreamResponse,
  Task,
  TaskState,
  formatSSEEvent,
} from "@a2a-js/sdk";
import { createEgress, type EgressConfig } from "../../src/egress/index.ts";
import { createOutboundA2aClient } from "../../src/a2a/client.ts";

function createMockA2aServer(opts: {
  port?: number;
  expectedToken?: string;
  onTurn?: (msg: string) => { reply?: string; chunks?: string[] };
} = {}) {
  const tasks = new Map<string, any>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (opts.expectedToken) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${opts.expectedToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    if (req.method === "GET" && (url.pathname === "/.well-known/agent-card.json" || url.pathname.endsWith("/agent-card.json"))) {
      const host = req.headers.host ?? "127.0.0.1";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "Remote Mock Agent",
          description: "Mock agent for testing outbound client",
          version: "1.0.0",
          supportedInterfaces: [
            {
              url: `http://${host}/rpc`,
              protocolBinding: "JSONRPC",
              protocolVersion: A2A_PROTOCOL_VERSION,
            },
          ],
          capabilities: { streaming: true },
          skills: [],
          signatures: [],
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/rpc") {
      let bodyText = "";
      for await (const chunk of req) {
        bodyText += chunk.toString("utf8");
      }
      const rpc = JSON.parse(bodyText);

      if (rpc.method === "SendMessage") {
        const userText = rpc.params?.message?.parts?.[0]?.text ?? "";
        const taskId = `task-${Date.now()}`;
        const outcome = opts.onTurn?.(userText) ?? { reply: `Echo: ${userText}` };

        const task = {
          id: taskId,
          status: { state: TaskState.TASK_STATE_COMPLETED },
          artifacts: [
            {
              artifactId: `art-${taskId}`,
              name: "output",
              description: "",
              parts: [{ content: { $case: "text", value: outcome.reply ?? "" } }],
              metadata: undefined,
              extensions: [],
            },
          ],
          history: [],
          metadata: undefined,
        };
        tasks.set(taskId, task);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { task: Task.toJSON(task as any) },
          }),
        );
        return;
      }

      if (rpc.method === "SendStreamingMessage") {
        const userText = rpc.params?.message?.parts?.[0]?.text ?? "";
        const taskId = `task-stream-${Date.now()}`;
        const outcome = opts.onTurn?.(userText) ?? {
          chunks: ["chunk-1", "chunk-2"],
        };

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const sendEvent = (event: any) => {
          res.write(
            formatSSEEvent({
              jsonrpc: "2.0",
              id: rpc.id,
              result: StreamResponse.toJSON(event),
            }),
          );
        };

        // 1. Task event
        const initialTask = {
          id: taskId,
          status: { state: TaskState.TASK_STATE_WORKING },
          artifacts: [],
          history: [],
          metadata: undefined,
        };
        sendEvent({ payload: { $case: "task", value: initialTask } });

        // 2. Chunks
        const chunks = outcome.chunks ?? [outcome.reply ?? ""];
        for (let i = 0; i < chunks.length; i++) {
          sendEvent({
            payload: {
              $case: "artifactUpdate",
              value: {
                taskId,
                contextId: "",
                artifact: {
                  artifactId: `art-${taskId}`,
                  name: "output",
                  description: "",
                  parts: [{ content: { $case: "text", value: chunks[i] } }],
                  metadata: undefined,
                  extensions: [],
                },
                append: i > 0,
                lastChunk: i === chunks.length - 1,
                metadata: undefined,
              },
            },
          });
        }

        // 3. Completed status
        sendEvent({
          payload: {
            $case: "statusUpdate",
            value: {
              taskId,
              contextId: "",
              status: { state: TaskState.TASK_STATE_COMPLETED },
              metadata: undefined,
            },
          },
        });

        res.end();
        return;
      }

      if (rpc.method === "CancelTask") {
        const taskId = rpc.params?.id;
        const task = tasks.get(taskId) ?? { id: taskId };
        task.status = { state: TaskState.TASK_STATE_CANCELED };
        tasks.set(taskId, task);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: Task.toJSON(task as any),
          }),
        );
        return;
      }

      if (rpc.method === "ListTasks") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              tasks: Array.from(tasks.values()).map((t) => Task.toJSON(t as any)),
              totalSize: tasks.size,
              pageSize: 50,
            },
          }),
        );
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise<{ url: string; port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        close: () => new Promise((resClose) => server.close(() => resClose())),
      });
    });
  });
}

test("M6A-A4.4: rejects targets not allowed by egress policy", async () => {
  const egressConfig: EgressConfig = {
    allowHosts: ["allowed.example.com"],
    allowPorts: [80, 443],
    allowLoopback: false,
  };
  const egress = createEgress({ config: () => egressConfig });

  await assert.rejects(
    createOutboundA2aClient({
      cardUrl: "http://127.0.0.1:9999/.well-known/agent-card.json",
      egress,
    }),
    /A2A egress denied/i,
  );
});

test("M6A-A4.4: rejects URLs with credentials or fragments", async () => {
  const egressConfig: EgressConfig = {
    allowHosts: ["127.0.0.1"],
    allowPorts: [80, 443],
    allowLoopback: true,
  };
  const egress = createEgress({ config: () => egressConfig });

  await assert.rejects(
    createOutboundA2aClient({
      cardUrl: "http://user:pass@127.0.0.1:8080/.well-known/agent-card.json",
      egress,
    }),
    /credentials and fragments are forbidden/i,
  );

  await assert.rejects(
    createOutboundA2aClient({
      cardUrl: "http://127.0.0.1:8080/.well-known/agent-card.json#frag",
      egress,
    }),
    /credentials and fragments are forbidden/i,
  );
});

test("M6A-A4.4: connects through egress to allowed host, sends message and receives task", async () => {
  const mockServer = await createMockA2aServer({
    expectedToken: "secret-a2a-token",
    onTurn: (msg) => ({ reply: `Outbound response to: ${msg}` }),
  });

  try {
    const egressConfig: EgressConfig = {
      allowHosts: ["127.0.0.1"],
      allowPorts: [mockServer.port],
      allowLoopback: true,
    };
    const egress = createEgress({ config: () => egressConfig });

    const client = await createOutboundA2aClient({
      cardUrl: `${mockServer.url}/.well-known/agent-card.json`,
      token: "secret-a2a-token",
      egress,
    });

    assert.equal(client.card.name, "Remote Mock Agent");

    // Send single message
    const task = await client.sendText("Hello remote agent");
    assert.ok(task.id);
    assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
    const content = task.artifacts?.[0]?.parts?.[0]?.content;
    assert.deepEqual(content, {
      $case: "text",
      value: "Outbound response to: Hello remote agent",
    });

    // List tasks
    const list = await client.listTasks(ListTasksRequest.fromJSON({}));
    assert.equal(list.tasks.length, 1);
    assert.equal(list.tasks[0]?.id, task.id);

    // Cancel task
    const canceled = await client.cancelTask(CancelTaskRequest.fromJSON({ id: task.id }));
    assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
  } finally {
    await mockServer.close();
  }
});

test("M6A-A4.4: streams SSE response through egress-gated outbound client", async () => {
  const mockServer = await createMockA2aServer({
    expectedToken: "stream-token",
    onTurn: () => ({ chunks: ["Part 1, ", "Part 2, ", "Part 3."] }),
  });

  try {
    const egressConfig: EgressConfig = {
      allowHosts: ["127.0.0.1"],
      allowPorts: [mockServer.port],
      allowLoopback: true,
    };
    const egress = createEgress({ config: () => egressConfig });

    const client = await createOutboundA2aClient({
      cardUrl: `${mockServer.url}/.well-known/agent-card.json`,
      token: "stream-token",
      egress,
    });

    const received: string[] = [];
    let isCompleted = false;

    for await (const event of client.sendTextStream("stream please")) {
      if (event.payload?.$case === "artifactUpdate") {
        const text = event.payload.value.artifact?.parts?.[0]?.content;
        if (text?.$case === "text") {
          received.push(text.value);
        }
      } else if (event.payload?.$case === "statusUpdate") {
        if (event.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED) {
          isCompleted = true;
        }
      }
    }

    assert.deepEqual(received, ["Part 1, ", "Part 2, ", "Part 3."]);
    assert.ok(isCompleted, "stream must emit completed state");
  } finally {
    await mockServer.close();
  }
});
