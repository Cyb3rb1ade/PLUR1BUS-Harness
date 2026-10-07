// The tool-call dispatcher (B1): resolve → validate → policy gate → execute under limits → provenance envelope.
// `call` never throws: every outcome, refusals and failures included, is an envelope the model sees and the trace records.
import { createHash } from "node:crypto";
import { decide, type ApprovalRequest, type Call, type CallFlags, type Clock, type Context, type Decision, type GrantSource, type SurfaceTrust } from "../policy/index.ts";
import type { PolicyAudit, PolicyAuditFields } from "../policy/audit.ts";
import type { ApprovalAnswer, ApprovalAsk, ApprovalPort } from "./approval.ts";
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
  /** The D36/D105 task the call belongs to: task grants, the repeat-denial rule and the prompt cap are per task. */
  taskId?: string;
  /** The turn the call belongs to (the approval binding, D109 §6). Default: the call id. */
  turnId?: string;
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

/** The write side of grant use (the `GrantStore` provides it): standing grants record their use, `once` is consumed atomically at execution start. */
export interface GrantUse {
  markUsed(id: string): void;
  consumeOnce(id: string, b: { person: string; agent: string; actionHash: string }): boolean;
}

export interface ToolDispatcherDeps {
  registry: ToolRegistry;
  approvals: ApprovalPort;
  grants: GrantSource;
  /** Without it a `once` grant is refused (it could be replayed) and a standing grant's use goes unrecorded. */
  grantUse?: GrantUse;
  /**
   * D109 §9: every decision and its outcome is written here. A decision that cannot be recorded refuses the call, so nothing runs
   * unrecorded; the outcome line is best effort (the call already ran).
   */
  audit?: PolicyAudit;
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

