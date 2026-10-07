// The tool-call dispatcher (B1): resolve → validate → policy gate → execute under limits → provenance envelope.
// `call` never throws: every outcome, refusals and failures included, is an envelope the model sees and the trace records.
import { createHash } from "node:crypto";
import { decide, type ApprovalRequest, type Call, type CallFlags, type Clock, type Context, type Decision, type GrantSource, type SurfaceTrust } from "../policy/index.ts";
import type { ApprovalPort } from "./approval.ts";
import { repairMessage, validateArgs, type RepairHook, type ValidationIssue } from "./repair.ts";
import type { RegisteredTool, ToolRegistry, ToolTrust } from "./registry.ts";

/** Arguments are bounded before they are validated or hashed. */
export const MAX_ARGS_BYTES = 256 * 1024;
const MAX_MESSAGE = 500;

export interface ToolCallRequest { id: string; name: string; args: unknown }

export interface DispatchContext {
  agentId: string;
  /** The opaque principal the call runs under (D17). */
  principal: string;
  sessionId?: string;
  /** Trust of the surface the call originates from (D109 §5). */
  surface: SurfaceTrust;
  signal: AbortSignal;
}

export interface Timers { set(fn: () => void, ms: number): () => void }
const realTimers: Timers = { set(fn, ms) { const t = setTimeout(fn, ms); return () => clearTimeout(t); } };

/** D19 provenance (ADR-014 §3 shape). `system` is `tool:<name>` for what a tool produced, `harness:tools` for a refusal the harness made. */
export interface ToolProvenance {
  origin: { system: string; agent: string | null; principal: string; trust: ToolTrust };
  hops: number;
  transformedBy: string[];
}

export type ToolErrorCode =
  | "tool-unknown" | "tool-call-invalid" | "tool-denied" | "tool-not-approved" | "tool-timeout" | "tool-failed"
  | "tool-result-too-large" | "tool-result-invalid" | "aborted";

export interface ToolError { code: ToolErrorCode; message: string; issues?: ValidationIssue[]; hint?: string }
export type ToolDecisionMeta = "none" | "allow" | "approved" | "deny" | "ask-refused";

interface Common { callId: string; tool: string; provenance: ToolProvenance; meta: { decision: ToolDecisionMeta; durationMs: number; bytes: number } }
export type ToolResult = Common & ({ isError: false; value: unknown } | { isError: true; error: ToolError });

export interface ToolDispatcherDeps {
  registry: ToolRegistry;
  approvals: ApprovalPort;
  grants: GrantSource;
  clock: Clock;
  timers?: Timers;
  /** One structured repair round for invalid arguments (D97). */
  repair?: RepairHook;
  /** Extra policy context per call (tools.deny, overrides, taint, hand-off, subject kind …). Merged over the defaults. */
  policyContext?: (ctx: DispatchContext) => Partial<Context>;
}

