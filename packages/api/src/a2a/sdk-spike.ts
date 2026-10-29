/**
 * M6A-A0.1 spike: evaluates @a2a-js/sdk 1.3.0 server, client, 0.3 legacy compat
 * and extension method pre-dispatch on a single node:http server without express.
 */
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  AgentCard,
  Extensions,
  HTTP_EXTENSION_HEADER,
  SSE_HEADERS,
  TaskState,
  formatSSEErrorEvent,
  formatSSEEvent,
  type AgentExtension,
  type ListTasksRequest,
  type ListTasksResponse,
  type Task,
} from "@a2a-js/sdk";
import {
  A2A_LEGACY_PROTOCOL_VERSION,
  LEGACY_HTTP_EXTENSION_HEADER,
  duplicateInterfacesForLegacy,
} from "@a2a-js/sdk/compat/v0_3";
import { LegacyJsonRpcTransportHandler } from "@a2a-js/sdk/compat/v0_3/server";
import {
  A2A_ERROR_CODE,
  ExtensionSupportRequiredError,
  RequestMalformedError,
} from "@a2a-js/sdk/errors";
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

/** Maximum request body size in bytes for the spike server. */
const SPIKE_MAX_BODY_BYTES = 64 * 1024;
/** Default page size for ListTasks responses. */
const SPIKE_DEFAULT_PAGE_SIZE = 50;

/** Definition of an A2A extension JSON-RPC method on the spike server. */
export interface SpikeExtensionMethodDef {
  extensionUri: string;
  handler: (params: Record<string, unknown>, context: ServerCallContext) => Promise<unknown>;
}

/** Per-agent configuration for the A2A SDK spike server. */
export interface SpikeAgentConfig {
  name: string;
  description: string;
  replyPrefix?: string;
  chunks?: string[];
  chunkDelayMs?: number;
  extensions?: Array<{ uri: string; description?: string; required?: boolean }>;
  extensionMethods?: Record<string, SpikeExtensionMethodDef>;
}

/** Task record captured by the custom TaskStore hook. */
export interface SpikeTaskRecord {
  agentId: string;
  task: Task;
}

/** Options for starting the A2A SDK spike server. */
export interface CreateA2aSpikeServerOptions {
  token: string;
  defaultAgentId?: string;
  legacy03?: boolean;
  agents: Record<string, SpikeAgentConfig>;
  onSaveTask?: (record: SpikeTaskRecord) => void;
  simulateBackpressureEvery?: number;
  onBackpressureWait?: () => void;
}

/** Running A2A SDK spike server handle. */
export interface A2aSpikeServerHandle {
  url: string;
  close: () => Promise<void>;
}

class InMemoryAgentTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();
  private readonly agentId: string;
  private readonly onSaveTask: ((record: SpikeTaskRecord) => void) | undefined;

  constructor(agentId: string, onSaveTask?: (record: SpikeTaskRecord) => void) {
    this.agentId = agentId;
    this.onSaveTask = onSaveTask;
  }

  async save(task: Task): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
    this.onSaveTask?.({ agentId: this.agentId, task: structuredClone(task) });
  }

  async load(taskId: string): Promise<Task | undefined> {
    const found = this.tasks.get(taskId);
    return found ? structuredClone(found) : undefined;
  }

  async list(params: ListTasksRequest): Promise<ListTasksResponse> {
    let all = Array.from(this.tasks.values()).map((t) => structuredClone(t));
    if (params.contextId) {
      all = all.filter((t) => t.contextId === params.contextId);
    }
    if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      all = all.filter((t) => t.status?.state === params.status);
    }
    return {
      tasks: all,
      totalSize: all.length,
      pageSize: params.pageSize || SPIKE_DEFAULT_PAGE_SIZE,
      nextPageToken: "",
    };
  }
}

class SpikeAgentExecutor implements AgentExecutor {
  private readonly config: SpikeAgentConfig;
  private readonly canceledTasks = new Set<string>();

