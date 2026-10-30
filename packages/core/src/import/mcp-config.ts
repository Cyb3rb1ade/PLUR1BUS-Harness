// A13 pure MCP source mapping. It never opens files, resolves environment variables, fetches, spawns or imports code.
import { discoveryFingerprint, discoveryIdentity } from "./discovery-identity.ts";
import { ImportError, type SourceType } from "./types.ts";

/** The native host assigns imported provenance and disabled state; source metadata cannot supply either. */
export interface ImportedMcpCandidate {
  schema: "import.mcp-candidate/1";
  source: SourceType;
  profile: string | null;
  name: string;
  fingerprint: string;
  transport: { type: "http"; url: string; auth: "none" | "header" }
    | { type: "manual"; runtime: "node" | "python" | "binary" | "unknown" };
  requiredSecrets: Array<{ slot: string }>;
  reasons: string[];
}

/** A sanitized source config plus its source-side profile identity, before any target mutation. */
export interface ImportedConfigInput { source: SourceType; profile?: string | null; config: unknown }

const MAX_SERVERS = 256;
const MAX_SLOTS = 64;
const SLOT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$(?![\s\S])/;

/** Fixed reason only: source mapping keys and values may contain credentials. */
export function extensionSourceLimit(): never {
  throw new ImportError("E_IMPORT_FAILED", "extension-source-limit", "Extension source exceeds the supported limit");
}

/** Narrows a decoded mapping without copying its untrusted fields. */
export function sourceObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function runtime(command: unknown): "node" | "python" | "unknown" {
  if (typeof command !== "string") return "unknown";
  const file = command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  if (file === "node" || file === "node.exe" || file === "npx" || file === "npx.cmd") return "node";
  if (file === "uv" || file === "uvx" || /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/.test(file ?? "")) return "python";
  return "unknown";
}

function slots(server: Record<string, unknown>, reasons: string[]): Array<{ slot: string }> {
  const keys = Object.keys(sourceObject(server.env));
  const headers = Object.entries(sourceObject(server.headers));
  if (keys.length > MAX_SLOTS || headers.length > MAX_SLOTS) extensionSourceLimit();
  if (keys.some(key => !SLOT.test(key))) reasons.push("invalid-secret-slot-manual-setup");
  const names = new Set(keys.filter(key => SLOT.test(key)));
  for (const [key, value] of headers) {
    if (key.toLowerCase() !== "authorization") continue;
    const reference = typeof value === "string" ? /^(?:Bearer )?\$\{([A-Za-z_][A-Za-z0-9_]{0,63})\}$(?![\s\S])/.exec(value) : null;
    names.add(reference?.[1] ?? "AUTHORIZATION");
  }
  if (server.auth === "header" && names.size === 0) names.add("AUTHORIZATION");
  if (names.size > MAX_SLOTS) extensionSourceLimit();
  return [...names].sort().map(slot => ({ slot }));
}

function transport(server: Record<string, unknown>, reasons: string[]): ImportedMcpCandidate["transport"] {
  const auth = sourceObject(server.auth);
  if (server.auth === "oauth" || auth.type === "oauth" || server.oauth !== undefined) {
    reasons.push("requester-oauth-manual-setup");
    return { type: "manual", runtime: "unknown" };
  }
  if (typeof server.url === "string") {
    let url: URL;
    try { url = new URL(server.url); } catch {
      reasons.push("invalid-remote-url");
      return { type: "manual", runtime: "unknown" };
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      reasons.push("credential-or-unsupported-url");
      return { type: "manual", runtime: "unknown" };
    }
    const headers = Object.keys(sourceObject(server.headers));
    if (headers.some(key => key.toLowerCase() !== "authorization")) {
      reasons.push("unsupported-header-manual-setup");
      return { type: "manual", runtime: "unknown" };
    }
    return { type: "http", url: url.toString(), auth: headers.length > 0 || server.auth === "header" ? "header" : "none" };
  }
  reasons.push("external-command-manual-setup");
  if (Array.isArray(server.args) && server.args.length > 0) reasons.push("arguments-withheld");
  if (server.cwd !== undefined) reasons.push("working-directory-withheld");
  return { type: "manual", runtime: runtime(server.command) };
}

/**
 * Maps OpenClaw `mcp.servers` or Hermes `mcp_servers` into inert native import candidates.
 * Only declared slot names survive; literal env/header/argv/cwd values and foreign metadata are never copied.
 */
export function parseImportedMcpConfig(input: ImportedConfigInput): ImportedMcpCandidate[] {
  const config = sourceObject(input.config);
  const servers = input.source === "openclaw" ? sourceObject(sourceObject(config.mcp).servers)
    : sourceObject(config.mcp_servers);
  const entries = Object.entries(servers);
  if (entries.length > MAX_SERVERS) extensionSourceLimit();
  return entries.sort(([a], [b]) => a.localeCompare(b)).map(([name, raw]) => {
    const identity = discoveryIdentity(input.source, input.profile ?? null, name);
    const server = sourceObject(raw);
    const reasons: string[] = [];
    const selected = transport(server, reasons);
    const requiredSecrets = slots(server, reasons);
    const descriptor = { source: input.source, identity: identity.identity, transport: selected, requiredSecrets, reasons };
    return { schema: "import.mcp-candidate/1", source: input.source, profile: identity.profile,
      name: identity.name, fingerprint: discoveryFingerprint(descriptor), transport: selected, requiredSecrets, reasons };
  });
}
