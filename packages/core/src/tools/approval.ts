// The approval seam. The dispatcher depends on this port only; `approvals/service.ts` implements it.
import type { ApprovalRequest, GrantScope, SubjectKind } from "../policy/index.ts";

export interface ApprovalAsk {
  request: ApprovalRequest;
  callId: string;
  tool: string;
  args: unknown;
  agentId: string;
  principal: string;
  sessionId?: string;
  /** Headless run: nobody is asked and nothing parks (D109 §9, owner ruling of D5); the port refuses at once. */
  park: boolean;
  signal: AbortSignal;
  // The §6 binding and what the person is shown, computed by the harness from the call (never from the model).
  /** Default `agent`. */
  subjectKind?: SubjectKind;
  /** Default: the call id. */
  turnId?: string;
  /** The D36/D105 task; task grants exist only when this is set. */
  taskId?: string;
  projectId?: string;
  /** Canonical resolved targets and access of the call: what a path grant is narrowed to. */
  targets?: readonly string[];
  access?: "read" | "write";
}

export interface ApprovalAnswer {
  approved: boolean;
  reason?: string;
  /** Set on every answer to a stored request, approved or not. */
  requestId?: string;
  /** The grants the person's decision created (a once grant bound to the action, or the path/capability grants of a wider scope). */
  grantIds?: readonly string[];
  scope?: GrantScope;
  /** The foreground wait ended and the request stays open (D109 §5): not approved now, decidable until it expires. */
  parked?: boolean;
}

export interface ApprovalPort {
  /** Resolves with the person's decision. A throw, a rejection or an abort counts as "not approved". Recording a grant is the port's business. */
  request(ask: ApprovalAsk): Promise<ApprovalAnswer>;
  /**
   * Execution start for an approved answer: consumes the approval (single use, bound to the ask) and its once grant atomically.
   * `false` means the call must not run. A port without it (tests, the old seam) is trusted as before.
   */
  begin?(answer: ApprovalAnswer, ask: ApprovalAsk): boolean;
}
