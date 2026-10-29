import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  Extensions,
  HTTP_EXTENSION_HEADER,
  Role,
  SSE_HEADERS,
  TaskState,
  formatSSEErrorEvent,
  formatSSEEvent,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type Task,
} from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";
import {
  A2A_LEGACY_PROTOCOL_VERSION,
  LEGACY_HTTP_EXTENSION_HEADER,
  duplicateInterfacesForLegacy,
} from "@a2a-js/sdk/compat/v0_3";
import { LegacyJsonRpcTransportHandler } from "@a2a-js/sdk/compat/v0_3/server";
import {
  AgentEvent,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from "@a2a-js/sdk/server";
import type { ServerResponse } from "node:http";
import { once } from "node:events";
import { A2A_DEFAULT_PAGE_SIZE } from "./types.ts";
import { InMemoryTaskStore, SqliteTaskStore } from "./task-store.ts";

export interface CoreLike {
  call<T = unknown>(method: string, params: unknown): Promise<T>;
}

export { InMemoryTaskStore, SqliteTaskStore };

export interface A2aAgentExecutorOptions {
  agentId: string;
  tokenId: string;
  core: CoreLike;
}

function createErrorMessage(taskId: string, contextId: string, errorText: string): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [
      {
        content: { $case: "text", value: errorText },
        filename: "",
        mediaType: "text/plain",
        metadata: undefined,
      },
    ],
    extensions: [],
    referenceTaskIds: [],
    metadata: undefined,
  };
}

export class A2aAgentExecutor implements AgentExecutor {
  private readonly agentId: string;
  private tokenId: string;
  private readonly core: CoreLike;
  private readonly taskContexts = new Map<string, string>();

  constructor(opts: A2aAgentExecutorOptions) {
    this.agentId = opts.agentId;
    this.tokenId = opts.tokenId;
    this.core = opts.core;
  }

  setTokenId(tokenId: string): void {
    this.tokenId = tokenId;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext;
    if (contextId) {
      this.taskContexts.set(taskId, contextId);
    }

    const now = new Date().toISOString();
    const initialTask: Task = task ?? {
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: now,
      },
      artifacts: [],
      history: [userMessage],
      metadata: undefined,
    };

    eventBus.publish(AgentEvent.task(initialTask));
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );

    const inputText =
      userMessage.parts
        .map((p) => {
          if (p.content?.$case === "text") return p.content.value;
          if (typeof (p as unknown as { text?: unknown }).text === "string") {
            return (p as unknown as { text: string }).text;
          }
          return "";
        })
        .join("") || "";

    try {
      const result = await this.core.call<{
        sessionId: string;
        turnId: string;
        state: "completed" | "failed";
        reply?: string;
        chunks?: string[];
        error?: string;
      }>("external.turn.start", {
        agentId: this.agentId,
        sessionId: contextId || taskId,
        message: inputText,
        audience: "a2a",
        tokenId: this.tokenId,
        wait: true,
      });

      if (result.state === "completed") {
        const chunks =
          result.chunks && result.chunks.length > 0
            ? result.chunks
            : [result.reply ?? ""];

        for (let i = 0; i < chunks.length; i++) {
          eventBus.publish(
            AgentEvent.artifactUpdate({
              taskId,
              contextId,
              artifact: {
                artifactId: `art-${taskId}`,
                name: "output",
                description: "Agent turn output",
                parts: [
                  {
                    content: { $case: "text", value: chunks[i] ?? "" },
                    metadata: undefined,
                    filename: "",
                    mediaType: "text/plain",
                  },
                ],
                metadata: undefined,
                extensions: [],
              },
              append: i > 0,
              lastChunk: i === chunks.length - 1,
              metadata: undefined,
            }),
          );
        }

        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_COMPLETED,
              message: undefined,
              timestamp: new Date().toISOString(),
            },
            metadata: undefined,
          }),
        );
      } else {
        const isCancelled = result.error === "cancelled";
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state: isCancelled ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED,
              message: result.error ? createErrorMessage(taskId, contextId, result.error) : undefined,
              timestamp: new Date().toISOString(),
            },
            metadata: undefined,
          }),
        );
      }
    } catch (err: unknown) {
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_FAILED,
            message: createErrorMessage(
              taskId,
              contextId,
              err instanceof Error ? err.message : String(err),
            ),
            timestamp: new Date().toISOString(),
          },
          metadata: undefined,
        }),
      );
    } finally {
      eventBus.finished();
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const sessionId = this.taskContexts.get(taskId) || taskId;
    try {
      await this.core.call("external.turn.cancel", {
        sessionId,
        agentId: this.agentId,
        audience: "a2a",
        tokenId: this.tokenId,
      });
    } catch {
      // ignore cancel error if turn already terminated
    }

    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: sessionId,
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
    eventBus.finished();
  }
}