/** Stable JSON: object keys sorted, so equal arguments hash equal. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const clip = (s: string): string => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s);
const errMsg = (e: unknown): string => clip(e instanceof Error ? e.message : String(e));

export class ToolDispatcher {
  readonly #d: ToolDispatcherDeps;
  constructor(d: ToolDispatcherDeps) { this.#d = d; }

  async call(req: ToolCallRequest, ctx: DispatchContext): Promise<ToolResult> {
    const started = this.#d.clock.now();
    const tool = typeof req.name === "string" ? this.#d.registry.get(req.name) : undefined;
    const fail = (code: ToolErrorCode, message: string, decision: ToolDecisionMeta, extra: Partial<ToolError> = {}, producedByTool = false): ToolResult => ({
      callId: req.id, tool: req.name, isError: true, error: { code, message: clip(message), ...extra },
      provenance: provenance(ctx, producedByTool && tool ? tool : null),
      meta: { decision, durationMs: Math.max(0, this.#d.clock.now() - started), bytes: 0 },
    });
    try {
      if (!tool) return fail("tool-unknown", `no tool named ${JSON.stringify(String(req.name).slice(0, 64))}`, "none");
      if (ctx.signal.aborted) return fail("aborted", "the call was aborted before it started", "none");

      // 1. arguments: bounded, validated, at most one repair round. An invalid call is neither gated nor run.
      let args = req.args;
      let issues = argIssues(tool, args);
      if (issues.length > 0 && this.#d.repair && !tooLarge(args)) {
        try {
          const fixed = await this.#d.repair({ tool: tool.name, args, issues, message: repairMessage(tool.name, issues) });
          if (fixed !== undefined) { args = fixed; issues = argIssues(tool, args); }
        } catch { /* the original issues stand */ }
      }
      if (issues.length > 0) {
        return fail("tool-call-invalid", `invalid arguments for ${tool.name}: ${issues.slice(0, 5).map((i) => `${i.path || "(arguments)"} ${i.message}`).join("; ")}`, "none",
          { issues: issues.slice(0, 10), hint: `Call ${tool.name} again with arguments that match its input schema.` });
      }

      // 2. policy gate.
      let call: Call;
      try { call = this.#buildCall(tool, args); }
      catch (e) { return fail("tool-denied", `the call could not be classified: ${errMsg(e)}`, "deny"); } // RULING: a tool whose classify() throws is refused, never allowed
      const decision = this.#decide(call, ctx);
      let via: ToolDecisionMeta = "allow";
      if (decision.kind === "deny") return fail("tool-denied", `refused by policy (${decision.reason}: ${decision.rule})`, "deny");
      if (decision.kind === "ask") {
        const answer = await this.#ask(tool, req, args, decision, ctx);
        if (answer === "aborted") return fail("aborted", "the call was aborted while waiting for approval", "none");
        if (!answer.approved) return fail("tool-not-approved", answer.reason ? `not approved: ${answer.reason}` : "not approved", "ask-refused");
        via = "approved";
      }
      if (ctx.signal.aborted) return fail("aborted", "the call was aborted before it ran", via);

      // 3. execute under the tool's own hard limits and the caller's abort.
      const out = await this.#run(tool, args, ctx);
      if (out.kind === "timeout") return fail("tool-timeout", `${tool.name} exceeded its ${tool.limits.timeoutMs} ms limit`, via, {}, true);
      if (out.kind === "aborted") return fail("aborted", `${tool.name} was aborted`, via, {}, true);
      if (out.kind === "failed") return fail("tool-failed", `${tool.name} failed: ${out.message}`, via, {}, true);

      // 4. bounded, serialisable result. RULING: over the limit is an error, never a cut-off JSON value.
      let json: string | undefined;
      try { json = JSON.stringify(out.value === undefined ? null : out.value); } catch { json = undefined; }
      if (json === undefined) return fail("tool-result-invalid", `${tool.name} returned a value that is not JSON`, via, {}, true);
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > tool.limits.maxResultBytes) return fail("tool-result-too-large", `${tool.name} returned ${bytes} bytes, over its ${tool.limits.maxResultBytes}-byte limit`, via, {}, true);
      return {
        callId: req.id, tool: tool.name, isError: false, value: JSON.parse(json) as unknown,
        provenance: provenance(ctx, tool), meta: { decision: via, durationMs: Math.max(0, this.#d.clock.now() - started), bytes },
      };
    } catch (e) {
      return fail("tool-failed", `internal error: ${errMsg(e)}`, "none"); // never a throw out of the dispatcher
    }
  }

  #buildCall(tool: RegisteredTool, args: unknown): Call {
    const c = tool.classify?.(args);
    // RULING: absent an explicit classification the call counts as outside the roots (fail closed: approval for anything above a read).
    const flags: CallFlags = { outsideRoots: true, denyListHit: false, ...(c?.flags ?? {}) };
    const targets = c?.targets ? [...c.targets] : undefined;
    const hash = createHash("sha256").update(canonicalJson({ capability: tool.capability, tool: tool.name, args, targets: targets ?? [] })).digest("hex");
    return { capability: tool.capability, tool: tool.name, effect: tool.effect, flags, ...(targets ? { targets } : {}), ...(c?.access ? { access: c.access } : {}), actionHash: hash };
  }

  #decide(call: Call, ctx: DispatchContext): Decision {
    const context: Context = {
      principal: { person: ctx.principal }, subject: { kind: "agent", agentId: ctx.agentId }, surface: ctx.surface,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), ...(this.#d.policyContext?.(ctx) ?? {}),
    };
    try { return decide(call, context, { grants: this.#d.grants, clock: this.#d.clock }); }
    catch { return { kind: "deny", reason: "policy-never", rule: "evaluator-error" }; } // fail closed
  }

  async #ask(tool: RegisteredTool, req: ToolCallRequest, args: unknown, d: Extract<Decision, { kind: "ask" }>, ctx: DispatchContext): Promise<{ approved: boolean; reason?: string } | "aborted"> {
    const request: ApprovalRequest = d.request;
    const pending = this.#d.approvals.request({
      request, callId: req.id, tool: tool.name, args, agentId: ctx.agentId, principal: ctx.principal,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), park: d.park, signal: ctx.signal,
    }).then((a) => a, (e: unknown) => ({ approved: false, reason: `approval failed: ${errMsg(e)}` }));
    const r = await raceAbort(pending, ctx.signal);
    if (r === "aborted") return "aborted";
    // RULING: only a literal `approved: true` counts; any other shape is a refusal.
    if (!r || typeof r !== "object" || (r as { approved?: unknown }).approved !== true) {
      const reason = (r as { reason?: unknown } | undefined)?.reason;
      return { approved: false, ...(typeof reason === "string" ? { reason: clip(reason) } : {}) };
    }
    return { approved: true };
  }

  #run(tool: RegisteredTool, args: unknown, ctx: DispatchContext): Promise<{ kind: "ok"; value: unknown } | { kind: "timeout" } | { kind: "aborted" } | { kind: "failed"; message: string }> {
    const timers = this.#d.timers ?? realTimers;
    const ac = new AbortController();
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: Parameters<typeof resolve>[0]): void => { if (done) return; done = true; cancel(); ctx.signal.removeEventListener("abort", onAbort); resolve(r); };
      const onAbort = (): void => { finish({ kind: "aborted" }); ac.abort(ctx.signal.reason); };
      const cancel = timers.set(() => { finish({ kind: "timeout" }); ac.abort(new Error("timeout")); }, tool.limits.timeoutMs);
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => tool.execute(args, { signal: ac.signal, agentId: ctx.agentId, principal: ctx.principal, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}) }))
        .then((value) => finish({ kind: "ok", value }), (e: unknown) => finish({ kind: "failed", message: errMsg(e) }));
    });
  }
}

function tooLarge(args: unknown): boolean {
  try { const s = JSON.stringify(args); return s !== undefined && Buffer.byteLength(s, "utf8") > MAX_ARGS_BYTES; } catch { return true; }
}

function argIssues(tool: RegisteredTool, args: unknown): ValidationIssue[] {
  if (tooLarge(args)) return [{ path: "", expected: `at most ${MAX_ARGS_BYTES} bytes`, got: "larger", message: "arguments are too large (or not JSON)" }];
  return validateArgs(tool.inputSchema, args);
}

function provenance(ctx: DispatchContext, tool: RegisteredTool | null): ToolProvenance {
  // RULING: a refusal the harness made is attributed to `harness:tools` (first-party); what a tool produced to `tool:<name>` with the tool's own trust.
  return {
    origin: { system: tool ? `tool:${tool.name}` : "harness:tools", agent: ctx.agentId, principal: ctx.principal, trust: tool ? tool.trust : "first-party" },
    hops: 1, transformedBy: [],
  };
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | "aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const on = (): void => resolve("aborted");
    signal.addEventListener("abort", on, { once: true });
    void p.then((v) => { signal.removeEventListener("abort", on); resolve(v); });
  });
}
