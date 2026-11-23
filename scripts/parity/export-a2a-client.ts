import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createOutboundA2aClient } from "../../packages/core/src/a2a/client.ts";
import { A2aPeerClient } from "../../packages/core/src/a2a/peer-client.ts";
import { A2aPeerStore } from "../../packages/core/src/a2a/peer-store.ts";
import { memoryAuditSink } from "../../packages/core/src/rbac/audit.ts";
import { recordPeerCards } from "./export-a2a-protocol.ts";
import { exporterMain } from "./lib.mjs";

async function recordDelegation() {
  const { key, cases } = await recordPeerCards();
  const { card, kid, source } = cases[0]!;
  const directory = await mkdtemp(join(tmpdir(), "p4w-a2a-fixture-"));
  const store = new A2aPeerStore({ path: join(directory, "peers.sqlite"), now: () => 1 });
  const signal = new AbortController().signal;
  const audit = memoryAuditSink();
  let requestBody = "";
  const client = new A2aPeerClient({ store, audit, now: () => 1, enabled: () => true, signal,
    transport: {
      async confirmTrust() {},
      async request(_peer, request) {
        const reply = (body: string) => ({ status: 200, contentType: "application/json", body });
        if (request.purpose === "card") return reply(JSON.stringify(card));
        const operation = JSON.parse(request.body!);
        const messageId = operation.params.message.messageId;
        operation.id = "rpc-fixture";
        operation.params.message.messageId = "message-fixture";
        requestBody = JSON.stringify(operation);
        const id = JSON.parse(request.body!).id;
        return reply(JSON.stringify({ jsonrpc: "2.0", id, result: { message: {
          messageId, role: "ROLE_AGENT", parts: [{ text: "Antwort 🌱" }],
        } } }));
      },
    },
  });
  const owner = { kind: "person", role: "owner", userId: "owner" } as const;
  const execution = { person: "owner", agent: "origin-agent", session: "session", turn: "turn", project: "", surface: 3 as const, policy: {} };
  const question = "Which book should we index?";
  const context = "A small fixture catalog.";
  try {
    const registration = client.add(owner, { id: "sample", cardUrl: source, kid, publicKey: key });
    await client.trust(owner, registration, execution, signal);
    const result = await client.target.run({ agentId: "a2a:sample", question, context, signal,
      principal: owner, origin: { fromAgent: execution.agent, traceId: "trace", spanId: "span" }, outbound: execution });
    if (!requestBody) throw new Error("fixture did not record the production peer envelope");
    return { requestBodyBase64: Buffer.from(requestBody).toString("base64"), answer: result.text };
  } finally {
    client.close();
    store.close();
    await rm(directory, { recursive: true });
  }
}

