// Test helper since D120 T1-a. It runs a tool's execute directly after validation and one repair round, so it must
// not live in src, where nothing may execute a tool outside ToolDispatcher. Production validation and the repair
// round are step 1 of ToolDispatcher.call.
import { repairMessage, validateArgs, type RepairHook, type ToolCallInvalid, type ValidationIssue } from "../../src/tools/repair.ts";

export interface Callable<C = unknown, R = unknown> {
  name: string;
  inputSchema: Record<string, unknown>;
  execute(args: unknown, ctx: C): Promise<R>;
}

function invalid(tool: string, issues: ValidationIssue[]): ToolCallInvalid {
  return {
    isError: true,
    error: {
      code: "tool-call-invalid",
      message: `invalid arguments for ${tool}: ${issues.slice(0, 5).map((i) => `${i.path || "(arguments)"} ${i.message}`).join("; ")}`,
      hint: `Check the tool's input schema and call ${tool} with arguments that match it, or use a different approach.`,
      issues: issues.slice(0, 10),
    },
  };
}

/**
 * Validate, run at most one repair round, execute. `repairRounds` is for the trace. Exceptions thrown by the tool
 * itself propagate: a tool turns its own failures into `isError` results.
 */
export async function callWithRepair<C, R>(
  tool: Callable<C, R>,
  args: unknown,
  opts: { repair?: RepairHook; ctx?: C } = {},
): Promise<{ repairRounds: 0 | 1; result: R | ToolCallInvalid }> {
  const ctx = (opts.ctx ?? {}) as C;
  let issues = validateArgs(tool.inputSchema, args);
  if (issues.length === 0) return { repairRounds: 0, result: await tool.execute(args, ctx) };
  if (!opts.repair) return { repairRounds: 0, result: invalid(tool.name, issues) };
  let fixed: unknown;
  try {
    fixed = await opts.repair({ tool: tool.name, args, issues, message: repairMessage(tool.name, issues) });
  } catch {
    return { repairRounds: 1, result: invalid(tool.name, issues) };
  }
  if (fixed === undefined) return { repairRounds: 1, result: invalid(tool.name, issues) };
  issues = validateArgs(tool.inputSchema, fixed);
  if (issues.length > 0) return { repairRounds: 1, result: invalid(tool.name, issues) };
  return { repairRounds: 1, result: await tool.execute(fixed, ctx) };
}
