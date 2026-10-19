// D104: sender validation/one repair, receiver authority check, then an explicit ack before execution.
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import handoffSchema from './schemas/handoff.schema.json' with { type: 'json' };
import returnSchema from './schemas/return.schema.json' with { type: 'json' };
import ackSchema from './schemas/ack.schema.json' with { type: 'json' };
import { assertSchema, validateArguments } from '../toolcall/validation.ts';
import type { ApprovalStore } from '../approvals/store.ts';
import type { GrantStore } from '../grants/store.ts';
import { CollabError } from './errors.ts';

export { handoffSchema, returnSchema, ackSchema };
export const HANDOFF_TOKEN_CAP = 2000;
/** Byte-level tokenizers cannot need more tokens than UTF-8 bytes. This upper bound fails closed without a model tokenizer. */
export const handoffTokenBound = (text: string): number => Buffer.byteLength(text, 'utf8');
export interface Handoff {
  schema: 'plur1bus.handoff/1'; id: string; kind: 'consult' | 'delegate' | 'handoff';
  from: { agent: string; session: string }; to: { agent: string } | { role: string };
  task: { id: string; project: string; card?: string }; objective: string; why?: string; doneWhen?: string[];
  constraints: { must: string[]; mustNot: string[]; scope: { paths: string[]; tools: string[] } };
  authority: { mayDecide: string[]; mustAsk: string[]; approvalsHeld: string[] };
  budget: { tokens: number; toolCalls: number; deadline: string; modelTier: 'cheap' | 'standard' | 'premium' };
  returnContract: { format: 'plur1bus.return/1'; maxTokens: number; outputSchema: Record<string, unknown>; citationsRequired: boolean; reportTo?: string };
  state?: { done: { step: string; evidence: string }[]; current: string; next: string[] };
  triedAndFailed?: { approach: string; why: string }[];
}
export interface HandoffContext {
  /** From authenticated dispatch context, never copied from model arguments. */
  person: string; taskId: string; sessionId: string; fromAgent: string; projectId: string;
  approvals: Pick<ApprovalStore, 'get'>; grants: Pick<GrantStore, 'get'>;
  now(): number;
  audit(event: { kind: 'handoff.refused'; reason: string; person: string; taskId: string }): void;
  hasHistory?: boolean;
  /** Supervisor-bound review checkout; never accepted from model arguments. */
  readOnlyWorktree?: string;
  /** Immutable authority/behavior boundaries across sender repair. */
  expected?: Pick<Handoff, 'kind' | 'from' | 'to' | 'task' | 'constraints' | 'authority' | 'budget' | 'returnContract' | 'doneWhen'>;
  onAccepted?: () => void;
}
export type HandoffRepair = (input: unknown, issues: readonly string[]) => Promise<unknown>;
export interface HandoffAck { schema: 'plur1bus.ack/1'; inReplyTo: string; objective: string; status: 'ok' | 'blocked'; blockingQuestions: string[] }
export interface ReturnEnvelope {
  schema: 'plur1bus.return/1'; id: string; inReplyTo: string;
  status: 'done' | 'done_with_concerns' | 'blocked' | 'needs_context' | 'declined' | 'partial';
  summary: string; doneWhen: { criterion: string; met: boolean; evidence: string }[];
  changes: { ref: string; what: string }[]; artifacts: { ref: string; kind: string; sha256?: string }[];
  concerns: string[]; blockedBy: string | null; needs: string[];
  assumptionsChecked: { claim: string; result: string }[]; learned: { fact: string; source: string }[];
  suggestedNext: string[]; usage: { tokens: number; toolCalls: number; durationMs: number };
  output?: unknown; citations?: string[];
}
function issuesFor(input: unknown, history: boolean): string[] {
  const issues = validateArguments(handoffSchema, input).map(x => `${x.path}: ${x.message}`);
  if (issues.length) return issues;
  const h = input as Handoff;
  if (handoffTokenBound(JSON.stringify(input)) > HANDOFF_TOKEN_CAP) issues.push('handoff exceeds 2000 tokens; move content to artifact references');
  if (h.kind !== 'consult' && !h.doneWhen?.length) issues.push('/doneWhen: acceptance criteria required');
  if (h.kind === 'handoff' && !h.state) issues.push('/state: required for ownership transfer');
  if (history && !h.triedAndFailed) issues.push('/triedAndFailed: required when there is history');
  if (!Number.isFinite(Date.parse(h.budget.deadline))) issues.push('/budget/deadline: invalid date');
  try { assertSchema(h.returnContract.outputSchema); } catch { issues.push('/returnContract/outputSchema: unsupported output schema'); }
  return issues;
}
function refuse(ctx: HandoffContext, reason: string): never {
  ctx.audit({ kind: 'handoff.refused', reason, person: ctx.person, taskId: ctx.taskId });
  throw new CollabError('unauthorized', 'handoff authority refused', { reason });
}
/** Approval ids and derived grant ids are both verified through their chain-backed stores. No capability is minted or consumed here. */
export function verifyHandoffAuthority(h: Handoff, ctx: HandoffContext): void {
  if (ctx.expected && Object.keys(ctx.expected).some(key => !isDeepStrictEqual(h[key as keyof Handoff], ctx.expected![key as keyof NonNullable<HandoffContext['expected']>]))) refuse(ctx, 'handoff-contract-mismatch');
  if (h.task.id !== ctx.taskId || h.task.project !== ctx.projectId || h.from.agent !== ctx.fromAgent || h.from.session !== ctx.sessionId) refuse(ctx, 'handoff-binding');
  if (Date.parse(h.budget.deadline) <= ctx.now()) refuse(ctx, 'handoff-expired');
  for (const id of h.authority.approvalsHeld) {
    const a = ctx.approvals.get(id);
    if (a) {
      if (a.status !== 'approved' || !a.delegable || a.expiresAt <= ctx.now() || a.bound.principal !== ctx.person || a.bound.taskId !== ctx.taskId || a.bound.sessionId !== ctx.sessionId || a.bound.subject.id !== ctx.fromAgent || a.bound.subject.kind !== 'agent') refuse(ctx, 'approval-mismatch');
      continue;
    }
    const g = ctx.grants.get(id);
    if (!g || g.revoked || g.consumedAt !== undefined || !g.delegable || g.person !== ctx.person || g.taskId !== ctx.taskId || (g.expiresAt !== null && g.expiresAt !== undefined && g.expiresAt <= ctx.now()) || g.agent !== ctx.fromAgent) refuse(ctx, 'approval-mismatch');
  }
}
/** One sender-side repair only. Authority failures are never repair prompts. Snapshot inputs across async boundaries. */
export async function prepareHandoff(input: unknown, ctx: HandoffContext, repair?: HandoffRepair): Promise<Handoff> {
  let value: unknown = input;
  for (let round = 0; round < 2; round++) {
    const issues = issuesFor(value, ctx.hasHistory === true);
    if (!issues.length) {
      const h = structuredClone(value) as Handoff;
      verifyHandoffAuthority(h, ctx);
      return h;
    }
    if (round === 0 && repair) { value = await repair(structuredClone(value), issues); continue; }
    throw new CollabError('invalid', `invalid handoff: ${issues.join('; ')}`, { reason: 'handoff-invalid' });
  }
  throw new Error('unreachable');
}
/** A short-lived ticket binds the receiver's ack to an immutable handoff, and can start only once. */
export function handoffTicket(handoff: Handoff, ctx: HandoffContext) {
  const issues = issuesFor(handoff, ctx.hasHistory === true);
  if (issues.length) throw new CollabError('invalid', 'invalid handoff ticket');
  const h = structuredClone(handoff);
  verifyHandoffAuthority(h, ctx);
  const digest = createHash('sha256').update(JSON.stringify(h)).digest('hex');
  let acked = h.kind === 'consult', started = false;
  return {
    digest,
    handoff: () => structuredClone(h),
    ack(value: unknown): void {
      if (validateArguments(ackSchema, value).length) throw new CollabError('invalid', 'invalid handoff ack');
      const a = value as HandoffAck;
      if (a.inReplyTo !== h.id || a.status !== 'ok' || a.blockingQuestions.length) throw new CollabError('conflict', 'receiver has not accepted handoff');
      acked = true;
    },
    async start<T>(work: (h: Handoff) => Promise<T>): Promise<T> {
      if (!acked || started) throw new CollabError('conflict', 'handoff needs ack and may start only once');
      verifyHandoffAuthority(h, ctx); started = true;
      return work(structuredClone(h));
    },
  };
}
export function validateReturn(input: unknown, h: Handoff): ReturnEnvelope {
  const issues = validateArguments(returnSchema, input);
  if (issues.length) throw new CollabError('invalid', 'invalid return envelope');
  const r = input as ReturnEnvelope;
  if (r.inReplyTo !== h.id || handoffTokenBound(JSON.stringify(r)) > h.returnContract.maxTokens) throw new CollabError('invalid', 'return binding or token cap exceeded');
  if (r.status === 'done' || r.status === 'done_with_concerns') {
    if (h.returnContract.citationsRequired && !r.citations?.length) throw new CollabError('invalid', 'return needs citations');
    if (validateArguments(h.returnContract.outputSchema, r.output ?? null).length) throw new CollabError('invalid', 'return output schema mismatch');
  }
  return structuredClone(r);
}