export async function recordA2aClient() {
  const requireCore = createRequire(new URL("../../packages/core/package.json", import.meta.url));
  const sdk = await import(requireCore.resolve("@a2a-js/sdk"));
  const cases: unknown[] = [];
  const replies = new Map<string, unknown>();
  const task = { id: "task-example", contextId: "context-example", status: { state: "TASK_STATE_COMPLETED" },
    artifacts: [{ artifactId: "artifact-example", parts: [{ text: "Antwort 🌱" }] }] };
  const working = { ...task, status: { state: "TASK_STATE_WORKING" }, artifacts: [] };
  const push = { taskId: task.id, id: "push-example", url: "https://notifications.example.invalid/report" };
  const stream = [
    { task: working },
    { artifactUpdate: { taskId: task.id, contextId: task.contextId, artifact: task.artifacts[0], lastChunk: true } },
    { statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status } },
  ];
  replies.set("SendMessage", { task });
  replies.set("GetTask", task);
  replies.set("CancelTask", { ...task, status: { state: "TASK_STATE_CANCELED" } });
  replies.set("ListTasks", { tasks: [task], totalSize: 1, pageSize: 50 });
  replies.set("CreateTaskPushNotificationConfig", push);
  replies.set("GetTaskPushNotificationConfig", push);
  replies.set("ListTaskPushNotificationConfigs", { configs: [push] });
  replies.set("DeleteTaskPushNotificationConfig", {});
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
        const body = { name: "Fixture", version: "1.0", capabilities: { streaming: true, pushNotifications: true },
          supportedInterfaces: [{ url: `http://${req.headers.host}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      const incoming = [];
      for await (const chunk of req) incoming.push(Buffer.from(chunk));
      const body = Buffer.concat(incoming).toString("utf8");
      const rpc = JSON.parse(body);
      if (req.method !== "POST" || req.url !== "/rpc" || req.headers.authorization !== "Bearer fixture-a2a") {
        res.writeHead(400).end();
        return;
      }
      const streaming = ["SendStreamingMessage", "SubscribeToTask"].includes(rpc.method);
      const contentType = streaming ? "text/event-stream" : "application/json";
      const result = replies.get(rpc.method);
      if (!streaming && !result) throw new Error("unexpected RPC method");
      const frame = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
      const response = (id: unknown): string[] => streaming
        ? stream.map(item => sdk.formatSSEEvent(frame(id, item)))
        : [JSON.stringify(frame(id, result))];
      const stableId = "rpc-fixture";
      if (JSON.stringify(rpc) !== body) throw new Error("unexpected RPC JSON encoding");
      const normalized = JSON.stringify({ ...rpc, id: stableId });
      const selected = ["accept", "content-type", "a2a-version"];
      const headers = Object.fromEntries(selected.filter(k => req.headers[k] !== undefined).map(k => [k, req.headers[k]]));
      cases.push({ method: rpc.method, request: { path: req.url, bodyBase64: Buffer.from(normalized).toString("base64"), headers },
        response: { contentType, chunksBase64: response(stableId).map(text => Buffer.from(text).toString("base64")) } });
      res.writeHead(200, { "content-type": contentType });
      for (const item of response(rpc.id)) res.write(item);
      res.end();
    } catch { res.writeHead(500).end(); }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const cardUrl = `http://127.0.0.1:${port}/.well-known/agent-card.json`;
    const client = await createOutboundA2aClient({ cardUrl, token: "fixture-a2a",
      egress: { async decide() { return { allowed: true, address: "127.0.0.1", family: 4, host: "127.0.0.1", port }; } },
      legacy03: false,
    });
    const message = { messageId: "message-example", taskId: task.id, contextId: task.contextId };
    await client.sendText("Grüße 🌱", message);
    await client.getTask(sdk.GetTaskRequest.fromJSON({ id: task.id, historyLength: 2 }));
    await client.listTasks(sdk.ListTasksRequest.fromJSON({ pageSize: 50 }));
    for await (const _ of client.sendTextStream("Grüße 🌱", message)) { /* capture the complete exchange */ }
    for await (const _ of client.resubscribeTask(sdk.SubscribeToTaskRequest.fromJSON({ id: task.id }))) { /* capture */ }
    await client.client.createTaskPushNotificationConfig(sdk.TaskPushNotificationConfig.fromJSON(push));
    await client.client.getTaskPushNotificationConfig(sdk.GetTaskPushNotificationConfigRequest.fromJSON({ taskId: task.id, id: push.id }));
    await client.client.listTaskPushNotificationConfig(sdk.ListTaskPushNotificationConfigsRequest.fromJSON({ taskId: task.id }));
    await client.client.deleteTaskPushNotificationConfig(sdk.DeleteTaskPushNotificationConfigRequest.fromJSON({ taskId: task.id, id: push.id }));
    await client.cancelTask(sdk.CancelTaskRequest.fromJSON({ id: task.id }));
    return { client: { source: "packages/core/src/a2a/client.ts", cases, delegation: await recordDelegation() } };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "a2a", build: recordA2aClient });
}