  /** What a provider is told about the registered tools. */
  describe(): ReturnType<ToolRegistry["describe"]> { return this.#d.registry.describe(); }

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
      catch (e) { // RULING: a tool whose classify() throws is refused, never allowed
        this.#auditSoft("policy.decision", { ...this.#who(ctx, undefined), tool: tool.name, capability: tool.capability, outcome: "never", rule: "classify-failed" });
        return fail("tool-denied", `the call could not be classified: ${errMsg(e)}`, "deny");
      }
      const { decision, context } = this.#decide(call, ctx);
      let via: ToolDecisionMeta = "allow";
      const argsBytes = argsSize(args);
      const base: PolicyAuditFields = {
        ...this.#who(ctx, context), tool: tool.name, capability: tool.capability, effect: tool.effect, risk: tool.risk, actionHash: call.actionHash, surface: ctx.surface,
        ...(call.targets ? { targets: call.targets } : {}), flags: call.flags as unknown as Record<string, boolean>, argsBytes,
      };
      const decisionFields: PolicyAuditFields = decision.kind === "allow"
        ? { ...base, outcome: "allowed", via: decision.via, ...(decision.grantId ? { grantId: decision.grantId } : {}) }
        : decision.kind === "ask" ? { ...base, outcome: "approval", via: "ask", rule: decision.why }
        : { ...base, outcome: "never", rule: decision.rule, reason: decision.reason };
      if (decision.kind === "deny") {
        this.#auditSoft("policy.decision", decisionFields);
        return fail("tool-denied", `refused by policy (${decision.reason}: ${decision.rule})`, "deny");
      }
      try { this.#d.audit?.record("policy.decision", decisionFields); }
      catch { return fail("tool-denied", "the audit trail is unavailable; nothing runs unrecorded", "deny"); }
      const out = (r: ToolResult): ToolResult => this.#outcome(base, r);

      if (decision.kind === "ask") {
        const asked = await this.#ask(tool, req, args, decision, ctx, context, call);
        if (asked === "aborted") return out(fail("aborted", "the call was aborted while waiting for approval", "none"));
        if (!asked.answer.approved) return out(fail("tool-not-approved", asked.answer.reason ? `not approved: ${asked.answer.reason}` : "not approved", "ask-refused"));
        // Execution start of an approved answer: the approval (and its once grant) is consumed atomically, single use.
        let began = true;
        try { began = this.#d.approvals.begin ? this.#d.approvals.begin(asked.answer, asked.ask) === true : true; } catch { began = false; }
        if (!began) return out(fail("tool-not-approved", "not approved: the approval could not be used (already used, expired or bound to another action)", "ask-refused"));
        via = "approved";
      } else if (decision.via === "grant" && decision.grantId) {
        const refusal = this.#useGrant(decision.grantId);
        if (refusal) return out(fail("tool-not-approved", refusal, "ask-refused"));
      }
      if (ctx.signal.aborted) return out(fail("aborted", "the call was aborted before it ran", via));

      // 3. execute under the tool's own hard limits and the caller's abort.
      const ran = await this.#run(tool, args, ctx);
      if (ran.kind === "timeout") return out(fail("tool-timeout", `${tool.name} exceeded its ${tool.limits.timeoutMs} ms limit`, via, {}, true));
      if (ran.kind === "aborted") return out(fail("aborted", `${tool.name} was aborted`, via, {}, true));
      if (ran.kind === "failed") return out(fail("tool-failed", `${tool.name} failed: ${ran.message}`, via, {}, true));

      // 4. bounded, serialisable result. RULING: over the limit is an error, never a cut-off JSON value.
      let json: string | undefined;
      try { json = JSON.stringify(ran.value === undefined ? null : ran.value); } catch { json = undefined; }
      if (json === undefined) return out(fail("tool-result-invalid", `${tool.name} returned a value that is not JSON`, via, {}, true));
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > tool.limits.maxResultBytes) return out(fail("tool-result-too-large", `${tool.name} returned ${bytes} bytes, over its ${tool.limits.maxResultBytes}-byte limit`, via, {}, true));
      return out({
        callId: req.id, tool: tool.name, isError: false, value: JSON.parse(json) as unknown,
        provenance: provenance(ctx, tool), meta: { decision: via, durationMs: Math.max(0, this.#d.clock.now() - started), bytes },
      });
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

  /** The decision and the exact context it was made under (the approval request is bound to the same context). */
  #decide(call: Call, ctx: DispatchContext): { decision: Decision; context: Context } {
    const baseCtx: Context = {
      principal: { person: ctx.principal }, subject: { kind: "agent", agentId: ctx.agentId }, surface: ctx.surface,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    };
    try {
      // The hook is inside the guard: a hook that throws (a broken approval chain, an unwritable audit line) is a refusal, never an allow.
      const context: Context = { ...baseCtx, ...(this.#d.policyContext?.(ctx) ?? {}) };
      try { return { decision: decide(call, context, { grants: this.#d.grants, clock: this.#d.clock }), context }; }
      catch { return { decision: { kind: "deny", reason: "policy-never", rule: "evaluator-error" }, context }; } // fail closed
    } catch {
      return { decision: { kind: "deny", reason: "policy-never", rule: "context-unavailable" }, context: baseCtx };
    }
  }

  async #ask(tool: RegisteredTool, req: ToolCallRequest, args: unknown, d: Extract<Decision, { kind: "ask" }>, ctx: DispatchContext, context: Context, call: Call): Promise<{ answer: ApprovalAnswer; ask: ApprovalAsk } | "aborted"> {
    const request: ApprovalRequest = d.request;
    const ask: ApprovalAsk = {
      request, callId: req.id, tool: tool.name, args, agentId: ctx.agentId, principal: ctx.principal,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), park: d.park, signal: ctx.signal,
      subjectKind: context.subject.kind, turnId: ctx.turnId ?? req.id,
      ...(context.taskId ?? ctx.taskId ? { taskId: (context.taskId ?? ctx.taskId)! } : {}), ...(context.projectId ? { projectId: context.projectId } : {}),
      ...(call.targets ? { targets: call.targets } : {}), ...(call.access ? { access: call.access } : {}),
    };
    const pending = this.#d.approvals.request(ask).then((a) => a, (e: unknown) => ({ approved: false, reason: `approval failed: ${errMsg(e)}` } as ApprovalAnswer));
    const r = await raceAbort(pending, ctx.signal);
    if (r === "aborted") return "aborted";
    // RULING: only a literal `approved: true` counts; any other shape is a refusal.
    if (!r || typeof r !== "object" || (r as { approved?: unknown }).approved !== true) {
      const reason = (r as { reason?: unknown } | undefined)?.reason;
      return { answer: { approved: false, ...(typeof reason === "string" ? { reason: clip(reason) } : {}) }, ask };
    }
    return { answer: r, ask };
  }

  /** Start of a call allowed by a grant: a `once` grant is consumed atomically, a standing grant records its use. Returns a refusal text, or null. */
  #useGrant(id: string): string | null {
    try {
      const g = this.#d.grants.get(id);
      if (!g) return "the grant that allowed this call no longer exists";
      if (g.scope === "once") {
        if (!this.#d.grantUse) return "a one-time grant cannot be consumed here, so it is not used";
        if (!this.#d.grantUse.consumeOnce(id, { person: g.person, agent: g.agent, actionHash: g.actionHash ?? "" })) return "the one-time grant was already used";
      } else this.#d.grantUse?.markUsed(id);
      return null;
    } catch {
      return "the use of the grant could not be recorded, so the call does not run";
    }
  }

  #who(ctx: DispatchContext, context: Context | undefined): PolicyAuditFields {
    return {
      person: ctx.principal, agentId: ctx.agentId, subjectKind: context?.subject.kind ?? "agent",
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), ...((context?.taskId ?? ctx.taskId) ? { taskId: (context?.taskId ?? ctx.taskId)! } : {}),
      ...(context?.headless ? { jobId: context.headless.jobId } : {}),
    };
  }

  #auditSoft(action: "policy.decision" | "policy.outcome", f: PolicyAuditFields): void {
    try { this.#d.audit?.record(action, f); } catch { /* the refusal stands */ }
  }

  /** What happened after the decision: a code and sizes, never the result. Best effort: the call has already run (or been refused). */
  #outcome(base: PolicyAuditFields, r: ToolResult): ToolResult {
    if (!this.#d.audit) return r;
    const outcome = !r.isError ? "executed" : r.error.code === "tool-not-approved" ? "refused" : r.error.code === "aborted" ? "aborted" : "failed";
    this.#auditSoft("policy.outcome", {
      ...base, outcome, durationMs: r.meta.durationMs, resultBytes: r.meta.bytes, ...(r.isError ? { resultCode: r.error.code } : {}),
    });
    return r;
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

function argsSize(args: unknown): number {
  try { return Buffer.byteLength(canonicalJson(args), "utf8"); } catch { return 0; }
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
