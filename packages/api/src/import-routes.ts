import { SOURCE_CATALOG } from "../../core/src/import/types.ts";
import type { Handler, RouteSpec } from "./routes.ts";

/** Public display metadata. Suggestions describe the deployment and never grant a network capability. */
export interface ImportSourcesResult {
  sources: readonly { id: string; displayName: string }[];
  hostPathsAllowed: boolean;
  sshHostSuggestion?: { host: "host.docker.internal"; reason: "container-host" };
}

export const IMPORT_ROUTES: readonly RouteSpec[] = [
  {
    id: "imports.sources",
    method: "GET",
    path: "/api/v1/import/sources",
    tag: "import",
    summary: "Supported import formats and the authenticated request's host-path capability",
    auth: "session",
    authz: { action: "imports.read" },
    csrf: false,
    rate: "read",
    stability: "experimental",
    since: "1.8.0",
    successStatus: 200,
    success: {
      description: "Canonical display metadata only; source configuration and filesystem paths are absent.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["sources", "hostPathsAllowed"],
        properties: {
          sources: {
            type: "array",
            maxItems: 64,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "displayName"],
              properties: { id: { type: "string", maxLength: 64 }, displayName: { type: "string", maxLength: 256 } },
            },
          },
          hostPathsAllowed: { type: "boolean" },
          sshHostSuggestion: {
            type: "object",
            additionalProperties: false,
            required: ["host", "reason"],
            properties: { host: { const: "host.docker.internal" }, reason: { const: "container-host" } },
          },
        },
      },
    },
  },
];
export function importHandlers(environment: NodeJS.ProcessEnv = process.env): Record<string, Handler> {
  const container = environment.PLUR1BUS_CONTAINER === "1";
  return {
    "imports.sources": (input) => ({
      body: {
        sources: SOURCE_CATALOG.map(({ id, displayName }) => ({ id, displayName })),
        ...(container ? { sshHostSuggestion: { host: "host.docker.internal", reason: "container-host" } } : {}),
        // ip/origin are supplied only by the authenticated HTTP dispatcher, never forwarding headers or RPC params.
        // This is a UX capability hint; the Core separately enforces apiTransport(ctx) at the mutation boundary.
        hostPathsAllowed:
          input.rbac?.role === "owner" ||
          (input.rbac?.role === "admin" && !input.remoteTransport?.origin && /^(127\.|::1$)/.test(input.ip)),
      },
    }),
  };
}
