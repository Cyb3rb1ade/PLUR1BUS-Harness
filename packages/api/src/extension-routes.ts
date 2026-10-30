import { SCHEMA } from "@plur1bus/rpc-schema";
import type { Handler, RouteSpec } from "./routes.ts";
import type { CoreRpc } from "./core-rpc.ts";
import { ApiError, errors, fromCoreError } from "./errors.ts";
import { webPrincipal } from "./principal.ts";

const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const uploadId = { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" };
/** OpenAPI reuses the canonical inspection schema and only its reachable definitions. */
export const EXTENSION_COMPONENTS: Record<string, Record<string, unknown>> = {};
function reference(name: string): Record<string, unknown> {
  const key = `ExtensionRpc${name}`;
  if (!(key in EXTENSION_COMPONENTS)) {
    EXTENSION_COMPONENTS[key] = {};
    const clone = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(clone);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [
            k,
            k === "$ref" && typeof v === "string" && v.startsWith("#/$defs/") ? reference(v.slice(8)).$ref : clone(v),
          ]),
        );
      return value;
    };
    EXTENSION_COMPONENTS[key] = clone((SCHEMA.$defs as Record<string, unknown>)[name]) as Record<string, unknown>;
  }
  return { $ref: `#/components/schemas/${key}` };
}
const inspection = reference("ExtInspection");
const base = {
  tag: "extensions",
  auth: "any",
  authz: { action: "extensions.manage" },
  csrf: true,
  stability: "experimental",
  since: "1.8.0",
  successStatus: 200,
  extra: {
    503: {
      description: "Private staging or the required Core service is unavailable",
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
} as const;
export const EXTENSION_ROUTES: readonly RouteSpec[] = [
  {
    ...base,
    authz: { action: "imports.manage" },
    id: "imports.snapshot.upload",
    method: "POST",
    path: "/api/v1/import/snapshots",
    tag: "import",
    rate: "upload",
    summary:
      "Stream one tar.gz import snapshot into separate ten-minute person-bound staging; explicitly enrolled import device scope or session",
    requestContentType: "multipart/form-data",
    requestBody: object({ file: { type: "string", format: "binary" } }),
    success: {
      description:
        "Separate import capability; never accepted by extension inspection. Compressed bytes are capped at 1 GiB before safe extraction by the import service.",
      schema: object({
        snapshotId: uploadId,
        expiresAt: { type: "integer", minimum: 0 },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      }),
    },
  },
  {
    ...base,
    id: "extensions.upload",
    method: "POST",
    path: "/api/v1/extensions/upload",
    rate: "upload",
    summary:
      "Stream one extension file into ten-minute person-bound private staging; session or explicitly enrolled native device token",
    requestContentType: "multipart/form-data",
    requestBody: object({ file: { type: "string", format: "binary" } }),
    success: {
      description:
        "Opaque one-use ID, expiry and package hash; never a host path. Ordinary personal API tokens cannot perform this human-only operation.",
      schema: object({
        uploadId,
        expiresAt: { type: "integer", minimum: 0 },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      }),
    },
  },
  {
    ...base,
    id: "extensions.inspect",
    method: "POST",
    path: "/api/v1/extensions/inspect",
    rate: "write",
    summary: "Inspect the same person's opaque upload; native device bearer or session with CSRF",
    requestBody: object({ source: object({ upload: uploadId }) }),
    success: {
      description: "Owned inspection for /extensions/confirm?inspection=<id>; no installation occurs.",
      schema: inspection,
    },
  },
];
export const NATIVE_FILE_ROUTES = new Set(EXTENSION_ROUTES.map((r) => r.id));
export function extensionHandlers(core: CoreRpc): Record<string, Handler> {
  return {
    // The authenticated dispatcher streams this route before any JSON reader or handler timeout starts.
    "extensions.upload": () => {
      throw new ApiError(503, "E_NOT_AVAILABLE", "upload stream unavailable");
    },
    "imports.snapshot.upload": () => {
      throw new ApiError(503, "E_NOT_AVAILABLE", "snapshot stream unavailable");
    },
    "extensions.inspect": async (input) => {
      const body = input.body as { source?: { upload?: unknown } } | undefined;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !body.source ||
        typeof body.source !== "object" ||
        Array.isArray(body.source) ||
        Object.keys(body.source).length !== 1 ||
        typeof body.source.upload !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.source.upload)
      )
        throw errors.badRequest("upload-source", "an opaque upload source is required");
      if (!core.callAs || !input.rbac) throw new ApiError(503, "E_NOT_AVAILABLE", "extension inspection unavailable");
      try {
        return {
          body: await core.callAs<Record<string, unknown>>(
            "ext.inspect",
            body,
            webPrincipal(input.rbac, input.principal?.kind === "owner"),
            "supervisor",
          ),
        };
      } catch (error) {
        throw fromCoreError(error);
      }
    },
  };
}