export function buildAgentCard(
  baseUrl: string,
  agentId: string,
  opts: { name?: string | undefined; description?: string | undefined; legacy03?: boolean } = {},
): AgentCard {
  const endpointUrl = `${baseUrl}/a2a/${encodeURIComponent(agentId)}`;
  const name = opts.name || `Agent ${agentId}`;
  const description = opts.description || `PLUR1BUS Agent ${agentId}`;

  const baseCard: AgentCard = {
    name,
    description,
    version: "1.0.0",
    supportedInterfaces: [
      {
        url: endpointUrl,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: "",
      },
    ],
    provider: {
      organization: "PLUR1BUS",
      url: baseUrl,
    },
    documentationUrl: "",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [],
    },
    securitySchemes: {
      bearerAuth: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            scheme: "Bearer",
            bearerFormat: "opaque",
            description: "Agent-bound token",
          },
        },
      },
    },
    securityRequirements: [
      {
        schemes: {
          bearerAuth: { list: [] },
        },
      },
    ],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: `${agentId}.default`,
        name,
        description,
        tags: ["a2a"],
        examples: [],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
        securityRequirements: [],
      },
    ],
    signatures: [],
    iconUrl: "",
  };

  if (opts.legacy03) {
    baseCard.supportedInterfaces = duplicateInterfacesForLegacy(
      baseCard.supportedInterfaces,
      ["JSONRPC"],
    );
  }

  return baseCard;
}

export interface A2aServerCoreOptions {
  agentId: string;
  tokenId: string;
  baseUrl: string;
  core: CoreLike;
  legacy03?: boolean;
  name?: string;
  description?: string;
  taskStore?: TaskStore;
}

export class A2aServerCore {
  readonly card: AgentCard;
  readonly taskStore: TaskStore;
  readonly executor: A2aAgentExecutor;
  readonly requestHandler: DefaultRequestHandler;
  readonly v1Transport: JsonRpcTransportHandler;
  readonly legacyTransport: LegacyJsonRpcTransportHandler;
  readonly legacy03: boolean;

  constructor(opts: A2aServerCoreOptions) {
    this.legacy03 = opts.legacy03 ?? false;
    this.card = buildAgentCard(opts.baseUrl, opts.agentId, {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      legacy03: this.legacy03,
    });
    this.taskStore = opts.taskStore ?? new InMemoryTaskStore(opts.agentId);
    this.executor = new A2aAgentExecutor({
      agentId: opts.agentId,
      tokenId: opts.tokenId,
      core: opts.core,
    });
    this.requestHandler = new DefaultRequestHandler(this.card, this.taskStore, this.executor);
    this.v1Transport = new JsonRpcTransportHandler(this.requestHandler);
    this.legacyTransport = new LegacyJsonRpcTransportHandler(this.requestHandler);
  }

  async handleRpc(
    rpcBody: string | Record<string, unknown>,
    callContext: ServerCallContext,
  ): Promise<unknown> {
    validateVersion(callContext.requestedVersion, this.card, "JSONRPC");

    const useLegacy =
      this.legacy03 &&
      (callContext.requestedVersion === A2A_LEGACY_PROTOCOL_VERSION ||
        callContext.requestedVersion === "0.3.0");

    const transport = useLegacy ? this.legacyTransport : this.v1Transport;
    return transport.handle(rpcBody, callContext);
  }

  async streamToResponse(
    res: ServerResponse,
    rpcId: string | number | null,
    stream: AsyncGenerator<unknown, void, undefined>,
    callContext: ServerCallContext,
    useLegacy: boolean,
  ): Promise<void> {
    let firstItem: IteratorResult<unknown, void>;
    try {
      firstItem = await stream.next();
    } catch (err) {
      const rpcErr = JsonRpcTransportHandler.mapToJSONRPCError(err);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, error: rpcErr }));
      return;
    }

    const sseHeaders: Record<string, string> = { ...SSE_HEADERS };
    if (callContext.activatedExtensions?.length) {
      const extHeaderName = useLegacy ? LEGACY_HTTP_EXTENSION_HEADER : HTTP_EXTENSION_HEADER;
      sseHeaders[extHeaderName] = Extensions.toServiceParameter(callContext.activatedExtensions);
    }
    res.writeHead(200, sseHeaders);

    let closed = false;
    const onClose = (): void => {
      closed = true;
      try { void stream.return?.(); } catch {}
    };
    res.on("close", onClose);

    try {
      if (!firstItem.done && !closed && !res.destroyed) {
        const ok = res.write(formatSSEEvent(firstItem.value));
        if (!ok && !closed && !res.destroyed) {
          await Promise.race([once(res, "drain"), once(res, "close")]);
        }
      }
      for await (const item of stream) {
        if (closed || res.destroyed || res.writableEnded) break;
        const ok = res.write(formatSSEEvent(item));
        if (!ok && !closed && !res.destroyed) {
          await Promise.race([once(res, "drain"), once(res, "close")]);
        }
      }
    } catch (err) {
      if (!closed && !res.destroyed) {
        const rpcErr = JsonRpcTransportHandler.mapToJSONRPCError(err);
        res.write(formatSSEErrorEvent({ jsonrpc: "2.0", id: rpcId, error: rpcErr }));
      }
    } finally {
      res.removeListener("close", onClose);
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    }
  }
}
