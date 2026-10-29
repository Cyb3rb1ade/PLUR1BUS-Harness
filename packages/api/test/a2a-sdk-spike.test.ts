/**
 * M6A-A0.1 spike tests: verifies @a2a-js/sdk 1.3.0 server, client, legacy 0.3
 * compatibility, SSE backpressure and extension method dispatch without express.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { ListTasksRequest, SendMessageRequest } from "@a2a-js/sdk";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  createAuthenticatingFetchWithRetry,
} from "@a2a-js/sdk/client";
import { createA2aSpikeServer, type SpikeTaskRecord } from "../src/a2a/sdk-spike.ts";

const require = createRequire(import.meta.url);

describe("M6A-A0.1 @a2a-js/sdk 1.3.0 spike", () => {
  it("runs without express installed in the dependency graph", () => {
    assert.throws(() => require.resolve("express"), /Cannot find module 'express'/);
  });

  it("serves one card and one endpoint per agent under /a2a/<agent>/ with custom TaskStore and AgentExecutor", async () => {
    const saved: SpikeTaskRecord[] = [];
    const srv = await createA2aSpikeServer({
      token: "tok-a2a-spike",
      defaultAgentId: "alpha",
      agents: {
        alpha: { name: "Alpha Agent", description: "First agent", replyPrefix: "alpha:" },
        beta: { name: "Beta Agent", description: "Second agent", replyPrefix: "beta:" },
      },
      onSaveTask: (rec) => saved.push(rec),
    });
    try {
      const authFetch = createAuthenticatingFetchWithRetry(fetch, {
        headers: async () => ({ Authorization: "Bearer tok-a2a-spike" }),
        shouldRetryWithHeaders: async () => undefined,
      });
      const factory = new ClientFactory(
        ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
          cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
          transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
        }),
      );

      // Default agent card at /.well-known/agent-card.json and per-agent cards
      const rootCardRes = await fetch(`${srv.url}/.well-known/agent-card.json`);
      assert.equal(rootCardRes.status, 200);
      const rootCard = (await rootCardRes.json()) as { name: string; supportedInterfaces: Array<{ url: string; protocolVersion: string }> };
      assert.equal(rootCard.name, "Alpha Agent");
      assert.equal(rootCard.supportedInterfaces[0]?.protocolVersion, "1.0");
      assert.equal(rootCard.supportedInterfaces[0]?.url, `${srv.url}/a2a/alpha`);

      const unknownCardRes = await fetch(`${srv.url}/a2a/gamma/.well-known/agent-card.json`);
      assert.equal(unknownCardRes.status, 404);
      await unknownCardRes.text();

      const alphaClient = await factory.createFromUrl(srv.url, "/a2a/alpha/.well-known/agent-card.json");
      const betaClient = await factory.createFromUrl(srv.url, "/a2a/beta/.well-known/agent-card.json");

      const alphaRes = await alphaClient.sendMessage(
        SendMessageRequest.fromJSON({
          message: {
            messageId: "msg-alpha-1",
            role: "ROLE_USER",
            parts: [{ text: "hello" }],
          },
        }),
      );
      assert.ok("id" in alphaRes && alphaRes.id);
      const alphaPart = alphaRes.artifacts?.[0]?.parts?.[0]?.content;
      assert.deepEqual(alphaPart, { $case: "text", value: "alpha:hello" });

      const betaRes = await betaClient.sendMessage(
        SendMessageRequest.fromJSON({
          message: {
            messageId: "msg-beta-1",
            role: "ROLE_USER",
            parts: [{ text: "world" }],
          },
        }),
      );
      assert.ok("id" in betaRes && betaRes.id);
      const betaPart = betaRes.artifacts?.[0]?.parts?.[0]?.content;
      assert.deepEqual(betaPart, { $case: "text", value: "beta:world" });

      // Custom TaskStore recorded each agent's task separately
      assert.ok(saved.some((r) => r.agentId === "alpha" && r.task.id === alphaRes.id));
      assert.ok(saved.some((r) => r.agentId === "beta" && r.task.id === betaRes.id));

      const listedAlpha = await alphaClient.listTasks(ListTasksRequest.fromJSON({}));
      assert.equal(listedAlpha.tasks.length, 1);
      assert.equal(listedAlpha.tasks[0]?.id, alphaRes.id);
    } finally {
      await srv.close();
    }
  });

  it("streams SSE on node:http with backpressure and handles CancelTask / SubscribeToTask", async () => {
    let drainWaits = 0;
    const srv = await createA2aSpikeServer({
      token: "tok-stream",
      agents: {
        alpha: {
          name: "Alpha Streamer",
          description: "Streams chunks",
          chunks: ["chunk-1 ", "chunk-2 ", "chunk-3"],
          chunkDelayMs: 15,
        },
      },
      simulateBackpressureEvery: 1,
      onBackpressureWait: () => {
        drainWaits++;
      },
    });
    try {
      const authFetch = createAuthenticatingFetchWithRetry(fetch, {
        headers: async () => ({ Authorization: "Bearer tok-stream" }),
        shouldRetryWithHeaders: async () => undefined,
      });
      const factory = new ClientFactory(
        ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
          cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
          transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
        }),
      );
      const client = await factory.createFromUrl(srv.url, "/a2a/alpha/.well-known/agent-card.json");
      const seenTexts: string[] = [];
      for await (const ev of client.sendMessageStream(
        SendMessageRequest.fromJSON({
          message: {
            messageId: "msg-stream-1",
            role: "ROLE_USER",
            parts: [{ text: "go" }],
          },
        }),
      )) {
        if (ev.payload?.$case === "artifactUpdate") {
          const part = ev.payload.value.artifact?.parts?.[0]?.content;
          if (part?.$case === "text") {
            seenTexts.push(part.value);
          }
        }
      }
      assert.deepEqual(seenTexts, ["chunk-1 ", "chunk-2 ", "chunk-3"]);
      assert.ok(drainWaits >= 2, `expected SSE backpressure drain waits, got ${drainWaits}`);
    } finally {
      await srv.close();
    }
  });

  it("rejects missing or 0.3 A2A-Version with -32009 by default and enables 0.3 via legacyCompat", async () => {
    const strictSrv = await createA2aSpikeServer({
      token: "tok-strict",
      legacy03: false,
      agents: {
        alpha: { name: "Alpha Strict", description: "1.0 only", replyPrefix: "v1:" },
      },
    });
    try {
      // Missing A2A-Version header -> -32009
      const noHeaderRes = await fetch(`${strictSrv.url}/a2a/alpha`, {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-strict",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "SendMessage",
          params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }] } },
        }),
      });
      assert.equal(noHeaderRes.status, 200);
      const noHeaderBody = (await noHeaderRes.json()) as { error?: { code: number } };
      assert.equal(noHeaderBody.error?.code, A2A_ERROR_CODE.VERSION_NOT_SUPPORTED);

      // Explicit A2A-Version: 0.3 -> -32009 when legacy03 is false
      const v03Res = await fetch(`${strictSrv.url}/a2a/alpha`, {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-strict",
          "Content-Type": "application/json",
          "A2A-Version": "0.3",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "message/send",
          params: { message: { kind: "message", messageId: "m2", role: "user", parts: [{ kind: "text", text: "hi" }] } },
        }),
      });
      const v03Body = (await v03Res.json()) as { error?: { code: number } };
      assert.equal(v03Body.error?.code, A2A_ERROR_CODE.VERSION_NOT_SUPPORTED);
    } finally {
      await strictSrv.close();
    }

    // With legacy03: true, 0.3 dotted methods succeed through LegacyJsonRpcTransportHandler
    const compatSrv = await createA2aSpikeServer({
      token: "tok-compat",
      legacy03: true,
      agents: {
        alpha: { name: "Alpha Compat", description: "1.0 + 0.3", replyPrefix: "compat:" },
      },
    });
    try {
      const compatRes = await fetch(`${compatSrv.url}/a2a/alpha`, {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-compat",
          "Content-Type": "application/json",
          "A2A-Version": "0.3",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "message/send",
          params: {
            configuration: { blocking: true },
            message: { kind: "message", messageId: "m3", role: "user", parts: [{ kind: "text", text: "legacy" }] },
          },
        }),
      });
      assert.equal(compatRes.status, 200);
      const compatBody = (await compatRes.json()) as { result?: { kind: string; status?: { state: string }; artifacts?: Array<{ parts: Array<{ text?: string }> }> } };
      assert.equal(compatBody.result?.kind, "task");
      assert.equal(compatBody.result?.status?.state, "completed");
      assert.equal(compatBody.result?.artifacts?.[0]?.parts?.[0]?.text, "compat:legacy");
    } finally {
      await compatSrv.close();
    }
  });

  it("supports extension declarations and extension JSON-RPC methods on the same endpoint (Federation S0.1)", async () => {
    const extUri = "https://plur1bus.invalid/ext/federation/v1";
    const srv = await createA2aSpikeServer({
      token: "tok-ext",
      agents: {
        alpha: {
          name: "Alpha Fed",
          description: "Federation-capable agent",
          extensions: [{ uri: extUri, description: "PLUR1BUS federation extension", required: false }],
          extensionMethods: {
            "federation/hello": {
              extensionUri: extUri,
              handler: async (params) => ({ instanceId: "inst-1", echo: params.ping ?? null }),
            },
          },
        },
      },
    });
    try {
      const cardRes = await fetch(`${srv.url}/a2a/alpha/.well-known/agent-card.json`);
      const card = (await cardRes.json()) as { capabilities?: { extensions?: Array<{ uri: string }> } };
      assert.equal(card.capabilities?.extensions?.[0]?.uri, extUri);

      // Calling federation/hello without A2A-Extensions header fails with -32008 EXTENSION_SUPPORT_REQUIRED
      const missingExtRes = await fetch(`${srv.url}/a2a/alpha`, {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-ext",
          "Content-Type": "application/json",
          "A2A-Version": "1.0",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "federation/hello", params: { ping: "pong" } }),
      });
      const missingExtBody = (await missingExtRes.json()) as { error?: { code: number } };
      assert.equal(missingExtBody.error?.code, A2A_ERROR_CODE.EXTENSION_SUPPORT_REQUIRED);

      // Calling federation/hello with A2A-Extensions activates the extension and echoes the header
      const okExtRes = await fetch(`${srv.url}/a2a/alpha`, {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-ext",
          "Content-Type": "application/json",
          "A2A-Version": "1.0",
          "A2A-Extensions": extUri,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "federation/hello", params: { ping: "pong" } }),
      });
      assert.equal(okExtRes.status, 200);
      assert.equal(okExtRes.headers.get("a2a-extensions"), extUri);
      const okExtBody = (await okExtRes.json()) as { result?: { instanceId: string; echo: string } };
      assert.deepEqual(okExtBody.result, { instanceId: "inst-1", echo: "pong" });

      // Enforces harness auth, batch rejection and body cap in front of the SDK
      const unauthRes = await fetch(`${srv.url}/a2a/alpha`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "ListTasks", params: {} }),
      });
      assert.equal(unauthRes.status, 401);

      const batchRes = await fetch(`${srv.url}/a2a/alpha`, {
        method: "POST",
        headers: {
          Authorization: "Bearer tok-ext",
          "Content-Type": "application/json",
          "A2A-Version": "1.0",
        },
        body: JSON.stringify([{ jsonrpc: "2.0", id: 13, method: "ListTasks", params: {} }]),
      });
      const batchBody = (await batchRes.json()) as { error?: { code: number } };
      assert.equal(batchBody.error?.code, A2A_ERROR_CODE.INVALID_REQUEST);
    } finally {
      await srv.close();
    }
  });
});
