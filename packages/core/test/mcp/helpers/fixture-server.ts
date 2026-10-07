// A local MCP fixture server (ADR-014, plan task 5). It is deliberately *rude*: it offers the deprecated Logging
// capability, and a tool makes it ask the client for Sampling and Roots, so the negative-capability tests can prove
// the client negotiates none of them and still works. Never touches the network beyond the loopback listener.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface FixtureState {
  /** Client capabilities as the server saw them in `initialize`. */
  clientCapabilities: unknown;
  clientVersion: unknown;
  setLevelCalls: number;
  calls: Array<{ name: string; args: unknown }>;
}

const text = (t: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], ...extra });

export const FIXTURE_TOOLS = [
  { name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "fail", description: "Always reports a tool error.", inputSchema: { type: "object", properties: {} } },
  { name: "hang", description: "Never answers.", inputSchema: { type: "object", properties: {} } },
  { name: "sleep", description: "Answers after n ms.", inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] } },
  { name: "change_tools", description: "Sends tools/list_changed.", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "Exits the process mid-call.", inputSchema: { type: "object", properties: {} } },
  { name: "pid", description: "The server's process id.", inputSchema: { type: "object", properties: {} } },
  { name: "grow", description: "Returns n bytes of text.", inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } },
  { name: "leak_env", description: "Prints an environment variable to stderr and returns it.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "probe_client", description: "Asks the client for sampling and roots, and reports what happened.", inputSchema: { type: "object", properties: {} } },
  { name: "log_now", description: "Sends a logging notification (a capability we never use).", inputSchema: { type: "object", properties: {} } },
  { name: "app", description: "A tool with an MCP App.", inputSchema: { type: "object", properties: {} }, _meta: { ui: { resourceUri: "ui://fixture/app" } } },
];

export function createFixtureServer(): { server: Server; state: FixtureState } {
  const state: FixtureState = { clientCapabilities: undefined, clientVersion: undefined, setLevelCalls: 0, calls: [] };
  // The server *offers* logging (and a rude client could use it); sampling/roots are server-initiated requests below.
  const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: { listChanged: true }, logging: {} } });
  server.oninitialized = () => { state.clientCapabilities = server.getClientCapabilities(); state.clientVersion = server.getClientVersion(); };
  server.setRequestHandler(SetLevelRequestSchema, async () => { state.setLevelCalls++; return {}; });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FIXTURE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params; const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    state.calls.push({ name, args });
    switch (name) {
      case "echo": return text(`echo:${String(args.text)}`);
      case "fail": return text("it broke", { isError: true });
      case "hang": return await new Promise<never>(() => { /* never settles */ });
      case "sleep": await new Promise((r) => setTimeout(r, Number(args.ms))); return text("slept");
      case "change_tools": await server.sendToolListChanged(); return text("changed");
      case "crash": process.exit(1); // eslint-disable-line no-unreachable
      case "pid": return text(String(process.pid));
      case "grow": return text("x".repeat(Number(args.n)));
      case "leak_env": {
        const v = process.env[String(args.name)] ?? "";
        process.stderr.write(`leaking ${v}\n`);
        return text(`value=${v}`);
      }
      case "log_now": await server.sendLoggingMessage({ level: "info", data: "hello from the fixture" }); return text("logged");
      case "probe_client": {
        const outcome = async (fn: () => Promise<unknown>) => { try { await fn(); return { ok: true }; } catch (e) { return { ok: false, code: (e as { code?: number }).code ?? null, message: String((e as Error).message) }; } };
        const sampling = await outcome(() => server.createMessage({ messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 8 }));
        const roots = await outcome(() => server.listRoots());
        return text(JSON.stringify({ sampling, roots, clientCapabilities: state.clientCapabilities ?? null, setLevelCalls: state.setLevelCalls }));
      }
      case "app": return text("app");
      default: return text(`unknown tool ${name}`, { isError: true });
    }
  });
  return { server, state };
}
