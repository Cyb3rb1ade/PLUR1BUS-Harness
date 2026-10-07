import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { toolHeaderExtractor } from "./tool-headers.ts";
import { McpError, ErrorCode, ListRootsRequestSchema, ListRootsResultSchema, CreateMessageRequestSchema, CreateMessageResultSchema,
  ElicitRequestSchema, ElicitResultSchema, type ClientCapabilities, type ListRootsResult, type CreateMessageRequest, type CreateMessageResult,
  type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";

export interface McpPortContext { server: string; signal: AbortSignal; timeoutMs?: number }
/** Explicit host ports. Supplying no port advertises no capability and refuses the request. */
export interface McpClientPorts {
  roots?: { list(context: McpPortContext): Promise<ListRootsResult> };
  sampling?: { createMessage(params: CreateMessageRequest["params"], context: McpPortContext): Promise<CreateMessageResult> };
  elicitation?: { create(params: ElicitRequest["params"], context: McpPortContext): Promise<ElicitResult>; url?: boolean };
}
export function portCapabilities(ports: McpClientPorts, modern = false): ClientCapabilities {
  return { ...(ports.roots ? { roots: modern ? {} : { listChanged: true } } : {}), ...(ports.sampling ? { sampling: {} } : {}),
    ...(ports.elicitation ? { elicitation: { form: {}, ...(ports.elicitation.url ? { url: {} } : {}) } } : {}) };
}
/** Validates requests and port results. Port exceptions are deliberately replaced, even if they contain secrets. */
async function dispatchValidated(method: string, params: unknown, ports: McpClientPorts, context: McpPortContext): Promise<Record<string, unknown>> {
  try {
    if (context.signal.aborted) throw new McpError(ErrorCode.InternalError, "MCP client request cancelled");
    switch (method) {
      case "roots/list": {
        if (!ports.roots) break;
        ListRootsRequestSchema.parse({ method, params });
        const result = ListRootsResultSchema.parse(await ports.roots.list(context));
        if (result.roots.some(r => !r.uri.startsWith("file://"))) throw new McpError(ErrorCode.InvalidParams, "MCP roots must use file URIs");
        return result;
      }
      case "sampling/createMessage": {
        if (!ports.sampling) break;
        const request = CreateMessageRequestSchema.parse({ method, params });
        if (request.params.tools || request.params.toolChoice || request.params.includeContext && request.params.includeContext !== "none") throw new McpError(ErrorCode.InvalidParams, "MCP sampling context or tool capability not enabled");
        return CreateMessageResultSchema.parse(await ports.sampling.createMessage(request.params, context));
      }
      case "elicitation/create": {
        if (!ports.elicitation) break;
        const request = ElicitRequestSchema.parse({ method, params });
        if (request.params.mode === "url" && !ports.elicitation.url) throw new McpError(ErrorCode.InvalidParams, "MCP URL elicitation not enabled");
        const result = ElicitResultSchema.parse(await ports.elicitation.create(request.params, context));
        if (request.params.mode !== "url" && result.action === "accept") {
          toolHeaderExtractor(request.params.requestedSchema);
          if (!new AjvJsonSchemaValidator().getValidator(request.params.requestedSchema as Record<string, unknown>)(result.content).valid) throw new McpError(ErrorCode.InvalidParams, "MCP elicitation result invalid");
        }
        return result;
      }
    }
    throw new McpError(ErrorCode.MethodNotFound, "MCP client feature is disabled");
  } catch (error) {
    if (error instanceof McpError) throw new McpError(error.code, error.code === ErrorCode.MethodNotFound ? "MCP client feature is disabled" : "MCP client request refused");
    throw new McpError(ErrorCode.InternalError, "MCP client port failed validation or execution");
  }
}

/** A port may ignore cancellation, so the host independently bounds its completion. */
export async function dispatchPort(method: string, params: unknown, ports: McpClientPorts, context: McpPortContext): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let detach: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const cancel = () => { controller.abort(); reject(new McpError(ErrorCode.InternalError, "MCP client port cancelled")); };
    if (context.signal.aborted) cancel(); else context.signal.addEventListener("abort", cancel, { once: true });
    detach = () => context.signal.removeEventListener("abort", cancel);
    timer = setTimeout(() => { controller.abort(); reject(new McpError(ErrorCode.InternalError, "MCP client port timed out")); }, context.timeoutMs ?? 60_000);
  });
  try { return await Promise.race([dispatchValidated(method, params, ports, { ...context, signal: controller.signal }), aborted]); }
  finally { clearTimeout(timer); detach?.(); }
}
