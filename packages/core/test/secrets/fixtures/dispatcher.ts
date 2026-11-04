// Real dispatcher with one read-only tool; tests vary values and secret sources without bypassing the result boundary.
import { ToolDispatcher, type DispatchContext, type ToolResult } from "../../../src/tools/dispatcher.ts";
import { ToolRegistry, type ToolDef } from "../../../src/tools/registry.ts";
import type { Grant } from "../../../src/policy/index.ts";

export function dispatcherProbe(execute: ToolDef["execute"], secrets: () => Iterable<string>, over: Partial<ToolDef> = {}, secretForms?: () => readonly string[]) {
  const registry = new ToolRegistry();
  registry.register({ name: "probe.print", description: "prints a fixture", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    capability: "sys.read", effect: "read", risk: "low", trust: "operator-vetted", execute, ...over });
  const dispatcher = new ToolDispatcher({ registry, secrets, ...(secretForms ? { secretForms } : {}), approvals: { request: async () => ({ approved: false }) },
    grants: { list: () => [] as readonly Grant[], get: () => undefined }, clock: { now: Date.now } });
  const context: DispatchContext = { agentId: "fixture", principal: "user:fixture:o", sessionId: "s1", surface: 3,
    signal: new AbortController().signal };
  return { run: (): Promise<ToolResult> => dispatcher.call({ id: "probe", name: "probe.print", args: {} }, context) };
}
