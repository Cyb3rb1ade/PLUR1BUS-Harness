// The tool registry (B1): what tools exist, what they accept, what they may do. Registration is fail-closed; the
// registry never executes anything (that is `dispatcher.ts`, behind the policy gate).
import { CAPABILITIES, RISKS, effectRank, isEffect, riskRank, type CallFlags, type Effect, type Risk } from "../policy/index.ts";

/** Hard caps no tool may exceed, whatever it declares. */
export const HARD_MAX_TIMEOUT_MS = 300_000;
export const HARD_MAX_RESULT_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;

/** D19 trust of the tool's origin. RULING: a tool that does not declare it is `untrusted` (fail closed). */
export type ToolTrust = "first-party" | "operator-vetted" | "untrusted";

export interface ToolLimits { timeoutMs: number; maxResultBytes: number }

export interface ToolRunContext {
  /** Aborted on timeout or when the caller aborts; a well-behaved tool stops. */
  signal: AbortSignal;
  agentId: string;
  principal: string;
  sessionId?: string;
}

/** What the tool knows about a call that the policy needs (D109 §2). Flags are computed by the harness path layer, not the model. */
export interface ToolClassification {
  flags?: Partial<CallFlags>;
  targets?: readonly string[];
  access?: "read" | "write";
}

export interface ToolDef {
  /** `[a-z][a-z0-9_.-]{0,63}`. */
  name: string;
  description: string;
  /** JSON Schema (object) of the parameters; validated by `validateArgs` (`repair.ts`). */
  inputSchema: Record<string, unknown>;
  /** A D109 capability id (`policy/capabilities.ts`). */
  capability: string;
  effect: Effect;
  /** Risk class; never below the capability's base risk. */
  risk: Risk;
  trust?: ToolTrust;
  limits?: Partial<ToolLimits>;
  classify?(args: unknown): ToolClassification;
  execute(args: unknown, ctx: ToolRunContext): Promise<unknown>;
}

export interface RegisteredTool extends Omit<ToolDef, "limits" | "trust"> { readonly limits: ToolLimits; readonly trust: ToolTrust }
export interface ToolDescription { name: string; description: string; inputSchema: Record<string, unknown>; risk: Risk }

export type RegistryReason = "name" | "description" | "schema" | "capability" | "effect" | "risk" | "limits" | "duplicate";
export class RegistryError extends Error {
  readonly reason: RegistryReason;
  constructor(reason: RegistryReason, message: string) { super(message); this.name = "RegistryError"; this.reason = reason; }
}

const NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  get size(): number { return this.#tools.size; }

  register(d: ToolDef): void {
    const bad = (r: RegistryReason, m: string): never => { throw new RegistryError(r, `tool ${JSON.stringify(d.name)}: ${m}`); };
    if (typeof d.name !== "string" || !NAME.test(d.name)) bad("name", "name must match [a-z][a-z0-9_.-]{0,63}");
    if (this.#tools.has(d.name)) bad("duplicate", "already registered");
    if (typeof d.description !== "string" || d.description.trim() === "") bad("description", "description is required");
    if (!d.inputSchema || typeof d.inputSchema !== "object" || d.inputSchema.type !== "object") bad("schema", "inputSchema must be an object schema");
    const cap = CAPABILITIES.get(d.capability);
    if (!cap) return bad("capability", `unknown capability ${JSON.stringify(d.capability)}`);
    if (!isEffect(d.effect)) bad("effect", "unknown effect");
    // The policy raises, never lowers, the capability's intrinsic effect; a tool declaring less is a wrong declaration.
    if (effectRank(d.effect) < effectRank(cap.intrinsicEffect)) bad("effect", `effect is below ${cap.id}'s intrinsic effect ${cap.intrinsicEffect}`);
    if (!(RISKS as readonly string[]).includes(d.risk)) bad("risk", "unknown risk class");
    if (riskRank(d.risk) < riskRank(cap.baseRisk)) bad("risk", `risk is below ${cap.id}'s base risk ${cap.baseRisk}`);
    const timeoutMs = d.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResultBytes = d.limits?.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HARD_MAX_TIMEOUT_MS) bad("limits", `timeoutMs must be 1..${HARD_MAX_TIMEOUT_MS}`);
    if (!Number.isInteger(maxResultBytes) || maxResultBytes < 1 || maxResultBytes > HARD_MAX_RESULT_BYTES) bad("limits", `maxResultBytes must be 1..${HARD_MAX_RESULT_BYTES}`);
    let schema: Record<string, unknown>;
    try { schema = JSON.parse(JSON.stringify(d.inputSchema)) as Record<string, unknown>; } catch { return bad("schema", "inputSchema is not JSON"); }
    this.#tools.set(d.name, deepFreeze({
      name: d.name, description: d.description, inputSchema: schema, capability: cap.id, effect: d.effect, risk: d.risk,
      trust: d.trust ?? "untrusted", limits: { timeoutMs, maxResultBytes },
      ...(d.classify ? { classify: d.classify } : {}), execute: d.execute,
    }));
  }

  get(name: string): RegisteredTool | undefined { return this.#tools.get(name); }

  /** What a provider is told about the tools; nothing executable. */
  describe(): ToolDescription[] {
    return [...this.#tools.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, risk: t.risk }));
  }
}
