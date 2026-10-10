// Provider direction (D55 a): the PLUR1BUS web GUI (M3) exposes harness RPC methods as WebMCP tools.
// The tool set is derived from the core's handshake capabilities and the RPC schema, never a
// hand-kept list; only the policy sets below (forbidden / read-only / default reads) are fixed here.
import type { ExecuteContext, JsonSchema, ToolResult, WebMcpTool } from "./types.ts";

/** One `core.auth` capability entry. `stability` is what buildCapabilities emits; `x-stability` and
 *  `server`/`x-server` are accepted so older or newer handshakes both work. */
export interface CapabilityEntryLike {
  stability?: string;
  "x-stability"?: string;
  since?: string;
  deprecated?: unknown;
  server?: string;
  "x-server"?: string;
}
export interface CapabilitiesLike {
  methods: Record<string, CapabilityEntryLike>;
}

/** Performs one RPC call through the page's authenticated client (D35 device token stays inside it).
 *  Rejects with the RPC error (`{ code, message, data: { error, reason } }` or a client error class
 *  carrying the same fields) on failure. */
export type RpcCall = (method: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;

/** Asks the human before a data-changing tool runs; resolve true to proceed. */
export type Confirm = (toolName: string, input: Record<string, unknown>) => Promise<boolean> | boolean;

export interface BuildOptions {
  capabilities: CapabilitiesLike;
  /** packages/rpc-schema's schema object (`SCHEMA`), injected so this package stays platform-neutral. */
  schema: Record<string, unknown>;
  call: RpcCall;
  confirm?: Confirm;
  /** Additional methods to expose (experimental ones are opt-in). Forbidden methods are ignored. */
  include?: readonly string[];
  /** Methods to leave out, e.g. because the page does not currently show that data (D55). */
  exclude?: readonly string[];
  /** Params the page supplies itself (e.g. `agentId` of the agent on screen). Removed from every
   *  inputSchema and forced into every call's params; the agent can never override them. `caller`
   *  is always removed from inputSchemas whether or not it is bound here (the page's RPC client or
   *  this map supplies it). */
  bound?: Readonly<Record<string, unknown>>;
}

export const TOOL_PREFIX = "plur1bus_";

/** Params the page always supplies; never part of an inputSchema. */
export const PAGE_SUPPLIED_PARAMS: readonly string[] = ["caller"];

/** Methods that are never exposed, even when named in `include`: authentication, process lifecycle,
 *  supervisor/daemon/module control, subscriptions, configuration writes and admin ops (D55: `admin.*`). */
const FORBIDDEN_EXACT = new Set([
  "core.auth", "core.shutdown", "core.adopt", "memory.checkpoint", "agent.open", "agent.close",
  "ext.install", "ext.uninstall", "ext.restore", "ext.enable", "ext.disable", "ext.update",
  "models.scan", "models.setOverride", "models.removeManual", "models.acknowledge",
  "budget.set",
  // Human-only admin (B15, docs/rbac.md): agent lifecycle, rights, pairing and other people's data. Agent pause/resume
  // stay exposed: a person may trigger them through an assistant, and RBAC decides who may.
  "agent.delete", "agent.archive", "agent.unarchive", "agent.export", "agent.rights.get", "agent.rights.set",
  "pairing.qr", "session.list",
]);
const FORBIDDEN_PREFIX = ["project.column.","supervisor.", "daemon.", "events.", "config.", "module.", "admin.", "service.", "identity.", "update.", "secret.", "secrets.", "login.", "auth.", "grant.", "approval.", "user.", "breakglass.", "device."];
const FORBIDDEN_SUFFIX = [".auth", ".adopt", ".shutdown"];

export function isForbiddenMethod(method: string): boolean {
  return FORBIDDEN_EXACT.has(method) || FORBIDDEN_PREFIX.some((p) => method.startsWith(p)) || FORBIDDEN_SUFFIX.some((s) => method.endsWith(s));
}

/** Methods that only read. Every other exposed method is non-read-only and needs confirmation. */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "core.status",
  "memory.recall",
  "memory.list",
  "memory.show",
  "memory.state",
  "memory.proposals.list",
  "agent.status",
  "agent.list",
  "jobs.list",
  "jobs.history",
]);

/** Read ops exposed by default even while experimental (D55: memory recall/list/show). */
export const DEFAULT_READ_METHODS: readonly string[] = ["memory.recall", "memory.list", "memory.show", "memory.state", "memory.proposals.list"];

/** Methods whose results carry stored memory text (user- or agent-authored, i.e. untrusted content). */
const MEMORY_CONTENT = /^memory\.(recall|list|show|proposals\.list)$/;

