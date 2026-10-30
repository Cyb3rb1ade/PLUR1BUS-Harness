import {
  A2A_PROTOCOL_VERSION,
  SendMessageRequest,
  StreamResponse,
  type AgentCard,
  type CancelTaskRequest,
  type GetTaskRequest,
  type ListTasksRequest,
  type ListTasksResponse,
  type SubscribeToTaskRequest,
  type Task,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  createAuthenticatingFetchWithRetry,
  type Client,
} from "@a2a-js/sdk/client";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import type { Egress } from "../egress/index.ts";

export interface A2aFetchOptions {
  egress: Pick<Egress, "decide">;
  maxBodyBytes?: number | undefined;
}

/**
 * Creates a fetch implementation that strictly enforces PLUR1BUS egress boundaries:
 * 1. Validates target URL against egress.decide().
 * 2. Pins the connection to the approved IP address (preventing DNS rebinding and SSRF).
 * 3. Forbids credentials and fragments in the URL.
 * 4. Yields standard Web ReadableStreams for SSE chunk streaming.
 */
export function createA2aFetch(opts: A2aFetchOptions): typeof fetch {
  const egress = opts.egress;
  return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl);

    if (url.username || url.password || url.hash) {
      throw new Error("A2A URL credentials and fragments are forbidden");
    }

    const pin = await egress.decide(url.toString());
    if (!pin.allowed) {
      throw new Error(`A2A egress denied (${pin.reason})`);
    }

    if (init.signal?.aborted) {
      throw new Error("A2A HTTP aborted");
    }

    const method =
      init.method ??
      (typeof input === "object" && "method" in input && input.method
        ? input.method
        : "GET");

    const headers: Record<string, string> = {};
    if (typeof input === "object" && "headers" in input && input.headers) {
      new Headers(input.headers).forEach((v, k) => {
        headers[k] = v;
      });
    }
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    delete headers.host;

    let bodyStr: string | undefined;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === "string") {
        bodyStr = init.body;
      } else if (Buffer.isBuffer(init.body)) {
        bodyStr = init.body.toString("utf8");
      } else if (init.body instanceof URLSearchParams) {
        bodyStr = init.body.toString();
      } else {
        throw new Error("A2A HTTP body must be string or buffer");
      }
    }

    return await new Promise<Response>((resolve, reject) => {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const isHttps = url.protocol === "https:";
      const port = url.port || (isHttps ? 443 : 80);

      const req = (isHttps ? https : http).request(
        {
          hostname: host,
          port,
          path: url.pathname + url.search,
          method,
          headers,
          agent: false,
          ...(init.signal ? { signal: init.signal } : {}),
          lookup: ((
            _hostname: string,
            options: { all?: boolean },
            callback: (...args: unknown[]) => void,
          ) => {
            if (options.all) {
              callback(null, [{ address: pin.address, family: pin.family }]);
            } else {
              callback(null, pin.address, pin.family);
            }
          }) as never,
        },
        (res) => {
          const status = res.statusCode ?? 500;
          const resHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) resHeaders.append(key, item);
            } else if (value !== undefined) {
              resHeaders.set(key, value);
            }
          }

          const stream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
          resolve(
            new Response(stream, {
              status,
              ...(res.statusMessage !== undefined ? { statusText: res.statusMessage } : {}),
              headers: resHeaders,
            }),
          );
        },
      );

      req.on("error", reject);
      if (bodyStr !== undefined) {
        req.write(bodyStr);
      }
      req.end();
    });
  };
}

export interface OutboundA2aClientOptions {
  cardUrl: string;
  token?: string | undefined;
  egress: Pick<Egress, "decide">;
  protocolVersion?: string | undefined;
  legacy03?: boolean | undefined;
}

export class OutboundA2aClient {
  readonly card: AgentCard;
  readonly client: Client;

  constructor(card: AgentCard, client: Client) {
    this.card = card;
    this.client = client;
  }

  async sendMessage(params: SendMessageRequest): Promise<Task> {
    return this.client.sendMessage(params) as Promise<Task>;
  }

  async *sendMessageStream(
    params: SendMessageRequest,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    yield* this.client.sendMessageStream(params);
  }

  async sendText(
    text: string,
    opts: { messageId?: string | undefined; taskId?: string | undefined; contextId?: string | undefined } = {},
  ): Promise<Task> {
    const req = SendMessageRequest.fromJSON({
      message: {
        messageId: opts.messageId ?? randomUUID(),
        role: "ROLE_USER",
        parts: [{ text }],
        ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
        ...(opts.contextId !== undefined ? { contextId: opts.contextId } : {}),
      },
    });
    return this.sendMessage(req);
  }

  async *sendTextStream(
    text: string,
    opts: { messageId?: string | undefined; taskId?: string | undefined; contextId?: string | undefined } = {},
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const req = SendMessageRequest.fromJSON({
      message: {
        messageId: opts.messageId ?? randomUUID(),
        role: "ROLE_USER",
        parts: [{ text }],
        ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
        ...(opts.contextId !== undefined ? { contextId: opts.contextId } : {}),
      },
    });
    yield* this.sendMessageStream(req);
  }

  async cancelTask(params: CancelTaskRequest): Promise<Task> {
    return this.client.cancelTask(params) as Promise<Task>;
  }

  async getTask(params: GetTaskRequest): Promise<Task> {
    return this.client.getTask(params) as Promise<Task>;
  }

  async listTasks(params: ListTasksRequest): Promise<ListTasksResponse> {
    return this.client.listTasks(params);
  }

  async *resubscribeTask(
    params: SubscribeToTaskRequest,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    yield* this.client.resubscribeTask(params);
  }
}

export async function createOutboundA2aClient(
  opts: OutboundA2aClientOptions,
): Promise<OutboundA2aClient> {
  const parsed = new URL(opts.cardUrl);
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("A2A URL credentials and fragments are forbidden");
  }

  const egressFetch = createA2aFetch({ egress: opts.egress });

  const authFetch = createAuthenticatingFetchWithRetry(egressFetch, {
    headers: async () => ({
      ...(opts.token !== undefined ? { Authorization: `Bearer ${opts.token}` } : {}),
      "a2a-version": opts.protocolVersion ?? A2A_PROTOCOL_VERSION,
    }),
    shouldRetryWithHeaders: async () => undefined,
  });

  const cardResolver = new DefaultAgentCardResolver({ fetchImpl: authFetch });
  const card = await cardResolver.resolve(opts.cardUrl, "");

  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver,
      transports: [
        new JsonRpcTransportFactory({
          fetchImpl: authFetch,
          ...(opts.legacy03 !== undefined ? { legacyCompat: { enabled: opts.legacy03 } } : {}),
        }),
      ],
    }),
  );

  const client = await factory.createFromAgentCard(card);
  return new OutboundA2aClient(card, client);
}
