import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AgentCard,
  Extensions,
  HTTP_EXTENSION_HEADER,
} from "@a2a-js/sdk";
import {
  A2A_LEGACY_PROTOCOL_VERSION,
  LEGACY_HTTP_EXTENSION_HEADER,
} from "@a2a-js/sdk/compat/v0_3";
import { A2A_ERROR_CODE, RequestMalformedError } from "@a2a-js/sdk/errors";
import { JsonRpcTransportHandler, ServerCallContext } from "@a2a-js/sdk/server";
import { ApiError, errors } from "../errors.ts";
import type { HandlerDeps, HandlerInput, HandlerOutput, RouteSpec } from "../routes.ts";
import {
  isAgentA2aExposed,
  isLegacy03Enabled,
  type A2aServerConfigLike,
} from "./activation.ts";
import { A2aServerCore, buildAgentCard, InMemoryTaskStore } from "./server.ts";
import { signAgentCard } from "./card.ts";
import { A2A_MAX_BODY_BYTES } from "./types.ts";
import type { TaskStore } from "@a2a-js/sdk/server";

export interface A2aHandlerDeps extends HandlerDeps {
  a2aConfig?:
    | A2aServerConfigLike
    | (() => Promise<A2aServerConfigLike | undefined> | A2aServerConfigLike | undefined)
    | undefined;
  taskStore?: ((agentId: string) => TaskStore) | undefined;
}