/** Fallback descriptions: the RPC schema carries no per-method description today. */
const DESCRIPTIONS: Record<string, string> = {
  "core.status": "Show the PLUR1BUS core's status: version, uptime, engine state, open agents.",
  "memory.recall": "Recall memories relevant to a query for a PLUR1BUS agent.",
  "memory.capture": "Store conversation messages in a PLUR1BUS agent's memory.",
  "memory.list": "List a PLUR1BUS agent's memory cards, optionally filtered by topic and time.",
  "memory.show": "Show one memory card of a PLUR1BUS agent by id.",
  "memory.forget": "Forget (delete) one memory card of a PLUR1BUS agent.",
  "memory.correct": "Replace the text of one memory card of a PLUR1BUS agent.",
  "memory.share": "Share one memory card of a PLUR1BUS agent with the workspace or the user.",
  "memory.state": "Show a PLUR1BUS agent's memory state (counts, health).",
  "memory.propose": "Propose a change to a shared memory card.",
  "memory.proposals.list": "List proposals for shared memory cards.",
  "memory.proposals.accept": "Accept a proposal for a shared memory card.",
  "memory.proposals.reject": "Reject a proposal for a shared memory card.",
  "agent.list": "List PLUR1BUS agents.",
  "agent.status": "Show one PLUR1BUS agent's status.",
  "jobs.list": "List a PLUR1BUS agent's scheduled jobs.",
  "jobs.run": "Run one of a PLUR1BUS agent's jobs now.",
  "jobs.history": "Show the run history of a PLUR1BUS agent's jobs.",
};

export function toolNameFor(method: string): string {
  return TOOL_PREFIX + method.replaceAll(".", "_");
}

function stabilityOf(entry: CapabilityEntryLike | undefined, def: Record<string, unknown> | undefined): string | undefined {
  return entry?.stability ?? entry?.["x-stability"] ?? (def?.["x-stability"] as string | undefined);
}
function serverOf(entry: CapabilityEntryLike | undefined, def: Record<string, unknown> | undefined): string | undefined {
  return entry?.server ?? entry?.["x-server"] ?? (def?.["x-server"] as string | undefined);
}

/** Selects the methods to expose, sorted. Exported for tests and for the GUI's settings screen. */
export function selectMethods(o: Pick<BuildOptions, "capabilities" | "schema" | "include" | "exclude">): string[] {
  const defs = (((o.schema as { $defs?: { methods?: unknown } }).$defs?.methods ?? {}) as Record<string, Record<string, unknown>>);
  const include = new Set(o.include ?? []);
  const exclude = new Set(o.exclude ?? []);
  const out: string[] = [];
  for (const [method, entry] of Object.entries(o.capabilities.methods ?? {})) {
    const def = defs[method];
    if (!def || isForbiddenMethod(method) || exclude.has(method)) continue;
    const server = serverOf(entry, def);
    if (server !== undefined && server !== "core") continue;
    const stable = stabilityOf(entry, def) === "stable" && !entry.deprecated;
    if (stable || DEFAULT_READ_METHODS.includes(method) || include.has(method)) out.push(method);
  }
  return out.sort();
}

/** Inlines local `#/$defs/...` refs so the inputSchema stands alone (a browser has no RPC schema). */
function inlineRefs(node: unknown, defs: Record<string, unknown>, depth = 0): unknown {
  if (depth > 32) throw new Error("webmcp: $ref nesting too deep (cycle?)");
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, defs, depth + 1));
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof obj.$ref === "string") {
    const m = /^#\/\$defs\/([^/]+)$/.exec(obj.$ref);
    if (!m || !(m[1]! in defs)) throw new Error(`webmcp: unresolvable $ref ${obj.$ref}`);
    Object.assign(out, inlineRefs(defs[m[1]!], defs, depth + 1) as Record<string, unknown>);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$ref" || k.startsWith("x-")) continue;
    out[k] = inlineRefs(v, defs, depth + 1);
  }
  return out;
}

/** The method's params schema, standalone, minus page-supplied params. */
export function inputSchemaFor(schema: Record<string, unknown>, method: string, stripped: readonly string[] = PAGE_SUPPLIED_PARAMS): JsonSchema {
  const defs = ((schema as { $defs?: Record<string, unknown> }).$defs ?? {}) as Record<string, unknown>;
  const params = ((defs.methods as Record<string, { params?: unknown }> | undefined)?.[method]?.params ?? { type: "object", properties: {} }) as Record<string, unknown>;
  const out = inlineRefs(params, defs) as Record<string, unknown>;
  const drop = new Set(stripped);
  if (out.properties && typeof out.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(out.properties as Record<string, unknown>).filter(([k]) => !drop.has(k)));
  } else {
    out.properties = {};
  }
  if (Array.isArray(out.required)) {
    const req = (out.required as string[]).filter((k) => !drop.has(k));
    if (req.length) out.required = req;
    else delete out.required;
  }
  out.type = "object";
  return out;
}

