// The approval seam. The approval store and its surfaces are another task; the dispatcher depends on this port only.
import type { ApprovalRequest } from "../policy/index.ts";

export interface ApprovalAsk {
  request: ApprovalRequest;
  callId: string;
  tool: string;
  args: unknown;
  agentId: string;
  principal: string;
  sessionId?: string;
  /** Headless run: the port parks the job and notifies (D109 §9) instead of prompting. */
  park: boolean;
  signal: AbortSignal;
}

export interface ApprovalAnswer {
  approved: boolean;
  reason?: string;
}

export interface ApprovalPort {
  /** Resolves with the person's decision. A throw, a rejection or an abort counts as "not approved". Recording a grant is the port's business. */
  request(ask: ApprovalAsk): Promise<ApprovalAnswer>;
}
