// Consumer direction (D55 b): PLUR1BUS agents that browse (Chrome extension D37, ego lite D39, the
// built-in browser) get a site's WebMCP tools as MCP tools named `webmcp:<origin>/<tool>`. The
// bridge enforces the per-origin allowlist with `isOriginAllowed` before offering anything; the
// harness approval policy (D30) and output sanitising run on every call outside this package.
import type { JsonSchema, ToolAnnotations } from "./types.ts";

/** A tool a page registered, as `ModelContext.getTools()` (current draft `RegisteredTool`) or an
 *  early-shape bridge reports it. Only the listed fields are read. */
export interface PageTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations & Record<string, unknown>;
}

export interface McpToolDescriptor {
  /** `webmcp:<origin>/<tool>` */
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; untrustedContentHint?: boolean; consequentialHint?: boolean };
  /** Routing back to the page: the canonical origin and the page's own tool name, unmodified. */
  origin: string;
  pageToolName: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

/** Parses a web origin (`scheme://host[:port]`, optional trailing slash). Returns the canonical
 *  origin (lower-case, default port dropped) or undefined when the string is not a plain https
 *  origin (or an http origin on localhost). Paths, queries, fragments and credentials are refused. */
export function canonicalOrigin(origin: string): string | undefined {
  if (typeof origin !== "string" || origin.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\/?$/i.test(origin)) return undefined;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && isLocalHost(url.hostname)) return url.origin;
  return undefined;
}

/** True when `origin` may expose tools to PLUR1BUS agents. Allowlist entries are either exact
 *  origins (`https://app.example.com`, `http://localhost:3000`) or a subdomain rule
 *  `*.example.com` / `https://*.example.com`, which matches https origins on the default port whose
 *  host is a strict subdomain of `example.com` (not `example.com` itself). A rule needs at least two
 *  labels after `*.`; `*`, `*.com` and any other wildcard form are ignored. Only https origins are
 *  allowed, except http on localhost (which needs an exact entry). */
export function isOriginAllowed(origin: string, allowlist: readonly string[]): boolean {
  const canon = canonicalOrigin(origin);
  if (!canon) return false;
  const url = new URL(canon);
  for (const raw of allowlist) {
    if (typeof raw !== "string") continue;
    const entry = raw.trim();
    const rule = /^(?:https:\/\/)?\*\.((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/i.exec(entry);
    if (rule) {
      const base = rule[1]!.toLowerCase();
      if (url.protocol === "https:" && url.port === "" && url.hostname.endsWith(`.${base}`)) return true;
      continue;
    }
    if (entry.includes("*")) continue;
    if (canonicalOrigin(entry) === canon) return true;
  }
  return false;
}

const TOOL_CHARS = /[^A-Za-z0-9_.-]/g;

/** Sanitises a page tool name to the draft's name alphabet (ASCII alphanumerics, `_`, `-`, `.`),
 *  1–128 characters. */
export function sanitizeToolName(name: string): string {
  const s = String(name).replace(TOOL_CHARS, "_").slice(0, 128);
  return s.length ? s : "_";
}

/** Plain-data copy of a page-supplied schema; anything non-JSON (functions, cycles) falls back to an
 *  empty object schema. */
function copySchema(v: unknown): JsonSchema {
  const empty = { type: "object", properties: {} };
  if (!v || typeof v !== "object" || Array.isArray(v)) return empty;
  try {
    const c = JSON.parse(JSON.stringify(v)) as unknown;
    return c && typeof c === "object" && !Array.isArray(c) ? (c as JsonSchema) : empty;
  } catch {
    return empty;
  }
}

/** Page tools -> MCP tool descriptors. Returns [] for an origin that is not a valid https (or
 *  localhost http) origin; allowlisting is the caller's separate `isOriginAllowed` check. Tools that
 *  collide after sanitising get a `_2`, `_3`… suffix; entries without a string name are skipped. */
export function pageToolsToMcp(origin: string, pageTools: readonly PageTool[]): McpToolDescriptor[] {
  const canon = canonicalOrigin(origin);
  if (!canon) return [];
  const used = new Set<string>();
  const out: McpToolDescriptor[] = [];
  for (const t of pageTools) {
    if (!t || typeof t.name !== "string" || t.name.length === 0) continue;
    const base = sanitizeToolName(t.name);
    let tool = base;
    for (let i = 2; used.has(tool); i++) tool = `${base.slice(0, 120)}_${i}`;
    used.add(tool);
    const a = t.annotations ?? {};
    const inputSchema = copySchema(t.inputSchema);
    out.push({
      name: `webmcp:${canon}/${tool}`,
      ...(typeof t.title === "string" ? { title: t.title } : {}),
      description: typeof t.description === "string" ? t.description : "",
      inputSchema,
      annotations: {
        readOnlyHint: a.readOnlyHint === true,
        // Page-provided content is untrusted by construction; the flag is kept for the policy layer.
        untrustedContentHint: true,
        ...(a.consequentialHint === true ? { consequentialHint: true } : {}),
      },
      origin: canon,
      pageToolName: t.name,
    });
  }
  return out;
}

/** Splits a `webmcp:<origin>/<tool>` name back into its parts (the tool part is the sanitised name;
 *  route calls by `McpToolDescriptor.pageToolName`, not by this). */
export function parseWebMcpToolName(name: string): { origin: string; tool: string } | undefined {
  const m = /^webmcp:([a-z][a-z0-9+.-]*:\/\/[^/]+)\/([A-Za-z0-9_.-]{1,128})$/.exec(name);
  if (!m) return undefined;
  const origin = canonicalOrigin(m[1]!);
  return origin ? { origin, tool: m[2]! } : undefined;
}