  constructor(config: SpikeAgentConfig) {
    this.config = config;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext;
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
        .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
        .join("") || "";
    const chunks =
      this.config.chunks ?? [`${this.config.replyPrefix ?? ""}${inputText}`];
    const artifactId = `art-${taskId}`;

    for (let i = 0; i < chunks.length; i++) {
      if (this.canceledTasks.has(taskId)) {
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_CANCELED,
              message: undefined,
              timestamp: new Date().toISOString(),
            },
            metadata: undefined,
          }),
        );
        eventBus.finished();
        return;
      }
      if (this.config.chunkDelayMs && this.config.chunkDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.config.chunkDelayMs));
      }
      const chunk = chunks[i] ?? "";
      eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId,
            name: "output",
            description: "",
            parts: [
              {
                content: { $case: "text", value: chunk },
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
    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.canceledTasks.add(taskId);
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: taskId,
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

interface AgentRuntime {
  card: AgentCard;
  requestHandler: DefaultRequestHandler;
  v1Transport: JsonRpcTransportHandler;
  legacyTransport: LegacyJsonRpcTransportHandler;
  extensionMethods: Record<string, SpikeExtensionMethodDef>;
}

function buildAgentCard(baseUrl: string, agentId: string, cfg: SpikeAgentConfig, legacy03: boolean): AgentCard {
  const endpointUrl = `${baseUrl}/a2a/${encodeURIComponent(agentId)}`;
  const extensions: AgentExtension[] = (cfg.extensions ?? []).map((ext) => ({
    uri: ext.uri,
    description: ext.description ?? "",
    required: ext.required ?? false,
    params: undefined,
  }));
  const baseCard: AgentCard = {
    name: cfg.name,
    description: cfg.description,
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
      extensions,
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
        name: cfg.name,
        description: cfg.description,
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
  if (legacy03) {
    baseCard.supportedInterfaces = duplicateInterfacesForLegacy(
      baseCard.supportedInterfaces,
      ["JSONRPC"],
    );
  }
  return baseCard;
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = SPIKE_MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new RequestMalformedError("Payload too large");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    // Deliberately map syntax error to A2A RequestMalformedError.
    throw new RequestMalformedError("Invalid JSON payload");
  }
}

async function writeChunkWithBackpressure(
  res: ServerResponse,
  chunk: string,
  simulateBackpressure: boolean,
  onBackpressureWait?: () => void,
): Promise<void> {
  const ok = res.write(chunk);
  if (!ok || simulateBackpressure) {
    onBackpressureWait?.();
    if (!ok) {
      await once(res, "drain");
    } else {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

/**
 * Starts an in-process HTTP server wrapping @a2a-js/sdk 1.3.0 for spike verification.
 */
export async function createA2aSpikeServer(
  options: CreateA2aSpikeServerOptions,
): Promise<A2aSpikeServerHandle> {
  const legacy03 = options.legacy03 ?? false;
  const runtimes = new Map<string, AgentRuntime>();
  let baseUrl = "";
  let sseWriteCount = 0;

  const ensureRuntimes = (): void => {
    if (runtimes.size > 0) return;
    for (const [agentId, cfg] of Object.entries(options.agents)) {
      const card = buildAgentCard(baseUrl, agentId, cfg, legacy03);
      const taskStore = new InMemoryAgentTaskStore(agentId, options.onSaveTask);
      const executor = new SpikeAgentExecutor(cfg);
      const requestHandler = new DefaultRequestHandler(card, taskStore, executor);
      runtimes.set(agentId, {
        card,
        requestHandler,
        v1Transport: new JsonRpcTransportHandler(requestHandler),
        legacyTransport: new LegacyJsonRpcTransportHandler(requestHandler),
        extensionMethods: cfg.extensionMethods ?? {},
      });
    }
  };

  const server = createServer(async (req, res) => {
    ensureRuntimes();
    const url = new URL(req.url ?? "/", baseUrl);
    const pathname = url.pathname;

    // 1. Default agent card at /.well-known/agent-card.json
    if (req.method === "GET" && pathname === "/.well-known/agent-card.json") {
      const defaultId = options.defaultAgentId ?? Object.keys(options.agents)[0];
      const runtime = defaultId ? runtimes.get(defaultId) : undefined;
      if (!runtime) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(AgentCard.toJSON(runtime.card)));
      return;
    }

    // 2. Per-agent card at /a2a/<agent>/.well-known/agent-card.json
    const cardMatch = /^\/a2a\/([^/]+)\/\.well-known\/agent-card\.json$/.exec(pathname);
    if (req.method === "GET" && cardMatch) {
      const agentId = decodeURIComponent(cardMatch[1] ?? "");
      const runtime = runtimes.get(agentId);
      if (!runtime) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(AgentCard.toJSON(runtime.card)));
      return;
    }

    // 3. Per-agent JSON-RPC endpoint at /a2a/<agent>
    const rpcMatch = /^\/a2a\/([^/]+)$/.exec(pathname);
    if (req.method === "POST" && rpcMatch) {
      const agentId = decodeURIComponent(rpcMatch[1] ?? "");
      const runtime = runtimes.get(agentId);
      if (!runtime) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      // Harness Bearer authentication
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${options.token}`) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="a2a"',
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const rpcErr = JsonRpcTransportHandler.mapToJSONRPCError(err);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: rpcErr }));
        return;
      }

      // Reject JSON-RPC batch arrays upfront
      if (Array.isArray(body) || typeof body !== "object" || body === null) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: A2A_ERROR_CODE.INVALID_REQUEST,
              message: "JSON-RPC batch requests are not supported",
            },
          }),
        );
        return;
      }

      const rpcBody = body as { jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: unknown };
      const versionHeaderRaw = req.headers[A2A_VERSION_HEADER.toLowerCase()];
      const versionHeader = Array.isArray(versionHeaderRaw) ? versionHeaderRaw[0] : versionHeaderRaw;
      const extHeaderRaw =
        req.headers[HTTP_EXTENSION_HEADER.toLowerCase()] ??
        req.headers[LEGACY_HTTP_EXTENSION_HEADER.toLowerCase()];
      const extHeader = Array.isArray(extHeaderRaw) ? extHeaderRaw.join(",") : extHeaderRaw;

      const callContext = new ServerCallContext({
        requestedExtensions: Extensions.parseServiceParameter(extHeader),
        ...(versionHeader !== undefined ? { requestedVersion: versionHeader } : {}),
      });

      try {
        validateVersion(callContext.requestedVersion, runtime.card, "JSONRPC");
      } catch (err) {
        const rpcErr = JsonRpcTransportHandler.mapToJSONRPCError(err);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcBody.id ?? null, error: rpcErr }));
        return;
      }

      // Extension method pre-dispatch on the same /a2a/<agent> endpoint
      if (typeof rpcBody.method === "string" && rpcBody.method in runtime.extensionMethods) {
        const extDef = runtime.extensionMethods[rpcBody.method]!;
        if (!callContext.requestedExtensions?.includes(extDef.extensionUri)) {
          const rpcErr = JsonRpcTransportHandler.mapToJSONRPCError(
            new ExtensionSupportRequiredError(extDef.extensionUri),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcBody.id ?? null, error: rpcErr }));
          return;
        }
        try {
          callContext.addActivatedExtension(extDef.extensionUri);
          const paramsObj =
            typeof rpcBody.params === "object" && rpcBody.params !== null && !Array.isArray(rpcBody.params)
              ? (rpcBody.params as Record<string, unknown>)
              : {};
          const extResult = await extDef.handler(paramsObj, callContext);
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (callContext.activatedExtensions?.length) {
            headers[HTTP_EXTENSION_HEADER] = Extensions.toServiceParameter(callContext.activatedExtensions);
          }
          res.writeHead(200, headers);
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcBody.id ?? null, result: extResult }));
        } catch (err) {
          const rpcErr = JsonRpcTransportHandler.mapToJSONRPCError(err);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcBody.id ?? null, error: rpcErr }));
        }
        return;
      }

      const useLegacy =
        legacy03 &&
        (callContext.requestedVersion === A2A_LEGACY_PROTOCOL_VERSION ||
          callContext.requestedVersion === "0.3.0");
      const transport = useLegacy ? runtime.legacyTransport : runtime.v1Transport;
      const resultOrStream = await transport.handle(rpcBody, callContext);

      if (Symbol.asyncIterator in Object(resultOrStream)) {
        const stream = resultOrStream as AsyncGenerator<unknown, void, undefined>;
        let firstItem: IteratorResult<unknown, void>;
        try {
          firstItem = await stream.next();
        } catch (err) {
          const rpcErr = JsonRpcTransportHandler.mapToJSONRPCError(err);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcBody.id ?? null, error: rpcErr }));
          return;
        }

        const sseHeaders: Record<string, string> = { ...SSE_HEADERS };
        if (callContext.activatedExtensions?.length) {
          const extHeaderName = useLegacy ? LEGACY_HTTP_EXTENSION_HEADER : HTTP_EXTENSION_HEADER;
          sseHeaders[extHeaderName] = Extensions.toServiceParameter(callContext.activatedExtensions);
        }
        res.writeHead(200, sseHeaders);

        try {
          if (!firstItem.done) {
            sseWriteCount++;
            const sim =
              Boolean(options.simulateBackpressureEvery) &&
              sseWriteCount % (options.simulateBackpressureEvery ?? 1) === 0;
            await writeChunkWithBackpressure(
              res,
              formatSSEEvent(firstItem.value),
              sim,
              options.onBackpressureWait,
            );
          }
          for await (const item of stream) {
            sseWriteCount++;
            const sim =
              Boolean(options.simulateBackpressureEvery) &&
              sseWriteCount % (options.simulateBackpressureEvery ?? 1) === 0;
            await writeChunkWithBackpressure(
              res,
              formatSSEEvent(item),
              sim,
              options.onBackpressureWait,
            );
          }
        } catch (err) {
          const rpcErr = JsonRpcTransportHandler.mapToJSONRPCError(err);
          res.write(formatSSEErrorEvent({ jsonrpc: "2.0", id: rpcBody.id ?? null, error: rpcErr }));
        } finally {
          res.end();
        }
        return;
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (callContext.activatedExtensions?.length) {
        const extHeaderName = useLegacy ? LEGACY_HTTP_EXTENSION_HEADER : HTTP_EXTENSION_HEADER;
        headers[extHeaderName] = Extensions.toServiceParameter(callContext.activatedExtensions);
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(resultOrStream));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    url: baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
