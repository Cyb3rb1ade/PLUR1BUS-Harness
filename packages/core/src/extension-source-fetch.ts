/** Credential-free MCP bundle downloads for the native plugin worker through the existing egress service (M-A11).
* The request and response are bounded; errors never include source URLs, configuration values or raw causes.
*/
import type { HarnessConfig } from "@plur1bus/config-schema";
import { isAbsolute } from "node:path";
import { validateConfig } from "./config-load.ts";
import { createEgress } from "./egress/index.ts";
import type { Egress } from "./egress/index.ts";
/** A closed request from the native worker; paths are local trusted process input, never remote RPC parameters. */
export interface ExtensionSourceRequest {
  home: string;
  url: string;
  maxBytes: number;
}
/** Explicit ports for validated target configuration and the shared guarded HTTP service. */
export interface ExtensionSourcePorts {
  config(home: string): HarnessConfig;
  egress?: Pick<Egress, "request">;
}
/** Parses the bounded native request without exposing JSON snippets or source credentials in errors. */
export function parseExtensionSourceRequest(value: unknown): ExtensionSourceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ExtensionSourceError("package-invalid");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 3 || typeof object.home !== "string" || !isAbsolute(object.home) ||
    object.home.includes("\0") || typeof object.url !== "string" || object.url.length > 2048 ||
    typeof object.maxBytes !== "number" || !Number.isSafeInteger(object.maxBytes) ||
    object.maxBytes <= 0 || object.maxBytes > 2 ** 30)
    throw new ExtensionSourceError("package-invalid");
  let url: URL;
  try {
    url = new URL(object.url);
  }
  catch {
    throw new ExtensionSourceError("package-invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new ExtensionSourceError("package-invalid");
  return { home: object.home, url: object.url, maxBytes: object.maxBytes };
}
type SourceFailure = "package-invalid" | "config-invalid" | "egress-denied" | "download-too-large" | "source-unreachable";
const MESSAGES: Record<SourceFailure, string> = {
  "package-invalid": "plugin source request is invalid",
  "config-invalid": "plugin source fetch requires readable valid target configuration",
  "egress-denied": "plugin source request was refused by the egress policy",
  "download-too-large": "plugin source response exceeds its byte limit",
  "source-unreachable": "plugin source response is unavailable",
};
/** Fixed, redacted boundary failure; raw HTTP, filesystem and JSON causes never leave the bridge. */
export class ExtensionSourceError extends Error {
  readonly reason: SourceFailure;
  constructor(reason: SourceFailure) {
    super(MESSAGES[reason]);
    this.reason = reason;
  }
}
function limited(stream: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let bytes = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        bytes += result.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          controller.error(new ExtensionSourceError("download-too-large"));
          return;
        }
        controller.enqueue(result.value);
      }
      catch {
        controller.error(new ExtensionSourceError("source-unreachable"));
      }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
}
/** Returns a bounded credential-free stream after validating the target configuration and HTTPS request. */
export async function fetchExtensionSource(value: unknown, ports: ExtensionSourcePorts): Promise<ReadableStream<Uint8Array>> {
  const request = parseExtensionSourceRequest(value);
  let config: HarnessConfig;
  try {
    const result = validateConfig(ports.config(request.home));
    if (!result.ok)
      throw new ExtensionSourceError("config-invalid");
    config = result.config;
  }
  catch {
    throw new ExtensionSourceError("config-invalid");
  }
  const extensions = config as unknown as {
    extensions?: {
      limits?: {
        packageBytes?: number;
      };
    };
  };
  const maxBytes = Math.min(request.maxBytes, extensions.extensions?.limits?.packageBytes ?? 256 * 1024 * 1024);
  const egress = ports.egress ?? createEgress({ config: () => config.egress });
  try {
    const response = await egress.request(request.url, {
      streamResponse: true, maxBytes, timeoutMs: 30000, maxRedirects: 10,
      userAgent: "PLUR1BUS-Extension-Source/1", accept: "application/octet-stream, application/json, application/zip",
    });
    if (response.status < 200 || response.status >= 300 || !response.stream)
      throw new ExtensionSourceError("source-unreachable");
    return limited(response.stream, maxBytes);
  }
  catch (error) {
    if (error instanceof ExtensionSourceError)
      throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "egress-denied" || code === "private-address")
      throw new ExtensionSourceError("egress-denied");
    if (code === "too-large")
      throw new ExtensionSourceError("download-too-large");
    throw new ExtensionSourceError("source-unreachable");
  }
}