/** One sender-side repair for a malformed/oversized return, with the original contract kept authoritative. */
export async function prepareReturn(input: unknown, handoff: Handoff, repair?: HandoffRepair): Promise<ReturnEnvelope> {
  let value = input;
  for (let round = 0; round < 2; round++) {
    try { return validateReturn(value, handoff); }
    catch (e) {
      if (round !== 0 || !repair || !(e instanceof CollabError)) throw e;
      value = await repair(structuredClone(value), [e.message]);
    }
  }
  throw new Error('unreachable');
}
export function boundedExcerpt(text: string, maxBytes: number): string {
  let out = '', bytes = 0;
  for (const char of text) { const n = Buffer.byteLength(char); if (bytes + n > maxBytes) break; out += char; bytes += n; }
  return out;
}
/** Adapter-authored report for plain-text peers; claims remain unverified and full output can be referenced. */
export function returnFromText(h: Handoff, text: string, usage: ReturnEnvelope['usage'], status: ReturnEnvelope['status'] = 'done_with_concerns', artifacts: ReturnEnvelope['artifacts'] = []): ReturnEnvelope {
  const clipped = Buffer.byteLength(text) > 600;
  return { schema: 'plur1bus.return/1', id: `rt_${randomUUID()}`, inReplyTo: h.id, status, summary: boundedExcerpt(text, 200), doneWhen: [], changes: [], artifacts, concerns: [status === 'partial' ? 'Interrupted; available output only' : 'Delegate report; external verification required', ...(clipped ? ['Excerpt; see referenced full output or delegation transcript.'] : [])], blockedBy: null, needs: [], assumptionsChecked: [], learned: [], suggestedNext: [], usage, output: boundedExcerpt(text, 600) + (clipped ? '\n[excerpt]' : '') };
}