export const A2A_ROUTES: readonly RouteSpec[] = [
  {
    id: "a2a.card.root",
    method: "GET",
    path: "/.well-known/agent-card.json",
    tag: "a2a",
    summary: "A2A 1.0 Agent Card for the default agent",
    auth: "none",
    authz: "public",
    csrf: false,
    rate: "read",
    stability: "experimental",
    since: "1.0.0",
    successStatus: 200,
    success: {
      description: "A2A Agent Card document",
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    id: "a2a.card.root.alias",
    method: "GET",
    path: "/.well-known/agent.json",
    tag: "a2a",
    summary: "A2A 1.0 Agent Card for the default agent (alias)",
    auth: "none",
    authz: "public",
    csrf: false,
    rate: "read",
    stability: "experimental",
    since: "1.0.0",
    successStatus: 200,
    success: {
      description: "A2A Agent Card document",
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    id: "a2a.card.agent",
    method: "GET",
    path: "/a2a/{agentId}/.well-known/agent-card.json",
    tag: "a2a",
    summary: "A2A 1.0 Agent Card for a specific agent",
    auth: "none",
    authz: "public",
    csrf: false,
    rate: "read",
    stability: "experimental",
    since: "1.0.0",
    successStatus: 200,
    success: {
      description: "A2A Agent Card document",
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    id: "a2a.card.agent.alias",
    method: "GET",
    path: "/a2a/{agentId}/.well-known/agent.json",
    tag: "a2a",
    summary: "A2A 1.0 Agent Card for a specific agent (alias)",
    auth: "none",
    authz: "public",
    csrf: false,
    rate: "read",
    stability: "experimental",
    since: "1.0.0",
    successStatus: 200,
    success: {
      description: "A2A Agent Card document",
      schema: { type: "object", additionalProperties: true },
    },
  },
  {
    id: "a2a.endpoint",
    method: "POST",
    path: "/a2a/{agentId}",
    tag: "a2a",
    summary: "A2A 1.0 JSON-RPC endpoint per exposed agent",
    auth: "any",
    authz: "delegated",
    csrf: false,
    rate: "rpc",
    transport: "protocol",
    protocol: {
      audience: "a2a",
      maxBodyBytes: A2A_MAX_BODY_BYTES,
      bodyTimeoutMs: 10_000,
      handlerTimeoutMs: 60_000,
    },
    stability: "experimental",
    since: "1.0.0",
    successStatus: 200,
    success: {
      description: "A2A JSON-RPC response or SSE event stream",
      schema: { type: "object", additionalProperties: true },
    },
  },
];

export function buildA2aHandlers(
  d: A2aHandlerDeps,
): Record<string, (i: HandlerInput) => Promise<HandlerOutput>> {
  const serverCores = new Map<string, A2aServerCore>();
  const taskStores = new Map<string, TaskStore>();

  const getTaskStore = (agentId: string): TaskStore => {
    let store = taskStores.get(agentId);
    if (!store) {
      store = new InMemoryTaskStore(agentId);
      taskStores.set(agentId, store);
    }
    return store;
  };

  const getServerCore = (agentId: string, create: () => A2aServerCore): A2aServerCore => {
    let server = serverCores.get(agentId);
    if (!server) {
      server = create();
      serverCores.set(agentId, server);
    }
    return server;
  };

  const serveCard = async (
    agentId: string | undefined,
    i: HandlerInput,
  ): Promise<HandlerOutput> => {
    const a2aConfig =
      typeof d.a2aConfig === "function" ? await d.a2aConfig() : d.a2aConfig;

    let targetAgentId = agentId;
    if (!targetAgentId) {
      targetAgentId = a2aConfig?.a2aServer?.defaultAgentId;
      if (!targetAgentId) {
        if (isAgentA2aExposed(a2aConfig, "default")) {
          targetAgentId = "default";
        } else {
          const exposed = Object.entries(a2aConfig?.agents ?? {}).find(
            ([, a]) => a.a2aServer?.exposed === true,
          );
          if (exposed) {
            targetAgentId = exposed[0];
          }
        }
      }
    }

    if (!targetAgentId || !isAgentA2aExposed(a2aConfig, targetAgentId)) {
      throw new ApiError(404, "E_NOT_FOUND", "Agent card not found or not exposed over A2A", {
        reason: "agent",
      });
    }

    const reqHeaders = i.headers ?? {};
    const host = (reqHeaders["host"] as string | undefined) || "127.0.0.1";
    const scheme = d.tls ? "https" : "http";
    const baseUrl = `${scheme}://${host}`;

    const agentCfg = a2aConfig?.agents?.[targetAgentId]?.a2aServer;
    let card = buildAgentCard(baseUrl, targetAgentId, {
      name: agentCfg?.name,
      description: agentCfg?.description,
      legacy03: isLegacy03Enabled(a2aConfig),
    });

    if (a2aConfig?.a2aServer?.signingKey?.privateKeyPem) {
      card = await signAgentCard(card, a2aConfig.a2aServer.signingKey.privateKeyPem, {
        kid: a2aConfig.a2aServer.signingKey.kid ?? "default",
      });
    }

    return {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
      },
      body: AgentCard.toJSON(card) as Record<string, unknown>,
    };
  };

  return {
    "a2a.card.root": async (i: HandlerInput): Promise<HandlerOutput> => {
      return serveCard(undefined, i);
    },
    "a2a.card.root.alias": async (i: HandlerInput): Promise<HandlerOutput> => {
      return serveCard(undefined, i);
    },
    "a2a.card.agent": async (i: HandlerInput): Promise<HandlerOutput> => {
      return serveCard(i.pathParams?.agentId, i);
    },
    "a2a.card.agent.alias": async (i: HandlerInput): Promise<HandlerOutput> => {
      return serveCard(i.pathParams?.agentId, i);
    },
    "a2a.endpoint": async (i: HandlerInput): Promise<HandlerOutput> => {
      if (!i.tokenRecord || !i.tokenRecord.binding) {
        throw errors.unauthenticated("authentication required");
      }
      const binding = i.tokenRecord.binding;
      if (binding.audience !== "a2a") {
        throw errors.forbidden("token-audience-mismatch");
      }

      const agentId = i.pathParams?.agentId;
      if (!agentId || binding.agentId !== agentId) {
        throw errors.forbidden("token-agent-mismatch");
      }

      const tokenId = i.tokenRecord.id;
      const actor = i.principal?.id ?? tokenId;

      // Check agent exposure
      const a2aConfig =
        typeof d.a2aConfig === "function" ? await d.a2aConfig() : d.a2aConfig;
      if (!isAgentA2aExposed(a2aConfig, agentId)) {
        d.audit.emit("a2a.server.denied", actor, `agent:${agentId}`, {
          tokenId,
          method: "-",
          agentId,
          reason: "agent-not-exposed",
        });
        throw errors.forbidden("agent-not-exposed", "Agent is not exposed over A2A");
      }

      // Parse JSON-RPC request body
      let rpcBody: unknown;
      if (i.rawBody && i.rawBody.length > 0) {
        try {
          rpcBody = JSON.parse(i.rawBody.toString("utf8"));
        } catch {
          const rpcErr = JsonRpcTransportHandler.mapToJSONRPCError(
            new RequestMalformedError("Invalid JSON payload"),
          );
          return {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: { jsonrpc: "2.0", id: null, error: rpcErr },
          };
        }
      } else {
        const rpcErr = JsonRpcTransportHandler.mapToJSONRPCError(
          new RequestMalformedError("Missing request body"),
        );
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: { jsonrpc: "2.0", id: null, error: rpcErr },
        };
      }

      // Reject JSON-RPC batch requests
      if (Array.isArray(rpcBody) || typeof rpcBody !== "object" || rpcBody === null) {
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: A2A_ERROR_CODE.INVALID_REQUEST,
              message: "JSON-RPC batch requests are not supported",
            },
          },
        };
      }

      const parsedRpc = rpcBody as {
        jsonrpc?: unknown;
        id?: string | number | null;
        method?: unknown;
        params?: unknown;
      };

      const methodName = typeof parsedRpc.method === "string" ? parsedRpc.method : "-";
      d.audit.emit("a2a.server.call", actor, `agent:${agentId}`, {
        tokenId,
        method: methodName,
        agentId,
      });

      // Construct call context
      const reqHeaders = i.headers ?? {};
      const versionHeaderRaw = reqHeaders[A2A_VERSION_HEADER.toLowerCase()];
      const versionHeader = Array.isArray(versionHeaderRaw)
        ? versionHeaderRaw[0]
        : versionHeaderRaw;
      const extHeaderRaw =
        reqHeaders[HTTP_EXTENSION_HEADER.toLowerCase()] ??
        reqHeaders[LEGACY_HTTP_EXTENSION_HEADER.toLowerCase()];
      const extHeader = Array.isArray(extHeaderRaw) ? extHeaderRaw.join(",") : extHeaderRaw;

      const callContext = new ServerCallContext({
        requestedExtensions: Extensions.parseServiceParameter(extHeader),
        ...(versionHeader !== undefined ? { requestedVersion: versionHeader } : {}),
      });

      const host = (reqHeaders["host"] as string | undefined) || "127.0.0.1";
      const scheme = d.tls ? "https" : "http";
      const baseUrl = `${scheme}://${host}`;
      const legacy03 = isLegacy03Enabled(a2aConfig);

      const taskStore = d.taskStore?.(agentId) ?? getTaskStore(agentId);
      const serverCore = getServerCore(
        agentId,
        () =>
          new A2aServerCore({
            agentId,
            tokenId,
            baseUrl,
            core: d.core,
            legacy03,
            taskStore,
          }),
      );
      serverCore.executor.setTokenId(tokenId);

      let resultOrStream: unknown;
      try {
        resultOrStream = await serverCore.handleRpc(parsedRpc, callContext);
      } catch (err) {
        const rpcErr = JsonRpcTransportHandler.mapToJSONRPCError(err);
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: { jsonrpc: "2.0", id: parsedRpc.id ?? null, error: rpcErr },
        };
      }

      // Check for streaming response (e.g. tasks/sendSubscribe)
      if (
        resultOrStream &&
        typeof resultOrStream === "object" &&
        Symbol.asyncIterator in resultOrStream
      ) {
        const useLegacy =
          legacy03 &&
          (callContext.requestedVersion === A2A_LEGACY_PROTOCOL_VERSION ||
            callContext.requestedVersion === "0.3.0");
        await serverCore.streamToResponse(
          i.res!,
          parsedRpc.id ?? null,
          resultOrStream as AsyncGenerator<unknown, void, undefined>,
          callContext,
          useLegacy,
        );
        return { streamed: true };
      }

      const resHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (callContext.activatedExtensions?.length) {
        const extHeaderName = legacy03 ? LEGACY_HTTP_EXTENSION_HEADER : HTTP_EXTENSION_HEADER;
        resHeaders[extHeaderName] = Extensions.toServiceParameter(callContext.activatedExtensions);
      }

      return {
        status: 200,
        headers: resHeaders,
        body: resultOrStream as Record<string, unknown>,
      };
    },
  };
}
