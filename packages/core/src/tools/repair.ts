// Tool-call argument validation with one structured repair round (D97 item 1). A call whose arguments do not match
// the tool's JSON Schema is NOT executed. The model gets one structured repair message (which field, what was
// expected, what came) and one retry; a second failure becomes a typed `tool-call-invalid` result that the model
// sees and the trace records — never a crash, never a silent drop.
//
// The validator covers the JSON Schema subset the harness's own tool schemas use (type, required, properties,
// additionalProperties:false, enum, minimum/maximum, min/maxLength, pattern, items, min/maxItems). Swap in the core's
// shared validator when the dispatcher lands; `validateArgs` is the only seam.

export interface ValidationIssue {
  /** JSON pointer to the offending value; "" is the arguments object itself. */
  path: string;
  expected: string;
  got: string;
  message: string;
}

export interface RepairRequest {
  tool: string;
  args: unknown;
  issues: ValidationIssue[];
  /** The text to show the model. */
  message: string;
}

/** Returns corrected arguments, or undefined to give up. Called at most once per call. */
export type RepairHook = (req: RepairRequest) => Promise<unknown | undefined>;

export interface Callable<C = unknown, R = unknown> {
  name: string;
  inputSchema: Record<string, unknown>;
  execute(args: unknown, ctx: C): Promise<R>;
}

export interface ToolCallInvalid {
  isError: true;
  error: { code: "tool-call-invalid"; message: string; hint: string; issues: ValidationIssue[] };
}

type Schema = Record<string, any>;

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const show = (v: unknown): string => {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

function check(schema: Schema, value: unknown, path: string, out: ValidationIssue[]): void {
  const t = schema.type as string | undefined;
  const issue = (expected: string, got: string, message: string): void => void out.push({ path, expected, got, message });
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e: unknown) => e === value)) issue(`one of ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}`, show(value), "value is not one of the allowed values");
    return;
  }
  if (t === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return issue("object", typeOf(value), "must be an object");
    const obj = value as Record<string, unknown>;
    const props: Record<string, Schema> = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(obj, key)) out.push({ path: `${path}/${key}`, expected: props[key]?.type ?? "value", got: "missing", message: "required property missing" });
    for (const [key, sub] of Object.entries(props)) if (Object.hasOwn(obj, key)) check(sub, obj[key], `${path}/${key}`, out);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) if (!Object.hasOwn(props, key)) out.push({ path: `${path}/${key}`, expected: "no such property", got: typeOf(obj[key]), message: "unknown property" });
    }
    return;
  }
  if (t === "array") {
    if (!Array.isArray(value)) return issue("array", typeOf(value), "must be an array");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) issue(`at most ${schema.maxItems} items`, `${value.length} items`, `must have at most ${schema.maxItems} items`);
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issue(`at least ${schema.minItems} items`, `${value.length} items`, `must have at least ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => check(schema.items, v, `${path}/${i}`, out));
    return;
  }
  if (t === "string") {
    if (typeof value !== "string") return issue("string", typeOf(value), "must be a string");
    if (typeof schema.minLength === "number" && value.length < schema.minLength) issue(`string of at least ${schema.minLength} characters`, `${value.length} characters`, `must have at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) issue(`string of at most ${schema.maxLength} characters`, `${value.length} characters`, `must have at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) issue(`string matching ${schema.pattern}`, show(value), "does not match the required pattern");
    return;
  }
  if (t === "integer" || t === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (t === "integer" && !Number.isInteger(value))) return issue(t, typeOf(value) === "number" ? "number" : typeOf(value), `must be ${t === "integer" ? "an integer" : "a number"}`);
    if (typeof schema.minimum === "number" && value < schema.minimum) issue(`${t} ≥ ${schema.minimum}`, String(value), `must be at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) issue(`${t} ≤ ${schema.maximum}`, String(value), `must be at most ${schema.maximum}`);
    return;
  }
  if (t === "boolean" && typeof value !== "boolean") issue("boolean", typeOf(value), "must be a boolean");
}

export function validateArgs(schema: Record<string, unknown>, args: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  check(schema, args, "", out);
  return out;
}

export function repairMessage(tool: string, issues: ValidationIssue[]): string {
  const lines = issues.slice(0, 10).map((i) => `- ${i.path === "" ? "(arguments)" : i.path}: ${i.message}; expected ${i.expected}, got ${i.got}`);
  return `The call to ${tool} was not executed because its arguments are invalid:\n${lines.join("\n")}\nCall ${tool} again once with corrected arguments.`;
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
