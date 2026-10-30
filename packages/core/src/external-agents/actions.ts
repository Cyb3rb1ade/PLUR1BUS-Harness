/** #820: D109 decisions and single-use ACP grants bind exact ToolCall-ID and canonical action bytes. */
import { createHash } from "node:crypto";
import type { ApprovalService } from "../approvals/service.ts";
import type { ApprovalAnswer, ApprovalAsk } from "../tools/approval.ts";
import { decide, type Call, type Context } from "../policy/decide.ts";
import { canonicalJson } from "../tools/dispatcher.ts";

export interface AcpAction {
  callId: string;
  capability: "fs.write" | "shell.exec";
  tool: string;
  args: Record<string, unknown>;
  targets: string[];
}

/** Exact paths, bytes and argv participate; no title or agent-supplied hash is trusted. */
export function acpActionHash(action: AcpAction): string {
  return createHash("sha256").update(canonicalJson({ capability: action.capability, tool: action.tool,
    args: action.args, targets: action.targets })).digest("hex");
}

/** One instance per run. Pending approvals expire with its AbortSignal. */
interface ActionOptions {
    signal: AbortSignal; agentId: string; person: string | null; sessionId: string; turnId: string;
    approvals(): Promise<ApprovalService | null>; context?: Partial<Context> | (() => Partial<Context>);
}

export class AcpActions {
  readonly #o: ActionOptions;
  readonly #grants = new Map<string, { service: ApprovalService; ask: ApprovalAsk; answer: ApprovalAnswer }>();
  constructor(options: ActionOptions) { this.#o = options; }

  async #decide(action: AcpAction, forceApproval: boolean) {
    this.#o.signal.throwIfAborted();
    const service = await this.#o.approvals();
    this.#o.signal.throwIfAborted();
    const actionHash = acpActionHash(action);
    const call: Call = { capability: action.capability, tool: action.tool, actionHash, targets: action.targets,
      access: "write", flags: { outsideRoots: false, denyListHit: false, sandboxed: true } };
    const configured = typeof this.#o.context === "function" ? this.#o.context() : this.#o.context;
    const inherited = service?.policyContext()({ agentId: this.#o.agentId, principal: this.#o.person ?? "headless",
      sessionId: this.#o.sessionId, signal: this.#o.signal, surface: 2 }) ?? {};
    const context: Context = { ...inherited, ...configured, principal: { person: this.#o.person ?? "headless" },
      subject: { kind: "acp-agent", agentId: this.#o.agentId }, surface: 2, sessionId: this.#o.sessionId,
      ...(forceApproval ? { overrides: { ...configured?.overrides, [action.capability]: "approval" } } : {}) };
    const decision = decide(call, context, { grants: { list: () => [], get: () => undefined }, clock: { now: Date.now } });
    return { decision, service, actionHash };
  }

  /** Permission requests select only an offered allow_once option and hold approval until the matching action. */
  async permission(action: AcpAction, options: readonly unknown[]): Promise<Record<string, unknown>> {
    const option = options.find(v => typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "allow_once") as { optionId?: unknown } | undefined;
    if (typeof option?.optionId !== "string") return { outcome: { outcome: "cancelled" } };
    const { decision, service, actionHash } = await this.#decide(action, true);
    if (decision.kind !== "ask" || !service || !this.#o.person) return { outcome: { outcome: "cancelled" } };
    const ask = this.#ask(action, decision.request, actionHash);
    const answer = await service.request(ask);
    this.#o.signal.throwIfAborted();
    if (!answer.approved) return { outcome: { outcome: "cancelled" } };
    this.#grants.set(action.callId + ":" + actionHash, { service, ask, answer });
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  /** Every side effect passes decide, even when a permission request preceded it. */
  async authorize(action: AcpAction): Promise<void> {
    const { decision, service, actionHash } = await this.#decide(action, false);
    if (decision.kind === "deny") throw new Error("policy-denied");
    const key = action.callId + ":" + actionHash;
    const granted = this.#grants.get(key);
    if (granted) {
      this.#grants.delete(key);
      this.#o.signal.throwIfAborted();
      if (!granted.service.begin(granted.answer, granted.ask)) throw new Error("not-approved");
      return;
    }
    // A held grant for another call or different bytes never becomes a replacement prompt implicitly.
    if ([...this.#grants.keys()].some(held => held.startsWith(action.callId + ":") || held.endsWith(":" + actionHash)))
      throw new Error("not-approved");
    if (decision.kind === "allow") return;
    if (!service || !this.#o.person) throw new Error("not-approved");
    const ask = this.#ask(action, decision.request, actionHash);
    const answer = await service.request(ask);
    this.#o.signal.throwIfAborted();
    if (!answer.approved || !service.begin(answer, ask)) throw new Error("not-approved");
  }

  #ask(action: AcpAction, request: ApprovalAsk["request"], actionHash: string): ApprovalAsk {
    return { request: { ...request, actionHash, grantOptions: request.grantOptions.filter(v => v.scope === "once") },
      callId: action.callId, tool: action.tool, args: action.args, agentId: this.#o.agentId,
      principal: this.#o.person!, sessionId: this.#o.sessionId, turnId: this.#o.turnId, park: false,
      signal: this.#o.signal, subjectKind: "acp-agent", targets: action.targets, access: "write" };
  }
}