const ERROR_CODE = /^E_[A-Z][A-Z0-9_]{0,63}$/;
const REASON = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** RPC error -> safe `{ error, reason? }`. Only the error code and a slug-shaped reason survive;
 *  message, detail, ids, tokens and anything else the error object carries are dropped. */
export function safeError(err: unknown): { error: string; reason?: string } {
  const e = (err ?? {}) as Record<string, unknown>;
  const inner = (e.error && typeof e.error === "object" ? e.error : e) as Record<string, unknown>;
  const data = (inner.data && typeof inner.data === "object" ? inner.data : {}) as Record<string, unknown>;
  const candidates = [data.error, inner.code, e.code, e.error];
  const code = candidates.find((c): c is string => typeof c === "string" && ERROR_CODE.test(c)) ?? "E_INTERNAL";
  const reasonRaw = data.reason ?? e.reason;
  const reason = typeof reasonRaw === "string" && REASON.test(reasonRaw) ? reasonRaw : undefined;
  return reason ? { error: code, reason } : { error: code };
}

const SECRET_KEY = /^(?:[a-z0-9]*[_-]?)?(?:token|secret|password|passwd|apikey|api_key|authorization|cookie|credentials?)$/i;

/** Drops secret-looking keys (anywhere in the value) from a result before it reaches the agent. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 64) return null;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [k, redactSecrets(v, depth + 1)]));
}

function text(value: unknown, isError = false): ToolResult {
  const t = JSON.stringify(value) ?? "null";
  return isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] };
}

async function askHuman(confirm: Confirm | undefined, ctx: ExecuteContext, toolName: string, input: Record<string, unknown>): Promise<boolean> {
  if (!confirm) return false; // fail closed: no GUI confirmation available
  try {
    const ask = async () => (await confirm(toolName, input)) === true;
    return ctx.requestUserInteraction ? (await ctx.requestUserInteraction(ask)) === true : await ask();
  } catch {
    return false;
  }
}

export function buildWebMcpTools(o: BuildOptions): WebMcpTool[] {
  const bound = { ...(o.bound ?? {}) };
  const stripped = [...new Set([...PAGE_SUPPLIED_PARAMS, ...Object.keys(bound)])];
  const defs = (((o.schema as { $defs?: { methods?: unknown } }).$defs?.methods ?? {}) as Record<string, Record<string, unknown>>);
  return selectMethods(o).map((method): WebMcpTool => {
    const name = toolNameFor(method);
    const readOnly = READ_ONLY_METHODS.has(method);
    const def = defs[method];
    const description = (typeof def?.description === "string" && def.description) || DESCRIPTIONS[method] || `Call the PLUR1BUS RPC method ${method}.`;
    const inputSchema = inputSchemaFor(o.schema, method, stripped);
    return {
      name,
      description: readOnly ? description : `${description} Changes data; the user is asked to confirm.`,
      inputSchema,
      annotations: {
        readOnlyHint: readOnly,
        ...(MEMORY_CONTENT.test(method) ? { untrustedContentHint: true } : {}),
        ...(readOnly ? {} : { consequentialHint: true }),
      },
      async execute(rawInput: unknown, ctx: ExecuteContext = {}): Promise<ToolResult> {
        if (rawInput === undefined || rawInput === null) rawInput = {};
        if (typeof rawInput !== "object" || Array.isArray(rawInput)) return text({ error: "E_INVALID_PARAMS", reason: "input-not-object" }, true);
        const input = Object.fromEntries(Object.entries(rawInput as Record<string, unknown>).filter(([k]) => !stripped.includes(k)));
        if (ctx.signal?.aborted) return text({ error: "E_CANCELLED", reason: "aborted" }, true);
        if (!readOnly && !(await askHuman(o.confirm, ctx, name, input))) return text({ error: "E_DENIED", reason: "user-declined" }, true);
        if (ctx.signal?.aborted) return text({ error: "E_CANCELLED", reason: "aborted" }, true);
        try {
          const result = await o.call(method, { ...input, ...bound }, ctx.signal ? { signal: ctx.signal } : undefined);
          return text(redactSecrets(result));
        } catch (err) {
          return text(safeError(err), true);
        }
      },
    };
  });
}
