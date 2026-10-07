import { isRecord } from "../errors.ts";
import type { JsonObject, ToolArgumentRepair, ToolCall, ToolDefinition } from "../types.ts";

// NOTE: the same logic lives (unexported) in ../accumulate.ts for chat_completions and in ../gemini/. It is kept here,
// under src/anthropic/, because this change may only touch src/anthropic/** and src/responses/**; the responses adapter
// imports it from here. A follow-up outside this change moves it to src/ and lets chat_completions share it.

function parseArgs(text: string): { ok: true; value: JsonObject } | { ok: false; error: string } {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { return { ok: false, error: `arguments are not valid JSON: ${(e as Error).message}` }; }
  if (!isRecord(v)) return { ok: false, error: "arguments must be a JSON object" };
  return { ok: true, value: v as JsonObject };
}

/**
 * One finished tool call → `ToolCall`. The arguments are the text the model produced; an empty text (a tool that takes
 * no arguments: the wire sends no fragment at all) is `{}`. Text that is not a JSON object keeps `argumentsError`; the
 * repair hook (D97 supplies the real one) is asked at most once and a failing or declining hook never loses the turn.
 */
export async function finaliseToolCall(
  id: string, name: string, rawText: string, repair: ToolArgumentRepair | undefined, tools: ToolDefinition[] | undefined, signal: AbortSignal,
): Promise<ToolCall> {
  const raw = rawText === "" ? "{}" : rawText;
  const first = parseArgs(raw);
  if (first.ok) return { id, name, argumentsRaw: raw, arguments: first.value };
  const failed: ToolCall = { id, name, argumentsRaw: raw, argumentsError: first.error };
  if (!repair) return failed;
  let outcome;
  try {
    const input: Parameters<ToolArgumentRepair["repair"]>[0] = { call: { id, name, argumentsRaw: raw }, error: first.error, signal };
    const tool = tools?.find((t) => t.name === name);
    if (tool) input.tool = tool;
    outcome = await repair.repair(input);
  } catch (e) {
    if (signal.aborted) throw e;
    return failed;
  }
  if (!outcome) return failed;
  if ("arguments" in outcome) {
    if (!isRecord(outcome.arguments)) return failed;
    return { id, name, argumentsRaw: JSON.stringify(outcome.arguments), arguments: outcome.arguments, repaired: true };
  }
  const second = parseArgs(outcome.argumentsRaw);
  if (!second.ok) return failed;
  return { id, name, argumentsRaw: outcome.argumentsRaw, arguments: second.value, repaired: true };
}
